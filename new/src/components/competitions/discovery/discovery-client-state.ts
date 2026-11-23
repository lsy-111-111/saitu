import { z } from "zod";
import { discoveryStoredAnswerSchema, discoveryAnswersSchema, discoveryFollowupAnswersSchema, discoveryFollowupQuestionsSchema, discoverySubmissionSchema, legacyDiscoverySubmissionSchema, discoverySupplementSchema, validateDiscoveryFollowupAnswers, type DiscoveryAnswers, type DiscoveryFollowupAnswer } from "@/lib/competitions/discovery/contracts";
import { DISCOVERY_FIELD_IDS, createEmptyDiscoveryAnswers } from "@/lib/competitions/discovery/questionnaire";
import { DISCOVERY_CONSENT_VERSION } from "@/lib/competitions/discovery/disclosure";
import { DISCOVERY_RETENTION_MS, type DiscoveryEvent, type DiscoveryRunSnapshot, type DiscoverySnapshot } from "@/lib/competitions/discovery/transport";
import type { DiscoveryFollowupSaveRequest } from "./discovery-followup-save";
import { DISCOVERY_PRESENTATION_VERSION, discoveryPresentationSchema, persistedPresentationRecordSchema, emptyDiscoveryPresentation, applyDiscoveryPresentationRecord } from "@/lib/competitions/discovery/presentation";

export const DISCOVERY_BROWSER_STORAGE_KEY = "saitu.competitionDiscovery.v1";
export const discoveryPhaseSchema = z.enum(["questions", "review", "clarifying", "followups", "report"]);
const sourceSchema = z.object({ url: z.string().url().refine(value => { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password; }), title: z.string() });
const runStatusSchema = z.enum(["queued", "running", "complete", "failed", "cancelled", "superseded", "deleted", "expired"]);
export const discoveryRunSnapshotSchema: z.ZodType<DiscoveryRunSnapshot> = z.object({
  runId: z.string().uuid(), status: runStatusSchema, markdown: z.string(), sources: z.array(sourceSchema),
  lastSeq: z.number().int().nonnegative(), attempt: z.number().int().nonnegative(), submittedAt: z.string().datetime(), deadlineAt: z.string().datetime(),
  error: z.string().optional(), model: z.string().optional(), webSearchUsed: z.boolean().optional(),
  presentationVersion: z.literal(DISCOVERY_PRESENTATION_VERSION).optional(), presentation: discoveryPresentationSchema.optional(),
});
export const discoverySnapshotSchema: z.ZodType<DiscoverySnapshot> = z.object({
  schemaVersion: z.enum(["competition-discovery.v1", "competition-discovery.v2"]).optional(),
  sessionId: z.string().uuid(), expiresAt: z.string().datetime(), status: z.enum(["clarifying", "followups", "ready", "generating", "complete", "failed", "cancelled"]),
  answers: discoveryAnswersSchema, additionalText: discoverySupplementSchema,
  followups: discoveryFollowupQuestionsSchema, followupAnswers: discoveryFollowupAnswersSchema,
  clarificationStatus: z.enum(["pending", "running", "complete", "failed", "skipped"]), clarificationError: z.string().optional(), followupEditedAt: z.string().datetime().optional(), run: discoveryRunSnapshotSchema.nullable(),
});
const eventMeta = { seq: z.number().int().positive(), runId: z.string().uuid(), at: z.string().datetime() };
export const discoveryEventSchema: z.ZodType<DiscoveryEvent> = z.discriminatedUnion("type", [
  z.object({ ...eventMeta, type: z.literal("text"), delta: z.string(), presentationRecord: persistedPresentationRecordSchema.optional() }),
  z.object({ ...eventMeta, type: z.literal("sources"), sources: z.array(sourceSchema) }),
  z.object({ ...eventMeta, type: z.literal("tool"), action: z.enum(["search", "read"]), status: z.enum(["started", "completed", "failed"]) }),
  z.object({ ...eventMeta, type: z.literal("reset"), attempt: z.number().int().nonnegative(), reason: z.enum(["timeout", "temporary_error", "withdrawn"]).optional() }),
  z.object({ ...eventMeta, type: z.literal("complete"), model: z.string().optional(), webSearchUsed: z.boolean().optional() }),
  z.object({ ...eventMeta, type: z.literal("error"), code: z.string() }),
  z.object({ ...eventMeta, type: z.literal("cancelled") }),
]);
const draftAnswersSchema = z.object(Object.fromEntries(DISCOVERY_FIELD_IDS.map(id => [id, discoveryStoredAnswerSchema])) as Record<(typeof DISCOVERY_FIELD_IDS)[number], typeof discoveryStoredAnswerSchema>).strict();
export const discoveryBrowserStateSchema = z.object({
  storageVersion: z.union([z.literal(1), z.literal(2)]), browserRecordId: z.string().uuid(), recordCreatedAt: z.number().int().nonnegative(), expiresAt: z.string().datetime(), phase: discoveryPhaseSchema, questionIndex: z.number().int().min(0).max(9),
  answers: draftAnswersSchema, additionalText: discoverySupplementSchema, acceptedConsentVersion: z.string().nullable(),
  submission: z.union([discoverySubmissionSchema, legacyDiscoverySubmissionSchema]).nullable(),
  session: z.object({ sessionId: z.string().uuid(), resumeToken: z.string().min(16).max(8192), expiresAt: z.string().datetime(), runId: z.string().uuid().nullable() }).nullable(),
  snapshot: discoverySnapshotSchema.nullable(), followupAnswers: discoveryFollowupAnswersSchema, followupIndex: z.number().int().min(0).max(1),
  followupEditedAt: z.string().datetime().nullable().default(null), followupSavedAt: z.string().datetime().nullable().default(null),
  reportRequestId: z.string().uuid().nullable(),
}).strict();
export type DiscoveryBrowserState = z.infer<typeof discoveryBrowserStateSchema>;

