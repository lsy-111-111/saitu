import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { getPool } from "@/lib/db/pool";
import { isSupportedDiscoveryConsentVersion } from "./disclosure";
import { DISCOVERY_RUNTIME_POLICY } from "@/lib/ai/discovery-policy.mjs";
import { DEFAULT_DISCOVERY_GENERATION_PROTOCOL, DEFAULT_DISCOVERY_PRESENTATION_VERSION, isDiscoveryGenerationProtocol, type DiscoveryGenerationProtocol } from "./generation-protocol";
import { extractDiscoveryMarkdownSources, safeDiscoverySourceUrl } from "./sources";
import {
  DISCOVERY_PRESENTATION_VERSION, applyDiscoveryPresentationRecord, emptyDiscoveryPresentation,
  persistedPresentationRecordSchema, presentationRecordMarkdown, discoveryPresentationSchema,
  type DiscoveryPresentationState,
} from "./presentation";
import { sealV7, unsealV7, type SealedV7 } from "../v7/crypto";
import {
  assertServerDiscoveryAdmissionsOpen, assertServerDiscoveryQueueCapacity,
  isServerDiscoveryRuntime, lockServerDiscoveryAdmission, serverDiscoveryCanStartQueuedRun,
} from "./server-admission";
import {
  DISCOVERY_SCHEMA_VERSION, discoveryAnswersSchema, discoverySubmittedAnswersSchema, discoveryFollowupQuestionsSchema, validateDiscoveryFollowupAnswers,
  DISCOVERY_CLARIFY_DEADLINE_MS,
  type DiscoveryAnswers, type DiscoveryFollowupAnswer, type DiscoveryFollowupQuestion,
} from "./contracts";
import {
  DISCOVERY_REPORT_DEADLINE_MS, DISCOVERY_RETENTION_MS,
  type DiscoveryCatalogSnapshot, type DiscoveryClarificationStatus, type DiscoveryEvent,
  type DiscoveryEventPayload, type DiscoveryRunSnapshot, type DiscoveryRunStatus,
  type DiscoverySnapshot, type DiscoverySource,
} from "./transport";

type QueryClient = Pick<PoolClient, "query">;
type SessionRow = SealedV7 & {
  session_id: string; creation_key: string; input_sha256: string; status: "active" | "deleted" | "expired";
  clarification_status: DiscoveryClarificationStatus; clarification_request_key: string | null;
  clarification_owner: string | null; clarification_fence: string; clarification_lease_expires_at: Date | null;
  clarification_deadline_at: Date | null;
  current_run_id: string | null; created_at: Date; expires_at: Date;
};
export type DiscoverySessionBody = {
  schemaVersion?: "competition-discovery.v1" | "competition-discovery.v2";
  answers: DiscoveryAnswers; additionalText: string; consentVersion: string; catalogSnapshot: DiscoveryCatalogSnapshot;
  followups: DiscoveryFollowupQuestion[]; followupAnswers: DiscoveryFollowupAnswer[]; clarificationError?: string;
  followupEditedAt?: string; followupDraftRequestAt?: string;
};
export type DiscoveryRunBody = {
  markdown: string; sources: DiscoverySource[]; attempt: number; error?: string;
  model?: string; webSearchUsed?: boolean; runtimeBinding?: string;
  reasoningEffort: "max" | "high"; timeoutFallback: boolean;
  manualRetryOfRunId?: string;
  inheritedMaxTimeout?: { runId: string; callId: string; resetSeq: number };
  presentationVersion?: typeof DISCOVERY_PRESENTATION_VERSION;
  protocolVersion?: DiscoveryGenerationProtocol;
  presentation?: DiscoveryPresentationState;
};
export type DiscoveryRunRow = SealedV7 & {
  run_id: string; session_id: string; submission_key: string; input_sha256: string; status: DiscoveryRunStatus;
  next_event_seq: string; lease_owner: string | null; lease_fence: string; lease_expires_at: Date | null;
  submitted_at: Date; deadline_at: Date; expires_at: Date;
};
export type ClaimedDiscoveryRun = {
  row: DiscoveryRunRow; body: DiscoveryRunBody; session: DiscoverySessionBody;
  owner: string; fence: string;
};
export type DiscoveryClarificationClaim = {
  sessionId: string; owner: string; fence: string; expiresAt: string; deadlineEpochMs: number; body: DiscoverySessionBody;
};
const LEASE_MS = 20_000;
const sha256 = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const safeCode = (value: string) => /^[A-Z0-9_:-]{1,120}$/.test(value) ? value : "DISCOVERY_FAILED";
const isLive = (status: DiscoveryRunStatus) => status === "queued" || status === "running";

/** Stable identity retained for already-dispatched V9 calls as well as new work. */
export function discoveryModelInvocationId(runId: string, attempt: number): string {
  // Keep NUL separators as bytes: SWC can otherwise fold a literal attempt
  // into an invalid octal escape while collecting the production routes.
  const bytes = createHash("sha256").update("saitu-discovery-report.v1").update(Buffer.from([0]))
    .update(runId).update(Buffer.from([0])).update(String(attempt)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function resumeSecret() {
  const value = process.env.AI_CONVERSATION_SIGNING_SECRET?.trim();
  if ((!value || value.length < 32) && process.env.NODE_ENV === "production") throw new Error("DISCOVERY_STATE_UNAVAILABLE");
  return value || "development-only-discovery-token-secret-do-not-deploy";
}
function resumeToken(sessionId: string, expiresAt: Date) {
  const value = `discovery.v1.${sessionId}.${expiresAt.getTime()}`;
  return `${value}.${createHmac("sha256", resumeSecret()).update(value).digest("base64url")}`;
}
export function verifyDiscoveryResumeToken(token: string): { sessionId: string; expiresAt: number } | null {
  try {
    const match = /^discovery\.v1\.([a-f0-9-]{36})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match || !z.string().uuid().safeParse(match[1]).success) return null;
    const expiresAt = Number(match[2]);
    // The signed initial expiry is metadata. The database owns the moving
    // retention deadline so a closed browser can recover 24h after completion.
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
    const bytes = Buffer.from(match[3], "base64url");
    if (bytes.toString("base64url") !== match[3]) return null;
    const expected = createHmac("sha256", resumeSecret()).update(`discovery.v1.${match[1]}.${match[2]}`).digest();
    return bytes.length === expected.length && timingSafeEqual(bytes, expected) ? { sessionId: match[1], expiresAt } : null;
  } catch { return null; }
}
async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try { await client.query("begin"); const value = await work(client); await client.query("commit"); return value; }
  catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}
