import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCOVERY_SCHEMA_VERSION, legacyDiscoverySubmissionSchema, type DiscoveryAnswers } from "@/lib/competitions/discovery/contracts";
import { DISCOVERY_FIELD_IDS, createEmptyDiscoveryAnswers } from "@/lib/competitions/discovery/questionnaire";
import { DISCOVERY_CONSENT_VERSION } from "@/lib/competitions/discovery/disclosure";
import type { DiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/transport";
import { unsealV7 } from "@/lib/competitions/v7/crypto";

const database = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), release: vi.fn() }));
const maintenance = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(),
  lstatSync: () => {
    if (maintenance.enabled) return {};
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => database }));
import { createDiscoverySession, findDiscoverySessionBySubmission, type DiscoverySessionBody } from "@/lib/competitions/discovery/store";

type StoredRow = {
  session_id: string; creation_key: string; input_sha256: string; ciphertext: Buffer; iv: Buffer; tag: Buffer;
  expires_at: Date; clarification_status: string; status: string; current_run_id: null;
};
let rows: Map<string, StoredRow>;
beforeEach(() => {
  vi.clearAllMocks();
  maintenance.enabled = false;
  rows = new Map();
  database.connect.mockResolvedValue(database);
  database.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (["begin", "commit", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith("select pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("insert into competition_discovery_sessions")) {
      if (rows.has(String(args[1]))) return { rows: [], rowCount: 0 };
      const row: StoredRow = { session_id: String(args[0]), creation_key: String(args[1]), input_sha256: String(args[2]),
        ciphertext: args[3] as Buffer, iv: args[4] as Buffer, tag: args[5] as Buffer, expires_at: args[6] as Date,
        clarification_status: String(args[7]), status: "active", current_run_id: null };
      rows.set(row.creation_key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("select * from competition_discovery_sessions where creation_key=")) {
      const row = rows.get(String(args[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`Unexpected database operation in session-only test: ${sql}`);
  });
});
afterEach(() => vi.unstubAllEnvs());

function catalog(): DiscoveryCatalogSnapshot {
  const text = "合成赛事资料";
  return { version: "synthetic.v1", count: 1, ids: ["synthetic"], text, clarifyText: text,
    byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}
function modernInput() {
  const answers = createEmptyDiscoveryAnswers();
  for (const id of DISCOVERY_FIELD_IDS) answers[id] = { status: "answered", values: [], text: `关于 ${id} 的个人情况` };
  return { schemaVersion: DISCOVERY_SCHEMA_VERSION, answers, additionalText: "保留的历史补充", catalogSnapshot: catalog(),
    consentVersion: DISCOVERY_CONSENT_VERSION, clientRequestId: randomUUID() };
}
function legacyAnswers(): DiscoveryAnswers {
  const answers = createEmptyDiscoveryAnswers();
  for (const id of DISCOVERY_FIELD_IDS) answers[id] = { status: "skipped", values: [] };
  return answers;
}

describe("discovery versioned session storage", () => {
  it("keeps server session recovery and duplicate creation available during maintenance, while blocking new sessions", async () => {
    vi.stubEnv("SAITU_RUNTIME_MODE", "server");
    const input = modernInput();
    const first = await createDiscoverySession(input);
    maintenance.enabled = true;
    const duplicate = await createDiscoverySession(input);
    expect(duplicate.created).toBe(false);
    expect(duplicate.resumeToken).toBe(first.resumeToken);
    expect((await findDiscoverySessionBySubmission(input))?.snapshot.sessionId).toBe(first.snapshot.sessionId);
    await expect(createDiscoverySession(modernInput())).rejects.toThrow("DISCOVERY_MAINTENANCE");
    expect(rows.size).toBe(1);
  });

  it("opens a complete v2 questionnaire directly as a ready, encrypted session", async () => {
    const input = modernInput();
    const result = await createDiscoverySession(input);
    expect(result.created).toBe(true);
    expect(result.snapshot).toMatchObject({ schemaVersion: DISCOVERY_SCHEMA_VERSION, status: "ready", clarificationStatus: "complete",
      answers: input.answers, additionalText: input.additionalText, followups: [], followupAnswers: [], run: null });
    const row = [...rows.values()][0];
    expect(row.clarification_status).toBe("complete");
    expect(row.ciphertext.toString("utf8")).not.toContain(input.answers.major.text);
    expect(unsealV7<DiscoverySessionBody>(`discovery-session:${row.session_id}`, row).answers).toEqual(input.answers);
  });

  it("rejects an incomplete v2 questionnaire before opening a transaction", async () => {
    const input = modernInput();
    input.answers.budget = { status: "unanswered", values: [] };
    await expect(createDiscoverySession(input)).rejects.toThrow();
    input.answers.budget = { status: "answered", values: [], text: "🧑".repeat(201) };
    await expect(createDiscoverySession(input)).rejects.toThrow();
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it("deduplicates v2 creation and recovers it without creating new work", async () => {
    const input = modernInput();
    const first = await createDiscoverySession(input), second = await createDiscoverySession(input);
    expect(second.created).toBe(false);
    expect(second.snapshot.sessionId).toBe(first.snapshot.sessionId);
    expect(second.resumeToken).toBe(first.resumeToken);
    database.query.mockClear();
    expect((await findDiscoverySessionBySubmission(input))?.snapshot.sessionId).toBe(first.snapshot.sessionId);
    expect(database.query.mock.calls.every(([sql]) => String(sql).startsWith("select"))).toBe(true);
    const changed = { ...input, answers: { ...input.answers, major: { status: "answered" as const, values: [], text: "不同自述" } } };
    await expect(createDiscoverySession(changed)).rejects.toThrow("DISCOVERY_REQUEST_CHANGED");
    await expect(findDiscoverySessionBySubmission(changed)).rejects.toThrow("DISCOVERY_REQUEST_CHANGED");
  });

  it("keeps old unanswered choices, missing text keys and request hashes intact", async () => {
    const submission = { schemaVersion: "competition-discovery.v1" as const, answers: legacyAnswers(), additionalText: "原版说明",
      consentVersion: "2026-11-19.discovery.v1", consentAccepted: true as const, clientRequestId: randomUUID() };
    const parsed = legacyDiscoverySubmissionSchema.parse(submission);
    const input = { answers: parsed.answers, additionalText: parsed.additionalText, consentVersion: parsed.consentVersion,
      clientRequestId: parsed.clientRequestId, catalogSnapshot: catalog() };
    const created = await createDiscoverySession(input);
    expect(created.snapshot.schemaVersion).toBeUndefined();
    expect(created.snapshot.status).toBe("clarifying");
    const row = [...rows.values()][0], body = unsealV7<DiscoverySessionBody>(`discovery-session:${row.session_id}`, row);
    expect(Object.hasOwn(body.answers.major, "text")).toBe(false);
    expect(Object.hasOwn(body, "schemaVersion")).toBe(false);
    expect((await findDiscoverySessionBySubmission({ ...input, answers: parsed.answers }))?.snapshot.answers).toEqual(submission.answers);
    expect(JSON.stringify(body.answers)).toBe(JSON.stringify(submission.answers));
  });

  it("recovers the originally accepted catalog without changing its stored ciphertext or hash", async () => {
    const input = modernInput(), created = await createDiscoverySession(input);
    const row = [...rows.values()][0], originalHash = row.input_sha256, originalCiphertext = row.ciphertext;
    const updatedCatalog = { ...catalog(), version: "synthetic.next-release" };
    // Full-body creation remains strict; the API recovers by the original
    // questionnaire instead of trying to replace its catalog snapshot.
    await expect(createDiscoverySession({ ...input, catalogSnapshot: updatedCatalog })).rejects.toThrow("DISCOVERY_REQUEST_CHANGED");
    database.query.mockClear();
    const recovered = await findDiscoverySessionBySubmission(input);
    expect(recovered?.snapshot.sessionId).toBe(created.snapshot.sessionId);
    expect(row.input_sha256).toBe(originalHash);
    expect(row.ciphertext).toBe(originalCiphertext);
    expect(unsealV7<DiscoverySessionBody>(`discovery-session:${row.session_id}`, row).catalogSnapshot).toEqual(input.catalogSnapshot);
    expect(database.query.mock.calls.every(([sql]) => String(sql).startsWith("select"))).toBe(true);
  });
});
