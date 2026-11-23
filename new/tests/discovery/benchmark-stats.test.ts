import { describe, expect, it } from "vitest";
import { DISCOVERY_ACCEPTANCE_PROFILES } from "./fixtures";
import {
  applyDiscoveryTimingReviews, bootstrapDiscoveryPairs, buildDiscoveryExperimentSummary,
  DISCOVERY_OPTIONAL_CARD_CASE_IDS, discoveryBenchmarkResultKey, evaluateDiscoveryBenchmark, summariseBenchmarkNumbers,
  type BenchmarkAcceptanceOptions, type BenchmarkResult, type BenchmarkTimingReview,
} from "../../scripts/competitions/discovery/benchmark-stats.mjs";

const prefix = "# 用户画像\n\n";
const item = "### 1. 甲竞赛\n全部任务、个人匹配理由、缺口与来源。\n\n";
const next = "### 2. 乙竞赛\n";
const suffix = "第二项的全部信息。\n";
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const configuration = {
  productionBuildSourceSha256: "a".repeat(64), runtimeBinding: "a".repeat(64),
  policySha256: "b".repeat(64), protocolSourceSha256: "c".repeat(64), fixturesSha256: "d".repeat(64),
  harnessSha256: "e".repeat(64), syntheticInputsSha256: "f".repeat(64),
  model: "deepseek-flash", initialEffort: "high", catalog: { count: 135, sha256: "0".repeat(64) },
};

function observation(caseId: string, round: number, variant: string, first: number, whole: number, noResult = false): BenchmarkResult {
  const baseline = variant === "legacy";
  const segments = noResult ? ["暂无可靠推荐。\n"] : [prefix, item + "### 2.", " 乙竞赛\n", suffix];
  let text = "";
  const timeline = segments.map((delta, index) => {
    text += delta;
    return { seq: index + 1, attempt: 1, delta, elapsedMs: index === 0 ? first - 2000 : index === 1 ? first - 1000 : index === 2 ? first : whole - 500,
      reportElapsedMs: index === 0 ? first - 2010 : index === 1 ? first - 1010 : index === 2 ? first - 10 : whole - 510,
      cumulativeUtf8Bytes: bytes(text) };
  });
  return { caseId, round, benchmarkVariant: variant, protocolVersion: variant,
    presentationVersion: baseline ? "legacy" : "discovery-cards.v1", runId: `${caseId}.${round}.${variant}`,
    status: "complete", passed: true, elapsedMs: whole + 500,
    inputSha256: String(DISCOVERY_ACCEPTANCE_PROFILES.findIndex(profile => profile.id === caseId) + 1).padStart(64, "0"),
    catalogSha256: configuration.catalog.sha256, configuration: structuredClone(configuration),
    report: { markdown: noResult ? segments.join("") : prefix + item + next + suffix },
    measurements: { attempt: 1, noRecommendations: noResult,
      profile: { elapsedMs: first - 2000, observedVia: "sse" },
      // Deliberately wrong automated legacy boundary. Only the reviewed stream
      // section may supply the formal baseline timing.
      firstRecommendation: noResult ? null : { elapsedMs: baseline ? 500 : first, observedVia: "sse" },
      completeAvailable: { elapsedMs: whole, observedVia: "sse_terminal" },
      textTimeline: [...timeline, { seq: timeline.length + 1, attempt: 1, elapsedMs: whole, reportElapsedMs: whole - 10, terminal: "complete" }],
    } };
}

function timingReview(row: BenchmarkResult): BenchmarkTimingReview {
  return { runId: row.runId!, reviewed: true, noRecommendations: row.measurements!.noRecommendations === true,
    ...(row.measurements!.noRecommendations ? { correctedFirstRecommendation: null } : {
      measuredCompetitionTitle: "甲竞赛", startUtf8Bytes: bytes(prefix),
      sectionEndExclusiveUtf8Bytes: bytes(prefix + item), recognitionEndExclusiveUtf8Bytes: bytes(prefix + item + next),
      correctedFirstRecommendation: { elapsedMs: row.measurements!.textTimeline![2].elapsedMs!,
        reportElapsedMs: row.measurements!.textTimeline![2].reportElapsedMs, seq: 3, observedVia: "reviewed_sse_boundary" },
    }) };
}