async function sessionForToken(client: QueryClient, token: string, lock = false): Promise<{ row: SessionRow; body: DiscoverySessionBody }> {
  const verified = verifyDiscoveryResumeToken(token);
  if (!verified) throw new Error("DISCOVERY_SESSION_EXPIRED");
  const row = (await client.query<SessionRow>(`select * from competition_discovery_sessions where session_id=$1 and status='active' and expires_at>now()${lock ? " for update" : ""}`, [verified.sessionId])).rows[0];
  if (!row) throw new Error("DISCOVERY_SESSION_EXPIRED");
  return { row, body: unsealV7<DiscoverySessionBody>(`discovery-session:${row.session_id}`, row) };
}
function presentRun(row: DiscoveryRunRow, body: DiscoveryRunBody): DiscoveryRunSnapshot {
  // Read projection only: old completed reports may contain valid plain URLs
  // without a saved sources event. Keep the original prose and search metadata.
  const sources = new Map<string, DiscoverySource>();
  const recovered = row.status === "complete" ? extractDiscoveryMarkdownSources(body.markdown) : [];
  for (const source of [...body.sources, ...recovered]) {
    const url = safeDiscoverySourceUrl(source.url);
    if (!url || sources.has(url)) continue;
    sources.set(url, { url, title: source.title.trim() ? source.title : url });
  }
  return {
    runId: row.run_id, status: row.status, markdown: body.markdown, sources: [...sources.values()],
    lastSeq: Number(row.next_event_seq), attempt: body.attempt, submittedAt: row.submitted_at.toISOString(), deadlineAt: row.deadline_at.toISOString(),
    ...(body.error ? { error: body.error } : {}), ...(body.model ? { model: body.model } : {}),
    ...(body.webSearchUsed === undefined ? {} : { webSearchUsed: body.webSearchUsed }),
    ...(body.manualRetryOfRunId ? { manualRetryOfRunId: body.manualRetryOfRunId } : {}),
    ...(body.inheritedMaxTimeout ? { maxTimeoutRunId: body.inheritedMaxTimeout.runId } : {}),
    ...(body.presentationVersion === DISCOVERY_PRESENTATION_VERSION ? {
      presentationVersion: body.presentationVersion,
      presentation: discoveryPresentationSchema.parse(body.presentation ?? emptyDiscoveryPresentation()),
    } : {}),
  };
}
async function snapshot(client: QueryClient, row: SessionRow, body: DiscoverySessionBody): Promise<DiscoverySnapshot> {
  const runRow = row.current_run_id ? (await client.query<DiscoveryRunRow>("select * from competition_discovery_runs where run_id=$1 and session_id=$2", [row.current_run_id, row.session_id])).rows[0] : undefined;
  const run = runRow && !["deleted", "expired"].includes(runRow.status)
    ? presentRun(runRow, unsealV7<DiscoveryRunBody>(`discovery-run:${runRow.run_id}`, runRow)) : null;
  const status: DiscoverySnapshot["status"] = run ? isLive(run.status) ? "generating" : run.status === "complete" ? "complete" : run.status === "cancelled" ? "cancelled" : "failed"
    : row.clarification_status === "pending" || row.clarification_status === "running" ? "clarifying"
      : body.followups.length ? "followups" : "ready";
  return { ...(body.schemaVersion ? { schemaVersion: body.schemaVersion } : {}), sessionId: row.session_id, expiresAt: row.expires_at.toISOString(), status, answers: body.answers, additionalText: body.additionalText,
    followups: body.followups,
    followupAnswers: body.followups.map(question => body.followupAnswers.find(answer => answer.questionId === question.id)
      ?? { questionId: question.id, status: "skipped" as const, values: [] }),
    ...(body.followupEditedAt ? { followupEditedAt: body.followupEditedAt } : {}),
    clarificationStatus: row.clarification_status === "failed" ? "skipped" : row.clarification_status,
    ...(body.clarificationError ? { clarificationError: body.clarificationError } : {}), run };
}
function validateCatalog(input: DiscoveryCatalogSnapshot): DiscoveryCatalogSnapshot {
  const value = z.object({ version: z.string().min(1).max(180), count: z.number().int().positive(), ids: z.array(z.string().min(1).max(180)),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().min(1), clarifyText: z.string().min(1), byteLength: z.number().int().positive() }).strict().parse(input);
  if (value.ids.length !== value.count || new Set(value.ids).size !== value.count || Buffer.byteLength(value.text) !== value.byteLength
    || sha256(value.text) !== value.sha256 || value.byteLength > 6_000_000) throw new Error("DISCOVERY_CATALOG_INVALID");
  return value;
}
export async function createDiscoverySession(input: {
  schemaVersion?: "competition-discovery.v1" | "competition-discovery.v2";
  answers: DiscoveryAnswers; additionalText: string; catalogSnapshot: DiscoveryCatalogSnapshot;
  consentVersion: string; clientRequestId: string;
}): Promise<{ created: boolean; resumeToken: string; snapshot: DiscoverySnapshot }> {
  const modern = input.schemaVersion === DISCOVERY_SCHEMA_VERSION;
  const body: DiscoverySessionBody = { ...(input.schemaVersion ? { schemaVersion: input.schemaVersion } : {}), answers: (modern ? discoverySubmittedAnswersSchema : discoveryAnswersSchema).parse(input.answers), additionalText: input.additionalText,
    consentVersion: z.string().min(1).max(120).parse(input.consentVersion), catalogSnapshot: validateCatalog(input.catalogSnapshot), followups: [], followupAnswers: [] };
  if (typeof body.additionalText !== "string" || Array.from(body.additionalText).length > 200) throw new Error("DISCOVERY_INPUT_INVALID");
  z.string().min(12).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(input.clientRequestId);
  const creationKey = sha256(["discovery-create.v1", input.clientRequestId]), inputHash = sha256(body);
  return transaction(async client => {
    await lockServerDiscoveryAdmission(client);
    const existing = isServerDiscoveryRuntime()
      ? (await client.query<SessionRow>("select * from competition_discovery_sessions where creation_key=$1 for update", [creationKey])).rows[0]
      : undefined;
    if (!existing) assertServerDiscoveryAdmissionsOpen();
    const id = randomUUID(), expiresAt = new Date(Date.now() + DISCOVERY_RETENTION_MS), sealed = sealV7(`discovery-session:${id}`, body);
    const inserted = existing ? { rows: [], rowCount: 0 } : await client.query<SessionRow>(`insert into competition_discovery_sessions(session_id,creation_key,input_sha256,ciphertext,iv,tag,expires_at,clarification_status)
      values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(creation_key) do nothing returning *`, [id, creationKey, inputHash, sealed.ciphertext, sealed.iv, sealed.tag, expiresAt, modern ? "complete" : "pending"]);
    const row = existing ?? inserted.rows[0] ?? (await client.query<SessionRow>("select * from competition_discovery_sessions where creation_key=$1 for update", [creationKey])).rows[0];
    if (!row || row.status !== "active" || row.expires_at.getTime() <= Date.now()) throw new Error("DISCOVERY_SESSION_EXPIRED");
    if (row.input_sha256 !== inputHash) throw new Error("DISCOVERY_REQUEST_CHANGED");
    const stored = unsealV7<DiscoverySessionBody>(`discovery-session:${row.session_id}`, row);
    return { created: inserted.rowCount === 1, resumeToken: resumeToken(row.session_id, row.expires_at), snapshot: await snapshot(client, row, stored) };
  });
}
export async function getDiscoverySnapshot(token: string): Promise<DiscoverySnapshot> {
  const session = await sessionForToken(getPool(), token);
  return snapshot(getPool(), session.row, session.body);
}
/** Recovery lookup only: it never creates a session, claims work, or calls a model. */
export async function findDiscoverySessionBySubmission(input: {
  schemaVersion?: "competition-discovery.v1" | "competition-discovery.v2";
  answers: DiscoveryAnswers; additionalText: string; consentVersion: string; clientRequestId: string;
}): Promise<{ resumeToken: string; snapshot: DiscoverySnapshot } | null> {
  z.string().min(12).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(input.clientRequestId);
  const row = (await getPool().query<SessionRow>("select * from competition_discovery_sessions where creation_key=$1 and status='active' and expires_at>now()", [sha256(["discovery-create.v1", input.clientRequestId])])).rows[0];
  if (!row) return null;
  const body = unsealV7<DiscoverySessionBody>(`discovery-session:${row.session_id}`, row);
  const expected = { answers: discoveryAnswersSchema.parse(input.answers), additionalText: input.additionalText, consentVersion: input.consentVersion };
  if (input.schemaVersion !== body.schemaVersion || sha256(expected) !== sha256({ answers: body.answers, additionalText: body.additionalText, consentVersion: body.consentVersion })) throw new Error("DISCOVERY_REQUEST_CHANGED");
  return { resumeToken: resumeToken(row.session_id, row.expires_at), snapshot: await snapshot(getPool(), row, body) };
}
export async function claimDiscoveryClarification(token: string, requestId: string, owner = randomUUID()): Promise<
  { kind: "claimed"; claim: DiscoveryClarificationClaim } | { kind: "in_progress" | "complete"; snapshot: DiscoverySnapshot }
