#!/usr/bin/env node
/** The one explicitly authorized production acceptance. Build/verify never invokes it. */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isDirectExecution } from "../lib/direct-execution.mjs";

export const PRODUCTION_ORIGIN = "https://gzhanchuang.com";
export const PRODUCTION_ACCEPTANCE_CASE_IDS = Object.freeze([
  "vocational-first-entry", "undergraduate-cross-major", "senior-software-portfolio", "masters-research",
  "online-only-hard-limit", "zero-personal-budget", "graduated-eligibility", "doctoral-life-science"
]);
const APPROVAL_ID = "server-launch-20261120-eight-reports";
const MAX_CASE_MS = 225_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const supplementFields = {
  "vocational-first-entry": "completedTasks", "undergraduate-cross-major": "completedTasks",
  "senior-software-portfolio": "completedTasks", "masters-research": "completedTasks",
  "online-only-hard-limit": "participationMode", "zero-personal-budget": "budget",
  "graduated-eligibility": "enrollmentStatus", "doctoral-life-science": "achievements"
};
const terminalStatuses = new Set(["complete", "failed", "cancelled", "superseded", "deleted", "expired"]);
const failure = (code) => Object.assign(new Error(code), { safeCode: code });
const publicFailure = (error) => typeof error?.safeCode === "string" ? error.safeCode
  : error?.name === "AbortError" ? "ACCEPTANCE_TIMEOUT" : "NETWORK_OR_PROTOCOL_ERROR";
const snapshotFrom = (value) => value?.snapshot?.sessionId ? value.snapshot : value?.sessionId ? value : null;
const safeCode = (value) => typeof value === "string" && /^[A-Z0-9_]{1,100}$/.test(value) ? value : undefined;

export function parseAcceptanceArgs(args) {
  let live = false, auditOnly = false, list = false, batchId, evidenceRoot;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--live") live = true;
    else if (args[index] === "--audit-only") auditOnly = true;
    else if (["--list", "--help"].includes(args[index])) list = true;
    else if (args[index] === "--batch-id" && args[index + 1]) batchId = args[++index];
    else if (args[index] === "--evidence-root" && args[index + 1]) evidenceRoot = path.resolve(args[++index]);
    else throw failure("USAGE_ERROR");
  }
  if (batchId !== undefined && !/^\d{8}T\d{6}Z$/.test(batchId)) throw failure("INVALID_RELEASE_ID");
  if (live && (!batchId || list || auditOnly)) throw failure("LIVE_REQUIRES_RELEASE_ID");
  if (auditOnly && (!batchId || list)) throw failure("AUDIT_REQUIRES_RELEASE_ID");
  return { live, auditOnly, list, batchId, evidenceRoot };
}

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

