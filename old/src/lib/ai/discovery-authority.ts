import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { isStandaloneDatabase } from "@/lib/config/local-instance";
import {
  LOCAL_DISCOVERY_RUNTIME_POLICY, LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256,
  SERVER_DISCOVERY_RUNTIME_POLICY, SERVER_DISCOVERY_RUNTIME_POLICY_SHA256, discoveryRunId,
  type DiscoveryRuntimePolicy,
} from "./discovery-policy.mjs";
import { isServerRuntime, readServerRuntimeConfiguration } from "./server-runtime-config.mjs";

export type DiscoveryAuthority = {
  mode: "local" | "server";
  mainRunId: string;
  runId: string;
  policy: DiscoveryRuntimePolicy;
  policySha256: string;
};

/** Only explicit deployment identity plus a separate administrator-created DB
 * grant can authorize the server policy. Environment variables cannot mint it. */
export function configuredDiscoveryAuthority(): DiscoveryAuthority {
  try {
    const mainRunId = process.env.AI_SPEND_RUN_ID ?? "";
    const runId = process.env.SAITU_DISCOVERY_SPEND_RUN_ID ?? "";
    if (runId !== discoveryRunId(mainRunId)) throw new Error("invalid run");
    if (isServerRuntime()) {
      readServerRuntimeConfiguration();
      if (!/^saitu-server-[a-f0-9]{32}$/.test(mainRunId)) throw new Error("invalid server run");
      return { mode: "server", mainRunId, runId, policy: SERVER_DISCOVERY_RUNTIME_POLICY,
        policySha256: SERVER_DISCOVERY_RUNTIME_POLICY_SHA256 };
    }
    const database = new URL(process.env.DATABASE_URL ?? "");
    const origin = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "");
    if (process.env.SAITU_STANDALONE_LOCAL !== "1" || process.env.SAITU_AI_EXECUTION_MODE !== "finite"
      || !/^saitu-local-[a-f0-9]{32}$/.test(mainRunId) || !isStandaloneDatabase(database)
      || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !["3190", "3191", "3192"].includes(origin.port)
      || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("invalid local run");
    return { mode: "local", mainRunId, runId, policy: LOCAL_DISCOVERY_RUNTIME_POLICY,
      policySha256: LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256 };
  } catch { throw new Error("DISCOVERY_RUNTIME_GRANT_REQUIRED"); }
}

/** Settlement may verify a disabled grant: revocation stops new dispatch, but
 * does not erase a response's cost. Active-release admission is checked by the
 * worker, separately, so a release switch cannot prevent old receipt settlement. */
export async function verifyDiscoveryAuthority(client: Pick<PoolClient, "query">,
  authority: DiscoveryAuthority, allowDisabled = false, queryTimeoutMs?: number) {
  const text = `select g.policy,g.policy_sha256 from saitu_discovery_runtime_grants g
     join ai_spend_authority a on a.singleton=true and a.run_id=g.main_run_id
     join ai_spend_budgets b on b.run_id=g.run_id
     where g.run_id=$1 and g.main_run_id=$2 and (g.enabled=true or $5::boolean)
       and g.grant_version=$3 and g.authorization_label=$4 and g.budget_mode='uncapped'
       and g.hard_limit_micros is null and b.hard_limit_micros is null and b.execution_mode='user-unbounded'`;
  const grant = (await client.query<{ policy: unknown; policy_sha256: string }>({ text,
    values: [authority.runId, authority.mainRunId, authority.policy.version, authority.policy.authorization, allowDisabled],
    ...(queryTimeoutMs === undefined ? {} : { query_timeout: queryTimeoutMs }) })).rows[0];
  if (!grant || grant.policy_sha256 !== authority.policySha256 || !isDeepStrictEqual(grant.policy, authority.policy))
    throw new Error("DISCOVERY_RUNTIME_GRANT_REQUIRED");
}
