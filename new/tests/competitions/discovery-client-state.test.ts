import { describe, expect, it } from "vitest";
import { applyDiscoveryEvent, discoveryDraftChanged, discoveryEventSchema, discoveryNeedsReportVerification, discoverySnapshotSchema, emptyDiscoveryBrowserState, hasNewerDiscoveryBrowserRecord, readDiscoveryBrowserState, type DiscoveryBrowserState } from "@/components/competitions/discovery/discovery-client-state";
import type { DiscoveryRunSnapshot, DiscoverySnapshot } from "@/lib/competitions/discovery/transport";
import { discoveryRetryStatus } from "@/components/competitions/discovery/discovery-retry-status";
import { DISCOVERY_PRESENTATION_VERSION, emptyDiscoveryPresentation, presentationRecordMarkdown, type DiscoveryProfileRecord } from "@/lib/competitions/discovery/presentation";

const runId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const at = "2026-11-19T12:00:00.000Z";
function run(): DiscoveryRunSnapshot {
  return { runId, status: "running", markdown: "上一轮已输出的正文", sources: [{ url: "https://example.com/old", title: "旧来源" }], lastSeq: 2, attempt: 1, submittedAt: at, deadlineAt: "2026-11-19T12:03:00.000Z" };
}
function snapshot(): DiscoverySnapshot {
  return { sessionId, expiresAt: "2026-11-20T12:00:00.000Z", status: "generating", answers: emptyDiscoveryBrowserState().answers, additionalText: "", followups: [], followupAnswers: [], clarificationStatus: "skipped", run: run() };
}

