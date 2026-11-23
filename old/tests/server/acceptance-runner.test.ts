import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { auditServerAcceptance, parseAcceptanceArgs, PRODUCTION_ACCEPTANCE_CASE_IDS, PRODUCTION_ORIGIN, runServerAcceptance,
  type AcceptanceProfile } from "../../scripts/server/verify-live.mjs";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const profiles: AcceptanceProfile[] = PRODUCTION_ACCEPTANCE_CASE_IDS.map((id) => ({
  id, name: id, answers: { completedTasks: { status: "answered", values: ["software"] },
    enrollmentStatus: { status: "answered", values: ["full-time"] }, participationMode: { status: "answered", values: ["online-only"] },
    achievements: { status: "answered", values: ["research"] }, budget: { status: "answered", values: ["no-personal-cost"] } },
  additionalText: "合成测试资料", reviewChecks: ["人工复核"]
}));

async function setup({ lostReportReply = false, badSession = false, reportErrors = false } = {}) {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "saitu-production-acceptance-")); temporary.push(evidenceRoot);
  const sessions = new Map<string, { sessionId: string; run?: { runId: string; status: string; markdown: string; attempt: number }; polls: number }>();
  let sessionPosts = 0, reportPosts = 0, readOnlyRecoveries = 0, concurrent = 0, maximumConcurrent = 0;
  const requests: { url: string; init?: RequestInit }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    expect(url.startsWith(`${PRODUCTION_ORIGIN}/api/ai/competition-discovery/`)).toBe(true);
    expect(init?.redirect).toBe("error");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Origin).toBe(PRODUCTION_ORIGIN);
    const token = headers.Authorization?.replace("Bearer ", "");
    if (url.endsWith("/session") && init?.method === "POST") {
      sessionPosts += 1;
      if (badSession && sessionPosts === 1) return json({ error: "TEST_PREPARATION_ERROR" }, 503);
      const resumeToken = `never-persist-this-resume-token-${randomUUID()}`;
      const session = { sessionId: randomUUID(), polls: 0 };
      sessions.set(resumeToken, session);
      return json({ resumeToken, snapshot: { ...session, followups: [], run: null } });
    }
    const session = sessions.get(token);
    if (!session) throw new Error("test missing token");
    if (url.endsWith("/session")) {
      readOnlyRecoveries += 1;
      return json({ ...session, followups: [] });
    }
    if (url.endsWith("/report")) {
      reportPosts += 1;
      if (reportErrors) return json({ error: "TEST_REPORT_ERROR" }, 503);
      session.run = { runId: randomUUID(), status: "running", markdown: "", attempt: 1 };
      concurrent += 1; maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      if (lostReportReply && reportPosts === 1) throw new Error("Response lost after server committed the paid job");
      return json({ runId: session.run.runId, snapshot: { ...session, followups: [] } });
    }
    if (url.includes("/events?")) {
      return new Response("id: 1\ndata: {\"seq\":1,\"payload\":{\"type\":\"text\",\"delta\":\"合成报告\"}}\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (url.endsWith("/cancel")) return json({ ...session, run: { ...session.run, status: "cancelled" } });
    session.polls += 1;
    if (session.polls >= 2 && session.run?.status === "running") {
      concurrent -= 1; session.run.status = "complete"; session.run.markdown = "合成报告，需人工审阅。";
    }
    return json({ ...session, followups: [] });
  };
  const options = { batchId: "20261120T060000Z", profiles, questionnaireVersion: "competition-discovery.v2", consentVersion: "test-server",
    parseSubmission: (value: unknown) => value,
    configuration: { concurrency: 4, dailyCallLimit: null, automaticRetries: 1, reportDeadlineMs: 180_000 },
    evidenceRoot, pollMs: 1, fetchImpl };
  return { options, requests, metrics: () => ({ sessionPosts, reportPosts, readOnlyRecoveries, maximumConcurrent }) };
}

