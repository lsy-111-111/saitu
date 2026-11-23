import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isServerRuntime, SERVER_SITE_ORIGIN } from './server-runtime-config.mjs';

/** Local discovery authority. The 2026-11-20 questionnaire update narrows new
 * dispatches to reports; historical clarification receipts remain auditable. */
export const LOCAL_DISCOVERY_RUNTIME_POLICY = Object.freeze({
  version: 'saitu.discovery-runtime.v1',
  authorization: 'user-approved-20261119-discovery-implementation',
  model: 'deepseek-flash',
  operations: ['competition_discovery_report'],
  initialEffort: 'high',
  timeoutFallbackEffort: 'high',
  clarifyThinking: 'enabled',
  clarifyFormat: 'json_object',
  clarifyMaxTokens: 16384,
  reportThinking: 'enabled',
  reportTools: ['deepseek_web_search'],
  reportSafetyLevel: 'high',
  reportMaxTokens: 131072,
  reportFallbackMaxTokens: 65536,
  output: 'text',
  budgetMode: 'uncapped',
  concurrency: 2,
  reportDeadlineMs: 180000,
  // Wait for substantive max answer text; a started answer keeps the original total deadline.
  reportFirstAttemptMs: 150000,
  clarifyDeadlineMs: 30000,
  clarifyFirstAttemptMs: 20000,
  automaticRetries: 1
});
const policyHash = policy => createHash('sha256').update(JSON.stringify(policy)).digest('hex');
export const LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256 = policyHash(LOCAL_DISCOVERY_RUNTIME_POLICY);
/** A fresh server grant never expands an existing local grant. Monetary
 * accounting remains uncapped while transport, retries and time stay bounded. */
export const SERVER_DISCOVERY_RUNTIME_POLICY = Object.freeze({
  ...LOCAL_DISCOVERY_RUNTIME_POLICY,
  version: 'saitu.discovery-runtime.v2',
  authorization: 'user-approved-20261120-server-deployment',
  concurrency: 4,
  runtimeMode: 'server',
  origin: SERVER_SITE_ORIGIN,
  dailyCallLimit: null
});
export const SERVER_DISCOVERY_RUNTIME_POLICY_SHA256 = policyHash(SERVER_DISCOVERY_RUNTIME_POLICY);
export function readDiscoveryRuntimePolicy(environment = process.env) {
  return isServerRuntime(environment) ? SERVER_DISCOVERY_RUNTIME_POLICY : LOCAL_DISCOVERY_RUNTIME_POLICY;
}
export const DISCOVERY_RUNTIME_POLICY = readDiscoveryRuntimePolicy();
export const DISCOVERY_RUNTIME_POLICY_SHA256 = policyHash(DISCOVERY_RUNTIME_POLICY);
/** Administrator setup may apply the approved questionnaire/performance update:
 * remove clarification dispatches and compare max/high as the initial effort.
 * It never changes the model, budget, concurrency, deadline, or retry ceiling.
 * Keep the original policy shape so existing receipts and JSONB hashes retain
 * their meaning. Only this privileged initializer may update the stored grant. */
export function assessDiscoveryPolicyRefresh(previous, storedSha256) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('DISCOVERY_GRANT_SCOPE_CHANGED');
  const keys = Object.keys(LOCAL_DISCOVERY_RUNTIME_POLICY);
  if (Object.keys(previous).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error('DISCOVERY_GRANT_SCOPE_CHANGED');
  // JSONB does not retain JavaScript insertion order. Recreate the original
  // policy order before checking the administrator-created stored binding.
  const ordered = Object.fromEntries(keys.map(key => [key, previous[key]]));
  const previousHash = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  if (previousHash !== storedSha256) throw new Error('DISCOVERY_GRANT_POLICY_HASH_INVALID');
  const knownOperations = isDeepStrictEqual(previous.operations, ['competition_discovery_report'])
    || isDeepStrictEqual(previous.operations, ['competition_discovery_clarify', 'competition_discovery_report']);
  const approvedFields = new Set(['reportFirstAttemptMs', 'operations', 'initialEffort']);
  if (!knownOperations || !['max', 'high'].includes(previous.initialEffort)
    || !Number.isSafeInteger(previous.reportFirstAttemptMs) || previous.reportFirstAttemptMs < 1
    || previous.reportFirstAttemptMs >= LOCAL_DISCOVERY_RUNTIME_POLICY.reportDeadlineMs
    || keys.some(key => !approvedFields.has(key) && !isDeepStrictEqual(previous[key], LOCAL_DISCOVERY_RUNTIME_POLICY[key])))
    throw new Error('DISCOVERY_GRANT_SCOPE_CHANGED');
  return { needsRefresh: storedSha256 !== LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256, previousFirstAttemptMs: previous.reportFirstAttemptMs };
}
export function discoveryRunId(mainRunId) {
  if (/^saitu-server-[a-f0-9]{32}$/.test(mainRunId))
    return `saitu-discovery-server-${mainRunId.slice('saitu-server-'.length)}`;
  if (!/^saitu-local-[a-f0-9]{32}$/.test(mainRunId)) throw new Error('INVALID_DISCOVERY_MAIN_AUTHORITY');
  return `saitu-discovery-${mainRunId.slice('saitu-local-'.length)}`;
}
