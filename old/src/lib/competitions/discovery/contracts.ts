import { z } from "zod";
import { DISCOVERY_FIELD_BY_ID, DISCOVERY_FIELD_IDS, DISCOVERY_QUESTIONS, type DiscoveryFieldId, type DiscoveryQuestion } from "./questionnaire";

export type { DiscoveryFieldId } from "./questionnaire";

export const LEGACY_DISCOVERY_SCHEMA_VERSION = "competition-discovery.v1" as const;
export const DISCOVERY_SCHEMA_VERSION = "competition-discovery.v2" as const;
export const DISCOVERY_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DISCOVERY_REPORT_DEADLINE_MS = 180_000;
export const DISCOVERY_CLARIFY_DEADLINE_MS = 30_000;
export const DISCOVERY_MAX_FOLLOWUPS = 2;
export const DISCOVERY_SUPPLEMENT_MAX_LENGTH = 200;
export const DISCOVERY_FIELD_TEXT_MAX_LENGTH = 200;

const optionValueSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
export const discoveryFieldTextSchema = z.string().refine((value) => Array.from(value).length <= DISCOVERY_FIELD_TEXT_MAX_LENGTH, "每项文字最多 200 字");

/** Keep legacy reads lossless: adding defaults would change existing request hashes. */
export const legacyDiscoveryAnswerSchema = z.object({
  status: z.enum(["answered", "skipped"]),
  values: z.array(optionValueSchema).max(4),
  text: z.never().optional(),
  orderConfirmed: z.boolean().optional()
}).strict().superRefine((answer, context) => {
  if (new Set(answer.values).size !== answer.values.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "选项不能重复", path: ["values"] });
  if (answer.status === "skipped" && (answer.values.length || answer.orderConfirmed)) context.addIssue({ code: z.ZodIssueCode.custom, message: "跳过的问题不能携带已选答案", path: ["values"] });
  if (answer.status === "answered" && !answer.values.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "已回答的问题需要至少一个选项", path: ["values"] });
});
export const discoveryAnswerSchema = z.object({
  status: z.enum(["answered", "unanswered"]),
  values: z.array(optionValueSchema).max(4),
  text: discoveryFieldTextSchema.optional(),
  orderConfirmed: z.boolean().optional()
}).strict().superRefine((answer, context) => {
  if (new Set(answer.values).size !== answer.values.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "选项不能重复", path: ["values"] });
  if (answer.status === "unanswered" && (answer.values.length || answer.text?.trim() || answer.orderConfirmed)) context.addIssue({ code: z.ZodIssueCode.custom, message: "未回答的问题不能携带答案", path: ["status"] });
  if (answer.status === "answered" && !answer.values.length && !answer.text?.trim()) context.addIssue({ code: z.ZodIssueCode.custom, message: "请选择选项或填写文字后继续", path: ["values"] });
});
export const discoveryStoredAnswerSchema = z.union([discoveryAnswerSchema, legacyDiscoveryAnswerSchema]);
export type DiscoveryDraftAnswer = z.infer<typeof discoveryAnswerSchema>;
export type DiscoveryAnswer = z.infer<typeof discoveryStoredAnswerSchema>;
export type DiscoveryFieldAnswer = DiscoveryAnswer;
export type DiscoveryAnswers = Record<DiscoveryFieldId, DiscoveryAnswer>;

