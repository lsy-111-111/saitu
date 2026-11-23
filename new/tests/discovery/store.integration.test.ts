import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/pool";
import { sealV7, unsealV7 } from "@/lib/competitions/v7/crypto";
import { createEmptyDiscoveryAnswers } from "@/lib/competitions/discovery/questionnaire";
import { DISCOVERY_CONSENT_VERSION } from "@/lib/competitions/discovery/disclosure";
import { DISCOVERY_RUNTIME_POLICY, DISCOVERY_RUNTIME_POLICY_SHA256 } from "@/lib/ai/discovery-policy.mjs";
import type { DiscoveryFollowupAnswer, DiscoveryFollowupQuestion } from "@/lib/competitions/discovery/contracts";
import { DISCOVERY_RETENTION_MS, type DiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/transport";
import {
  appendDiscoveryRunEvent, cancelDiscoveryRun, claimDiscoveryClarification, claimDiscoveryRun,
  createDiscoverySession, deleteDiscoverySession, enqueueDiscoveryReport, expireDiscoverySessions,
  findDiscoverySessionBySubmission, finishDiscoveryClarification, getDiscoverySnapshot,
  listDiscoveryEvents, renewDiscoveryRunLease, verifyDiscoveryResumeToken, saveDiscoveryFollowupDraft, discoveryModelInvocationId,
  type DiscoveryRunBody, type DiscoverySessionBody,
} from "@/lib/competitions/discovery/store";
import { createV7TestDatabase } from "../helpers/v7-database-environment";
import { acknowledgeDiscoveryFollowupSave, changeDiscoveryFollowup, discoveryFollowupSaveRequest, emptyDiscoveryBrowserState, type DiscoveryBrowserState } from "@/components/competitions/discovery/discovery-client-state";
import { DISCOVERY_SCHEMA_VERSION } from "@/lib/competitions/discovery/contracts";
import {
  DISCOVERY_PRESENTATION_VERSION, discoveryPresentationMarkdown, emptyDiscoveryPresentation, presentationRecordMarkdown,
  persistedPresentationRecordSchema,
  type DiscoveryPresentationRecord,
} from "@/lib/competitions/discovery/presentation";

const integration = process.env.RUN_V7_DATABASE_TESTS === "1" ? describe : describe.skip;
integration("discovery durable store in a disposable PostgreSQL database", () => {
  const original = { ...process.env }, globals = globalThis as typeof globalThis & { __pgPool?: pg.Pool };
  let fixture: Awaited<ReturnType<typeof createV7TestDatabase>>;
  const mainSpendRun = `saitu-local-${randomUUID().replaceAll("-", "")}`, discoverySpendRun = `saitu-discovery-${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    fixture = await createV7TestDatabase("backend");
    await fixture.admin.query(readFileSync("db/migrations/20261119_competition_discovery.sql", "utf8"));
    await fixture.admin.query(readFileSync("db/migrations/20261119_discovery_runtime_grant.sql", "utf8"));
    await fixture.admin.query(readFileSync("db/migrations/20261119_discovery_call_receipts.sql", "utf8"));
    const role = decodeURIComponent(new URL(fixture.runtimeUrl).username);
    for (const table of ["competition_discovery_sessions", "competition_discovery_runs", "competition_discovery_events"])
      await fixture.admin.query(`grant select,insert,update on ${table} to "${role}"`);
    await fixture.admin.query(`grant select on saitu_discovery_call_receipts to "${role}"`);
    await fixture.admin.query("insert into ai_spend_budgets(run_id,hard_limit_micros) values($1,1),($2,1)", [mainSpendRun, discoverySpendRun]);
    await fixture.admin.query(`insert into saitu_discovery_runtime_grants(run_id,main_run_id,grant_version,authorization_label,policy,policy_sha256)
      values($1,$2,$3,$4,$5::jsonb,$6)`, [discoverySpendRun, mainSpendRun, DISCOVERY_RUNTIME_POLICY.version,
      DISCOVERY_RUNTIME_POLICY.authorization, JSON.stringify(DISCOVERY_RUNTIME_POLICY), DISCOVERY_RUNTIME_POLICY_SHA256]);
    await globals.__pgPool?.end(); delete globals.__pgPool;
    Object.assign(process.env, { DATABASE_URL: fixture.runtimeUrl, AI_CONVERSATION_SIGNING_SECRET: randomUUID() + randomUUID(), AI_API_KEY: "" });
  }, 30000);
  afterEach(async () => {
    await fixture.admin.query("update competition_discovery_runs set status='cancelled',lease_owner=null,lease_expires_at=null where status in ('queued','running')");
  });
  afterAll(async () => {
    await globals.__pgPool?.end(); delete globals.__pgPool;
    await fixture?.close(); process.env = { ...original };
  });
  function input() {
    const text = JSON.stringify([{ id: "synthetic-competition", task: "合成竞赛资料" }]);
    const catalogSnapshot: DiscoveryCatalogSnapshot = { version: "synthetic.v1", count: 1, ids: ["synthetic-competition"], text,
      clarifyText: JSON.stringify([{ id: "synthetic-competition" }]), byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
    return { answers: createEmptyDiscoveryAnswers(), additionalText: "合成学生补充", catalogSnapshot,
      consentVersion: DISCOVERY_CONSENT_VERSION, clientRequestId: randomUUID() };
  }
  async function start(format: "legacy" | "current" = "legacy") {
    const created = await createDiscoverySession(input());
    const clarification = await claimDiscoveryClarification(created.resumeToken, randomUUID());
    if (clarification.kind !== "claimed") throw new Error("synthetic_claim_expected");
    await finishDiscoveryClarification(clarification.claim, { questions: [] });
    const report = await enqueueDiscoveryReport(created.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] },
      { presentationVersion: format === "legacy" ? "legacy" : DISCOVERY_PRESENTATION_VERSION });
    const claim = await claimDiscoveryRun(`synthetic-${randomUUID()}`);
    if (!claim || claim.row.run_id !== report.snapshot.run?.runId) throw new Error("synthetic_report_claim_expected");
    return { ...created, report, claim };
  }

  const profileRecord: DiscoveryPresentationRecord = { type: "profile", summary: "合成画像摘要", groups: {
    background: ["当前学段待核"], goals: ["技能训练"], experience: [], constraints: ["总预算待核"],
  } };
  const cardRecord: DiscoveryPresentationRecord = { type: "card", key: "synthetic", competitionId: "synthetic-competition", title: "合成竞赛", track: "合成赛道",
    summary: "与合成作答对应的推荐", details: { tasks: ["合成任务"], reasons: ["真实回答的关联"], value: ["训练记录"], conditions: ["参赛资格待核"] }, sources: [],
    catalogDetail: { version: "synthetic.v1", id: "synthetic-competition", title: "合成竞赛", detailPath: "/competitions/synthetic-competition",
      sections: [{ heading: "冻结目录说明", paragraphs: ["保留本次使用的历史范围"] }], sources: [] },
  };
  const conclusionRecord: DiscoveryPresentationRecord = { type: "conclusion", priorities: [{ cardKey: "synthetic", reason: "合成优先理由" }], note: "条件仍待核", exceptions: [] };
  const recordEvent = (presentationRecord: DiscoveryPresentationRecord) => ({ type: "text" as const, delta: presentationRecordMarkdown(presentationRecord), presentationRecord });

  it("fixes an explicitly selected card format per run even while the public default remains legacy", async () => {
    const value = await start("current");
    expect(value.report.snapshot.run).toMatchObject({ presentationVersion: DISCOVERY_PRESENTATION_VERSION, presentation: emptyDiscoveryPresentation() });
    expect(value.claim.body.presentationVersion).toBe(DISCOVERY_PRESENTATION_VERSION);
    const duplicate = await enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] }, { presentationVersion: "legacy" });
    expect(duplicate.created).toBe(false);
    expect(duplicate.snapshot.run?.presentationVersion).toBe(DISCOVERY_PRESENTATION_VERSION);
    expect(duplicate.snapshot.run?.runId).toBe(value.claim.row.run_id);
  });

  it("preserves an old missing-format run while a manual retry can use the new presentation", async () => {
    const value = await start();
    await appendDiscoveryRunEvent(value.claim, { type: "text", delta: "旧报告正文原样保留" });
    await appendDiscoveryRunEvent(value.claim, { type: "error", code: "DISCOVERY_NETWORK_ERROR" });
    expect((await getDiscoverySnapshot(value.resumeToken)).run).toMatchObject({ markdown: "旧报告正文原样保留" });
    expect((await getDiscoverySnapshot(value.resumeToken)).run?.presentationVersion).toBeUndefined();
    const retried = await enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] },
      { presentationVersion: DISCOVERY_PRESENTATION_VERSION });
    expect(retried.snapshot.run).toMatchObject({ presentationVersion: DISCOVERY_PRESENTATION_VERSION, presentation: emptyDiscoveryPresentation(), manualRetryOfRunId: value.claim.row.run_id });
    const oldRow = (await fixture.admin.query("select * from competition_discovery_runs where run_id=$1", [value.claim.row.run_id])).rows[0];
    const oldBody = unsealV7<DiscoveryRunBody>(`discovery-run:${oldRow.run_id}`, oldRow);
    expect(oldBody.markdown).toBe("旧报告正文原样保留");
    expect(oldBody.presentationVersion).toBeUndefined();
  });

  it("commits complete records, Markdown and event sequences together and recovers the same frozen detail", async () => {
    const value = await start("current");
    for (const record of [profileRecord, cardRecord, conclusionRecord]) await appendDiscoveryRunEvent(value.claim, recordEvent(record));
    await appendDiscoveryRunEvent(value.claim, { type: "complete", model: "deepseek-flash", webSearchUsed: false });
    const current = (await getDiscoverySnapshot(value.resumeToken)).run!;
    const events = await listDiscoveryEvents(value.resumeToken, 0, current.runId);
    expect(current.presentation).toMatchObject({ profile: profileRecord, cards: [cardRecord], conclusion: conclusionRecord });
    expect(current.markdown).toBe(discoveryPresentationMarkdown(current.presentation!));
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.filter(event => event.type === "text").map(event => event.presentationRecord)).toEqual([profileRecord, cardRecord, conclusionRecord]);
    expect(current.presentation?.cards[0].catalogDetail).toEqual(cardRecord.type === "card" ? cardRecord.catalogDetail : undefined);
    const row = (await fixture.admin.query("select * from competition_discovery_runs where run_id=$1", [current.runId])).rows[0];
    expect(unsealV7<DiscoveryRunBody>(`discovery-run:${row.run_id}`, row).presentation).toEqual(current.presentation);
    expect(row.ciphertext.toString("utf8")).not.toContain("合成画像摘要");
  });

  it("rolls back a record whose Markdown differs and refuses to complete a partial presentation", async () => {
    const value = await start("current");
    await expect(appendDiscoveryRunEvent(value.claim, { ...recordEvent(profileRecord), delta: "不一致的正文" })).rejects.toThrow("DISCOVERY_PRESENTATION_MARKDOWN_INVALID");
    expect((await getDiscoverySnapshot(value.resumeToken)).run).toMatchObject({ markdown: "", lastSeq: 0, presentation: emptyDiscoveryPresentation() });
    expect(await listDiscoveryEvents(value.resumeToken)).toEqual([]);
    await appendDiscoveryRunEvent(value.claim, recordEvent(profileRecord));
    await expect(appendDiscoveryRunEvent(value.claim, { type: "complete" })).rejects.toThrow("DISCOVERY_PRESENTATION_INCOMPLETE");
    expect((await getDiscoverySnapshot(value.resumeToken)).run).toMatchObject({ status: "running", lastSeq: 1, presentation: { profile: profileRecord, cards: [] } });
    await expect(appendDiscoveryRunEvent(value.claim, { type: "text", delta: "无结构的协议残片" })).rejects.toThrow("DISCOVERY_PRESENTATION_RECORD_REQUIRED");
    expect((await getDiscoverySnapshot(value.resumeToken)).run?.lastSeq).toBe(1);
  });

  it("persists the validated source URL projection in both the event and recovered presentation", async () => {
    const value = await start("current");
    await appendDiscoveryRunEvent(value.claim, recordEvent(profileRecord));
    const raw = { ...cardRecord, sources: [{ url: "https://EXAMPLE.org", title: "合成一手来源" }] };
    const normalized = persistedPresentationRecordSchema.parse(raw);
    const event = await appendDiscoveryRunEvent(value.claim, { type: "text", delta: presentationRecordMarkdown(normalized), presentationRecord: raw });
    if (event.type !== "text" || event.presentationRecord?.type !== "card") throw new Error("synthetic_card_event_expected");
    expect(event.presentationRecord.sources[0].url).toBe("https://example.org/");
    expect((await getDiscoverySnapshot(value.resumeToken)).run?.presentation?.cards[0].sources).toEqual(normalized.type === "card" ? normalized.sources : []);
    expect((await listDiscoveryEvents(value.resumeToken)).at(-1)).toMatchObject({ presentationRecord: event.presentationRecord, delta: event.delta });
  });

  it("clears all presentation output on reset while keeping the run's frozen format", async () => {
    const value = await start("current");
    await appendDiscoveryRunEvent(value.claim, recordEvent(profileRecord));
    await appendDiscoveryRunEvent(value.claim, recordEvent(cardRecord));
    await appendDiscoveryRunEvent(value.claim, { type: "sources", sources: [{ url: "https://example.org", title: "旧轮来源" }] });
    await appendDiscoveryRunEvent(value.claim, { type: "reset", attempt: 2, reason: "temporary_error", failureCode: "stream_incomplete" });
    expect((await getDiscoverySnapshot(value.resumeToken)).run).toMatchObject({ presentationVersion: DISCOVERY_PRESENTATION_VERSION,
      presentation: emptyDiscoveryPresentation(), markdown: "", sources: [], attempt: 2 });
    expect(value.claim.body.presentation).toEqual(emptyDiscoveryPresentation());
    expect((await listDiscoveryEvents(value.resumeToken)).filter(event => event.type === "text")).toHaveLength(2);
    await appendDiscoveryRunEvent(value.claim, recordEvent(profileRecord));
    await appendDiscoveryRunEvent(value.claim, recordEvent({ type: "conclusion", priorities: [], note: "没有可靠匹配依据", exceptions: [] }));
    await appendDiscoveryRunEvent(value.claim, { type: "complete" });
    expect((await getDiscoverySnapshot(value.resumeToken)).run?.presentation?.cards).toEqual([]);
  });

  it("serializes concurrent server submissions into eight slots, deduplicates active work and limits claims to four", async () => {
    const previousMode = process.env.SAITU_RUNTIME_MODE;
    process.env.SAITU_RUNTIME_MODE = "server";
    try {
      const sessions = await Promise.all(Array.from({ length: 12 }, () => {
        const value = input();
        for (const id of Object.keys(value.answers) as (keyof typeof value.answers)[]) {
          value.answers[id] = { status: "answered", values: [], text: "暂不确定。" };
        }
        return createDiscoverySession({ ...value, schemaVersion: DISCOVERY_SCHEMA_VERSION });
      }));
      const accepted = await Promise.allSettled(sessions.map(value => enqueueDiscoveryReport(value.resumeToken,
        { clientRequestId: randomUUID(), followupAnswers: [] })));
      expect(accepted.filter(value => value.status === "fulfilled")).toHaveLength(8);
      const rejected = accepted.filter((value): value is PromiseRejectedResult => value.status === "rejected");
      expect(rejected).toHaveLength(4);
      for (const value of rejected) expect(value.reason).toBeInstanceOf(Error);
      for (const value of rejected) expect(value.reason.message).toBe("DISCOVERY_BUSY");
      const acceptedIndex = accepted.findIndex(value => value.status === "fulfilled");
      const first = accepted[acceptedIndex];
      if (first.status !== "fulfilled") throw new Error("accepted_report_missing");
      const duplicate = await Promise.all(Array.from({ length: 5 }, () => enqueueDiscoveryReport(sessions[acceptedIndex].resumeToken,
        { clientRequestId: randomUUID(), followupAnswers: [] })));
      expect(duplicate.every(value => !value.created && value.snapshot.run?.runId === first.value.snapshot.run?.runId)).toBe(true);
      const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => claimDiscoveryRun(`parallel-server-${index}`)));
      expect(claims.filter(Boolean)).toHaveLength(4);
      const counts = (await fixture.admin.query(`select status,count(*)::int as count from competition_discovery_runs
        where status in ('queued','running') group by status`)).rows;
      expect(counts).toEqual(expect.arrayContaining([{ status: "running", count: 4 }, { status: "queued", count: 4 }]));
      const completed = claims.find(value => value !== null)!;
      await appendDiscoveryRunEvent(completed, { type: "error", code: "DISCOVERY_SYNTHETIC_END" });
      expect(await claimDiscoveryRun("parallel-server-replacement")).not.toBeNull();
      const rejectedIndex = accepted.findIndex(value => value.status === "rejected");
      expect((await enqueueDiscoveryReport(sessions[rejectedIndex].resumeToken,
        { clientRequestId: randomUUID(), followupAnswers: [] })).created).toBe(true);
    } finally {
      if (previousMode === undefined) delete process.env.SAITU_RUNTIME_MODE;
      else process.env.SAITU_RUNTIME_MODE = previousMode;
    }
  });
  async function persistInitialEffort(value: Awaited<ReturnType<typeof start>>, effort: "max" | "high") {
    // Build an explicit historical/current attempt independently of the chosen
    // new-session default; a high initial call is never fake max-timeout proof.
    value.claim.body.reasoningEffort = effort;
    value.claim.body.timeoutFallback = false;
    const sealed = sealV7(`discovery-run:${value.claim.row.run_id}`, value.claim.body);
    await fixture.admin.query("update competition_discovery_runs set ciphertext=$2,iv=$3,tag=$4 where run_id=$1",
      [value.claim.row.run_id, sealed.ciphertext, sealed.iv, sealed.tag]);
  }
  async function dispatchedAttempt(value: Awaited<ReturnType<typeof start>>, dispatched = true, effort: "max" | "high" = "max") {
    await persistInitialEffort(value, effort);
    const callId = discoveryModelInvocationId(value.claim.row.run_id, 1);
    await fixture.admin.query(`insert into ai_spend_ledger(id,run_id,model,effort,operation,price_version,reserved_micros,charged_micros,state,phase)
      values($1,$2,'deepseek-flash',$3,'competition_discovery_report','synthetic-test',1,1,'conservative','formal')`, [callId, discoverySpendRun, effort]);
    await fixture.admin.query(`insert into saitu_discovery_call_receipts(call_id,run_id,hard_deadline_at,dispatched_at)
      values($1,$2,$3,$4)`, [callId, discoverySpendRun, value.claim.row.deadline_at, dispatched ? new Date(Date.now() - 1000) : null]);
    return callId;
  }

  it.each(["max", "high"] as const)("persists the current %s effort across temporary failures without manufacturing timeout provenance", async effort => {
    const value = await start();
    await persistInitialEffort(value, effort);
    await appendDiscoveryRunEvent(value.claim, { type: "text", delta: "暂时中断的正文" });
    await appendDiscoveryRunEvent(value.claim, { type: "reset", attempt: 2, reason: "temporary_error", failureCode: "rate_limited" });
    const row = (await fixture.admin.query("select * from competition_discovery_runs where run_id=$1", [value.claim.row.run_id])).rows[0];
    expect(value.claim.body).toMatchObject({ reasoningEffort: effort, timeoutFallback: false, attempt: 2, markdown: "" });
    expect(unsealV7<DiscoveryRunBody>(`discovery-run:${row.run_id}`, row)).toMatchObject({ reasoningEffort: effort, timeoutFallback: false });
    expect(value.claim.body.inheritedMaxTimeout).toBeUndefined();
  });

  it.each(["max", "high"] as const)("persists high after an actual timeout reset from %s", async effort => {
    const value = await start();
    await persistInitialEffort(value, effort);
    await appendDiscoveryRunEvent(value.claim, { type: "reset", attempt: 2, reason: "timeout", failureCode: "timeout" });
    const row = (await fixture.admin.query("select * from competition_discovery_runs where run_id=$1", [value.claim.row.run_id])).rows[0];
    expect(unsealV7<DiscoveryRunBody>(`discovery-run:${row.run_id}`, row)).toMatchObject({ reasoningEffort: "high", timeoutFallback: true });
  });

  it("inherits high only from a same-input dispatched max timeout and preserves the auditable retry chain", async () => {
    const value = await start(), originalRunId = value.claim.row.run_id, callId = await dispatchedAttempt(value);
    const reset = await appendDiscoveryRunEvent(value.claim, { type: "reset", attempt: 2, reason: "timeout", failureCode: "timeout" });
    await appendDiscoveryRunEvent(value.claim, { type: "error", code: "DISCOVERY_TIMEOUT" });
    const retried = await enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] });
    const claim = await claimDiscoveryRun(`synthetic-manual-${randomUUID()}`);
    expect(claim?.row.run_id).toBe(retried.snapshot.run!.runId);
    expect(claim?.body).toMatchObject({ attempt: 1, reasoningEffort: "high", timeoutFallback: true, manualRetryOfRunId: originalRunId,
      inheritedMaxTimeout: { runId: originalRunId, callId, resetSeq: reset.seq }, webSearchUsed: false });
    expect(retried.snapshot.run).toMatchObject({ manualRetryOfRunId: originalRunId, maxTimeoutRunId: originalRunId });
    expect(claim!.row.deadline_at.getTime() - claim!.row.submitted_at.getTime()).toBe(180000);
    await appendDiscoveryRunEvent(claim!, { type: "reset", attempt: 2, reason: "temporary_error", failureCode: "network_error" });
    expect(claim!.body.reasoningEffort).toBe("high");
    expect(claim!.body.timeoutFallback).toBe(true);
    await appendDiscoveryRunEvent(claim!, { type: "error", code: "DISCOVERY_TIMEOUT" });
    const next = await enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] });
    const chained = await claimDiscoveryRun(`synthetic-chain-${randomUUID()}`);
    expect(chained?.row.run_id).toBe(next.snapshot.run!.runId);
    expect(chained?.body).toMatchObject({ reasoningEffort: "high", manualRetryOfRunId: claim!.row.run_id,
      inheritedMaxTimeout: { runId: originalRunId, callId, resetSeq: reset.seq } });
    const freshSession = await createDiscoverySession(input()), clarification = await claimDiscoveryClarification(freshSession.resumeToken, randomUUID());
    if (clarification.kind !== "claimed") throw new Error("missing_claim");
    await finishDiscoveryClarification(clarification.claim, { questions: [] });
    const fresh = await enqueueDiscoveryReport(freshSession.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] });
    expect(fresh.snapshot.run?.maxTimeoutRunId).toBeUndefined();
    const freshStored = (await fixture.admin.query("select * from competition_discovery_runs where run_id=$1", [fresh.snapshot.run!.runId])).rows[0];
    expect(unsealV7<DiscoveryRunBody>(`discovery-run:${fresh.snapshot.run!.runId}`, freshStored)).toMatchObject({
      reasoningEffort: DISCOVERY_RUNTIME_POLICY.initialEffort, timeoutFallback: false });
  });

  it.each(["no_receipt", "undispatched", "high_receipt", "no_reset", "authentication", "refusal"])("uses the configured initial effort for manual retry without eligible max-timeout proof (%s)", async scenario => {
    const value = await start();
    if (scenario !== "no_receipt") await dispatchedAttempt(value, scenario !== "undispatched", scenario === "high_receipt" ? "high" : "max");
    if (scenario !== "no_reset") await appendDiscoveryRunEvent(value.claim, { type: "reset", attempt: 2, reason: "timeout", failureCode: "timeout" });
    const code = scenario === "authentication" ? "DISCOVERY_AUTHENTICATION_ERROR" : scenario === "refusal" ? "DISCOVERY_REFUSAL" : "DISCOVERY_TIMEOUT";
    await appendDiscoveryRunEvent(value.claim, { type: "error", code });
    const retried = await enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] });
    const row = (await fixture.admin.query("select * from competition_discovery_runs where run_id=$1", [retried.snapshot.run!.runId])).rows[0];
    expect(unsealV7<DiscoveryRunBody>(`discovery-run:${row.run_id}`, row)).toMatchObject({ reasoningEffort: DISCOVERY_RUNTIME_POLICY.initialEffort, timeoutFallback: false });
    expect(retried.snapshot.run?.maxTimeoutRunId).toBeUndefined();
  });

  it.each(["failed", "cancelled"])("does not accept changed followup answers after a %s report", async status => {
    const created = await draftSession();
    const report = await enqueueDiscoveryReport(created.resumeToken, { clientRequestId: randomUUID(), followupAnswers: draftAnswers(["a"]) });
    await fixture.admin.query("update competition_discovery_runs set status=$2 where run_id=$1", [report.snapshot.run!.runId, status]);
    await expect(enqueueDiscoveryReport(created.resumeToken, { clientRequestId: randomUUID(), followupAnswers: draftAnswers(["b"]) })).rejects.toThrow("DISCOVERY_REQUEST_CHANGED");
    expect((await getDiscoverySnapshot(created.resumeToken)).run?.runId).toBe(report.snapshot.run!.runId);
    expect((await fixture.admin.query("select status from competition_discovery_runs where run_id=$1", [report.snapshot.run!.runId])).rows[0].status).toBe(status);
  });

  it("clears the current attempt's network marker on reset while retaining earlier tool events", async () => {
    const value = await start();
    await appendDiscoveryRunEvent(value.claim, { type: "tool", action: "search", status: "started" });
    expect((await getDiscoverySnapshot(value.resumeToken)).run?.webSearchUsed).toBe(true);
    await appendDiscoveryRunEvent(value.claim, { type: "text", delta: "上一轮正文" });
    await appendDiscoveryRunEvent(value.claim, { type: "reset", attempt: 2, reason: "temporary_error", failureCode: "network_error" });
    await appendDiscoveryRunEvent(value.claim, { type: "text", delta: "当前未联网的部分正文" });
    await appendDiscoveryRunEvent(value.claim, { type: "error", code: "DISCOVERY_TIMEOUT" });
    const result = await getDiscoverySnapshot(value.resumeToken), events = await listDiscoveryEvents(value.resumeToken);
    expect(result.run).toMatchObject({ markdown: "当前未联网的部分正文", webSearchUsed: false });
    expect(events.filter(event => event.type === "tool")).toHaveLength(1);
    expect(events.find(event => event.type === "tool")).toMatchObject({ action: "search", status: "started" });
  });
  const followups: DiscoveryFollowupQuestion[] = [
    { id: "focus", prompt: "更愿意尝试哪些任务？", selection: "multiple", maxSelections: 2, exclusiveValues: ["unknown"],
      options: [{ value: "a", label: "方向一" }, { value: "b", label: "方向二" }, { value: "unknown", label: "不确定" }] },
    { id: "support", prompt: "是否有已确认支持？", selection: "single", maxSelections: 1,
      options: [{ value: "yes", label: "已有明确支持" }, { value: "none", label: "明确没有支持" }, { value: "unknown", label: "尚不确定" }] }
  ];
  const draftAnswers = (values = ["a"]): DiscoveryFollowupAnswer[] => [
    { questionId: "focus", status: values.length ? "answered" : "skipped", values },
    { questionId: "support", status: "skipped", values: [] }
  ];
  async function draftSession() {
    const created = await createDiscoverySession(input());
    const clarification = await claimDiscoveryClarification(created.resumeToken, randomUUID());
    if (clarification.kind !== "claimed") throw new Error("synthetic_claim_expected");
    await finishDiscoveryClarification(clarification.claim, { questions: followups });
    return created;
  }

  it("keeps late supplemental edits for 24 hours, encrypted, without creating model work", async () => {
    const created = await draftSession();
    await fixture.admin.query("update competition_discovery_sessions set created_at=now()-interval '23 hours',expires_at=now()+interval '10 minutes' where session_id=$1", [created.snapshot.sessionId]);
    const spendBefore = (await fixture.admin.query("select count(*)::int as count from ai_spend_ledger")).rows[0].count;
    const editedAt = new Date().toISOString(), answers = draftAnswers();
    const saved = await saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: answers, editedAt });
    expect(saved.followupEditedAt).toBe(editedAt);
    expect(saved.followupAnswers).toEqual(answers);
    expect(Date.parse(saved.expiresAt)).toBe(Date.parse(editedAt) + DISCOVERY_RETENTION_MS);
    expect(saved.run).toBeNull();
    const row = (await fixture.admin.query("select * from competition_discovery_sessions where session_id=$1", [created.snapshot.sessionId])).rows[0];
    const body = unsealV7<DiscoverySessionBody>(`discovery-session:${created.snapshot.sessionId}`, row);
    expect(body.followupAnswers).toEqual(answers); expect(body.followupEditedAt).toBe(editedAt);
    expect(row.ciphertext.toString("utf8")).not.toContain("followupAnswers");
    expect((await getDiscoverySnapshot(created.resumeToken)).followupAnswers).toEqual(answers);
    expect((await fixture.admin.query("select count(*)::int as count from competition_discovery_runs where session_id=$1", [created.snapshot.sessionId])).rows[0].count).toBe(0);
    expect((await fixture.admin.query("select count(*)::int as count from ai_spend_ledger")).rows[0].count).toBe(spendBefore);
  });

  it("acknowledges an initial answer changed back to skipped and allows report submission", async () => {
    const created = await draftSession(), initial = await getDiscoverySnapshot(created.resumeToken);
    const state: DiscoveryBrowserState = { ...emptyDiscoveryBrowserState(), phase: "followups", snapshot: initial,
      expiresAt: initial.expiresAt, followupAnswers: initial.followupAnswers,
      session: { sessionId: initial.sessionId, resumeToken: created.resumeToken, expiresAt: initial.expiresAt, runId: null } };
    const selected = changeDiscoveryFollowup(state, draftAnswers()[0]);
    const skipped = changeDiscoveryFollowup(selected, draftAnswers([])[0]);
    const request = discoveryFollowupSaveRequest(skipped);
    expect(request).not.toBeNull();
    const saved = await saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: request!.answers, editedAt: request!.editedAt });
    expect(saved.followupAnswers).toEqual(draftAnswers([]));
    expect(saved.expiresAt).toBe(initial.expiresAt); expect(saved.followupEditedAt).toBeUndefined();
    const stored = (await fixture.admin.query("select * from competition_discovery_sessions where session_id=$1", [initial.sessionId])).rows[0];
    expect(unsealV7<DiscoverySessionBody>(`discovery-session:${initial.sessionId}`, stored).followupAnswers).toEqual([]);
    const acknowledged = acknowledgeDiscoveryFollowupSave(skipped, request!, saved);
    expect(acknowledged).not.toBeNull();
    expect(discoveryFollowupSaveRequest(acknowledged!)).toBeNull();
    const report = await enqueueDiscoveryReport(created.resumeToken, { clientRequestId: randomUUID(), followupAnswers: acknowledged!.followupAnswers });
    expect(report.created).toBe(true);
    expect(report.snapshot.followupAnswers).toEqual(draftAnswers([]));
  });

  it("ignores old or repeated edits and reordered multiple selections without extending retention", async () => {
    const created = await draftSession();
    await fixture.admin.query("update competition_discovery_sessions set expires_at=now()+interval '10 minutes' where session_id=$1", [created.snapshot.sessionId]);
    const editedAt = new Date(Date.now() - 3000).toISOString(), followupAnswers = draftAnswers(["a", "b"]);
    const first = await saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers, editedAt });
    const before = (await fixture.admin.query("select ciphertext,expires_at,updated_at from competition_discovery_sessions where session_id=$1", [created.snapshot.sessionId])).rows[0];
    for (const input of [
      { followupAnswers: draftAnswers(["b"]), editedAt },
      { followupAnswers: draftAnswers(["b"]), editedAt: new Date(Date.parse(editedAt) - 1000).toISOString() },
      { followupAnswers: [...draftAnswers(["b", "a"])].reverse(), editedAt: new Date(Date.now()).toISOString() }
    ]) {
      const duplicate = await saveDiscoveryFollowupDraft(created.resumeToken, input);
      expect(duplicate.followupAnswers).toEqual(followupAnswers);
      expect(duplicate.expiresAt).toBe(first.expiresAt);
      expect(duplicate.followupEditedAt).toBe(editedAt);
    }
    const after = (await fixture.admin.query("select ciphertext,expires_at,updated_at from competition_discovery_sessions where session_id=$1", [created.snapshot.sessionId])).rows[0];
    expect(after.expires_at).toEqual(before.expires_at);
  });

  it("fences a delayed changed edit after a newer no-op without changing edit time or expiry", async () => {
    const created = await draftSession(), now = Date.now();
    const firstAt = new Date(now - 30_000).toISOString(), staleAt = new Date(now - 25_000).toISOString(), noOpAt = new Date(now - 20_000).toISOString();
    const first = await saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: draftAnswers(["a"]), editedAt: firstAt });
    const readBody = async () => unsealV7<DiscoverySessionBody>(`discovery-session:${created.snapshot.sessionId}`,
      (await fixture.admin.query("select * from competition_discovery_sessions where session_id=$1", [created.snapshot.sessionId])).rows[0]);
    const initialBody = await readBody();
    const noOp = await saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: draftAnswers(["a"]), editedAt: noOpAt });
    expect(noOp.followupEditedAt).toBe(firstAt); expect(noOp.expiresAt).toBe(first.expiresAt);
    expect(await readBody()).toEqual({ ...initialBody, followupDraftRequestAt: noOpAt });
    const delayed = await saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: draftAnswers(["b"]), editedAt: staleAt });
    expect(delayed.followupAnswers).toEqual(draftAnswers(["a"]));
    expect(delayed.followupEditedAt).toBe(firstAt); expect(delayed.expiresAt).toBe(first.expiresAt);
    expect(await readBody()).toEqual({ ...initialBody, followupDraftRequestAt: noOpAt });
  });

  it("accepts a report just before draft expiry and protects the active run from draft cleanup", async () => {
    const created = await draftSession();
    await fixture.admin.query("update competition_discovery_sessions set expires_at=now()+interval '1 second' where session_id=$1", [created.snapshot.sessionId]);
    const result = await enqueueDiscoveryReport(created.resumeToken, { clientRequestId: randomUUID(), followupAnswers: draftAnswers() }, { presentationVersion: "legacy" });
    expect(result.created).toBe(true);
    expect(Date.parse(result.snapshot.expiresAt)).toBeGreaterThanOrEqual(Date.parse(result.snapshot.run!.deadlineAt) + DISCOVERY_RETENTION_MS);
    await fixture.admin.query("select pg_sleep(1.05)");
    await expireDiscoverySessions();
    const stored = (await fixture.admin.query("select status,expires_at,ciphertext is not null as retained from competition_discovery_runs where run_id=$1", [result.snapshot.run!.runId])).rows[0];
    expect(stored.status).toBe("queued"); expect(stored.retained).toBe(true);
    expect(stored.expires_at.toISOString()).toBe(result.snapshot.expiresAt);
    const claim = await claimDiscoveryRun(`synthetic-near-expiry-${randomUUID()}`);
    expect(claim?.row.run_id).toBe(result.snapshot.run!.runId);
    await appendDiscoveryRunEvent(claim!, { type: "complete" });
    const completed = await getDiscoverySnapshot(created.resumeToken);
    expect(Date.parse(completed.expiresAt)).toBeGreaterThanOrEqual(Date.now() + DISCOVERY_RETENTION_MS - 1000);
    expect(Date.parse(completed.expiresAt)).toBeLessThanOrEqual(Date.now() + DISCOVERY_RETENTION_MS);
  });

  it("validates stored question identity, every answer, exclusivity and edit time before changing a draft", async () => {
    const created = await draftSession();
    const before = (await fixture.admin.query("select ciphertext,expires_at from competition_discovery_sessions where session_id=$1", [created.snapshot.sessionId])).rows[0];
    const invalid = [draftAnswers().slice(0, 1), draftAnswers(["invented"]), draftAnswers(["a", "unknown"]),
      [{ questionId: "other", status: "skipped", values: [] }, draftAnswers()[1]]];
    for (const answers of invalid) await expect(saveDiscoveryFollowupDraft(created.resumeToken, {
      followupAnswers: answers as DiscoveryFollowupAnswer[], editedAt: new Date().toISOString()
    })).rejects.toThrow("DISCOVERY_FOLLOWUP_INVALID");
    for (const editedAt of ["not-a-date", new Date(Date.now() + 120_000).toISOString(), new Date(Date.now() - 120_000).toISOString()]) {
      await expect(saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: draftAnswers(), editedAt })).rejects.toThrow("DISCOVERY_DRAFT_TIME_INVALID");
    }
    expect((await fixture.admin.query("select ciphertext,expires_at from competition_discovery_sessions where session_id=$1", [created.snapshot.sessionId])).rows[0]).toEqual(before);
  });

  it("bounds small future clock skew and deduplicates the original client edit timestamp", async () => {
    const created = await draftSession();
    await fixture.admin.query("update competition_discovery_sessions set expires_at=now()+interval '10 minutes' where session_id=$1", [created.snapshot.sessionId]);
    const before = Date.now(), editedAt = new Date(before + 30_000).toISOString();
    const saved = await saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: draftAnswers(), editedAt });
    expect(Date.parse(saved.followupEditedAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(saved.expiresAt)).toBeLessThanOrEqual(Date.now() + DISCOVERY_RETENTION_MS);
    const repeated = await saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: draftAnswers(["b"]), editedAt });
    expect(repeated.followupAnswers).toEqual(saved.followupAnswers);
    expect(repeated.expiresAt).toBe(saved.expiresAt);
  });

  it("does not save during clarification or revive an expired or deleted draft", async () => {
    const pending = await createDiscoverySession(input());
    await expect(saveDiscoveryFollowupDraft(pending.resumeToken, { followupAnswers: [], editedAt: new Date().toISOString() })).rejects.toThrow("DISCOVERY_DRAFT_NOT_READY");
    await claimDiscoveryClarification(pending.resumeToken, randomUUID());
    await expect(saveDiscoveryFollowupDraft(pending.resumeToken, { followupAnswers: [], editedAt: new Date().toISOString() })).rejects.toThrow("DISCOVERY_DRAFT_NOT_READY");
    for (const status of ["expired", "deleted"]) {
      const created = await draftSession();
      if (status === "expired") await fixture.admin.query("update competition_discovery_sessions set expires_at=now()-interval '1 second' where session_id=$1", [created.snapshot.sessionId]);
      else await deleteDiscoverySession(created.resumeToken);
      await expect(saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: draftAnswers(), editedAt: new Date().toISOString() })).rejects.toThrow("DISCOVERY_SESSION_EXPIRED");
    }
  });

  it("does not revive a draft that expires while its save waits for the session lock", async () => {
    const created = await draftSession(), blocker = await getPool().connect();
    await fixture.admin.query("update competition_discovery_sessions set expires_at=now()+interval '100 milliseconds' where session_id=$1", [created.snapshot.sessionId]);
    try {
      await blocker.query("begin");
      await blocker.query("select 1 from competition_discovery_sessions where session_id=$1 for update", [created.snapshot.sessionId]);
      const pending = expect(saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: draftAnswers(), editedAt: new Date().toISOString() })).rejects.toThrow("DISCOVERY_SESSION_EXPIRED");
      await fixture.admin.query("select pg_sleep(0.15)");
      await blocker.query("commit");
      await pending;
      const row = (await fixture.admin.query("select expires_at from competition_discovery_sessions where session_id=$1", [created.snapshot.sessionId])).rows[0];
      expect(row.expires_at.getTime()).toBeLessThan(Date.now());
    } finally { await blocker.query("rollback"); blocker.release(); }
  });

  it.each(["queued", "running", "complete", "cancelled", "failed"])("does not edit or extend a %s report session", async status => {
    const created = await draftSession();
    const report = await enqueueDiscoveryReport(created.resumeToken, { clientRequestId: randomUUID(), followupAnswers: draftAnswers() });
    await fixture.admin.query("update competition_discovery_runs set status=$2 where run_id=$1", [report.snapshot.run!.runId, status]);
    const before = (await fixture.admin.query("select ciphertext,expires_at from competition_discovery_sessions where session_id=$1", [created.snapshot.sessionId])).rows[0];
    await expect(saveDiscoveryFollowupDraft(created.resumeToken, { followupAnswers: draftAnswers(["b"]), editedAt: new Date().toISOString() })).rejects.toThrow("DISCOVERY_REPORT_ALREADY_CREATED");
    expect((await fixture.admin.query("select ciphertext,expires_at from competition_discovery_sessions where session_id=$1", [created.snapshot.sessionId])).rows[0]).toEqual(before);
  });


  it("atomically deduplicates creation, rejects changed input, and performs recovery lookup without creating work", async () => {
    const value = input(), results = await Promise.all([createDiscoverySession(value), createDiscoverySession(value)]);
    expect(results.map(result => result.created).sort()).toEqual([false, true]);
    expect(results[0].snapshot.sessionId).toBe(results[1].snapshot.sessionId); expect(results[0].resumeToken).toBe(results[1].resumeToken);
    await expect(createDiscoverySession({ ...value, additionalText: "不同输入" })).rejects.toThrow("DISCOVERY_REQUEST_CHANGED");
    const recovered = await findDiscoverySessionBySubmission(value);
    expect(recovered?.snapshot.sessionId).toBe(results[0].snapshot.sessionId);
    expect(await findDiscoverySessionBySubmission({ ...value, clientRequestId: randomUUID() })).toBeNull();
    const count = (await fixture.admin.query("select count(*)::int as count from competition_discovery_runs where session_id=$1", [results[0].snapshot.sessionId])).rows[0].count;
    expect(count).toBe(0);
    expect(verifyDiscoveryResumeToken(results[0].resumeToken.slice(0, -1) + (results[0].resumeToken.endsWith("A") ? "B" : "A"))).toBeNull();
  });
  it("allows only one clarification claimant and makes its answer available to duplicate submissions", async () => {
    const created = await createDiscoverySession(input());
    const results = await Promise.all([claimDiscoveryClarification(created.resumeToken, randomUUID()), claimDiscoveryClarification(created.resumeToken, randomUUID())]);
    expect(results.map(result => result.kind).sort()).toEqual(["claimed", "in_progress"]);
    const first = results.find(result => result.kind === "claimed"); if (first?.kind !== "claimed") throw new Error("missing_claim");
    expect(first.claim.deadlineEpochMs - Date.now()).toBeLessThanOrEqual(30000);
    await finishDiscoveryClarification(first.claim, { questions: [] });
    expect((await claimDiscoveryClarification(created.resumeToken, randomUUID())).kind).toBe("complete");
    await expect(finishDiscoveryClarification(first.claim, { questions: [] })).rejects.toThrow("DISCOVERY_LEASE_LOST");
  });
  it("rejects a stored consent version that is no longer current before enqueue", async () => {
    const created = await createDiscoverySession({ ...input(), consentVersion: "old-synthetic-consent" });
    const clarification = await claimDiscoveryClarification(created.resumeToken, randomUUID());
    if (clarification.kind !== "claimed") throw new Error("missing_claim");
    await finishDiscoveryClarification(clarification.claim, { questions: [] });
    await expect(enqueueDiscoveryReport(created.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] })).rejects.toThrow("DISCOVERY_CONSENT_CHANGED");
  });
  it("serializes concurrent events, replays from a cursor, and checks the run belongs to the token", async () => {
    const value = await start();
    const reportAgain = await enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] });
    expect(reportAgain.created).toBe(false); expect(reportAgain.snapshot.run?.runId).toBe(value.claim.row.run_id);
    await Promise.all([appendDiscoveryRunEvent(value.claim, { type: "text", delta: "中文" }), appendDiscoveryRunEvent(value.claim, { type: "text", delta: "正文" })]);
    await appendDiscoveryRunEvent(value.claim, { type: "sources", sources: [{ url: "https://example.org/official", title: "合成官方来源" }] });
    await appendDiscoveryRunEvent(value.claim, { type: "complete", model: "deepseek-flash", webSearchUsed: true });
    const current = await getDiscoverySnapshot(value.resumeToken), events = await listDiscoveryEvents(value.resumeToken, 1, value.claim.row.run_id);
    expect(current.run).toMatchObject({ status: "complete", lastSeq: 4, model: "deepseek-flash", webSearchUsed: true });
    const textEvents = (await listDiscoveryEvents(value.resumeToken, 0, value.claim.row.run_id)).flatMap(event => event.type === "text" ? [event.delta] : []);
    expect([...textEvents].sort()).toEqual(["中文", "正文"].sort());
    expect(current.run?.markdown).toBe(textEvents.join(""));
    await expect(enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] })).rejects.toThrow("DISCOVERY_ALREADY_COMPLETE");
    expect(events.map(event => event.seq)).toEqual([2, 3, 4]);
    await expect(listDiscoveryEvents(value.resumeToken, 0, randomUUID())).rejects.toThrow("DISCOVERY_RUN_NOT_FOUND");
    const other = await createDiscoverySession(input());
    await expect(listDiscoveryEvents(other.resumeToken, 0, value.claim.row.run_id)).rejects.toThrow("DISCOVERY_RUN_NOT_FOUND");
  });
  it("retains terminal results for 24 hours and accepts the original signed recovery token", async () => {
    const value = await start(), initialExpiry = verifyDiscoveryResumeToken(value.resumeToken)!.expiresAt;
    // Moving the server expiry proves the token's initial-expiry metadata is not authoritative.
    await fixture.admin.query("update competition_discovery_sessions set expires_at=now()+interval '10 minutes' where session_id=$1", [value.snapshot.sessionId]);
    await appendDiscoveryRunEvent(value.claim, { type: "text", delta: "完整报告" });
    const completedAt = Date.now();
    await appendDiscoveryRunEvent(value.claim, { type: "complete" });
    const current = await getDiscoverySnapshot(value.resumeToken), expiry = Date.parse(current.expiresAt);
    expect(expiry).toBeGreaterThanOrEqual(completedAt + DISCOVERY_RETENTION_MS);
    expect(expiry).toBeGreaterThanOrEqual(initialExpiry);
    expect(value.claim.row.expires_at.getTime()).toBe(expiry);
    expect(verifyDiscoveryResumeToken(value.resumeToken)?.sessionId).toBe(value.snapshot.sessionId);
  });
  it("restores seven bare HTTP sources from a stored completed report without rewriting data or search status", async () => {
    const value = await start();
    const urls = Array.from({ length: 7 }, (_, index) => `http://example.org/competition-${index + 1}`);
    const markdown = `已有报告原文，来源为正文中的裸链接。\n${urls.map((url, index) => `${index + 1}. ${url}`).join("\n")}`;
    await appendDiscoveryRunEvent(value.claim, { type: "text", delta: markdown });
    await appendDiscoveryRunEvent(value.claim, { type: "complete", model: "deepseek-flash", webSearchUsed: false });
    const readStored = async () => (await fixture.admin.query("select ciphertext,iv,tag,next_event_seq,updated_at from competition_discovery_runs where run_id=$1", [value.claim.row.run_id])).rows[0];
    const readEvents = async () => (await fixture.admin.query("select seq,ciphertext,iv,tag,created_at from competition_discovery_events where run_id=$1 order by seq", [value.claim.row.run_id])).rows;
    const before = await readStored(), eventsBefore = await readEvents();
    const ledgerBefore = (await getPool().query("select count(*)::int as count from ai_spend_ledger")).rows[0].count;
    const original = unsealV7<DiscoveryRunBody>(`discovery-run:${value.claim.row.run_id}`, before);
    expect(original.sources).toEqual([]); expect(original.markdown).toBe(markdown); expect(original.webSearchUsed).toBe(false);
    const returned = (await getDiscoverySnapshot(value.resumeToken)).run;
    expect(returned).toMatchObject({ status: "complete", markdown, webSearchUsed: false, lastSeq: 2 });
    expect(returned?.sources.map(source => source.url)).toEqual(urls);
    expect(await readStored()).toEqual(before); expect(await readEvents()).toEqual(eventsBefore);
    expect((await getPool().query("select count(*)::int as count from ai_spend_ledger")).rows[0].count).toBe(ledgerBefore);
  });
  it("merges recovered links with saved sources by canonical URL while retaining the saved title", async () => {
    const value = await start();
    const markdown = "已保存来源和正文中的同一个裸链接：http://example.org\n新增正文链接：http://example.org/news?id=1。";
    await appendDiscoveryRunEvent(value.claim, { type: "text", delta: markdown });
    await appendDiscoveryRunEvent(value.claim, { type: "sources", sources: [{ url: "http://example.org/", title: "保留原来源标题" }] });
    await appendDiscoveryRunEvent(value.claim, { type: "complete", webSearchUsed: false });
    const returned = (await getDiscoverySnapshot(value.resumeToken)).run;
    expect(returned?.sources).toEqual([
      { url: "http://example.org/", title: "保留原来源标题" },
      { url: "http://example.org/news?id=1", title: "http://example.org/news?id=1" },
    ]);
    expect(returned?.markdown).toBe(markdown); expect(returned?.webSearchUsed).toBe(false);
  });
  it("withdraws refused text from both the current report and old event ciphertext", async () => {
    const value = await start();
    await appendDiscoveryRunEvent(value.claim, { type: "text", delta: "应撤回的片段" });
    await appendDiscoveryRunEvent(value.claim, { type: "sources", sources: [{ title: "撤回来源", url: "https://example.org" }] });
    await appendDiscoveryRunEvent(value.claim, { type: "reset", attempt: 1, reason: "withdrawn" });
    await appendDiscoveryRunEvent(value.claim, { type: "error", code: "DISCOVERY_REFUSAL" });
    expect((await getDiscoverySnapshot(value.resumeToken)).run).toMatchObject({ markdown: "", sources: [], status: "failed", error: "DISCOVERY_REFUSAL" });
    const rows = (await fixture.admin.query("select seq::int,redacted,ciphertext is null as cleared from competition_discovery_events where run_id=$1 order by seq", [value.claim.row.run_id])).rows;
    expect(rows.slice(0, 2)).toEqual([{ seq: 1, redacted: true, cleared: true }, { seq: 2, redacted: true, cleared: true }]);
    expect((await listDiscoveryEvents(value.resumeToken)).map(event => event.type)).toEqual(["reset", "error"]);
  });
  it("cancels and clears idempotently while fencing a late worker write", async () => {
    const value = await start();
    const costId = randomUUID(), budgetId = `synthetic-preserved-${randomUUID()}`;
    await fixture.admin.query("insert into ai_spend_budgets(run_id,hard_limit_micros) values($1,1000000)", [budgetId]);
    await fixture.admin.query(`insert into ai_spend_ledger(id,run_id,model,effort,operation,price_version,reserved_micros,charged_micros,state,phase)
      values($1,$2,'deepseek-flash','max','competition_discovery_report','synthetic-test',17,17,'conservative','formal')`, [costId, budgetId]);
    await appendDiscoveryRunEvent(value.claim, { type: "text", delta: "未完成" });
    const cancelled = await cancelDiscoveryRun(value.resumeToken);
    expect(cancelled.run?.status).toBe("cancelled"); expect(await renewDiscoveryRunLease(value.claim)).toBe(false);
    await expect(appendDiscoveryRunEvent(value.claim, { type: "complete" })).rejects.toThrow("DISCOVERY_LEASE_LOST");
    await deleteDiscoverySession(value.resumeToken); await deleteDiscoverySession(value.resumeToken);
    await expect(getDiscoverySnapshot(value.resumeToken)).rejects.toThrow("DISCOVERY_SESSION_EXPIRED");
    const remaining = (await fixture.admin.query("select count(*)::int as count from competition_discovery_events where run_id=$1 and ciphertext is not null", [value.claim.row.run_id])).rows[0].count;
    expect(remaining).toBe(0);
    expect((await fixture.admin.query("select charged_micros::int as charged,state from ai_spend_ledger where id=$1", [costId])).rows[0]).toEqual({ charged: 17, state: "conservative" });
  });
  it("avoids lock-order deadlocks when completion races cancellation or clear", async () => {
    for (const clear of [false, true]) {
      const value = await start(); await appendDiscoveryRunEvent(value.claim, { type: "text", delta: "正文" });
      const results = await Promise.allSettled([appendDiscoveryRunEvent(value.claim, { type: "complete" }), clear ? deleteDiscoverySession(value.resumeToken) : cancelDiscoveryRun(value.resumeToken)]);
      expect(results[1].status).toBe("fulfilled");
      for (const result of results) if (result.status === "rejected") expect(result.reason.message).toBe("DISCOVERY_LEASE_LOST");
      if (!clear) expect(["complete", "cancelled"]).toContain((await getDiscoverySnapshot(value.resumeToken)).run?.status);
    }
  });
  it("redacts expired sessions and never expires the old spend ledger", async () => {
    const previousSpend = (await getPool().query("select count(*)::int as count from ai_spend_ledger")).rows[0].count;
    const value = await start(); await appendDiscoveryRunEvent(value.claim, { type: "text", delta: "待清理" });
    await fixture.admin.query("update competition_discovery_sessions set expires_at=now()-interval '1 second' where session_id=$1", [value.snapshot.sessionId]);
    expect(await expireDiscoverySessions()).toBeGreaterThanOrEqual(1);
    const row = (await fixture.admin.query("select status,ciphertext is null as cleared from competition_discovery_runs where run_id=$1", [value.claim.row.run_id])).rows[0];
    expect(row).toEqual({ status: "expired", cleared: true });
    await expect(getDiscoverySnapshot(value.resumeToken)).rejects.toThrow("DISCOVERY_SESSION_EXPIRED");
    expect((await getPool().query("select count(*)::int as count from ai_spend_ledger")).rows[0].count).toBe(previousSpend);
  });
});

