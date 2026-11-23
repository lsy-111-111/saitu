import { describe, expect, it } from "vitest";
import {
  DISCOVERY_SCHEMA_VERSION,
  discoveryAnswersSchema,
  discoveryAnswerSchema,
  discoveryDraftAnswersSchema,
  discoverySubmittedAnswersSchema,
  legacyDiscoverySubmissionSchema,
  discoveryFollowupQuestionsSchema,
  discoverySubmissionSchema,
  validateDiscoveryFollowupAnswers,
  validateDiscoveryStep,
  type DiscoveryFollowupQuestion
} from "@/lib/competitions/discovery/contracts";
import {
  DISCOVERY_FIELDS,
  DISCOVERY_FIELD_IDS,
  DISCOVERY_QUESTIONS,
  createEmptyDiscoveryAnswers,
  formatDiscoveryAnswers,
  toggleDiscoverySelection
} from "@/lib/competitions/discovery/questionnaire";

const question: DiscoveryFollowupQuestion = {
  id: "independence",
  prompt: "关于你提到的数据分析任务，哪种描述最接近实际情况？",
  selection: "single",
  maxSelections: 1,
  options: [
    { value: "guided", label: "跟随教程或他人指导完成" },
    { value: "independent", label: "能够独立完成基础任务" },
    { value: "unknown", label: "不太确定，先了解适合入门的形式" }
  ]
};

function completeAnswers() {
  const answers = createEmptyDiscoveryAnswers();
  for (const field of DISCOVERY_FIELDS) answers[field.id] = { status: "answered", values: [field.options.find(option => option.meaning === "unknown")!.value] };
  return answers;
}

function legacyAnswers() {
  const answers = createEmptyDiscoveryAnswers();
  for (const id of DISCOVERY_FIELD_IDS) answers[id] = { status: "skipped", values: [] };
  return answers;
}

function submission() {
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    answers: completeAnswers(),
    consentVersion: "2026-11-20.discovery.v2",
    consentAccepted: true as const,
    clientRequestId: "c83b0acf-7736-434e-8e93-5dfaa0f5454d"
  };
}

