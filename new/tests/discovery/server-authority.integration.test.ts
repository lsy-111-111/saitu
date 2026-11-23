import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { createV7TestDatabase } from "../helpers/v7-database-environment";
import { getPool } from "@/lib/db/pool";
import { initializeServerDiscoveryRuntimeGrant } from "@/lib/ai/discovery-grant-setup.mjs";
import {
  LOCAL_DISCOVERY_RUNTIME_POLICY, LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256,
  SERVER_DISCOVERY_RUNTIME_POLICY, SERVER_DISCOVERY_RUNTIME_POLICY_SHA256, discoveryRunId,
} from "@/lib/ai/discovery-policy.mjs";
import { acquireModelCallPermit, resetModelCallGovernorForTests } from "@/lib/ai/model-call-governor";
import { withDiscoveryModelCall } from "@/lib/ai/discovery-spend";

const integration = process.env.RUN_V7_DATABASE_TESTS === "1" ? describe : describe.skip;
integration("server discovery grant and shared model gate with isolated PostgreSQL", () => {
  const environment = { ...process.env }, mainRunId = `saitu-server-${randomBytes(16).toString("hex")}`;
  const runId = discoveryRunId(mainRunId), localMain = `saitu-local-${randomBytes(16).toString("hex")}`;
  const globals = globalThis as typeof globalThis & { __pgPool?: pg.Pool };
  let fixture: Awaited<ReturnType<typeof createV7TestDatabase>>;
  const migration = readFileSync("db/migrations/20261120_server_discovery_runtime_grant.sql", "utf8");
  const options = () => ({ profile: "server-discovery" as const, deadlineEpochMs: Date.now() + 6000, maxWaitMs: 5000 });
  const count = async (table: "ai_model_call_leases" | "ai_model_call_waiters") =>
    Number((await fixture.admin.query(`select count(*)::int as count from ${table}`)).rows[0].count);
  async function waitUntil(check: () => Promise<boolean>) {
    const deadline = Date.now() + 7000;
    while (!await check()) {
      if (Date.now() >= deadline) throw new Error("isolated model gate did not reach expected state");
      await delay(25);
    }
  }
  beforeAll(async () => {
    fixture = await createV7TestDatabase("backend");
    await fixture.admin.query(readFileSync("db/migrations/20261119_discovery_runtime_grant.sql", "utf8"));
    await fixture.admin.query(readFileSync("db/migrations/20261119_discovery_call_receipts.sql", "utf8"));
    await fixture.admin.query("insert into ai_spend_budgets(run_id,hard_limit_micros) values($1,1),($2,1)", [mainRunId, localMain]);
    await fixture.admin.query("insert into ai_spend_budgets(run_id,hard_limit_micros,execution_mode) values($1,null,'user-unbounded')", [discoveryRunId(localMain)]);
    await fixture.admin.query(`insert into saitu_discovery_runtime_grants
      (run_id,main_run_id,grant_version,authorization_label,policy,policy_sha256) values($1,$2,$3,$4,$5::jsonb,$6)`,
    [discoveryRunId(localMain), localMain, LOCAL_DISCOVERY_RUNTIME_POLICY.version,
      LOCAL_DISCOVERY_RUNTIME_POLICY.authorization, JSON.stringify(LOCAL_DISCOVERY_RUNTIME_POLICY), LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256]);
    await fixture.admin.query(migration);
    await fixture.admin.query(migration);
    await fixture.admin.query("insert into ai_spend_authority(singleton,run_id) values(true,$1)", [mainRunId]);
    await fixture.admin.query("begin");
    try { await initializeServerDiscoveryRuntimeGrant(fixture.admin, mainRunId); await fixture.admin.query("commit"); }
    catch (error) { await fixture.admin.query("rollback"); throw error; }
    const role = new URL(fixture.runtimeUrl).username;
    await fixture.admin.query(`grant select on saitu_discovery_runtime_grants to "${role}"`);
    await fixture.admin.query(`grant select,insert,update on saitu_discovery_call_receipts to "${role}"`);
    await globals.__pgPool?.end(); delete globals.__pgPool;
    Object.assign(process.env, { DATABASE_URL: fixture.runtimeUrl, SAITU_RUNTIME_MODE: "server", SAITU_STANDALONE_LOCAL: "0",
      SAITU_AI_EXECUTION_MODE: "finite", NEXT_PUBLIC_SITE_URL: "https://gzhanchuang.com",
      AI_SPEND_RUN_ID: mainRunId, SAITU_DISCOVERY_SPEND_RUN_ID: runId, AI_API_KEY: "", OPENAI_API_KEY: "",
      AI_CONCURRENCY_MAX: "999", AI_MODEL_CALLS_PER_DAY: "1", AI_QUEUE_MAX: "32", AI_QUEUE_WAIT_MS: "15000" });
  });
  beforeEach(async () => {
    resetModelCallGovernorForTests();
    await fixture.admin.query("truncate ai_model_call_leases,ai_model_call_waiters,ai_model_daily_usage");
    await fixture.admin.query("update saitu_discovery_runtime_grants set enabled=true where run_id=$1", [runId]);
  });
  afterAll(async () => {
    resetModelCallGovernorForTests();
    await globals.__pgPool?.end(); delete globals.__pgPool;
    await fixture?.close(); process.env = { ...environment };
  });

  it("keeps local v1 intact and makes production setup idempotent without reversing revocation", async () => {
    const local = (await fixture.admin.query("select policy_sha256,policy from saitu_discovery_runtime_grants where run_id=$1", [discoveryRunId(localMain)])).rows[0];
    expect(local).toEqual({ policy_sha256: LOCAL_DISCOVERY_RUNTIME_POLICY_SHA256, policy: LOCAL_DISCOVERY_RUNTIME_POLICY });
    const before = (await fixture.admin.query("select * from ai_spend_budgets order by run_id")).rows;
    await fixture.admin.query("update saitu_discovery_runtime_grants set enabled=false where run_id=$1", [runId]);
    for (let index = 0; index < 2; index += 1) {
      await fixture.admin.query("begin");
      try {
        expect(await initializeServerDiscoveryRuntimeGrant(fixture.admin, mainRunId)).toEqual({ runId,
          policySha256: SERVER_DISCOVERY_RUNTIME_POLICY_SHA256, enabled: false });
        await fixture.admin.query("commit");
      } catch (error) { await fixture.admin.query("rollback"); throw error; }
    }
    expect((await fixture.admin.query("select * from ai_spend_budgets order by run_id")).rows).toEqual(before);
    await expect(initializeServerDiscoveryRuntimeGrant(getPool(), mainRunId)).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("update saitu_discovery_runtime_grants set enabled=true")).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("update ai_spend_budgets set hard_limit_micros=null")).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects a mixed local/server authorization tuple at the database boundary", async () => {
    await expect(fixture.admin.query("update saitu_discovery_runtime_grants set authorization_label=$2 where run_id=$1",
      [runId, LOCAL_DISCOVERY_RUNTIME_POLICY.authorization])).rejects.toMatchObject({ code: "23514" });
    await expect(fixture.admin.query("update saitu_discovery_runtime_grants set policy=jsonb_set(policy,'{concurrency}','8') where run_id=$1", [runId]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a conflicting stored production policy without rewriting it", async () => {
    await fixture.admin.query("begin");
    try {
      await fixture.admin.query("update saitu_discovery_runtime_grants set policy_sha256=$2 where run_id=$1", [runId, "0".repeat(64)]);
      await expect(initializeServerDiscoveryRuntimeGrant(fixture.admin, mainRunId)).rejects.toThrow("SERVER_DISCOVERY_GRANT_SCOPE_CHANGED");
      expect((await fixture.admin.query("select policy_sha256 from saitu_discovery_runtime_grants where run_id=$1", [runId])).rows[0].policy_sha256)
        .toBe("0".repeat(64));
    } finally { await fixture.admin.query("rollback"); }
  });

  it("retains two-call concurrency and the 1200 daily ceiling for the default local profile", async () => {
    const saved = { ...process.env };
    process.env.SAITU_RUNTIME_MODE = "local";
    delete process.env.AI_MODEL_CALLS_PER_DAY;
    const held: Awaited<ReturnType<typeof acquireModelCallPermit>>[] = [];
    try {
      held.push(...await Promise.all([0, 1].map(() => acquireModelCallPermit({ deadlineEpochMs: Date.now() + 3000 }))));
      expect(held.every(result => result.ok)).toBe(true);
      expect(await count("ai_model_call_leases")).toBe(2);
      expect(await acquireModelCallPermit({ deadlineEpochMs: Date.now() + 1000, maxWaitMs: 150 }))
        .toEqual({ ok: false, reason: "capacity_exhausted" });
      for (const result of held) if (result.ok) result.permit.release();
      await waitUntil(async () => await count("ai_model_call_leases") === 0 && await count("ai_model_call_waiters") === 0);
      await fixture.admin.query("update ai_model_daily_usage set call_count=1200");
      expect(await acquireModelCallPermit({ deadlineEpochMs: Date.now() + 3000 }))
        .toEqual({ ok: false, reason: "daily_budget_exhausted" });
    } finally {
      for (const result of held) if (result.ok) result.permit.release();
      process.env = saved;
    }
  });

  it("admits exactly four calls, queues a fifth, and continues daily statistics above the old cap", async () => {
    await fixture.admin.query(`insert into ai_model_daily_usage values((now() at time zone 'Asia/Shanghai')::date,'global',1200,now())`);
    const held = await Promise.all(Array.from({ length: 4 }, () => acquireModelCallPermit(options())));
    expect(held.every(result => result.ok)).toBe(true);
    expect(await count("ai_model_call_leases")).toBe(4);
    let fifthAcquired = false;
    const fifth = acquireModelCallPermit(options()).then(result => { fifthAcquired = result.ok; return result; });
    await waitUntil(async () => await count("ai_model_call_waiters") === 1);
    expect(fifthAcquired).toBe(false);
    if (held[0].ok) held[0].permit.release();
    const next = await fifth;
    expect(next.ok).toBe(true);
    expect(await count("ai_model_call_leases")).toBe(4);
    expect((await fixture.admin.query("select sum(call_count)::int as count from ai_model_daily_usage")).rows[0].count).toBe(1205);
    for (const result of [...held, next]) if (result.ok) { result.permit.release(); result.permit.release(); }
    await waitUntil(async () => await count("ai_model_call_leases") === 0);
  });

  it("enforces the same four-call ceiling across two real Node processes", async () => {
    const children: ChildProcess[] = [0, 1].map(() => fork("tests/fixtures/server-model-gate-child.mjs", [], {
      execPath: process.execPath, cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "ignore", "ignore", "ipc"] }));
    const exits = children.map(child => new Promise<void>((resolve, reject) => {
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("isolated gate participant failed")));
      child.once("error", reject);
    }));
    try {
      await waitUntil(async () => await count("ai_model_call_leases") >= 4);
      await waitUntil(async () => await count("ai_model_call_waiters") >= 2);
      expect(await count("ai_model_call_leases")).toBe(4);
      await delay(150);
      expect(await count("ai_model_call_leases")).toBe(4);
    } finally {
      for (const child of children) if (child.connected) child.send("stop");
      try { await Promise.all(exits); }
      finally { for (const child of children) if (child.exitCode === null) child.kill("SIGTERM"); }
    }
    await waitUntil(async () => await count("ai_model_call_leases") === 0 && await count("ai_model_call_waiters") === 0);
  }, 20000);

  it("rechecks a revoked grant while a fifth call waits and removes its waiter", async () => {
    const held = await Promise.all(Array.from({ length: 4 }, () => acquireModelCallPermit(options())));
    const pending = acquireModelCallPermit(options());
    await waitUntil(async () => await count("ai_model_call_waiters") === 1);
    await fixture.admin.query("update saitu_discovery_runtime_grants set enabled=false where run_id=$1", [runId]);
    if (held[0].ok) held[0].permit.release();
    expect(await pending).toEqual({ ok: false, reason: "budget_store_unavailable" });
    for (const result of held) if (result.ok) result.permit.release();
    await waitUntil(async () => await count("ai_model_call_leases") === 0 && await count("ai_model_call_waiters") === 0);
  });

  it("settles an already dispatched call after revocation while refusing a new provider call", async () => {
    const callId = randomUUID();
    await withDiscoveryModelCall({ operation: "competition_discovery_report", callId, reasoningEffort: "high",
      signal: new AbortController().signal, deadlineEpochMs: Date.now() + 6000, inputTokensEstimate: 1000 },
    async ({ markDispatched, recordUsage }) => {
      await markDispatched();
      await fixture.admin.query("update saitu_discovery_runtime_grants set enabled=false where run_id=$1", [runId]);
      recordUsage({ inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0 });
    });
    expect((await fixture.admin.query("select state,effort_policy_sha256 from ai_spend_ledger where id=$1", [callId])).rows[0])
      .toEqual({ state: "usage_estimated", effort_policy_sha256: SERVER_DISCOVERY_RUNTIME_POLICY_SHA256 });
    let executed = false;
    await expect(withDiscoveryModelCall({ operation: "competition_discovery_report", callId: randomUUID(), reasoningEffort: "high",
      signal: new AbortController().signal, deadlineEpochMs: Date.now() + 6000, inputTokensEstimate: 1000 }, async () => { executed = true; }))
      .rejects.toThrow("DISCOVERY_MODEL_GATE_budget_store_unavailable");
    expect(executed).toBe(false);
    expect((await fixture.admin.query("select hard_limit_micros from ai_spend_budgets where run_id=$1", [runId])).rows[0].hard_limit_micros).toBeNull();
    expect(SERVER_DISCOVERY_RUNTIME_POLICY.reportDeadlineMs).toBe(180000);
  });
});
