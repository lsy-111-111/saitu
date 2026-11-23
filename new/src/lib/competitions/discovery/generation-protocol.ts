/** Internal generation wire formats. These are not questionnaire or public
 * presentation versions, and HTTP submissions cannot select an experiment. */
export const DISCOVERY_GENERATION_PROTOCOLS = [
  "v16", "rules", "blocks", "refs", "json-optimized", "blocks-optimized",
  "blocks-flow", "json-flat", "blocks-flow-named",
  "narrative", "narrative-rules", "narrative-index",
  "markdown-v16", "markdown-single", "markdown-nested", "markdown-late",
  "markdown-grounded-scope",
] as const;
export type DiscoveryGenerationProtocol = typeof DISCOVERY_GENERATION_PROTOCOLS[number];

// Cards have not passed the paired quality/performance rollout gate. Ordinary
// new reports retain Markdown; the private local harness can opt into cards,
// and saved card reports keep their own presentation version when recovered.
export const DEFAULT_DISCOVERY_PRESENTATION_VERSION: "legacy" | "discovery-cards.v1" = "legacy";

// A winner is selected only after the independent speed/quality acceptance.
export const DEFAULT_DISCOVERY_GENERATION_PROTOCOL: DiscoveryGenerationProtocol = "v16";

export function isDiscoveryGenerationProtocol(value: unknown): value is DiscoveryGenerationProtocol {
  return typeof value === "string" && DISCOVERY_GENERATION_PROTOCOLS.some(protocol => protocol === value);
}
