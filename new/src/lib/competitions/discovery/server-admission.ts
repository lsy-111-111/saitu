import "server-only";
import { lstatSync } from "node:fs";
import type { PoolClient } from "pg";
import { isServerRuntime } from "@/lib/ai/server-runtime-config.mjs";

/** Deployment takes this same transaction lock after creating the maintenance
 * marker, before checking that accepted work has drained. */
export const SERVER_DISCOVERY_ADMISSION_LOCK = "724310896145225";
export const SERVER_DISCOVERY_MAINTENANCE_FILE = "/var/lib/saitu/maintenance";
export const SERVER_DISCOVERY_RUNNING_MAX = 4;
export const SERVER_DISCOVERY_OUTSTANDING_MAX = 8;
type QueryClient = Pick<PoolClient, "query">;

export const isServerDiscoveryRuntime = () => isServerRuntime();

export async function lockServerDiscoveryAdmission(client: QueryClient): Promise<void> {
  if (isServerDiscoveryRuntime()) {
    await client.query("select pg_advisory_xact_lock($1::bigint)", [SERVER_DISCOVERY_ADMISSION_LOCK]);
  }
}

/** Check only for genuinely new work. Recovery and idempotent responses stay
 * available while maintenance drains already accepted reports. */
export function assertServerDiscoveryAdmissionsOpen(): void {
  if (!isServerDiscoveryRuntime()) return;
  try {
    lstatSync(SERVER_DISCOVERY_MAINTENANCE_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("DISCOVERY_UNAVAILABLE");
  }
  throw new Error("DISCOVERY_MAINTENANCE");
}

async function countLiveRuns(client: QueryClient, runningOnly: boolean): Promise<number> {
  const row = (await client.query<{ count: number }>(`select count(*)::int as count
    from competition_discovery_runs r join competition_discovery_sessions s on s.session_id=r.session_id
    where r.status ${runningOnly ? "= 'running'" : "in ('queued','running')"}
      and r.expires_at>now() and s.status='active' and s.expires_at>now()
      and s.current_run_id=r.run_id`)).rows[0];
  if (!row || !Number.isSafeInteger(row.count) || row.count < 0) throw new Error("DISCOVERY_UNAVAILABLE");
  return row.count;
}

/** Caller holds SERVER_DISCOVERY_ADMISSION_LOCK until the insert commits. */
export async function assertServerDiscoveryQueueCapacity(client: QueryClient): Promise<void> {
  if (isServerDiscoveryRuntime() && await countLiveRuns(client, false) >= SERVER_DISCOVERY_OUTSTANDING_MAX) {
    throw new Error("DISCOVERY_BUSY");
  }
}

/** Running rows with a lost lease may always be reclaimed for finalization;
 * this check controls the transition of another queued row to running. */
export async function serverDiscoveryCanStartQueuedRun(client: QueryClient): Promise<boolean> {
  return !isServerDiscoveryRuntime() || await countLiveRuns(client, true) < SERVER_DISCOVERY_RUNNING_MAX;
}
