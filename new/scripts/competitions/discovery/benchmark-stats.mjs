/** Pure benchmark bookkeeping and acceptance statistics. Never dispatches AI. */
export const DISCOVERY_OPTIONAL_CARD_CASE_IDS = Object.freeze([
  "all-uncertain", "all-skipped", "sparse-feasible-options", "graduated-eligibility",
]);
export const DISCOVERY_BENCHMARK_DEFAULTS = Object.freeze({
  rounds: 3, caseCount: 15, deadlineMs: 180_000, firstCardRatio: 0.75,
  firstCardSavingsMs: 10_000, wholeRatio: 0.85, p90Ratio: 1,
  bootstrapIterations: 10_000, bootstrapSeed: 20261123, confidence: 0.95,
});

const label = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/u.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const duration = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const complete = row => row?.passed === true && (row.status === undefined || row.status === "complete");
const legacy = row => row?.presentationVersion === "legacy" || row?.measurements?.presentationVersion === "legacy";
const notRun = row => !row || ["not-run", "not_run"].includes(row.status);
const structuralFailure = row => row?.structuralFailure === true
  || /(?:INVALID_OUTPUT|EMPTY_(?:REPORT|CONTENT)|TRUNCATED|PRESENTATION|INVALID_(?:JSON|RECORD)|SCHEMA|PARSE_ERROR)/u.test(String(row?.error ?? "").toUpperCase());

export function discoveryBenchmarkIdentity(row) {
  const round = row?.round ?? 1;
  const benchmarkVariant = row?.benchmarkVariant ?? row?.presentationVersion;
  if (!positiveInteger(round) || !label(row?.caseId) || !label(benchmarkVariant)) throw new Error("BENCHMARK_IDENTITY_INVALID");
  return { round, caseId: row.caseId, benchmarkVariant };
}
export function discoveryBenchmarkResultKey(row) {
  const { round, caseId, benchmarkVariant } = discoveryBenchmarkIdentity(row);
  return JSON.stringify([round, caseId, benchmarkVariant]);
}

export function summariseBenchmarkNumbers(values) {
  const sorted = values.filter(value => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, medianMs: null, p90Ms: null, p95Ms: null, minMs: null, maxMs: null };
  const middle = Math.floor(sorted.length / 2);
  return { count: sorted.length, medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p90Ms: sorted[Math.ceil(sorted.length * 0.9) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], minMs: sorted[0], maxMs: sorted.at(-1) };
}

const utf8Boundary = (buffer, offset) => Number.isSafeInteger(offset) && offset >= 0 && offset <= buffer.length
  && (offset === buffer.length || (buffer[offset] & 0xC0) !== 0x80);

/** Bind human section judgments to the saved final-attempt UI stream. The human
 * names the actual competition and its complete section; this function checks
 * byte/timeline evidence, not recommendation semantics. Raw artifacts stay intact.
 * Historical review files may omit round/variant only when runId is unambiguous. */
