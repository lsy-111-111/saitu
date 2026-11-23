import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRetention } from "../../scripts/server/retention.mjs";
import { createV7TestDatabase } from "../helpers/v7-database-environment";

const integration = process.env.RUN_V7_DATABASE_TESTS === "1" ? describe : describe.skip;
integration("retention in a disposable PostgreSQL database", () => {
  let fixture: Awaited<ReturnType<typeof createV7TestDatabase>>;
  beforeAll(async () => {
    fixture = await createV7TestDatabase("durable");
    for (const name of ["20261119_competition_discovery.sql", "20261119_discovery_runtime_grant.sql",
      "20261119_discovery_call_receipts.sql", "20261120_server_retention.sql"])
      await fixture.admin.query(readFileSync(`db/migrations/${name}`, "utf8"));
    // The migration can be rerun safely without altering already redacted content.
    await fixture.admin.query(readFileSync("db/migrations/20261120_server_retention.sql", "utf8"));
  }, 20_000);
  afterAll(async () => { await fixture?.close(); });

  it("removes only expired bodies, preserves dispatch/expense evidence and respects the daily audit cursor", async () => {
    const client = fixture.admin;
    const expiredState = "a".repeat(64), activeState = "b".repeat(64);
    const oldRun = randomUUID(), activeOldRun = randomUUID(), oldCall = randomUUID();
    const expiredSession = randomUUID(), activeSession = randomUUID();
    const expiredDiscoveryRun = randomUUID(), activeDiscoveryRun = randomUUID(), olderRetry = randomUUID();
    const mainBudget = `saitu-local-${randomUUID().replaceAll("-", "")}`;
    const discoveryBudget = `saitu-discovery-${randomUUID().replaceAll("-", "")}`;
    const body = Buffer.from("fixture encrypted body"), iv = Buffer.alloc(12), tag = Buffer.alloc(16);
    await client.query(`insert into ai_spend_budgets(run_id,hard_limit_micros) values($1,1)`, [mainBudget]);
    await client.query(`insert into ai_spend_budgets(run_id,hard_limit_micros,execution_mode) values($1,null,'user-unbounded')`, [discoveryBudget]);
    await client.query(`insert into saitu_discovery_runtime_grants(run_id,main_run_id,grant_version,authorization_label,policy,policy_sha256)
      values($1,$2,'saitu.discovery-runtime.v1','user-approved-20261119-discovery-implementation','{}',$3)`,
    [discoveryBudget, mainBudget, "c".repeat(64)]);
    await client.query(`insert into ai_spend_ledger(id,run_id,model,effort,operation,price_version,reserved_micros,state)
      values($1,$2,'deepseek-flash','high','competition_discovery_report','fixture',1,'reserved')`, [oldCall, discoveryBudget]);
    await client.query(`insert into saitu_discovery_call_receipts(call_id,run_id,hard_deadline_at,dispatched_at)
      values($1,$2,now()-interval '1 hour',now()-interval '2 hours')`, [oldCall, discoveryBudget]);
    for (const [id, expired] of [[expiredState, true], [activeState, false]] as const) {
      await client.query(`insert into competition_decision_states(state_key,generation,ciphertext,iv,tag,expires_at)
        values($1,0,$2,$3,$4,now()+$5::interval)`, [id, body, iv, tag, expired ? "-1 hour" : "1 day"]);
    }
    for (const [id, state, expired] of [[oldRun, expiredState, true], [activeOldRun, activeState, false]] as const) {
      await client.query(`insert into competition_decision_runs(run_id,state_key,submission_key,implementation_version,status,
        ciphertext,iv,tag,submitted_at,list_deadline_at,detail_deadline_at,expires_at)
        values($1,$2,$3,'fixture','ready',$4,$5,$6,now()-interval '3 hours',now()-interval '170 minutes',
          now()-interval '160 minutes',now()+$7::interval)`, [id, state, id.replaceAll("-", "").repeat(2), body, iv, tag, expired ? "-1 hour" : "1 day"]);
    }
    await client.query(`insert into competition_decision_calls(call_id,run_id,call_key,prompt_sha256,reservation_id,state,
      ciphertext,iv,tag,dispatched_at) values($1,$2,'fixture',$3,$1,'dispatch_intent',$4,$5,$6,now()-interval '2 hours')`,
    [oldCall, oldRun, "d".repeat(64), body, iv, tag]);
    await client.query(`insert into competition_decision_chat_requests(run_id,request_id,request_sha256,ciphertext,iv,tag)
      values($1,'fixture',$2,$3,$4,$5)`, [oldRun, "e".repeat(64), body, iv, tag]);
    for (const [id, expired] of [[expiredSession, true], [activeSession, false]] as const) {
      await client.query(`insert into competition_discovery_sessions(session_id,creation_key,input_sha256,ciphertext,iv,tag,expires_at)
        values($1,$2,$2,$3,$4,$5,now()+$6::interval)`,
      [id, id.replaceAll("-", "").repeat(2), body, iv, tag, expired ? "-1 hour" : "1 day"]);
    }
    for (const [id, session, expired] of [[expiredDiscoveryRun, expiredSession, true],
      [activeDiscoveryRun, activeSession, false], [olderRetry, activeSession, true]] as const) {
      await client.query(`insert into competition_discovery_runs(run_id,session_id,submission_key,input_sha256,status,ciphertext,iv,tag,
        submitted_at,deadline_at,expires_at) values($1,$2,$3,$3,'complete',$4,$5,$6,now()-interval '3 hours',
        now()-interval '2 hours',now()+$7::interval)`,
      [id, session, id.replaceAll("-", "").repeat(2), body, iv, tag, expired ? "-1 hour" : "1 day"]);
      await client.query(`insert into competition_discovery_events(run_id,seq,ciphertext,iv,tag) values($1,1,$2,$3,$4)`, [id, body, iv, tag]);
    }
    await client.query(`insert into ai_consents(consent_version,purpose,created_at) values
      ('expired','fixture',now()-interval '181 days'),('active','fixture',now()-interval '179 days')`);
    const originalExpiry = (await client.query(`select expires_at from competition_discovery_sessions where session_id=$1`, [expiredSession])).rows[0].expires_at;
    const result = await runRetention(client);
    expect(result).toMatchObject({ skipped: false, discoverySessions: 1, discoveryRuns: 1, legacyRuns: 1,
      legacyStates: 1, consentAudit: 1, consentAuditCompletedToday: true });
    const oldState = (await client.query(`select ciphertext,content_redacted_at from competition_decision_states where state_key=$1`, [expiredState])).rows[0];
    expect(oldState.ciphertext).toBeNull(); expect(oldState.content_redacted_at).toBeTruthy();
    const call = (await client.query(`select * from competition_decision_calls where call_id=$1`, [oldCall])).rows[0];
    expect(call).toMatchObject({ state: "dispatch_intent", reservation_id: oldCall, ciphertext: null, iv: null, tag: null });
    expect(call.dispatched_at).toBeTruthy();
    await expect(client.query(`update competition_decision_calls set ciphertext=$2,iv=$3,tag=$4 where call_id=$1`,
      [oldCall, body, iv, tag])).rejects.toMatchObject({ code: "23514" });
    expect((await client.query(`select count(*)::int as count from ai_spend_ledger`)).rows[0].count).toBe(1);
    expect((await client.query(`select count(*)::int as count from saitu_discovery_call_receipts where dispatched_at is not null`)).rows[0].count).toBe(1);
    expect((await client.query(`select ciphertext from competition_decision_chat_requests where run_id=$1`, [oldRun])).rows[0].ciphertext).toBeNull();
    for (const id of [expiredDiscoveryRun, olderRetry]) {
      expect((await client.query(`select status,ciphertext from competition_discovery_runs where run_id=$1`, [id])).rows[0])
        .toMatchObject({ status: "expired", ciphertext: null });
      expect((await client.query(`select redacted,ciphertext from competition_discovery_events where run_id=$1`, [id])).rows[0])
        .toMatchObject({ redacted: true, ciphertext: null });
    }
    expect((await client.query(`select expires_at from competition_discovery_sessions where session_id=$1`, [expiredSession])).rows[0].expires_at)
      .toEqual(originalExpiry);
    expect((await client.query(`select ciphertext from competition_decision_states where state_key=$1`, [activeState])).rows[0].ciphertext).toEqual(body);
    expect((await client.query(`select ciphertext from competition_decision_runs where run_id=$1`, [activeOldRun])).rows[0].ciphertext).toEqual(body);
    expect((await client.query(`select ciphertext from competition_discovery_runs where run_id=$1`, [activeDiscoveryRun])).rows[0].ciphertext).toEqual(body);
    expect((await client.query(`select ciphertext from competition_discovery_sessions where session_id=$1`, [activeSession])).rows[0].ciphertext).toEqual(body);
    expect(await runRetention(client)).toMatchObject({ skipped: false, discoverySessions: 0, discoveryRuns: 0, legacyRuns: 0, legacyStates: 0, consentAudit: 0 });
    await client.query(`insert into ai_consents(consent_version,purpose,created_at) values('backlog','fixture',now()-interval '181 days')`);
    expect(await runRetention(client)).toMatchObject({ consentAudit: 0 });
    await client.query(`update saitu_retention_maintenance set completed_day=completed_day-1`);
    expect(await runRetention(client)).toMatchObject({ consentAudit: 1 });
    expect((await client.query(`select consent_version from ai_consents`)).rows).toEqual([{ consent_version: "active" }]);
  }, 20_000);
});