integration("discovery private generation protocol registration", () => {
  const original = { ...process.env }, globals = globalThis as typeof globalThis & { __pgPool?: pg.Pool };
  let fixture: Awaited<ReturnType<typeof createV7TestDatabase>>;
  beforeAll(async () => {
    fixture = await createV7TestDatabase("backend");
    await fixture.admin.query(readFileSync("db/migrations/20261119_competition_discovery.sql", "utf8"));
    const role = decodeURIComponent(new URL(fixture.runtimeUrl).username);
    for (const table of ["competition_discovery_sessions", "competition_discovery_runs", "competition_discovery_events"])
      await fixture.admin.query(`grant select,insert,update on ${table} to "${role}"`);
    await globals.__pgPool?.end(); delete globals.__pgPool;
    Object.assign(process.env, { DATABASE_URL: fixture.runtimeUrl, AI_CONVERSATION_SIGNING_SECRET: randomUUID() + randomUUID(), AI_API_KEY: "", SAITU_RUNTIME_MODE: "local" });
  }, 30000);
  afterEach(async () => {
    await fixture.admin.query("update competition_discovery_runs set status='cancelled',lease_owner=null,lease_expires_at=null where status in ('queued','running')");
  });
  afterAll(async () => {
    await globals.__pgPool?.end(); delete globals.__pgPool;
    await fixture?.close(); process.env = { ...original };
  });
  async function ready() {
    const answers = createEmptyDiscoveryAnswers();
    for (const id of Object.keys(answers) as (keyof typeof answers)[]) answers[id] = { status: "answered", values: [], text: "暂不确定。" };
    const text = "合成协议登记目录", catalogSnapshot: DiscoveryCatalogSnapshot = { version: "synthetic-protocol.v1", count: 1, ids: ["synthetic-protocol"],
      text, clarifyText: text, byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
    const session = await createDiscoverySession({ schemaVersion: DISCOVERY_SCHEMA_VERSION, answers, additionalText: "", catalogSnapshot,
      consentVersion: DISCOVERY_CONSENT_VERSION, clientRequestId: randomUUID() });
    return { ...session, answers, catalogSnapshot };
  }

  it.each(["local", "server"])("defaults a new %s report to legacy without changing the complete questionnaire", async mode => {
    const previousMode = process.env.SAITU_RUNTIME_MODE;
    process.env.SAITU_RUNTIME_MODE = mode;
    try {
      const value = await ready();
      expect(value.snapshot).toMatchObject({ schemaVersion: DISCOVERY_SCHEMA_VERSION, status: "ready",
        answers: value.answers, followups: [], followupAnswers: [], clarificationStatus: "complete" });
      const report = await enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] });
      expect(report.snapshot.answers).toEqual(value.answers);
      expect(report.snapshot.followups).toEqual([]);
      expect(report.snapshot.run?.presentationVersion).toBeUndefined();
      expect(report.snapshot.run?.presentation).toBeUndefined();
      const claim = await claimDiscoveryRun(`synthetic-default-${randomUUID()}`);
      expect(claim?.row.run_id).toBe(report.snapshot.run?.runId);
      expect(claim?.body.presentationVersion).toBeUndefined();
      expect(claim?.body.protocolVersion).toBeUndefined();
      expect(claim?.session.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
      expect(claim?.session.answers).toEqual(value.answers);
      if (!claim) throw new Error("synthetic_default_claim_expected");
      await appendDiscoveryRunEvent(claim, { type: "text", delta: "普通报告保留原Markdown正文" });
      await appendDiscoveryRunEvent(claim, { type: "complete", model: "deepseek-flash" });
      const recovered = await getDiscoverySnapshot(value.resumeToken);
      expect(recovered.run).toMatchObject({ status: "complete", markdown: "普通报告保留原Markdown正文" });
      expect(recovered.run?.presentationVersion).toBeUndefined();
    } finally {
      if (previousMode === undefined) delete process.env.SAITU_RUNTIME_MODE;
      else process.env.SAITU_RUNTIME_MODE = previousMode;
    }
  });

  it("keeps card generation available only through an explicit internal presentation choice", async () => {
    const value = await ready();
    await expect(enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] },
      { protocolVersion: "refs" })).rejects.toThrow("DISCOVERY_GENERATION_PROTOCOL_INVALID");
    const report = await enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] },
      { presentationVersion: DISCOVERY_PRESENTATION_VERSION });
    expect(report.snapshot.run).toMatchObject({ presentationVersion: DISCOVERY_PRESENTATION_VERSION, presentation: emptyDiscoveryPresentation() });
    const claim = await claimDiscoveryRun(`synthetic-explicit-card-${randomUUID()}`);
    expect(claim?.body).toMatchObject({ presentationVersion: DISCOVERY_PRESENTATION_VERSION, protocolVersion: "v16" });
    expect((await getDiscoverySnapshot(value.resumeToken)).run).toMatchObject({
      presentationVersion: DISCOVERY_PRESENTATION_VERSION, presentation: emptyDiscoveryPresentation(),
    });
    expect(report.snapshot.answers).toEqual(value.answers);
  });

  it("encrypts the selected protocol per run without publishing it or changing it on duplicate enqueue", async () => {
    const value = await ready(), clientRequestId = randomUUID();
    const report = await enqueueDiscoveryReport(value.resumeToken, { clientRequestId, followupAnswers: [] },
      { presentationVersion: DISCOVERY_PRESENTATION_VERSION, protocolVersion: "refs" });
    const runId = report.snapshot.run!.runId;
    const row = (await fixture.admin.query("select * from competition_discovery_runs where run_id=$1", [runId])).rows[0];
    expect(unsealV7<DiscoveryRunBody>(`discovery-run:${runId}`, row)).toMatchObject({ protocolVersion: "refs", presentationVersion: DISCOVERY_PRESENTATION_VERSION });
    expect(row.ciphertext.toString("utf8")).not.toContain('"protocolVersion"');
    expect(Object.hasOwn(report.snapshot.run!, "protocolVersion")).toBe(false);
    expect(Object.hasOwn((await getDiscoverySnapshot(value.resumeToken)).run!, "protocolVersion")).toBe(false);
    let registeredAgain = false;
    const duplicate = await enqueueDiscoveryReport(value.resumeToken, { clientRequestId, followupAnswers: [] }, {
      presentationVersion: DISCOVERY_PRESENTATION_VERSION, protocolVersion: "blocks", onPrepared: async () => { registeredAgain = true; },
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.snapshot.run!.runId).toBe(runId);
    expect(registeredAgain).toBe(false);
    const claimed = await claimDiscoveryRun(`synthetic-protocol-${randomUUID()}`);
    expect(claimed?.body.protocolVersion).toBe("refs");
  });

  it("awaits private registration before another database connection can observe or claim the task", async () => {
    const value = await ready();
    let entered: () => void = () => undefined, release: () => void = () => undefined;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    let preparedRunId: string | undefined;
    const pending = enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] }, {
      presentationVersion: DISCOVERY_PRESENTATION_VERSION, protocolVersion: "json-optimized", onPrepared: async prepared => {
        preparedRunId = prepared.runId;
        expect(prepared).toMatchObject({ answers: value.answers, additionalText: "", followups: [], catalogSha256: value.catalogSnapshot.sha256 });
        entered();
        await releasePromise;
      },
    });
    try {
      await Promise.race([enteredPromise, pending.then(() => { throw new Error("synthetic_registration_was_not_awaited"); })]);
      expect(preparedRunId).toMatch(/^[a-f0-9-]{36}$/u);
      expect((await fixture.admin.query("select run_id from competition_discovery_runs where run_id=$1", [preparedRunId])).rowCount).toBe(0);
      expect((await fixture.admin.query("select current_run_id from competition_discovery_sessions where session_id=$1", [value.snapshot.sessionId])).rows[0].current_run_id).toBeNull();
      expect((await getDiscoverySnapshot(value.resumeToken)).run).toBeNull();
      expect(await claimDiscoveryRun(`synthetic-before-registration-${randomUUID()}`)).toBeNull();
    } finally { release(); }
    const report = await pending;
    expect(report.created).toBe(true);
    expect(report.snapshot.run!.runId).toBe(preparedRunId);
    expect((await claimDiscoveryRun(`synthetic-after-registration-${randomUUID()}`))?.row.run_id).toBe(preparedRunId);
  });

  it("rolls back registration failure without leaving a queued task or current-run pointer", async () => {
    const value = await ready();
    let preparedRunId: string | undefined;
    await expect(enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] }, {
      presentationVersion: DISCOVERY_PRESENTATION_VERSION, protocolVersion: "blocks-optimized", onPrepared: async prepared => {
        preparedRunId = prepared.runId;
        throw new Error("SYNTHETIC_CAPTURE_REGISTRATION_FAILED");
      },
    })).rejects.toThrow("SYNTHETIC_CAPTURE_REGISTRATION_FAILED");
    expect(preparedRunId).toMatch(/^[a-f0-9-]{36}$/u);
    expect((await fixture.admin.query("select run_id from competition_discovery_runs where session_id=$1", [value.snapshot.sessionId])).rowCount).toBe(0);
    expect((await getDiscoverySnapshot(value.resumeToken)).run).toBeNull();
    expect(await claimDiscoveryRun(`synthetic-failed-registration-${randomUUID()}`)).toBeNull();
  });

  it("rejects private protocol and capture-registration options in server mode before any task is created", async () => {
    const value = await ready(), previousMode = process.env.SAITU_RUNTIME_MODE;
    let registrationCalled = false;
    process.env.SAITU_RUNTIME_MODE = "server";
    try {
      await expect(enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] },
        { presentationVersion: DISCOVERY_PRESENTATION_VERSION, protocolVersion: "v16" }))
        .rejects.toThrow("DISCOVERY_GENERATION_PROTOCOL_INVALID");
      await expect(enqueueDiscoveryReport(value.resumeToken, { clientRequestId: randomUUID(), followupAnswers: [] }, {
        onPrepared: async () => { registrationCalled = true; },
      })).rejects.toThrow("DISCOVERY_SYNTHETIC_CAPTURE_LOCAL_ONLY");
      expect(registrationCalled).toBe(false);
      expect((await fixture.admin.query("select run_id from competition_discovery_runs where session_id=$1", [value.snapshot.sessionId])).rowCount).toBe(0);
      expect((await getDiscoverySnapshot(value.resumeToken)).run).toBeNull();
    } finally {
      if (previousMode === undefined) delete process.env.SAITU_RUNTIME_MODE;
      else process.env.SAITU_RUNTIME_MODE = previousMode;
    }
  });
});