function answerObject<Schema extends z.ZodTypeAny>(schema: Schema) {
  const shape = Object.fromEntries(DISCOVERY_FIELD_IDS.map((id) => [id, schema])) as Record<DiscoveryFieldId, Schema>;
  return z.object(shape).strict();
}
function validateAnswerOptions(answers: DiscoveryAnswers, context: z.RefinementCtx, requireOrder = true) {
  for (const id of DISCOVERY_FIELD_IDS) {
    const answer = answers[id], field = DISCOVERY_FIELD_BY_ID[id];
    if (answer.status !== "answered") continue;
    const allowed = new Set(field.options.map((option) => option.value));
    if (answer.values.some((value) => !allowed.has(value))) context.addIssue({ code: z.ZodIssueCode.custom, message: "包含该问题没有的选项", path: [id, "values"] });
    if (answer.values.length > field.maxSelections) context.addIssue({ code: z.ZodIssueCode.custom, message: `最多选择 ${field.maxSelections} 项`, path: [id, "values"] });
    if (answer.values.length > 1 && answer.values.some((value) => field.exclusiveValues.includes(value))) context.addIssue({ code: z.ZodIssueCode.custom, message: "不确定／都没有与其他选项互斥", path: [id, "values"] });
    if (requireOrder && field.selection === "ranked" && answer.values.length > 1 && answer.orderConfirmed !== true) context.addIssue({ code: z.ZodIssueCode.custom, message: "请明确确认目标优先顺序", path: [id, "orderConfirmed"] });
    if (field.selection !== "ranked" && answer.orderConfirmed !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "仅参赛目标包含排序确认", path: [id, "orderConfirmed"] });
  }
}
export const legacyDiscoveryAnswersSchema = answerObject(legacyDiscoveryAnswerSchema).superRefine((answers, context) => validateAnswerOptions(answers, context));
export const discoveryAnswersSchema = answerObject(discoveryStoredAnswerSchema).superRefine((answers, context) => validateAnswerOptions(answers, context));
export const discoveryDraftAnswersSchema = answerObject(discoveryAnswerSchema).superRefine((answers, context) => validateAnswerOptions(answers, context, false));
export const discoverySubmittedAnswersSchema = answerObject(discoveryAnswerSchema).superRefine((answers, context) => {
  validateAnswerOptions(answers, context);
  for (const id of DISCOVERY_FIELD_IDS) {
    if (answers[id].status !== "answered") context.addIssue({ code: z.ZodIssueCode.custom, message: `请回答“${DISCOVERY_FIELD_BY_ID[id].label}”后继续`, path: [id, "status"] });
  }
});

export const discoverySupplementSchema = z.string().refine((value) => Array.from(value).length <= DISCOVERY_SUPPLEMENT_MAX_LENGTH, "补充最多 200 字");
export const legacyDiscoverySubmissionSchema = z.object({
  schemaVersion: z.literal(LEGACY_DISCOVERY_SCHEMA_VERSION),
  answers: legacyDiscoveryAnswersSchema,
  additionalText: discoverySupplementSchema,
  consentVersion: z.string().min(1).max(100),
  consentAccepted: z.literal(true),
  clientRequestId: z.string().uuid()
}).strict();
export const discoverySubmissionSchema = z.object({
  schemaVersion: z.literal(DISCOVERY_SCHEMA_VERSION),
  answers: discoverySubmittedAnswersSchema,
  legacyAdditionalText: discoverySupplementSchema.optional(),
  consentVersion: z.string().min(1).max(100),
  consentAccepted: z.literal(true),
  clientRequestId: z.string().uuid()
}).strict();
export const discoveryStoredSubmissionSchema = z.union([discoverySubmissionSchema, legacyDiscoverySubmissionSchema]);
export type DiscoverySubmission = z.infer<typeof discoverySubmissionSchema>;
export type LegacyDiscoverySubmission = z.infer<typeof legacyDiscoverySubmissionSchema>;
export type DiscoveryStoredSubmission = z.infer<typeof discoveryStoredSubmissionSchema>;

export function validateDiscoveryStep(question: DiscoveryQuestion | string, answers: DiscoveryAnswers): { valid: boolean; errors: string[] } {
  const definition = typeof question === "string" ? DISCOVERY_QUESTIONS.find(({ id }) => id === question) : question;
  if (!definition) return { valid: false, errors: ["无法识别问题"] };
  const result = discoverySubmittedAnswersSchema.safeParse(answers);
  if (result.success) return { valid: true, errors: [] };
  const ids = new Set<string>(definition.fields.map(({ id }) => id));
  const errors = result.error.issues.filter((issue) => ids.has(String(issue.path[0]))).map(({ message }) => message);
  return { valid: errors.length === 0, errors };
}

