import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDiscoveryAnswers } from "@/lib/competitions/discovery/questionnaire";
import { DISCOVERY_CONSENT_VERSION } from "@/lib/competitions/discovery/disclosure";
import type { ClaimedDiscoveryRun } from "@/lib/competitions/discovery/store";
import type { DiscoveryEventPayload } from "@/lib/competitions/discovery/transport";

const mocks = vi.hoisted(() => ({ append: vi.fn(), renew: vi.fn(), release: vi.fn(), claim: vi.fn(), expire: vi.fn(), stream: vi.fn() }));
vi.mock("@/lib/competitions/discovery/model", () => ({ streamDiscoveryReport: mocks.stream }));
vi.mock("@/lib/competitions/discovery/store", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/competitions/discovery/store")>(),
  appendDiscoveryRunEvent: mocks.append, renewDiscoveryRunLease: mocks.renew,
  releaseDiscoveryRunLease: mocks.release, claimDiscoveryRun: mocks.claim, expireDiscoverySessions: mocks.expire }));
import { DISCOVERY_TEXT_BATCH_BYTES, DISCOVERY_TEXT_BATCH_MS, discoveryModelInvocationId, processClaimedDiscoveryRun } from "@/lib/competitions/discovery/worker";

function claim(): ClaimedDiscoveryRun {
  const now = Date.now(), runId = randomUUID();
  return {
    owner: "synthetic-worker", fence: "1",
    row: { run_id: runId, session_id: randomUUID(), status: "running", submission_key: "a".repeat(64), input_sha256: "b".repeat(64),
      next_event_seq: "0", lease_owner: "synthetic-worker", lease_fence: "1", lease_expires_at: new Date(now + 20000),
      submitted_at: new Date(now), deadline_at: new Date(now + 180000), expires_at: new Date(now + 86400000), ciphertext: Buffer.alloc(0), iv: Buffer.alloc(0), tag: Buffer.alloc(0) },
    body: { markdown: "", sources: [], attempt: 1, reasoningEffort: "max", timeoutFallback: false, runtimeBinding: process.env.SAITU_DISCOVERY_SOURCE_SHA256 || "development" },
    session: { answers: createEmptyDiscoveryAnswers(), additionalText: "合成测试", consentVersion: DISCOVERY_CONSENT_VERSION, followups: [], followupAnswers: [],
      catalogSnapshot: { version: "test", count: 1, ids: ["one"], text: "[]", clarifyText: "[]", sha256: "c".repeat(64), byteLength: 2 } },
  };
}
const successful = { model: "deepseek-flash", finishReason: "stop" as const, webSearchUsed: false };
function manualHighClaim() {
  const value = claim(), prior = randomUUID();
  value.body.reasoningEffort = "high"; value.body.timeoutFallback = true; value.body.manualRetryOfRunId = prior;
  value.body.inheritedMaxTimeout = { runId: prior, callId: discoveryModelInvocationId(prior, 1), resetSeq: 1 };
  return value;
}
let events: DiscoveryEventPayload[];
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-19T04:00:00.000Z")); events = [];
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  mocks.renew.mockResolvedValue(true); mocks.release.mockResolvedValue(undefined);
  mocks.append.mockImplementation(async (value: ClaimedDiscoveryRun, payload: DiscoveryEventPayload) => {
    events.push(payload);
    if (payload.type === "text") value.body.markdown += payload.delta;
    if (payload.type === "sources") value.body.sources = payload.sources;
    if (payload.type === "tool") value.body.webSearchUsed = true;
    if (payload.type === "reset") {
      value.body.markdown = ""; value.body.sources = []; value.body.attempt = payload.attempt; value.body.webSearchUsed = false;
      if (payload.reason === "timeout") {
        value.body.reasoningEffort = "high";
        value.body.timeoutFallback = true;
      }
    }
    if (payload.type === "error") { value.body.error = payload.code; value.row.status = "failed"; }
    if (payload.type === "complete") value.row.status = "complete";
    return { ...payload, seq: events.length, runId: value.row.run_id, at: new Date().toISOString() };
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("discovery report worker", () => {
  it("uses stable distinct UUIDs for each paid attempt", () => {
    const id = randomUUID(), first = discoveryModelInvocationId(id, 1), second = discoveryModelInvocationId(id, 2);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(discoveryModelInvocationId(id, 1)).toBe(first); expect(second).not.toBe(first);
    expect(discoveryModelInvocationId("11111111-1111-4111-8111-111111111111", 1)).toBe("1e5d6098-dd1e-59e9-b14b-dc7d5ffd6668");
    expect(discoveryModelInvocationId("11111111-1111-4111-8111-111111111111", 2)).toBe("0d183c9e-5d12-5599-be2a-6210d28d4bb2");
  });
  it("gives a proven manual high retry its full new deadline without the max-only first-text watchdog", async () => {
    const value = manualHighClaim();
    mocks.stream.mockImplementation(async input => {
      expect(input.reasoningEffort).toBe("high");
      await vi.advanceTimersByTimeAsync(160000);
      expect(input.signal.aborted).toBe(false);
      await input.onEvent({ type: "text", delta: "超过150秒但在新任务期限内的完整正文" });
      await vi.advanceTimersByTimeAsync(19000);
      expect(input.signal.aborted).toBe(false);
      return successful;
    });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(value.row.status).toBe("complete");
    expect(events.some(event => event.type === "reset")).toBe(false);
    expect(mocks.stream.mock.calls[0][0].deadlineEpochMs).toBe(value.row.deadline_at.getTime());
  });
  it("keeps a proven manual retry at high for one transient retry and never makes a third call", async () => {
    const value = manualHighClaim();
    mocks.stream.mockRejectedValue(Object.assign(new Error("network_error"), { code: "network_error", retryable: true, retryAfterMs: 0 }));
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream.mock.calls.map(call => call[0].reasoningEffort)).toEqual(["high", "high"]);
    expect(value.row.status).toBe("failed"); expect(value.body.inheritedMaxTimeout).toBeDefined();
    expect(value.body.timeoutFallback).toBe(true);
    expect(events.filter(event => event.type === "reset")).toHaveLength(1);
  });
  it.each(["rate_limited", "upstream_server_error"])("keeps an initial high call at high after a temporary %s without inventing a timeout", async code => {
    const value = claim(); value.body.reasoningEffort = "high";
    mocks.stream.mockRejectedValueOnce(Object.assign(new Error(code), { code, retryable: true, retryAfterMs: 0, upstreamAttempted: true }))
      .mockImplementationOnce(async input => { await input.onEvent({ type: "text", delta: "同档位重试后的报告" }); return successful; });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream.mock.calls.map(call => call[0].reasoningEffort)).toEqual(["high", "high"]);
    expect(mocks.stream.mock.calls.map(call => call[0].timeoutFallback)).toEqual([false, false]);
    expect(value.body).toMatchObject({ reasoningEffort: "high", timeoutFallback: false });
    expect(value.body.inheritedMaxTimeout).toBeUndefined();
    expect(events).toContainEqual({ type: "reset", attempt: 2, reason: "temporary_error", failureCode: code });
    expect(value.row.status).toBe("complete");
  });
  it("still stops a manual high retry at 180 seconds and retains its incomplete current text", async () => {
    const value = manualHighClaim();
    mocks.stream.mockImplementation(async input => {
      await vi.advanceTimersByTimeAsync(160000); await input.onEvent({ type: "text", delta: "尚未完成" });
      await vi.advanceTimersByTimeAsync(20000); expect(input.signal.aborted).toBe(true);
      throw Object.assign(new Error("timeout"), { code: "timeout", upstreamAttempted: true });
    });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(value.body.markdown).toBe("尚未完成");
    expect(value.body.error).toBe("DISCOVERY_TIMEOUT"); expect(events.some(event => event.type === "complete")).toBe(false);
  });
  it.each(["authentication_error", "refusal"])("preserves explicit %s at the manual high hard deadline", async code => {
    const value = manualHighClaim();
    mocks.stream.mockImplementation(async () => { await vi.advanceTimersByTimeAsync(180000); throw Object.assign(new Error(code), { code, upstreamAttempted: true }); });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(value.body.error).toBe(`DISCOVERY_${code.toUpperCase()}`);
  });
  it("persists text before completion and passes frozen catalog, max effort and the absolute deadline", async () => {
    const value = claim();
    mocks.stream.mockImplementation(async input => { await input.onEvent({ type: "text", delta: "中文正文" }); return successful; });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(mocks.stream.mock.calls[0][0]).toMatchObject({ reasoningEffort: "max", deadlineEpochMs: value.row.deadline_at.getTime(),
      invocationId: discoveryModelInvocationId(value.row.run_id, 1), catalog: value.session.catalogSnapshot });
    expect(events.map(event => event.type)).toEqual(["text", "complete"]);
    expect(value.row.status).toBe("complete"); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("persists the first useful segment immediately and combines later deltas within 150ms", async () => {
    const value = claim();
    mocks.stream.mockImplementation(async input => {
      await input.onEvent({ type: "text", delta: "首段" });
      expect(value.body.markdown).toBe("首段");
      await input.onEvent({ type: "text", delta: "，第二" });
      await input.onEvent({ type: "text", delta: "段😀" });
      expect(events).toEqual([{ type: "text", delta: "首段" }]);
      await vi.advanceTimersByTimeAsync(DISCOVERY_TEXT_BATCH_MS - 1);
      expect(value.body.markdown).toBe("首段");
      await vi.advanceTimersByTimeAsync(1);
      expect(value.body.markdown).toBe("首段，第二段😀");
      return successful;
    });
    await processClaimedDiscoveryRun(value);
    expect(events).toEqual([{ type: "text", delta: "首段" }, { type: "text", delta: "，第二段😀" }, { type: "complete", model: "deepseek-flash", webSearchUsed: false }]);
  });
  it("flushes at a UTF-8 byte threshold without splitting a Chinese or emoji delta", async () => {
    const value = claim(), delta = "中😀".repeat(Math.ceil(DISCOVERY_TEXT_BATCH_BYTES / 7));
    mocks.stream.mockImplementation(async input => {
      await input.onEvent({ type: "text", delta: "首段" });
      await input.onEvent({ type: "text", delta });
      expect(value.body.markdown).toBe("首段" + delta);
      expect(Date.now()).toBe(value.row.submitted_at.getTime());
      return successful;
    });
    await processClaimedDiscoveryRun(value);
    expect(events.filter(event => event.type === "text")).toHaveLength(2);
  });
  it("flushes text before tools, sources and normal completion without reordering deltas", async () => {
    const value = claim(), sources = [{ url: "https://example.org/rules", title: "规则" }];
    mocks.stream.mockImplementation(async input => {
      await input.onEvent({ type: "text", delta: "首" });
      await input.onEvent({ type: "text", delta: "工具之前" });
      await input.onEvent({ type: "tool", action: "search", status: "started" });
      await input.onEvent({ type: "text", delta: "来源之前" });
      await input.onEvent({ type: "sources", sources });
      await input.onEvent({ type: "text", delta: "结尾" });
      return successful;
    });
    await processClaimedDiscoveryRun(value);
    expect(events.map(event => event.type)).toEqual(["text", "text", "tool", "text", "sources", "text", "complete"]);
    expect(value.body.markdown).toBe("首工具之前来源之前结尾");
    await vi.advanceTimersByTimeAsync(DISCOVERY_TEXT_BATCH_MS);
    expect(events.at(-1)?.type).toBe("complete");
  });
  it("flushes pending partial text before a transient reset and immediately persists the retry's first segment", async () => {
    const value = claim();
    mocks.stream.mockImplementationOnce(async input => {
      await input.onEvent({ type: "text", delta: "旧首段" });
      await input.onEvent({ type: "text", delta: "旧尾段" });
      throw Object.assign(new Error("stream_incomplete"), { code: "stream_incomplete", retryable: true, retryAfterMs: 0, upstreamAttempted: true });
    }).mockImplementationOnce(async input => {
      await input.onEvent({ type: "text", delta: "新正文" });
      expect(value.body.markdown).toBe("新正文");
      return successful;
    });
    await processClaimedDiscoveryRun(value);
    expect(events.map(event => event.type)).toEqual(["text", "text", "reset", "text", "complete"]);
    expect(value.body.markdown).toBe("新正文");
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });
  it("flushes buffered text before a refusal withdrawal and never publishes completion", async () => {
    const value = claim();
    mocks.stream.mockImplementation(async input => {
      await input.onEvent({ type: "text", delta: "需要撤回" });
      await input.onEvent({ type: "text", delta: "的尾段" });
      throw Object.assign(new Error("refusal"), { code: "refusal", retryable: false, upstreamAttempted: true });
    });
    await processClaimedDiscoveryRun(value);
    expect(events.map(event => event.type)).toEqual(["text", "text", "reset", "error"]);
    expect(value.body.markdown).toBe("");
  });
  it.each(["refusal", "authentication_error"])("preserves explicit %s when flushing buffered text crosses the hard deadline", async code => {
    const value = claim(), append = mocks.append.getMockImplementation()!;
    mocks.append.mockImplementation(async (current, payload) => {
      if (payload.type === "text" && payload.delta === "迟到尾段") {
        await vi.advanceTimersByTimeAsync(100);
        throw new Error("DISCOVERY_TIMEOUT");
      }
      return append(current, payload);
    });
    mocks.stream.mockImplementation(async input => {
      await input.onEvent({ type: "text", delta: "可见正文" });
      await vi.advanceTimersByTimeAsync(179900);
      await input.onEvent({ type: "text", delta: "迟到尾段" });
      throw Object.assign(new Error(code), { code, retryable: false, upstreamAttempted: true });
    });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(value.body.error).toBe(`DISCOVERY_${code.toUpperCase()}`);
    if (code === "refusal") expect(value.body.markdown).toBe("");
    expect(events.some(event => event.type === "complete")).toBe(false);
  });
  it("does not dispatch another provider call when an asynchronous batch write fails", async () => {
    const value = claim(), append = mocks.append.getMockImplementation()!;
    mocks.append.mockImplementationOnce(append).mockRejectedValueOnce(new Error("database unavailable"));
    mocks.stream.mockImplementation(async input => {
      await input.onEvent({ type: "text", delta: "已保存" });
      await input.onEvent({ type: "text", delta: "未保存尾段" });
      await new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      return successful;
    });
    const work = processClaimedDiscoveryRun(value);
    await vi.advanceTimersByTimeAsync(DISCOVERY_TEXT_BATCH_MS);
    await work;
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(value.body.error).toBe("DISCOVERY_DELIVERY_ERROR");
    expect(events.map(event => event.type)).toEqual(["text", "error"]);
  });
  it("discards an unsaved buffer after worker cancellation without appending after the cancellation boundary", async () => {
    const value = claim(), cancelled = new AbortController();
    mocks.stream.mockImplementation(async input => {
      await input.onEvent({ type: "text", delta: "已保存" });
      await input.onEvent({ type: "text", delta: "尚未保存" });
      cancelled.abort();
      throw new Error("cancelled");
    });
    await processClaimedDiscoveryRun(value, undefined, cancelled.signal);
    await vi.advanceTimersByTimeAsync(DISCOVERY_TEXT_BATCH_MS);
    expect(events).toEqual([{ type: "text", delta: "已保存" }]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("records queue, model and save stages using only content-free metadata", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const value = claim(); value.row.submitted_at = new Date(Date.now() - 200);
    mocks.stream.mockImplementation(async input => {
      input.onTiming({ stage: "gate_acquired", atEpochMs: Date.now(), waitMs: 12 });
      input.onTiming({ stage: "first_reasoning", atEpochMs: Date.now() });
      await input.onEvent({ type: "tool", action: "search", status: "started" });
      input.onTiming({ stage: "first_upstream_text", atEpochMs: Date.now() });
      await input.onEvent({ type: "text", delta: "私人回答不得记录" });
      return successful;
    });
    await processClaimedDiscoveryRun(value);
    const records = log.mock.calls.map(([message]) => JSON.parse(message));
    expect(records.map(record => record.stage)).toEqual(["queued", "claimed", "gate_acquired", "first_reasoning", "tool", "first_upstream_text", "first_persisted_text", "text_persisted", "complete"]);
    expect(records[1]).toMatchObject({ queueMs: 200, elapsedMs: 200 });
    expect(records.at(-1)).toMatchObject({ runId: value.row.run_id, batches: 1 });
    expect(JSON.stringify(records)).not.toMatch(/私人|合成测试|example/);
  });
  it("keeps already authorized v1 sessions usable after the questionnaire consent version changes", async () => {
    const value = claim(); value.session.consentVersion = "2026-11-19.discovery.v1";
    mocks.stream.mockImplementation(async input => { await input.onEvent({ type: "text", delta: "旧版会话报告" }); return successful; });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(value.row.status).toBe("complete");
  });
  it("uses the only retry at high after 150s without substantive text, clearing prior whitespace", async () => {
    const value = claim();
    mocks.stream.mockImplementationOnce(async input => {
      await input.onEvent({ type: "text", delta: "\n\n" });
      await input.onEvent({ type: "tool", action: "search", status: "started" });
      await vi.advanceTimersByTimeAsync(150000);
      expect(input.signal.aborted).toBe(true);
      throw Object.assign(new Error("timeout"), { code: "timeout", retryable: false, upstreamAttempted: true });
    }).mockImplementationOnce(async input => { await input.onEvent({ type: "text", delta: "重试后的完整正文" }); return successful; });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream.mock.calls.map(call => call[0].reasoningEffort)).toEqual(["max", "high"]);
    expect(mocks.stream.mock.calls[1][0].deadlineEpochMs).toBe(value.row.deadline_at.getTime());
    expect(mocks.stream.mock.calls[1][0].deadlineEpochMs - Date.now()).toBe(30000);
    expect(events).toContainEqual({ type: "reset", attempt: 2, reason: "timeout", failureCode: "timeout" });
    expect(value.body.markdown).toBe("重试后的完整正文"); expect(value.body.timeoutFallback).toBe(true);
  });
  it("keeps the same max request when first text arrives at 149s and completes at 160s", async () => {
    const value = claim();
    mocks.stream.mockImplementation(async input => {
      await vi.advanceTimersByTimeAsync(149000);
      expect(input.signal.aborted).toBe(false);
      await input.onEvent({ type: "text", delta: "正文已经开始" });
      await vi.advanceTimersByTimeAsync(11000);
      expect(input.signal.aborted).toBe(false);
      await input.onEvent({ type: "text", delta: "，同一次请求完整结束。" });
      return successful;
    });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(value.row.status).toBe("complete");
    expect(value.body.reasoningEffort).toBe("max"); expect(events.some(event => event.type === "reset")).toBe(false);
    expect(value.body.markdown).toBe("正文已经开始，同一次请求完整结束。");
  });
  it("preserves an actual first-text timeout at the model callback boundary without keeping the late text", async () => {
    const value = claim();
    mocks.stream.mockImplementationOnce(async input => {
      await vi.advanceTimersByTimeAsync(150000);
      try { await input.onEvent({ type: "text", delta: "截止之后的首段" }); }
      catch { throw Object.assign(new Error("delivery_error"), { code: "delivery_error", retryable: false, upstreamAttempted: true }); }
      return successful;
    }).mockImplementationOnce(async input => { await input.onEvent({ type: "text", delta: "回退后的完整报告" }); return successful; });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream.mock.calls.map(call => call[0].reasoningEffort)).toEqual(["max", "high"]);
    expect(value.body.markdown).toBe("回退后的完整报告"); expect(value.row.status).toBe("complete");
    expect(events.some(event => event.type === "text" && event.delta === "截止之后的首段")).toBe(false);
  });
  it("keeps max for a transient HTTP failure and never takes a third attempt", async () => {
    const value = claim();
    mocks.stream.mockRejectedValue(Object.assign(new Error("rate_limited"), { code: "rate_limited", retryable: true, retryAfterMs: 0 }));
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream.mock.calls.map(call => call[0].reasoningEffort)).toEqual(["max", "max"]);
    expect(events).toContainEqual({ type: "reset", attempt: 2, reason: "temporary_error", failureCode: "rate_limited" });
    expect(value.row.status).toBe("failed"); expect(value.body.error).toBe("DISCOVERY_RATE_LIMITED");
  });
  it("keeps max when an explicit 429 arrives at the first attempt boundary", async () => {
    const value = claim();
    mocks.stream.mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(150000);
      throw Object.assign(new Error("rate_limited"), { code: "rate_limited", retryable: true, retryAfterMs: 0 });
    }).mockImplementationOnce(async input => { await input.onEvent({ type: "text", delta: "完整正文" }); return successful; });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream.mock.calls.map(call => call[0].reasoningEffort)).toEqual(["max", "max"]);
    expect(events).toContainEqual({ type: "reset", attempt: 2, reason: "temporary_error", failureCode: "rate_limited" });
    expect(value.body.timeoutFallback).toBe(false); expect(value.row.status).toBe("complete");
  });
  it("records a safe retry classification after partial text while keeping the retry at max", async () => {
    const value = claim();
    mocks.stream.mockImplementationOnce(async input => {
      await input.onEvent({ type: "text", delta: "中断前的部分正文" });
      throw Object.assign(new Error("upstream message is not stored"), {
        code: "stream_incomplete", retryable: true, retryAfterMs: 0, upstreamAttempted: true,
      });
    }).mockImplementationOnce(async input => { await input.onEvent({ type: "text", delta: "新的完整正文" }); return successful; });
    await processClaimedDiscoveryRun(value);
    expect(events).toContainEqual({ type: "reset", attempt: 2, reason: "temporary_error", failureCode: "stream_incomplete" });
    expect(mocks.stream.mock.calls.map(call => call[0].reasoningEffort)).toEqual(["max", "max"]);
    expect(value.body.markdown).toBe("新的完整正文"); expect(value.body.timeoutFallback).toBe(false);
    expect(JSON.stringify(events)).not.toContain("upstream message");
  });
  it("never persists an unexpected upstream error code or message in reset metadata", async () => {
    const value = claim();
    mocks.stream.mockRejectedValueOnce(Object.assign(new Error("private upstream message"), {
      code: "https://invalid.example/?credential=private-value", retryable: true, retryAfterMs: 0,
    })).mockImplementationOnce(async input => { await input.onEvent({ type: "text", delta: "完整正文" }); return successful; });
    await processClaimedDiscoveryRun(value);
    expect(events).toContainEqual({ type: "reset", attempt: 2, reason: "temporary_error", failureCode: "unknown_retryable_error" });
    expect(JSON.stringify(events)).not.toMatch(/private|credential|invalid\.example/);
    expect(mocks.stream.mock.calls.map(call => call[0].reasoningEffort)).toEqual(["max", "max"]);
    expect(value.row.status).toBe("complete");
  });
  it("starts the first real call at max after a long queue while keeping the absolute 180s deadline", async () => {
    const value = claim(); value.row.submitted_at = new Date(Date.now() - 151000); value.row.deadline_at = new Date(value.row.submitted_at.getTime() + 180000);
    mocks.stream.mockImplementation(async input => { await input.onEvent({ type: "text", delta: "正文" }); return successful; });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(mocks.stream.mock.calls[0][0].reasoningEffort).toBe("max");
    expect(mocks.stream.mock.calls[0][0].deadlineEpochMs).toBe(value.row.deadline_at.getTime());
    expect(events.some(event => event.type === "reset")).toBe(false); expect(value.body.timeoutFallback).toBe(false);
  });
  it("anchors the first-text wait to processing while still deducting queue time from the total budget", async () => {
    const value = claim(), processingAt = Date.now();
    value.row.submitted_at = new Date(processingAt - 10000); value.row.deadline_at = new Date(value.row.submitted_at.getTime() + 180000);
    mocks.stream.mockImplementation(async input => {
      await vi.advanceTimersByTimeAsync(149000);
      expect(input.signal.aborted).toBe(false);
      await input.onEvent({ type: "text", delta: "正文" });
      await vi.advanceTimersByTimeAsync(11000);
      expect(input.signal.aborted).toBe(false);
      return successful;
    });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream.mock.calls[0][0]).toMatchObject({ reasoningEffort: "max", deadlineEpochMs: processingAt + 170000 });
    expect(value.row.deadline_at.getTime()).toBe(processingAt + 170000);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(value.row.status).toBe("complete");
  });
  it("does not downgrade or claim max ran when permit or preparation timed out before dispatch", async () => {
    const value = claim();
    mocks.stream.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(150000);
      throw Object.assign(new Error("timeout"), { code: "timeout", retryable: true, upstreamAttempted: false });
    });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(value.body.reasoningEffort).toBe("max");
    expect(value.body.timeoutFallback).toBe(false); expect(value.body.error).toBe("DISCOVERY_TIMEOUT");
    expect(events).toEqual([{ type: "error", code: "DISCOVERY_TIMEOUT" }]);
  });
  it("does not downgrade on a plain pre-dispatch deadline error lacking upstream evidence", async () => {
    const value = claim();
    mocks.stream.mockImplementation(async () => { await vi.advanceTimersByTimeAsync(150000); throw new Error("DISCOVERY_CALL_DEADLINE"); });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(events).toEqual([{ type: "error", code: "DISCOVERY_TIMEOUT" }]);
    expect(value.body.timeoutFallback).toBe(false);
  });
  it("stops at the absolute 180s deadline without completing a truncated report", async () => {
    const value = claim();
    mocks.stream.mockImplementationOnce(async () => { await vi.advanceTimersByTimeAsync(150000); throw Object.assign(new Error("timeout"), { code: "timeout", upstreamAttempted: true }); })
      .mockImplementationOnce(async () => { await vi.advanceTimersByTimeAsync(30000); throw Object.assign(new Error("timeout"), { code: "timeout", upstreamAttempted: true }); });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledTimes(2); expect(events.at(-1)).toEqual({ type: "error", code: "DISCOVERY_TIMEOUT" });
    expect(events.some(event => event.type === "complete")).toBe(false);
  });
  it("still stops a started max report at the original absolute deadline without a new attempt", async () => {
    const value = claim();
    mocks.stream.mockImplementation(async input => {
      await vi.advanceTimersByTimeAsync(149000);
      await input.onEvent({ type: "text", delta: "报告未完" });
      await vi.advanceTimersByTimeAsync(31000);
      expect(input.signal.aborted).toBe(true);
      throw Object.assign(new Error("timeout"), { code: "timeout", upstreamAttempted: true });
    });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(events.some(event => event.type === "reset")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "error", code: "DISCOVERY_TIMEOUT" });
  });
  it.each(["authentication_error", "refusal"])("preserves an explicit %s even if the first-text watchdog fired", async code => {
    const value = claim();
    mocks.stream.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(150000);
      throw Object.assign(new Error(code), { code, retryable: false, upstreamAttempted: true });
    });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(value.body.error).toBe(`DISCOVERY_${code.toUpperCase()}`);
    expect(events.some(event => event.type === "reset" && event.reason !== "withdrawn")).toBe(false);
  });
  it("withdraws a rejected partial answer before publishing failure", async () => {
    const value = claim();
    mocks.stream.mockImplementation(async input => { await input.onEvent({ type: "text", delta: "需要撤回的部分" }); throw Object.assign(new Error("refusal"), { code: "refusal", retryable: false }); });
    await processClaimedDiscoveryRun(value);
    expect(events.slice(-2)).toEqual([{ type: "reset", attempt: 1, reason: "withdrawn" }, { type: "error", code: "DISCOVERY_REFUSAL" }]);
    expect(value.body.markdown).toBe(""); expect(mocks.stream).toHaveBeenCalledOnce();
  });
  it("does not reinterpret a terminal provider error at the time boundary as a retryable timeout", async () => {
    const value = claim();
    mocks.stream.mockImplementation(async input => {
      await input.onEvent({ type: "text", delta: "撤回片段" });
      await vi.advanceTimersByTimeAsync(150000);
      throw Object.assign(new Error("refusal"), { code: "refusal", retryable: false });
    });
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).toHaveBeenCalledOnce(); expect(value.body.error).toBe("DISCOVERY_REFUSAL"); expect(value.body.markdown).toBe("");
  });
  it("does not dispatch with an outdated stored consent", async () => {
    const value = claim(); value.session.consentVersion = "old-consent";
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).not.toHaveBeenCalled(); expect(events).toEqual([{ type: "error", code: "DISCOVERY_CONSENT_CHANGED" }]);
  });
  it("does not replay an already running task whose previous lease was lost", async () => {
    const value = claim(); value.body.error = "DISCOVERY_WORKER_INTERRUPTED";
    await processClaimedDiscoveryRun(value);
    expect(mocks.stream).not.toHaveBeenCalled(); expect(events).toEqual([{ type: "error", code: "DISCOVERY_WORKER_INTERRUPTED" }]);
  });
  it("aborts provider work after cancellation invalidates its database lease", async () => {
    const value = claim(); mocks.renew.mockResolvedValue(false);
    mocks.stream.mockImplementation(input => new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })));
    const work = processClaimedDiscoveryRun(value);
    await vi.advanceTimersByTimeAsync(1000); await work;
    expect(mocks.stream.mock.calls[0][0].signal.aborted).toBe(true); expect(events).toEqual([]); expect(mocks.release).toHaveBeenCalledOnce();
  });
});
