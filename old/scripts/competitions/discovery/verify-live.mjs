#!/usr/bin/env node
/** Explicit live acceptance runner. Ordinary build/verify never invokes this file. */
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { installSourceLoader } from "../../lib/load-typescript-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
installSourceLoader(root);
const { DISCOVERY_ACCEPTANCE_PROFILES } = await import("../../../tests/discovery/fixtures.ts");
const { DISCOVERY_SCHEMA_VERSION, discoverySubmissionSchema } = await import("../../../src/lib/competitions/discovery/contracts.ts");
const { DISCOVERY_CONSENT_VERSION } = await import("../../../src/lib/competitions/discovery/disclosure.ts");
const { safeDiscoveryResetFailureCode } = await import("../../../src/lib/competitions/discovery/transport.ts");
const { DISCOVERY_RUNTIME_POLICY, DISCOVERY_RUNTIME_POLICY_SHA256 } = await import("../../../src/lib/ai/discovery-policy.mjs");
const { DISCOVERY_PROMPT_VERSION } = await import("../../../src/lib/competitions/discovery/prompts.ts");
const MAX_CASE_MS = 225_000;
const args = process.argv.slice(2);
let live = false, all = false, list = false, origin = "http://127.0.0.1:3190", stopAfterCurrentFile, label = "acceptance";
const requested = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--live") live = true;
  else if (arg === "--all") all = true;
  else if (arg === "--list" || arg === "--help") list = true;
  else if (arg === "--origin" && args[index + 1]) origin = args[++index];
  else if (arg === "--case" && args[index + 1]) requested.push(...args[++index].split(",").filter(Boolean));
  else if (arg === "--stop-after-current-file" && args[index + 1]) stopAfterCurrentFile = path.resolve(args[++index]);
  else if (arg === "--label" && args[index + 1] && /^[a-z0-9-]{1,64}$/.test(args[index + 1])) label = args[++index];
  else throw new Error("Usage: verify-live.mjs --list | --live (--case ID | --all) [--origin http://127.0.0.1:3190] [--label LABEL] [--stop-after-current-file PATH]");
}

