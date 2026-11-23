import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDiscoveryAnswers, DISCOVERY_FIELDS, DISCOVERY_FIELD_IDS } from "@/lib/competitions/discovery/questionnaire";
import { DISCOVERY_SCHEMA_VERSION } from "@/lib/competitions/discovery/contracts";
import { DISCOVERY_CONSENT_VERSION } from "@/lib/competitions/discovery/disclosure";
import type { DiscoverySnapshot } from "@/lib/competitions/discovery/transport";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), limited: vi.fn(), consent: vi.fn(), catalog: vi.fn(), clarify: vi.fn(),
  createSession: vi.fn(), findSession: vi.fn(), claimClarification: vi.fn(), finishClarification: vi.fn(), enqueue: vi.fn(),
  getSnapshot: vi.fn(), listEvents: vi.fn(), cancel: vi.fn(), clear: vi.fn(), saveDraft: vi.fn()
}));
vi.mock("@/lib/config/features", () => ({ isCompetitionRecommenderEnabled: mocks.enabled }));
vi.mock("@/lib/security/rate-limit", () => ({ checkDiscoveryStartRateLimit: mocks.limited }));
vi.mock("@/lib/ai/consent", () => ({ recordAiConsent: mocks.consent }));
vi.mock("@/lib/competitions/discovery/catalog", () => ({ makeDiscoveryCatalogSnapshot: mocks.catalog }));
vi.mock("@/lib/competitions/discovery/model", () => ({ clarifyDiscovery: mocks.clarify }));
vi.mock("@/lib/competitions/discovery/store", () => ({
  createDiscoverySession: mocks.createSession,
  findDiscoverySessionBySubmission: mocks.findSession,
  claimDiscoveryClarification: mocks.claimClarification,
  finishDiscoveryClarification: mocks.finishClarification,
  enqueueDiscoveryReport: mocks.enqueue,
  getDiscoverySnapshot: mocks.getSnapshot,
  listDiscoveryEvents: mocks.listEvents,
  cancelDiscoveryRun: mocks.cancel,
  deleteDiscoverySession: mocks.clear,
  saveDiscoveryFollowupDraft: mocks.saveDraft
}));

import {
  postDiscoverySession, postDiscoveryClarify, postDiscoveryReport, getDiscoveryRun, getDiscoveryEvents, getDiscoveryCurrentSession,
  postDiscoveryCancel, deleteDiscoveryCurrentSession, patchDiscoveryCurrentSession
} from "@/lib/competitions/discovery/api";

const runId = "86c95f5a-13be-49c9-9f8a-aad0f2a96f0f";
const otherRunId = "5499aecd-674d-4311-90cb-13b2c035814f";
const token = "test-resume-token-with-at-least-thirty-two-characters";
const origin = "http://127.0.0.1:3191";

function snapshot(overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  return {
    sessionId: "92eb529d-906d-4bce-bf11-7c1f442cce5f",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    status: "ready", answers: createEmptyDiscoveryAnswers(), additionalText: "",
    followups: [], followupAnswers: [], clarificationStatus: "complete", run: null,
    ...overrides
  };
}

function runSnapshot(overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  return snapshot({ status: "complete", run: {
    runId, status: "complete", markdown: "中文报告", sources: [], lastSeq: 3, attempt: 1,
    submittedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 180_000).toISOString()
  }, ...overrides });
}

function submission() {
  const answers = createEmptyDiscoveryAnswers();
  for (const field of DISCOVERY_FIELDS) answers[field.id] = { status: "answered", values: [field.options.find(option => option.meaning === "unknown")!.value] };
  return { schemaVersion: DISCOVERY_SCHEMA_VERSION, answers,
    consentVersion: DISCOVERY_CONSENT_VERSION, consentAccepted: true,
    clientRequestId: "c83b0acf-7736-434e-8e93-5dfaa0f5454d" };
}