function fixture(firstBaseline = 100_000, firstCandidate = 70_000, wholeBaseline = 120_000, wholeCandidate = 90_000) {
  const cases = DISCOVERY_ACCEPTANCE_PROFILES.map(profile => ({ caseId: profile.id,
    cardExpectation: DISCOVERY_OPTIONAL_CARD_CASE_IDS.includes(profile.id) ? "optional" as const : "required" as const }));
  const rows = [1, 2, 3].flatMap(round => cases.flatMap(({ caseId, cardExpectation }) => [
    observation(caseId, round, "legacy", firstBaseline, wholeBaseline, cardExpectation === "optional"),
    observation(caseId, round, "blocks", firstCandidate, wholeCandidate, cardExpectation === "optional"),
  ]));
  const reviews = rows.filter(row => row.benchmarkVariant === "legacy").map(timingReview);
  const qualityRows = rows.filter(row => row.benchmarkVariant === "legacy").map(row => ({ round: row.round!, caseId: row.caseId,
    reviewed: true, noRegression: true, criticalErrors: 0, baselineRunId: row.runId!, candidateRunId: `${row.caseId}.${row.round}.blocks` }));
  const options: BenchmarkAcceptanceOptions = { baselineVariant: "legacy", candidateVariant: "blocks", rounds: 3, cases,
    bootstrap: { iterations: 300, seed: 17 }, timingReviews: reviews,
    quality: { complete: true, blinded: true, noRegression: true, rows: qualityRows } };
  return { rows, reviews, options };
}