export function applyDiscoveryTimingReviews(results, reviewInput = []) {
  const source = Array.isArray(reviewInput) ? reviewInput : reviewInput?.cases ?? reviewInput?.rows;
  if (!Array.isArray(source)) throw new Error("BENCHMARK_TIMING_REVIEWS_INVALID");
  const attached = results.filter(row => row.timingReview && !source.some(review => review?.runId === row.runId))
    .map(row => ({ ...row.timingReview, runId: row.timingReview.runId ?? row.runId }));
  const reviews = [], issues = [], byRun = new Map();
  for (const [index, review] of [...source, ...attached].entries()) {
    const reject = code => issues.push({ index, runId: review?.runId, code });
    if (typeof review?.runId !== "string" || !review.runId) { reject("timing_review_run_id_required"); continue; }
    const matches = results.filter(row => row.runId === review.runId);
    if (matches.length !== 1) { reject("timing_review_run_not_unique"); continue; }
    const row = matches[0];
    let identity;
    try { identity = discoveryBenchmarkIdentity(row); } catch { reject("timing_review_identity_invalid"); continue; }
    if (["round", "caseId", "benchmarkVariant"].some(key => review[key] !== undefined && review[key] !== identity[key])) {
      reject("timing_review_identity_mismatch"); continue;
    }
    if (review.reviewed !== true || !complete(row) || typeof review.noRecommendations !== "boolean") {
      reject("timing_review_not_complete"); continue;
    }
    if (byRun.has(review.runId)) {
      // Reapplying the exact normalized evidence is harmless; two different
      // judgments must never select whichever happens to be first.
      if (JSON.stringify(byRun.get(review.runId).input) === JSON.stringify(review)) continue;
      reject("duplicate_timing_review"); byRun.set(review.runId, { invalid: true }); continue;
    }
    const normalized = { ...review, ...identity, reviewed: true, evidenceValidated: true };
    if (review.noRecommendations) {
      if (review.correctedFirstRecommendation || review.reviewedFirst || review.firstRecommendation) {
        reject("zero_result_has_first_card_timing"); continue;
      }
      normalized.correctedFirstRecommendation = null;
    } else {
      const requested = review.correctedFirstRecommendation ?? review.reviewedFirst ?? review.firstRecommendation;
      const start = review.startUtf8Bytes ?? requested?.startUtf8Bytes;
      const end = review.sectionEndExclusiveUtf8Bytes ?? review.endUtf8Bytes ?? requested?.endUtf8Bytes;
      const recognition = review.recognitionEndExclusiveUtf8Bytes ?? requested?.recognitionEndExclusiveUtf8Bytes;
      const markdown = row.report?.markdown ?? row.markdown;
      const bytes = typeof markdown === "string" ? Buffer.from(markdown, "utf8") : null;
      if (!bytes || !utf8Boundary(bytes, start) || !utf8Boundary(bytes, end) || !utf8Boundary(bytes, recognition)
        || start >= end || end > recognition) { reject("timing_review_byte_boundaries_invalid"); continue; }
      const timeline = row.measurements?.textTimeline ?? [], finalAttempt = row.measurements?.attempt ?? 1;
      const current = timeline.filter(event => (event.attempt ?? 1) === finalAttempt && !event.reset);
      let text = "", timelineInvalid = false;
      const deltas = [];
      for (const event of current) if (typeof event.delta === "string") {
        text += event.delta;
        const length = Buffer.byteLength(text, "utf8");
        if (event.cumulativeUtf8Bytes !== undefined && event.cumulativeUtf8Bytes !== length) timelineInvalid = true;
        deltas.push({ ...event, cumulativeUtf8Bytes: length });
      }
      if (timelineInvalid || !markdown.startsWith(text)) { reject("timing_review_saved_stream_mismatch"); continue; }
      const atEnd = review.boundaryKind === "report_end" || ["successful_report_end", "manually_verified_report_end"].includes(requested?.method);
      // Without a following boundary, the successful terminal event closes the
      // last item. A partial heading/first character cannot close a section.
      const observed = atEnd ? current.find(event => event.terminal === "complete")
        : deltas.find(event => event.cumulativeUtf8Bytes >= recognition);
      if ((!atEnd && recognition === end) || !observed || !duration(observed.elapsedMs) || !Number.isSafeInteger(observed.seq)
        || (atEnd && (end !== bytes.length || recognition !== bytes.length || Buffer.byteLength(text, "utf8") !== bytes.length))) {
        reject("timing_review_boundary_not_observed"); continue;
      }
      if (requested && ["seq", "elapsedMs", "reportElapsedMs"].some(key => requested[key] !== undefined && requested[key] !== observed[key])) {
        reject("timing_review_observed_time_mismatch"); continue;
      }
      normalized.boundaryKind = atEnd ? "report_end" : "following_section";
      normalized.correctedFirstRecommendation = { elapsedMs: observed.elapsedMs, reportElapsedMs: observed.reportElapsedMs ?? null,
        seq: observed.seq, observedVia: "reviewed_sse_boundary", method: atEnd ? "manually_verified_report_end" : "manually_verified_following_section",
        title: review.measuredCompetitionTitle ?? requested?.title, startUtf8Bytes: start, endUtf8Bytes: end,
        recognitionEndExclusiveUtf8Bytes: recognition, cumulativeUtf8Bytes: observed.cumulativeUtf8Bytes ?? bytes.length };
    }
    byRun.set(review.runId, { input: review, normalized });
  }
  for (const value of byRun.values()) if (!value.invalid) reviews.push(value.normalized);
  const validByRun = new Map(reviews.map(review => [review.runId, review]));
  return { results: results.map(row => ({ ...row, timingReview: validByRun.get(row.runId) })), reviews, issues };
}

function plan(caseIds, options = {}) {
  const variants = options.variants ?? ["legacy", "discovery-cards.v1"];
  const rounds = options.rounds ?? 1, startRound = options.startRound ?? 1;
  if (!positiveInteger(rounds) || !positiveInteger(startRound) || !Array.isArray(caseIds) || !caseIds.length
    || caseIds.some(id => !label(id)) || new Set(caseIds).size !== caseIds.length
    || !Array.isArray(variants) || variants.length < 1 || variants.some(value => !label(value))
    || new Set(variants).size !== variants.length) throw new Error("BENCHMARK_PLAN_INVALID");
  const baselineVariant = options.baselineVariant ?? variants[0];
  if (!variants.includes(baselineVariant)) throw new Error("BENCHMARK_BASELINE_INVALID");
  const cells = [];
  for (let round = startRound; round < startRound + rounds; round += 1) for (const caseId of caseIds) for (const benchmarkVariant of variants) {
    cells.push({ round, caseId, benchmarkVariant });
  }
  return { variants, rounds, startRound, baselineVariant, caseIds, cells };
}

