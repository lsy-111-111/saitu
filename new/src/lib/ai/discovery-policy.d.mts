export type LocalDiscoveryRuntimePolicy = Readonly<{
  version: 'saitu.discovery-runtime.v1'; authorization: string; model: 'deepseek-flash';
  operations: string[]; initialEffort: 'max' | 'high'; timeoutFallbackEffort: 'high';
  clarifyThinking: 'enabled'; clarifyFormat: 'json_object'; clarifyMaxTokens: 16384;
  reportThinking: 'enabled'; reportTools: string[]; reportSafetyLevel: 'high'; reportMaxTokens: 131072; reportFallbackMaxTokens: 65536; output: 'text';
  budgetMode: 'uncapped'; concurrency: 2; reportDeadlineMs: 180000;
  /** First nonempty max answer text; never extends reportDeadlineMs. */
  reportFirstAttemptMs: 150000;
  clarifyDeadlineMs: 30000; clarifyFirstAttemptMs: 20000; automaticRetries: 1;
}>;
export type ServerDiscoveryRuntimePolicy = Omit<LocalDiscoveryRuntimePolicy, 'version' | 'concurrency'> & Readonly<{
  version: 'saitu.discovery-runtime.v2'; concurrency: 4; runtimeMode: 'server';
  origin: 'https://gzhanchuang.com'; dailyCallLimit: null;
}>;
export type DiscoveryRuntimePolicy = LocalDiscoveryRuntimePolicy | ServerDiscoveryRuntimePolicy;
export const LOCAL_DISCOVERY_RUNTIME_POLICY: LocalDiscoveryRuntimePolicy;
export const LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256: string;
export const SERVER_DISCOVERY_RUNTIME_POLICY: ServerDiscoveryRuntimePolicy;
export const SERVER_DISCOVERY_RUNTIME_POLICY_SHA256: string;
export function readDiscoveryRuntimePolicy(environment?: Readonly<Record<string, string | undefined>>): DiscoveryRuntimePolicy;
export const DISCOVERY_RUNTIME_POLICY: DiscoveryRuntimePolicy;
export const DISCOVERY_RUNTIME_POLICY_SHA256: string;
export function assessDiscoveryPolicyRefresh(previous: unknown, storedSha256: string): { needsRefresh: boolean; previousFirstAttemptMs: number };
export function discoveryRunId(mainRunId: string): string;
