import type { BenchmarkAcceptance } from "./benchmark-stats.mjs";
export type BenchmarkAnalysisOptions = {
  directories: readonly string[]; planFile: string; timingReviewFiles?: readonly string[];
  qualityReviewFiles?: readonly string[]; outputFile?: string;
};
export function parseDiscoveryBenchmarkAnalysisArgs(args: readonly string[]): BenchmarkAnalysisOptions;
export function analyzeDiscoveryBenchmarkArtifacts(options: BenchmarkAnalysisOptions): Promise<BenchmarkAcceptance & {
  inputEvidence: { plan: { filename: string; sha256: string }; resultFiles: { filename: string; sha256: string }[];
    timingReviewFiles: { filename: string; sha256: string }[]; qualityFiles: { filename: string; sha256: string }[];
    ignoredFiles: string[]; actualResultRecords: number; analysis: string };
}>;