/** Runtime dependencies are injected in tests; CLI loads the real questionnaire. */
export async function runServerAcceptance(options) {
  const { batchId, profiles, questionnaireVersion, consentVersion, parseSubmission, configuration,
    evidenceRoot, fetchImpl = fetch, pollMs = 1_000, onProgress = () => {} } = options;
  if (!/^\d{8}T\d{6}Z$/.test(batchId ?? "")) throw failure("INVALID_RELEASE_ID");
  if (profiles.length !== 8 || profiles.some((profile, index) => profile.id !== PRODUCTION_ACCEPTANCE_CASE_IDS[index]))
    throw failure("FIXED_EIGHT_SYNTHETIC_CASES_REQUIRED");
  if (configuration?.concurrency !== 4 || configuration?.dailyCallLimit !== null
    || configuration?.automaticRetries !== 1 || configuration?.reportDeadlineMs !== 180_000)
    throw failure("PRODUCTION_POLICY_MISMATCH");
  // Parse every case before claiming the once-only approval or making requests.
  const submissions = profiles.map((profile) => parseSubmission({ schemaVersion: questionnaireVersion,
    answers: currentAnswers(profile), consentVersion, consentAccepted: true, clientRequestId: randomUUID() }));
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await chmod(evidenceRoot, 0o700);
  // Approval is fixed across release IDs, so changing --batch-id cannot silently
  // create a second paid acceptance. Never delete this receipt to retry failures.
  const outputDirectory = path.join(evidenceRoot, APPROVAL_ID);
  try { await mkdir(outputDirectory, { mode: 0o700 }); }
  catch (error) { if (error?.code === "EEXIST") throw failure("ACCEPTANCE_ALREADY_STARTED_NEW_AUTHORIZATION_REQUIRED"); throw error; }
  const persist = async (name, value) => {
    const target = path.join(outputDirectory, name), temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  };
  const startedAt = new Date().toISOString();
  await persist("receipt.json", { schemaVersion: "saitu.server-live-receipt.v1", approvalId: APPROVAL_ID,
    batchId, startedAt, origin: PRODUCTION_ORIGIN, caseIds: PRODUCTION_ACCEPTANCE_CASE_IDS,
    maximumReports: 8, maximumPaidDispatches: 16, configuration, restartPolicy: "refuse; new authorization required" });
  const results = [], activeStops = new Set();
  let interruption = null, runnerError, reportSubmissions = 0;
  const interrupt = (reason) => {
    interruption ??= { reason, requestedAt: new Date().toISOString() };
    for (const stop of activeStops) stop();
  };
  const signalHandlers = new Map(["SIGINT", "SIGTERM"].map((name) => {
    const handler = () => interrupt(name); process.on(name, handler); return [name, handler];
  }));
  const persistSummary = async () => {
    await persist("summary.json", { schemaVersion: "saitu.server-live-summary.v1", approvalId: APPROVAL_ID,
      batchId, origin: PRODUCTION_ORIGIN, startedAt, updatedAt: new Date().toISOString(), synthetic: true,
      configuration, maximumReports: 8, maximumPaidDispatches: 16, reportSubmissions,
      paidDispatchesAudit: "requires server ai_spend_ledger and call receipt reconciliation; attempts are observations, not a billing count",
      ...(interruption ? { interruption } : {}), ...(runnerError ? { error: runnerError } : {}),
      remainingCaseIds: profiles.filter((profile) => !results.some((result) => result.caseId === profile.id)).map(({ id }) => id),
      cases: results.map(({ caseId, runId, status, passed, error, elapsedMs, reportElapsedMs, firstTextMs,
        attempt, streamConnections, restoredFromSnapshot, webSearchUsed, cancellationStatus }) =>
        ({ caseId, runId, status, passed, error, elapsedMs, reportElapsedMs, firstTextMs,
          attempt, streamConnections, restoredFromSnapshot, webSearchUsed, cancellationStatus })),
      manualContentReview: "required", evidenceDirectory: outputDirectory });
  };

  async function verifyProfile(profile, submission, preparationBarrier) {
    const started = performance.now(), caseStartedAt = new Date().toISOString();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), MAX_CASE_MS);
    const signal = controller.signal;
    let token, runId, latestSnapshot, streamPromise, streamController, pendingMutation = false;
    let reportStarted = null, firstTextMs = null, streamedText = "", lastSeq = 0, streamConnections = 0;
    let restoredFromSnapshot = false, result, prepared = false;
    const sources = new Map(), events = [];
    const stop = () => { if (!pendingMutation) controller.abort(); };
    activeStops.add(stop);
    const continuing = () => { if (interruption) throw failure("ACCEPTANCE_INTERRUPTED"); signal.throwIfAborted(); };
    const request = async (pathname, init = {}) => {
      const headers = { Origin: PRODUCTION_ORIGIN, ...init.headers };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (init.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetchImpl(`${PRODUCTION_ORIGIN}/api/ai/competition-discovery${pathname}`, {
        ...init, headers, signal: init.signal ?? signal, redirect: "error"
      });
      return response;
    };
    const jsonRequest = async (pathname, init = {}) => {
      const response = await request(pathname, init), body = await response.json().catch(() => null);
      if (!response.ok) throw failure(safeCode(body?.error) ?? `HTTP_${response.status}`);
      return body;
    };
    const recover = async () => {
      // Read-only recovery never retries either mutation or creates another job.
      const recovered = snapshotFrom(await jsonRequest("/session", { signal: AbortSignal.timeout(10_000) }));
      if (recovered) { latestSnapshot = recovered; runId = recovered.run?.runId; restoredFromSnapshot = true; }
      return recovered;
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
              if (data.length) {
                try {
                  const value = JSON.parse(data.join("\n")), event = value?.event ?? value;
                  const seq = Number(event?.seq ?? eventId), payload = event?.payload ?? event;
                  if (Number.isSafeInteger(seq) && seq > lastSeq) {
                    lastSeq = seq;
                    if (payload.type === "text" && typeof payload.delta === "string") {
                      if (firstTextMs === null && payload.delta) firstTextMs = Math.round(performance.now() - started);
                      streamedText += payload.delta;
                    } else if (payload.type === "reset") {
                      streamedText = ""; sources.clear();
                      events.push({ seq, type: "reset", attempt: [1, 2].includes(payload.attempt) ? payload.attempt : null });
                    } else if (payload.type === "sources" && Array.isArray(payload.sources)) {
                      for (const source of payload.sources) if (typeof source?.url === "string") sources.set(source.url, source);
                    } else if (["complete", "error", "cancelled", "tool"].includes(payload.type)) {
                      events.push({ seq, type: payload.type, code: safeCode(payload.code), action: payload.action, status: payload.status });
                    }
                  }
                } catch { /* Non-JSON keepalive frames do not alter the run. */ }
              }
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
            if (buffer) line(buffer); line("");
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        } catch { /* Read-only snapshot polling remains authoritative. */ }
        if (!streamController.signal.aborted && !signal.aborted) await delay(pollMs, undefined, { signal }).catch(() => {});
      }
    };
    try {
      continuing();
      await persist(`${profile.id}.phase.json`, { phase: "session_request_started", at: new Date().toISOString() });
      pendingMutation = true;
      let session;
      try { session = await jsonRequest("/session", { method: "POST", body: JSON.stringify(submission) }); }
      finally { pendingMutation = false; }
      token = session.resumeToken;
      latestSnapshot = snapshotFrom(session);
      if (typeof token !== "string" || !token) throw failure("MISSING_RESUME_TOKEN");
      if (!latestSnapshot || latestSnapshot.followups?.length) throw failure("UNEXPECTED_SESSION_PROTOCOL");
      // All four sessions are prepared before submitting the batch's reports.
      prepared = true; preparationBarrier.arrive(true);
      const batchReady = await preparationBarrier.ready;
      if (!batchReady) throw failure("BATCH_SESSION_PREPARATION_FAILED");
      continuing();
      reportStarted = performance.now();
      // Durable intention is recorded before POST. A lost response is resolved by
      // GET /session; the runner never repeats the paid-work mutation.
      await persist(`${profile.id}.phase.json`, { phase: "report_request_started", at: new Date().toISOString(), maximumPaidDispatches: 2 });
      reportSubmissions += 1;
      if (reportSubmissions > 8) throw failure("ACCEPTANCE_REPORT_LIMIT_EXCEEDED");
      pendingMutation = true;
      try {
        const queued = await jsonRequest("/report", { method: "POST", body: JSON.stringify({ clientRequestId: randomUUID() }) });
        latestSnapshot = snapshotFrom(queued) ?? latestSnapshot;
        runId = queued.runId ?? latestSnapshot?.run?.runId;
      } catch (error) {
        if (error?.safeCode) throw error;
        await recover();
        if (!runId) throw failure("REPORT_SUBMISSION_OUTCOME_UNKNOWN_NO_RETRY");
      } finally { pendingMutation = false; }
      if (typeof runId !== "string" || !/^[a-f0-9-]{36}$/i.test(runId)) throw failure("MISSING_RUN_ID");
      continuing();
      streamController = new AbortController(); streamPromise = observeStream();
      for (;;) {
        let state;
        try { state = snapshotFrom(await jsonRequest(`/runs/${encodeURIComponent(runId)}`)); }
        catch (error) {
          if (error?.safeCode || signal.aborted) throw error;
          state = await recover();
        }
        latestSnapshot = state ?? latestSnapshot;
        const run = latestSnapshot?.run;
        if (run?.markdown && firstTextMs === null) firstTextMs = Math.round(performance.now() - started);
        if (run?.attempt > 2) { interrupt("SERVER_RETRY_LIMIT_VIOLATED"); throw failure("SERVER_RETRY_LIMIT_VIOLATED"); }
        if (run && terminalStatuses.has(run.status)) break;
        await delay(pollMs, undefined, { signal });
      }
      const run = latestSnapshot?.run;
      result = { status: run?.status ?? "unknown", passed: run?.status === "complete" && Boolean(run.markdown?.trim()),
        error: safeCode(run?.error), attempt: run?.attempt ?? null, submittedAt: run?.submittedAt, deadlineAt: run?.deadlineAt,
        model: run?.model, webSearchUsed: run?.webSearchUsed, report: { markdown: run?.markdown ?? streamedText,
          sources: run?.sources ?? [...sources.values()] } };
    } catch (error) {
      result = { status: interruption ? "interrupted" : "acceptance_failed", passed: false,
        error: interruption ? "ACCEPTANCE_INTERRUPTED" : publicFailure(error), attempt: latestSnapshot?.run?.attempt ?? null,
        report: { markdown: latestSnapshot?.run?.markdown ?? streamedText, sources: latestSnapshot?.run?.sources ?? [...sources.values()] } };
      if (token && runId) {
        try {
          const cancelled = snapshotFrom(await jsonRequest(`/runs/${encodeURIComponent(runId)}/cancel`, {
            method: "POST", body: "{}", signal: AbortSignal.timeout(5_000)
          }));
          result.cancellationStatus = terminalStatuses.has(cancelled?.run?.status) ? cancelled.run.status : "requested";
        } catch { result.cancellationStatus = "request_failed"; }
      }
    } finally {
      if (!prepared) preparationBarrier.arrive(false);
      clearTimeout(timer); streamController?.abort(); activeStops.delete(stop);
      await streamPromise?.catch(() => {});
    }
    result = { schemaVersion: "saitu.server-live-case.v1", synthetic: true, caseId: profile.id, name: profile.name,
      runId, startedAt: caseStartedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
      reportElapsedMs: reportStarted === null ? null : Math.round(performance.now() - reportStarted), firstTextMs,
      streamConnections, restoredFromSnapshot, events, ...result, reviewChecks: profile.reviewChecks,
      manualContentReview: "required" };
    await persist(`${profile.id}.json`, result);
    onProgress({ caseId: result.caseId, passed: result.passed, status: result.status,
      error: result.error, elapsedMs: result.elapsedMs, firstTextMs: result.firstTextMs });
    return result;
  }

  try {
    for (let batch = 0; batch < 2 && !interruption; batch += 1) {
      let arrivals = 0, allPrepared = true, resolveReady;
      const barrier = { ready: new Promise((resolve) => { resolveReady = resolve; }), arrive(ok) {
        arrivals += 1; allPrepared &&= ok; if (arrivals === 4) resolveReady(allPrepared);
      } };
      const start = batch * 4;
      const batchResults = await Promise.all(profiles.slice(start, start + 4)
        .map((profile, index) => verifyProfile(profile, submissions[start + index], barrier)));
      results.push(...batchResults);
      await persistSummary();
      // Preparation/protocol failure does not authorize trying a replacement case.
      if (batchResults.some((result) => result.error === "BATCH_SESSION_PREPARATION_FAILED")) break;
    }
  } catch (error) { runnerError = publicFailure(error); interrupt("RUNNER_ERROR"); }
  finally {
    await persistSummary();
    for (const [name, handler] of signalHandlers) process.off(name, handler);
  }
  return { outputDirectory, passed: results.length === 8 && results.every(({ passed }) => passed),
    interrupted: interruption?.reason ?? null, runnerError, reportSubmissions, results };
}

