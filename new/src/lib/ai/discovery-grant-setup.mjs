import { LOCAL_DISCOVERY_RUNTIME_POLICY as DISCOVERY_RUNTIME_POLICY,
  LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256 as DISCOVERY_RUNTIME_POLICY_SHA256,
  SERVER_DISCOVERY_RUNTIME_POLICY, SERVER_DISCOVERY_RUNTIME_POLICY_SHA256,
  assessDiscoveryPolicyRefresh, discoveryRunId } from './discovery-policy.mjs';
import { isDeepStrictEqual } from 'node:util';

/** Privileged local initialization only; the caller owns the transaction.
 * Runtime roles cannot write budgets or grants. No existing spending row is
 * removed, reset, or reattributed by this operation. */
export async function initializeDiscoveryRuntimeGrant(client, mainRunId) {
  if (!/^saitu-local-[a-f0-9]{32}$/.test(mainRunId)) throw new Error('INVALID_DISCOVERY_MAIN_AUTHORITY');
  const runId = discoveryRunId(mainRunId);
  await client.query("insert into ai_spend_budgets(run_id,hard_limit_micros,execution_mode) values($1,null,'user-unbounded') on conflict do nothing", [runId]);
  await client.query(`insert into saitu_discovery_runtime_grants
    (run_id,main_run_id,grant_version,authorization_label,policy,policy_sha256) values($1,$2,$3,$4,$5::jsonb,$6) on conflict do nothing`,
  [runId, mainRunId, DISCOVERY_RUNTIME_POLICY.version, DISCOVERY_RUNTIME_POLICY.authorization,
    JSON.stringify(DISCOVERY_RUNTIME_POLICY), DISCOVERY_RUNTIME_POLICY_SHA256]);
  const grant = (await client.query(`select g.main_run_id,g.grant_version,g.authorization_label,g.policy,g.policy_sha256,
    g.budget_mode,g.hard_limit_micros,g.enabled,b.execution_mode,b.hard_limit_micros as budget_cap
    from saitu_discovery_runtime_grants g join ai_spend_budgets b on b.run_id=g.run_id
    join ai_spend_authority a on a.singleton=true and a.run_id=g.main_run_id
    where g.run_id=$1 for update of g,b`, [runId])).rows[0];
  if (!grant || grant.main_run_id !== mainRunId || grant.grant_version !== DISCOVERY_RUNTIME_POLICY.version
    || grant.authorization_label !== DISCOVERY_RUNTIME_POLICY.authorization || grant.budget_mode !== 'uncapped'
    || grant.hard_limit_micros !== null || grant.budget_cap !== null || grant.execution_mode !== 'user-unbounded')
    throw new Error('DISCOVERY_GRANT_SCOPE_CHANGED');
  const assessment = assessDiscoveryPolicyRefresh(grant.policy, grant.policy_sha256);
  if (assessment.needsRefresh) {
    const result = await client.query(`update saitu_discovery_runtime_grants set policy=$2::jsonb,policy_sha256=$3
      where run_id=$1 and policy_sha256=$4 and main_run_id=$5`,
    [runId, JSON.stringify(DISCOVERY_RUNTIME_POLICY), DISCOVERY_RUNTIME_POLICY_SHA256, grant.policy_sha256, mainRunId]);
    if (result.rowCount !== 1) throw new Error('DISCOVERY_GRANT_REFRESH_CONFLICT');
  }
  // An administrator's revocation survives setup and rebuild.
  return { runId, refreshed: assessment.needsRefresh, previousFirstAttemptMs: assessment.previousFirstAttemptMs,
    currentFirstAttemptMs: DISCOVERY_RUNTIME_POLICY.reportFirstAttemptMs, enabled: grant.enabled };
}

/** Privileged server initialization only. The caller owns the transaction and
 * must already have installed the main budget and singleton authority. Repeated
 * deployment never rewrites a grant, resets a ledger or reverses revocation. */
export async function initializeServerDiscoveryRuntimeGrant(client, mainRunId) {
  if (!/^saitu-server-[a-f0-9]{32}$/.test(mainRunId)) throw new Error('INVALID_DISCOVERY_MAIN_AUTHORITY');
  const authority = (await client.query('select run_id from ai_spend_authority where singleton=true')).rows[0];
  if (authority?.run_id !== mainRunId) throw new Error('SERVER_DISCOVERY_AUTHORITY_MISMATCH');
  const runId = discoveryRunId(mainRunId), policy = SERVER_DISCOVERY_RUNTIME_POLICY;
  await client.query("insert into ai_spend_budgets(run_id,hard_limit_micros,execution_mode) values($1,null,'user-unbounded') on conflict do nothing", [runId]);
  await client.query(`insert into saitu_discovery_runtime_grants
    (run_id,main_run_id,grant_version,authorization_label,policy,policy_sha256) values($1,$2,$3,$4,$5::jsonb,$6) on conflict do nothing`,
  [runId, mainRunId, policy.version, policy.authorization, JSON.stringify(policy), SERVER_DISCOVERY_RUNTIME_POLICY_SHA256]);
  const grant = (await client.query(`select g.main_run_id,g.grant_version,g.authorization_label,g.policy,g.policy_sha256,
    g.budget_mode,g.hard_limit_micros,g.enabled,b.execution_mode,b.hard_limit_micros as budget_cap
    from saitu_discovery_runtime_grants g join ai_spend_budgets b on b.run_id=g.run_id
    where g.run_id=$1 for update of g,b`, [runId])).rows[0];
  if (!grant || grant.main_run_id !== mainRunId || grant.grant_version !== policy.version
    || grant.authorization_label !== policy.authorization || grant.budget_mode !== 'uncapped'
    || grant.hard_limit_micros !== null || grant.budget_cap !== null || grant.execution_mode !== 'user-unbounded'
    || grant.policy_sha256 !== SERVER_DISCOVERY_RUNTIME_POLICY_SHA256 || !isDeepStrictEqual(grant.policy, policy))
    throw new Error('SERVER_DISCOVERY_GRANT_SCOPE_CHANGED');
  return { runId, policySha256: SERVER_DISCOVERY_RUNTIME_POLICY_SHA256, enabled: grant.enabled };
}