function indexResults(results) {
  const byKey = new Map(), invalidRows = [];
  for (let index = 0; index < results.length; index += 1) {
    try {
      const key = discoveryBenchmarkResultKey(results[index]);
      byKey.set(key, [...(byKey.get(key) ?? []), results[index]]);
    } catch { invalidRows.push({ index, code: "BENCHMARK_IDENTITY_INVALID" }); }
  }
  return { byKey, invalidRows };
}
function onlyRow(index, identity) {
  const rows = index.byKey.get(discoveryBenchmarkResultKey(identity));
  return rows?.length === 1 ? rows[0] : undefined;
}
function findTimingReview(row, external = []) {
  if (!row) return undefined;
  const matching = external.filter(review => {
    try { return discoveryBenchmarkResultKey(review) === discoveryBenchmarkResultKey(row); } catch { return false; }
  });
  if (matching.length > 1) return { duplicate: true };
  return matching[0] ?? row.timingReview;
}
function firstTiming(row, reviews = [], allowUnreviewedLegacy = false) {
  if (!row) return { timing: null, issue: "not_run" };
  const review = findTimingReview(row, reviews);
  if (review?.duplicate) return { timing: null, issue: "duplicate_timing_review" };
  if (review?.runId && review.runId !== row.runId) return { timing: null, issue: "timing_review_run_mismatch" };
  if (legacy(row) && !allowUnreviewedLegacy && (review?.reviewed !== true || review.evidenceValidated !== true)) return { timing: null, issue: "legacy_manual_review_required" };
  const timing = review?.reviewed === true
    ? review.correctedFirstRecommendation ?? review.firstRecommendation ?? null : row.measurements?.firstRecommendation;
  if (!timing || !duration(timing.elapsedMs)) return { timing: null, issue: "first_card_timing_missing" };
  if (!["sse", "reviewed_sse_boundary", "manual_sse_boundary"].includes(timing.observedVia)) {
    return { timing: null, issue: "first_card_timing_not_exact" };
  }
  return { timing, issue: null };
}
function zeroResult(row, reviews = []) {
  const review = findTimingReview(row, reviews);
  const value = review?.reviewed === true ? review.noRecommendations : row?.measurements?.noRecommendations;
  return typeof value === "boolean" ? value : null;
}

/** Exploratory summary; formal release decisions use evaluateDiscoveryBenchmark.
 * Every planned cell survives missing runs, failures, zero cards and duplicates. */