> {
  z.string().min(12).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(requestId);
  return transaction(async client => {
    const { row, body } = await sessionForToken(client, token, true);
    if (["complete", "failed"].includes(row.clarification_status)) return { kind: "complete", snapshot: await snapshot(client, row, body) };
    if (row.clarification_status === "running") {
      if (row.clarification_lease_expires_at && row.clarification_lease_expires_at.getTime() > Date.now()) return { kind: "in_progress", snapshot: await snapshot(client, row, body) };
      // An already dispatched clarification has an unknown outcome. Do not dispatch it twice after a crash.
      body.clarificationError = "DISCOVERY_CLARIFICATION_INTERRUPTED";
      const sealed = sealV7(`discovery-session:${row.session_id}`, body);
      await client.query("update competition_discovery_sessions set clarification_status='failed',clarification_owner=null,clarification_lease_expires_at=null,ciphertext=$2,iv=$3,tag=$4,updated_at=now() where session_id=$1", [row.session_id, sealed.ciphertext, sealed.iv, sealed.tag]);
      row.clarification_status = "failed";
      return { kind: "complete", snapshot: await snapshot(client, row, body) };
    }
    const changed = (await client.query<SessionRow>(`update competition_discovery_sessions set clarification_status='running',clarification_request_key=$2,
      clarification_owner=$3,clarification_fence=clarification_fence+1,clarification_deadline_at=now()+($4::int*interval '1 millisecond'),
      clarification_lease_expires_at=now()+($4::int*interval '1 millisecond')+interval '5 seconds',updated_at=now() where session_id=$1 returning *`, [row.session_id, sha256(requestId), owner, DISCOVERY_CLARIFY_DEADLINE_MS])).rows[0];
    return { kind: "claimed", claim: { sessionId: row.session_id, owner, fence: String(changed.clarification_fence), expiresAt: row.expires_at.toISOString(), deadlineEpochMs: changed.clarification_deadline_at!.getTime(), body } };
  });
}
export async function finishDiscoveryClarification(claim: DiscoveryClarificationClaim, result: { questions: DiscoveryFollowupQuestion[]; error?: string }): Promise<DiscoverySnapshot> {
  const questions = discoveryFollowupQuestionsSchema.parse(result.questions);
  return transaction(async client => {
    const row = (await client.query<SessionRow>(`select * from competition_discovery_sessions where session_id=$1 and status='active' and expires_at>now()
      and clarification_status='running' and clarification_owner=$2 and clarification_fence=$3 and clarification_lease_expires_at>now() for update`, [claim.sessionId, claim.owner, claim.fence])).rows[0];
    if (!row) throw new Error("DISCOVERY_LEASE_LOST");
    const body = unsealV7<DiscoverySessionBody>(`discovery-session:${row.session_id}`, row);
    body.followups = questions;
    if (result.error) body.clarificationError = safeCode(result.error); else delete body.clarificationError;
    const sealed = sealV7(`discovery-session:${row.session_id}`, body);
    await client.query(`update competition_discovery_sessions set clarification_status=$2,clarification_owner=null,clarification_lease_expires_at=null,
      ciphertext=$3,iv=$4,tag=$5,updated_at=now() where session_id=$1`, [row.session_id, result.error ? "failed" : "complete", sealed.ciphertext, sealed.iv, sealed.tag]);
    row.clarification_status = result.error ? "failed" : "complete";
    return snapshot(client, row, body);
  });
}
function validateFollowups(questions: DiscoveryFollowupQuestion[], input: DiscoveryFollowupAnswer[]) {
  try { return validateDiscoveryFollowupAnswers(questions, input); }
  catch { throw new Error("DISCOVERY_FOLLOWUP_INVALID"); }
}
/** Supplemental answers are still a draft until the first report is submitted.
 * The session lock also serializes this edit with enqueue, clear and expiry. */
