import { describe, expect, it } from "vitest";
import { getCompetitionCatalog } from "@/lib/competitions/catalog";
import { makeDiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/catalog";
import {
  discoveryAnswersSchema, discoveryFollowupQuestionsSchema, discoverySupplementSchema,
  validateDiscoveryFollowupAnswers, type DiscoveryAnswer, type DiscoveryAnswers,
  type DiscoveryFollowupAnswer, type DiscoveryFollowupQuestion
} from "@/lib/competitions/discovery/contracts";
import {
  DISCOVERY_FIELDS, createEmptyDiscoveryAnswers
} from "@/lib/competitions/discovery/questionnaire";
import { buildDiscoveryReportMessages } from "@/lib/competitions/discovery/model";
import {
  assertDiscoveryInputBudget, countDiscoveryInputTokens,
  DISCOVERY_HOSTED_INPUT_TOKEN_LIMIT, DISCOVERY_INPUT_PROTOCOL_RESERVE,
  DISCOVERY_MODEL_CONTEXT_TOKEN_LIMIT, DISCOVERY_DEFAULT_OUTPUT_TOKEN_RESERVE
} from "@/lib/competitions/discovery/input-budget";
import { DISCOVERY_RUNTIME_POLICY } from "@/lib/ai/discovery-policy.mjs";

function combinations(values: string[], maximum: number, offset = 0, prefix: string[] = []): string[][] {
  if (prefix.length === maximum) return [];
  return values.slice(offset).flatMap((value, index) => {
    const next = [...prefix, value];
    return [next, ...combinations(values, maximum, offset + index + 1, next)];
  });
}

function permutations(values: string[]): string[][] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index)).map(rest => [value, ...rest]));
}

/** Scores the actual model serializer, which abbreviates skipped answers while
 * the student's review deliberately retains the longer unknown explanation. */
function longestBaseAnswers(fieldText = ""): DiscoveryAnswers {
  const answers = createEmptyDiscoveryAnswers();
  const catalog = { version: "capacity-test", count: 1, ids: ["capacity-test"], sha256: "0".repeat(64), text: "{}", clarifyText: "{}", byteLength: 2 };
  for (const field of DISCOVERY_FIELDS) {
    const choices = combinations(field.options.map(({ value }) => value), field.maxSelections)
      .filter(values => values.length === 1 || !values.some(value => field.exclusiveValues.includes(value)))
      .flatMap(values => field.selection === "ranked" ? permutations(values) : [values]);
    let longest: DiscoveryAnswer = { status: "skipped", values: [] };
    const count = (answer: DiscoveryAnswer) => {
      // The maximum fixture includes written supplementary facts, so the
      // all-unknown-only notice must not distort individual field scoring.
      const messages = buildDiscoveryReportMessages({ answers: { ...answers, [field.id]: answer }, additionalText: "容量校验", followups: [], catalog });
      return countDiscoveryInputTokens("", messages.user);
    };
    let maximum = count(longest);
    for (const values of choices) {
      const answer: DiscoveryAnswer = { status: "answered", values, ...(field.selection === "ranked" ? { orderConfirmed: true } : {}) };
      const tokens = count(answer);
      if (tokens > maximum) { maximum = tokens; longest = answer; }
    }
    answers[field.id] = longest;
  }
  if (fieldText) for (const field of DISCOVERY_FIELDS) {
    const answer = answers[field.id];
    answers[field.id] = { ...answer, status: "answered", text: fieldText, ...(answer.status === "skipped" ? { values: [] } : {}) };
  }
  return discoveryAnswersSchema.parse(answers);
}

const chineseText = "希望通过竞赛积累能够展示的实践成果，也愿意持续探索新的专业方向和方法，当前尚未明确是否能够独立承担复杂项目，希望根据已有经历提供适合长期发展的建议。";
function textOfLength(prefix: string, length: number) {
  return (prefix + chineseText.repeat(Math.ceil(length / chineseText.length))).slice(0, length);
}