function request(path: string, body?: unknown, options: { method?: string; headers?: Record<string, string> } = {}) {
  return new Request(`${origin}/api/ai/competition-discovery/${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers: { origin, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.enabled.mockReturnValue(true);
  mocks.limited.mockResolvedValue(null);
  mocks.consent.mockResolvedValue(undefined);
  const catalog = { version: "test.v1", count: 1, ids: ["one"], sha256: "a".repeat(64), text: "完整材料", byteLength: 12, clarifyText: "精简材料" };
  mocks.catalog.mockReturnValue(catalog);
  mocks.createSession.mockResolvedValue({ created: true, resumeToken: token, snapshot: snapshot() });
  mocks.findSession.mockResolvedValue(null);
  mocks.claimClarification.mockResolvedValue({ kind: "claimed", claim: { sessionId: snapshot().sessionId, owner: "test-owner", fence: "1", deadlineEpochMs: Date.now() + 30_000,
    body: { answers: createEmptyDiscoveryAnswers(), additionalText: "", catalogSnapshot: catalog, followups: [], followupAnswers: [], consentVersion: DISCOVERY_CONSENT_VERSION } } });
  mocks.finishClarification.mockResolvedValue(snapshot());
  mocks.clarify.mockResolvedValue({ questions: [], model: "deepseek-flash", finishReason: "stop" });
  mocks.getSnapshot.mockResolvedValue(runSnapshot());
  mocks.listEvents.mockResolvedValue([]);
  mocks.enqueue.mockResolvedValue({ created: true, snapshot: runSnapshot(), consentVersion: DISCOVERY_CONSENT_VERSION });
  mocks.cancel.mockResolvedValue(runSnapshot({ status: "cancelled" }));
  mocks.clear.mockResolvedValue(undefined);
  mocks.saveDraft.mockResolvedValue(snapshot());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("discovery API session admission without AI followups", () => {
  it("returns retryable busy/maintenance responses while keeping existing read, stream, cancel and delete operations available", async () => {
    for (const [code, status] of [["DISCOVERY_BUSY", 429], ["DISCOVERY_MAINTENANCE", 503]] as const) {
      mocks.enqueue.mockRejectedValueOnce(new Error(code));
      const response = await postDiscoveryReport(request("report", { clientRequestId: crypto.randomUUID() }));
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe("30");
      expect(await response.json()).toMatchObject({ error: code, message: expect.stringContaining("已保留你的回答") });
    }
    expect((await getDiscoveryCurrentSession(request("session"))).status).toBe(200);
    expect((await getDiscoveryRun(request(`runs/${runId}`), runId)).status).toBe(200);
    const events = await getDiscoveryEvents(request(`runs/${runId}/events?after=3`), runId);
    expect(events.status).toBe(200);
    await events.text();
    expect((await postDiscoveryCancel(request(`runs/${runId}/cancel`, {}), runId)).status).toBe(200);
    expect((await deleteDiscoveryCurrentSession(request("session", undefined, { method: "DELETE" }))).status).toBe(200);
  });

  it("uses the configured public origin when Next normalizes its internal request URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
    const normalized = new Request("http://localhost:3191/api/ai/competition-discovery/session?resume=1", {
      method: "POST", headers: { origin, host: "127.0.0.1:3191", "content-type": "application/json" }, body: JSON.stringify(submission())
    });
    expect((await postDiscoverySession(normalized)).status).toBe(404);
    expect(mocks.findSession).toHaveBeenCalledOnce();
    expect((await postDiscoverySession(request("session", submission(), { headers: { origin: "http://localhost:3191" } }))).status).toBe(403);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
  });

  it("rejects absent consent and old consent before creating any session", async () => {
    expect((await postDiscoverySession(request("session", { ...submission(), consentAccepted: false }))).status).toBe(400);
    const response = await postDiscoverySession(request("session", { ...submission(), consentVersion: "old-consent" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "AI_CONSENT_REQUIRED", consentDisclosure: { version: DISCOVERY_CONSENT_VERSION } });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled();
  });

  it("rejects missing fields and empty answers at API admission, including direct clients", async () => {
    for (const id of DISCOVERY_FIELD_IDS) {
      const input = submission();
      input.answers[id] = { status: "unanswered", values: [] };
      expect((await postDiscoverySession(request("session", input))).status, id).toBe(400);
    }
    for (const input of [
      { ...submission(), profile: { legacy: true } },
      { ...submission(), schemaVersion: "competition-recommendation.v7" },
      { ...submission(), additionalText: "旧总补充不可用于新输入" },
      { ...submission(), legacyAdditionalText: "🧑".repeat(201) },
      { ...submission(), answers: { ...submission().answers, major: { status: "answered", values: [], text: "🧑".repeat(201) } } },
      { ...submission(), answers: { ...submission().answers, major: { status: "answered", values: [], text: " \n\t" } } },
      { ...submission(), answers: { ...submission().answers, learningStage: { status: "skipped", values: [] } } }
    ]) expect((await postDiscoverySession(request("session", input))).status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
  });

  it("enforces source, content-type, UTF-8 and feature admission", async () => {
    expect((await postDiscoverySession(request("session", submission(), { headers: { origin: "https://outside.example" } }))).status).toBe(403);
    expect((await postDiscoverySession(request("session", submission(), { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect((await postDiscoverySession(request("session", submission(), { headers: { "content-type": "text/plain" } }))).status).toBe(415);
    const invalidUtf8 = new Request(`${origin}/api/ai/competition-discovery/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: new Uint8Array([0xc3, 0x28]) });
    expect((await postDiscoverySession(invalidUtf8)).status).toBe(400);
    mocks.enabled.mockReturnValue(false);
    expect((await postDiscoverySession(request("session", submission()))).status).toBe(503);
    expect(mocks.clarify).not.toHaveBeenCalled();
  });

  it("honors shared admission and catalog errors before session creation", async () => {
    mocks.limited.mockResolvedValueOnce(new Response(JSON.stringify({ error: "RATE_LIMITED" }), { status: 429 }));
    expect((await postDiscoverySession(request("session", submission()))).status).toBe(429);
    mocks.catalog.mockImplementation(() => { throw new Error("discovery_catalog_context_too_large"); });
    const response = await postDiscoverySession(request("session", submission()));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "DISCOVERY_CATALOG_CONTEXT_TOO_LARGE", message: expect.stringContaining("没有省略赛事") });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
  });

  it("creates a ready v2 session directly with per-field text and no model or consent billing call", async () => {
    const input = { ...submission(), legacyAdditionalText: "保留的旧说明" };
    input.answers.major = { status: "answered", values: [], text: "统计学，主要做数据分析" };
    mocks.createSession.mockResolvedValue({ created: true, resumeToken: token, snapshot: snapshot({ schemaVersion: DISCOVERY_SCHEMA_VERSION, answers: input.answers, additionalText: input.legacyAdditionalText }) });
    const response = await postDiscoverySession(request("session", input));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ resumeToken: token, snapshot: { schemaVersion: DISCOVERY_SCHEMA_VERSION, status: "ready", clarificationStatus: "complete", followups: [] } });
    expect(mocks.createSession).toHaveBeenCalledWith({ schemaVersion: DISCOVERY_SCHEMA_VERSION, answers: input.answers,
      additionalText: input.legacyAdditionalText, consentVersion: input.consentVersion, clientRequestId: input.clientRequestId, catalogSnapshot: mocks.catalog.mock.results[0].value });
    expect(mocks.claimClarification).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled();
    mocks.createSession.mockResolvedValue({ created: false, resumeToken: token, snapshot: snapshot({ schemaVersion: DISCOVERY_SCHEMA_VERSION }) });
    expect((await postDiscoverySession(request("session", input))).status).toBe(200);
  });

  it("only resumes an existing new session even under an older consent version", async () => {
    const input = { ...submission(), consentVersion: "older-consent" };
    expect((await postDiscoverySession(request("session?resume=1", input))).status).toBe(404);
    const existing = snapshot({ schemaVersion: DISCOVERY_SCHEMA_VERSION });
    mocks.findSession.mockResolvedValue({ resumeToken: token, snapshot: existing });
    const response = await postDiscoverySession(request("session?resume=1", input));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resumeToken: token, snapshot: { sessionId: existing.sessionId } });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.limited).not.toHaveBeenCalled();
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
  });

  it("reuses the original snapshot when a lost session response is retried after a catalog release", async () => {
    const input = submission(), original = runSnapshot({ schemaVersion: DISCOVERY_SCHEMA_VERSION, answers: input.answers });
    mocks.findSession.mockResolvedValue({ resumeToken: token, snapshot: original });
    // The next release's catalog is intentionally unavailable: recovery must
    // not construct or merge it into an already accepted session.
    mocks.catalog.mockImplementation(() => { throw new Error("new-release-catalog-must-not-be-used"); });
    const response = await postDiscoverySession(request("session", input));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: original.sessionId, resumeToken: token,
      expiresAt: original.expiresAt, snapshot: original });
    expect(mocks.limited).toHaveBeenCalledOnce();
    expect(mocks.findSession).toHaveBeenCalledWith({ schemaVersion: DISCOVERY_SCHEMA_VERSION, answers: input.answers,
      additionalText: "", consentVersion: input.consentVersion, clientRequestId: input.clientRequestId });
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled();

    expect((await postDiscoverySession(request("session", { ...input, consentVersion: "old-consent" }))).status).toBe(409);
    mocks.limited.mockResolvedValue(new Response("{}", { status: 429 }));
    expect((await postDiscoverySession(request("session", input))).status).toBe(429);
    expect(mocks.findSession).toHaveBeenCalledOnce();
  });

  it("recovers the winning snapshot when concurrent releases race to create the same questionnaire", async () => {
    const original = snapshot({ schemaVersion: DISCOVERY_SCHEMA_VERSION, answers: submission().answers });
    mocks.findSession.mockResolvedValueOnce(null).mockResolvedValueOnce({ resumeToken: token, snapshot: original });
    mocks.createSession.mockRejectedValue(new Error("DISCOVERY_REQUEST_CHANGED"));
    const response = await postDiscoverySession(request("session", submission()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resumeToken: token, snapshot: original });
    expect(mocks.findSession).toHaveBeenCalledTimes(2);
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled();
  });

  it("still rejects a reused request ID whose actual questionnaire input changed", async () => {
    mocks.findSession.mockRejectedValue(new Error("DISCOVERY_REQUEST_CHANGED"));
    const input = submission();
    input.answers.major = { status: "answered", values: [], text: "不同专业自述" };
    const response = await postDiscoverySession(request("session", input));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "DISCOVERY_REQUEST_CHANGED" });
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("retires the legacy clarify endpoint without dispatching or creating replacement sessions", async () => {
    expect((await postDiscoveryClarify(request("clarify", submission()))).status).toBe(410);
    const legacyAnswers = createEmptyDiscoveryAnswers();
    for (const id of DISCOVERY_FIELD_IDS) legacyAnswers[id] = { status: "skipped", values: [] };
    const input = { schemaVersion: "competition-discovery.v1", answers: legacyAnswers, additionalText: "旧说明", consentVersion: "2026-11-19.discovery.v1", consentAccepted: true, clientRequestId: submission().clientRequestId };
    expect((await postDiscoveryClarify(request("clarify", input))).status).toBe(410);
    expect((await postDiscoveryClarify(request("clarify?resume=1", input))).status).toBe(404);
    const existing = snapshot({ status: "generating", clarificationStatus: "complete", answers: legacyAnswers });
    mocks.findSession.mockResolvedValue({ resumeToken: token, snapshot: existing });
    const response = await postDiscoveryClarify(request("clarify?resume=1", input));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resumeToken: token, snapshot: { sessionId: existing.sessionId } });
    expect(mocks.findSession).toHaveBeenCalledWith({ answers: legacyAnswers, additionalText: input.additionalText, consentVersion: input.consentVersion, clientRequestId: input.clientRequestId });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.claimClarification).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled();
    expect(mocks.limited).not.toHaveBeenCalled();
  });

  it("validates read-only recovery before querying storage", async () => {
    expect((await postDiscoveryClarify(request("clarify?resume=1", { ...submission(), clientRequestId: "invalid" }))).status).toBe(400);
    expect((await postDiscoverySession(request("session?resume=1", { ...submission(), clientRequestId: "invalid" }))).status).toBe(400);
    expect(mocks.findSession).not.toHaveBeenCalled();
  });
});