describe("experiment identities and planned cells", () => {
  it("reports nearest-rank P95 and maximum without changing the P90 gate", () => {
    expect(summariseBenchmarkNumbers(Array.from({ length: 20 }, (_, index) => index + 1)))
      .toMatchObject({ count: 20, medianMs: 10.5, p90Ms: 18, p95Ms: 19, maxMs: 20 });
    expect(summariseBenchmarkNumbers([null, undefined])).toMatchObject({ count: 0, p90Ms: null, p95Ms: null, maxMs: null });
    const { rows, options } = fixture();
    expect(Object.keys(evaluateDiscoveryBenchmark(rows, options).gates)).not.toContain("p95NonRegression");
  });

  it("separates round and protocol variants sharing one public presentation schema", () => {
    const row = { caseId: "same", round: 1, benchmarkVariant: "blocks", presentationVersion: "discovery-cards.v1" };
    expect(discoveryBenchmarkResultKey(row)).toBe('[1,"same","blocks"]');
    expect(discoveryBenchmarkResultKey({ ...row, round: 2 })).not.toBe(discoveryBenchmarkResultKey(row));
    expect(discoveryBenchmarkResultKey({ ...row, benchmarkVariant: "refs" })).not.toBe(discoveryBenchmarkResultKey(row));
    expect(() => discoveryBenchmarkResultKey({ ...row, round: 0 })).toThrow("IDENTITY_INVALID");
  });

  it("supports a single-arm pilot and preserves an explicit startRound", () => {
    const summary = buildDiscoveryExperimentSummary([], ["one"], { variants: ["refs"], rounds: 2, startRound: 3 });
    expect(summary.cells.map(cell => [cell.round, cell.status])).toEqual([[3, "not-run"], [4, "not-run"]]);
    expect(summary.pairs).toEqual([]);
    expect(summary.variants.refs).toMatchObject({ scheduled: 2, observed: 0, notRun: 2 });
  });

  it("does not silently choose one duplicate or match a different round", () => {
    const { rows } = fixture();
    const one = rows[1], two = { ...one, round: 2, runId: "second", measurements: { ...one.measurements, firstRecommendation: { elapsedMs: 20_000, observedVia: "sse" } } };
    const summary = buildDiscoveryExperimentSummary([one, two, { ...two, runId: "duplicate" }], [one.caseId],
      { variants: ["legacy", "blocks"], rounds: 3 });
    expect(summary.cells).toHaveLength(6);
    expect(summary.cells.find(cell => cell.round === 2 && cell.benchmarkVariant === "blocks")).toMatchObject({ status: "duplicate", observationCount: 2 });
    expect(summary.variants.blocks).toMatchObject({ observed: 3, observedCells: 2, duplicateCells: 1, notRun: 1 });
    expect(summary.pairs.every(pair => !pair.comparable)).toBe(true);
  });

  it("retains failed, interrupted, zero-result and unknown-usage accounting separately", () => {
    const { rows } = fixture();
    const failures = [{ ...rows[0], passed: false, status: "failed", error: "invalid_output" },
      { ...rows[2], passed: false, status: "interrupted" }, rows.find(row => row.measurements?.noRecommendations)!];
    const ids = [...new Set(failures.map(row => row.caseId))];
    const summary = buildDiscoveryExperimentSummary(failures, ids, { variants: ["legacy"], rounds: 1 });
    expect(summary.variants.legacy).toMatchObject({ failed: 1, interrupted: 1, structuralFailures: 1, noRecommendationResults: 1,
      dispatchedModelCalls: null, chargedMicros: null, inputTokens: null });
  });

  it("keeps unknown usage unknown and labels the known cache subset explicitly", () => {
    const { rows } = fixture();
    const pair = [rows[1], rows[3]];
    pair[0].usageAudit = { status: "available", dispatchedCalls: 1, chargedMicros: 100, inputTokens: 1000, cachedInputTokens: 900, outputTokens: 50 };
    pair[1].usageAudit = { status: "available", dispatchedCalls: 1, chargedMicros: 500, inputTokens: null, cachedInputTokens: null, outputTokens: null };
    const summary = buildDiscoveryExperimentSummary(pair, pair.map(row => row.caseId), { variants: ["blocks"] });
    expect(summary.variants.blocks).toMatchObject({ dispatchedModelCalls: 2, chargedMicros: 600, inputTokens: null, cacheHitRate: null,
      knownUsageSubset: { runs: 1, inputTokens: 1000, cachedInputTokens: 900, cacheHitRate: 0.9, chargedMicros: 100 } });
  });

  it("reports terminal timeouts separately from a successful retry after a timeout", () => {
    const { rows } = fixture();
    const selected = [{ ...rows[1], passed: false, status: "failed", error: "DISCOVERY_TIMEOUT" },
      { ...rows[3], resetEvents: [{ attempt: 2, reason: "timeout" }] }];
    const result = buildDiscoveryExperimentSummary(selected, selected.map(row => row.caseId), { variants: ["blocks"] });
    expect(result.variants.blocks).toMatchObject({ complete: 1, failed: 1, timeouts: 1, timeoutRetryEvents: 1 });
  });
});