if (list || !live) {
  console.info("Explicit --live is required for paid model calls. Choose --case ID or --all; cases run sequentially.");
  console.info("SIGINT/SIGTERM cancel the current run and preserve results. A stop file stops after the current case.");
  for (const profile of DISCOVERY_ACCEPTANCE_PROFILES) console.info(`${profile.id}\t${profile.name}`);
  if (!live) process.exit(0);
}
if (all === (requested.length > 0)) throw new Error("Choose exactly one of --all or --case ID.");
const parsedOrigin = new URL(origin);
if (parsedOrigin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsedOrigin.hostname)
  || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) {
  throw new Error("Live acceptance is restricted to a loopback HTTP origin.");
}
origin = parsedOrigin.origin;
const selected = all ? DISCOVERY_ACCEPTANCE_PROFILES : [...new Set(requested)].map((id) => {
  const profile = DISCOVERY_ACCEPTANCE_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unknown synthetic case: ${id.replace(/[^a-z0-9-]/g, "").slice(0, 80)}`);
  return profile;
});
// Two explicitly started runners must not overwrite each other's summaries.
const stamp = `${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}`;
const outputDirectory = path.join(root, ".local", "checks", "discovery-live", stamp);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);
const buildBinding = await readFile(path.join(root, ".next", "decision-worker-binding.json"), "utf8")
  .then(JSON.parse).catch(() => null);
// Safe provenance only; neither credentials nor recovery tokens are persisted.
const configuration = {
  initialEffort: DISCOVERY_RUNTIME_POLICY.initialEffort,
  policySha256: DISCOVERY_RUNTIME_POLICY_SHA256,
  promptVersion: DISCOVERY_PROMPT_VERSION,
  productionBuildSourceSha256: buildBinding?.sourceSha256 ?? null
};

// Signals request an orderly stop; they must never dispatch the next profile.
// The active case retains its token only in memory until cancellation finishes.
let interruption = null, stopCurrentCase = null;
function requestInterruption(reason) {
  interruption ??= { reason, requestedAt: new Date().toISOString() };
  stopCurrentCase?.();
}
const signalHandlers = new Map(["SIGINT", "SIGTERM"].map((name) => {
  const handler = () => requestInterruption(name);
  process.on(name, handler);
  return [name, handler];
}));
async function checkStopFile() {
  if (!stopAfterCurrentFile || interruption) return;
  try { await access(stopAfterCurrentFile); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw failure("STOP_FILE_UNREADABLE");
  }
  requestInterruption("stop_after_current_file");
}

function extractSnapshot(value) {
  if (value?.snapshot?.sessionId) return value.snapshot;
  if (value?.sessionId && ("run" in value || "followups" in value)) return value;
  return null;
}
function publicFailure(error) {
  // Never print upstream messages, response bodies, headers or recovery credentials.
  return typeof error?.safeCode === "string" ? error.safeCode : error?.name === "AbortError" ? "ACCEPTANCE_TIMEOUT" : "NETWORK_OR_PROTOCOL_ERROR";
}
function failure(code) { return Object.assign(new Error(code), { safeCode: code }); }

// Preserve the synthetic facts used by the old baseline, moving its single
// supplement into the relevant question. Unanswered historical fields become
// an explicit unknown, never an invented lack of experience or preference.
const supplementFields = {
  "vocational-first-entry": "completedTasks", "undergraduate-cross-major": "completedTasks",
  "senior-software-portfolio": "completedTasks", "masters-research": "completedTasks",
  "low-time-long-term": "weeklyTime", "no-team-no-mentor": "completedTasks",
  "online-only-hard-limit": "participationMode", "zero-personal-budget": "budget",
  "catalog-tail-geophysics": "major", "sparse-feasible-options": "teamStatus",
  "graduated-eligibility": "enrollmentStatus", "doctoral-life-science": "achievements",
  "part-time-law": "enrollmentStatus"
};
function currentAnswers(profile) {
  const answers = Object.fromEntries(Object.entries(profile.answers).map(([id, answer]) => [id,
    answer.status === "answered" ? { ...answer } : { status: "answered", values: [], text: "暂不确定。" }]));
  if (profile.additionalText) {
    const field = supplementFields[profile.id];
    if (!field) throw failure("UNMAPPED_SYNTHETIC_SUPPLEMENT");
    answers[field] = { ...answers[field], text: profile.additionalText };
  }
  return answers;
}
async function persist(filename, value) {
  const target = path.join(outputDirectory, filename);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return target;
}

async function verifyProfile(profile) {
  const startedAt = new Date().toISOString(), started = performance.now();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), MAX_CASE_MS);
  const signal = controller.signal;
  let token, runId, latestSnapshot, streamController, streamPromise;
  let pendingMutation = false;
  stopCurrentCase = () => {
    // Let a local mutation return its recovery token/run ID before stopping.
    // Aborting that response would leave a paid call running without a handle.
    if (!pendingMutation) controller.abort();
  };
  const ensureContinuing = () => {
    if (interruption) throw failure("ACCEPTANCE_INTERRUPTED");
  };
  let firstTextMs = null, reportFirstTextMs = null, reportStarted = null, firstTextObservedVia = null, lastSeq = 0, streamConnections = 0;
  let streamedText = "", questions = [], resetCount = 0;
  let clarificationStatus = null, clarificationNotice = null, clarificationElapsedMs = null, sessionElapsedMs = null;
  const sources = new Map(), toolEvents = [], terminalEvents = [], resetEvents = [];
  const request = async (pathname, options = {}) => {
    const headers = { Origin: origin, ...options.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${origin}/api/ai/competition-discovery${pathname}`, {
      ...options, headers, signal: options.signal ?? signal
    });
  };
  const jsonRequest = async (pathname, options = {}) => {
    const response = await request(pathname, options);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof payload?.error === "string" && /^[A-Z0-9_]{1,100}$/.test(payload.error) ? payload.error : `HTTP_${response.status}`;
      throw failure(code);
    }
    return payload;
  };
  const receive = (value, eventId) => {
    const event = value?.event ?? value;
    if (!event || typeof event !== "object") return;
    const seq = Number(event.seq ?? eventId);
    if (Number.isSafeInteger(seq) && seq > 0) {
      if (seq <= lastSeq) return;
      lastSeq = seq;
    }
    const payload = event.payload ?? event;
    if (payload.type === "text" && typeof payload.delta === "string") {
      if (firstTextMs === null && payload.delta) {
        firstTextMs = Math.round(performance.now() - started);
        reportFirstTextMs = reportStarted === null ? null : Math.round(performance.now() - reportStarted);
        firstTextObservedVia = "sse";
      }
      streamedText += payload.delta;
    } else if (payload.type === "reset") {
      streamedText = ""; sources.clear(); resetCount += 1;
      resetEvents.push({ seq, attempt: [1, 2].includes(payload.attempt) ? payload.attempt : null,
        reason: ["timeout", "temporary_error", "withdrawn"].includes(payload.reason) ? payload.reason : undefined,
        ...(payload.failureCode === undefined ? {} : { failureCode: safeDiscoveryResetFailureCode(payload.failureCode) }),
        elapsedMs: Math.round(performance.now() - started),
        reportElapsedMs: reportStarted === null ? null : Math.round(performance.now() - reportStarted) });
    } else if (payload.type === "sources" && Array.isArray(payload.sources)) {
      for (const source of payload.sources) if (typeof source?.url === "string") sources.set(source.url, source);
    } else if (payload.type === "tool") {
      toolEvents.push({ seq, action: payload.action, status: payload.status });
    } else if (["complete", "error", "cancelled"].includes(payload.type)) {
      terminalEvents.push({ seq, type: payload.type, code: payload.code, webSearchUsed: payload.webSearchUsed });
    }
  };
  const observeStream = async () => {
    for (let connection = 0; connection < 4 && !signal.aborted && !streamController.signal.aborted; connection += 1) {
      streamConnections += 1;
      try {
        const response = await request(`/runs/${encodeURIComponent(runId)}/events?after=${lastSeq}`, {
          headers: { Accept: "text/event-stream" }, signal: AbortSignal.any([signal, streamController.signal])
        });
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
        let buffer = "", data = [], eventId;
        const line = (raw) => {
          const current = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (!current) {
            if (data.length) { try { receive(JSON.parse(data.join("\n")), eventId); } catch { /* Ignore non-JSON keepalive frames. */ } }
            data = []; eventId = undefined; return;
          }
          if (current.startsWith("data:")) data.push(current.slice(5).replace(/^ /, ""));
          else if (current.startsWith("id:")) eventId = current.slice(3).trim();
        };
        try {
          while (!signal.aborted && !streamController.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) { buffer += decoder.decode(); break; }
            buffer += decoder.decode(chunk.value, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
            if (buffer.length > 1_000_000) throw failure("SSE_FRAME_TOO_LARGE");
          }
          if (buffer) line(buffer);
          line("");
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch { /* Snapshot polling remains authoritative; reconnect never creates a model call. */ }
      if (!streamController.signal.aborted && !signal.aborted) await delay(500, undefined, { signal }).catch(() => {});
    }
  };

  let result;
  try {
    ensureContinuing();
    const submission = discoverySubmissionSchema.parse({
      schemaVersion: DISCOVERY_SCHEMA_VERSION, answers: currentAnswers(profile),
      consentVersion: DISCOVERY_CONSENT_VERSION, consentAccepted: true, clientRequestId: randomUUID()
    });
    let session;
    pendingMutation = true;
    try { session = await jsonRequest("/session", { method: "POST", body: JSON.stringify(submission) }); }
    finally { pendingMutation = false; }
    token = session.resumeToken;
    latestSnapshot = extractSnapshot(session);
    questions = latestSnapshot?.followups ?? [];
    clarificationStatus = "not_requested";
    sessionElapsedMs = Math.round(performance.now() - started);
    clarificationElapsedMs = 0;
    if (typeof token !== "string" || !token) throw failure("MISSING_RESUME_TOKEN");
    if (!Array.isArray(questions) || questions.length) throw failure("UNEXPECTED_CLARIFICATION");
    ensureContinuing();
    reportStarted = performance.now();
    let queued;
    pendingMutation = true;
    try { queued = await jsonRequest("/report", { method: "POST", body: JSON.stringify({ clientRequestId: randomUUID() }) }); }
    finally { pendingMutation = false; }
    latestSnapshot = extractSnapshot(queued) ?? latestSnapshot;
    runId = queued.runId ?? latestSnapshot?.run?.runId;
    if (typeof runId !== "string") throw failure("MISSING_RUN_ID");
    ensureContinuing();
    streamController = new AbortController();
    streamPromise = observeStream();
    for (;;) {
      const state = await jsonRequest(`/runs/${encodeURIComponent(runId)}`);
      latestSnapshot = extractSnapshot(state) ?? latestSnapshot;
      const run = latestSnapshot?.run ?? state.run;
      if (run?.markdown && firstTextMs === null) {
        firstTextMs = Math.round(performance.now() - started);
        reportFirstTextMs = Math.round(performance.now() - reportStarted);
        firstTextObservedVia = "snapshot";
      }
      if (run && ["complete", "failed", "cancelled", "superseded", "deleted", "expired"].includes(run.status)) break;
      await delay(1_000, undefined, { signal });
    }
    const run = latestSnapshot?.run;
    result = {
      schemaVersion: "saitu.discovery-live-acceptance.v1", questionnaireVersion: DISCOVERY_SCHEMA_VERSION, label, synthetic: true, caseId: profile.id, name: profile.name,
      startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
      firstTextMs, reportFirstTextMs, reportElapsedMs: Math.round(performance.now() - reportStarted), firstTextObservedVia,
      runId, submittedAt: run?.submittedAt, deadlineAt: run?.deadlineAt,
      status: run?.status ?? "unknown", passed: run?.status === "complete" && Boolean(run.markdown?.trim()),
      model: run?.model, error: run?.error, attempts: run?.attempt, webSearchUsed: run?.webSearchUsed ?? toolEvents.some((event) => event.action === "search"),
      streamConnections, lastSeq, resetCount, resetEvents, toolEvents, terminalEvents,
      clarificationStatus, clarificationNotice, clarificationElapsedMs, sessionElapsedMs, followups: questions, followupAnswerPolicy: "not_requested",
      report: { markdown: run?.markdown ?? streamedText, sources: run?.sources ?? [...sources.values()] },
      reviewChecks: profile.reviewChecks, coverageCandidates: profile.coverageCandidates,
      manualContentReview: "required", usageAudit: "Read corresponding ai_spend_ledger rows; no credentials are included in this artifact."
    };
  } catch (error) {
    result = {
      schemaVersion: "saitu.discovery-live-acceptance.v1", questionnaireVersion: DISCOVERY_SCHEMA_VERSION, label, synthetic: true, caseId: profile.id, name: profile.name,
      startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
      firstTextMs, reportFirstTextMs, reportElapsedMs: reportStarted === null ? null : Math.round(performance.now() - reportStarted),
      firstTextObservedVia, runId, passed: false, status: interruption ? "interrupted" : "acceptance_failed",
      error: interruption ? "ACCEPTANCE_INTERRUPTED" : publicFailure(error),
      ...(interruption ? { interrupted: true, interruptionReason: interruption.reason } : {}),
      streamConnections, lastSeq, resetCount, resetEvents, toolEvents, terminalEvents,
      clarificationStatus, clarificationNotice, clarificationElapsedMs, sessionElapsedMs,
      report: { markdown: latestSnapshot?.run?.markdown ?? streamedText, sources: latestSnapshot?.run?.sources ?? [...sources.values()] },
      reviewChecks: profile.reviewChecks, manualContentReview: "required"
    };
    if ((signal.aborted || interruption) && token && runId) {
      result.cancellationRequested = true;
      try {
        const cancelled = await jsonRequest(`/runs/${encodeURIComponent(runId)}/cancel`, {
          method: "POST", body: "{}", signal: AbortSignal.timeout(3_000)
        });
        const cancelledRun = extractSnapshot(cancelled)?.run;
        result.cancellationStatus = ["cancelled", "complete", "failed", "superseded"].includes(cancelledRun?.status)
          ? cancelledRun.status : "requested";
      } catch { result.cancellationStatus = "request_failed"; }
    }
  } finally {
    stopCurrentCase = null;
    clearTimeout(timer); streamController?.abort();
    await streamPromise?.catch(() => {});
  }
  const filename = await persist(`${profile.id}.json`, result);
  console.info(JSON.stringify({ caseId: result.caseId, passed: result.passed, status: result.status,
    elapsedMs: result.elapsedMs, reportElapsedMs: result.reportElapsedMs, firstTextMs: result.firstTextMs,
    reportFirstTextMs: result.reportFirstTextMs, clarificationStatus: result.clarificationStatus,
    clarificationElapsedMs: result.clarificationElapsedMs, webSearchUsed: result.webSearchUsed,
    sources: result.report.sources.length, error: result.error, resetEvents: result.resetEvents, evidence: filename }));
  return result;
}

const results = [];
let runnerError;
async function persistSummary() {
  const tested = new Set(results.map((result) => result.caseId));
  await persist("summary.json", { schemaVersion: "saitu.discovery-live-summary.v1", questionnaireVersion: DISCOVERY_SCHEMA_VERSION, label, synthetic: true, origin,
    completedAt: new Date().toISOString(), configuration, interrupted: Boolean(interruption),
    ...(interruption ? { interruption } : {}), ...(runnerError ? { error: runnerError } : {}),
    selectedCaseIds: selected.map((profile) => profile.id), remainingCaseIds: selected.filter((profile) => !tested.has(profile.id)).map((profile) => profile.id),
    cases: results.map(({ caseId, runId, passed, status, elapsedMs, reportElapsedMs, firstTextMs, reportFirstTextMs, clarificationStatus, clarificationElapsedMs, sessionElapsedMs, webSearchUsed, toolEvents, error, resetEvents, cancellationRequested, cancellationStatus }) =>
      ({ caseId, runId, passed, status, elapsedMs, reportElapsedMs, firstTextMs, reportFirstTextMs, clarificationStatus, clarificationElapsedMs, sessionElapsedMs, webSearchUsed,
        acrossAttemptsToolEventCount: toolEvents.length, error, resetEvents, cancellationRequested, cancellationStatus })),
    manualContentReview: "required", observedHostedSearch: results.some((result) => result.webSearchUsed === true || result.toolEvents.length > 0) });
}
try {
  for (const profile of selected) {
    await checkStopFile();
    if (interruption) break;
    results.push(await verifyProfile(profile));
    await checkStopFile();
    // Preserve completed cases even if a later case or shutdown fails.
    await persistSummary();
    if (interruption) break;
  }
} catch (error) { runnerError = publicFailure(error); }
finally {
  await persistSummary();
  for (const [name, handler] of signalHandlers) process.off(name, handler);
}
if (interruption?.reason === "SIGINT") process.exitCode = 130;
else if (interruption?.reason === "SIGTERM") process.exitCode = 143;
else if (runnerError || results.some((result) => !result.passed)) process.exitCode = 1;