describe("discovery report and resume API", () => {
  it("resolves a lost report enqueue response through a read-only session snapshot", async () => {
    const existing = runSnapshot();
    mocks.getSnapshot.mockResolvedValue(existing);
    const response = await getDiscoveryCurrentSession(request("session"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(existing);
    expect(mocks.getSnapshot).toHaveBeenCalledWith(token);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
    mocks.getSnapshot.mockClear();
    expect((await getDiscoveryCurrentSession(request("session", undefined, { headers: { authorization: "Bearer invalid" } }))).status).toBe(401);
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
  });

  it("starts a new v2 report with only its request ID", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot({ schemaVersion: DISCOVERY_SCHEMA_VERSION }));
    const response = await postDiscoveryReport(request("report", { clientRequestId: submission().clientRequestId }));
    expect(response.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith(token, { clientRequestId: submission().clientRequestId, followupAnswers: [] });
    expect(mocks.clarify).not.toHaveBeenCalled();
  });

  it("saves a supplemental draft with its recovery credential without creating model work", async () => {
    const editedAt = new Date().toISOString();
    const followupAnswers = [{ questionId: "followup_1", status: "skipped", values: [] }];
    const saved = snapshot({ followupEditedAt: editedAt });
    mocks.saveDraft.mockResolvedValue(saved);
    const response = await patchDiscoveryCurrentSession(request("session", { followupAnswers, editedAt }, { method: "PATCH" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(saved);
    expect(mocks.saveDraft).toHaveBeenCalledWith(token, { followupAnswers, editedAt });
    expect(mocks.clarify).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled();
  });

  it("validates draft origin, bearer, JSON and exact body before attempting to save", async () => {
    const input = { followupAnswers: [], editedAt: new Date().toISOString() };
    expect((await patchDiscoveryCurrentSession(request("session", input, { method: "PATCH", headers: { origin: "https://outside.example" } }))).status).toBe(403);
    expect((await patchDiscoveryCurrentSession(request("session", input, { method: "PATCH", headers: { authorization: "Bearer invalid" } }))).status).toBe(401);
    expect((await patchDiscoveryCurrentSession(request("session", input, { method: "PATCH", headers: { "content-type": "text/plain" } }))).status).toBe(415);
    for (const body of [{ ...input, editedAt: "tomorrow" }, { ...input, extra: true }, { ...input, followupAnswers: [{ questionId: "followup_1", status: "skipped", values: ["a"] }] }]) {
      expect((await patchDiscoveryCurrentSession(request("session", body, { method: "PATCH" }))).status).toBe(400);
    }
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
  });

  it.each([
    ["DISCOVERY_FOLLOWUP_INVALID", 400], ["DISCOVERY_DRAFT_TIME_INVALID", 400],
    ["DISCOVERY_DRAFT_NOT_READY", 409], ["DISCOVERY_REPORT_ALREADY_CREATED", 409], ["DISCOVERY_SESSION_EXPIRED", 401]
  ])("maps draft rejection %s without model or report work", async (code, status) => {
    mocks.saveDraft.mockRejectedValue(new Error(code));
    const response = await patchDiscoveryCurrentSession(request("session", { followupAnswers: [], editedAt: new Date().toISOString() }, { method: "PATCH" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: code });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
  });

  it("validates followup IDs and actual choices before enqueueing a report", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot({ followups: [{ id: "followup_1", prompt: "更想尝试什么？", selection: "single", maxSelections: 1,
      options: [{ value: "a", label: "方向一" }, { value: "b", label: "方向二" }, { value: "unknown", label: "不确定" }] }] }));
    const invalid = await postDiscoveryReport(request("report", { clientRequestId: submission().clientRequestId, followupAnswers: [{ questionId: "followup_1", status: "answered", values: ["invented"] }] }));
    expect(invalid.status).toBe(400);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const valid = await postDiscoveryReport(request("report", { clientRequestId: submission().clientRequestId, followupAnswers: [{ questionId: "followup_1", status: "skipped", values: [] }] }));
    expect(valid.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.clarify).not.toHaveBeenCalled();
  });

  it("records a report consent audit only when a new task was created", async () => {
    const body = { clientRequestId: submission().clientRequestId, followupAnswers: [] };
    expect((await postDiscoveryReport(request("report", body))).status).toBe(202);
    mocks.enqueue.mockResolvedValue({ created: false, snapshot: runSnapshot() });
    expect((await postDiscoveryReport(request("report", body))).status).toBe(202);
    expect(mocks.consent).toHaveBeenCalledTimes(1);
    expect(mocks.consent).toHaveBeenCalledWith(expect.any(Request), "competition_discovery_report", expect.any(Object), expect.objectContaining({ consentVersion: DISCOVERY_CONSENT_VERSION }));
  });

  it("audits the original stored consent when retrying a legacy v1 session", async () => {
    const legacyConsent = "2026-11-19.discovery.v1";
    mocks.getSnapshot.mockResolvedValue(snapshot());
    mocks.enqueue.mockResolvedValue({ created: true, snapshot: runSnapshot(), consentVersion: legacyConsent });
    const response = await postDiscoveryReport(request("report", { clientRequestId: submission().clientRequestId }));
    expect(response.status).toBe(202);
    expect(mocks.consent).toHaveBeenCalledWith(expect.any(Request), "competition_discovery_report", expect.any(Object), { consentVersion: legacyConsent });
    expect(await response.json()).not.toHaveProperty("consentVersion");
    mocks.enqueue.mockResolvedValue({ created: false, snapshot: runSnapshot(), consentVersion: legacyConsent });
    expect((await postDiscoveryReport(request("report", { clientRequestId: submission().clientRequestId }))).status).toBe(202);
    expect(mocks.consent).toHaveBeenCalledOnce();
  });

  it("rejects report extra fields and malformed request IDs before any enqueue", async () => {
    const body = { clientRequestId: submission().clientRequestId, followupAnswers: [] };
    expect((await postDiscoveryReport(request("report", { ...body, answers: createEmptyDiscoveryAnswers() }))).status).toBe(400);
    expect((await postDiscoveryReport(request("report", { ...body, clientRequestId: "legacy-request" }))).status).toBe(400);
    for (const selector of [{ presentationVersion: "discovery-cards.v1" }, { presentationVersion: "legacy" }, { protocolVersion: "v16" }]) {
      expect((await postDiscoveryReport(request("report", { ...body, ...selector }))).status).toBe(400);
    }
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("rejects malformed tokens and mismatched task IDs for read and cancel", async () => {
    const malformed = await getDiscoveryRun(request(`runs/${runId}`, undefined, { headers: { authorization: "Bearer invalid" } }), runId);
    expect(malformed.status).toBe(401);
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
    expect((await getDiscoveryRun(request(`runs/${otherRunId}`), otherRunId)).status).toBe(409);
    expect((await postDiscoveryCancel(request(`runs/${otherRunId}/cancel`, undefined, { method: "POST" }), otherRunId)).status).toBe(409);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect((await getDiscoveryRun(request("runs/not-a-uuid"), "not-a-uuid")).status).toBe(400);
  });

  it("replays events from a cursor and never dispatches new model work", async () => {
    mocks.listEvents.mockResolvedValue([
      { type: "text", delta: "中文报告", seq: 2, runId, at: new Date().toISOString() },
      { type: "complete", seq: 3, runId, at: new Date().toISOString() }
    ]);
    const response = await getDiscoveryEvents(request(`runs/${runId}/events?after=1`), runId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const text = await response.text();
    expect(text).toContain("id: 2\nevent: text");
    expect(text).toContain("中文报告");
    expect(text).toContain("event: complete");
    expect(mocks.listEvents).toHaveBeenCalledWith(token, 1, runId);
    expect(mocks.clarify).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("accepts Last-Event-ID and rejects invalid or ahead-of-task cursors", async () => {
    const response = await getDiscoveryEvents(request(`runs/${runId}/events`, undefined, { headers: { "last-event-id": "3" } }), runId);
    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.listEvents).toHaveBeenCalledWith(token, 3, runId);
    for (const cursor of ["-1", "NaN", "4", "9007199254740992"]) {
      expect((await getDiscoveryEvents(request(`runs/${runId}/events?after=${cursor}`), runId)).status).toBe(400);
    }
  });

  it("disconnects an event reader without cancelling or restarting its background task", async () => {
    const current = runSnapshot();
    mocks.getSnapshot.mockResolvedValue({ ...current, status: "generating", run: { ...current.run!, status: "running", lastSeq: 0 } });
    const response = await getDiscoveryEvents(request(`runs/${runId}/events`), runId);
    await response.body!.cancel();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.clarify).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("authorizes explicit cancel and clear without creating or retrying work", async () => {
    expect((await postDiscoveryCancel(request(`runs/${runId}/cancel`, undefined, { method: "POST" }), runId)).status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith(token);
    const cleared = await deleteDiscoveryCurrentSession(request("session", undefined, { method: "DELETE" }));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true });
    expect(mocks.clear).toHaveBeenCalledWith(token);
    expect(mocks.clarify).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
