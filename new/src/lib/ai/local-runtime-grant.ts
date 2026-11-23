import "server-only";
import type { PoolClient } from "pg";
import { isStandaloneDatabase } from "@/lib/config/local-instance";
import { readLocalDecisionPreviewV7 } from "@/lib/competitions/v7/active-release";
import { currentDecisionEffortPolicy } from "./effort-context";
import { DEFAULT_EFFORT_POLICY, effortPolicySha256, resolveEffortForOperation } from "./effort-policy.mjs";

/** Fresh administrator-created local authority; never reuses an experimental grant. */
export async function verifyLocalRuntimeGrant(client: Pick<PoolClient, "query">, input: {
  runId: string; phase: string; model: string; effort: string; operation?: string; effortPolicySha256?: string;
}): Promise<string | undefined> {
  const database = new URL(process.env.DATABASE_URL ?? "");
  const origin = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "");
  if (process.env.SAITU_STANDALONE_LOCAL !== "1" || !isStandaloneDatabase(database)
    || !/^saitu-local-[a-f0-9]{32}$/.test(input.runId) || input.model !== "deepseek-flash"
    || process.env.SAITU_AI_EXECUTION_MODE !== "finite"
    || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
    || !["3190", "3191", "3192"].includes(origin.port) || origin.pathname !== "/" || origin.search || origin.hash
    || origin.username || origin.password
    || process.env.NODE_ENV === "production" && !readLocalDecisionPreviewV7()) throw new Error("LOCAL_RUNTIME_GRANT_REQUIRED");
  const policy = currentDecisionEffortPolicy(), hash = effortPolicySha256(policy);
  if (hash !== effortPolicySha256(DEFAULT_EFFORT_POLICY)) throw new Error("LOCAL_RUNTIME_POLICY_CHANGED");
  const row = (await client.query<{ phase: string; effort_policy_sha256: string; effort_policy: unknown; cap: string; budget: string }>(
    `select g.phase,g.effort_policy_sha256,g.effort_policy,g.hard_limit_micros::text as cap,b.hard_limit_micros::text as budget
     from saitu_local_runtime_grants g join ai_spend_authority a on a.singleton=true and a.run_id=g.run_id
     join ai_spend_budgets b on b.run_id=g.run_id where g.run_id=$1 and g.enabled=true and b.execution_mode is null`,
    [input.runId])).rows[0];
  if (!row || row.phase !== input.phase || row.effort_policy_sha256 !== hash
    || effortPolicySha256(row.effort_policy as typeof policy) !== hash
    || !Number.isSafeInteger(Number(row.cap)) || Number(row.cap) <= 0 || Number(row.cap) > 300_000_000
    || row.cap !== row.budget) throw new Error("LOCAL_RUNTIME_GRANT_REQUIRED");
  const staged = /^competition_v7_/.test(input.operation ?? "") || input.effortPolicySha256 !== undefined;
  if (staged) {
    if (input.effortPolicySha256 !== hash || input.effort !== resolveEffortForOperation(input.operation ?? "", policy))
      throw new Error("LOCAL_RUNTIME_OPERATION_MISMATCH");
    return hash;
  }
  if (input.effort !== "max") throw new Error("LOCAL_RUNTIME_LEGACY_EFFORT_CHANGED");
  return undefined;
}
