export const DISCOVERY_OPTIONAL_CARD_CASE_IDS: readonly string[];
export const DISCOVERY_BENCHMARK_DEFAULTS: Readonly<{
  rounds: 3; caseCount: 15; deadlineMs: 180000; firstCardRatio: 0.75;
  firstCardSavingsMs: 10000; wholeRatio: 0.85; p90Ratio: 1;
  bootstrapIterations: 10000; bootstrapSeed: 20261123; confidence: 0.95;
}>;
export type BenchmarkIdentity = { round: number; caseId: string; benchmarkVariant: string };
export type BenchmarkTiming = {
  elapsedMs: number; reportElapsedMs?: number | null; observedVia: string;
  seq?: number; method?: string; title?: string; startUtf8Bytes?: number; endUtf8Bytes?: number;
  recognitionEndExclusiveUtf8Bytes?: number; cumulativeUtf8Bytes?: number;
};
export type BenchmarkTimelineEvent = {
  seq?: number; attempt?: number; elapsedMs?: number; reportElapsedMs?: number | null;
  delta?: string; reset?: boolean; terminal?: string; cumulativeUtf8Bytes?: number;
};
export type BenchmarkMeasurements = {
  presentationVersion?: string; attempt?: number; profile?: BenchmarkTiming | null;
  firstRecommendation?: BenchmarkTiming | null; completeAvailable?: BenchmarkTiming | null;
  noRecommendationAvailable?: BenchmarkTiming | null; noRecommendations?: boolean | null;
  textTimeline?: readonly BenchmarkTimelineEvent[];
};
export type BenchmarkTimingReview = Partial<BenchmarkIdentity> & {
  runId: string; reviewed: boolean; evidenceValidated?: boolean; noRecommendations: boolean;
  correctedFirstRecommendation?: BenchmarkTiming | null; reviewedFirst?: BenchmarkTiming | null;
  firstRecommendation?: BenchmarkTiming | null; startUtf8Bytes?: number; endUtf8Bytes?: number;
  sectionEndExclusiveUtf8Bytes?: number; recognitionEndExclusiveUtf8Bytes?: number;
  measuredCompetitionTitle?: string; boundaryKind?: "report_end" | "following_section";
  [key: string]: unknown;
};
export type BenchmarkTimingReviewInput = readonly BenchmarkTimingReview[]
  | { cases: readonly BenchmarkTimingReview[] } | { rows: readonly BenchmarkTimingReview[] };
export type BenchmarkTimingReviewIssue = { index: number; runId?: string; code: string };
export type BenchmarkConfiguration = {
  productionBuildSourceSha256?: string | null; runtimeBinding?: string | null; policySha256?: string;
  protocolSourceSha256?: string; fixturesSha256?: string; harnessSha256?: string; syntheticInputsSha256?: string;
  model?: string; initialEffort?: string; catalog?: { sha256?: string; count?: number };
};
export type BenchmarkResult = {
  caseId: string; round?: number; benchmarkVariant?: string; presentationVersion?: string;
  runId?: string; passed: boolean; elapsedMs: number; status?: string; error?: string;
  protocolVersion?: string | null; inputSha256?: string; catalogSha256?: string | null;
  measurements?: BenchmarkMeasurements; configuration?: BenchmarkConfiguration;
  report?: { markdown?: string }; markdown?: string; timingReview?: BenchmarkTimingReview;
  structuralFailure?: boolean; resetEvents?: readonly { attempt?: number; reason?: string }[];
  usageAudit?: { status: string; dispatchedCalls?: number; chargedMicros?: number | null;
    inputTokens?: number | null; cachedInputTokens?: number | null; outputTokens?: number | null };
};
export type BenchmarkNumberSummary = {
  count: number; medianMs: number | null; p90Ms: number | null; p95Ms: number | null; minMs: number | null; maxMs: number | null;
};
export type BenchmarkVariantSummary = {
  scheduled: number; observed: number; observedCells: number; complete: number; failed: number; interrupted: number; timeouts: number; timeoutRetryEvents: number;
  notRun: number; remaining: number; duplicateCells: number; recommendationResults: number;
  noRecommendationResults: number; unclassifiedSuccessfulResults: number;
  allObservedElapsed: BenchmarkNumberSummary; successfulComplete: BenchmarkNumberSummary; profile: BenchmarkNumberSummary;
  firstRecommendationSse: BenchmarkNumberSummary; firstRecommendationAnyObservation: BenchmarkNumberSummary;
  firstRecommendationSnapshotUpperBounds: number; firstRecommendationTimingIssues: string[];
  noRecommendationAvailable: BenchmarkNumberSummary; structuralFailures: number; automaticRetries: number;
  auditAvailable: number; dispatchedModelCalls: number | null; chargedMicros: number | null;
  inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null;
  cacheHitRate: number | null;
  knownUsageSubset: { runs: number; dispatchedModelCalls: number | null; chargedMicros: number | null;
    inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; cacheHitRate: number | null };
};
export type DiscoveryExperimentSummaryOptions = {
  variants?: readonly string[]; rounds?: number; startRound?: number; baselineVariant?: string;
  timingReviews?: BenchmarkTimingReviewInput;
  allowUnreviewedLegacy?: boolean;
};
export type BenchmarkPairSummary = {
  round: number; caseId: string; baselineVariant: string; candidateVariant: string;
  baselineRunId?: string; candidateRunId?: string; comparable: boolean; excludedReason?: string;
  baselineFirstRecommendationMs?: number; candidateFirstRecommendationMs?: number;
  firstRecommendationDeltaMs?: number; completeDeltaMs?: number;
};
export type DiscoveryExperimentSummary = {
  schemaVersion: string; rounds: number; startRound: number; baselineVariant: string; selectedVariants: string[];
  variants: Record<string, BenchmarkVariantSummary>;
  cells: (BenchmarkIdentity & { key: string; observationCount: number; runId?: string; status: string;
    passed: boolean; error?: string; noRecommendations: boolean | null })[];
  pairs: BenchmarkPairSummary[]; duplicateCells: { key: string; count: number }[]; duplicateRunIds: { runId: string; count: number }[];
  unplannedKeys: string[]; invalidRows: { index: number; code: string }[];
  timingReviewIssues: BenchmarkTimingReviewIssue[]; pairedFirstRecommendationDelta: BenchmarkNumberSummary; notes: string[];
};
export function discoveryBenchmarkIdentity(row: Partial<BenchmarkResult>): BenchmarkIdentity;
export function discoveryBenchmarkResultKey(row: Partial<BenchmarkResult>): string;
export function summariseBenchmarkNumbers(values: readonly (number | null | undefined)[]): BenchmarkNumberSummary;
export function applyDiscoveryTimingReviews<T extends BenchmarkResult>(results: readonly T[], reviews?: BenchmarkTimingReviewInput): {
  results: (T & { timingReview?: BenchmarkTimingReview })[]; reviews: BenchmarkTimingReview[]; issues: BenchmarkTimingReviewIssue[];
};
export function buildDiscoveryExperimentSummary(results: readonly BenchmarkResult[], caseIds: readonly string[], options?: DiscoveryExperimentSummaryOptions): DiscoveryExperimentSummary;
export type BootstrapOptions = { iterations?: number; seed?: number };
export type BenchmarkNumericPair = { caseId: string; baseline: number; candidate: number; round?: number;
  baselinePenalized?: boolean; candidatePenalized?: boolean };
