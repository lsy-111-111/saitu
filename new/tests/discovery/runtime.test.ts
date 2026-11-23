import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { DISCOVERY_RUNTIME_POLICY, DISCOVERY_RUNTIME_POLICY_SHA256, assessDiscoveryPolicyRefresh, discoveryRunId } from "@/lib/ai/discovery-policy.mjs";

const fixture = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), permitRelease: vi.fn(), gate: vi.fn(), connect: vi.fn()
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: fixture.query, connect: fixture.connect }), isDatabaseConfigured: () => true }));
vi.mock("@/lib/ai/model-call-governor", () => ({ acquireModelCallPermit: fixture.gate }));
import { reconcileDiscoverySpend, withDiscoveryModelCall } from "@/lib/ai/discovery-spend";
type Query = string | { text: string; values?: unknown[] };
const queryText = (input: Query) => typeof input === "string" ? input : input.text;
const queries = () => fixture.query.mock.calls.map(([input, values]) =>
  [queryText(input), typeof input === "string" ? values : input.values] as [string, unknown[]]);

describe("independent discovery accounting", () => {
  const environment = { ...process.env };
  const mainRunId = `saitu-local-${"1".repeat(32)}`;
  const options = () => ({ operation: "competition_discovery_report" as const, callId: randomUUID(),
    reasoningEffort: "max" as const,
    signal: new AbortController().signal, deadlineEpochMs: Date.now() + 2000, inputTokensEstimate: 1000 });
  beforeEach(() => {
    Object.assign(process.env, { SAITU_STANDALONE_LOCAL: "1", SAITU_AI_EXECUTION_MODE: "finite",
      DATABASE_URL: "postgresql://runtime@127.0.0.1:5433/saitu_clean", NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3191",
      AI_SPEND_RUN_ID: mainRunId, SAITU_DISCOVERY_SPEND_RUN_ID: discoveryRunId(mainRunId) });
    fixture.query.mockReset(); fixture.release.mockReset(); fixture.permitRelease.mockReset(); fixture.gate.mockReset();
    fixture.gate.mockResolvedValue({ ok: true, permit: { release: fixture.permitRelease } });
    fixture.connect.mockResolvedValue({ query: fixture.query, release: fixture.release });
    fixture.query.mockImplementation(async (sql: Query) => queryText(sql).includes("select g.policy")
      ? { rows: [{ policy: DISCOVERY_RUNTIME_POLICY, policy_sha256: DISCOVERY_RUNTIME_POLICY_SHA256 }] }
      : { rows: [], rowCount: 1 });
  });
  afterEach(() => { process.env = { ...environment }; vi.restoreAllMocks(); });
  const settlement = () => queries().find(([sql]) => sql.startsWith("update ai_spend_ledger"))?.[1] as unknown[];

  it("starts at high while retaining the bounded watchdog for historical max runs", () => {
    expect(DISCOVERY_RUNTIME_POLICY.initialEffort).toBe("high");
    expect(DISCOVERY_RUNTIME_POLICY.timeoutFallbackEffort).toBe("high");
    expect(DISCOVERY_RUNTIME_POLICY.reportFirstAttemptMs).toBe(150000);
    expect(DISCOVERY_RUNTIME_POLICY.reportDeadlineMs - DISCOVERY_RUNTIME_POLICY.reportFirstAttemptMs).toBe(30000);
    expect(DISCOVERY_RUNTIME_POLICY.automaticRetries).toBe(1);
  });

  it("allows privileged refresh of the first-attempt timer with a verified JSONB policy", () => {
    const previous = { ...DISCOVERY_RUNTIME_POLICY, reportFirstAttemptMs: 100000 };
    const previousHash = createHash("sha256").update(JSON.stringify(previous)).digest("hex");
    const jsonbOrder = Object.fromEntries(Object.entries(previous).reverse());
    expect(assessDiscoveryPolicyRefresh(jsonbOrder, previousHash)).toEqual({ needsRefresh: true, previousFirstAttemptMs: 100000 });
    expect(assessDiscoveryPolicyRefresh(DISCOVERY_RUNTIME_POLICY, DISCOVERY_RUNTIME_POLICY_SHA256).needsRefresh).toBe(false);
  });

  it("rejects scope expansion or a corrupt grant hash during administrator refresh", () => {
    const changed = { ...DISCOVERY_RUNTIME_POLICY, reportDeadlineMs: 240000 };
    const hash = createHash("sha256").update(JSON.stringify(changed)).digest("hex");
    expect(() => assessDiscoveryPolicyRefresh(changed, hash)).toThrow("DISCOVERY_GRANT_SCOPE_CHANGED");
    expect(() => assessDiscoveryPolicyRefresh(DISCOVERY_RUNTIME_POLICY, "0".repeat(64))).toThrow("DISCOVERY_GRANT_POLICY_HASH_INVALID");
  });

  it("migrates the approved report-only policy without permitting unrelated operations", () => {
    const previous = { ...DISCOVERY_RUNTIME_POLICY, operations: ["competition_discovery_clarify", "competition_discovery_report"] };
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(assessDiscoveryPolicyRefresh(previous, digest(previous)).needsRefresh).toBe(true);
    const comparedEffort = { ...DISCOVERY_RUNTIME_POLICY, initialEffort: "max" };
    expect(assessDiscoveryPolicyRefresh(comparedEffort, digest(comparedEffort)).needsRefresh).toBe(true);
    const expanded = { ...previous, operations: [...previous.operations, "arbitrary_operation"] };
    expect(() => assessDiscoveryPolicyRefresh(expanded, digest(expanded))).toThrow("DISCOVERY_GRANT_SCOPE_CHANGED");
  });

  it("rejects removed clarification dispatches before acquiring a permit", async () => {
    await expect(withDiscoveryModelCall({ ...options(), operation: "competition_discovery_clarify" }, vi.fn()))
      .rejects.toThrow("DISCOVERY_CALL_CONFIGURATION_INVALID");
    expect(fixture.gate).not.toHaveBeenCalled();
  });

  it("records real cumulative usage and keeps global finite concurrency", async () => {
    await expect(withDiscoveryModelCall(options(), async ({ markDispatched, recordUsage }) => {
      await markDispatched(); recordUsage({ inputTokens: 10000, outputTokens: 2000, cachedInputTokens: 500 }); return "done";
    })).resolves.toBe("done");
    expect(settlement()).toEqual([expect.any(String), expect.any(Number), "usage_estimated", 10000, 2000, 500, discoveryRunId(mainRunId)]);
    const reservation = queries().find(([sql]) => sql.startsWith("insert into ai_spend_ledger"))?.[1] as unknown[];
    expect(reservation[6]).toBe("max");
    expect(fixture.permitRelease).toHaveBeenCalledTimes(1);
    expect(process.env.SAITU_AI_EXECUTION_MODE).toBe("finite");
    expect(queries().some(([sql]) => /update ai_spend_budgets|delete from ai_spend_ledger/.test(sql))).toBe(false);
  });

  it("does not report an attempted request of unknown usage as zero", async () => {
    await expect(withDiscoveryModelCall(options(), async ({ markDispatched }) => {
      await markDispatched(); throw new Error("network lost");
    })).rejects.toThrow("network lost");
    expect(settlement()[1]).toBeGreaterThan(0);
    expect(settlement().slice(2)).toEqual(["conservative", null, null, null, discoveryRunId(mainRunId)]);
    expect(fixture.permitRelease).toHaveBeenCalledTimes(1);
  });

  it("records the explicitly selected high-effort timeout fallback", async () => {
    await withDiscoveryModelCall({ ...options(), reasoningEffort: "high" }, async () => undefined);
    const reservation = queries().find(([sql]) => sql.startsWith("insert into ai_spend_ledger"))?.[1] as unknown[];
    expect(reservation[6]).toBe("high");
  });

  it("cancels a reservation before provider dispatch without charging", async () => {
    await expect(withDiscoveryModelCall(options(), async () => { throw new Error("input invalid"); })).rejects.toThrow("input invalid");
    expect(settlement().slice(1)).toEqual([0, "cancelled", null, null, null, discoveryRunId(mainRunId)]);
    expect(fixture.permitRelease).toHaveBeenCalledTimes(1);
  });

  it("fails closed for disabled or changed authority before provider execution", async () => {
    fixture.query.mockImplementation(async () => ({ rows: [] }));
    const execute = vi.fn();
    await expect(withDiscoveryModelCall(options(), execute)).rejects.toThrow("DISCOVERY_RUNTIME_GRANT_REQUIRED");
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.permitRelease).toHaveBeenCalledTimes(1);
    expect(settlement()).toBeUndefined();
  });

  it("cannot use a global unlimited mode or arbitrary budget run", async () => {
    process.env.SAITU_AI_EXECUTION_MODE = "user-unbounded";
    await expect(withDiscoveryModelCall(options(), vi.fn())).rejects.toThrow("DISCOVERY_RUNTIME_GRANT_REQUIRED");
    expect(fixture.gate).not.toHaveBeenCalled();
    process.env.SAITU_AI_EXECUTION_MODE = "finite";
    process.env.SAITU_DISCOVERY_SPEND_RUN_ID = "different-run";
    await expect(withDiscoveryModelCall(options(), vi.fn())).rejects.toThrow("DISCOVERY_RUNTIME_GRANT_REQUIRED");
  });

  it("preserves the successful model response after three failed settlement attempts", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let providerCalls = 0;
    fixture.query.mockImplementation(async (input: Query) => {
      const sql = queryText(input);
      if (sql.includes("select g.policy")) return { rows: [{ policy: DISCOVERY_RUNTIME_POLICY, policy_sha256: DISCOVERY_RUNTIME_POLICY_SHA256 }] };
      if (sql.startsWith("update ai_spend_ledger")) throw new Error("database unavailable");
      return { rows: [], rowCount: 1 };
    });
    await expect(withDiscoveryModelCall(options(), async ({ markDispatched }) => {
      await markDispatched(); providerCalls += 1; return "complete report";
    })).resolves.toBe("complete report");
    expect(providerCalls).toBe(1);
    expect(queries().filter(([sql]) => sql.startsWith("update ai_spend_ledger"))).toHaveLength(3);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"event":"discovery_spend_settlement_pending"'));
    expect(fixture.permitRelease).toHaveBeenCalledTimes(1);
  });

  it("retries only settlement storage when one ledger update temporarily fails", async () => {
    let settlements = 0, providerCalls = 0;
    fixture.query.mockImplementation(async (input: Query) => {
      const sql = queryText(input);
      if (sql.includes("select g.policy")) return { rows: [{ policy: DISCOVERY_RUNTIME_POLICY, policy_sha256: DISCOVERY_RUNTIME_POLICY_SHA256 }] };
      if (sql.startsWith("update ai_spend_ledger") && ++settlements === 1) throw new Error("temporary database loss");
      return { rows: [], rowCount: 1 };
    });
    await expect(withDiscoveryModelCall(options(), async ({ markDispatched, recordUsage }) => {
      await markDispatched(); providerCalls += 1; recordUsage({ inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 }); return "done";
    })).resolves.toBe("done");
    expect(providerCalls).toBe(1); expect(settlements).toBe(2);
    expect(fixture.permitRelease).toHaveBeenCalledTimes(1);
  });

  it("preserves the original provider error when every settlement update fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const providerError = Object.assign(new Error("provider timeout"), { code: "timeout", retryable: true });
    fixture.query.mockImplementation(async (input: Query) => {
      const sql = queryText(input);
      if (sql.includes("select g.policy")) return { rows: [{ policy: DISCOVERY_RUNTIME_POLICY, policy_sha256: DISCOVERY_RUNTIME_POLICY_SHA256 }] };
      if (sql.startsWith("update ai_spend_ledger")) throw new Error("storage unavailable");
      return { rows: [], rowCount: 1 };
    });
    await expect(withDiscoveryModelCall(options(), async ({ markDispatched }) => {
      await markDispatched(); throw providerError;
    })).rejects.toBe(providerError);
    expect(fixture.permitRelease).toHaveBeenCalledTimes(1);
  });

  it("never dispatches HTTP before the durable dispatch receipt succeeds", async () => {
    let providerCalls = 0;
    fixture.query.mockImplementation(async (input: Query) => {
      const sql = queryText(input);
      if (sql.includes("select g.policy")) return { rows: [{ policy: DISCOVERY_RUNTIME_POLICY, policy_sha256: DISCOVERY_RUNTIME_POLICY_SHA256 }] };
      if (sql.includes("set dispatched_at=")) throw new Error("receipt unavailable");
      return { rows: [], rowCount: 1 };
    });
    await expect(withDiscoveryModelCall(options(), async ({ markDispatched }) => {
      await markDispatched(); providerCalls += 1;
    })).rejects.toThrow("receipt unavailable");
    expect(providerCalls).toBe(0);
    expect(fixture.permitRelease).toHaveBeenCalledTimes(1);
  });

  it("scopes periodic reconciliation to the verified discovery budget", async () => {
    expect(await reconcileDiscoverySpend()).toBe(2);
    const updates = queries().filter(([sql]) => sql.startsWith("update ai_spend_ledger"));
    expect(updates).toHaveLength(2);
    for (const [sql, values] of updates) {
      expect(sql).toContain("l.run_id=$1"); expect(values).toEqual([discoveryRunId(mainRunId)]);
    }
    expect(updates[0][0]).toContain("interval '30 seconds'");
    expect(updates[1][0]).toContain("interval '210 seconds'");
  });
});