export function buildDiscoveryExperimentSummary(results, caseIds, options = {}) {
  const applied = applyDiscoveryTimingReviews(results, options.timingReviews ?? []);
  results = applied.results;
  const planned = plan(caseIds, options), index = indexResults(results), reviews = applied.reviews;
  const plannedKeys = new Set(planned.cells.map(discoveryBenchmarkResultKey));
  const duplicateCells = [...index.byKey].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ key, count: rows.length }));
  const runCounts = new Map();
  for (const row of results) if (row.runId) runCounts.set(row.runId, (runCounts.get(row.runId) ?? 0) + 1);
  const duplicateRunIds = [...runCounts].filter(([, count]) => count > 1).map(([runId, count]) => ({ runId, count }));
  const unplannedKeys = [...index.byKey.keys()].filter(key => !plannedKeys.has(key));
  const cells = planned.cells.map(identity => {
    const rows = index.byKey.get(discoveryBenchmarkResultKey(identity)) ?? [], row = rows.length === 1 ? rows[0] : undefined;
    return { ...identity, key: discoveryBenchmarkResultKey(identity), observationCount: rows.length,
      runId: row?.runId, status: rows.length > 1 ? "duplicate" : row?.status ?? (row ? row.passed ? "complete" : "failed" : "not-run"),
      passed: complete(row), error: row?.error, noRecommendations: zeroResult(row, reviews) };
  });
  const variants = Object.fromEntries(planned.variants.map(variant => {
    const group = planned.cells.filter(cell => cell.benchmarkVariant === variant);
    const rows = group.flatMap(cell => index.byKey.get(discoveryBenchmarkResultKey(cell)) ?? []), successes = rows.filter(complete);
    const recommendations = successes.filter(row => zeroResult(row, reviews) === false), none = successes.filter(row => zeroResult(row, reviews) === true);
    const auditRows = rows.map(row => row.usageAudit).filter(audit => audit?.status === "available");
    const sum = key => rows.some(row => runCounts.get(row.runId) > 1) || auditRows.length !== rows.length || auditRows.some(audit => typeof audit[key] !== "number" || !Number.isFinite(audit[key]))
      ? null : auditRows.reduce((total, audit) => total + audit[key], 0);
    const knownUsage = rows.filter(row => row.runId && runCounts.get(row.runId) === 1).map(row => row.usageAudit)
      .filter(audit => audit?.status === "available" && ["inputTokens", "cachedInputTokens", "outputTokens"].every(key => typeof audit[key] === "number" && Number.isFinite(audit[key])));
    const knownSum = key => !knownUsage.length || knownUsage.some(audit => typeof audit[key] !== "number" || !Number.isFinite(audit[key]))
      ? null : knownUsage.reduce((total, audit) => total + audit[key], 0);
    const inputTokens = sum("inputTokens"), cachedInputTokens = sum("cachedInputTokens");
    const first = recommendations.map(row => firstTiming(row, reviews, options.allowUnreviewedLegacy === true));
    return [variant, {
      scheduled: group.length, observed: rows.length, observedCells: group.filter(cell => index.byKey.has(discoveryBenchmarkResultKey(cell))).length, complete: successes.length,
      failed: rows.filter(row => !complete(row) && !notRun(row) && row.status !== "interrupted").length,
      interrupted: rows.filter(row => row.status === "interrupted").length,
      timeouts: rows.filter(row => !complete(row) && /TIMEOUT|TIMED_OUT|DEADLINE/u.test(String(row.error ?? "").toUpperCase())).length,
      timeoutRetryEvents: rows.reduce((total, row) => total + (row.resetEvents ?? []).filter(event => event.reason === "timeout").length, 0),
      notRun: group.filter(cell => !index.byKey.has(discoveryBenchmarkResultKey(cell)) || notRun(onlyRow(index, cell))
        && index.byKey.get(discoveryBenchmarkResultKey(cell))?.length === 1).length,
      remaining: group.filter(cell => !index.byKey.has(discoveryBenchmarkResultKey(cell))).length,
      duplicateCells: group.filter(cell => (index.byKey.get(discoveryBenchmarkResultKey(cell))?.length ?? 0) > 1).length,
      recommendationResults: recommendations.length, noRecommendationResults: none.length,
      unclassifiedSuccessfulResults: successes.length - recommendations.length - none.length,
      allObservedElapsed: summariseBenchmarkNumbers(rows.map(row => row.elapsedMs)),
      successfulComplete: summariseBenchmarkNumbers(successes.map(row => row.measurements?.completeAvailable?.elapsedMs ?? row.elapsedMs)),
      profile: summariseBenchmarkNumbers(successes.map(row => row.measurements?.profile?.elapsedMs)),
      firstRecommendationSse: summariseBenchmarkNumbers(first.map(value => value.timing?.elapsedMs)),
      firstRecommendationAnyObservation: summariseBenchmarkNumbers(recommendations.map(row => row.measurements?.firstRecommendation?.elapsedMs)),
      firstRecommendationSnapshotUpperBounds: recommendations.filter(row => row.measurements?.firstRecommendation?.observedVia === "snapshot_upper_bound").length,
      firstRecommendationTimingIssues: first.filter(value => value.issue).map(value => value.issue),
      noRecommendationAvailable: summariseBenchmarkNumbers(none.map(row => row.measurements?.noRecommendationAvailable?.elapsedMs)),
      structuralFailures: rows.filter(structuralFailure).length,
      automaticRetries: rows.reduce((total, row) => total + (row.resetEvents ?? []).filter(event => event.attempt === 2 && event.reason !== "withdrawn").length, 0),
      auditAvailable: auditRows.length, dispatchedModelCalls: sum("dispatchedCalls"), chargedMicros: sum("chargedMicros"),
      inputTokens, cachedInputTokens, outputTokens: sum("outputTokens"),
      cacheHitRate: inputTokens > 0 && cachedInputTokens !== null ? cachedInputTokens / inputTokens : null,
      knownUsageSubset: { runs: knownUsage.length, dispatchedModelCalls: knownSum("dispatchedCalls"), chargedMicros: knownSum("chargedMicros"),
        inputTokens: knownSum("inputTokens"), cachedInputTokens: knownSum("cachedInputTokens"), outputTokens: knownSum("outputTokens"),
        cacheHitRate: knownSum("inputTokens") > 0 ? knownSum("cachedInputTokens") / knownSum("inputTokens") : null },
    }];
  }));
  const pairs = planned.cells.filter(cell => cell.benchmarkVariant !== planned.baselineVariant).map(identity => {
    const baselineIdentity = { ...identity, benchmarkVariant: planned.baselineVariant };
    const baseline = onlyRow(index, baselineIdentity), candidate = onlyRow(index, identity);
    const baselineFirst = firstTiming(baseline, reviews, options.allowUnreviewedLegacy === true);
    const candidateFirst = firstTiming(candidate, reviews, options.allowUnreviewedLegacy === true);
    const duplicate = [baselineIdentity, identity].some(cell => (index.byKey.get(discoveryBenchmarkResultKey(cell))?.length ?? 0) > 1);
    const reason = duplicate ? "duplicate_observation" : !baseline || !candidate ? "not_both_observed"
      : !complete(baseline) || !complete(candidate) ? "delivery_failure"
        : zeroResult(baseline, reviews) === true || zeroResult(candidate, reviews) === true ? "no_recommendation_result"
          : baselineFirst.issue || candidateFirst.issue ? "timing_requires_review" : null;
    return { round: identity.round, caseId: identity.caseId, baselineVariant: planned.baselineVariant, candidateVariant: identity.benchmarkVariant,
      baselineRunId: baseline?.runId, candidateRunId: candidate?.runId, comparable: reason === null,
      ...(reason ? { excludedReason: reason } : {
        baselineFirstRecommendationMs: baselineFirst.timing.elapsedMs, candidateFirstRecommendationMs: candidateFirst.timing.elapsedMs,
        firstRecommendationDeltaMs: candidateFirst.timing.elapsedMs - baselineFirst.timing.elapsedMs,
        completeDeltaMs: (candidate.measurements?.completeAvailable?.elapsedMs ?? candidate.elapsedMs)
          - (baseline.measurements?.completeAvailable?.elapsedMs ?? baseline.elapsedMs),
      }) };
  });
  return { schemaVersion: "saitu.discovery-experiment-summary.v1", rounds: planned.rounds, startRound: planned.startRound,
    baselineVariant: planned.baselineVariant, selectedVariants: planned.variants, variants, cells, pairs,
    duplicateCells, duplicateRunIds, unplannedKeys, invalidRows: index.invalidRows, timingReviewIssues: applied.issues,
    pairedFirstRecommendationDelta: summariseBenchmarkNumbers(pairs.filter(pair => pair.comparable).map(pair => pair.firstRecommendationDeltaMs)),
    notes: ["Planned cells are keyed by round, caseId and benchmarkVariant; public presentationVersion does not identify experimental arms.",
      "This descriptive summary is not a release decision and never replaces the fixed-sample acceptance gate.",
      "Manual legacy boundaries are required unless an explicitly exploratory compatibility caller permits unreviewed timing.",
      "Failures, zero recommendations, not-run cells and duplicate observations remain visible. Unknown token usage remains null."],
  };
}