export type BenchmarkBootstrap = {
  method: string; clusterCount: number; pairCount: number; iterations: number; seed: number; confidence: number;
  medianRatio: { lower: number; upper: number } | null; medianSavingsMs: { lower: number; upper: number } | null;
};
export function bootstrapDiscoveryPairs(pairs: readonly BenchmarkNumericPair[], options?: BootstrapOptions): BenchmarkBootstrap;
export type BenchmarkQualityReview = {
  complete?: boolean; blinded?: boolean; noRegression?: boolean;
  rows?: readonly { round: number; caseId: string; reviewed: boolean; noRegression?: boolean;
    criticalErrors?: number; baselineRunId?: string; candidateRunId?: string }[];
};
export type BenchmarkAcceptanceOptions = {
  baselineVariant: string; candidateVariant: string; rounds?: number; startRound?: number; deadlineMs?: number;
  cases: readonly { caseId: string; cardExpectation: "required" | "optional" | "none" }[];
  bootstrap?: BootstrapOptions; timingReviews?: BenchmarkTimingReviewInput; quality?: BenchmarkQualityReview;
};
export type BenchmarkGate = { status: "pass" | "fail" | "pending"; reasons: string[]; [key: string]: unknown };
export type BenchmarkComparison = {
  count: number; baseline: BenchmarkNumberSummary; candidate: BenchmarkNumberSummary;
  medianRatio: number | null; medianSavingsMs: number | null; pairedDifference: BenchmarkNumberSummary; penalizedPairs: number;
};
export type BenchmarkPairedRow = { round: number; caseId: string; cardExpectation: string;
  baselineRunId?: string; candidateRunId?: string; baselineStatus: string; candidateStatus: string };
export type BenchmarkAcceptance = {
  schemaVersion: string; status: "failed" | "pending" | "passed"; decision: "ready_for_release" | "hold";
  configuration: BenchmarkAcceptanceOptions & { thresholds: typeof DISCOVERY_BENCHMARK_DEFAULTS };
  gates: Record<string, BenchmarkGate>; summary: DiscoveryExperimentSummary;
  metrics: { firstCard: BenchmarkComparison; whole: BenchmarkComparison };
  bootstrap: { firstCard: BenchmarkBootstrap | null; whole: BenchmarkBootstrap | null };
  pairedRows: BenchmarkPairedRow[]; firstCardPairs: (BenchmarkNumericPair & BenchmarkPairedRow)[];
  wholePairs: (BenchmarkNumericPair & BenchmarkPairedRow)[];
  timingIssues: (BenchmarkIdentity & { issue: string })[];
  timingReviewIssues: BenchmarkTimingReviewIssue[]; provenanceIssues: (Partial<BenchmarkIdentity> & { issue: string })[];
  notes: string[];
};
export function evaluateDiscoveryBenchmark(results: readonly BenchmarkResult[], options: BenchmarkAcceptanceOptions): BenchmarkAcceptance;