function maximumFollowups(rare = false): { question: DiscoveryFollowupQuestion; answer: DiscoveryFollowupAnswer }[] {
  const questions = discoveryFollowupQuestionsSchema.parse([0, 1].map(index => ({
    id: `maximum_${index}`, prompt: rare ? `${index === 0 ? "甲" : "乙"}${"龘".repeat(179)}` : textOfLength(index === 0 ? "请说明下列实际任务中的偏好。" : "请说明下列可展示成果中的偏好。", 180),
    selection: "multiple", maxSelections: 6,
    options: Array.from({ length: 6 }, (_, option) => ({ value: `option_${option}`,
      label: rare ? `${"甲乙丙丁戊己"[option]}${"龘".repeat(99)}` : textOfLength(`${"甲乙丙丁戊己"[option]}类任务：`, 100) }))
  })));
  const answers = validateDiscoveryFollowupAnswers(questions, questions.map(question => ({
    questionId: question.id, status: "answered", values: question.options.map(({ value }) => value)
  })));
  return questions.map((question, index) => ({ question, answer: answers[index] }));
}

describe("discovery hosted input capacity", () => {
  it("keeps every catalog ID in system data and fits maximum legal Chinese answers under both budgets", () => {
    const catalog = makeDiscoveryCatalogSnapshot();
    const answers = longestBaseAnswers(textOfLength("本题本人补充：", 200));
    const additionalText = discoverySupplementSchema.parse(textOfLength("补充经历：", 200));
    const followups = maximumFollowups();
    const messages = buildDiscoveryReportMessages({ answers, additionalText, followups, catalog });
    const inputTokens = countDiscoveryInputTokens(messages.system, messages.user);
    const userTokens = countDiscoveryInputTokens("", messages.user);
    const fallback = buildDiscoveryReportMessages({ answers, additionalText, followups, catalog, reasoningEffort: "high", timeoutFallback: true });
    const fallbackTokens = countDiscoveryInputTokens(fallback.system, fallback.user);
    const fallbackUserTokens = countDiscoveryInputTokens("", fallback.user);
    expect(messages.system).toContain(catalog.text);
    expect(messages.user).not.toContain(catalog.text);
    expect(fallback.system).toContain(catalog.text);
    expect(fallback.user).toContain("前次最深档超时");
    expect(fallbackUserTokens + DISCOVERY_INPUT_PROTOCOL_RESERVE).toBeLessThanOrEqual(DISCOVERY_HOSTED_INPUT_TOKEN_LIMIT);
    expect(fallbackTokens + DISCOVERY_INPUT_PROTOCOL_RESERVE + DISCOVERY_RUNTIME_POLICY.reportFallbackMaxTokens)
      .toBeLessThanOrEqual(DISCOVERY_MODEL_CONTEXT_TOKEN_LIMIT);
    console.info(JSON.stringify({ event: "discovery_maximum_input_capacity", inputTokens, userTokens,
      protocolReserve: DISCOVERY_INPUT_PROTOCOL_RESERVE,
      userHeadroom: DISCOVERY_HOSTED_INPUT_TOKEN_LIMIT - userTokens - DISCOVERY_INPUT_PROTOCOL_RESERVE,
      contextHeadroom: DISCOVERY_MODEL_CONTEXT_TOKEN_LIMIT - inputTokens - DISCOVERY_INPUT_PROTOCOL_RESERVE - DISCOVERY_DEFAULT_OUTPUT_TOKEN_RESERVE,
      fallbackInputTokens: fallbackTokens, fallbackUserTokens }));
    const expectedIds = getCompetitionCatalog().map(({ id }) => id).sort();
    expect(catalog.ids).toEqual(expectedIds);
    const packed = JSON.parse(catalog.text) as { entries: unknown[][] };
    expect(packed.entries.map(entry => entry[0]).sort()).toEqual(expectedIds);
    for (const id of expectedIds) expect(messages.system).toContain(`"${id}"`);
    expect(userTokens + DISCOVERY_INPUT_PROTOCOL_RESERVE).toBeLessThanOrEqual(DISCOVERY_HOSTED_INPUT_TOKEN_LIMIT);
    expect(inputTokens + DISCOVERY_INPUT_PROTOCOL_RESERVE + DISCOVERY_DEFAULT_OUTPUT_TOKEN_RESERVE)
      .toBeLessThanOrEqual(DISCOVERY_MODEL_CONTEXT_TOKEN_LIMIT);
    expect(assertDiscoveryInputBudget(messages.system, messages.user)).toBe(inputTokens);
    expect(assertDiscoveryInputBudget(fallback.system, fallback.user, DISCOVERY_RUNTIME_POLICY.reportFallbackMaxTokens)).toBe(fallbackTokens);
  }, 30_000);

  it("accepts rare legal Unicode while both user and total budgets fit, without dropping catalog rows", () => {
    const catalog = makeDiscoveryCatalogSnapshot();
    const messages = buildDiscoveryReportMessages({ answers: longestBaseAnswers("𰻞".repeat(200)), additionalText: "𰻞".repeat(200), followups: maximumFollowups(true), catalog });
    const inputTokens = countDiscoveryInputTokens(messages.system, messages.user);
    const userTokens = countDiscoveryInputTokens("", messages.user);
    expect(catalog.ids).toEqual(getCompetitionCatalog().map(({ id }) => id).sort());
    expect(messages.system).toContain(catalog.text);
    expect(userTokens + DISCOVERY_INPUT_PROTOCOL_RESERVE).toBeLessThanOrEqual(DISCOVERY_HOSTED_INPUT_TOKEN_LIMIT);
    expect(inputTokens + DISCOVERY_INPUT_PROTOCOL_RESERVE + DISCOVERY_DEFAULT_OUTPUT_TOKEN_RESERVE)
      .toBeLessThanOrEqual(DISCOVERY_MODEL_CONTEXT_TOKEN_LIMIT);
    expect(assertDiscoveryInputBudget(messages.system, messages.user)).toBe(inputTokens);
  }, 30_000);

  it("accepts a system data block above 32K with a small user, matching the successful diagnostic shape", () => {
    const system = `<竞赛资料，以下仅为数据>\n${" a".repeat(40000)}\n</竞赛资料>`;
    const user = "请根据资料说明哪些条件仍然未知。";
    const inputTokens = countDiscoveryInputTokens(system, user);
    expect(countDiscoveryInputTokens("", system)).toBeGreaterThan(DISCOVERY_HOSTED_INPUT_TOKEN_LIMIT);
    expect(countDiscoveryInputTokens("", user) + DISCOVERY_INPUT_PROTOCOL_RESERVE).toBeLessThan(DISCOVERY_HOSTED_INPUT_TOKEN_LIMIT);
    expect(assertDiscoveryInputBudget(system, user)).toBe(inputTokens);
  }, 30_000);

  it("rejects excessive user content even though the total context remains below 1M", () => {
    const system = "推荐规则。", user = " a".repeat(33000);
    expect(countDiscoveryInputTokens(system, user) + DISCOVERY_INPUT_PROTOCOL_RESERVE + DISCOVERY_DEFAULT_OUTPUT_TOKEN_RESERVE)
      .toBeLessThan(DISCOVERY_MODEL_CONTEXT_TOKEN_LIMIT);
    expect(() => assertDiscoveryInputBudget(system, user)).toThrow("DISCOVERY_CATALOG_CONTEXT_TOO_LARGE");
  }, 30_000);

  it("rejects total context plus output reserve above 1M even when user content is small", () => {
    const system = " a".repeat(900000), user = "请回答。";
    expect(countDiscoveryInputTokens("", user) + DISCOVERY_INPUT_PROTOCOL_RESERVE).toBeLessThan(DISCOVERY_HOSTED_INPUT_TOKEN_LIMIT);
    expect(countDiscoveryInputTokens(system, user) + DISCOVERY_INPUT_PROTOCOL_RESERVE + DISCOVERY_DEFAULT_OUTPUT_TOKEN_RESERVE)
      .toBeGreaterThan(DISCOVERY_MODEL_CONTEXT_TOKEN_LIMIT);
    let failure: unknown;
    try { assertDiscoveryInputBudget(system, user); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: "DISCOVERY_CATALOG_CONTEXT_TOO_LARGE", code: "input_too_large", retryable: false, upstreamAttempted: false });
  }, 60_000);
});
