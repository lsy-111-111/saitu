import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { reconcileDiscoverySpend } from "@/lib/ai/discovery-spend";
import { DISCOVERY_RUNTIME_POLICY } from "@/lib/ai/discovery-policy.mjs";
import { streamDiscoveryReport, type DiscoveryModelEvent, type DiscoveryModelTiming } from "./model";
import { isSupportedDiscoveryConsentVersion } from "./disclosure";
import {
  appendDiscoveryRunEvent, claimDiscoveryRun, expireDiscoverySessions,
  releaseDiscoveryRunLease, renewDiscoveryRunLease, discoveryModelInvocationId, type ClaimedDiscoveryRun,
} from "./store";
import { safeDiscoveryResetFailureCode, type DiscoveryEventPayload } from "./transport";

export type DiscoveryWorkerModels = { streamReport: typeof streamDiscoveryReport };
export const DISCOVERY_TEXT_BATCH_MS = 150;
export const DISCOVERY_TEXT_BATCH_BYTES = 2_048;

export { discoveryModelInvocationId } from "./store";

function modelFailure(error: unknown): { code: string; retryable: boolean; retryAfterMs: number; upstreamAttempted: boolean } {
  const value = error && typeof error === "object" ? error as { code?: unknown; retryable?: unknown; retryAfterMs?: unknown; upstreamAttempted?: unknown } : undefined;
  return {
    code: typeof value?.code === "string" ? value.code : error instanceof Error ? error.message : "discovery_failed",
    retryable: value?.retryable === true,
    upstreamAttempted: value?.upstreamAttempted === true,
    retryAfterMs: typeof value?.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0 ? value.retryAfterMs : 250,
  };
}
function publicFailure(code: string) {
  if (code === "timeout" || code === "DISCOVERY_TIMEOUT") return "DISCOVERY_TIMEOUT";
  if (/^DISCOVERY_[A-Z0-9_:-]{1,100}$/.test(code)) return code;
  const result = `DISCOVERY_${code.toUpperCase()}`;
  return /^DISCOVERY_[A-Z0-9_:-]{1,100}$/.test(result) ? result : "DISCOVERY_FAILED";
}

