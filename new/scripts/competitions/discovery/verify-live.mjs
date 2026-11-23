#!/usr/bin/env node
/** Explicit live acceptance runner. Ordinary build/verify never invokes this file. */
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { installSourceLoader } from "../../lib/load-typescript-source.mjs";
import { buildDiscoveryComparisonSchedule, buildDiscoveryComparisonSummary, buildDiscoveryExperimentSummary, createDiscoveryLiveMeasurements,
  LEGACY_PRESENTATION, CARDS_PRESENTATION } from "./live-measurements.mjs";
import { DISCOVERY_EXPERIMENT_PROTOCOLS, buildDiscoveryExperimentSchedule, discoveryExperimentProtocol,
  discoveryExperimentRound, parseDiscoveryExperimentProtocols, discoveryExperimentJobKey, discoveryExperimentResultFilename } from "./experiment-schedule.mjs";
import { parseDiscoveryExperimentShard, partitionDiscoveryExperimentSchedule } from "./experiment-schedule.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
installSourceLoader(root);
const { DISCOVERY_ACCEPTANCE_PROFILES } = await import("../../../tests/discovery/fixtures.ts");
const { DISCOVERY_SCHEMA_VERSION, discoverySubmissionSchema } = await import("../../../src/lib/competitions/discovery/contracts.ts");
const { DISCOVERY_CONSENT_VERSION } = await import("../../../src/lib/competitions/discovery/disclosure.ts");
const { safeDiscoveryResetFailureCode } = await import("../../../src/lib/competitions/discovery/transport.ts");
const { DISCOVERY_RUNTIME_POLICY, DISCOVERY_RUNTIME_POLICY_SHA256 } = await import("../../../src/lib/ai/discovery-policy.mjs");
const { DISCOVERY_PROMPT_VERSION, DISCOVERY_LEGACY_PROMPT_VERSION } = await import("../../../src/lib/competitions/discovery/prompts.ts");
const { DEFAULT_DISCOVERY_PRESENTATION_VERSION, DEFAULT_DISCOVERY_GENERATION_PROTOCOL } = await import("../../../src/lib/competitions/discovery/generation-protocol.ts");
const MAX_CASE_MS = 225_000;
const args = process.argv.slice(2);
let live = false, all = false, list = false, compare = false, presentationVersion, protocolVersion, variants,
  startRound = 1, rounds = 1, roundSpecified = false, roundsSpecified = false, captureSynthetic = false, shard,
  origin = "http://127.0.0.1:3190", stopAfterCurrentFile, label = "acceptance";
const requested = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--live") live = true;
  else if (arg === "--all") all = true;
  else if (arg === "--compare") compare = true;
  else if (arg === "--protocol" && args[index + 1]) protocolVersion = discoveryExperimentProtocol(args[++index]);
  else if (arg === "--variants" && args[index + 1]) variants = parseDiscoveryExperimentProtocols(args[++index]);
  else if (arg === "--round" && args[index + 1]) { startRound = discoveryExperimentRound(args[++index]); roundSpecified = true; }
  else if (arg === "--rounds" && args[index + 1]) { rounds = discoveryExperimentRound(args[++index]); roundsSpecified = true; }
  else if (arg === "--capture-synthetic") captureSynthetic = true;
  else if (arg === "--shard" && args[index + 1]) shard = parseDiscoveryExperimentShard(args[++index]);
  else if (arg === "--presentation" && [LEGACY_PRESENTATION, CARDS_PRESENTATION].includes(args[index + 1])) presentationVersion = args[++index];
  else if (arg === "--list" || arg === "--help") list = true;
  else if (arg === "--origin" && args[index + 1]) origin = args[++index];
  else if (arg === "--case" && args[index + 1]) requested.push(...args[++index].split(",").filter(Boolean));
  else if (arg === "--stop-after-current-file" && args[index + 1]) stopAfterCurrentFile = path.resolve(args[++index]);
  else if (arg === "--label" && args[index + 1] && /^[a-z0-9-]{1,64}$/.test(args[index + 1])) label = args[++index];
  else throw new Error("Usage: verify-live.mjs --list | --live (--case ID | --all) [--compare | --presentation legacy|discovery-cards.v1 | --protocol NAME | --variants A,B] [--round N] [--rounds N] [--shard INDEX/COUNT] [--capture-synthetic] [--origin http://127.0.0.1:3190] [--label LABEL] [--stop-after-current-file PATH]");
}

