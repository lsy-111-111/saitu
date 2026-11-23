import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { createV7TestDatabase } from "../helpers/v7-database-environment";
import { getPool } from "@/lib/db/pool";
import { reconcileDiscoverySpend, withDiscoveryModelCall } from "@/lib/ai/discovery-spend";
import { DISCOVERY_RUNTIME_POLICY, DISCOVERY_RUNTIME_POLICY_SHA256, discoveryRunId } from "@/lib/ai/discovery-policy.mjs";
import { initializeDiscoveryRuntimeGrant } from "@/lib/ai/discovery-grant-setup.mjs";

const integration = process.env.RUN_V7_DATABASE_TESTS === "1" ? describe : describe.skip;
integration("discovery monetary authority with isolated PostgreSQL", () => {
  const environment = { ...process.env };
  const mainRunId = `saitu-local-${randomBytes(16).toString("hex")}`, runId = discoveryRunId(mainRunId);
  const globals = globalThis as typeof globalThis & { __pgPool?: pg.Pool };
  let fixture: Awaited<ReturnType<typeof createV7TestDatabase>>;
  beforeAll(async () => {
    fixture = await createV7TestDatabase("backend");
    await fixture.admin.query(readFileSync("db/migrations/20261119_discovery_runtime_grant.sql", "utf8"));
    await fixture.admin.query(readFileSync("db/migrations/20261119_discovery_call_receipts.sql", "utf8"));
    const role = new URL(fixture.runtimeUrl).username;
    await fixture.admin.query(`grant select on saitu_discovery_runtime_grants to "${role}"`);
    await fixture.admin.query(`grant select,insert,update on saitu_discovery_call_receipts to "${role}"`);
    await fixture.admin.query("insert into ai_spend_budgets(run_id,hard_limit_micros) values($1,1)", [mainRunId]);
    await fixture.admin.query("insert into ai_spend_authority(singleton,run_id) values(true,$1)", [mainRunId]);
    await fixture.admin.query("insert into ai_spend_budgets(run_id,hard_limit_micros,execution_mode) values($1,null,'user-unbounded')", [runId]);
    await fixture.admin.query(`insert into saitu_discovery_runtime_grants
      (run_id,main_run_id,grant_version,authorization_label,policy,policy_sha256) values($1,$2,$3,$4,$5::jsonb,$6)`,
    [runId, mainRunId, DISCOVERY_RUNTIME_POLICY.version, DISCOVERY_RUNTIME_POLICY.authorization,
      JSON.stringify(DISCOVERY_RUNTIME_POLICY), DISCOVERY_RUNTIME_POLICY_SHA256]);
    await globals.__pgPool?.end(); delete globals.__pgPool;
    Object.assign(process.env, { DATABASE_URL: fixture.runtimeUrl, SAITU_STANDALONE_LOCAL: "1", SAITU_AI_EXECUTION_MODE: "finite",
      NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3192", AI_SPEND_RUN_ID: mainRunId,
      SAITU_DISCOVERY_SPEND_RUN_ID: runId, AI_SPEND_LIMIT_CNY: "0.000001", AI_SPEND_FUNDED_CNY: "0.000001", AI_API_KEY: "" });
  });
  afterAll(async () => {
    // The governor's lease release is asynchronous; settle it on this pool
    // before removing the private test database.
    await globals.__pgPool?.query("select 1").catch(() => undefined);
    await globals.__pgPool?.end(); delete globals.__pgPool;
    await fixture?.close(); process.env = { ...environment };
  });
  it("records a new call despite the old budget having only one micro-yuan", async () => {
    const callId = randomUUID();
    await withDiscoveryModelCall({ operation: "competition_discovery_report", callId, reasoningEffort: "max",
      signal: new AbortController().signal, deadlineEpochMs: Date.now() + 5000, inputTokensEstimate: 100000, maxOutputTokens: 131072 },
    async ({ markDispatched, recordUsage }) => { await markDispatched(); recordUsage({ inputTokens: 100000, outputTokens: 10000, cachedInputTokens: 0 }); });
    const row = (await fixture.admin.query("select run_id,effort,state,charged_micros::text from ai_spend_ledger where id=$1", [callId])).rows[0];
    expect(row).toMatchObject({ run_id: runId, effort: "max", state: "usage_estimated", charged_micros: "280000" });
    expect((await fixture.admin.query("select hard_limit_micros::text from ai_spend_budgets where run_id=$1", [mainRunId])).rows[0].hard_limit_micros).toBe("1");
    expect((await fixture.admin.query("select count(*)::int as count from ai_spend_development_batches")).rows[0].count).toBe(0);
  });
  it("does not allow the runtime role to disable the grant or mint more budget", async () => {
    await expect(getPool().query("update saitu_discovery_runtime_grants set enabled=false")).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("insert into ai_spend_budgets(run_id,hard_limit_micros) values('unauthorized',1)")).rejects.toMatchObject({ code: "42501" });
  });
  it("fails before provider execution if the dedicated grant is revoked", async () => {
    await fixture.admin.query("update saitu_discovery_runtime_grants set enabled=false where run_id=$1", [runId]);
    let executed = false;
    await expect(withDiscoveryModelCall({ operation: "competition_discovery_report", callId: randomUUID(), reasoningEffort: "high",
      signal: new AbortController().signal, deadlineEpochMs: Date.now() + 5000, inputTokensEstimate: 100 },
    async () => { executed = true; })).rejects.toThrow("DISCOVERY_RUNTIME_GRANT_REQUIRED");
    expect(executed).toBe(false);
  });
  it("reconciles abandoned receipts without changing other budget runs", async () => {
    const otherRunId = `saitu-discovery-${randomBytes(16).toString("hex")}`;
    await fixture.admin.query("insert into ai_spend_budgets(run_id,hard_limit_micros,execution_mode) values($1,null,'user-unbounded')", [otherRunId]);
    await fixture.admin.query(`insert into saitu_discovery_runtime_grants
      (run_id,main_run_id,grant_version,authorization_label,policy,policy_sha256) values($1,$2,$3,$4,$5::jsonb,$6)`,
    [otherRunId, mainRunId, DISCOVERY_RUNTIME_POLICY.version, DISCOVERY_RUNTIME_POLICY.authorization,
      JSON.stringify(DISCOVERY_RUNTIME_POLICY), DISCOVERY_RUNTIME_POLICY_SHA256]);
    const ids = { undispatched: randomUUID(), unknown: randomUUID(), known: randomUUID(), legacy: randomUUID(), other: randomUUID() };
    for (const [name, id] of Object.entries(ids)) {
      const budget = name === "other" ? otherRunId : runId;
      await fixture.admin.query(`insert into ai_spend_ledger
        (id,run_id,model,effort,operation,price_version,reserved_micros,state,phase,created_at)
        values($1,$2,'deepseek-flash','max','competition_discovery_report','synthetic-test',12345,'reserved','formal',now()-interval '211 seconds')`, [id, budget]);
      if (name !== "legacy") await fixture.admin.query(`insert into saitu_discovery_call_receipts
        (call_id,run_id,hard_deadline_at,dispatched_at,input_tokens,output_tokens,cached_input_tokens,usage_cost_micros)
        values($1,$2,now()-interval '31 seconds',$3,$4,$5,$6,$7)`,
      [id, budget, name === "undispatched" ? null : new Date(), name === "known" ? 100 : null,
        name === "known" ? 20 : null, name === "known" ? 0 : null, name === "known" ? 360 : null]);
    }
    expect(await reconcileDiscoverySpend()).toBe(4);
    const rows = (await fixture.admin.query("select id,state,charged_micros::text from ai_spend_ledger where id=any($1::uuid[])", [Object.values(ids)])).rows;
    const row = (id: string) => rows.find(value => value.id === id);
    expect(row(ids.undispatched)).toMatchObject({ state: "cancelled", charged_micros: "0" });
    expect(row(ids.unknown)).toMatchObject({ state: "conservative", charged_micros: "12345" });
    expect(row(ids.known)).toMatchObject({ state: "usage_estimated", charged_micros: "360" });
    expect(row(ids.legacy)).toMatchObject({ state: "conservative", charged_micros: "12345" });
    expect(row(ids.other)).toMatchObject({ state: "reserved", charged_micros: null });
  });
  it("privileged setup narrows the old grant without resetting money or re-enabling it", async () => {
    const previousPolicy = { ...DISCOVERY_RUNTIME_POLICY, operations: ["competition_discovery_clarify", "competition_discovery_report"], reportFirstAttemptMs: 100000 };
    const previousHash = createHash("sha256").update(JSON.stringify(previousPolicy)).digest("hex");
    await fixture.admin.query("begin");
    try {
      const beforeBudgets = (await fixture.admin.query("select * from ai_spend_budgets order by run_id")).rows;
      const beforeLedger = (await fixture.admin.query("select * from ai_spend_ledger order by id")).rows;
      await fixture.admin.query("update saitu_discovery_runtime_grants set policy=$2::jsonb,policy_sha256=$3,enabled=false where run_id=$1",
        [runId, JSON.stringify(previousPolicy), previousHash]);
      expect(await initializeDiscoveryRuntimeGrant(fixture.admin, mainRunId)).toMatchObject({ refreshed: true,
        previousFirstAttemptMs: 100000, currentFirstAttemptMs: 150000, enabled: false });
      expect(await initializeDiscoveryRuntimeGrant(fixture.admin, mainRunId)).toMatchObject({ refreshed: false, enabled: false });
      const grant = (await fixture.admin.query("select policy,policy_sha256,enabled from saitu_discovery_runtime_grants where run_id=$1", [runId])).rows[0];
      expect(grant.policy.reportFirstAttemptMs).toBe(150000);
      expect(grant.policy_sha256).toBe(DISCOVERY_RUNTIME_POLICY_SHA256);
      expect(grant.enabled).toBe(false);
      expect((await fixture.admin.query("select * from ai_spend_budgets order by run_id")).rows).toEqual(beforeBudgets);
      expect((await fixture.admin.query("select * from ai_spend_ledger order by id")).rows).toEqual(beforeLedger);
      await fixture.admin.query("commit");
    } catch (error) { await fixture.admin.query("rollback"); throw error; }
    await expect(initializeDiscoveryRuntimeGrant(getPool(), mainRunId)).rejects.toMatchObject({ code: "42501" });
  });
});