const median = values => summariseBenchmarkNumbers(values).medianMs;
function comparison(values) {
  const baseline = values.map(row => row.baseline), candidate = values.map(row => row.candidate);
  const b = median(baseline), c = median(candidate);
  return { count: values.length, baseline: summariseBenchmarkNumbers(baseline), candidate: summariseBenchmarkNumbers(candidate),
    medianRatio: b > 0 && c !== null ? c / b : null, medianSavingsMs: b !== null && c !== null ? b - c : null,
    pairedDifference: summariseBenchmarkNumbers(values.map(row => row.candidate - row.baseline)),
    penalizedPairs: values.filter(row => row.baselinePenalized || row.candidatePenalized).length };
}
function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability, lower = Math.floor(position), fraction = position - lower;
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * fraction;
}

/** Resample whole profiles, retaining all rounds and both members of each pair.
 * Repeated rounds are not treated as independent student-profile clusters. */
export function bootstrapDiscoveryPairs(pairs, options = {}) {
  const iterations = options.iterations ?? DISCOVERY_BENCHMARK_DEFAULTS.bootstrapIterations;
  const seed = options.seed ?? DISCOVERY_BENCHMARK_DEFAULTS.bootstrapSeed;
  if (!positiveInteger(iterations) || !Number.isSafeInteger(seed)) throw new Error("BENCHMARK_BOOTSTRAP_INVALID");
  const groups = new Map();
  for (const pair of pairs) {
    if (!label(pair.caseId) || !duration(pair.baseline) || !duration(pair.candidate)) throw new Error("BENCHMARK_BOOTSTRAP_PAIR_INVALID");
    groups.set(pair.caseId, [...(groups.get(pair.caseId) ?? []), pair]);
  }
  const clusters = [...groups.values()], ratios = [], savings = [];
  if (!clusters.length) return { method: "paired-profile-cluster-percentile", clusterCount: 0, pairCount: 0, iterations, seed, confidence: 0.95, medianRatio: null, medianSavingsMs: null };
  const random = randomGenerator(seed);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    for (let cluster = 0; cluster < clusters.length; cluster += 1) sample.push(...clusters[Math.floor(random() * clusters.length)]);
    const b = median(sample.map(row => row.baseline)), c = median(sample.map(row => row.candidate));
    ratios.push(c / b); savings.push(b - c);
  }
  ratios.sort((a, b) => a - b); savings.sort((a, b) => a - b);
  return { method: "paired-profile-cluster-percentile", clusterCount: clusters.length, pairCount: pairs.length, iterations, seed, confidence: 0.95,
    medianRatio: { lower: quantile(ratios, 0.025), upper: quantile(ratios, 0.975) },
    medianSavingsMs: { lower: quantile(savings, 0.025), upper: quantile(savings, 0.975) } };
}