if (list || !live) {
  console.info("Explicit --live is required for paid model calls. Choose --case ID or --all; cases run sequentially.");
  console.info("SIGINT/SIGTERM cancel the current run and preserve results. A stop file stops after the current case.");
  console.info("--compare interleaves legacy and cards for each synthetic case; --presentation tests one format. These use the guarded local CLI enqueue path, with no public format selector.");
  console.info(`Experiment protocols: ${DISCOVERY_EXPERIMENT_PROTOCOLS.join(",")}. --round/--rounds never overwrite prior evidence; --capture-synthetic additionally requires the configured local capture allowlist.`);
  for (const profile of DISCOVERY_ACCEPTANCE_PROFILES) console.info(`${profile.id}\t${profile.name}`);
  process.exit(0);
}
if (all === (requested.length > 0)) throw new Error("Choose exactly one of --all or --case ID.");
if ([compare, Boolean(presentationVersion), Boolean(protocolVersion), Boolean(variants)].filter(Boolean).length > 1)
  throw new Error("Choose exactly one format/protocol selector.");
if (startRound + rounds - 1 > 100) throw new Error("INVALID_EXPERIMENT_ROUND_RANGE");
if (captureSynthetic && !(compare || presentationVersion || protocolVersion || variants)) throw new Error("SYNTHETIC_CAPTURE_REQUIRES_INTERNAL_EXPERIMENT");
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
const experimental = Boolean(protocolVersion || variants || roundSpecified || roundsSpecified || shard);
const defaultBenchmarkVariant = DEFAULT_DISCOVERY_PRESENTATION_VERSION === LEGACY_PRESENTATION ? "legacy" : DEFAULT_DISCOVERY_GENERATION_PROTOCOL;
const armVariants = variants ?? (protocolVersion ? [protocolVersion] : compare ? ["legacy", DEFAULT_DISCOVERY_GENERATION_PROTOCOL]
  : presentationVersion ? [presentationVersion === LEGACY_PRESENTATION ? "legacy" : DEFAULT_DISCOVERY_GENERATION_PROTOCOL] : [defaultBenchmarkVariant]);
const allJobs = experimental ? buildDiscoveryExperimentSchedule(selected, armVariants, { startRound, rounds })
  : (compare ? buildDiscoveryComparisonSchedule(selected) : selected.map(profile => ({ profile, presentationVersion })))
    .map(job => ({ ...job, round: 1,
      benchmarkVariant: (job.presentationVersion ?? DEFAULT_DISCOVERY_PRESENTATION_VERSION) === LEGACY_PRESENTATION ? "legacy" : DEFAULT_DISCOVERY_GENERATION_PROTOCOL,
      protocolVersion: job.presentationVersion === LEGACY_PRESENTATION ? undefined : job.presentationVersion ? DEFAULT_DISCOVERY_GENERATION_PROTOCOL : undefined }));
const jobs = partitionDiscoveryExperimentSchedule(allJobs, selected, shard);
const assignedCaseIds = new Set(jobs.map(job => job.profile.id));
const assignedProfiles = selected.filter(profile => assignedCaseIds.has(profile.id));