describe("discovery browser lifecycle", () => {
  it("persists validated presentation records through snapshots and clears them on retry", () => {
    const profile: DiscoveryProfileRecord = { type: "profile", summary: "已确认目标，其他条件待核。", groups: { background: [], goals: ["作品积累"], experience: [], constraints: [] } };
    const previous = { ...run(), markdown: "", sources: [], presentationVersion: DISCOVERY_PRESENTATION_VERSION, presentation: emptyDiscoveryPresentation() };
    const event = discoveryEventSchema.parse({ type: "text", runId, seq: 3, at, delta: presentationRecordMarkdown(profile), presentationRecord: profile });
    const appended = applyDiscoveryEvent(previous, event);
    expect(appended.presentation?.profile).toEqual(profile);
    expect(appended.markdown).toContain(profile.summary);
    expect(applyDiscoveryEvent(appended, event)).toBe(appended);
    const restored = discoverySnapshotSchema.parse({ ...snapshot(), run: appended });
    expect(restored.run?.presentation).toEqual(appended.presentation);
    const failed = applyDiscoveryEvent(appended, { type: "error", runId, seq: 4, at, code: "invalid_output" });
    expect(failed.presentation?.profile).toEqual(profile);
    const reset = applyDiscoveryEvent(failed, { type: "reset", runId, seq: 5, at, attempt: 2, reason: "temporary_error" });
    expect(reset.presentation).toEqual(emptyDiscoveryPresentation());
    expect(reset.markdown).toBe("");
    expect(reset.presentationVersion).toBe(DISCOVERY_PRESENTATION_VERSION);
  });
  it("shows automatic regeneration after reset and after restoring attempt two from a snapshot", () => {
    const reset = applyDiscoveryEvent(run(), { type: "reset", runId, seq: 3, at, attempt: 2, reason: "timeout" });
    expect(discoveryRetryStatus(reset)).toContain("正在重新生成");
    const restored = discoverySnapshotSchema.parse({ ...snapshot(), run: { ...reset, markdown: "新一轮正文" } });
    expect(discoveryRetryStatus(restored.run)).toContain("正在重新生成");
    expect(restored.run?.markdown).toBe("新一轮正文");
    expect(discoveryRetryStatus({ ...reset, status: "complete" })).toBeNull();
    expect(discoveryRetryStatus(run())).toBeNull();
  });
  it("accepts optional clarification failure as skipped, so the report can continue", () => {
    expect(discoverySnapshotSchema.parse(snapshot()).clarificationStatus).toBe("skipped");
  });

  it("deduplicates replayed events and requires a snapshot after an event gap", () => {
    const previous = run();
    expect(applyDiscoveryEvent(previous, { type: "text", runId, seq: 2, at, delta: "重复" })).toBe(previous);
    expect(() => applyDiscoveryEvent(previous, { type: "text", runId, seq: 4, at, delta: "有缺口" })).toThrow("缺口");
    expect(applyDiscoveryEvent(previous, { type: "text", runId: sessionId, seq: 3, at, delta: "另一个任务" })).toBe(previous);
  });

  it.each(["timeout", "temporary_error", "withdrawn"] as const)("clears old text and sources on %s reset before appending a new attempt", reason => {
    const event = discoveryEventSchema.parse({ type: "reset", runId, seq: 3, at, attempt: 2, reason });
    const reset = applyDiscoveryEvent(run(), event);
    expect(reset.markdown).toBe("");
    expect(reset.sources).toEqual([]);
    expect(reset.attempt).toBe(2);
    const next = applyDiscoveryEvent(reset, { type: "text", runId, seq: 4, at, delta: "本轮正文" });
    expect(next.markdown).toBe("本轮正文");
  });

  it("keeps recovery credentials for a task completed while closed without exposing expired cached text", () => {
    const base = emptyDiscoveryBrowserState(Date.parse(at));
    const stored: DiscoveryBrowserState = { ...base, phase: "report", additionalText: "已到缓存期限的补充", snapshot: snapshot(), session: { sessionId, resumeToken: "recovery-token-with-ample-length", expiresAt: base.expiresAt, runId } };
    const recovered = readDiscoveryBrowserState(JSON.stringify(stored), Date.parse(base.expiresAt) + 1000);
    expect(recovered?.session?.resumeToken).toBe(stored.session?.resumeToken);
    expect(recovered?.snapshot).toBeNull();
    expect(recovered?.additionalText).toBe("");
  });

  it("drops an expired draft and verifies a completed report's moving expiry before dropping credentials", () => {
    const draft = emptyDiscoveryBrowserState(Date.parse(at));
    expect(readDiscoveryBrowserState(JSON.stringify(draft), Date.parse(draft.expiresAt) + 1)).toBeNull();
    const complete = { ...snapshot(), run: { ...run(), status: "complete" as const } };
    const stored: DiscoveryBrowserState = { ...draft, phase: "report", snapshot: complete, session: { sessionId, resumeToken: "recovery-token-with-ample-length", expiresAt: draft.expiresAt, runId } };
    expect(readDiscoveryBrowserState(JSON.stringify(stored), Date.parse(draft.expiresAt) + 1)?.snapshot).toBeNull();
    expect(readDiscoveryBrowserState(JSON.stringify(stored), Date.parse(draft.expiresAt) + 24 * 60 * 60_000 + 1)).toBeNull();
  });

  it("retains an unconfirmed priority draft without accepting it as a submitted snapshot", () => {
    const stored = emptyDiscoveryBrowserState(Date.parse(at));
    stored.answers.goals = { status: "answered", values: ["career-portfolio", "research"], orderConfirmed: false };
    expect(readDiscoveryBrowserState(JSON.stringify(stored), Date.parse(at) + 1000)?.answers.goals.orderConfirmed).toBe(false);
  });

  it("prevents an old tab's stream or clear action from overwriting the newer browser record", () => {
    const older = emptyDiscoveryBrowserState(Date.parse(at));
    const newer = emptyDiscoveryBrowserState(Date.parse(at) + 1000);
    expect(hasNewerDiscoveryBrowserRecord(older, JSON.stringify(newer))).toBe(true);
    expect(hasNewerDiscoveryBrowserRecord(newer, JSON.stringify(older))).toBe(false);
    expect(hasNewerDiscoveryBrowserRecord(newer, JSON.stringify(newer))).toBe(false);
  });

  it("migrates an unfinished v1 draft without losing selected options or historical text", () => {
    const old = emptyDiscoveryBrowserState(Date.parse(at));
    old.storageVersion = 1; old.phase = "questions";
    for (const id of Object.keys(old.answers) as (keyof typeof old.answers)[]) old.answers[id] = { status: "skipped", values: [] };
    old.answers.major = { status: "answered", values: ["computing"] };
    old.additionalText = "之前完成过一个软件项目";
    const migrated = readDiscoveryBrowserState(JSON.stringify(old), Date.parse(at) + 1000)!;
    expect(migrated.storageVersion).toBe(2);
    expect(migrated.phase).toBe("review");
    expect(migrated.answers.major).toEqual(old.answers.major);
    expect(migrated.answers.budget).toEqual({ status: "unanswered", values: [] });
    expect(migrated.additionalText).toBe(old.additionalText);
    expect(migrated.session).toBeNull();
    expect(migrated.acceptedConsentVersion).toBeNull();
  });

  it("keeps v2 text answers and every other answer when navigating backward and restoring", () => {
    const initial = emptyDiscoveryBrowserState(Date.parse(at));
    initial.answers.major = { status: "answered", values: [], text: "数字媒体艺术" };
    initial.answers.goals = { status: "answered", values: [], text: "先做作品集，再考虑获奖" };
    const back = discoveryDraftChanged(initial, { questionIndex: 1 });
    const restored = readDiscoveryBrowserState(JSON.stringify(back), Date.parse(at) + 1000)!;
    expect(restored.questionIndex).toBe(1);
    expect(restored.answers.major.text).toBe("数字媒体艺术");
    expect(restored.answers.goals.text).toBe("先做作品集，再考虑获奖");
    expect(restored.phase).toBe("questions");
  });

  it("restores an existing v1 report without changing the original input or hash shape", () => {
    const old = emptyDiscoveryBrowserState(Date.parse(at));
    old.storageVersion = 1; old.phase = "report";
    old.answers.learningStage = { status: "skipped", values: [] };
    old.snapshot = snapshot();
    old.session = { sessionId, resumeToken: "recovery-token-with-ample-length", expiresAt: old.expiresAt, runId };
    const restored = readDiscoveryBrowserState(JSON.stringify(old), Date.parse(at) + 1000)!;
    expect(restored.answers.learningStage).toEqual({ status: "skipped", values: [] });
    expect(restored.session).toEqual(old.session);
    expect(restored.snapshot?.run?.markdown).toBe("上一轮已输出的正文");
  });

  it.each([1, 2] as const)("keeps a v%s report request's token until the server checks a lost enqueue response", storageVersion => {
    const old = emptyDiscoveryBrowserState(Date.parse(at));
    old.storageVersion = storageVersion; old.phase = "report"; old.reportRequestId = "33333333-3333-4333-8333-333333333333";
    old.session = { sessionId, resumeToken: "recovery-token-with-ample-length", expiresAt: old.expiresAt, runId: null };
    const restored = readDiscoveryBrowserState(JSON.stringify(old), Date.parse(at) + 1000)!;
    expect(restored.storageVersion).toBe(storageVersion);
    expect(restored.phase).toBe("report");
    expect(restored.session?.resumeToken).toBe(old.session.resumeToken);
    expect(restored.reportRequestId).toBe(old.reportRequestId);
    const afterCacheExpiry = readDiscoveryBrowserState(JSON.stringify(old), Date.parse(old.expiresAt) + 1000)!;
    expect(afterCacheExpiry.session?.resumeToken).toBe(old.session.resumeToken);
    expect(afterCacheExpiry.snapshot).toBeNull();
    expect(discoveryNeedsReportVerification(afterCacheExpiry)).toBe(true);
    expect(readDiscoveryBrowserState(JSON.stringify(old), Date.parse(old.expiresAt) + 86_400_001)).toBeNull();
    expect(discoveryNeedsReportVerification({ ...afterCacheExpiry, session: { ...afterCacheExpiry.session!, runId } })).toBe(false);
  });
});
