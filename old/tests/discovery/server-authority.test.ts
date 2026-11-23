import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  LOCAL_DISCOVERY_RUNTIME_POLICY, LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256,
  SERVER_DISCOVERY_RUNTIME_POLICY, SERVER_DISCOVERY_RUNTIME_POLICY_SHA256,
  assessDiscoveryPolicyRefresh, discoveryRunId, readDiscoveryRuntimePolicy,
} from "@/lib/ai/discovery-policy.mjs";
import { isServerRuntime, readServerRuntimeConfiguration } from "@/lib/ai/server-runtime-config.mjs";
import { configuredDiscoveryAuthority, verifyDiscoveryAuthority } from "@/lib/ai/discovery-authority";
import { acquireModelCallPermit, getModelCallGovernorConfigurationSnapshot } from "@/lib/ai/model-call-governor";
import type { PoolClient } from "pg";

const environment = { ...process.env };
const mainRunId = `saitu-server-${"a".repeat(32)}`;
function serverEnvironment(): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", SAITU_RUNTIME_MODE: "server", SAITU_AI_EXECUTION_MODE: "finite",
    DATABASE_URL: "postgresql://runtime:synthetic@127.0.0.1:5432/saitu_production",
    NEXT_PUBLIC_SITE_URL: "https://gzhanchuang.com", AI_SPEND_RUN_ID: mainRunId,
    SAITU_DISCOVERY_SPEND_RUN_ID: discoveryRunId(mainRunId) };
}
afterEach(() => { process.env = { ...environment }; });