/** Provider work belongs to the persisted job, never the browser's SSE connection. */
export async function processClaimedDiscoveryRun(
  claim: ClaimedDiscoveryRun,
  models: DiscoveryWorkerModels = { streamReport: streamDiscoveryReport },
  signal?: AbortSignal,
  canDispatch?: () => boolean,
): Promise<void> {
  const processingStartedAt = Date.now();
  const controller = new AbortController();
  let leaseLost = false, heartbeatBusy = false, writes: Promise<unknown> = Promise.resolve();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const totalDeadline = claim.row.deadline_at.getTime();
  const observe = (stage: string, atEpochMs = Date.now(), metrics: Record<string, string | number | boolean | undefined> = {}) => {
    try {
      console.info(JSON.stringify({ event: "discovery_latency", schemaVersion: "saitu.discovery-latency.v1", runId: claim.row.run_id,
        attempt: claim.body.attempt, reasoningEffort: claim.body.reasoningEffort, stage, atEpochMs,
        elapsedMs: Math.max(0, atEpochMs - claim.row.submitted_at.getTime()),
        processingElapsedMs: Math.max(0, atEpochMs - processingStartedAt), ...metrics }));
    } catch { /* Diagnostics never affect provider work or persistence. */ }
  };
  observe("queued", claim.row.submitted_at.getTime());
  observe("claimed", processingStartedAt, { queueMs: Math.max(0, processingStartedAt - claim.row.submitted_at.getTime()) });
  const observeModel = ({ stage, atEpochMs, ...metrics }: DiscoveryModelTiming) => observe(stage, atEpochMs, metrics);
  // Queue time consumes the absolute budget. The first call uses the persisted
  // effort; a historical max run is not downgraded merely because it queued.
  const firstTextDeadline = Math.min(totalDeadline, processingStartedAt + DISCOVERY_RUNTIME_POLICY.reportFirstAttemptMs);
  const hardTimer = setTimeout(() => controller.abort(new Error("DISCOVERY_TIMEOUT")), Math.max(1, totalDeadline - Date.now()));
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || controller.signal.aborted) return;
    heartbeatBusy = true;
    void renewDiscoveryRunLease(claim).then(ok => {
      if (!ok) { leaseLost = true; controller.abort(new Error("DISCOVERY_LEASE_LOST")); }
    }, () => { leaseLost = true; controller.abort(new Error("DISCOVERY_LEASE_LOST")); }).finally(() => { heartbeatBusy = false; });
  }, 1_000);
  heartbeat.unref();
  let bufferedText = "", bufferedBytes = 0, persistedSubstantiveText = false, persistedBatches = 0;
  let profileAvailable = false, firstCardAvailable = false;
  let batchTimer: ReturnType<typeof setTimeout> | undefined, batchFailure: unknown;
  const deliveryFailure = (error: unknown) => Object.assign(new Error("delivery_error"), {
    code: "delivery_error", retryable: false, upstreamAttempted: true, cause: error,
  });
  const persist = (payload: DiscoveryEventPayload): Promise<void> => {
    const write = writes.then(async () => {
      if (leaseLost) throw new Error("DISCOVERY_LEASE_LOST");
      await appendDiscoveryRunEvent(claim, payload);
      if (payload.type === "text") {
        persistedBatches += 1;
        if (!persistedSubstantiveText && /\S/u.test(payload.delta)) {
          persistedSubstantiveText = true;
          observe("first_persisted_text");
        }
        observe("text_persisted", Date.now(), { bytes: Buffer.byteLength(payload.delta, "utf8"), batches: persistedBatches });
        if (payload.presentationRecord?.type === "profile" && !profileAvailable) {
          profileAvailable = true;
          observe("profile_available");
        }
        if (payload.presentationRecord?.type === "card" && !firstCardAvailable) {
          firstCardAvailable = true;
          observe("first_card_available");
        }
      } else if (payload.type === "tool") observe("tool", Date.now(), { action: payload.action, status: payload.status });
      else if (payload.type === "reset") observe("reset", Date.now(), { reason: payload.reason });
      else if (payload.type === "complete") observe("complete", Date.now(), { batches: persistedBatches });
      else if (payload.type === "error") observe("failed", Date.now(), { code: payload.code, batches: persistedBatches });
    });
    writes = write;
    return write;
  };
  const discardBufferedText = () => {
    clearTimeout(batchTimer); batchTimer = undefined;
    bufferedText = ""; bufferedBytes = 0;
  };
  const flushText = (): Promise<void> => {
    clearTimeout(batchTimer); batchTimer = undefined;
    if (batchFailure) return Promise.reject(batchFailure);
    if (!bufferedText) return writes.then(() => undefined);
    const delta = bufferedText;
    bufferedText = ""; bufferedBytes = 0;
    return persist({ type: "text", delta });
  };
  const scheduleText = () => {
    if (batchTimer) return;
    // Do not hold the last accepted bytes past the immutable run deadline.
    batchTimer = setTimeout(() => {
      batchTimer = undefined;
      if (controller.signal.aborted || leaseLost || canDispatch && !canDispatch()) { discardBufferedText(); return; }
      void flushText().catch(error => {
        batchFailure = deliveryFailure(error);
        controller.abort(new Error("DISCOVERY_DELIVERY_FAILED"));
      });
    }, Math.max(1, Math.min(DISCOVERY_TEXT_BATCH_MS, totalDeadline - Date.now() - 1)));
    batchTimer.unref();
  };
  const emit = async (payload: DiscoveryEventPayload): Promise<void> => {
    if (payload.type !== "text") {
      await flushText();
      await persist(payload);
      if (payload.type === "reset") {
        persistedSubstantiveText = false;
        profileAvailable = false;
        firstCardAvailable = false;
      }
      return;
    }
    // A complete validated record and its Markdown projection form one durable
    // event. Never detach the record by combining its text with another batch.
    if (payload.presentationRecord) {
      await flushText();
      await persist(payload);
      return;
    }
    if (batchFailure) throw batchFailure;
    bufferedText += payload.delta;
    bufferedBytes += Buffer.byteLength(payload.delta, "utf8");
    // The first useful segment bypasses batching, including leading whitespace.
    if ((!persistedSubstantiveText && /\S/u.test(bufferedText)) || bufferedBytes >= DISCOVERY_TEXT_BATCH_BYTES) await flushText();
    else scheduleText();
  };
  try {
    if (!isSupportedDiscoveryConsentVersion(claim.session.consentVersion)) {
      await emit({ type: "error", code: "DISCOVERY_CONSENT_CHANGED" });
      return;
    }
    if (claim.body.error === "DISCOVERY_WORKER_INTERRUPTED") {
      await emit({ type: "error", code: "DISCOVERY_WORKER_INTERRUPTED" });
      return;
    }
    if (claim.body.runtimeBinding !== (process.env.SAITU_DISCOVERY_SOURCE_SHA256 || "development")) {
      await emit({ type: "error", code: "DISCOVERY_IMPLEMENTATION_CHANGED" });
      return;
    }
    for (;;) {
      if (canDispatch && !canDispatch()) throw new Error("DISCOVERY_RELEASE_INACTIVE");
      if (controller.signal.aborted || Date.now() >= totalDeadline) throw new Error("DISCOVERY_TIMEOUT");
      const attempt = claim.body.attempt;
      const effort = claim.body.reasoningEffort;
      const watchFirstText = attempt === 1 && effort === "max";
      const attemptController = new AbortController();
      const abortAttempt = () => attemptController.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", abortAttempt, { once: true });
      if (controller.signal.aborted) abortAttempt();
      let receivedFirstText = false, firstTextExpiredInDelivery = false, firstTextTimer: ReturnType<typeof setTimeout> | undefined;
      if (watchFirstText) firstTextTimer = setTimeout(() => {
        if (!receivedFirstText) attemptController.abort(new Error("DISCOVERY_TIMEOUT"));
      }, Math.max(1, firstTextDeadline - Date.now()));
      try {
        if (watchFirstText && Date.now() >= firstTextDeadline) throw Object.assign(new Error("timeout"), { code: "timeout", upstreamAttempted: false });
        const result = await models.streamReport({
          answers: claim.session.answers, additionalText: claim.session.additionalText, catalog: claim.session.catalogSnapshot,
          followups: claim.session.followups.map(question => {
            const answer = claim.session.followupAnswers.find(value => value.questionId === question.id);
            if (!answer) throw new Error("DISCOVERY_FOLLOWUP_INVALID");
            return { question, answer };
          }),
          // The provider and accounting receipt keep the absolute deadline.
          // Only the first-text watchdog is released when useful text starts.
          reasoningEffort: effort, signal: attemptController.signal, deadlineEpochMs: totalDeadline,
          presentationVersion: claim.body.presentationVersion,
          protocolVersion: claim.body.protocolVersion,
          timeoutFallback: claim.body.timeoutFallback,
          invocationId: discoveryModelInvocationId(claim.row.run_id, attempt),
          onTiming: timing => {
            // Structured records arrive only after their full JSON is parsed.
            // The historical max watchdog still follows the first substantive
            // upstream byte, rather than the first complete projected record.
            if (timing.stage === "first_upstream_text" && !receivedFirstText) {
              if (watchFirstText && timing.atEpochMs >= firstTextDeadline) firstTextExpiredInDelivery = true;
              else {
                receivedFirstText = true;
                clearTimeout(firstTextTimer);
              }
            }
            observeModel(timing);
          },
          onEvent: async (event: DiscoveryModelEvent) => {
            if (watchFirstText && !receivedFirstText && Date.now() >= firstTextDeadline) firstTextExpiredInDelivery = true;
            if (attemptController.signal.aborted || Date.now() >= totalDeadline
              || firstTextExpiredInDelivery) {
              throw Object.assign(new Error("DISCOVERY_TIMEOUT"), { code: "timeout", upstreamAttempted: true });
            }
            if (!claim.body.presentationVersion && event.type === "text" && /\S/u.test(event.delta)) {
              receivedFirstText = true;
              clearTimeout(firstTextTimer);
            }
            await emit(event);
          },
        });
        await flushText();
        if (attemptController.signal.aborted || Date.now() >= totalDeadline) {
          throw Object.assign(new Error("DISCOVERY_TIMEOUT"), { code: "timeout", upstreamAttempted: true });
        }
        if (!claim.body.markdown.trim()) throw new Error("DISCOVERY_EMPTY_REPORT");
        await emit({ type: "complete", model: result.model, webSearchUsed: result.webSearchUsed });
        return;
      } catch (error) {
        if (leaseLost || signal?.aborted || canDispatch && !canDispatch()) { discardBufferedText(); throw error; }
        const originalFailure = modelFailure(error);
        const explicitRejection = originalFailure.code === "refusal" || originalFailure.code === "authentication_error";
        let caught = explicitRejection ? error : batchFailure ?? error;
        try { await flushText(); } catch (failure) {
          // A delayed text write cannot turn an explicit provider rejection into
          // a timeout or stop a refusal from withdrawing already visible text.
          if (!explicitRejection) caught = batchFailure ?? deliveryFailure(failure);
        }
        const failure = modelFailure(caught);
        // Explicit provider errors keep their classification even at the time
        // boundary: a refusal/auth failure is never a timeout, and 429/5xx
        // retries retain their current reasoning effort.
        const timedOut = failure.code === "timeout" || failure.code === "DISCOVERY_TIMEOUT"
          || failure.code === "delivery_error" && firstTextExpiredInDelivery
          || failure.code === "DISCOVERY_CALL_DEADLINE" && Date.now() >= (watchFirstText ? firstTextDeadline : totalDeadline);
        const attemptedTimeout = timedOut && failure.upstreamAttempted && !receivedFirstText;
        if (attempt === 1 && (attemptedTimeout || !timedOut && failure.retryable) && Date.now() < totalDeadline) {
          // A timeout spends the one retry on high. Transient failures keep the current effort.
          // The reset and effort are committed before any second paid dispatch.
          const pause = timedOut ? 0 : failure.retryAfterMs;
          if (Date.now() + pause >= totalDeadline) throw new Error("DISCOVERY_TIMEOUT");
          await emit({ type: "reset", attempt: 2, reason: timedOut ? "timeout" : "temporary_error",
            failureCode: safeDiscoveryResetFailureCode(failure.code) });
          if (pause) await delay(pause, undefined, { signal: controller.signal });
          continue;
        }
        throw new Error(publicFailure(timedOut ? "timeout" : failure.code));
      } finally {
        clearTimeout(firstTextTimer);
        controller.signal.removeEventListener("abort", abortAttempt);
        attemptController.abort();
      }
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "DISCOVERY_FAILED";
    if (!leaseLost && !signal?.aborted && code !== "DISCOVERY_RELEASE_INACTIVE") {
      // A failed append may have invalidated the lease. The final write checks it again.
      writes = writes.catch(() => undefined);
      discardBufferedText(); batchFailure = undefined;
      if (code === "DISCOVERY_REFUSAL") await persist({ type: "reset", attempt: claim.body.attempt, reason: "withdrawn" }).catch(() => undefined);
      const explicitRejection = code === "DISCOVERY_REFUSAL" || code === "DISCOVERY_AUTHENTICATION_ERROR";
      const finalCode = explicitRejection ? code : Date.now() >= totalDeadline ? "DISCOVERY_TIMEOUT" : code;
      await persist({ type: "error", code: finalCode }).catch(() => undefined);
    }
  } finally {
    controller.abort(); clearTimeout(hardTimer); clearInterval(heartbeat);
    discardBufferedText();
    signal?.removeEventListener("abort", abort);
    await writes.catch(() => undefined);
    await releaseDiscoveryRunLease(claim).catch(() => undefined);
  }
}

let nextCleanupAt = 0;
export async function workNextDiscoveryRun(owner = `discovery-${randomUUID()}`, signal?: AbortSignal, canDispatch?: () => boolean): Promise<boolean> {
  if (signal?.aborted || canDispatch && !canDispatch()) return false;
  if (Date.now() >= nextCleanupAt) {
    nextCleanupAt = Date.now() + 60_000;
    await expireDiscoverySessions();
    await reconcileDiscoverySpend();
  }
  const claim = await claimDiscoveryRun(owner);
  if (!claim) return false;
  await processClaimedDiscoveryRun(claim, undefined, signal, canDispatch);
  return true;
}