// Only this explicitly invoked local CLI can choose a format. The ordinary
// HTTP endpoints never receive a selector or a new administrative secret.
let internalHarness;
let syntheticDiagnostics;
if (compare || presentationVersion || protocolVersion || variants || experimental) {
  if (process.env.SAITU_RUNTIME_MODE === "server") throw new Error("INTERNAL_ACCEPTANCE_REQUIRES_LOCAL_RUNTIME");
  const { environment } = await import("../../local/shared.mjs");
  const localEnvironment = await environment("production");
  let database;
  try { database = new URL(localEnvironment.DATABASE_URL); } catch { throw new Error("INTERNAL_ACCEPTANCE_LOCAL_DATABASE_REQUIRED"); }
  if (localEnvironment.SAITU_STANDALONE_LOCAL !== "1" || localEnvironment.SAITU_RUNTIME_MODE === "server"
    || !["postgres:", "postgresql:"].includes(database.protocol) || database.hostname !== "127.0.0.1"
    || database.port !== "5433" || database.pathname !== "/saitu_clean" || database.search || database.hash
    || localEnvironment.NEXT_PUBLIC_SITE_URL !== origin) throw new Error("INTERNAL_ACCEPTANCE_REQUIRES_MATCHING_LOCAL_COPY");
  Object.assign(process.env, localEnvironment);
  const { enqueueDiscoveryReport, discoveryModelInvocationId } = await import("../../../src/lib/competitions/discovery/store.ts");
  const { getPool } = await import("../../../src/lib/db/pool.ts");
  const { unsealV7 } = await import("../../../src/lib/competitions/v7/crypto.ts");
  syntheticDiagnostics = await import("../../../src/lib/competitions/discovery/diagnostics.ts");
  if (captureSynthetic && process.env.SAITU_DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST !== path.join(root, ".local", "checks", "discovery-synthetic-capture-allowlist.json"))
    throw new Error("SYNTHETIC_CAPTURE_REQUIRES_CONFIGURED_LOCAL_ALLOWLIST");
  const { DISCOVERY_GENERATION_PROTOCOLS } = await import("../../../src/lib/competitions/discovery/generation-protocol.ts");
  if (JSON.stringify(DISCOVERY_EXPERIMENT_PROTOCOLS.filter(value => value !== "legacy")) !== JSON.stringify(DISCOVERY_GENERATION_PROTOCOLS))
    throw new Error("INTERNAL_ACCEPTANCE_PROTOCOL_DEFINITIONS_CHANGED");
  internalHarness = {
    async enqueue(token, input, job, onPrepared) {
      const { snapshot } = await enqueueDiscoveryReport(token, input, { presentationVersion: job.presentationVersion,
        ...(job.protocolVersion ? { protocolVersion: job.protocolVersion } : {}), ...(onPrepared ? { onPrepared } : {}) });
      return { runId: snapshot.run?.runId, snapshot };
    },
    async provenance(runId) {
      const { rows } = await getPool().query("select ciphertext,iv,tag from competition_discovery_runs where run_id=$1", [runId]);
      if (!rows[0]) throw failure("INTERNAL_ACCEPTANCE_RUN_NOT_FOUND");
      const body = unsealV7(`discovery-run:${runId}`, rows[0]);
      return { protocolVersion: body.protocolVersion ?? (body.presentationVersion ? "v16" : "legacy"), runtimeBinding: body.runtimeBinding };
    },
    async authorizeCapture(prepared, identity) {
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      await syntheticDiagnostics.registerDiscoverySyntheticCaptures([1, 2].map(attempt => ({
        callId: discoveryModelInvocationId(prepared.runId, attempt), inputSha256: identity.inputSha256,
        catalogSha256: prepared.catalogSha256, caseId: identity.caseId, presentationVersion: identity.presentationVersion,
        expiresAt, benchmarkVariant: identity.benchmarkVariant, round: identity.round,
        protocolVersion: identity.protocolVersion ?? "legacy",
      })));
    },
    async audit(runId) {
      const callIds = [1, 2].map(attempt => discoveryModelInvocationId(runId, attempt));
      const { rows } = await getPool().query(`select l.id,l.state,l.model,l.effort,l.price_version,l.charged_micros,
        l.input_tokens,l.output_tokens,l.cached_input_tokens,r.dispatched_at,r.completed_at
        from ai_spend_ledger l left join saitu_discovery_call_receipts r on r.call_id=l.id and r.run_id=l.run_id
        where l.id=any($1::uuid[]) and l.operation='competition_discovery_report' order by l.created_at`, [callIds]);
      const number = value => value === null || value === undefined ? null : Number(value);
      const calls = rows.map(row => ({ callId: row.id, state: row.state, model: row.model, effort: row.effort,
        priceVersion: row.price_version, chargedMicros: number(row.charged_micros), inputTokens: number(row.input_tokens),
        cachedInputTokens: number(row.cached_input_tokens), outputTokens: number(row.output_tokens),
        dispatched: row.dispatched_at !== null, completed: row.completed_at !== null }));
      const sum = key => calls.some(call => call[key] === null) ? null : calls.reduce((total, call) => total + call[key], 0);
      return { status: "available", calls, reservedCalls: calls.length, dispatchedCalls: calls.filter(call => call.dispatched).length,
        chargedMicros: sum("chargedMicros"), inputTokens: sum("inputTokens"), cachedInputTokens: sum("cachedInputTokens"), outputTokens: sum("outputTokens"),
        note: "Existing accounting price snapshot; conservative charges or unknown usage are retained, not treated as zero or a provider invoice." };
    },
    async captureAudit(runId, identity) {
      const calls = [];
      for (const attempt of [1, 2]) {
        const callId = discoveryModelInvocationId(runId, attempt);
        const evidence = path.join(root, ".local", "checks", "discovery-synthetic-captures", `${callId}.ndjson`);
        try {
          const capture = await syntheticDiagnostics.readDiscoverySyntheticCapture(evidence);
          const header = capture.header;
          if (header.callId !== callId || header.inputSha256 !== identity.inputSha256
            || header.catalogSha256 !== configuration.catalog.sha256 || header.runtimeBinding !== configuration.runtimeBinding
            || header.caseId !== identity.caseId || header.benchmarkVariant !== identity.benchmarkVariant || header.round !== identity.round
            || header.protocolVersion !== identity.benchmarkVariant
            || header.presentationVersion !== (identity.benchmarkVariant === "legacy" ? LEGACY_PRESENTATION : CARDS_PRESENTATION))
            throw failure("SYNTHETIC_CAPTURE_EVIDENCE_BINDING_MISMATCH");
          // Keep raw content in its guarded private file. This projection is
          // intentionally restricted to identity, completion and timing data.
          calls.push({ attempt, callId, status: "available", evidence, complete: capture.complete, integrity: capture.integrity,
            ...(capture.readFailure ? { readFailure: capture.readFailure } : {}),
            timings: capture.timings, ...(capture.end ? { end: capture.end } : {}) });
        } catch (error) {
          calls.push({ attempt, callId, status: error?.code === "ENOENT" ? "not_observed" : "unavailable",
            ...(error?.code === "ENOENT" ? {} : { error: publicFailure(error) }) });
        }
      }
      return { enabled: true, calls };
    },
    close: () => getPool().end(),
  };
}
// Two explicitly started runners must not overwrite each other's summaries.
const stamp = `${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}`;
const outputDirectory = path.join(root, ".local", "checks", "discovery-live", stamp);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);
const buildBinding = await readFile(path.join(root, ".next", "decision-worker-binding.json"), "utf8")
  .then(JSON.parse).catch(() => null);
