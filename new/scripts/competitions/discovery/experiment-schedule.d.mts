export type DiscoveryExperimentProtocol = "legacy" | "v16" | "rules" | "blocks" | "refs" | "json-optimized" | "blocks-optimized"
  | "blocks-flow" | "json-flat" | "blocks-flow-named" | "narrative" | "narrative-rules" | "narrative-index"
  | "markdown-v16" | "markdown-single" | "markdown-nested" | "markdown-late" | "markdown-grounded-scope";
export const DISCOVERY_EXPERIMENT_PROTOCOLS: readonly DiscoveryExperimentProtocol[];
export const DISCOVERY_INITIAL_SCREENING_PROTOCOLS: readonly DiscoveryExperimentProtocol[];
export const DISCOVERY_SCREENING_CASE_IDS: readonly string[];
export type DiscoveryExperimentJob<T extends { id: string } = { id: string }> = {
  profile: T; round: number; benchmarkVariant: DiscoveryExperimentProtocol;
  presentationVersion: "legacy" | "discovery-cards.v1";
  protocolVersion: Exclude<DiscoveryExperimentProtocol, "legacy"> | undefined;
};
export function discoveryExperimentProtocol(value: unknown): DiscoveryExperimentProtocol;
export function discoveryExperimentRound(value: unknown): number;
export function parseDiscoveryExperimentProtocols(value: string): DiscoveryExperimentProtocol[];
export function discoveryExperimentJobKey(input: { round: number; caseId: string; benchmarkVariant: string }): string;
export type DiscoveryExperimentShard = { index: number; count: number };
export function parseDiscoveryExperimentShard(value: string): DiscoveryExperimentShard;
export function partitionDiscoveryExperimentSchedule<T extends { id: string }>(jobs: readonly DiscoveryExperimentJob<T>[], profiles: readonly T[], shard?: DiscoveryExperimentShard): DiscoveryExperimentJob<T>[];
export function buildDiscoveryExperimentSchedule<T extends { id: string }>(profiles: readonly T[], variants: readonly string[], options?: { startRound?: number; rounds?: number }): DiscoveryExperimentJob<T>[];
export function discoveryExperimentResultFilename(job: DiscoveryExperimentJob, options?: { legacyFilenames?: boolean }): string;