export function emptyDiscoveryBrowserState(now = Date.now()): DiscoveryBrowserState {
  return { storageVersion: 2, browserRecordId: crypto.randomUUID(), recordCreatedAt: now, expiresAt: new Date(now + DISCOVERY_RETENTION_MS).toISOString(), phase: "questions", questionIndex: 0,
    answers: createEmptyDiscoveryAnswers(), additionalText: "", acceptedConsentVersion: null, submission: null, session: null,
    snapshot: null, followupAnswers: [], followupIndex: 0, followupEditedAt: null, followupSavedAt: null, reportRequestId: null };
}

export function migrateDiscoveryBrowserDraft(stored: DiscoveryBrowserState): DiscoveryBrowserState {
  const answers = Object.fromEntries(DISCOVERY_FIELD_IDS.map(id => {
    const answer = stored.answers[id];
    return [id, answer.status === "skipped" ? { status: "unanswered", values: [] } : answer];
  })) as DiscoveryAnswers;
  return { ...stored, storageVersion: 2, phase: "review", answers, acceptedConsentVersion: null,
    submission: null, session: null, snapshot: null, followupAnswers: [], followupIndex: 0,
    followupEditedAt: null, followupSavedAt: null, reportRequestId: null };
}

/** A lost enqueue response leaves a request ID but no run ID. Its cached expiry
 * cannot decide whether the server has since completed and extended a report. */
export function discoveryNeedsReportVerification(state: Pick<DiscoveryBrowserState, "phase" | "session" | "snapshot" | "reportRequestId">): boolean {
  return Boolean(state.phase === "report" && state.session && !state.session.runId && !state.snapshot?.run && state.reportRequestId);
}

