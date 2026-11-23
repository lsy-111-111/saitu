import type { PoolClient } from 'pg';
export function initializeDiscoveryRuntimeGrant(client: Pick<PoolClient, 'query'>, mainRunId: string): Promise<{
  runId: string; refreshed: boolean; previousFirstAttemptMs: number; currentFirstAttemptMs: number; enabled: boolean;
}>;
export function initializeServerDiscoveryRuntimeGrant(client: Pick<PoolClient, 'query'>, mainRunId: string): Promise<{
  runId: string; policySha256: string; enabled: boolean;
}>;