// Safe provenance only; neither credentials nor recovery tokens are persisted.
const configuration = {
  model: DISCOVERY_RUNTIME_POLICY.model,
  initialEffort: DISCOVERY_RUNTIME_POLICY.initialEffort,
  policySha256: DISCOVERY_RUNTIME_POLICY_SHA256,
  promptVersion: DISCOVERY_PROMPT_VERSION,
  legacyPromptVersion: DISCOVERY_LEGACY_PROMPT_VERSION,
  harnessArguments: args,
  experiment: { variants: armVariants, startRound, rounds, captureSynthetic, ...(shard ? { shard } : {}) },
  metricDefinitions: {
    firstTextMs: "Compatibility metric: first delivered Markdown (or explicitly labelled snapshot observation), not upstream TTFT. For cards this is normally a validated profile projection.",
    firstCompleteRecommendation: "A complete validated card record for cards, or a conservative closed recommendation section for legacy. Primary paired statistics require SSE observations.",
    upstreamTtft: "Not inferred from delivered Markdown. Read this run's content-free discovery_latency first_upstream_text worker event separately.",
  },
  execution: internalHarness ? "local_cli_enqueue_with_existing_authority" : "http_report_endpoint",
  consentAudit: internalHarness ? "Synthetic acceptance only: explicit --live invocation, current accepted consent in each HTTP session, and existing persisted model authority. CLI enqueue does not create an extra HTTP consent row." : "existing_http_consent_audit",
  productionBuildSourceSha256: buildBinding?.sourceSha256 ?? null
};
if (internalHarness) {
  const { makeDiscoveryCatalogSnapshot } = await import("../../../src/lib/competitions/discovery/catalog.ts");
  const catalog = makeDiscoveryCatalogSnapshot();
  configuration.catalog = { version: catalog.version, count: catalog.count, sha256: catalog.sha256, byteLength: catalog.byteLength };
  configuration.runtimeBinding = process.env.SAITU_DISCOVERY_SOURCE_SHA256 ?? null;
  if (!configuration.runtimeBinding || configuration.runtimeBinding !== configuration.productionBuildSourceSha256)
    throw new Error("INTERNAL_ACCEPTANCE_BUILD_BINDING_MISMATCH");
}

