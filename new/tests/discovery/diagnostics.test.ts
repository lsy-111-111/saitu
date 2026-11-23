import { mkdtemp, mkdir, writeFile, readFile, stat, chmod, rename, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_ENV, DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_RELATIVE,
  DISCOVERY_SYNTHETIC_CAPTURE_DIRECTORY_RELATIVE, DISCOVERY_SYNTHETIC_CAPTURE_MAX_BYTES,
  discoverySyntheticInputSha256, registerDiscoverySyntheticCaptures, openDiscoverySyntheticCapture,
  readDiscoverySyntheticCapture, replayDiscoverySyntheticCapture, type DiscoverySyntheticCaptureEntry,
} from "@/lib/competitions/discovery/diagnostics";
import { DiscoveryPresentationParser } from "@/lib/competitions/discovery/presentation-parser";
import { REPORT_START_MARKER } from "@/lib/competitions/discovery/presentation";
import { makeDiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/catalog";
import { getCompetitionCatalog } from "@/lib/competitions/catalog";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const at = 1_790_000_000_000, source = "a".repeat(64), catalog = "b".repeat(64);
const callId = "12345678-1234-4123-8123-123456789abc", otherCall = "12345678-1234-4123-8123-123456789abd";
const syntheticInput = { answers: { field: { values: ["unknown"], status: "answered" } }, additionalText: "SYNTHETIC_INPUT_NOT_FOR_CAPTURE", followups: [] };
const inputHash = discoverySyntheticInputSha256(syntheticInput);
const makeEntry = (extra: Partial<DiscoverySyntheticCaptureEntry> = {}): DiscoverySyntheticCaptureEntry => ({
  callId, inputSha256: inputHash, catalogSha256: catalog, caseId: "all-uncertain", presentationVersion: "discovery-cards.v1",
  expiresAt: new Date(at + 10 * 60 * 1000).toISOString(), benchmarkVariant: "cards", protocolVersion: "test-v1", round: 1, ...extra,
});
const request = { callId, inputSha256: inputHash, catalogSha256: catalog, model: "deepseek-flash", reasoningEffort: "high" as const,
  presentationVersion: "discovery-cards.v1" as const, protocolVersion: "test-v1", promptVersion: "competition-discovery.test.v1" };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "saitu-synthetic-capture-")); roots.push(root);
  await mkdir(path.join(root, ".next"), { mode: 0o700 });
  await writeFile(path.join(root, ".next/decision-worker-binding.json"), JSON.stringify({ sourceSha256: source }));
  const environment: Record<string, string | undefined> = {
    SAITU_STANDALONE_LOCAL: "1", SAITU_RUNTIME_MODE: "local", SAITU_AI_EXECUTION_MODE: "finite", SAITU_DISCOVERY_SOURCE_SHA256: source,
    DATABASE_URL: "postgresql://synthetic:NEVER_SAVE_DATABASE_PASSWORD@127.0.0.1:5433/saitu_clean",
    NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3190", [DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_ENV]: path.join(root, DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_RELATIVE),
    AI_API_KEY: "NEVER_SAVE_PROVIDER_SECRET", AI_CONVERSATION_SIGNING_SECRET: "NEVER_SAVE_RECOVERY_SECRET",
  };
  const controls = { root, environment, now: () => at };
  return { root, controls, environment, filename: path.join(root, DISCOVERY_SYNTHETIC_CAPTURE_DIRECTORY_RELATIVE, `${callId}.ndjson`),
    allowlist: path.join(root, DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_RELATIVE) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("explicit synthetic content capture", () => {
  it("hashes equivalent input key order identically without including unrelated fields", () => {
    expect(discoverySyntheticInputSha256({ followups: [], additionalText: syntheticInput.additionalText,
      answers: { field: { status: "answered", values: ["unknown"] } } })).toBe(inputHash);
    expect(discoverySyntheticInputSha256({ ...syntheticInput, additionalText: "changed" })).not.toBe(inputHash);
    expect(inputHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does nothing without both an explicit worker switch and an allowlist", async () => {
    const f = await fixture();
    expect(await openDiscoverySyntheticCapture(request, f.controls)).toBeNull();
    await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    const disabled = { ...f.controls, environment: { ...f.environment, [DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_ENV]: undefined } };
    expect(await openDiscoverySyntheticCapture(request, disabled)).toBeNull();
    await expect(stat(path.dirname(f.filename))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects mismatching calls, facts, catalog, format, source, expiry and server runtime", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    for (const changes of [{ callId: otherCall }, { inputSha256: "c".repeat(64) }, { catalogSha256: "d".repeat(64) }, { presentationVersion: "legacy" as const }, { protocolVersion: "other-protocol" }])
      expect(await openDiscoverySyntheticCapture({ ...request, ...changes }, f.controls)).toBeNull();
    expect(await openDiscoverySyntheticCapture(request, { ...f.controls, now: () => at + 11 * 60 * 1000 })).toBeNull();
    for (const changes of [{ SAITU_RUNTIME_MODE: "server" }, { SAITU_STANDALONE_LOCAL: "0" }, { DATABASE_URL: "postgresql://x@127.0.0.1:5432/saitu_production" }, { SAITU_DISCOVERY_SOURCE_SHA256: "e".repeat(64) }])
      expect(await openDiscoverySyntheticCapture(request, { ...f.controls, environment: { ...f.environment, ...changes } })).toBeNull();
    await expect(registerDiscoverySyntheticCaptures([makeEntry({ expiresAt: new Date(at - 1).toISOString() })], f.controls)).rejects.toThrow("EXPIRY_INVALID");
    const payload = JSON.parse(await readFile(f.allowlist, "utf8")); payload.source = "ordinary-user-report";
    await writeFile(f.allowlist, JSON.stringify(payload));
    expect(await openDiscoverySyntheticCapture(request, f.controls)).toBeNull();
  });

  it("uses owner-only permissions, stable identities, and never overwrites a prior capture", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    expect((await stat(f.allowlist)).mode & 0o777).toBe(0o600);
    const capture = await openDiscoverySyntheticCapture(request, f.controls); expect(capture).not.toBeNull();
    capture!.content("原始中文🙂", at + 1); await capture!.finish({ outcome: "complete", finishReason: "stop", doneReceived: true });
    expect((await stat(path.dirname(f.filename))).mode & 0o777).toBe(0o700);
    expect((await stat(f.filename)).mode & 0o777).toBe(0o600);
    expect(await openDiscoverySyntheticCapture(request, f.controls)).toBeNull();
    expect((await readDiscoverySyntheticCapture(f.filename)).header).toMatchObject({ callId, inputSha256: inputHash, catalogSha256: catalog, runtimeBinding: source, caseId: "all-uncertain", round: 1 });
  });

  it("rejects permissive files, alternate paths and symlink boundaries", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    await chmod(f.allowlist, 0o644); expect(await openDiscoverySyntheticCapture(request, f.controls)).toBeNull(); await chmod(f.allowlist, 0o600);
    expect(await openDiscoverySyntheticCapture(request, { ...f.controls, environment: { ...f.environment, [DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_ENV]: `${f.allowlist}.other` } })).toBeNull();
    await rename(f.allowlist, `${f.allowlist}.original`); await symlink(`${f.allowlist}.original`, f.allowlist);
    expect(await openDiscoverySyntheticCapture(request, f.controls)).toBeNull();
    await rm(f.allowlist); await rename(`${f.allowlist}.original`, f.allowlist);
    const elsewhere = path.join(f.root, "elsewhere"); await mkdir(elsewhere, { mode: 0o700 }); await symlink(elsewhere, path.dirname(f.filename));
    expect(await openDiscoverySyntheticCapture(request, f.controls)).toBeNull();
    await expect(stat(path.join(elsewhere, `${callId}.ndjson`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("merges concurrent runner registrations atomically and refuses call identity changes", async () => {
    const f = await fixture();
    await Promise.all([registerDiscoverySyntheticCaptures([makeEntry()], f.controls), registerDiscoverySyntheticCaptures([makeEntry({ callId: otherCall })], f.controls)]);
    const payload = JSON.parse(await readFile(f.allowlist, "utf8"));
    expect(payload.entries.map((entry: DiscoverySyntheticCaptureEntry) => entry.callId).sort()).toEqual([callId, otherCall].sort());
    await expect(registerDiscoverySyntheticCaptures([makeEntry({ inputSha256: "c".repeat(64) })], f.controls)).rejects.toThrow("CALL_CHANGED");
  });

  it("captures only final content and allowlisted numeric timings, never inputs or provider payloads", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    const capture = (await openDiscoverySyntheticCapture(request, f.controls))!;
    capture.timing({ stage: "first_reasoning", atEpochMs: at + 2, reasoningTokens: 11,
      reasoning_content: "NEVER_SAVE_REASONING", toolPayload: "NEVER_SAVE_TOOL_PAYLOAD", answers: syntheticInput.answers, credentials: "NEVER_SAVE_CREDENTIALS" });
    capture.timing({ stage: "untrusted_stage", atEpochMs: at + 3, providerBody: "NEVER_SAVE_PROVIDER_BODY" });
    capture.content("保留引号\"与反斜线\\和换行\n", at + 4); capture.content("以及🙂与原始JSON文本{}", at + 5);
    await capture.finish({ outcome: "complete", finishReason: "stop", doneReceived: true });
    const raw = await readFile(f.filename, "utf8"), saved = await readDiscoverySyntheticCapture(f.filename);
    expect(raw).not.toContain("NEVER_SAVE"); expect(raw).not.toContain(syntheticInput.additionalText);
    expect(saved.timings).toEqual([{ stage: "first_reasoning", atEpochMs: at + 2, reasoningTokens: 11 }]);
    expect(saved.rawPrefix).toBe("保留引号\"与反斜线\\和换行\n以及🙂与原始JSON文本{}");
    expect(saved.complete).toBe(true);
    expect(saved.observedSources).toEqual([]);
  });

  it("captures only normalized hosted URL/title observations before their content", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    const capture = (await openDiscoverySyntheticCapture(request, f.controls))!;
    capture.hostedSources!([{ url: "HTTPS://EXAMPLE.ORG:443/rules", title: "公开章程",
      queries: ["NEVER_SAVE_SEARCH_QUERY"], page: { content: "NEVER_SAVE_PAGE_BODY" },
      reasoning_content: "NEVER_SAVE_REASONING", answers: syntheticInput.answers, apiKey: "NEVER_SAVE_SECRET" }], at + 1);
    capture.content("正文", at + 2);
    await capture.finish({ outcome: "complete", finishReason: "stop", doneReceived: true });
    const raw = await readFile(f.filename, "utf8"), saved = await readDiscoverySyntheticCapture(f.filename);
    expect(raw).not.toContain("NEVER_SAVE");
    expect(saved.observedSources).toEqual([{ url: "https://example.org/rules", title: "公开章程", atEpochMs: at + 1 }]);
    const lines = raw.trimEnd().split("\n").map(line => JSON.parse(line));
    expect(lines.map(line => line.type)).toEqual(["header", "hosted_sources", "content", "end"]);
    expect(lines[1]).toEqual({ type: "hosted_sources", atEpochMs: at + 1,
      sources: [{ url: "https://example.org/rules", title: "公开章程" }] });
    expect(saved.complete).toBe(true);
    expect(saved.rawPrefix).toBe("正文");
  });

  it("ignores unsafe URLs and malformed optional source metadata without affecting completeness", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    const capture = (await openDiscoverySyntheticCapture(request, f.controls))!;
    expect(() => {
      capture.hostedSources!(null, at + 1);
      capture.hostedSources!([{ url: "https://example.org/ignored", title: "invalid time" }], NaN);
      capture.hostedSources!([
        ...["javascript:alert(1)", "data:text/html,secret", "file:///private/secret", "https://user:secret@example.org/rules", "https://example.org/" + "x".repeat(8192)]
          .map(url => ({ url, title: "NEVER_SAVE_INVALID_SOURCE" })),
        { url: "https://example.org/invalid-title", title: { content: "NEVER_SAVE_RAW_OBJECT" } },
        { url: "https://example.org/missing-title" },
        { url: "https://example.org/allowed", title: "允许的公开资料" },
      ], at + 2);
    }).not.toThrow();
    capture.content("完整正文", at + 3);
    await capture.finish({ outcome: "complete", finishReason: "stop", doneReceived: true });
    const raw = await readFile(f.filename, "utf8"), saved = await readDiscoverySyntheticCapture(f.filename);
    expect(raw).not.toContain("NEVER_SAVE"); expect(raw).not.toContain("secret");
    expect(saved.observedSources).toEqual([{ url: "https://example.org/allowed", title: "允许的公开资料", atEpochMs: at + 2 }]);
    expect(saved.complete).toBe(true);
  });

  it("continues reading old captures with no hosted-source record", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    const capture = (await openDiscoverySyntheticCapture(request, f.controls))!;
    capture.content("旧文件的正文", at + 1);
    await capture.finish({ outcome: "complete", finishReason: "stop", doneReceived: true });
    const raw = await readFile(f.filename, "utf8");
    expect(raw).not.toContain("hosted_sources");
    expect(await readDiscoverySyntheticCapture(f.filename)).toMatchObject({
      observedSources: [], rawPrefix: "旧文件的正文", complete: true,
    });
  });

  it("keeps the exact failed parser prefix including the offending content delta", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    const capture = (await openDiscoverySyntheticCapture(request, f.controls))!;
    const profile = { type: "profile", summary: "合成未知画像", groups: { background: [], goals: [], experience: [], constraints: [] } };
    const chunks = [`${REPORT_START_MARKER}\n${JSON.stringify(profile)}\n`, "NOT_JSON\n"];
    const parser = new DiscoveryPresentationParser({ onRecord() { /* No model or I/O. */ } });
    await parser.push(chunks[0]);
    // Model integration records a delta before passing the same delta to parser.
    capture.content(chunks[0], at + 1); capture.content(chunks[1], at + 2);
    await expect(parser.push(chunks[1])).rejects.toMatchObject({ code: "invalid_json" });
    await capture.finish({ outcome: "incomplete", failureCode: "invalid_output", parserCode: "invalid_json", doneReceived: false });
    const saved = await readDiscoverySyntheticCapture(f.filename);
    expect(saved.rawPrefix).toBe(chunks.join("")); expect(saved.complete).toBe(false); expect(saved.integrity).toBe("prefix");
    const replayed = await replayDiscoverySyntheticCapture(saved, new DiscoveryPresentationParser({ onRecord() { /* No model or I/O. */ } }));
    expect(replayed).toEqual({ sourceComplete: false, parserAccepted: false, replayedChunks: 2, parserErrorCode: "invalid_json" });
  });

  it("replays exact chunk boundaries offline and distinguishes accepted incomplete data", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    const capture = (await openDiscoverySyntheticCapture(request, f.controls))!, chunks = ["中", "文\n", "\ud83d", "\ude42"];
    for (const delta of chunks) capture.content(delta);
    await capture.finish({ outcome: "incomplete", failureCode: "stream_incomplete" });
    const saved = await readDiscoverySyntheticCapture(f.filename), seen: string[] = [];
    const replayed = await replayDiscoverySyntheticCapture(saved, { push(delta) { seen.push(delta); }, finish() {} });
    expect(seen).toEqual(chunks); expect(saved.rawPrefix).toBe("中文\n🙂");
    expect(replayed).toMatchObject({ sourceComplete: false, parserAccepted: true, replayedChunks: 4 });
  });

  it("caps the actual saved file at 8 MiB without skipping forward past a missing delta", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    const capture = (await openDiscoverySyntheticCapture(request, f.controls))!;
    capture.content("exact-prefix"); capture.content("x".repeat(DISCOVERY_SYNTHETIC_CAPTURE_MAX_BYTES)); capture.content("must-not-skip-ahead");
    await capture.finish({ outcome: "complete", finishReason: "stop", doneReceived: true });
    expect((await stat(f.filename)).size).toBeLessThanOrEqual(DISCOVERY_SYNTHETIC_CAPTURE_MAX_BYTES);
    const saved = await readDiscoverySyntheticCapture(f.filename);
    expect(saved.rawPrefix).toBe("exact-prefix"); expect(saved.complete).toBe(false);
    expect(saved.end).toMatchObject({ outcome: "incomplete", captureTruncated: true, receivedChunks: 3, capturedChunks: 1 });
  });

  it("marks missing or malformed trailing evidence incomplete rather than claiming success", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    const capture = (await openDiscoverySyntheticCapture(request, f.controls))!;
    capture.content("saved-prefix"); await capture.finish({ outcome: "complete", finishReason: "stop", doneReceived: true });
    const raw = await readFile(f.filename, "utf8"), lines = raw.trimEnd().split("\n");
    await writeFile(f.filename, `${lines.slice(0, -1).join("\n")}\n`);
    expect(await readDiscoverySyntheticCapture(f.filename)).toMatchObject({ complete: false, integrity: "prefix", readFailure: "missing_end", rawPrefix: "saved-prefix" });
    await writeFile(f.filename, `${raw}{"type":"unexpected","providerBody":"not accepted"}\n`);
    expect(await readDiscoverySyntheticCapture(f.filename)).toMatchObject({ complete: false, readFailure: "invalid_record", rawPrefix: "saved-prefix" });
  });

  it("does not accept a complete label without a normal upstream stop and DONE", async () => {
    const f = await fixture(); await registerDiscoverySyntheticCaptures([makeEntry()], f.controls);
    const capture = (await openDiscoverySyntheticCapture(request, f.controls))!;
    capture.content("prefix"); await capture.finish({ outcome: "complete", finishReason: "length", doneReceived: true });
    expect(await readDiscoverySyntheticCapture(f.filename)).toMatchObject({ complete: false, end: { outcome: "incomplete", finishReason: "length" } });
  });

  it("runs the offline CLI across protocol and UTF-8 chunk variants without printing raw content", async () => {
    const f = await fixture();
    const catalogSnapshot = makeDiscoveryCatalogSnapshot({ competitions: [getCompetitionCatalog()[0]], records: [] });
    const catalogFile = path.join(f.root, "frozen-catalog.json");
    await writeFile(catalogFile, JSON.stringify(catalogSnapshot), { mode: 0o600 });
    await registerDiscoverySyntheticCaptures([makeEntry({ catalogSha256: catalogSnapshot.sha256, protocolVersion: "v16" })], f.controls);
    const capture = (await openDiscoverySyntheticCapture({ ...request, catalogSha256: catalogSnapshot.sha256, protocolVersion: "v16" }, f.controls))!;
    const profile = { type: "profile", summary: "RAW_REPLAY_CONTENT_SHOULD_NOT_APPEAR 中文🙂", groups: { background: [], goals: [], experience: [], constraints: [] } };
    const conclusion = { type: "conclusion", priorities: [], note: "合成未知画像，未确认个人事实，因此没有可靠推荐。", exceptions: [] };
    capture.content(`${REPORT_START_MARKER}\n${JSON.stringify(profile)}\n`);
    capture.content(JSON.stringify(conclusion));
    await capture.finish({ outcome: "complete", finishReason: "stop", doneReceived: true });
    const executable = path.join(process.cwd(), ".runtime/node/bin/node"), script = path.join(process.cwd(), "scripts/competitions/discovery/replay-capture.mjs");
    const { stdout } = await execFileAsync(executable, [script, "--capture", f.filename, "--catalog", catalogFile, "--protocol", "all"], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    expect(stdout).not.toContain("RAW_REPLAY_CONTENT"); expect(stdout).not.toContain(syntheticInput.additionalText);
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({ offline: true, synthetic: true, sourceComplete: true, catalogSource: "provided-matching-hash" });
    const v16 = summary.results.filter((result: { protocol: string }) => result.protocol === "v16");
    expect(v16).toHaveLength(5);
    expect(v16.every((result: { parserAccepted: boolean; sourceComplete: boolean }) => result.parserAccepted && result.sourceComplete)).toBe(true);
    expect(v16.slice(1).every((result: { consistentWithOriginalChunks: boolean }) => result.consistentWithOriginalChunks)).toBe(true);
    await expect(execFileAsync(executable, [script, "--capture", f.filename], { timeout: 15_000 })).rejects.toMatchObject({
      stderr: expect.stringContaining("REPLAY_CATALOG_HASH_MISMATCH"),
    });
  });
});