describe("manual legacy boundaries", () => {
  it("recomputes the full heading boundary rather than a partial heading or hand-entered time", () => {
    const { rows, reviews } = fixture();
    const row = rows[0], original = JSON.stringify(row);
    const applied = applyDiscoveryTimingReviews([row], { cases: [reviews[0]] });
    expect(applied.issues).toEqual([]);
    expect(applied.reviews[0].correctedFirstRecommendation).toMatchObject({ elapsedMs: 100_000, seq: 3,
      endUtf8Bytes: bytes(prefix + item), observedVia: "reviewed_sse_boundary" });
    expect(JSON.stringify(row)).toBe(original);
    expect(applyDiscoveryTimingReviews(applied.results, applied.reviews)).toEqual(applied);
    const bad = applyDiscoveryTimingReviews([row], [{ ...reviews[0], correctedFirstRecommendation: { elapsedMs: 99_000, observedVia: "sse" } }]);
    expect(bad.issues[0].code).toBe("timing_review_observed_time_mismatch");
  });

  it("binds historical run IDs without guessing the matching round or accepting wrong UTF8 offsets", () => {
    const { rows, reviews } = fixture();
    const row = rows[0];
    const normalized = applyDiscoveryTimingReviews(rows, { rows: [reviews[0]] });
    expect(normalized.reviews[0]).toMatchObject({ round: 1, caseId: row.caseId, benchmarkVariant: "legacy" });
    expect(applyDiscoveryTimingReviews(rows, [{ ...reviews[0], round: 2 }]).issues[0].code).toBe("timing_review_identity_mismatch");
    expect(applyDiscoveryTimingReviews([row], [{ ...reviews[0], startUtf8Bytes: 3 }]).issues[0].code).toBe("timing_review_byte_boundaries_invalid");
    expect(applyDiscoveryTimingReviews([{ ...row, runId: "other" }], [reviews[0]]).reviews).toEqual([]);
  });

  it("uses only the final attempt and rejects an inconsistent saved stream", () => {
    const { rows, reviews } = fixture();
    const row = structuredClone(rows[0]);
    row.measurements!.attempt = 2;
    row.measurements!.textTimeline = [
      { seq: 50, attempt: 1, delta: row.report!.markdown, elapsedMs: 5, cumulativeUtf8Bytes: bytes(row.report!.markdown!) },
      ...row.measurements!.textTimeline!.map(event => ({ ...event, attempt: 2 })),
    ];
    expect(applyDiscoveryTimingReviews([row], [reviews[0]]).reviews[0].correctedFirstRecommendation?.elapsedMs).toBe(100_000);
    row.report!.markdown = "完全不同的最终报告";
    expect(applyDiscoveryTimingReviews([row], [reviews[0]]).issues[0].code).toBe("timing_review_byte_boundaries_invalid");
  });

  it("closes a sole recommendation only at complete and remains idempotent after normalization", () => {
    const { rows } = fixture();
    const row = structuredClone(rows[0]), markdown = prefix + item;
    row.report!.markdown = markdown;
    row.measurements!.textTimeline = [
      { seq: 1, attempt: 1, delta: markdown, elapsedMs: 90_000, cumulativeUtf8Bytes: bytes(markdown) },
      { seq: 2, attempt: 1, terminal: "complete", elapsedMs: 120_000, reportElapsedMs: 119_990 },
    ];
    const review: BenchmarkTimingReview = { runId: row.runId!, reviewed: true, noRecommendations: false,
      startUtf8Bytes: bytes(prefix), sectionEndExclusiveUtf8Bytes: bytes(markdown), recognitionEndExclusiveUtf8Bytes: bytes(markdown),
      reviewedFirst: { elapsedMs: 120_000, observedVia: "sse", method: "successful_report_end" } };
    const applied = applyDiscoveryTimingReviews([row], [review]);
    expect(applied.issues).toEqual([]);
    expect(applied.reviews[0].boundaryKind).toBe("report_end");
    expect(applied.reviews[0].correctedFirstRecommendation?.elapsedMs).toBe(120_000);
    expect(applyDiscoveryTimingReviews(applied.results, applied.reviews)).toEqual(applied);
  });
});

