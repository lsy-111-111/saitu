import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { createV7TestDatabase } from "../helpers/v7-database-environment";
import { DEFAULT_EFFORT_POLICY, effortPolicySha256 } from "@/lib/ai/effort-policy.mjs";
import { reserveAiSpend } from "@/lib/ai/spend-ledger";
import { getPool } from "@/lib/db/pool";
import { isStandaloneDatabase } from "@/lib/config/local-instance";

const integration = process.env.RUN_V7_DATABASE_TESTS === "1" ? describe : describe.skip;
integration("independent local finite authority with isolated PostgreSQL", () => {
  const original = { ...process.env }, runId = `saitu-local-${randomBytes(16).toString("hex")}`;
  const hash = effortPolicySha256(DEFAULT_EFFORT_POLICY);
  const globals = globalThis as typeof globalThis & { __pgPool?: pg.Pool };
  let fixture: Awaited<ReturnType<typeof createV7TestDatabase>>;
  const request = { system: "synthetic", prompt: "synthetic", maxTokens: 32, model: "deepseek-flash", effort: "low",
    operation: "competition_v7_rank", effortPolicySha256: hash };
  beforeAll(async () => {
    fixture = await createV7TestDatabase("backend");
    await fixture.admin.query(readFileSync("db/migrations/20261119_local_standalone.sql", "utf8"));
    const role = new URL(fixture.runtimeUrl).username;
    await fixture.admin.query(`grant select on saitu_local_runtime_grants to "${role}"`);
    await fixture.admin.query("insert into ai_spend_budgets(run_id,hard_limit_micros) values($1,1000000)", [runId]);
    await fixture.admin.query("insert into ai_spend_authority(singleton,run_id) values(true,$1)", [runId]);
    await fixture.admin.query("insert into saitu_local_runtime_grants(run_id,phase,effort_policy,effort_policy_sha256,hard_limit_micros) values($1,'calibration',$2::jsonb,$3,1000000)",
      [runId, JSON.stringify(DEFAULT_EFFORT_POLICY), hash]);
    await globals.__pgPool?.end(); delete globals.__pgPool;
    Object.assign(process.env, { DATABASE_URL: fixture.runtimeUrl, SAITU_STANDALONE_LOCAL: "1", SAITU_AI_EXECUTION_MODE: "finite",
      SAITU_V7_EFFORT_POLICY: JSON.stringify(DEFAULT_EFFORT_POLICY), SAITU_V7_EFFORT_POLICY_SHA256: hash,
      NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3192", AI_SPEND_RUN_ID: runId, AI_SPEND_PHASE: "calibration",
      AI_SPEND_LIMIT_CNY: "1", AI_SPEND_FUNDED_CNY: "1", AI_API_KEY: "" });
  });
  beforeEach(async () => {
    process.env.AI_SPEND_LIMIT_CNY = "1"; process.env.AI_SPEND_FUNDED_CNY = "1";
    await fixture.admin.query("update saitu_local_runtime_grants set enabled=true where run_id=$1", [runId]);
  });
  afterAll(async () => {
    await globals.__pgPool?.end(); delete globals.__pgPool;
    await fixture?.close(); process.env = { ...original };
  });
  it("accepts the preserved staged policy without fabricating historical batches", async () => {
    const result = await reserveAiSpend(request);
    expect(result.ok).toBe(true);
    if (result.ok) await result.reservation.settle(undefined, false);
    expect((await fixture.admin.query("select count(*)::int as n from ai_spend_development_batches")).rows[0].n).toBe(0);
    expect((await fixture.admin.query("select state,charged_micros::text as charged from ai_spend_ledger where run_id=$1", [runId])).rows[0]).toMatchObject({ state: "cancelled", charged: "0" });
  });
  it("preserves max effort for legacy normalization", async () => {
    const result = await reserveAiSpend({ ...request, operation: "competition_normalize", effort: "max", effortPolicySha256: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) await result.reservation.settle(undefined, false);
  });
  it("rejects a different policy, operation effort, or disabled grant", async () => {
    expect(await reserveAiSpend({ ...request, effortPolicySha256: "0".repeat(64) })).toMatchObject({ ok: false, reason: "spend_configuration_invalid" });
    expect(await reserveAiSpend({ ...request, effort: "high" })).toMatchObject({ ok: false, reason: "spend_configuration_invalid" });
    await fixture.admin.query("update saitu_local_runtime_grants set enabled=false where run_id=$1", [runId]);
    expect(await reserveAiSpend(request)).toMatchObject({ ok: false, reason: "spend_configuration_invalid" });
  });
  it("cannot raise the stored cap with environment changes", async () => {
    process.env.AI_SPEND_LIMIT_CNY = "300"; process.env.AI_SPEND_FUNDED_CNY = "300";
    expect(await reserveAiSpend({ ...request, maxTokens: 1_000_000 })).toMatchObject({ ok: false, reason: "spend_budget_exhausted" });
  });
  it("does not grant the application administrator privileges", async () => {
    await expect(getPool().query("update saitu_local_runtime_grants set enabled=false")).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("update ai_spend_budgets set hard_limit_micros=300000000")).rejects.toMatchObject({ code: "42501" });
  });
  it("rejects the original project's endpoint and remote databases", () => {
    expect(isStandaloneDatabase(new URL("postgresql://runtime@127.0.0.1:5432/saitu_upgrade"))).toBe(false);
    expect(isStandaloneDatabase(new URL("postgresql://runtime@example.com:5433/saitu_clean"))).toBe(false);
    expect(isStandaloneDatabase(new URL("postgresql://runtime@127.0.0.1:5433/saitu_clean"))).toBe(true);
  });
});