describe("discovery questionnaire v2 contract", () => {
  it("has ten rounds, thirteen fields, and requires an answer to every field", () => {
    expect(DISCOVERY_QUESTIONS).toHaveLength(10);
    expect(DISCOVERY_QUESTIONS.map(({ fields }) => fields.length)).toEqual([2, 1, 1, 2, 1, 1, 1, 2, 1, 1]);
    expect(DISCOVERY_FIELDS.map(({ id }) => id).sort()).toEqual([...DISCOVERY_FIELD_IDS].sort());
    expect(discoverySubmissionSchema.safeParse(submission()).success).toBe(true);
    expect(discoverySubmissionSchema.safeParse({ ...submission(), answers: createEmptyDiscoveryAnswers() }).success).toBe(false);
    for (const id of DISCOVERY_FIELD_IDS) {
      const answers = { ...completeAnswers(), [id]: { status: "unanswered", values: [] } };
      expect(discoverySubmissionSchema.safeParse({ ...submission(), answers }).success, id).toBe(false);
    }
  });

  it("allows draft gaps but prevents advancing an unanswered round", () => {
    const answers = createEmptyDiscoveryAnswers();
    expect(discoveryDraftAnswersSchema.safeParse(answers).success).toBe(true);
    expect(validateDiscoveryStep("q1", answers).valid).toBe(false);
    answers.learningStage = { status: "answered", values: [], text: "本科大二" };
    expect(validateDiscoveryStep("q1", answers).valid).toBe(false);
    answers.enrollmentStatus = { status: "answered", values: ["unknown"] };
    expect(validateDiscoveryStep("q1", answers)).toEqual({ valid: true, errors: [] });
  });

  it("accepts choices, free text, or both while rejecting empty text-only answers", () => {
    for (const answer of [
      { status: "answered", values: [], text: "主修统计" },
      { status: "answered", values: ["science"] },
      { status: "answered", values: ["science"], text: "具体是统计学" }
    ]) {
      const answers = { ...completeAnswers(), major: answer };
      expect(discoverySubmittedAnswersSchema.safeParse(answers).success).toBe(true);
      expect(discoverySubmissionSchema.safeParse({ ...submission(), answers }).success).toBe(true);
    }
    for (const answer of [
      { status: "answered", values: [], text: "  \n\t" },
      { status: "answered", values: [] },
      { status: "skipped", values: [] },
      { status: "unanswered", values: [], text: "有自述" }
    ]) expect(discoveryAnswerSchema.safeParse(answer).success).toBe(false);
  });

  it("preserves exact per-field Unicode text and enforces 200 characters", () => {
    const text = " 🧑" + "字".repeat(197) + " ";
    expect(Array.from(text)).toHaveLength(200);
    const answers = { ...completeAnswers(), major: { status: "answered", values: [], text } };
    expect(discoverySubmissionSchema.parse({ ...submission(), answers }).answers.major.text).toBe(text);
    expect(discoverySubmissionSchema.safeParse({ ...submission(), answers: { ...answers, major: { ...answers.major, text: text + "字" } } }).success).toBe(false);
    expect(formatDiscoveryAnswers(answers as ReturnType<typeof completeAnswers>)).toContain(`本人文字回答：${text}`);
  });

  it("retains old skipped answers losslessly only for legacy reads", () => {
    const answers = legacyAnswers();
    answers.major = { status: "answered", values: ["unknown"] };
    answers.completedTasks = { status: "answered", values: ["none"] };
    const original = { schemaVersion: "competition-discovery.v1", answers, additionalText: "旧总补充", consentVersion: "2026-11-19.discovery.v1", consentAccepted: true, clientRequestId: submission().clientRequestId };
    expect(legacyDiscoverySubmissionSchema.parse(original)).toEqual(original);
    expect(JSON.stringify(legacyDiscoverySubmissionSchema.parse(original))).toBe(JSON.stringify(original));
    expect(discoveryAnswersSchema.parse(answers)).toEqual(answers);
    expect(discoverySubmissionSchema.safeParse(original).success).toBe(false);
    expect(formatDiscoveryAnswers(answers)).toContain("暂未回答（未知");
    expect(formatDiscoveryAnswers(answers)).toContain("暂时没有完成过上述任务");
  });

  it("rejects missing, foreign, duplicate and out-of-range selections", () => {
    const answers = completeAnswers();
    expect(discoverySubmittedAnswersSchema.safeParse({ ...answers, oldProfile: "v7" }).success).toBe(false);
    expect(discoverySubmittedAnswersSchema.safeParse({ ...answers, learningStage: undefined }).success).toBe(false);
    expect(discoverySubmittedAnswersSchema.safeParse({ ...answers, learningStage: { status: "answered", values: ["foreign"] } }).success).toBe(false);
    expect(discoverySubmittedAnswersSchema.safeParse({ ...answers, resources: { status: "answered", values: ["mentor", "mentor"] } }).success).toBe(false);
    for (const field of DISCOVERY_FIELDS) {
      answers[field.id] = { status: "answered", values: field.options.slice(0, field.maxSelections).map(({ value }) => value), ...(field.selection === "ranked" ? { orderConfirmed: true } : {}) };
      expect(discoverySubmittedAnswersSchema.safeParse(answers).success, field.id).toBe(true);
      answers[field.id] = { ...answers[field.id], values: field.options.slice(0, field.maxSelections + 1).map(({ value }) => value) };
      expect(discoverySubmittedAnswersSchema.safeParse(answers).success, field.id).toBe(false);
      answers[field.id] = completeAnswers()[field.id];
    }
    expect(discoverySubmittedAnswersSchema.safeParse({ ...answers, resources: { status: "answered", values: ["none", "unknown"] } }).success).toBe(false);
  });

  it("requires selected-goal ordering but allows a text-only goal without manufactured priorities", () => {
    const answers = completeAnswers();
    answers.goals = { status: "answered", values: ["skills", "career-portfolio"] };
    expect(discoveryDraftAnswersSchema.safeParse(answers).success).toBe(true);
    expect(validateDiscoveryStep("q3", answers).valid).toBe(false);
    expect(validateDiscoveryStep("q2", answers)).toEqual({ valid: true, errors: [] });
    answers.goals.orderConfirmed = true;
    expect(validateDiscoveryStep("q3", answers).valid).toBe(true);
    expect(formatDiscoveryAnswers(answers)).toContain("第1优先：练会某项方法或工具");
    answers.goals = { status: "answered", values: [], text: "希望做科研，形成作品" };
    expect(discoverySubmittedAnswersSchema.safeParse(answers).success).toBe(true);
  });

  it("keeps exclusive selection behavior and validates history without a new global text field", () => {
    const resources = DISCOVERY_FIELDS.find(({ id }) => id === "resources")!;
    expect(toggleDiscoverySelection(resources, ["mentor", "equipment", "learning"], "unknown")).toEqual(["unknown"]);
    expect(toggleDiscoverySelection(resources, ["unknown"], "mentor")).toEqual(["mentor"]);
    expect(discoverySubmissionSchema.safeParse({ ...submission(), legacyAdditionalText: "🧑".repeat(200) }).success).toBe(true);
    expect(discoverySubmissionSchema.safeParse({ ...submission(), legacyAdditionalText: "🧑".repeat(201) }).success).toBe(false);
    expect(discoverySubmissionSchema.safeParse({ ...submission(), additionalText: "新输入不能用旧总补充字段" }).success).toBe(false);
  });

  it("requires explicit consent and a request UUID", () => {
    const input = submission();
    expect(discoverySubmissionSchema.safeParse({ ...input, consentAccepted: false }).success).toBe(false);
    expect(discoverySubmissionSchema.safeParse({ ...input, clientRequestId: "not-a-uuid" }).success).toBe(false);
    expect(discoverySubmissionSchema.safeParse({ ...input, schemaVersion: "competition-recommendation.v7" }).success).toBe(false);
    expect(discoverySubmissionSchema.safeParse({ ...input, supplement: "foreign field" }).success).toBe(false);
  });
});

