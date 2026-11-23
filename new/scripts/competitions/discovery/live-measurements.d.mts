import type { BenchmarkResult, BenchmarkVariantSummary, DiscoveryExperimentSummary, DiscoveryExperimentSummaryOptions } from "./benchmark-stats.mjs";
export { applyDiscoveryTimingReviews, buildDiscoveryExperimentSummary, bootstrapDiscoveryPairs,
  discoveryBenchmarkIdentity, discoveryBenchmarkResultKey, evaluateDiscoveryBenchmark } from "./benchmark-stats.mjs";
export const LEGACY_PRESENTATION: "legacy";
export const CARDS_PRESENTATION: "discovery-cards.v1";
export type LiveAt = { elapsedMs: number; reportElapsedMs: number | null };
export type LiveTiming = LiveAt & { observedVia: string; method?: string; cardKey?: string; startUtf8Bytes?: number; endUtf8Bytes?: number; title?: string };
export type LiveMeasurements = {
  schemaVersion: string; presentationVersion: string; attempt: number;
  profile: LiveTiming | null; firstRecommendation: LiveTiming | null; conclusion: LiveTiming | null;
  cardCount: number | null; noRecommendations: boolean | null;
  noRecommendationAvailable: LiveTiming | null; completeAvailable: LiveTiming | null;
  incompleteOrUnrecognisedRecommendationTiming: boolean;
  textTimeline: Record<string, unknown>[]; attemptHistory: Record<string, unknown>[]; review: string;
};
export type LiveRun = {
  status?: string; markdown?: string;
  presentation?: { profile?: unknown; cards?: { key?: string }[]; conclusion?: unknown };
};
export type NumberSummary = { count: number; medianMs: number | null; p90Ms: number | null; p95Ms: number | null; minMs: number | null; maxMs: number | null };
export function buildDiscoveryComparisonSchedule<T>(profiles: readonly T[]): { profile: T; presentationVersion: "legacy" | "discovery-cards.v1" }[];
export function detectLegacyContentBoundaries(markdown: string, terminal?: boolean): {
  noRecommendations: boolean; method: string; profileEndUtf8Bytes?: number;
  firstRecommendationStartUtf8Bytes?: number; firstRecommendationEndUtf8Bytes?: number | null; firstRecommendationTitle?: string;
};
export function createDiscoveryLiveMeasurements(presentationVersion: string): {
  text(delta: string, presentationRecord: { type: string; key?: string } | undefined, at: LiveAt, seq: number): void;
  reset(nextAttempt: number, at: LiveAt, seq: number): void;
  terminal(type: string, at: LiveAt, seq: number): void;
  finish(run: LiveRun | undefined, at: LiveAt): LiveMeasurements;
};
export function summariseNumbers(values: readonly (number | null | undefined)[]): NumberSummary;
export type LiveComparisonResult = BenchmarkResult & { presentationVersion: string; measurements?: LiveMeasurements };
export type VariantSummary = BenchmarkVariantSummary;
export function buildDiscoveryComparisonSummary(results: readonly LiveComparisonResult[], selectedCaseIds: readonly string[], options?: DiscoveryExperimentSummaryOptions): DiscoveryExperimentSummary;