function invocationId(runId, attempt) {
  const bytes = createHash("sha256").update("saitu-discovery-report.v1").update(Buffer.from([0]))
    .update(runId).update(Buffer.from([0])).update(String(attempt)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Content-free read-only billing audit. Never submits, retries, or restores work. */
export async function auditServerAcceptance({ evidenceRoot, batchId, readLedgerRows }) {
  const directory = path.join(evidenceRoot, APPROVAL_ID);
  const receipt = JSON.parse(await readFile(path.join(directory, "receipt.json"), "utf8"));
  if (receipt.batchId !== batchId || receipt.approvalId !== APPROVAL_ID) throw failure("ACCEPTANCE_RECEIPT_MISMATCH");
  const results = [];
  for (const id of PRODUCTION_ACCEPTANCE_CASE_IDS) {
    const result = await readFile(path.join(directory, `${id}.json`), "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return null; throw error;
    });
    if (result && result.caseId !== id) throw failure("ACCEPTANCE_CASE_MISMATCH");
    if (result?.runId && !/^[a-f0-9-]{36}$/i.test(result.runId)) throw failure("INVALID_ACCEPTANCE_RUN_ID");
    results.push(result);
  }
  const callIds = results.flatMap(result => result?.runId ? [invocationId(result.runId, 1), invocationId(result.runId, 2)] : []);
  const rows = await readLedgerRows(callIds);
  if (!Array.isArray(rows) || rows.some(row => !callIds.includes(row.callId))
    || new Set(rows.map(row => row.callId)).size !== rows.length) throw failure("ACCEPTANCE_LEDGER_AUDIT_INVALID");
  const dispatched = rows.filter(row => row.dispatchedAt !== null), boundaries = [];
  for (const row of dispatched) {
    const start = Date.parse(row.dispatchedAt), end = Date.parse(row.completedAt ?? row.hardDeadlineAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw failure("ACCEPTANCE_LEDGER_TIMESTAMPS_INVALID");
    boundaries.push([start, 1], [end, -1]);
  }
  let active = 0, maximumConcurrent = 0;
  for (const [, change] of boundaries.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    active += change; maximumConcurrent = Math.max(maximumConcurrent, active);
  }
  const chargedMicros = rows.reduce((total, row) => total + Number(row.chargedMicros ?? 0), 0);
  const completedReportsHaveDispatchEvidence = results.every(result => result?.status !== "complete"
    || dispatched.some(row => row.callId === invocationId(result.runId, 1) || row.callId === invocationId(result.runId, 2)));
  const audit = { schemaVersion: "saitu.server-live-ledger-audit.v1", approvalId: APPROVAL_ID, batchId,
    auditedAt: new Date().toISOString(), reportResults: results.filter(Boolean).length,
    reportRuns: results.filter(result => result?.runId).length,
    actualPaidDispatches: dispatched.length, maximumPaidDispatches: 16,
    observedMaximumConcurrent: maximumConcurrent,
    concurrencyMeasurement: "receipt dispatch through completion; conservative upper bound when completion is unavailable",
    chargedMicros, chargedCny: chargedMicros / 1e6,
    unsettledReservations: rows.filter(row => row.state === "reserved").length,
    completedReportsHaveDispatchEvidence,
    noUnexpectedRetries: results.every(result => !result || !(result.attempt > 2)),
    allResultsRecorded: results.every(Boolean),
    passed: results.every(Boolean) && dispatched.length <= 16 && maximumConcurrent <= 4
      && completedReportsHaveDispatchEvidence && rows.every(row => row.state !== "reserved")
      && results.every(result => !result || !(result.attempt > 2)), rows };
  const filename = path.join(directory, "ledger-audit.json"), temporary = `${filename}.tmp`;
  await writeFile(temporary, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, filename);
  return audit;
}

async function readProductionLedgerRows(callIds) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw failure("LEDGER_AUDIT_REQUIRES_SERVER_ROOT");
  if (!callIds.length) return [];
  const uuidList = callIds.map(id => `'${id}'::uuid`).join(",");
  const sql = `select coalesce(json_agg(json_build_object('callId',r.call_id,'dispatchedAt',r.dispatched_at,
    'completedAt',r.completed_at,'hardDeadlineAt',r.hard_deadline_at,'state',l.state,
    'chargedMicros',l.charged_micros,'usageCostMicros',r.usage_cost_micros,'operation',l.operation)), '[]'::json)
    from public.saitu_discovery_call_receipts r join public.ai_spend_ledger l on l.id=r.call_id
    where r.call_id in (${uuidList});`;
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", "-u", "postgres", "/usr/lib/postgresql/17/bin/psql", "--no-psqlrc",
      "--host=/var/run/postgresql", "--username=postgres", "--dbname=saitu_production",
      "--quiet", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => reject(failure("LEDGER_AUDIT_UNAVAILABLE")));
    child.once("exit", code => {
      if (code !== 0) reject(failure("LEDGER_AUDIT_UNAVAILABLE"));
      else { try { resolve(JSON.parse(output)); } catch { reject(failure("LEDGER_AUDIT_INVALID_JSON")); } }
    });
    child.stdin.end(`begin read only; set local statement_timeout='10000ms'; ${sql} commit;`);
  });
}

