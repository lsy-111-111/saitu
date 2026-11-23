import { describe, expect, it } from "vitest";
import { acknowledgeDiscoveryFollowupSave, changeDiscoveryFollowup, discoveryBrowserStateSchema, discoveryFollowupSaveRequest, emptyDiscoveryBrowserState, hasNewerDiscoveryBrowserRecord, readDiscoveryBrowserState, type DiscoveryBrowserState } from "@/components/competitions/discovery/discovery-client-state";
import type { DiscoverySnapshot } from "@/lib/competitions/discovery/transport";

const at = Date.parse("2026-11-19T12:00:00.000Z");
function state(): DiscoveryBrowserState {
  const base = emptyDiscoveryBrowserState(at);
  const snapshot: DiscoverySnapshot = { sessionId: "22222222-2222-4222-8222-222222222222", expiresAt: base.expiresAt, status: "followups", answers: base.answers, additionalText: "", clarificationStatus: "complete", followups: [{ id: "clarify1", prompt: "你愿意承担哪些任务？", selection: "multiple", maxSelections: 2, options: [{ value: "code", label: "写代码" }, { value: "design", label: "做设计" }, { value: "unknown", label: "不确定" }], exclusiveValues: ["unknown"] }], followupAnswers: [{ questionId: "clarify1", status: "skipped", values: [] }], run: null };
  return { ...base, phase: "followups", session: { sessionId: snapshot.sessionId, resumeToken: "synthetic-recovery-value", expiresAt: base.expiresAt, runId: null }, snapshot, followupAnswers: snapshot.followupAnswers };
}
const answer = { questionId: "clarify1", status: "answered" as const, values: ["code"] };

describe("followup draft retention", () => {
  it("marks only a valid changed answer pending without extending the server expiry locally", () => {
    const initial = state(); expect(discoveryFollowupSaveRequest(initial)).toBeNull();
    expect(changeDiscoveryFollowup(initial, initial.followupAnswers[0], at + 1000)).toBe(initial);
    expect(changeDiscoveryFollowup(initial, { ...answer, values: ["invalid"] }, at + 1000)).toBe(initial);
    const changed = changeDiscoveryFollowup(initial, answer, at + 1000);
    expect(changed.expiresAt).toBe(initial.expiresAt); expect(changed.session?.expiresAt).toBe(initial.session?.expiresAt);
    expect(discoveryFollowupSaveRequest(changed)?.editedAt).toBe(new Date(at + 1000).toISOString());
    expect(changeDiscoveryFollowup(changed, answer, at + 2000)).toBe(changed);
  });

  it("uses canonical answers and acknowledges a no-op or server-clamped timestamp without claiming a local extension", () => {
    const changed = changeDiscoveryFollowup(state(), { ...answer, values: ["design", "code"] }, at + 1000);
    const request = discoveryFollowupSaveRequest(changed)!; expect(request.answers[0].values).toEqual(["code", "design"]);
    const response = { ...changed.snapshot!, followupAnswers: request.answers, followupEditedAt: new Date(at).toISOString() };
    const acknowledged = acknowledgeDiscoveryFollowupSave(changed, request, response)!;
    expect(acknowledged.expiresAt).toBe(changed.expiresAt); expect(discoveryFollowupSaveRequest(acknowledged)).toBeNull();
  });

  it("preserves newer local answers while installing an authoritative extended expiry", () => {
    const first = changeDiscoveryFollowup(state(), answer, at + 1000), request = discoveryFollowupSaveRequest(first)!;
    const second = changeDiscoveryFollowup(first, { ...answer, values: ["design"] }, at + 2000);
    const expiresAt = new Date(at + 86_402_000).toISOString();
    const installed = acknowledgeDiscoveryFollowupSave(second, request, { ...first.snapshot!, expiresAt, followupAnswers: request.answers })!;
    expect(installed.expiresAt).toBe(expiresAt); expect(installed.followupAnswers[0].values).toEqual(["design"]);
    expect(discoveryFollowupSaveRequest(installed)?.editedAt).toBe(second.followupEditedAt);
    expect(acknowledgeDiscoveryFollowupSave(emptyDiscoveryBrowserState(at + 3000), request, first.snapshot!)).toBeNull();
    expect(acknowledgeDiscoveryFollowupSave({ ...second, phase: "report" }, request, first.snapshot!)).toBeNull();
  });

  it("does not let a late save roll back a newer expiry or acknowledgement", () => {
    const first = changeDiscoveryFollowup(state(), answer, at + 1000), request = discoveryFollowupSaveRequest(first)!;
    const newerExpiry = new Date(at + 100_000_000).toISOString();
    const newer = { ...first, expiresAt: newerExpiry, followupSavedAt: new Date(at + 2000).toISOString() };
    const installed = acknowledgeDiscoveryFollowupSave(newer, request, { ...first.snapshot!, followupAnswers: request.answers })!;
    expect(installed.expiresAt).toBe(newerExpiry); expect(installed.followupSavedAt).toBe(newer.followupSavedAt);
  });

  it("does not revive expired legacy followup drafts after removing the followup flow", () => {
    const changed = changeDiscoveryFollowup(state(), answer, at + 1000);
    const afterExpiry = Date.parse(changed.expiresAt) + 1;
    expect(readDiscoveryBrowserState(JSON.stringify(changed), afterExpiry)).toBeNull();
    expect(readDiscoveryBrowserState(JSON.stringify({ ...changed, followupSavedAt: changed.followupEditedAt }), afterExpiry)).toBeNull();
    expect(readDiscoveryBrowserState(JSON.stringify(changed), afterExpiry + 86_400_000)).toBeNull();
  });

  it("recognizes a newer followup edit in the same session in another tab and accepts old storage without new fields", () => {
    const initial = state(), changed = changeDiscoveryFollowup(initial, answer, at + 1000);
    expect(hasNewerDiscoveryBrowserRecord(initial, JSON.stringify(changed))).toBe(true);
    expect(hasNewerDiscoveryBrowserRecord(changed, JSON.stringify(initial))).toBe(false);
    const reporting = { ...initial, phase: "report" as const };
    expect(hasNewerDiscoveryBrowserRecord(initial, JSON.stringify(reporting))).toBe(true);
    expect(hasNewerDiscoveryBrowserRecord(reporting, JSON.stringify(changed))).toBe(false);
    const { followupEditedAt: _editedAt, followupSavedAt: _savedAt, ...legacy } = initial;
    expect(discoveryBrowserStateSchema.parse(legacy).followupEditedAt).toBeNull();
  });
});