const unsafeQuestionText = /(?:https?:\/\/|www\.|<[^>]*>|姓名|学校名称|院校名称|成绩排名|学号|手机号|电话号码|联系方式|微信号|邮箱|身份证|(?:哪所|哪个|什么)(?:学校|大学|学院)|(?:所在|就读|毕业)(?:的)?(?:学校|大学|学院)(?:是|叫什么|名称|[？?]))/i;
const generatedText = (maximum: number) => z.string().trim().min(1).max(maximum).refine((value) => !unsafeQuestionText.test(value), "补问题目不能索取身份和联系信息或包含链接");
export const discoveryFollowupQuestionSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
  prompt: generatedText(180),
  selection: z.enum(["single", "multiple"]),
  maxSelections: z.number().int().min(1).max(6),
  options: z.array(z.object({ value: optionValueSchema, label: generatedText(100) }).strict()).min(3).max(6),
  exclusiveValues: z.array(optionValueSchema).max(6).optional()
}).strict().superRefine((question, context) => {
  const values = question.options.map(({ value }) => value);
  const labels = question.options.map(({ label }) => label);
  if (new Set(values).size !== values.length || new Set(labels).size !== labels.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "补问选项不能重复", path: ["options"] });
  if (question.maxSelections > question.options.length || (question.selection === "single" && question.maxSelections !== 1)) context.addIssue({ code: z.ZodIssueCode.custom, message: "补问选择上限无效", path: ["maxSelections"] });
  if ((question.exclusiveValues ?? []).some((value) => !values.includes(value)) || new Set(question.exclusiveValues ?? []).size !== (question.exclusiveValues ?? []).length) context.addIssue({ code: z.ZodIssueCode.custom, message: "互斥选项必须属于本题且不重复", path: ["exclusiveValues"] });
});
export type DiscoveryFollowupQuestion = z.infer<typeof discoveryFollowupQuestionSchema>;
export const discoveryFollowupQuestionsSchema = z.array(discoveryFollowupQuestionSchema).max(DISCOVERY_MAX_FOLLOWUPS).superRefine((questions, context) => {
  if (new Set(questions.map(({ id }) => id)).size !== questions.length || new Set(questions.map(({ prompt }) => prompt)).size !== questions.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "补问不能重复" });
});
export const discoveryClarificationSchema = z.object({ questions: discoveryFollowupQuestionsSchema }).strict();

export const discoveryFollowupAnswerSchema = z.object({
  questionId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
  status: z.enum(["answered", "skipped"]),
  values: z.array(optionValueSchema).max(6)
}).strict().superRefine((answer, context) => {
  if (new Set(answer.values).size !== answer.values.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "补问答案不能重复", path: ["values"] });
  if ((answer.status === "skipped" && answer.values.length) || (answer.status === "answered" && !answer.values.length)) context.addIssue({ code: z.ZodIssueCode.custom, message: "补问作答状态与选项不一致", path: ["values"] });
});
export type DiscoveryFollowupAnswer = z.infer<typeof discoveryFollowupAnswerSchema>;
export const discoveryFollowupAnswersSchema = z.array(discoveryFollowupAnswerSchema).max(DISCOVERY_MAX_FOLLOWUPS).superRefine((answers, context) => {
  if (new Set(answers.map(({ questionId }) => questionId)).size !== answers.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "同一道补问不能重复回答" });
});

/** Validates against the actual stored questions, never client-supplied options. */
export function validateDiscoveryFollowupAnswers(questions: readonly DiscoveryFollowupQuestion[], input: unknown): DiscoveryFollowupAnswer[] {
  const answers = discoveryFollowupAnswersSchema.parse(input);
  if (answers.length !== questions.length) throw new Error("请为每道补问作答或明确跳过");
  for (const answer of answers) {
    const question = questions.find(({ id }) => id === answer.questionId);
    if (!question) throw new Error("补问答案与当前会话不对应");
    const allowed = new Set(question.options.map(({ value }) => value));
    if (answer.values.some((value) => !allowed.has(value)) || answer.values.length > question.maxSelections) throw new Error("补问答案包含无效选项或超过选择上限");
    if (answer.values.length > 1 && answer.values.some((value) => question.exclusiveValues?.includes(value))) throw new Error("补问的互斥选项不能同时选择");
  }
  return answers;
}
