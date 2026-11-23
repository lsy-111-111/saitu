import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { recordAiConsent } from "@/lib/ai/consent";
import { competitionAiJson, competitionAiRequestErrorResponse, readCompetitionAiJson } from "@/lib/ai/competition-api";
import { isCompetitionRecommenderEnabled } from "@/lib/config/features";
import { checkDiscoveryStartRateLimit } from "@/lib/security/rate-limit";
import { DISCOVERY_SCHEMA_VERSION, discoverySubmissionSchema, discoveryStoredSubmissionSchema, discoveryFollowupAnswersSchema, validateDiscoveryFollowupAnswers, type DiscoveryStoredSubmission } from "./contracts";
import { DISCOVERY_CONSENT_DISCLOSURE, DISCOVERY_CONSENT_VERSION } from "./disclosure";
import { makeDiscoveryCatalogSnapshot } from "./catalog";
import {
  createDiscoverySession, findDiscoverySessionBySubmission,
  enqueueDiscoveryReport, getDiscoverySnapshot, listDiscoveryEvents,
  cancelDiscoveryRun, deleteDiscoverySession, saveDiscoveryFollowupDraft
} from "./store";
import type { DiscoverySnapshot } from "./transport";

const reportInputSchema = z.object({ clientRequestId: z.string().uuid(), followupAnswers: discoveryFollowupAnswersSchema.optional() }).strict();
const followupDraftInputSchema = z.object({ followupAnswers: discoveryFollowupAnswersSchema, editedAt: z.string().datetime() }).strict();
const idSchema = z.string().uuid();
const terminalStates = new Set(["complete", "failed", "cancelled", "deleted", "expired", "superseded"]);

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const code = /^DISCOVERY_[A-Z_]+$/i.test(message) ? message.toUpperCase() : "DISCOVERY_UNAVAILABLE";
  const status = code === "DISCOVERY_BUSY" ? 429 : /TOKEN|EXPIRED|NOT_FOUND|DELETED/.test(code) ? 401
    : /CHANGED|CONFLICT|NOT_READY|RUN_MISMATCH|ALREADY/.test(code) ? 409
      : /INVALID|ANSWER/.test(code) ? 400 : 503;
  console.error(JSON.stringify({ event: "discovery_api_error", code, status }));
  return competitionAiJson({ ok: false, error: code,
    ...(code === "DISCOVERY_BUSY" ? { message: "当前生成报告的人较多，已保留你的回答，请稍后重试。" } : {}),
    ...(code === "DISCOVERY_MAINTENANCE" ? { message: "网站正在短暂维护，已保留你的回答，稍后可继续提交。" } : {}),
    ...(code === "DISCOVERY_CATALOG_CONTEXT_TOO_LARGE" ? { message: "完整竞赛资料超出当前模型可处理的容量，本次未开始生成。需要调整资料后再试；系统没有省略赛事。" } : {})
  }, { status, ...(["DISCOVERY_BUSY", "DISCOVERY_MAINTENANCE"].includes(code) ? { headers: { "Retry-After": "30" } } : {}) });
}

function guard(request: Request): Response | null {
  if (!isCompetitionRecommenderEnabled()) return competitionAiJson({ error: "COMPETITION_RECOMMENDER_DISABLED" }, { status: 503 });
  const origin = request.headers.get("origin");
  // Next's production listener may normalize Request.url to localhost. Compare
  // browser origins against the configured public origin, never a forwarded Host.
  const expectedOrigin = new URL(process.env.NEXT_PUBLIC_SITE_URL || request.url).origin;
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin !== null && origin !== expectedOrigin)) {
    return competitionAiJson({ error: "UNSAFE_REQUEST" }, { status: 403 });
  }
  return null;
}

function bearer(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._~-]{32,4096}$/.test(authorization)) throw new Error("DISCOVERY_TOKEN_INVALID");
  return authorization.slice(7);
}

async function authorizedRun(request: Request, runId: string) {
  if (!idSchema.safeParse(runId).success) throw new Error("DISCOVERY_RUN_INVALID");
  const token = bearer(request), snapshot = await getDiscoverySnapshot(token);
  if (snapshot.run?.runId !== runId) throw new Error("DISCOVERY_RUN_MISMATCH");
  return { token, snapshot };
}