describe("server discovery identity and authorization", () => {
  it("preserves the existing local policy bytes while selecting a separate server policy", () => {
    expect(LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256).toBe("c8093e4aee2021b59a0d71f59d63755646c82eb7871a9cbf096a667b629b3dc7");
    expect(LOCAL_DISCOVERY_RUNTIME_POLICY.concurrency).toBe(2);
    expect(readDiscoveryRuntimePolicy({})).toBe(LOCAL_DISCOVERY_RUNTIME_POLICY);
    expect(readDiscoveryRuntimePolicy(serverEnvironment())).toBe(SERVER_DISCOVERY_RUNTIME_POLICY);
    expect(SERVER_DISCOVERY_RUNTIME_POLICY).toMatchObject({ concurrency: 4, dailyCallLimit: null,
      budgetMode: "uncapped", reportDeadlineMs: 180000, automaticRetries: 1 });
    expect(SERVER_DISCOVERY_RUNTIME_POLICY_SHA256).not.toBe(LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256);
    expect(() => assessDiscoveryPolicyRefresh(SERVER_DISCOVERY_RUNTIME_POLICY, SERVER_DISCOVERY_RUNTIME_POLICY_SHA256))
      .toThrow("DISCOVERY_GRANT_SCOPE_CHANGED");
  });

  it("rejects unknown runtime modes rather than guessing a policy", () => {
    expect(() => isServerRuntime({ SAITU_RUNTIME_MODE: "prod" })).toThrow("INVALID_SAITU_RUNTIME_MODE");
    expect(() => readDiscoveryRuntimePolicy({ SAITU_RUNTIME_MODE: "prod" })).toThrow();
  });

  it("binds the deployment to the production database and canonical HTTPS origin", () => {
    expect(readServerRuntimeConfiguration(serverEnvironment())).toEqual({
      origin: "https://gzhanchuang.com", databaseName: "saitu_production" });
    Object.assign(process.env, serverEnvironment());
    delete process.env.SAITU_STANDALONE_LOCAL;
    expect(configuredDiscoveryAuthority()).toMatchObject({ mode: "server", mainRunId,
      runId: discoveryRunId(mainRunId), policySha256: SERVER_DISCOVERY_RUNTIME_POLICY_SHA256 });
    expect(getModelCallGovernorConfigurationSnapshot()).toMatchObject({ executionMode: "finite",
      transportConcurrencyHardMax: 4, transportConcurrencyEffectiveMax: 4, dailyCallLimit: null, persistentRequired: true });
  });

  it.each([
    { NEXT_PUBLIC_SITE_URL: "http://gzhanchuang.com" },
    { NEXT_PUBLIC_SITE_URL: "https://www.gzhanchuang.com" },
    { NEXT_PUBLIC_SITE_URL: "https://gzhanchuang.com/path" },
    { DATABASE_URL: "postgresql://runtime@127.0.0.1:5433/saitu_production" },
    { DATABASE_URL: "postgresql://runtime@127.0.0.1:5432/saitu_clean" },
    { DATABASE_URL: "postgresql://runtime@localhost:5432/saitu_production" },
    { DATABASE_URL: "postgresql://runtime@127.0.0.1:5432/saitu_production?sslmode=disable" },
    { SAITU_STANDALONE_LOCAL: "1" },
    { SAITU_AI_EXECUTION_MODE: "user-unbounded" },
    { NODE_ENV: "production", SAITU_LOCAL_TEST_DATABASE: "1", DATABASE_URL: `postgresql://runtime@127.0.0.1:5433/saitu_v7_backend_${"b".repeat(32)}` },
  ])("rejects deployment identity changes: %j", changes => {
    expect(() => readServerRuntimeConfiguration({ ...serverEnvironment(), ...changes })).toThrow("SERVER_RUNTIME_CONFIGURATION_REQUIRED");
  });

  it("cannot borrow a local run ID or another server's discovery run", () => {
    process.env = { ...environment, ...serverEnvironment(), SAITU_STANDALONE_LOCAL: "0" };
    process.env.AI_SPEND_RUN_ID = `saitu-local-${"a".repeat(32)}`;
    expect(() => configuredDiscoveryAuthority()).toThrow("DISCOVERY_RUNTIME_GRANT_REQUIRED");
    process.env.AI_SPEND_RUN_ID = mainRunId;
    process.env.SAITU_DISCOVERY_SPEND_RUN_ID = `saitu-discovery-server-${"b".repeat(32)}`;
    expect(() => configuredDiscoveryAuthority()).toThrow("DISCOVERY_RUNTIME_GRANT_REQUIRED");
  });

  it("checks the entire DB policy rather than trusting environment or an unchecked hash", async () => {
    process.env = { ...environment, ...serverEnvironment(), SAITU_STANDALONE_LOCAL: "0" };
    const authority = configuredDiscoveryAuthority();
    const altered = { ...SERVER_DISCOVERY_RUNTIME_POLICY, concurrency: 8 };
    const query = async () => ({ rows: [{ policy: altered,
      policy_sha256: createHash("sha256").update(JSON.stringify(altered)).digest("hex") }] });
    await expect(verifyDiscoveryAuthority({ query } as unknown as Pick<PoolClient, "query">, authority))
      .rejects.toThrow("DISCOVERY_RUNTIME_GRANT_REQUIRED");
    await expect(verifyDiscoveryAuthority({ query: async () => ({ rows: [{ policy: SERVER_DISCOVERY_RUNTIME_POLICY,
      policy_sha256: SERVER_DISCOVERY_RUNTIME_POLICY_SHA256 }] }) } as unknown as Pick<PoolClient, "query">, authority)).resolves.toBeUndefined();
  });

  it("never falls back to a default or memory governor for the server profile", async () => {
    process.env = { ...environment, ...serverEnvironment(), SAITU_STANDALONE_LOCAL: "0" };
    await expect(acquireModelCallPermit()).resolves.toEqual({ ok: false, reason: "budget_store_unavailable" });
    process.env.DATABASE_URL = "";
    await expect(acquireModelCallPermit({ profile: "server-discovery" })).resolves.toEqual({ ok: false, reason: "budget_store_unavailable" });
    process.env = { ...environment, SAITU_RUNTIME_MODE: "local" };
    await expect(acquireModelCallPermit({ profile: "server-discovery" })).resolves.toEqual({ ok: false, reason: "budget_store_unavailable" });
  });
});