describe("the explicitly authorized production acceptance runner", () => {
  it("never treats unknown arguments or a different target as live authorization", () => {
    expect(parseAcceptanceArgs([]).live).toBe(false);
    expect(() => parseAcceptanceArgs(["--live"])).toThrow("LIVE_REQUIRES_RELEASE_ID");
    expect(() => parseAcceptanceArgs(["--live", "--batch-id", "../../outside"])).toThrow("INVALID_RELEASE_ID");
    expect(() => parseAcceptanceArgs(["--live", "--batch-id", "20261120T060000Z", "--origin", "https://outside.example"])).toThrow("USAGE_ERROR");
  });

  it("runs precisely two batches of four and prevents another dispatch after restart or release change", async () => {
    const test = await setup();
    const result = await runServerAcceptance(test.options);
    expect(result.passed).toBe(true);
    expect(test.metrics()).toMatchObject({ sessionPosts: 8, reportPosts: 8, maximumConcurrent: 4 });
    await expect(runServerAcceptance({ ...test.options, batchId: "20261121T060000Z" }))
      .rejects.toThrow("ACCEPTANCE_ALREADY_STARTED_NEW_AUTHORIZATION_REQUIRED");
    expect(test.metrics().reportPosts).toBe(8);
    const files = await readdir(result.outputDirectory);
    const evidence = (await Promise.all(files.map((name) => readFile(path.join(result.outputDirectory, name), "utf8")))).join("\n");
    expect(evidence).not.toContain("never-persist-this-resume-token-");
    expect(JSON.parse(await readFile(path.join(result.outputDirectory, "receipt.json"), "utf8"))).toMatchObject({ maximumReports: 8, maximumPaidDispatches: 16 });
  });

  it("recovers a lost enqueue reply with a read and never repeats the report POST", async () => {
    const test = await setup({ lostReportReply: true });
    const result = await runServerAcceptance(test.options);
    expect(result.passed).toBe(true);
    expect(result.results.filter(({ restoredFromSnapshot }) => restoredFromSnapshot)).toHaveLength(1);
    expect(test.metrics()).toMatchObject({ reportPosts: 8, readOnlyRecoveries: 1, maximumConcurrent: 4 });
  });

  it("does not start a paid batch when one of its sessions could not be prepared", async () => {
    const test = await setup({ badSession: true });
    const result = await runServerAcceptance(test.options);
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(4);
    expect(test.metrics()).toMatchObject({ sessionPosts: 4, reportPosts: 0 });
  });

  it("does not repeat failed model-work mutations or replace cases to obtain successes", async () => {
    const test = await setup({ reportErrors: true });
    const result = await runServerAcceptance(test.options);
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(8);
    expect(result.results.every(({ error }) => error === "TEST_REPORT_ERROR")).toBe(true);
    expect(test.metrics()).toMatchObject({ sessionPosts: 8, reportPosts: 8 });
  });

  it("rejects a mismatching production retry policy before creating a receipt or contacting the server", async () => {
    const test = await setup();
    await expect(runServerAcceptance({ ...test.options,
      configuration: { ...test.options.configuration, automaticRetries: 2 } })).rejects.toThrow("PRODUCTION_POLICY_MISMATCH");
    expect(test.requests).toHaveLength(0);
    expect(await readdir(test.options.evidenceRoot)).toEqual([]);
  });

  it("audits receipt costs and concurrent dispatches without submitting more work", async () => {
    const test = await setup();
    await runServerAcceptance(test.options);
    const audit = await auditServerAcceptance({ evidenceRoot: test.options.evidenceRoot, batchId: test.options.batchId,
      readLedgerRows: async (ids) => ids.filter((_, index) => index % 2 === 0).map((callId, index) => ({
        callId, dispatchedAt: new Date(100_000 + Math.floor(index / 4) * 2_000).toISOString(),
        completedAt: new Date(101_000 + Math.floor(index / 4) * 2_000).toISOString(),
        hardDeadlineAt: new Date(280_000).toISOString(), state: "usage_estimated", chargedMicros: 12_000
      })) });
    expect(audit).toMatchObject({ passed: true, actualPaidDispatches: 8, observedMaximumConcurrent: 4, chargedCny: 0.096 });
    expect(test.metrics().reportPosts).toBe(8);
    const noEvidence = await auditServerAcceptance({ evidenceRoot: test.options.evidenceRoot, batchId: test.options.batchId,
      readLedgerRows: async () => [] });
    expect(noEvidence).toMatchObject({ passed: false, completedReportsHaveDispatchEvidence: false });
    expect(test.metrics().reportPosts).toBe(8);
  });
});