async function protocolSourceSha256() {
  const directory = path.join(root, "src", "lib", "competitions", "discovery");
  const files = (await readdir(directory)).filter(name => /\.(?:ts|mjs)$/u.test(name)).sort();
  const hash = createHash("sha256");
  for (const name of files) hash.update(name).update("\0").update(await readFile(path.join(directory, name))).update("\0");
  hash.update("discovery-policy.mjs\0").update(await readFile(path.join(root, "src", "lib", "ai", "discovery-policy.mjs")));
  return hash.digest("hex");
}
if (internalHarness) configuration.protocolSourceSha256 = await protocolSourceSha256();
configuration.fixturesSha256 = createHash("sha256").update(await readFile(path.join(root, "tests", "discovery", "fixtures.ts"))).digest("hex");
configuration.harnessSha256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url)))
  .update(await readFile(path.join(root, "scripts", "competitions", "discovery", "experiment-schedule.mjs"))).digest("hex");

async function assertFrozenProvenance() {
  if (!internalHarness) return;
  const binding = JSON.parse(await readFile(path.join(root, ".next", "decision-worker-binding.json"), "utf8"));
  const { makeDiscoveryCatalogSnapshot } = await import("../../../src/lib/competitions/discovery/catalog.ts");
  if (binding.sourceSha256 !== configuration.productionBuildSourceSha256
    || makeDiscoveryCatalogSnapshot().sha256 !== configuration.catalog.sha256
    || await protocolSourceSha256() !== configuration.protocolSourceSha256)
    throw failure("INTERNAL_ACCEPTANCE_FROZEN_PROVENANCE_CHANGED");
}

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
  return typeof error?.safeCode === "string" ? error.safeCode : /^DISCOVERY_[A-Z0-9_:-]{1,100}$/u.test(error?.message ?? "")
    ? error.message : error?.name === "AbortError" ? "ACCEPTANCE_TIMEOUT" : "NETWORK_OR_PROTOCOL_ERROR";
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

const frozenInputs = selected.map(profile => {
  const answers = discoverySubmissionSchema.parse({ schemaVersion: DISCOVERY_SCHEMA_VERSION, answers: currentAnswers(profile),
    consentVersion: DISCOVERY_CONSENT_VERSION, consentAccepted: true, clientRequestId: randomUUID() }).answers;
  const input = { answers, additionalText: "", followups: [] };
  const inputSha256 = syntheticDiagnostics?.discoverySyntheticInputSha256(input)
    ?? createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return { caseId: profile.id, inputSha256, ...input };
});
const frozenInputByCase = new Map(frozenInputs.map(input => [input.caseId, input]));
configuration.syntheticInputsSha256 = createHash("sha256").update(JSON.stringify(frozenInputs)).digest("hex");
configuration.plannedReportTasks = jobs.length;
configuration.globalPlannedReportTasks = allJobs.length;

