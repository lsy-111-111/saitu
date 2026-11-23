import type { DiscoveryAnswers, DiscoveryFollowupAnswer, DiscoveryFollowupQuestion } from "./contracts";

export { DISCOVERY_RETENTION_MS, DISCOVERY_REPORT_DEADLINE_MS } from "./contracts";
export type DiscoverySource = { url: string; title: string };
export type DiscoveryCatalogSnapshot = {
  version: string; count: number; ids: string[]; sha256: string; text: string; clarifyText: string; byteLength: number;
};
export type DiscoveryRunStatus = "queued" | "running" | "complete" | "failed" | "cancelled" | "superseded" | "deleted" | "expired";
export type DiscoveryClarificationStatus = "pending" | "running" | "complete" | "failed" | "skipped";
/** Fixed local classifications only. Provider messages and payloads must never
 * become event metadata, even when an unexpected error reports retryable=true. */
export const DISCOVERY_RESET_FAILURE_CODES = [
  "rate_limited", "upstream_server_error", "network_error", "stream_incomplete",
  "timeout", "delivery_error", "DISCOVERY_TIMEOUT", "DISCOVERY_CALL_DEADLINE", "unknown_retryable_error",
] as const;
export type DiscoveryResetFailureCode = typeof DISCOVERY_RESET_FAILURE_CODES[number];
export function safeDiscoveryResetFailureCode(value: unknown): DiscoveryResetFailureCode {
  return DISCOVERY_RESET_FAILURE_CODES.find(code => code === value) ?? "unknown_retryable_error";
}
export type DiscoveryEventPayload =
  | { type: "text"; delta: string }
  | { type: "sources"; sources: DiscoverySource[] }
  | { type: "tool"; action: "search" | "read"; status: "started" | "completed" | "failed" }
  | { type: "reset"; attempt: number; reason?: "timeout" | "temporary_error" | "withdrawn"; failureCode?: DiscoveryResetFailureCode }
  | { type: "complete"; model?: string; webSearchUsed?: boolean }
  | { type: "error"; code: string }
  | { type: "cancelled" };
export type DiscoveryEvent = DiscoveryEventPayload & { seq: number; runId: string; at: string };
export type DiscoveryRunSnapshot = {
  runId: string; status: DiscoveryRunStatus; markdown: string; sources: DiscoverySource[];
  lastSeq: number; attempt: number; submittedAt: string; deadlineAt: string;
  error?: string; model?: string; webSearchUsed?: boolean;
  manualRetryOfRunId?: string; maxTimeoutRunId?: string;
};
export type DiscoverySnapshot = {
  schemaVersion?: "competition-discovery.v1" | "competition-discovery.v2";
  sessionId: string; expiresAt: string;
  status: "clarifying" | "followups" | "ready" | "generating" | "complete" | "failed" | "cancelled";
  answers: DiscoveryAnswers; additionalText: string;
  followups: DiscoveryFollowupQuestion[]; followupAnswers: DiscoveryFollowupAnswer[];
  followupEditedAt?: string;
  clarificationStatus: DiscoveryClarificationStatus; clarificationError?: string;
  run: DiscoveryRunSnapshot | null;
};
