import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PreTrainedTokenizer } from "@huggingface/transformers";

/** Observed hosted limit applies to cumulative user content, not system data. */
export const DISCOVERY_HOSTED_INPUT_TOKEN_LIMIT = 32_768;
/** Official model context is 1M, conservatively interpreted as 1,000,000.
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * This is distinct from the observed 32K user-content validation limit. */
export const DISCOVERY_MODEL_CONTEXT_TOKEN_LIMIT = 1_000_000;
export const DISCOVERY_DEFAULT_OUTPUT_TOKEN_RESERVE = 131_072;
/** A conservative framing/server margin, not measured exact initial usage. */
export const DISCOVERY_INPUT_PROTOCOL_RESERVE = 2_048;
const TOKENIZER_SHA256 = "81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99";
let tokenizer: PreTrainedTokenizer | undefined;

function countTextTokens(text: string): number {
  if (!tokenizer) {
    const bytes = readFileSync(path.join(process.cwd(), "src/lib/competitions/discovery/assets/deepseek-v41-tokenizer.json"));
    if (createHash("sha256").update(bytes).digest("hex") !== TOKENIZER_SHA256) throw new Error("DISCOVERY_TOKENIZER_INTEGRITY");
    tokenizer = new PreTrainedTokenizer(JSON.parse(bytes.toString("utf8")), {});
  }
  return tokenizer.encode(text, { add_special_tokens: false }).length;
}

/** The tokenizer is bundled server-side; this performs no model/network call. */
export function countDiscoveryInputTokens(system: string, user: string): number {
  return countTextTokens(system) + countTextTokens(user);
}

export function assertDiscoveryInputBudget(system: string, user: string,
  maxOutputTokens = DISCOVERY_DEFAULT_OUTPUT_TOKEN_RESERVE): number {
  const userTokens = countTextTokens(user);
  if (userTokens + DISCOVERY_INPUT_PROTOCOL_RESERVE > DISCOVERY_HOSTED_INPUT_TOKEN_LIMIT) {
    throw Object.assign(new Error("DISCOVERY_CATALOG_CONTEXT_TOO_LARGE"), { code: "input_too_large", retryable: false, upstreamAttempted: false });
  }
  const inputTokens = countTextTokens(system) + userTokens;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1
    || inputTokens + DISCOVERY_INPUT_PROTOCOL_RESERVE + maxOutputTokens > DISCOVERY_MODEL_CONTEXT_TOKEN_LIMIT)
    throw Object.assign(new Error("DISCOVERY_CATALOG_CONTEXT_TOO_LARGE"), { code: "input_too_large", retryable: false, upstreamAttempted: false });
  return inputTokens;
}