describe("discovery followup contract", () => {
  it("allows zero, one or two distinct questions, never three", () => {
    expect(discoveryFollowupQuestionsSchema.parse([])).toEqual([]);
    expect(discoveryFollowupQuestionsSchema.parse([question])).toHaveLength(1);
    const other = { ...question, id: "direction", prompt: "你更愿意持续承担哪一种实际任务？" };
    expect(discoveryFollowupQuestionsSchema.parse([question, other])).toHaveLength(2);
    expect(discoveryFollowupQuestionsSchema.safeParse([question, other, { ...other, id: "third" }]).success).toBe(false);
    expect(discoveryFollowupQuestionsSchema.safeParse([question, question]).success).toBe(false);
  });

  it("rejects malformed or identity-soliciting questions", () => {
    expect(discoveryFollowupQuestionsSchema.safeParse([{ ...question, maxSelections: 2 }]).success).toBe(false);
    expect(discoveryFollowupQuestionsSchema.safeParse([{ ...question, options: question.options.slice(0, 2) }]).success).toBe(false);
    expect(discoveryFollowupQuestionsSchema.safeParse([{ ...question, prompt: "你所在学校是什么？" }]).success).toBe(false);
    expect(discoveryFollowupQuestionsSchema.safeParse([{ ...question, prompt: "请填写你的成绩排名" }]).success).toBe(false);
    expect(discoveryFollowupQuestionsSchema.safeParse([{ ...question, prompt: "打开 https://example.com" }]).success).toBe(false);
    expect(discoveryFollowupQuestionsSchema.safeParse([{ ...question, exclusiveValues: ["not-present"] }]).success).toBe(false);
    expect(discoveryFollowupQuestionsSchema.safeParse([{ ...question, extra: "unsafe" }]).success).toBe(false);
  });

  it("validates actual stored question IDs and choices, including explicit skipping", () => {
    const skipped = { questionId: question.id, status: "skipped", values: [] };
    expect(validateDiscoveryFollowupAnswers([question], [skipped])).toEqual([skipped]);
    expect(validateDiscoveryFollowupAnswers([question], [{ questionId: question.id, status: "answered", values: ["independent"] }])).toHaveLength(1);
    expect(() => validateDiscoveryFollowupAnswers([question], [])).toThrow();
    expect(() => validateDiscoveryFollowupAnswers([question], [{ ...skipped, questionId: "foreign-question" }])).toThrow();
    expect(() => validateDiscoveryFollowupAnswers([question], [{ questionId: question.id, status: "answered", values: ["invented"] }])).toThrow();
    expect(() => validateDiscoveryFollowupAnswers([question], [{ questionId: question.id, status: "answered", values: ["guided", "independent"] }])).toThrow();
    expect(() => validateDiscoveryFollowupAnswers([question], [skipped, skipped])).toThrow();
  });
});