const gate = (status, reasons = [], extra = {}) => ({ status, reasons, ...extra });
function qualityGate(quality, pairedRows) {
  if (!quality) return gate("pending", ["quality_review_missing"]);
  if (quality.noRegression === false || quality.blinded === false) return gate("fail", ["quality_regression_or_unblinded_review"]);
  const reviews = Array.isArray(quality.rows) ? quality.rows : [];
  const issues = [], pending = [];
  if (reviews.some(review => !pairedRows.some(pair => pair.round === review.round && pair.caseId === review.caseId))) issues.push("unplanned_quality_review");
  for (const pair of pairedRows) {
    const found = reviews.filter(row => row.round === pair.round && row.caseId === pair.caseId);
    if (found.length > 1) { issues.push("duplicate_quality_review"); continue; }
    const row = found[0];
    if (!row || row.reviewed !== true) { pending.push("quality_rows_incomplete"); continue; }
    if (row.criticalErrors !== undefined && (!Number.isSafeInteger(row.criticalErrors) || row.criticalErrors < 0)) issues.push("quality_review_invalid");
    if (row.noRegression === false || Number(row.criticalErrors ?? 0) > 0) issues.push("quality_regression");
    if (row.noRegression !== true) pending.push("quality_verdict_missing");
    if (!row.baselineRunId || !row.candidateRunId) pending.push("quality_run_binding_missing");
    if (row.baselineRunId && row.baselineRunId !== pair.baselineRunId || row.candidateRunId && row.candidateRunId !== pair.candidateRunId) issues.push("quality_review_run_mismatch");
  }
  if (issues.length) return gate("fail", [...new Set(issues)]);
  if (quality.complete !== true || quality.noRegression !== true || quality.blinded !== true || pending.length) return gate("pending", [...new Set([...pending, "quality_review_not_complete"])]);
  return gate("pass", [], { reviewedPairs: pairedRows.length });
}

/** Formal 3x15 acceptance. Missing/failed required cards and failed reports get
 * a 180s value for fixed-denominator summaries AND prevent acceptance. */