export function readDiscoveryBrowserState(raw: string | null, now = Date.now()): DiscoveryBrowserState | null {
  if (!raw) return null;
  try {
    const parsed = discoveryBrowserStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const stored = parsed.data;
    const expired = Date.parse(stored.expiresAt) <= now || stored.session && Date.parse(stored.session.expiresAt) <= now;
    if (expired) {
      // A task may have finished while the browser was closed, moving the server's
      // retention deadline. Keep only its recovery credentials for verification.
      if (!(stored.session?.runId || discoveryNeedsReportVerification(stored))
        || now > Date.parse(stored.expiresAt) + DISCOVERY_RETENTION_MS) return null;
      const answers = createEmptyDiscoveryAnswers();
      return { ...stored, phase: "report", answers, additionalText: "", submission: null, followupAnswers: [], snapshot: null };
    }
    const consent = stored.acceptedConsentVersion === DISCOVERY_CONSENT_VERSION ? DISCOVERY_CONSENT_VERSION : null;
    const hasReport = Boolean(stored.session?.runId || stored.snapshot?.run
      // A report request may have committed before its response was lost. Keep
      // the token until a read-only server check confirms whether a run exists.
      || discoveryNeedsReportVerification(stored));
    if (hasReport) return { ...stored, phase: "report", acceptedConsentVersion: consent };
    // Old unsubmitted sessions become editable v2 drafts. Their selected options
    // and historical supplement survive, but skipped answers must now be filled.
    if (stored.storageVersion === 1 || stored.phase === "clarifying" || stored.phase === "followups" || stored.submission?.schemaVersion === "competition-discovery.v1") {
      return migrateDiscoveryBrowserDraft(stored);
    }
    return { ...stored, acceptedConsentVersion: consent };
  } catch { return null; }
}

export function hasNewerDiscoveryBrowserRecord(current: Pick<DiscoveryBrowserState, "browserRecordId" | "recordCreatedAt"> & { followupEditedAt?: string | null; phase?: DiscoveryBrowserState["phase"] }, raw: string | null): boolean {
  if (!raw) return false;
  try {
    const incoming = z.object({ browserRecordId: z.string().uuid(), recordCreatedAt: z.number().int().nonnegative(), followupEditedAt: z.string().datetime().nullable().optional(), phase: discoveryPhaseSchema.optional() }).parse(JSON.parse(raw));
    if (incoming.recordCreatedAt !== current.recordCreatedAt) return incoming.recordCreatedAt > current.recordCreatedAt;
    if (incoming.browserRecordId !== current.browserRecordId) return incoming.browserRecordId > current.browserRecordId;
    if (current.phase === "report" && incoming.phase === "followups") return false;
    return current.phase === "followups" && incoming.phase === "report" || Date.parse(incoming.followupEditedAt ?? "") > Date.parse(current.followupEditedAt ?? "1970-01-01T00:00:00.000Z");
  } catch { return false; }
}

export const discoveryRunEnded = (run: DiscoveryRunSnapshot | null): boolean => Boolean(run && !["queued", "running"].includes(run.status));

export function applyDiscoveryEvent(run: DiscoveryRunSnapshot, event: DiscoveryEvent): DiscoveryRunSnapshot {
  if (event.runId !== run.runId || event.seq <= run.lastSeq) return run;
  if (event.seq !== run.lastSeq + 1) throw new Error("报告更新有缺口，正在重新同步。");
  const next = { ...run, lastSeq: event.seq };
  if (event.type === "reset") return { ...next, status: "running", attempt: event.attempt, markdown: "", sources: [], error: undefined, model: undefined, webSearchUsed: undefined,
    ...(next.presentationVersion ? { presentation: emptyDiscoveryPresentation() } : {}) };
  if (event.type === "text") return { ...next, status: "running", markdown: next.markdown + event.delta,
    ...(event.presentationRecord ? { presentationVersion: DISCOVERY_PRESENTATION_VERSION,
      presentation: applyDiscoveryPresentationRecord(next.presentation ?? emptyDiscoveryPresentation(), event.presentationRecord) } : {}) };
  if (event.type === "sources") return { ...next, sources: [...new Map([...run.sources, ...event.sources].map(source => [source.url, source])).values()] };
  if (event.type === "complete") return { ...next, status: "complete", model: event.model, webSearchUsed: event.webSearchUsed };
  if (event.type === "error") return { ...next, status: "failed", error: event.code };
  if (event.type === "cancelled") return { ...next, status: "cancelled" };
  return next;
}