describe("fixed-sample release gates", () => {
  it("passes the predeclared 45-report plan only with complete timings and blind quality evidence", () => {
    const { rows, options } = fixture();
    const result = evaluateDiscoveryBenchmark(rows, options);
    expect(result.status).toBe("passed");
    expect(result.decision).toBe("ready_for_release");
    expect(result.metrics.firstCard).toMatchObject({ count: 33, medianRatio: 0.7, medianSavingsMs: 30_000, penalizedPairs: 0 });
    expect(result.metrics.whole).toMatchObject({ count: 45, medianRatio: 0.75 });
    expect(result.bootstrap.firstCard).toMatchObject({ clusterCount: 11, pairCount: 33 });
    expect(result.bootstrap.whole).toMatchObject({ clusterCount: 15, pairCount: 45 });
    expect(result.summary.variants.blocks.noRecommendationResults).toBe(12);
  });

  it("holds for incomplete quality review or missing legacy manual boundary evidence", () => {
    const { rows, options } = fixture();
    const missingQuality = evaluateDiscoveryBenchmark(rows, { ...options, quality: undefined });
    expect(missingQuality.gates.qualityReview.status).toBe("pending");
    expect(missingQuality.status).toBe("pending");
    const missingTiming = evaluateDiscoveryBenchmark(rows, { ...options, timingReviews: [] });
    expect(missingTiming.decision).toBe("hold");
    expect(missingTiming.gates.completeTimingEvidence.status).toBe("pending");
    expect(missingTiming.metrics.firstCard.penalizedPairs).toBe(33);
    expect(missingTiming.bootstrap.firstCard).toBeNull();
  });

  it("requires both 25 percent and 10 seconds first-card savings, and 15 percent whole-report savings", () => {
    const small = fixture(20_000, 14_000);
    const short = evaluateDiscoveryBenchmark(small.rows, small.options);
    expect(short.gates.firstCardMedianReduction.status).toBe("pass");
    expect(short.gates.firstCardAbsoluteSavings.status).toBe("fail");
    const whole = fixture(100_000, 70_000, 120_000, 108_000);
    expect(evaluateDiscoveryBenchmark(whole.rows, whole.options).gates.wholeMedianReduction.status).toBe("fail");
  });

  it("rejects a slower P90 even when median speed passes", () => {
    const { rows, options } = fixture(70_000, 40_000);
    const slowIds = options.cases.filter(value => value.cardExpectation === "required").slice(0, 2).map(value => value.caseId);
    for (const row of rows) if (row.benchmarkVariant === "blocks" && slowIds.includes(row.caseId)) row.measurements!.firstRecommendation!.elapsedMs = 80_000;
    const result = evaluateDiscoveryBenchmark(rows, options);
    expect(result.gates.firstCardMedianReduction.status).toBe("pass");
    expect(result.gates.p90NonRegression.status).toBe("fail");
  });

  it("keeps failed and missing required cards in all planned denominators", () => {
    const { rows, options } = fixture();
    rows[1].passed = false; rows[1].status = "failed"; rows[1].error = "INVALID_OUTPUT";
    const result = evaluateDiscoveryBenchmark(rows, options);
    expect(result.metrics.firstCard.count).toBe(33);
    expect(result.metrics.whole.count).toBe(45);
    expect(result.firstCardPairs[0]).toMatchObject({ candidate: 180_000, candidatePenalized: true });
    expect(result.wholePairs[0]).toMatchObject({ candidate: 180_000, candidatePenalized: true });
    expect(result.gates.candidateComplete.status).toBe("fail");
    expect(result.gates.zeroStructuralFailures).toMatchObject({ status: "fail", actual: 1 });
    expect(result.decision).toBe("hold");
  });

  it("does not drop a zero-result required profile or invent a missing completion time", () => {
    const { rows, options } = fixture();
    rows[1].measurements!.noRecommendations = true;
    rows[1].measurements!.firstRecommendation = null;
    rows[3].measurements!.completeAvailable = null;
    const result = evaluateDiscoveryBenchmark(rows, options);
    expect(result.metrics.firstCard.penalizedPairs).toBe(1);
    expect(result.metrics.whole.penalizedPairs).toBe(1);
    expect(result.metrics.whole.count).toBe(45);
    expect(result.gates.completeTimingEvidence.status).toBe("fail");
  });

  it("preserves not-run observations and rejects duplicate/unplanned arms", () => {
    const { rows, options } = fixture();
    const incomplete = evaluateDiscoveryBenchmark(rows.slice(1), { ...options, timingReviews: [], quality: undefined });
    expect(incomplete.summary.cells).toHaveLength(90);
    expect(incomplete.summary.variants.legacy.notRun).toBe(1);
    expect(incomplete.metrics.whole.count).toBe(45);
    expect(incomplete.gates.uniqueObservations.status).toBe("pending");
    const duplicate = evaluateDiscoveryBenchmark([...rows, rows[0]], options);
    expect(duplicate.gates.uniqueObservations.status).toBe("fail");
    expect(duplicate.summary.duplicateCells).toHaveLength(1);
    const extra = evaluateDiscoveryBenchmark([...rows, { ...rows[1], benchmarkVariant: "refs" }], options);
    expect(extra.gates.uniqueObservations.status).toBe("fail");
    const copiedRun = rows.map((row, index) => index === 3 ? { ...row, runId: rows[1].runId } : row);
    const copied = evaluateDiscoveryBenchmark(copiedRun, options);
    expect(copied.gates.uniqueObservations.status).toBe("fail");
    expect(copied.summary.duplicateRunIds).toHaveLength(1);
  });

  it("detects changed source, input, model and protocol evidence", () => {
    const { rows, options } = fixture();
    rows[1].configuration!.model = "other-model";
    rows[3].inputSha256 = "9".repeat(64);
    rows[5].protocolVersion = "refs";
    const result = evaluateDiscoveryBenchmark(rows, options);
    expect(result.gates.frozenSourceAndRuntime.status).toBe("fail");
    expect(result.provenanceIssues.some(issue => issue.issue === "input_changed_between_pairs_or_rounds")).toBe(true);
  });

  it("holds when externally reviewed quality regresses or belongs to another run", () => {
    const { rows, options } = fixture();
    options.quality!.rows![0].noRegression = false;
    expect(evaluateDiscoveryBenchmark(rows, options).gates.qualityReview.status).toBe("fail");
    options.quality!.rows![0].noRegression = true;
    options.quality!.rows![0].candidateRunId = "different-run";
    expect(evaluateDiscoveryBenchmark(rows, options).gates.qualityReview.reasons).toContain("quality_review_run_mismatch");
  });

  it("requires CI evidence of genuine speedup without requiring the entire CI to clear 25 percent", () => {
    const { rows, options } = fixture(100_000, 70_000, 150_000, 120_000);
    const required = options.cases.filter(value => value.cardExpectation === "required").map(value => value.caseId);
    const values = [60, 61, 62, 63, 70, 74, 80, 84, 86, 90, 94];
    for (const row of rows) if (row.benchmarkVariant === "blocks" && required.includes(row.caseId)) row.measurements!.firstRecommendation!.elapsedMs = values[required.indexOf(row.caseId)] * 1000;
    options.bootstrap = { iterations: 1000, seed: 17 };
    const result = evaluateDiscoveryBenchmark(rows, options);
    expect(result.metrics.firstCard.medianRatio).toBe(0.74);
    expect(result.bootstrap.firstCard!.medianRatio!.upper).toBeGreaterThan(0.75);
    expect(result.bootstrap.firstCard!.medianRatio!.upper).toBeLessThan(1);
    expect(result.gates.bootstrapSupportsSpeedup.status).toBe("pass");
    expect(result.decision).toBe("ready_for_release");
  });
});

describe("paired profile-cluster bootstrap", () => {
  it("retains all rounds per resampled profile and is deterministic", () => {
    const pairs = Array.from({ length: 15 }, (_, profile) => [1, 2, 3].map(round => ({
      caseId: `case-${profile}`, round, baseline: 100 + profile, candidate: (100 + profile) * 0.7,
    }))).flat();
    const first = bootstrapDiscoveryPairs(pairs, { iterations: 500, seed: 99 });
    expect(first).toEqual(bootstrapDiscoveryPairs(pairs, { iterations: 500, seed: 99 }));
    expect(first).toMatchObject({ clusterCount: 15, pairCount: 45, confidence: 0.95 });
    expect(first.medianRatio!.lower).toBeCloseTo(0.7, 12);
    expect(first.medianRatio!.upper).toBeCloseTo(0.7, 12);
  });
});
