import { z } from "zod";

/** Display contract only. It does not score, filter or rank competitions. */
export const DISCOVERY_PRESENTATION_VERSION = "discovery-cards.v1" as const;
export const PRESENTATION_VERSION = DISCOVERY_PRESENTATION_VERSION;
export const REPORT_START_MARKER = "<SAITU_REPORT_V1>" as const;
export const REPORT_END_MARKER = "</SAITU_REPORT_V1>" as const;

const text = z.string().max(32_000).refine(value => /\S/u.test(value), "内容不能为空");
const optionalText = z.string().max(32_000);
const canonicalId = z.string().max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const cardKey = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const paragraphs = z.array(text).max(128);

export function safePresentationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export const discoveryPresentationSourceSchema = z.object({
  url: z.string().max(8192).transform((value, context) => {
    const normalized = safePresentationUrl(value);
    if (normalized) return normalized;
    context.addIssue({ code: z.ZodIssueCode.custom, message: "来源地址无效" });
    return z.NEVER;
  }),
  title: text,
}).strict();
export type DiscoveryPresentationSource = z.infer<typeof discoveryPresentationSourceSchema>;

/** A server-added reading projection from the run's frozen catalog snapshot. */
export const discoveryCatalogDetailSchema = z.object({
  version: z.string().min(1).max(180),
  id: canonicalId,
  title: text,
  detailPath: z.string().max(220).regex(/^\/competitions\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sections: z.array(z.object({
    heading: text,
    paragraphs,
    sources: z.array(discoveryPresentationSourceSchema).optional(),
  }).strict()).max(128),
  sources: z.array(discoveryPresentationSourceSchema),
}).strict().superRefine((value, context) => {
  if (value.detailPath !== `/competitions/${value.id}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["detailPath"], message: "详情入口与赛事不对应" });
  }
});
export type DiscoveryCatalogDetail = z.infer<typeof discoveryCatalogDetailSchema>;

export const discoveryProfileRecordSchema = z.object({
  type: z.literal("profile"),
  summary: text,
  groups: z.object({ background: paragraphs, goals: paragraphs, experience: paragraphs, constraints: paragraphs }).strict(),
}).strict();
export type DiscoveryProfileRecord = z.infer<typeof discoveryProfileRecordSchema>;

const modelCardSchema = z.object({
  type: z.literal("card"),
  key: cardKey,
  competitionId: canonicalId.nullable(),
  title: text,
  track: optionalText,
  summary: text,
  timing: text.optional(),
  details: z.object({ tasks: paragraphs.min(1), reasons: paragraphs.min(1), value: paragraphs.min(1), conditions: paragraphs.min(1) }).strict(),
  sources: z.array(discoveryPresentationSourceSchema),
}).strict();
export const discoveryCardRecordSchema = modelCardSchema.extend({ catalogDetail: discoveryCatalogDetailSchema.optional() });
export type DiscoveryCardRecord = z.infer<typeof discoveryCardRecordSchema>;

export const discoveryConclusionRecordSchema = z.object({
  type: z.literal("conclusion"),
  priorities: z.array(z.object({ cardKey, reason: text }).strict()).max(2),
  note: optionalText,
  exceptions: paragraphs.max(2),
}).strict();
export type DiscoveryConclusionRecord = z.infer<typeof discoveryConclusionRecordSchema>;

/** Model output cannot author the server's frozen catalog detail. */
export const presentationRecordSchema = z.discriminatedUnion("type", [discoveryProfileRecordSchema, modelCardSchema, discoveryConclusionRecordSchema]);
export type DiscoveryModelPresentationRecord = z.infer<typeof presentationRecordSchema>;
export const persistedPresentationRecordSchema = z.discriminatedUnion("type", [discoveryProfileRecordSchema, discoveryCardRecordSchema, discoveryConclusionRecordSchema])
  .superRefine((record, context) => {
    if (record.type === "card" && record.catalogDetail && record.catalogDetail.id !== record.competitionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["catalogDetail", "id"], message: "目录资料与推荐赛事不对应" });
    }
  });
export type DiscoveryPresentationRecord = z.infer<typeof persistedPresentationRecordSchema>;

export type DiscoveryPresentationState = {
  version: typeof DISCOVERY_PRESENTATION_VERSION;
  profile?: DiscoveryProfileRecord;
  cards: DiscoveryCardRecord[];
  conclusion?: DiscoveryConclusionRecord;
};
export type DiscoveryPresentation = DiscoveryPresentationState;

export type PresentationErrorCode = "missing_marker" | "invalid_json" | "invalid_record" | "invalid_sequence" | "duplicate_card" | "invalid_conclusion" | "incomplete_report" | "response_too_large";
export type PresentationSchemaIssue = { code: z.ZodIssueCode; path: (string | number)[] };
const diagnosticRootFields = new Set(["type", "summary", "groups", "key", "competitionId", "title", "track", "timing", "details", "sources", "priorities", "note", "exceptions"]);
const diagnosticGroupFields = new Set(["background", "goals", "experience", "constraints"]);
const diagnosticDetailFields = new Set(["tasks", "reasons", "value", "conditions"]);
const diagnosticIndex = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Log only paths declared by the model-record schema. Zod messages, values and
 * unrecognized_keys can contain authored text and are deliberately discarded. */
function safeSchemaIssuePath(value: (string | number)[]): (string | number)[] {
  const [field, child, leaf] = value;
  const known = value.length === 0
    || value.length === 1 && typeof field === "string" && diagnosticRootFields.has(field)
    || (field === "groups" && diagnosticGroupFields.has(String(child)) || field === "details" && diagnosticDetailFields.has(String(child)))
      && (value.length === 2 || value.length === 3 && diagnosticIndex(leaf))
    || field === "sources" && diagnosticIndex(child) && (value.length === 2 || value.length === 3 && (leaf === "url" || leaf === "title"))
    || field === "priorities" && diagnosticIndex(child) && (value.length === 2 || value.length === 3 && (leaf === "cardKey" || leaf === "reason"))
    || field === "exceptions" && value.length === 2 && diagnosticIndex(child);
  return known ? [...value] : [];
}
export class PresentationError extends Error {
  readonly code: PresentationErrorCode;
  readonly schemaIssues?: PresentationSchemaIssue[];
  constructor(code: PresentationErrorCode, issues?: readonly z.ZodIssue[]) {
    super(`discovery_presentation_${code}`);
    this.name = "PresentationError";
    this.code = code;
    if (issues) this.schemaIssues = issues.slice(0, 5).map(issue => ({ code: issue.code, path: safeSchemaIssuePath(issue.path) }));
  }
}

export function emptyDiscoveryPresentation(): DiscoveryPresentationState {
  return { version: DISCOVERY_PRESENTATION_VERSION, cards: [] };
}

/** Append one complete record. Nothing is silently deduplicated or reordered. */
export function applyDiscoveryPresentationRecord(state: DiscoveryPresentationState, record: DiscoveryPresentationRecord): DiscoveryPresentationState {
  if (state.conclusion) throw new PresentationError("invalid_sequence");
  if (record.type === "profile") {
    if (state.profile || state.cards.length) throw new PresentationError("invalid_sequence");
    return { ...state, profile: record };
  }
  if (!state.profile) throw new PresentationError("invalid_sequence");
  if (record.type === "card") {
    if (state.cards.some(card => card.key === record.key || record.competitionId !== null && card.competitionId === record.competitionId
      || record.competitionId === null && card.competitionId === null && card.title.normalize("NFKC").trim() === record.title.normalize("NFKC").trim())) {
      throw new PresentationError("duplicate_card");
    }
    return { ...state, cards: [...state.cards, record] };
  }
  const priorityKeys = record.priorities.map(priority => priority.cardKey);
  if (new Set(priorityKeys).size !== priorityKeys.length || priorityKeys.some(key => !state.cards.some(card => card.key === key))
    || state.cards.length > 0 && priorityKeys.length === 0
    || state.cards.length === 0 && !record.note.trim()) throw new PresentationError("invalid_conclusion");
  return { ...state, conclusion: record };
}

export const discoveryPresentationSchema: z.ZodType<DiscoveryPresentationState> = z.object({
  version: z.literal(DISCOVERY_PRESENTATION_VERSION),
  profile: discoveryProfileRecordSchema.optional(),
  cards: z.array(discoveryCardRecordSchema),
  conclusion: discoveryConclusionRecordSchema.optional(),
}).strict().superRefine((value, context) => {
  try {
    let state = emptyDiscoveryPresentation();
    if (value.profile) state = applyDiscoveryPresentationRecord(state, value.profile);
    for (const card of value.cards) {
      const parsed = persistedPresentationRecordSchema.safeParse(card);
      if (!parsed.success) throw new PresentationError("invalid_record");
      state = applyDiscoveryPresentationRecord(state, card);
    }
    if (value.conclusion) applyDiscoveryPresentationRecord(state, value.conclusion);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "报告展示记录不完整或顺序不一致" });
  }
});

const escapeMarkdown = (value: string): string => value.replace(/\\/gu, "\\\\").replace(/([`*_{}\[\]<>#+.!|~-])/gu, "\\$1");
const list = (values: readonly string[]): string => values.map(value => `- ${escapeMarkdown(value)}`).join("\n");
const sourceMarkdown = (source: DiscoveryPresentationSource): string => `[${escapeMarkdown(source.title)}](<${safePresentationUrl(source.url) ?? ""}>)`;

/** A readable lossless copy of delivered display records, without another AI call. */
export function presentationRecordMarkdown(record: DiscoveryPresentationRecord): string {
  if (record.type === "profile") {
    const labels = { background: "背景", goals: "目标", experience: "已有经历与能力自述", constraints: "现实条件" } as const;
    return `## 用户画像\n\n${escapeMarkdown(record.summary)}\n\n${(Object.keys(labels) as (keyof typeof labels)[])
      .filter(key => record.groups[key].length).map(key => `### ${labels[key]}\n\n${list(record.groups[key])}`).join("\n\n")}\n\n`;
  }
  if (record.type === "card") {
    const detailLabels = { tasks: "比赛任务", reasons: "为什么推荐给你", value: "可能的收获", conditions: "资格、条件与待核事项" } as const;
    const details = (Object.keys(detailLabels) as (keyof typeof detailLabels)[])
      .map(key => `### ${detailLabels[key]}\n\n${list(record.details[key])}`).join("\n\n");
    const catalog = record.catalogDetail;
    const catalogText = catalog ? `\n\n### 本次使用的站内资料\n\n以下资料与本次匹配使用的目录一致；历史届次与待核事项按原范围保留。\n\n${catalog.sections.map(section => `#### ${escapeMarkdown(section.heading)}\n\n${list(section.paragraphs)}${section.sources?.length ? `\n\n${section.sources.map(sourceMarkdown).join("\n\n")}` : ""}`).join("\n\n")}\n\n[打开站内赛事详情](${catalog.detailPath})${catalog.sources.length ? `\n\n${catalog.sources.map(sourceMarkdown).join("\n\n")}` : ""}` : "";
    return `## ${escapeMarkdown(record.title)}${record.track ? ` · ${escapeMarkdown(record.track)}` : ""}\n\n${escapeMarkdown(record.summary)}${record.timing ? `\n\n${escapeMarkdown(record.timing)}` : ""}\n\n${details}${record.sources.length ? `\n\n### 依据与核验来源\n\n${record.sources.map(sourceMarkdown).join("\n\n")}` : ""}${catalogText}\n\n`;
  }
  return `## 优先建议\n\n${record.priorities.map(priority => `- ${escapeMarkdown(priority.reason)}`).join("\n")}${record.note ? `\n\n${escapeMarkdown(record.note)}` : ""}${record.exceptions.length ? `\n\n### 已知冲突与例外说明\n\n${list(record.exceptions)}` : ""}\n\n`;
}

export function discoveryPresentationMarkdown(state: DiscoveryPresentationState): string {
  return [state.profile, ...state.cards, state.conclusion].filter((record): record is DiscoveryPresentationRecord => Boolean(record)).map(presentationRecordMarkdown).join("");
}