export async function saveDiscoveryFollowupDraft(token: string, input: {
  followupAnswers: DiscoveryFollowupAnswer[]; editedAt: string;
}): Promise<DiscoverySnapshot> {
  if (!z.string().datetime().safeParse(input.editedAt).success) throw new Error("DISCOVERY_DRAFT_TIME_INVALID");
  const requestedAt = Date.parse(input.editedAt);
  return transaction(async client => {
    const { row, body } = await sessionForToken(client, token, true);
    if (row.expires_at.getTime() <= Date.now()) throw new Error("DISCOVERY_SESSION_EXPIRED");
    if (!["complete", "failed", "skipped"].includes(row.clarification_status)) throw new Error("DISCOVERY_DRAFT_NOT_READY");
    const report = (await client.query("select 1 from competition_discovery_runs where session_id=$1 limit 1", [row.session_id])).rows[0];
    if (row.current_run_id || report) throw new Error("DISCOVERY_REPORT_ALREADY_CREATED");
    const now = Date.now();
    // Bounded clock skew is accepted, but never grants future retention time.
    if (requestedAt > now + 60_000 || requestedAt < row.created_at.getTime() - 60_000) throw new Error("DISCOVERY_DRAFT_TIME_INVALID");
    const answers = validateFollowups(body.followups, input.followupAnswers);
    const canonical = (values: DiscoveryFollowupAnswer[]) => body.followups.map(question => {
      const answer = values.find(item => item.questionId === question.id) ?? { questionId: question.id, status: "skipped" as const, values: [] };
      return { ...answer, values: question.options.filter(option => answer.values.includes(option.value)).map(option => option.value) };
    });
    const nextAnswers = canonical(answers);
    const previousAt = Date.parse(body.followupDraftRequestAt ?? body.followupEditedAt ?? "");
    if (Number.isFinite(previousAt) && requestedAt <= previousAt) return snapshot(client, row, body);
    const changed = sha256(nextAnswers) !== sha256(canonical(body.followupAnswers));
    const editedAt = Math.min(requestedAt, now);
    if (changed) {
      body.followupAnswers = nextAnswers;
      body.followupEditedAt = new Date(editedAt).toISOString();
    }
    // Even an unchanged newer draft fences a delayed older edit. Its request
    // watermark is encrypted and does not count as an edit or extend retention.
    body.followupDraftRequestAt = input.editedAt;
    const expiresAt = changed ? new Date(Math.max(row.expires_at.getTime(), editedAt + DISCOVERY_RETENTION_MS)) : row.expires_at;
    const sealed = sealV7(`discovery-session:${row.session_id}`, body);
    const updated = await client.query(`update competition_discovery_sessions set ciphertext=$2,iv=$3,tag=$4,expires_at=$5,updated_at=now()
      where session_id=$1 and status='active' and expires_at>clock_timestamp() returning session_id`, [row.session_id, sealed.ciphertext, sealed.iv, sealed.tag, expiresAt]);
    if (updated.rowCount !== 1) throw new Error("DISCOVERY_SESSION_EXPIRED");
    row.expires_at = expiresAt;
    return snapshot(client, row, body);
  });
}
async function inheritedMaxTimeout(client: QueryClient, previous: DiscoveryRunRow): Promise<DiscoveryRunBody["inheritedMaxTimeout"]> {
  const previousBody = unsealV7<DiscoveryRunBody>(`discovery-run:${previous.run_id}`, previous);
  if (["DISCOVERY_AUTHENTICATION_ERROR", "DISCOVERY_REFUSAL"].includes(previousBody.error ?? "")) return undefined;
  const proofRunId = previousBody.inheritedMaxTimeout?.runId ?? previous.run_id;
  const proof = proofRunId === previous.run_id ? previous : (await client.query<DiscoveryRunRow>(`select * from competition_discovery_runs
    where run_id=$1 and session_id=$2 and input_sha256=$3 and ciphertext is not null`, [proofRunId, previous.session_id, previous.input_sha256])).rows[0];
  if (!proof) return undefined;
  const proofBody = unsealV7<DiscoveryRunBody>(`discovery-run:${proof.run_id}`, proof);
  if (proofBody.reasoningEffort !== "high" || !proofBody.timeoutFallback || proofBody.attempt < 2
    || ["DISCOVERY_AUTHENTICATION_ERROR", "DISCOVERY_REFUSAL"].includes(proofBody.error ?? "")) return undefined;
  const events = (await client.query<SealedV7 & { seq: string; created_at: Date }>(`select seq,ciphertext,iv,tag,created_at
    from competition_discovery_events where run_id=$1 and redacted=false order by seq`, [proof.run_id])).rows;
  for (const event of events) {
    const payload = unsealV7<DiscoveryEventPayload>(`discovery-event:${proof.run_id}:${event.seq}`, event);
    if (payload.type !== "reset" || payload.reason !== "timeout" || payload.attempt !== 2) continue;
    const callId = discoveryModelInvocationId(proof.run_id, 1);
    const dispatched = (await client.query(`select 1 from saitu_discovery_call_receipts r join ai_spend_ledger l on l.id=r.call_id
      where r.call_id=$1 and r.dispatched_at is not null and r.dispatched_at<=$2
      and l.operation='competition_discovery_report' and l.effort='max' and l.model='deepseek-flash'`, [callId, event.created_at])).rows[0];
    if (dispatched) return { runId: proof.run_id, callId, resetSeq: Number(event.seq) };
  }
  return undefined;
}
/** The optional format selector belongs to the internal acceptance harness.
 * HTTP submissions use the accepted default, which remains legacy Markdown
 * until the card rollout passes its quality and performance gate. */