export function discoveryDraftChanged(state: DiscoveryBrowserState, changes: Partial<Pick<DiscoveryBrowserState, "answers" | "additionalText" | "phase" | "questionIndex" | "acceptedConsentVersion">>): DiscoveryBrowserState {
  return { ...state, ...changes, expiresAt: new Date(Date.now() + DISCOVERY_RETENTION_MS).toISOString(), submission: null, reportRequestId: null };
}

/** Allows partially edited rankings in draft storage while transport validation stays strict. */
export function discoveryAnswersForDraft(value: unknown): DiscoveryAnswers | null {
  const parsed = draftAnswersSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function canonicalFollowupAnswers(snapshot: DiscoverySnapshot, answers: DiscoveryFollowupAnswer[]): DiscoveryFollowupAnswer[] {
  const valid = validateDiscoveryFollowupAnswers(snapshot.followups, answers);
  return snapshot.followups.map(question => {
    const answer = valid.find(item => item.questionId === question.id)!;
    return { ...answer, values: question.options.filter(option => answer.values.includes(option.value)).map(option => option.value) };
  });
}

export function discoveryFollowupSaveRequest(state: DiscoveryBrowserState): DiscoveryFollowupSaveRequest | null {
  if (state.phase !== "followups" || !state.session || state.session.runId || !state.snapshot || state.snapshot.run || !state.snapshot.followups.length || ["pending", "running"].includes(state.snapshot.clarificationStatus) || !state.followupEditedAt || state.followupEditedAt === state.followupSavedAt) return null;
  try { return { browserRecordId: state.browserRecordId, sessionId: state.session.sessionId, resumeToken: state.session.resumeToken, editedAt: state.followupEditedAt, answers: canonicalFollowupAnswers(state.snapshot, state.followupAnswers) }; }
  catch { return null; }
}

export function changeDiscoveryFollowup(state: DiscoveryBrowserState, answer: DiscoveryFollowupAnswer, now = Date.now()): DiscoveryBrowserState {
  if (state.phase !== "followups" || !state.session || state.session.runId || !state.snapshot || state.snapshot.run) return state;
  try {
    const previous = canonicalFollowupAnswers(state.snapshot, state.followupAnswers);
    const next = canonicalFollowupAnswers(state.snapshot, previous.map(item => item.questionId === answer.questionId ? answer : item));
    if (JSON.stringify(previous) === JSON.stringify(next)) return state;
    return { ...state, followupAnswers: next, followupEditedAt: new Date(Math.max(now, Date.parse(state.followupEditedAt ?? "1970-01-01T00:00:00.000Z") + 1)).toISOString() };
  } catch { return state; }
}

export function acknowledgeDiscoveryFollowupSave(state: DiscoveryBrowserState, request: DiscoveryFollowupSaveRequest, snapshot: DiscoverySnapshot): DiscoveryBrowserState | null {
  if (state.browserRecordId !== request.browserRecordId || state.session?.sessionId !== request.sessionId || state.phase !== "followups" || state.session.runId || state.snapshot?.run || snapshot.sessionId !== request.sessionId || snapshot.run) return null;
  const sent = canonicalFollowupAnswers(snapshot, request.answers);
  if (JSON.stringify(sent) !== JSON.stringify(canonicalFollowupAnswers(snapshot, snapshot.followupAnswers))) {
    if (state.followupSavedAt && Date.parse(state.followupSavedAt) > Date.parse(request.editedAt)) return state;
    throw new Error("补问已在其他页面更新，请刷新后核对。");
  }
  const newerSnapshot = Date.parse(snapshot.expiresAt) >= Date.parse(state.expiresAt);
  return { ...state, ...(newerSnapshot ? { snapshot, expiresAt: snapshot.expiresAt, session: { ...state.session, expiresAt: snapshot.expiresAt } } : {}),
    followupSavedAt: !state.followupSavedAt || Date.parse(request.editedAt) > Date.parse(state.followupSavedAt) ? request.editedAt : state.followupSavedAt };
}