export function evaluateDiscoveryBenchmark(results, options) {
  const applied = applyDiscoveryTimingReviews(results, options.timingReviews ?? []);
  results = applied.results;
  const cases = options.cases ?? [], caseIds = cases.map(value => value.caseId);
  const rounds = options.rounds ?? 3, startRound = options.startRound ?? 1, deadlineMs = options.deadlineMs ?? 180_000;
  if (!label(options.baselineVariant) || !label(options.candidateVariant) || options.baselineVariant === options.candidateVariant
    || cases.some(value => !["required", "optional", "none"].includes(value.cardExpectation)) || !duration(deadlineMs)) throw new Error("BENCHMARK_ACCEPTANCE_OPTIONS_INVALID");
  const config = { rounds, startRound, baselineVariant: options.baselineVariant,
    variants: [options.baselineVariant, options.candidateVariant], timingReviews: applied.reviews };
  const summary = buildDiscoveryExperimentSummary(results, caseIds, config), planned = plan(caseIds, config), index = indexResults(results);
  const pairedRows = [], firstPairs = [], wholePairs = [], timingIssues = [], provenanceIssues = [];
  const frozenFields = ["productionBuildSourceSha256", "policySha256", "protocolSourceSha256", "fixturesSha256", "harnessSha256", "syntheticInputsSha256"];
  const frozenHashes = new Map(frozenFields.map(key => [key, new Set()])), catalogHashes = new Set(), inputHashesByCase = new Map();
  for (let round = startRound; round < startRound + rounds; round += 1) for (const expected of cases) {
    const identities = planned.variants.map(benchmarkVariant => ({ round, caseId: expected.caseId, benchmarkVariant }));
    const rows = identities.map(identity => onlyRow(index, identity));
    const item = { round, caseId: expected.caseId, cardExpectation: expected.cardExpectation,
      baselineRunId: rows[0]?.runId, candidateRunId: rows[1]?.runId, baselineStatus: rows[0]?.status ?? "not-run", candidateStatus: rows[1]?.status ?? "not-run" };
    const firstValues = [], wholeValues = [], firstValid = [];
    for (let role = 0; role < rows.length; role += 1) {
      const row = rows[role], identity = identities[role], first = firstTiming(row, config.timingReviews);
      const whole = row?.measurements?.completeAvailable;
      const wholeValid = row?.status === "complete" && complete(row) && duration(whole?.elapsedMs);
      wholeValues.push(wholeValid ? whole.elapsedMs : deadlineMs);
      if (!wholeValid) timingIssues.push({ ...identity, issue: !row ? "not_run" : !complete(row) ? "delivery_failure" : "whole_timing_missing" });
      if (expected.cardExpectation === "required") {
        const valid = row?.status === "complete" && complete(row) && Boolean(first.timing) && zeroResult(row, config.timingReviews) === false;
        firstValid.push(valid);
        firstValues.push(valid ? first.timing.elapsedMs : deadlineMs);
        if (!valid) timingIssues.push({ ...identity, issue: !row ? "not_run" : !complete(row) ? "delivery_failure" : first.issue ?? "required_card_missing" });
      }
      if (expected.cardExpectation === "none" && complete(row) && zeroResult(row, config.timingReviews) !== true) timingIssues.push({ ...identity, issue: "expected_zero_result_missing" });
      if (row) {
        const c = row.configuration;
        const source = c?.productionBuildSourceSha256, catalog = c?.catalog?.sha256, policy = c?.policySha256;
        if (frozenFields.some(key => !/^[a-f0-9]{64}$/u.test(c?.[key] ?? "")) || c?.runtimeBinding !== source
          || !/^[a-f0-9]{64}$/u.test(catalog ?? "") || !/^[a-f0-9]{64}$/u.test(policy ?? "")
          || c?.catalog?.count !== 135 || c?.model !== "deepseek-flash" || c?.initialEffort !== "high"
          || row.catalogSha256 !== catalog || !/^[a-f0-9]{64}$/u.test(row.inputSha256 ?? "")
          || row.protocolVersion !== identity.benchmarkVariant || row.status === undefined || typeof row.runId !== "string" || !row.runId) provenanceIssues.push({ ...identity, issue: "source_catalog_or_runtime_evidence_invalid" });
        for (const key of frozenFields) frozenHashes.get(key).add(c?.[key]);
        catalogHashes.add(catalog);
        const inputs = inputHashesByCase.get(expected.caseId) ?? new Set();
        inputs.add(row.inputSha256); inputHashesByCase.set(expected.caseId, inputs);
      }
    }
    wholePairs.push({ ...item, baseline: wholeValues[0], candidate: wholeValues[1],
      baselinePenalized: rows[0]?.status !== "complete" || !complete(rows[0]) || !duration(rows[0]?.measurements?.completeAvailable?.elapsedMs),
      candidatePenalized: rows[1]?.status !== "complete" || !complete(rows[1]) || !duration(rows[1]?.measurements?.completeAvailable?.elapsedMs) });
    if (expected.cardExpectation === "required") firstPairs.push({ ...item, baseline: firstValues[0], candidate: firstValues[1],
      baselinePenalized: !firstValid[0], candidatePenalized: !firstValid[1] });
    pairedRows.push(item);
  }
  if ([...frozenHashes.values(), catalogHashes].some(hashes => hashes.size > 1)) provenanceIssues.push({ issue: "mixed_source_catalog_policy_or_harness" });
  if ([...inputHashesByCase.values()].some(hashes => hashes.size > 1)) provenanceIssues.push({ issue: "input_changed_between_pairs_or_rounds" });
  const first = comparison(firstPairs), whole = comparison(wholePairs), candidate = summary.variants[options.candidateVariant], baseline = summary.variants[options.baselineVariant];
  const expectedPairs = cases.length * rounds, missing = summary.cells.some(cell => cell.observationCount === 0 || cell.status === "not-run");
  const hardTimingIssues = timingIssues.filter(issue => !["not_run", "legacy_manual_review_required"].includes(issue.issue));
  const reviewPending = timingIssues.some(issue => issue.issue === "legacy_manual_review_required");
  const dataReady = !missing && !summary.duplicateCells.length && !summary.duplicateRunIds.length && !summary.unplannedKeys.length && !summary.invalidRows.length;
  const timingsReady = dataReady && !timingIssues.length && !applied.issues.length;
  const bootstrap = timingsReady ? {
    firstCard: bootstrapDiscoveryPairs(firstPairs, options.bootstrap),
    whole: bootstrapDiscoveryPairs(wholePairs, { ...options.bootstrap, seed: (options.bootstrap?.seed ?? DISCOVERY_BENCHMARK_DEFAULTS.bootstrapSeed) + 1 }),
  } : { firstCard: null, whole: null };
  const speedGate = passed => !dataReady ? gate("pending", ["observations_incomplete"])
    : !timingsReady ? gate(hardTimingIssues.length || applied.issues.length ? "fail" : "pending", ["timing_evidence_incomplete"]) : gate(passed ? "pass" : "fail");
  const gates = {
    planShape: gate(cases.length === 15 && rounds === 3 && expectedPairs === 45 && deadlineMs === 180_000
      && cases.filter(value => value.cardExpectation === "required").length === 11
      && cases.filter(value => value.cardExpectation === "optional").every(value => DISCOVERY_OPTIONAL_CARD_CASE_IDS.includes(value.caseId))
      && DISCOVERY_OPTIONAL_CARD_CASE_IDS.every(id => cases.some(value => value.caseId === id && value.cardExpectation === "optional")) ? "pass" : "fail", [], { expectedCandidateReports: 45 }),
    uniqueObservations: summary.duplicateCells.length || summary.duplicateRunIds.length || summary.unplannedKeys.length || summary.invalidRows.length ? gate("fail", ["duplicate_unplanned_or_invalid_observations"])
      : gate(missing ? "pending" : "pass", missing ? ["planned_observations_missing"] : []),
    frozenSourceAndRuntime: gate(provenanceIssues.length ? "fail" : missing ? "pending" : "pass", [...new Set(provenanceIssues.map(issue => issue.issue))]),
    candidateComplete: candidate.failed || candidate.interrupted ? gate("fail", ["candidate_delivery_failure"])
      : gate(candidate.complete === 45 ? "pass" : "pending", candidate.complete === 45 ? [] : ["candidate_reports_incomplete"], { actual: candidate.complete, required: 45 }),
    deliveryRateNonRegression: gate(missing ? "pending" : candidate.complete >= baseline.complete ? "pass" : "fail"),
    zeroStructuralFailures: gate(candidate.structuralFailures ? "fail" : missing ? "pending" : "pass", [], { actual: candidate.structuralFailures }),
    completeTimingEvidence: gate(hardTimingIssues.length || applied.issues.length ? "fail" : missing || reviewPending ? "pending" : "pass",
      [...new Set([...timingIssues.map(issue => issue.issue), ...applied.issues.map(issue => issue.code)])]),
    firstCardMedianReduction: speedGate(first.medianRatio !== null && first.medianRatio <= 0.75),
    firstCardAbsoluteSavings: speedGate(first.medianSavingsMs !== null && first.medianSavingsMs >= 10_000),
    wholeMedianReduction: speedGate(whole.medianRatio !== null && whole.medianRatio <= 0.85),
    p90NonRegression: speedGate(first.candidate.p90Ms <= first.baseline.p90Ms && whole.candidate.p90Ms <= whole.baseline.p90Ms),
    bootstrapSupportsSpeedup: !timingsReady ? gate("pending", ["timing_evidence_incomplete"])
      : gate(bootstrap.firstCard?.medianRatio?.upper < 1 && bootstrap.whole?.medianRatio?.upper < 1 ? "pass" : "fail"),
    qualityReview: qualityGate(options.quality, pairedRows),
  };
  const statuses = Object.values(gates).map(value => value.status);
  return { schemaVersion: "saitu.discovery-benchmark-acceptance.v1", status: statuses.includes("fail") ? "failed" : statuses.includes("pending") ? "pending" : "passed",
    decision: statuses.every(value => value === "pass") ? "ready_for_release" : "hold",
    configuration: { baselineVariant: options.baselineVariant, candidateVariant: options.candidateVariant, rounds, startRound, cases, deadlineMs,
      thresholds: DISCOVERY_BENCHMARK_DEFAULTS }, gates, summary, metrics: { firstCard: first, whole }, bootstrap,
    pairedRows, firstCardPairs: firstPairs, wholePairs, timingIssues, timingReviewIssues: applied.issues, provenanceIssues,
    notes: ["The first-card cohort is predeclared by cardExpectation, never selected from successful outputs after testing.",
      "Optional/no-card cases remain in whole-report, delivery, quality and billing counts. Missing/failed required timings receive 180s and prevent acceptance.",
      "Point estimates must meet 25% plus 10s for first complete card and 15% for complete report. CI only needs to support genuine speedup (upper ratio < 1).",
      "Bootstrap resamples profile clusters, retaining all three paired rounds. It does not treat 45 calls as 45 independent profiles.",
      "Passing sampled gates is not proof of population failure rate or a guarantee about every future request."],
  };
}