export async function enqueueDiscoveryReport(token: string, input: { clientRequestId: string; followupAnswers: DiscoveryFollowupAnswer[] },
  options?: {
    presentationVersion?: "legacy" | typeof DISCOVERY_PRESENTATION_VERSION;
    protocolVersion?: DiscoveryGenerationProtocol;
    /** Local synthetic capture registration must precede commit so a worker
     * cannot claim the task before its exact invocation is authorized. */
    onPrepared?: (prepared: { runId: string; answers: DiscoveryAnswers; additionalText: string;
      followups: { question: DiscoveryFollowupQuestion; answer: DiscoveryFollowupAnswer }[]; catalogSha256: string }) => Promise<void>;
  },
): Promise<{ created: boolean; snapshot: DiscoverySnapshot; consentVersion: string }> {
  z.string().min(12).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(input.clientRequestId);
  const presentationVersion = options?.presentationVersion ?? DEFAULT_DISCOVERY_PRESENTATION_VERSION;
  if (presentationVersion !== "legacy" && presentationVersion !== DISCOVERY_PRESENTATION_VERSION) throw new Error("DISCOVERY_PRESENTATION_VERSION_INVALID");
  if (options?.protocolVersion !== undefined && (isServerDiscoveryRuntime() || presentationVersion === "legacy"
    || !isDiscoveryGenerationProtocol(options.protocolVersion))) throw new Error("DISCOVERY_GENERATION_PROTOCOL_INVALID");
  if (options?.onPrepared && isServerDiscoveryRuntime()) throw new Error("DISCOVERY_SYNTHETIC_CAPTURE_LOCAL_ONLY");
  const protocolVersion = options?.protocolVersion ?? DEFAULT_DISCOVERY_GENERATION_PROTOCOL;
  return transaction(async client => {
    await lockServerDiscoveryAdmission(client);
    const { row: sessionRow, body } = await sessionForToken(client, token, true);
    if (sessionRow.expires_at.getTime() <= Date.now()) throw new Error("DISCOVERY_SESSION_EXPIRED");
    if (!isSupportedDiscoveryConsentVersion(body.consentVersion)) throw new Error("DISCOVERY_CONSENT_CHANGED");
    if (["pending", "running"].includes(sessionRow.clarification_status)) throw new Error("DISCOVERY_CLARIFICATION_IN_PROGRESS");
    const followupAnswers = validateFollowups(body.followups, input.followupAnswers);
    const submissionKey = sha256(["discovery-report.v1", sessionRow.session_id, input.clientRequestId]);
    const inputHash = sha256({ input: sessionRow.input_sha256, questions: body.followups, followupAnswers });
    const existing = (await client.query<DiscoveryRunRow>("select * from competition_discovery_runs where submission_key=$1", [submissionKey])).rows[0];
    if (existing) {
      if (existing.input_sha256 !== inputHash) throw new Error("DISCOVERY_REQUEST_CHANGED");
      if (existing.run_id !== sessionRow.current_run_id) throw new Error("DISCOVERY_RUN_SUPERSEDED");
      return { created: false, snapshot: await snapshot(client, sessionRow, body), consentVersion: body.consentVersion };
    }
    let previousRunId: string | undefined, maxTimeout: DiscoveryRunBody["inheritedMaxTimeout"];
    if (sessionRow.current_run_id) {
      const current = (await client.query<DiscoveryRunRow>("select * from competition_discovery_runs where run_id=$1 for update", [sessionRow.current_run_id])).rows[0];
      if (current && current.input_sha256 !== inputHash) throw new Error("DISCOVERY_REQUEST_CHANGED");
      if (current && isLive(current.status)) {
        return { created: false, snapshot: await snapshot(client, sessionRow, body), consentVersion: body.consentVersion };
      }
      if (current?.status === "complete") throw new Error("DISCOVERY_ALREADY_COMPLETE");
      if (current) {
        previousRunId = current.run_id;
        maxTimeout = await inheritedMaxTimeout(client, current);
        await client.query("update competition_discovery_runs set status='superseded',lease_owner=null,lease_expires_at=null,updated_at=now() where run_id=$1 and status not in ('deleted','expired')", [current.run_id]);
      }
    }
    assertServerDiscoveryAdmissionsOpen();
    await assertServerDiscoveryQueueCapacity(client);
    const runId = randomUUID(), submittedAt = new Date(), deadline = new Date(submittedAt.getTime() + DISCOVERY_REPORT_DEADLINE_MS);
    const expiresAt = new Date(Math.max(sessionRow.expires_at.getTime(), deadline.getTime() + DISCOVERY_RETENTION_MS));
    body.followupAnswers = followupAnswers;
    if (options?.onPrepared) await options.onPrepared({ runId, answers: body.answers, additionalText: body.additionalText,
      followups: body.followups.map(question => ({ question, answer: followupAnswers.find(answer => answer.questionId === question.id)! })),
      catalogSha256: body.catalogSnapshot.sha256 });
    const runBody: DiscoveryRunBody = { markdown: "", sources: [], webSearchUsed: false, attempt: 1,
      ...(presentationVersion === DISCOVERY_PRESENTATION_VERSION ? { presentationVersion, protocolVersion, presentation: emptyDiscoveryPresentation() } : {}),
      reasoningEffort: maxTimeout ? "high" : DISCOVERY_RUNTIME_POLICY.initialEffort, timeoutFallback: Boolean(maxTimeout),
      ...(previousRunId ? { manualRetryOfRunId: previousRunId } : {}), ...(maxTimeout ? { inheritedMaxTimeout: maxTimeout } : {}),
      runtimeBinding: process.env.SAITU_DISCOVERY_SOURCE_SHA256 || "development" };
    const sealed = sealV7(`discovery-run:${runId}`, runBody), sessionSealed = sealV7(`discovery-session:${sessionRow.session_id}`, body);
    await client.query(`insert into competition_discovery_runs(run_id,session_id,submission_key,input_sha256,status,ciphertext,iv,tag,submitted_at,deadline_at,expires_at)
      values($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10)`, [runId, sessionRow.session_id, submissionKey, inputHash, sealed.ciphertext, sealed.iv, sealed.tag, submittedAt, deadline, expiresAt]);
    const updated = await client.query(`update competition_discovery_sessions set current_run_id=$2,ciphertext=$3,iv=$4,tag=$5,expires_at=$6,updated_at=now()
      where session_id=$1 and status='active' and expires_at>clock_timestamp() returning session_id`, [sessionRow.session_id, runId, sessionSealed.ciphertext, sessionSealed.iv, sessionSealed.tag, expiresAt]);
    if (updated.rowCount !== 1) throw new Error("DISCOVERY_SESSION_EXPIRED");
    sessionRow.current_run_id = runId;
    sessionRow.expires_at = expiresAt;
    return { created: true, snapshot: await snapshot(client, sessionRow, body), consentVersion: body.consentVersion };
  });
}
export async function listDiscoveryEvents(token: string, afterSeq = 0, expectedRunId?: string): Promise<DiscoveryEvent[]> {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("DISCOVERY_CURSOR_INVALID");
  const { row } = await sessionForToken(getPool(), token);
  if (expectedRunId && expectedRunId !== row.current_run_id) throw new Error("DISCOVERY_RUN_NOT_FOUND");
  if (!row.current_run_id) return [];
  const events = (await getPool().query<SealedV7 & { seq: string; created_at: Date }>(`select e.seq,e.ciphertext,e.iv,e.tag,e.created_at from competition_discovery_events e
    join competition_discovery_sessions s on s.current_run_id=e.run_id where s.session_id=$1 and s.status='active' and s.expires_at>now()
    and e.seq>$2 and e.run_id=$3 and e.redacted=false order by e.seq limit 512`, [row.session_id, afterSeq, row.current_run_id])).rows;
  return events.map(event => ({ ...unsealV7<DiscoveryEventPayload>(`discovery-event:${row.current_run_id}:${event.seq}`, event), seq: Number(event.seq), runId: row.current_run_id!, at: event.created_at.toISOString() }));
}
export async function claimDiscoveryRun(owner = `discovery-${randomUUID()}`): Promise<ClaimedDiscoveryRun | null> {
  return transaction(async client => {
    await lockServerDiscoveryAdmission(client);
    const canStartQueued = await serverDiscoveryCanStartQueuedRun(client);
    const row = (await client.query<DiscoveryRunRow>(`select r.* from competition_discovery_runs r join competition_discovery_sessions s on s.session_id=r.session_id
      where r.status in ('queued','running') and r.expires_at>now() and s.status='active' and s.expires_at>now() and s.current_run_id=r.run_id
      ${canStartQueued ? "" : "and r.status='running'"}
      and (r.lease_expires_at is null or r.lease_expires_at<now()) order by r.submitted_at for update of r skip locked limit 1`)).rows[0];
    if (!row) return null;
    const previousStatus = row.status;
    const changed = (await client.query<DiscoveryRunRow>(`update competition_discovery_runs set status='running',lease_owner=$2,lease_fence=lease_fence+1,
      lease_expires_at=now()+($3::int*interval '1 millisecond'),updated_at=now() where run_id=$1 returning *`, [row.run_id, owner, LEASE_MS])).rows[0];
    const session = (await client.query<SessionRow>("select * from competition_discovery_sessions where session_id=$1", [row.session_id])).rows[0];
    const body = unsealV7<DiscoveryRunBody>(`discovery-run:${row.run_id}`, row);
    // A running task after lease loss may already have incurred a provider call; never silently replay it.
    if (previousStatus === "running") body.error = "DISCOVERY_WORKER_INTERRUPTED";
    return { row: changed, body, session: unsealV7<DiscoverySessionBody>(`discovery-session:${session.session_id}`, session), owner, fence: String(changed.lease_fence) };
  });
}
export async function renewDiscoveryRunLease(claim: ClaimedDiscoveryRun): Promise<boolean> {
  const result = await getPool().query(`update competition_discovery_runs r set lease_expires_at=now()+($4::int*interval '1 millisecond')
    where r.run_id=$1 and r.lease_owner=$2 and r.lease_fence=$3 and r.status='running' and r.lease_expires_at>now() and r.expires_at>now()
    and exists(select 1 from competition_discovery_sessions s where s.session_id=r.session_id and s.status='active' and s.expires_at>now() and s.current_run_id=r.run_id)`, [claim.row.run_id, claim.owner, claim.fence, LEASE_MS]);
  return result.rowCount === 1;
}
export async function releaseDiscoveryRunLease(claim: ClaimedDiscoveryRun): Promise<void> {
  await getPool().query("update competition_discovery_runs set lease_owner=null,lease_expires_at=null where run_id=$1 and lease_owner=$2 and lease_fence=$3", [claim.row.run_id, claim.owner, claim.fence]);
}
function applyEvent(body: DiscoveryRunBody, payload: DiscoveryEventPayload) {
  if (payload.type === "text") {
    if (payload.presentationRecord) {
      if (body.presentationVersion !== DISCOVERY_PRESENTATION_VERSION) throw new Error("DISCOVERY_PRESENTATION_VERSION_INVALID");
      const record = payload.presentationRecord;
      if (payload.delta !== presentationRecordMarkdown(record)) throw new Error("DISCOVERY_PRESENTATION_MARKDOWN_INVALID");
      body.presentation = applyDiscoveryPresentationRecord(body.presentation ?? emptyDiscoveryPresentation(), record);
    } else if (body.presentationVersion === DISCOVERY_PRESENTATION_VERSION) {
      throw new Error("DISCOVERY_PRESENTATION_RECORD_REQUIRED");
    }
    body.markdown += payload.delta;
  }
  if (payload.type === "sources") body.sources = [...new Map([...body.sources, ...payload.sources].map(source => [source.url, source])).values()];
  if (payload.type === "tool") body.webSearchUsed = true;
  if (payload.type === "reset") {
    body.markdown = ""; body.sources = []; body.attempt = payload.attempt; body.webSearchUsed = false; delete body.model;
    if (body.presentationVersion === DISCOVERY_PRESENTATION_VERSION) body.presentation = emptyDiscoveryPresentation();
    else delete body.presentation;
    if (payload.reason === "timeout") {
      body.reasoningEffort = "high";
      body.timeoutFallback = true;
    }
    delete body.error;
  }
  if (payload.type === "error") body.error = safeCode(payload.code);
  if (payload.type === "complete") {
    if (body.presentationVersion === DISCOVERY_PRESENTATION_VERSION && (!body.presentation?.profile || !body.presentation.conclusion)) {
      throw new Error("DISCOVERY_PRESENTATION_INCOMPLETE");
    }
    if (payload.model) body.model = payload.model;
    if (payload.webSearchUsed !== undefined) body.webSearchUsed = payload.webSearchUsed;
  }
}
export async function appendDiscoveryRunEvent(claim: ClaimedDiscoveryRun, payload: DiscoveryEventPayload): Promise<DiscoveryEvent> {
  if (payload.type === "text" && payload.presentationRecord) {
    payload = { ...payload, presentationRecord: persistedPresentationRecordSchema.parse(payload.presentationRecord) };
  }
  const committed = await transaction(async client => {
    // Every operation that writes both tables locks the session first.
    // Completion/retention must not deadlock with cancel, clear, or enqueue.
    const session = (await client.query<{ session_id: string }>(`select session_id from competition_discovery_sessions
      where session_id=$1 and status='active' and expires_at>now() and current_run_id=$2 for update`, [claim.row.session_id, claim.row.run_id])).rows[0];
    if (!session) throw new Error("DISCOVERY_LEASE_LOST");
    const row = (await client.query<DiscoveryRunRow>(`select * from competition_discovery_runs
      where run_id=$1 and lease_owner=$2 and lease_fence=$3 and lease_expires_at>now() and status='running'
      and expires_at>now() for update`, [claim.row.run_id, claim.owner, claim.fence])).rows[0];
    if (!row) throw new Error("DISCOVERY_LEASE_LOST");
    if (payload.type !== "error" && payload.type !== "cancelled" && !(payload.type === "reset" && payload.reason === "withdrawn")
      && row.deadline_at.getTime() <= Date.now()) throw new Error("DISCOVERY_TIMEOUT");
    const body = unsealV7<DiscoveryRunBody>(`discovery-run:${row.run_id}`, row);
    applyEvent(body, payload);
    const seq = Number(row.next_event_seq) + 1, at = new Date();
    const event = sealV7(`discovery-event:${row.run_id}:${seq}`, payload), sealed = sealV7(`discovery-run:${row.run_id}`, body);
    const status: DiscoveryRunStatus = payload.type === "complete" ? "complete" : payload.type === "error" ? "failed" : payload.type === "cancelled" ? "cancelled" : "running";
    if (payload.type === "reset" && payload.reason === "withdrawn") {
      await client.query("update competition_discovery_events set ciphertext=null,iv=null,tag=null,redacted=true where run_id=$1", [row.run_id]);
    }
    const expiresAt = status === "running" ? row.expires_at : new Date(at.getTime() + DISCOVERY_RETENTION_MS);
    if (status !== "running") await client.query("update competition_discovery_sessions set expires_at=$2,updated_at=now() where session_id=$1 and status='active'", [row.session_id, expiresAt]);
    await client.query("insert into competition_discovery_events(run_id,seq,ciphertext,iv,tag,created_at) values($1,$2,$3,$4,$5,$6)", [row.run_id, seq, event.ciphertext, event.iv, event.tag, at]);
    const updated = (await client.query<DiscoveryRunRow>(`update competition_discovery_runs set status=$2,ciphertext=$3,iv=$4,tag=$5,next_event_seq=$6,
      lease_owner=case when $7 then null else lease_owner end,lease_expires_at=case when $7 then null else lease_expires_at end,expires_at=$8,updated_at=now() where run_id=$1 returning *`, [row.run_id, status, sealed.ciphertext, sealed.iv, sealed.tag, seq, status !== "running", expiresAt])).rows[0];
    return { row: updated, body, event: { ...payload, seq, runId: row.run_id, at: at.toISOString() } };
  });
  // A failed insert/update/commit must not advance the worker's in-memory
  // projection beyond the durable sequence that a reconnect can recover.
  claim.row = committed.row;
  claim.body = committed.body;
  return committed.event;
}
export async function cancelDiscoveryRun(token: string): Promise<DiscoverySnapshot> {
  return transaction(async client => {
    const { row, body } = await sessionForToken(client, token, true);
    if (row.current_run_id) {
      const run = (await client.query<DiscoveryRunRow>("select * from competition_discovery_runs where run_id=$1 for update", [row.current_run_id])).rows[0];
      if (run && isLive(run.status)) {
        const seq = Number(run.next_event_seq) + 1, event = sealV7(`discovery-event:${run.run_id}:${seq}`, { type: "cancelled" });
        await client.query("insert into competition_discovery_events(run_id,seq,ciphertext,iv,tag) values($1,$2,$3,$4,$5)", [run.run_id, seq, event.ciphertext, event.iv, event.tag]);
        const expiresAt = new Date(Date.now() + DISCOVERY_RETENTION_MS);
        await client.query("update competition_discovery_runs set status='cancelled',next_event_seq=$2,lease_owner=null,lease_expires_at=null,lease_fence=lease_fence+1,expires_at=$3,updated_at=now() where run_id=$1", [run.run_id, seq, expiresAt]);
        await client.query("update competition_discovery_sessions set expires_at=$2,updated_at=now() where session_id=$1", [row.session_id, expiresAt]);
        row.expires_at = expiresAt;
      }
    }
    return snapshot(client, row, body);
  });
}
async function redactSessions(client: QueryClient, sessionIds: string[], status: "deleted" | "expired") {
  if (!sessionIds.length) return;
  await client.query(`update competition_discovery_events set ciphertext=null,iv=null,tag=null,redacted=true where run_id in
    (select run_id from competition_discovery_runs where session_id=any($1::uuid[]))`, [sessionIds]);
  await client.query("update competition_discovery_runs set status=$2,ciphertext=null,iv=null,tag=null,lease_owner=null,lease_expires_at=null,lease_fence=lease_fence+1,updated_at=now() where session_id=any($1::uuid[])", [sessionIds, status]);
  await client.query("update competition_discovery_sessions set status=$2,ciphertext=null,iv=null,tag=null,clarification_owner=null,clarification_lease_expires_at=null,clarification_fence=clarification_fence+1,updated_at=now() where session_id=any($1::uuid[])", [sessionIds, status]);
}
export async function deleteDiscoverySession(token: string): Promise<void> {
  await transaction(async client => {
    const verified = verifyDiscoveryResumeToken(token);
    if (!verified) throw new Error("DISCOVERY_SESSION_EXPIRED");
    const row = (await client.query<SessionRow>("select * from competition_discovery_sessions where session_id=$1 for update", [verified.sessionId])).rows[0];
    if (!row || row.status === "expired" || row.status === "active" && row.expires_at.getTime() <= Date.now()) throw new Error("DISCOVERY_SESSION_EXPIRED");
    if (row.status === "active") await redactSessions(client, [row.session_id], "deleted");
  });
}
export async function expireDiscoverySessions(): Promise<number> {
  return transaction(async client => {
    const rows = (await client.query<{ session_id: string }>("select session_id from competition_discovery_sessions where status='active' and expires_at<=now() order by expires_at for update skip locked limit 100")).rows;
    await redactSessions(client, rows.map(row => row.session_id), "expired");
    return rows.length;
  });
}