async function verifyProfile(job) {
  const { profile, presentationVersion: requestedPresentationVersion, benchmarkVariant, round } = job;
  const startedAt = new Date().toISOString(), started = performance.now();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), MAX_CASE_MS);
  const signal = controller.signal;
  let token, runId, latestSnapshot, streamController, streamPromise;
  let measurements, terminalObservedAt, inputSha256, actualProtocolVersion;
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
  const observedAt = () => ({ elapsedMs: Math.round(performance.now() - started),
    reportElapsedMs: reportStarted === null ? null : Math.round(performance.now() - reportStarted) });
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
      measurements?.text(payload.delta, payload.presentationRecord, observedAt(), seq);
    } else if (payload.type === "reset") {
      streamedText = ""; sources.clear(); resetCount += 1;
      measurements?.reset(payload.attempt, observedAt(), seq);
      resetEvents.push({ seq, attempt: [1, 2].includes(payload.attempt) ? payload.attempt : null,
        reason: ["timeout", "temporary_error", "withdrawn"].includes(payload.reason) ? payload.reason : undefined,
        ...(payload.failureCode === undefined ? {} : { failureCode: safeDiscoveryResetFailureCode(payload.failureCode) }),
        elapsedMs: Math.round(performance.now() - started),
        reportElapsedMs: reportStarted === null ? null : Math.round(performance.now() - reportStarted) });
    } else if (payload.type === "sources" && Array.isArray(payload.sources)) {
      for (const source of payload.sources) if (typeof source?.url === "string") sources.set(source.url, source);
    } else if (payload.type === "tool") {
      toolEvents.push({ seq, ...observedAt(), action: payload.action, status: payload.status });
    } else if (["complete", "error", "cancelled"].includes(payload.type)) {
      const at = observedAt();
      terminalEvents.push({ seq, ...at, type: payload.type, code: payload.code, webSearchUsed: payload.webSearchUsed });
      measurements?.terminal(payload.type, at, seq);
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
    inputSha256 = syntheticDiagnostics?.discoverySyntheticInputSha256({ answers: submission.answers, additionalText: "", followups: [] })
      ?? createHash("sha256").update(JSON.stringify({ answers: submission.answers, additionalText: "", followups: [] })).digest("hex");
    if (inputSha256 !== frozenInputByCase.get(profile.id)?.inputSha256) throw failure("INTERNAL_ACCEPTANCE_INPUT_CHANGED");
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
    try {
      const reportInput = { clientRequestId: randomUUID(), followupAnswers: [] };
      const onPrepared = captureSynthetic ? async prepared => {
        const preparedHash = syntheticDiagnostics.discoverySyntheticInputSha256(prepared);
        if (preparedHash !== inputSha256 || prepared.catalogSha256 !== configuration.catalog.sha256)
          throw failure("SYNTHETIC_CAPTURE_INPUT_BINDING_MISMATCH");
        await internalHarness.authorizeCapture(prepared, { inputSha256, caseId: profile.id, benchmarkVariant, round,
          presentationVersion: requestedPresentationVersion, protocolVersion: job.protocolVersion });
      } : undefined;
      queued = internalHarness ? await internalHarness.enqueue(token, reportInput, job, onPrepared)
        : await jsonRequest("/report", { method: "POST", body: JSON.stringify(reportInput) });
    }
    finally { pendingMutation = false; }
    latestSnapshot = extractSnapshot(queued) ?? latestSnapshot;
    runId = queued.runId ?? latestSnapshot?.run?.runId;
    if (typeof runId !== "string") throw failure("MISSING_RUN_ID");
    const actualPresentationVersion = latestSnapshot?.run?.presentationVersion ?? LEGACY_PRESENTATION;
    if (requestedPresentationVersion && requestedPresentationVersion !== actualPresentationVersion) throw failure("PRESENTATION_VERSION_MISMATCH");
    if (internalHarness) {
      const audit = await internalHarness.provenance(runId);
      actualProtocolVersion = audit.protocolVersion;
      if (actualProtocolVersion !== benchmarkVariant || audit.runtimeBinding !== configuration.runtimeBinding)
        throw failure("PROTOCOL_VERSION_MISMATCH");
    }
    measurements = createDiscoveryLiveMeasurements(actualPresentationVersion);
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
      if (run && ["complete", "failed", "cancelled", "superseded", "deleted", "expired"].includes(run.status)) { terminalObservedAt = observedAt(); break; }
      await delay(1_000, undefined, { signal });
    }
    const run = latestSnapshot?.run;
    result = {
      schemaVersion: "saitu.discovery-live-acceptance.v1", questionnaireVersion: DISCOVERY_SCHEMA_VERSION, label, synthetic: true, caseId: profile.id, name: profile.name,
      startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
      firstTextMs, reportFirstTextMs, reportElapsedMs: Math.round(performance.now() - reportStarted), firstTextObservedVia,
      firstDeliveredMarkdownMs: firstTextMs, reportFirstDeliveredMarkdownMs: reportFirstTextMs,
      runId, submittedAt: run?.submittedAt, deadlineAt: run?.deadlineAt,
      status: run?.status ?? "unknown", passed: run?.status === "complete" && Boolean(run.markdown?.trim()),
      model: run?.model, error: run?.error, attempts: run?.attempt, webSearchUsed: run?.webSearchUsed ?? toolEvents.some((event) => event.action === "search"),
      presentationVersion: run?.presentationVersion ?? LEGACY_PRESENTATION,
      promptVersion: (run?.presentationVersion ?? LEGACY_PRESENTATION) === LEGACY_PRESENTATION ? DISCOVERY_LEGACY_PROMPT_VERSION : DISCOVERY_PROMPT_VERSION,
      streamConnections, lastSeq, resetCount, resetEvents, toolEvents, terminalEvents,
      clarificationStatus, clarificationNotice, clarificationElapsedMs, sessionElapsedMs, followups: questions, followupAnswerPolicy: "not_requested",
      report: { markdown: run?.markdown ?? streamedText, sources: run?.sources ?? [...sources.values()], ...(run?.presentation ? { presentation: run.presentation } : {}) },
      reviewChecks: profile.reviewChecks, coverageCandidates: profile.coverageCandidates,
      manualContentReview: "required", usageAudit: "Read corresponding ai_spend_ledger rows; no credentials are included in this artifact."
    };
  } catch (error) {
    result = {
      schemaVersion: "saitu.discovery-live-acceptance.v1", questionnaireVersion: DISCOVERY_SCHEMA_VERSION, label, synthetic: true, caseId: profile.id, name: profile.name,
      startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
      firstTextMs, reportFirstTextMs, reportElapsedMs: reportStarted === null ? null : Math.round(performance.now() - reportStarted),
      firstDeliveredMarkdownMs: firstTextMs, reportFirstDeliveredMarkdownMs: reportFirstTextMs,
      firstTextObservedVia, runId, passed: false, status: interruption ? "interrupted" : "acceptance_failed",
      presentationVersion: requestedPresentationVersion ?? latestSnapshot?.run?.presentationVersion ?? LEGACY_PRESENTATION,
      error: interruption ? "ACCEPTANCE_INTERRUPTED" : publicFailure(error),
      ...(interruption ? { interrupted: true, interruptionReason: interruption.reason } : {}),
      streamConnections, lastSeq, resetCount, resetEvents, toolEvents, terminalEvents,
      clarificationStatus, clarificationNotice, clarificationElapsedMs, sessionElapsedMs,
      report: { markdown: latestSnapshot?.run?.markdown ?? streamedText, sources: latestSnapshot?.run?.sources ?? [...sources.values()],
        ...(latestSnapshot?.run?.presentation ? { presentation: latestSnapshot.run.presentation } : {}) },
      reviewChecks: profile.reviewChecks, manualContentReview: "required"
    };
    if ((signal.aborted || interruption || internalHarness) && token && runId) {
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
  result.measurements = (measurements ?? createDiscoveryLiveMeasurements(result.presentationVersion)).finish(latestSnapshot?.run, terminalObservedAt ?? observedAt());
  if (internalHarness && runId) {
    try { result.usageAudit = await internalHarness.audit(runId); }
    catch { result.usageAudit = { status: "unavailable", error: "LOCAL_AUDIT_READ_FAILED" }; }
    if (captureSynthetic) result.syntheticCapture = await internalHarness.captureAudit(runId, {
      inputSha256, caseId: profile.id, benchmarkVariant, round });
  }
  result.configuration = configuration;
  Object.assign(result, { round, benchmarkVariant, protocolVersion: actualProtocolVersion ?? null,
    experimentJobKey: discoveryExperimentJobKey({ round, caseId: profile.id, benchmarkVariant }),
    inputSha256, catalogSha256: configuration.catalog?.sha256 ?? null });
  const suffix = requestedPresentationVersion ? requestedPresentationVersion === LEGACY_PRESENTATION ? ".legacy" : ".cards" : "";
  const filename = await persist(experimental ? discoveryExperimentResultFilename(job) : `${profile.id}${suffix}.json`, result);
  console.info(JSON.stringify({ caseId: result.caseId, passed: result.passed, status: result.status,
    round, benchmarkVariant, protocolVersion: result.protocolVersion,
    elapsedMs: result.elapsedMs, reportElapsedMs: result.reportElapsedMs, firstTextMs: result.firstTextMs,
    reportFirstTextMs: result.reportFirstTextMs, clarificationStatus: result.clarificationStatus,
    presentationVersion: result.presentationVersion, profileAvailableMs: result.measurements.profile?.elapsedMs ?? null,
    firstCompleteRecommendationMs: result.measurements.firstRecommendation?.elapsedMs ?? null,
    firstRecommendationTimingSource: result.measurements.firstRecommendation?.observedVia ?? null,
    noRecommendations: result.measurements.noRecommendations,
    clarificationElapsedMs: result.clarificationElapsedMs, webSearchUsed: result.webSearchUsed,
    sources: result.report.sources.length, error: result.error, resetEvents: result.resetEvents, evidence: filename }));
  return result;
}

const results = [];
let runnerError;
async function persistSummary() {
  const tested = new Set(results.map(discoveryExperimentJobKey));
  const describeJob = job => ({ caseId: job.profile.id, round: job.round, benchmarkVariant: job.benchmarkVariant,
    protocolVersion: job.protocolVersion ?? "legacy", presentationVersion: job.presentationVersion ?? "http_default" });
  const experimentSummary = experimental
    ? buildDiscoveryExperimentSummary(results, assignedProfiles.map(profile => profile.id),
      { variants: armVariants, rounds, startRound, baselineVariant: armVariants.includes("legacy") ? "legacy" : armVariants[0] }) : undefined;
  await persist("summary.json", { schemaVersion: "saitu.discovery-live-summary.v1", questionnaireVersion: DISCOVERY_SCHEMA_VERSION, label, synthetic: true, origin,
    completedAt: new Date().toISOString(), configuration, interrupted: Boolean(interruption),
    ...(interruption ? { interruption } : {}), ...(runnerError ? { error: runnerError } : {}),
    selectedCaseIds: assignedProfiles.map((profile) => profile.id),
    plannedCaseIds: selected.map(profile => profile.id),
    scheduledJobs: jobs.map(describeJob),
    remainingJobs: jobs.filter(job => !tested.has(discoveryExperimentJobKey({ round: job.round, caseId: job.profile.id, benchmarkVariant: job.benchmarkVariant }))).map(describeJob),
    cases: results.map(({ caseId, round, benchmarkVariant, protocolVersion, inputSha256, catalogSha256, experimentJobKey, runId, passed, status, elapsedMs, reportElapsedMs, firstTextMs, reportFirstTextMs, clarificationStatus, clarificationElapsedMs, sessionElapsedMs, webSearchUsed, toolEvents, error, resetEvents, cancellationRequested, cancellationStatus, presentationVersion, measurements, usageAudit, syntheticCapture }) =>
      ({ caseId, runId, passed, status, elapsedMs, reportElapsedMs, firstTextMs, reportFirstTextMs, clarificationStatus, clarificationElapsedMs, sessionElapsedMs, webSearchUsed,
        round, benchmarkVariant, protocolVersion, inputSha256, catalogSha256, experimentJobKey,
        presentationVersion, measurements: measurements ? Object.fromEntries(Object.entries(measurements).filter(([key]) => !["textTimeline", "attemptHistory"].includes(key))) : undefined, usageAudit, syntheticCapture,
        acrossAttemptsToolEventCount: toolEvents.length, error, resetEvents, cancellationRequested, cancellationStatus })),
    ...(compare && !experimental ? { comparison: buildDiscoveryComparisonSummary(results, selected.map(profile => profile.id)) } : {}),
    ...(experimentSummary ? { experiment: experimentSummary } : {}),
    manualContentReview: "required", observedHostedSearch: results.some((result) => result.webSearchUsed === true || result.toolEvents.length > 0) });
}
try {
  await persist("inputs.json", { schemaVersion: "saitu.discovery-live-synthetic-inputs.v1", synthetic: true,
    questionnaireVersion: DISCOVERY_SCHEMA_VERSION, sha256: configuration.syntheticInputsSha256, cases: frozenInputs });
  if (internalHarness) {
    const { makeDiscoveryCatalogSnapshot } = await import("../../../src/lib/competitions/discovery/catalog.ts");
    await persist("catalog-snapshot.json", makeDiscoveryCatalogSnapshot());
  }
  // Save the complete planned matrix before dispatching its first paid task.
  // A stopped experiment therefore still shows every not-run cell.
  await persistSummary();
  console.info(JSON.stringify({ experimentDirectory: outputDirectory, plannedReportTasks: jobs.length,
    variants: armVariants, startRound, rounds, captureSynthetic }));
  for (const job of jobs) {
    await checkStopFile();
    if (interruption) break;
    await assertFrozenProvenance();
    results.push(await verifyProfile(job));
    await assertFrozenProvenance();
    await checkStopFile();
    // Preserve completed cases even if a later case or shutdown fails.
    await persistSummary();
    if (interruption) break;
  }
} catch (error) { runnerError = publicFailure(error); }
finally {
  try { await persistSummary(); }
  finally {
    for (const [name, handler] of signalHandlers) process.off(name, handler);
    await internalHarness?.close();
  }
}
if (interruption?.reason === "SIGINT") process.exitCode = 130;
else if (interruption?.reason === "SIGTERM") process.exitCode = 143;
else if (runnerError || results.some((result) => !result.passed)) process.exitCode = 1;
