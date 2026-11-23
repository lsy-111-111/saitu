import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A small hook dispatcher exercises the real hook's effects in node without
// adding a DOM dependency. Effects run in commit order and preserve identities.
const hooks = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], effects: [] as (() => void)[] }));
vi.mock("react", () => {
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) => Boolean(a && a.length === b.length && a.every((item, index) => Object.is(item, b[index])));
  return {
    useState<T>(initial: T | (() => T)) {
      const index = hooks.index++;
      if (!hooks.slots[index]) {
        const slot = { value: typeof initial === "function" ? (initial as () => T)() : initial, set: (_value: T | ((previous: T) => T)) => {} };
        slot.set = value => { slot.value = typeof value === "function" ? (value as (previous: T) => T)(slot.value) : value; };
        hooks.slots[index] = slot;
      }
      const slot = hooks.slots[index] as { value: T; set: (value: T | ((previous: T) => T)) => void };
      return [slot.value, slot.set];
    },
    useRef<T>(current: T) { const index = hooks.index++; return (hooks.slots[index] ??= { current }); },
    useCallback<T>(value: T, deps: readonly unknown[]) {
      const index = hooks.index++, slot = hooks.slots[index] as { value: T; deps: readonly unknown[] } | undefined;
      if (!slot || !same(slot.deps, deps)) hooks.slots[index] = { value, deps };
      return (hooks.slots[index] as { value: T }).value;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = hooks.index++, previous = hooks.slots[index] as { deps: readonly unknown[]; cleanup?: () => void } | undefined;
      if (previous && same(previous.deps, deps)) return;
      const slot = { deps, cleanup: undefined as (() => void) | undefined };
      hooks.slots[index] = slot;
      hooks.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); if (typeof cleanup === "function") slot.cleanup = cleanup; });
    },
  };
});

import { useCompetitionDiscovery } from "@/components/competitions/discovery/useCompetitionDiscovery";
import { DISCOVERY_BROWSER_STORAGE_KEY, emptyDiscoveryBrowserState, type DiscoveryBrowserState } from "@/components/competitions/discovery/discovery-client-state";
import type { DiscoverySnapshot } from "@/lib/competitions/discovery/transport";
import { DISCOVERY_FIELD_IDS } from "@/lib/competitions/discovery/questionnaire";
import { DISCOVERY_CONSENT_VERSION } from "@/lib/competitions/discovery/disclosure";

const sessionId = "22222222-2222-4222-8222-222222222222", runId = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-11-20T12:00:01.000Z");
function DiscoveryHookHarness() {
  hooks.index = 0;
  const result = useCompetitionDiscovery();
  for (const effect of hooks.effects.splice(0)) effect();
  return result;
}
async function settle() { for (let index = 0; index < 15; index++) await Promise.resolve(); }