async function main() {
  const args = parseAcceptanceArgs(process.argv.slice(2));
  const evidenceRoot = args.evidenceRoot ?? (process.platform === "linux" ? "/var/lib/saitu/acceptance" : path.join(root, ".local/checks/server-live"));
  if (args.auditOnly) {
    const audit = await auditServerAcceptance({ evidenceRoot, batchId: args.batchId, readLedgerRows: readProductionLedgerRows });
    console.info(JSON.stringify({ passed: audit.passed, actualPaidDispatches: audit.actualPaidDispatches,
      observedMaximumConcurrent: audit.observedMaximumConcurrent, chargedCny: audit.chargedCny }));
    if (!audit.passed) process.exitCode = 1;
    return;
  }
  if (!args.live) {
    console.info("Explicit paid acceptance: --live --batch-id YYYYMMDDTHHMMSSZ [--evidence-root PATH]");
    console.info(`Target: ${PRODUCTION_ORIGIN}; fixed 8 synthetic reports, two batches of 4, at most 16 model dispatches.`);
    console.info("The persisted approval receipt prevents restarting this acceptance, even with a different batch ID.");
    console.info("Read-only server billing audit: --audit-only --batch-id YYYYMMDDTHHMMSSZ [--evidence-root PATH]");
    for (const id of PRODUCTION_ACCEPTANCE_CASE_IDS) console.info(id);
    return;
  }
  process.env.SAITU_RUNTIME_MODE = "server";
  const { installSourceLoader } = await import("../lib/load-typescript-source.mjs");
  installSourceLoader(root);
  const [{ DISCOVERY_ACCEPTANCE_PROFILES }, contracts, disclosure, policy, prompts] = await Promise.all([
    import("../../tests/discovery/fixtures.ts"), import("../../src/lib/competitions/discovery/contracts.ts"),
    import("../../src/lib/competitions/discovery/disclosure.ts"), import("../../src/lib/ai/discovery-policy.mjs"),
    import("../../src/lib/competitions/discovery/prompts.ts")
  ]);
  const selected = PRODUCTION_ACCEPTANCE_CASE_IDS.map((id) => DISCOVERY_ACCEPTANCE_PROFILES.find((profile) => profile.id === id));
  if (selected.some((profile) => !profile)) throw failure("SYNTHETIC_FIXTURE_MISSING");
  const binding = await readFile(path.join(root, ".next/decision-worker-binding.json"), "utf8").then(JSON.parse);
  const p = policy.DISCOVERY_RUNTIME_POLICY;
  const result = await runServerAcceptance({ ...args, profiles: selected,
    evidenceRoot,
    questionnaireVersion: contracts.DISCOVERY_SCHEMA_VERSION, consentVersion: disclosure.DISCOVERY_CONSENT_VERSION,
    parseSubmission: (input) => contracts.discoverySubmissionSchema.parse(input),
    configuration: { policyVersion: p.version, policySha256: policy.DISCOVERY_RUNTIME_POLICY_SHA256,
      sourceSha256: binding.sourceSha256, promptVersion: prompts.DISCOVERY_PROMPT_VERSION,
      initialEffort: p.initialEffort, concurrency: p.concurrency, dailyCallLimit: p.dailyCallLimit,
      automaticRetries: p.automaticRetries, reportDeadlineMs: p.reportDeadlineMs },
    onProgress: (value) => console.info(JSON.stringify(value)) });
  const audit = process.platform === "linux" && process.getuid?.() === 0
    ? await auditServerAcceptance({ evidenceRoot, batchId: args.batchId, readLedgerRows: readProductionLedgerRows }) : null;
  console.info(JSON.stringify({ passed: result.passed, reportSubmissions: result.reportSubmissions,
    evidenceDirectory: result.outputDirectory, actualPaidDispatches: audit?.actualPaidDispatches ?? "run --audit-only on the server",
    observedMaximumConcurrent: audit?.observedMaximumConcurrent, chargedCny: audit?.chargedCny, interruption: result.interrupted }));
  if (result.interrupted === "SIGINT") process.exitCode = 130;
  else if (result.interrupted === "SIGTERM") process.exitCode = 143;
  else if (!result.passed || result.runnerError || audit && !audit.passed) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => { console.error(JSON.stringify({ error: publicFailure(error) })); process.exitCode = 1; });
}