function clarifyResponse(snapshot: DiscoverySnapshot, resumeToken: string) {
  const pending = snapshot.clarificationStatus === "running" || snapshot.clarificationStatus === "pending";
  const skipped = snapshot.clarificationStatus === "failed" || snapshot.clarificationStatus === "skipped";
  return competitionAiJson({ sessionId: snapshot.sessionId, resumeToken, expiresAt: snapshot.expiresAt,
    questions: snapshot.followups,
    clarificationStatus: pending ? "running" : skipped ? "skipped" : "complete",
    ...(skipped ? { notice: "补充问题暂不可用，将根据你已填写的回答生成报告。" } : {}),
    snapshot
  }, { status: pending ? 202 : 200 });
}

function sessionInput(input: DiscoveryStoredSubmission) {
  return {
    answers: input.answers,
    additionalText: input.schemaVersion === DISCOVERY_SCHEMA_VERSION ? input.legacyAdditionalText ?? "" : input.additionalText,
    consentVersion: input.consentVersion,
    clientRequestId: input.clientRequestId,
    ...(input.schemaVersion === DISCOVERY_SCHEMA_VERSION ? { schemaVersion: input.schemaVersion } : {})
  };
}

/** The old endpoint only recovers an existing record; it never dispatches AI work. */
export async function postDiscoveryClarify(request: Request) {
  try {
    const rejected = guard(request); if (rejected) return rejected;
    const body = await readCompetitionAiJson(request);
    if (!body.ok) return competitionAiRequestErrorResponse(body.error);
    const input = discoveryStoredSubmissionSchema.safeParse(body.value);
    if (!input.success) return competitionAiJson({ error: "DISCOVERY_INPUT_INVALID" }, { status: 400 });
    if (new URL(request.url).searchParams.get("resume") !== "1") return competitionAiJson({ error: "DISCOVERY_CLARIFICATION_REMOVED", message: "补充追问已取消，请回到问卷核对回答后生成报告。" }, { status: 410 });
    const existing = await findDiscoverySessionBySubmission(sessionInput(input.data));
    return existing ? clarifyResponse(existing.snapshot, existing.resumeToken)
      : competitionAiJson({ error: "DISCOVERY_SESSION_NOT_FOUND" }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}

/** A complete questionnaire now opens a ready session without a model call. */
export async function postDiscoverySession(request: Request) {
  try {
    const rejected = guard(request); if (rejected) return rejected;
    const body = await readCompetitionAiJson(request);
    if (!body.ok) return competitionAiRequestErrorResponse(body.error);
    const input = discoverySubmissionSchema.safeParse(body.value);
    if (!input.success) return competitionAiJson({ error: "DISCOVERY_INPUT_INVALID" }, { status: 400 });
    if (new URL(request.url).searchParams.get("resume") === "1") {
      const existing = await findDiscoverySessionBySubmission(sessionInput(input.data));
      return existing ? competitionAiJson({ sessionId: existing.snapshot.sessionId, resumeToken: existing.resumeToken,
        expiresAt: existing.snapshot.expiresAt, snapshot: existing.snapshot })
        : competitionAiJson({ error: "DISCOVERY_SESSION_NOT_FOUND" }, { status: 404 });
    }
    if (input.data.consentVersion !== DISCOVERY_CONSENT_VERSION) return competitionAiJson({ error: "AI_CONSENT_REQUIRED", consentDisclosure: DISCOVERY_CONSENT_DISCLOSURE }, { status: 409 });
    const limited = await checkDiscoveryStartRateLimit(request); if (limited) return limited;
    const submitted = sessionInput(input.data);
    // A retry belongs to the original catalog snapshot even after a release.
    // Validate the submitted answers before reusing it, never merge new facts.
    const existing = await findDiscoverySessionBySubmission(submitted);
    let session: Awaited<ReturnType<typeof createDiscoverySession>>;
    if (existing) session = { ...existing, created: false };
    else {
      try { session = await createDiscoverySession({ ...submitted, catalogSnapshot: makeDiscoveryCatalogSnapshot() }); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "DISCOVERY_REQUEST_CHANGED") throw error;
        // Another release may have won creation after the initial lookup. Its
        // stored user input still has to match exactly before recovering it.
        const recovered = await findDiscoverySessionBySubmission(submitted);
        if (!recovered) throw error;
        session = { ...recovered, created: false };
      }
    }
    return competitionAiJson({ sessionId: session.snapshot.sessionId, resumeToken: session.resumeToken,
      expiresAt: session.snapshot.expiresAt, snapshot: session.snapshot }, { status: session.created ? 201 : 200 });
  } catch (error) { return errorResponse(error); }
}

export async function postDiscoveryReport(request: Request) {
  try {
    const rejected = guard(request); if (rejected) return rejected;
    const token = bearer(request);
    const body = await readCompetitionAiJson(request);
    if (!body.ok) return competitionAiRequestErrorResponse(body.error);
    const input = reportInputSchema.safeParse(body.value);
    if (!input.success) return competitionAiJson({ error: "DISCOVERY_INPUT_INVALID" }, { status: 400 });
    const before = await getDiscoverySnapshot(token);
    const followupAnswers = input.data.followupAnswers ?? (before.schemaVersion === DISCOVERY_SCHEMA_VERSION ? [] : before.followupAnswers);
    try { validateDiscoveryFollowupAnswers(before.followups, followupAnswers); }
    catch { return competitionAiJson({ error: "DISCOVERY_ANSWERS_INVALID" }, { status: 400 }); }
    const { created, snapshot, consentVersion } = await enqueueDiscoveryReport(token, { clientRequestId: input.data.clientRequestId, followupAnswers });
    if (created) await recordAiConsent(request, "competition_discovery_report", { provider: "deepseek", model: "deepseek-flash" }, { consentVersion });
    return competitionAiJson({ runId: snapshot.run!.runId, snapshot }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}

export async function getDiscoveryRun(request: Request, runId: string) {
  try {
    const rejected = guard(request); if (rejected) return rejected;
    return competitionAiJson((await authorizedRun(request, runId)).snapshot);
  } catch (error) { return errorResponse(error); }
}

/** Resolve a possibly lost enqueue response without creating or retrying work. */
export async function getDiscoveryCurrentSession(request: Request) {
  try {
    const rejected = guard(request); if (rejected) return rejected;
    return competitionAiJson(await getDiscoverySnapshot(bearer(request)));
  } catch (error) { return errorResponse(error); }
}

export async function postDiscoveryCancel(request: Request, runId: string) {
  try {
    const rejected = guard(request); if (rejected) return rejected;
    const { token } = await authorizedRun(request, runId);
    return competitionAiJson(await cancelDiscoveryRun(token));
  } catch (error) { return errorResponse(error); }
}

export async function deleteDiscoveryCurrentSession(request: Request) {
  try {
    const rejected = guard(request); if (rejected) return rejected;
    await deleteDiscoverySession(bearer(request));
    return competitionAiJson({ ok: true });
  } catch (error) { return errorResponse(error); }
}

export async function patchDiscoveryCurrentSession(request: Request) {
  try {
    const rejected = guard(request); if (rejected) return rejected;
    const token = bearer(request);
    const body = await readCompetitionAiJson(request);
    if (!body.ok) return competitionAiRequestErrorResponse(body.error);
    const input = followupDraftInputSchema.safeParse(body.value);
    if (!input.success) return competitionAiJson({ error: "DISCOVERY_INPUT_INVALID" }, { status: 400 });
    return competitionAiJson(await saveDiscoveryFollowupDraft(token, input.data));
  } catch (error) { return errorResponse(error); }
}

export async function getDiscoveryEvents(request: Request, runId: string) {
  try {
    const rejected = guard(request); if (rejected) return rejected;
    const { token, snapshot } = await authorizedRun(request, runId);
    const rawAfter = new URL(request.url).searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
    const initialAfter = Number(rawAfter);
    if (!/^\d+$/.test(rawAfter) || !Number.isSafeInteger(initialAfter) || initialAfter > snapshot.run!.lastSeq) return competitionAiJson({ error: "DISCOVERY_CURSOR_INVALID" }, { status: 400 });
    const connection = new AbortController();
    const signal = AbortSignal.any([connection.signal, request.signal]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let after = initialAfter, heartbeat = Date.now();
        try {
          controller.enqueue(encoder.encode(": connected\n\n"));
          while (!signal.aborted) {
            const events = await listDiscoveryEvents(token, after, runId);
            for (const event of events) {
              if (signal.aborted) break;
              controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
              after = event.seq;
            }
            const current = await getDiscoverySnapshot(token);
            if (current.run?.runId !== runId) break;
            if (terminalStates.has(current.run.status) && after >= current.run.lastSeq) break;
            if (Date.now() - heartbeat >= 15_000) { controller.enqueue(encoder.encode(": keep-alive\n\n")); heartbeat = Date.now(); }
            await delay(400, undefined, { signal }).catch(() => undefined);
          }
        } catch {
          if (!signal.aborted) controller.enqueue(encoder.encode('event: connection_error\ndata: {"error":"DISCOVERY_CONNECTION_LOST"}\n\n'));
        } finally { if (!signal.aborted) controller.close(); }
      },
      cancel() { connection.abort(); }
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}