describe("lost report response recovery", () => {
  beforeEach(() => {
    hooks.index = 0; hooks.slots = []; hooks.effects = [];
    vi.useFakeTimers(); vi.setSystemTime(now);
    const records = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value), removeItem: (key: string) => records.delete(key) },
      sessionStorage: { removeItem: vi.fn() },
      setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    });
  });
  afterEach(() => {
    for (const slot of hooks.slots) (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
    vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it("keeps answers and the valid session after a definitive busy response, allowing direct retry without creating another session", async () => {
    const state = emptyDiscoveryBrowserState(now);
    state.phase = "review";
    state.answers.major = { status: "answered", values: [], text: "数字媒体艺术" };
    state.session = { sessionId, resumeToken: "synthetic-recovery-token-with-length", expiresAt: state.expiresAt, runId: null };
    state.snapshot = { sessionId, expiresAt: state.expiresAt, status: "ready", answers: state.answers, additionalText: "", followups: [], followupAnswers: [], clarificationStatus: "complete", run: null };
    window.localStorage.setItem(DISCOVERY_BROWSER_STORAGE_KEY, JSON.stringify(state));
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ error: "DISCOVERY_BUSY", message: "当前生成报告的人较多，已保留你的回答，请稍后重试。" }, { status: 429 })));
    vi.stubGlobal("fetch", fetchMock);
    DiscoveryHookHarness(); DiscoveryHookHarness();
    await DiscoveryHookHarness().startReport();
    const busy = DiscoveryHookHarness();
    expect(busy.error).toContain("已保留你的回答");
    expect(busy.state.answers.major.text).toBe("数字媒体艺术");
    expect(busy.state.session).toEqual(state.session);
    expect(busy.state.reportRequestId).toBeNull();
    await busy.startReport();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls as unknown as [string][]) expect(url).toBe("/api/ai/competition-discovery/report");
  });

  it("returns to answer review after maintenance rejects a new session without erasing consent or answers", async () => {
    const state = emptyDiscoveryBrowserState(now);
    state.phase = "review";
    state.acceptedConsentVersion = DISCOVERY_CONSENT_VERSION;
    for (const id of DISCOVERY_FIELD_IDS) state.answers[id] = { status: "answered", values: [], text: "暂不确定。" };
    window.localStorage.setItem(DISCOVERY_BROWSER_STORAGE_KEY, JSON.stringify(state));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ error: "DISCOVERY_MAINTENANCE", message: "网站正在短暂维护，已保留你的回答，稍后可继续提交。" }, { status: 503 }))));
    DiscoveryHookHarness(); DiscoveryHookHarness();
    DiscoveryHookHarness().submit(); await settle();
    const maintained = DiscoveryHookHarness();
    expect(maintained.state.phase).toBe("review");
    expect(maintained.state.submission).toBeNull();
    expect(maintained.state.answers).toEqual(state.answers);
    expect(maintained.state.acceptedConsentVersion).toBe(DISCOVERY_CONSENT_VERSION);
    expect(maintained.error).toContain("短暂维护");
  });

  it.each([1, 2] as const)("waits for a delayed read-only v%s server check before considering cached expiry", async storageVersion => {
    const state = emptyDiscoveryBrowserState(now - 86_401_000);
    Object.assign(state, { storageVersion, phase: "report", reportRequestId: "33333333-3333-4333-8333-333333333333",
      session: { sessionId, resumeToken: "synthetic-recovery-token-with-length", expiresAt: state.expiresAt, runId: null } });
    window.localStorage.setItem(DISCOVERY_BROWSER_STORAGE_KEY, JSON.stringify(state));
    let finishCheck!: (response: Response) => void;
    const check = new Promise<Response>(resolve => { finishCheck = resolve; });
    const freshExpiry = new Date(now + 86_400_000).toISOString();
    const snapshot: DiscoverySnapshot = { sessionId, expiresAt: freshExpiry, status: "complete", answers: state.answers, additionalText: "", followups: [], followupAnswers: [], clarificationStatus: "complete",
      run: { runId, status: "complete", markdown: "后台已经完成的报告", sources: [], lastSeq: 2, attempt: 1, submittedAt: new Date(now - 120_000).toISOString(), deadlineAt: new Date(now + 60_000).toISOString() } };
    const fetchMock = vi.fn((url: string) => url.endsWith("/session") ? check : Promise.resolve(Response.json(snapshot)));
    vi.stubGlobal("fetch", fetchMock);
    DiscoveryHookHarness(); DiscoveryHookHarness();
    await vi.advanceTimersByTimeAsync(1500);
    const waiting = DiscoveryHookHarness();
    expect(waiting.state.session?.resumeToken).toBe(state.session?.resumeToken);
    expect(waiting.state.phase).toBe("report");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ai/competition-discovery/session");
    const saved = JSON.parse(window.localStorage.getItem(DISCOVERY_BROWSER_STORAGE_KEY)!) as DiscoveryBrowserState;
    expect(saved.session?.resumeToken).toBe(state.session?.resumeToken);

    finishCheck(Response.json(snapshot)); await settle();
    const recovered = DiscoveryHookHarness();
    expect(recovered.state.session?.runId).toBe(runId);
    expect(recovered.state.snapshot?.run?.markdown).toBe("后台已经完成的报告");
    expect(recovered.state.expiresAt).toBe(freshExpiry);
    // Only read-only session/run requests occurred; no duplicate report dispatch.
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) expect(init.method).toBeUndefined();
  });

  it("clears expired recovery credentials only after the server rejects them", async () => {
    const state = emptyDiscoveryBrowserState(now - 86_401_000);
    Object.assign(state, { phase: "report", reportRequestId: "33333333-3333-4333-8333-333333333333",
      session: { sessionId, resumeToken: "synthetic-recovery-token-with-length", expiresAt: state.expiresAt, runId: null } });
    window.localStorage.setItem(DISCOVERY_BROWSER_STORAGE_KEY, JSON.stringify(state));
    let finishCheck!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finishCheck = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    DiscoveryHookHarness(); DiscoveryHookHarness();
    await vi.advanceTimersByTimeAsync(1500);
    expect(DiscoveryHookHarness().state.session?.resumeToken).toBe(state.session?.resumeToken);
    finishCheck(Response.json({ error: "DISCOVERY_SESSION_EXPIRED" }, { status: 410 }));
    await settle();
    const expired = DiscoveryHookHarness();
    expect(expired.state.session).toBeNull();
    expect(expired.state.phase).toBe("questions");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an active session without an actual run to review without dispatching a report", async () => {
    const state = emptyDiscoveryBrowserState(now);
    Object.assign(state, { phase: "report", reportRequestId: "33333333-3333-4333-8333-333333333333",
      session: { sessionId, resumeToken: "synthetic-recovery-token-with-length", expiresAt: state.expiresAt, runId: null } });
    state.answers.major = { status: "answered", values: [], text: "数字媒体艺术" };
    window.localStorage.setItem(DISCOVERY_BROWSER_STORAGE_KEY, JSON.stringify(state));
    const snapshot: DiscoverySnapshot = { sessionId, expiresAt: state.expiresAt, status: "ready", answers: state.answers, additionalText: "", followups: [], followupAnswers: [], clarificationStatus: "complete", run: null };
    const fetchMock = vi.fn(() => Promise.resolve(Response.json(snapshot)));
    vi.stubGlobal("fetch", fetchMock);
    DiscoveryHookHarness(); DiscoveryHookHarness(); await settle();
    const draft = DiscoveryHookHarness();
    expect(draft.state.phase).toBe("review");
    expect(draft.state.answers.major.text).toBe("数字媒体艺术");
    expect(draft.state.session).toBeNull();
    expect(draft.state.reportRequestId).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
