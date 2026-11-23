import { describe, expect, it, vi } from "vitest";
import { DiscoveryFollowupSaveQueue, type DiscoveryFollowupSaveRequest } from "@/components/competitions/discovery/discovery-followup-save";

function request(second: number): DiscoveryFollowupSaveRequest {
  return { browserRecordId: "record", sessionId: "session", resumeToken: "test-only", editedAt: new Date(second * 1000).toISOString(), answers: [{ questionId: "q1", status: "answered", values: [String(second)] }] };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe("followup save coordination", () => {
  it("flushes a newer edit after an in-flight save before report submission can continue", async () => {
    let pending: DiscoveryFollowupSaveRequest | null = request(1);
    const first = deferred(), second = deferred(), written: string[] = [];
    const queue = new DiscoveryFollowupSaveQueue({ pending: () => pending, onBusy: vi.fn(), onError: vi.fn(), write: async payload => {
      written.push(payload.editedAt); await (written.length === 1 ? first : second).promise;
      if (pending?.editedAt === payload.editedAt) pending = null;
    } });
    const autosave = queue.flush(); pending = request(2);
    let submitted = false; const submission = queue.flush().then(saved => { submitted = saved; });
    expect(written).toHaveLength(1); first.resolve();
    await vi.waitFor(() => expect(written).toHaveLength(2));
    expect(submitted).toBe(false); second.resolve(); await Promise.all([autosave, submission]);
    expect(submitted).toBe(true); expect(written).toEqual([request(1).editedAt, request(2).editedAt]);
  });

  it("dispatches the latest edit with keepalive on exit without waiting for the older request", async () => {
    let pending: DiscoveryFollowupSaveRequest | null = request(1);
    const first = deferred(), second = deferred(), writes: { editedAt: string; keepalive: boolean }[] = [];
    const queue = new DiscoveryFollowupSaveQueue({ pending: () => pending, onBusy: vi.fn(), onError: vi.fn(), write: async (payload, _signal, keepalive) => {
      writes.push({ editedAt: payload.editedAt, keepalive }); await (keepalive ? second : first).promise;
      if (pending?.editedAt === payload.editedAt) pending = null;
    } });
    const original = queue.flush(); pending = request(2); const leaving = queue.flush({ keepalive: true });
    expect(writes).toEqual([{ editedAt: request(1).editedAt, keepalive: false }, { editedAt: request(2).editedAt, keepalive: true }]);
    second.resolve(); expect(await leaving).toBe(true); first.resolve(); expect(await original).toBe(true);
    expect(writes).toHaveLength(2);
  });

  it("keeps a failed edit pending for explicit retry and does not auto-submit or spin", async () => {
    let pending: DiscoveryFollowupSaveRequest | null = request(1); const onError = vi.fn();
    const write = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(async () => { pending = null; });
    const queue = new DiscoveryFollowupSaveQueue({ pending: () => pending, onBusy: vi.fn(), onError, write });
    expect(await queue.flush()).toBe(false); expect(write).toHaveBeenCalledTimes(1); expect(pending).not.toBeNull(); expect(onError).toHaveBeenCalledTimes(1);
    expect(await queue.flush()).toBe(true); expect(write).toHaveBeenCalledTimes(2);
  });

  it("does not show a stale failure after a newer keepalive response has already saved the edit", async () => {
    let pending: DiscoveryFollowupSaveRequest | null = request(1); const first = deferred(), onError = vi.fn();
    const queue = new DiscoveryFollowupSaveQueue({ pending: () => pending, onBusy: vi.fn(), onError, write: async (_payload, _signal, keepalive) => {
      if (keepalive) { pending = null; return; }
      await first.promise; throw new Error("older connection closed");
    } });
    const original = queue.flush(); pending = request(2); expect(await queue.flush({ keepalive: true })).toBe(true);
    first.resolve(); expect(await original).toBe(true); expect(onError).not.toHaveBeenCalled();
  });

  it("aborts late writes on clear or another tab taking ownership and never revives the old record", async () => {
    let pending: DiscoveryFollowupSaveRequest | null = request(1); const response = deferred(); let applied = false;
    const queue = new DiscoveryFollowupSaveQueue({ pending: () => pending, onBusy: vi.fn(), onError: vi.fn(), write: async (_payload, signal) => {
      await response.promise; if (!signal.aborted) applied = true;
    } });
    const saving = queue.flush(); queue.cancel(); pending = null; response.resolve();
    expect(await saving).toBe(false); expect(applied).toBe(false); expect(await queue.flush()).toBe(true);
  });
});
