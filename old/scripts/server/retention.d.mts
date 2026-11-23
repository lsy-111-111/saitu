import type { Client } from "pg";
export function retentionDatabaseUrl(environment?: Record<string, string | undefined>): string;
export function runRetention(client: Pick<Client, "query">): Promise<
  { skipped: true } | { skipped: false; discoverySessions: number; discoveryRuns: number; legacyRuns: number;
    legacyStates: number; securityState: number; consentAudit: number; consentAuditCompletedToday: boolean }
>;
