export const PRODUCTION_ORIGIN: "https://gzhanchuang.com";
export const PRODUCTION_ACCEPTANCE_CASE_IDS: readonly string[];
export type AcceptanceProfile = {
  id: string; name: string; answers: Record<string, { status: string; values: string[]; text?: string }>;
  additionalText: string; reviewChecks: readonly string[];
};
export type AcceptanceConfiguration = {
  concurrency: number; dailyCallLimit: number | null; automaticRetries: number; reportDeadlineMs: number;
  [key: string]: unknown;
};
export type AcceptanceCaseResult = {
  caseId: string; runId?: string; passed: boolean; status: string; error?: string; attempt?: number;
  restoredFromSnapshot: boolean; [key: string]: unknown;
};
export function parseAcceptanceArgs(args: string[]): { live: boolean; auditOnly: boolean; list: boolean; batchId?: string; evidenceRoot?: string };
export type AcceptanceLedgerRow = { callId: string; dispatchedAt: string | null; completedAt: string | null;
  hardDeadlineAt: string; state: string; chargedMicros: number | null; [key: string]: unknown };
export function auditServerAcceptance(options: { evidenceRoot: string; batchId: string;
  readLedgerRows(callIds: string[]): Promise<AcceptanceLedgerRow[]>;
}): Promise<{ passed: boolean; actualPaidDispatches: number; observedMaximumConcurrent: number; chargedCny: number;
  completedReportsHaveDispatchEvidence: boolean; rows: AcceptanceLedgerRow[]; [key: string]: unknown }>;
export function runServerAcceptance(options: {
  batchId: string; profiles: AcceptanceProfile[]; questionnaireVersion: string; consentVersion: string;
  parseSubmission(input: unknown): unknown; configuration: AcceptanceConfiguration; evidenceRoot: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>; pollMs?: number;
  onProgress?: (value: Record<string, unknown>) => void;
}): Promise<{
  outputDirectory: string; passed: boolean; interrupted: string | null; runnerError?: string;
  reportSubmissions: number; results: AcceptanceCaseResult[];
}>;
