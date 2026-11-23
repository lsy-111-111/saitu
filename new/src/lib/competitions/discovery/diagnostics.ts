import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { safeDiscoverySourceUrl } from "./sources";

/** No model content is recorded unless a private, expiring synthetic-call
 * allowlist and the explicit local-worker switch both authorize this call. */
export const DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_ENV = "SAITU_DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST";
export const DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_RELATIVE = ".local/checks/discovery-synthetic-capture-allowlist.json";
export const DISCOVERY_SYNTHETIC_CAPTURE_DIRECTORY_RELATIVE = ".local/checks/discovery-synthetic-captures";
export const DISCOVERY_SYNTHETIC_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ALLOWLIST_BYTES = 256 * 1024;
const FOOTER_RESERVE_BYTES = 4096;
const SOURCE = "discovery-live-synthetic";
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const version = z.string().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(HASH);
const format = z.enum(["legacy", "discovery-cards.v1"]);

export const discoverySyntheticCaptureEntrySchema = z.object({
  callId: z.string().regex(UUID), inputSha256: hash, catalogSha256: hash,
  caseId: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  presentationVersion: format, expiresAt: z.string().datetime(),
  benchmarkVariant: version.optional(), protocolVersion: version, round: z.number().int().min(1).max(100).optional(),
}).strict();
export type DiscoverySyntheticCaptureEntry = z.infer<typeof discoverySyntheticCaptureEntrySchema>;
const allowlistSchema = z.object({
  schemaVersion: z.literal("saitu.discovery-synthetic-capture-allowlist.v1"),
  source: z.literal(SOURCE), runtimeBinding: hash,
  entries: z.array(discoverySyntheticCaptureEntrySchema).max(512),
}).strict();

type Controls = { root?: string; environment?: Record<string, string | undefined>; now?: () => number };
type LocalPaths = { root: string; allowlist: string; directory: string; runtimeBinding: string; now: () => number };
const owned = (stat: { uid: number; mode: number }, mode: number) => typeof process.getuid === "function"
  && stat.uid === process.getuid() && (stat.mode & 0o777) === mode;

function localPaths(controls: Controls = {}): LocalPaths | null {
  const environment = controls.environment ?? process.env;
  if (environment.SAITU_STANDALONE_LOCAL !== "1" || ![undefined, "", "local"].includes(environment.SAITU_RUNTIME_MODE)
    || environment.SAITU_AI_EXECUTION_MODE !== "finite" || !HASH.test(environment.SAITU_DISCOVERY_SOURCE_SHA256 ?? "")) return null;
  try {
    const database = new URL(environment.DATABASE_URL ?? ""), origin = new URL(environment.NEXT_PUBLIC_SITE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(database.protocol) || database.hostname !== "127.0.0.1" || database.port !== "5433"
      || database.pathname !== "/saitu_clean" || database.search || database.hash
      || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !["3190", "3191"].includes(origin.port)
      || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) return null;
    const root = path.resolve(controls.root ?? process.cwd()), allowlist = path.join(root, DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_RELATIVE);
    if (environment[DISCOVERY_SYNTHETIC_CAPTURE_ALLOWLIST_ENV] !== allowlist) return null;
    return { root, allowlist, directory: path.join(root, DISCOVERY_SYNTHETIC_CAPTURE_DIRECTORY_RELATIVE),
      runtimeBinding: environment.SAITU_DISCOVERY_SOURCE_SHA256!, now: controls.now ?? Date.now };
  } catch { return null; }
}

async function privateDirectory(directory: string, create = false): Promise<void> {
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat, 0o700)) throw new Error("SYNTHETIC_CAPTURE_DIRECTORY_INVALID");
}

async function localBoundary(paths: LocalPaths, create = false): Promise<void> {
  await privateDirectory(path.join(paths.root, ".local"), create);
  await privateDirectory(path.join(paths.root, ".local/checks"), create);
  // The manifest is public build provenance, never the model's request or keys.
  const filename = path.join(paths.root, ".next/decision-worker-binding.json");
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("SYNTHETIC_CAPTURE_SOURCE_INVALID");
  const manifest = JSON.parse(await readFile(filename, "utf8")) as { sourceSha256?: unknown };
  if (manifest.sourceSha256 !== paths.runtimeBinding) throw new Error("SYNTHETIC_CAPTURE_SOURCE_INVALID");
}

async function privateFile(filename: string, maximum: number): Promise<FileHandle> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat, 0o600) || stat.size > maximum) throw new Error("SYNTHETIC_CAPTURE_FILE_INVALID");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = await handle.stat();
  if (!opened.isFile() || !owned(opened, 0o600) || opened.size > maximum || opened.ino !== stat.ino || opened.dev !== stat.dev) {
    await handle.close(); throw new Error("SYNTHETIC_CAPTURE_FILE_INVALID");
  }
  return handle;
}

async function loadAllowlist(paths: LocalPaths) {
  const file = await privateFile(paths.allowlist, MAX_ALLOWLIST_BYTES);
  try {
    const parsed = allowlistSchema.parse(JSON.parse(await file.readFile("utf8")));
    if (parsed.runtimeBinding !== paths.runtimeBinding || new Set(parsed.entries.map(entry => entry.callId)).size !== parsed.entries.length)
      throw new Error("SYNTHETIC_CAPTURE_ALLOWLIST_INVALID");
    return parsed;
  } finally { await file.close(); }
}

/** The harness and worker hash exactly these synthetic facts, never a request
 * string containing dates, provider secrets, or database recovery credentials. */
export function discoverySyntheticInputSha256(input: { answers: unknown; additionalText: string; followups: unknown }): string {
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    throw new Error("SYNTHETIC_CAPTURE_INPUT_INVALID");
  };
  return createHash("sha256").update("saitu.discovery-synthetic-input.v1\0").update(JSON.stringify(canonical({ answers: input.answers, additionalText: input.additionalText, followups: input.followups }))).digest("hex");
}

/** Call before committing the synthetic enqueue. Registration itself never
 * dispatches a model, changes a grant, or authorizes a nonmatching request. */
export async function registerDiscoverySyntheticCaptures(entries: DiscoverySyntheticCaptureEntry[], controls: Controls = {}): Promise<void> {
  const paths = localPaths(controls);
  if (!paths) throw new Error("SYNTHETIC_CAPTURE_LOCAL_CONFIGURATION_REQUIRED");
  await localBoundary(paths, true);
  const now = paths.now(), parsed = z.array(discoverySyntheticCaptureEntrySchema).min(1).max(512).parse(entries);
  if (parsed.some(entry => Date.parse(entry.expiresAt) <= now || Date.parse(entry.expiresAt) > now + 24 * 60 * 60 * 1000))
    throw new Error("SYNTHETIC_CAPTURE_EXPIRY_INVALID");
  const lockPath = `${paths.allowlist}.lock`;
  let lock: FileHandle | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (attempt === 39) throw new Error("SYNTHETIC_CAPTURE_ALLOWLIST_BUSY"); await delay(50); }
  }
  const temporary = `${paths.allowlist}.${randomUUID()}.tmp`;
  try {
    let existing: DiscoverySyntheticCaptureEntry[] = [];
    try { existing = (await loadAllowlist(paths)).entries.filter(entry => Date.parse(entry.expiresAt) > now); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const byCall = new Map(existing.map(entry => [entry.callId, entry]));
    for (const entry of parsed) {
      const previous = byCall.get(entry.callId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error("SYNTHETIC_CAPTURE_CALL_CHANGED");
      byCall.set(entry.callId, entry);
    }
    const payload = allowlistSchema.parse({ schemaVersion: "saitu.discovery-synthetic-capture-allowlist.v1", source: SOURCE, runtimeBinding: paths.runtimeBinding, entries: [...byCall.values()] });
    const encoded = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(encoded) > MAX_ALLOWLIST_BYTES) throw new Error("SYNTHETIC_CAPTURE_ALLOWLIST_TOO_LARGE");
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
    await rename(temporary, paths.allowlist);
  } finally {
    await unlink(temporary).catch(() => undefined);
    await lock?.close();
    if (lock) await unlink(lockPath).catch(() => undefined);
  }
}

const STAGES = ["model_prepared", "gate_wait_started", "gate_acquired", "dispatched", "response_headers", "first_reasoning", "first_upstream_text", "upstream_complete"] as const;
const timingSchema = z.object({
  stage: z.enum(STAGES), atEpochMs: epoch, waitMs: integer.optional(), httpStatus: integer.max(599).optional(),
  inputTokens: integer.optional(), outputTokens: integer.optional(), cachedInputTokens: integer.optional(), reasoningTokens: integer.optional(),
  reasoningChunks: integer.optional(), textChunks: integer.optional(), textBytes: integer.optional(), searchCalls: integer.optional(), readCalls: integer.optional(),
}).strip();
const failureCodes = ["missing_api_key", "provider_not_allowed", "authentication_error", "insufficient_balance", "invalid_request", "rate_limited", "upstream_server_error", "network_error", "timeout", "cancelled", "invalid_output", "empty_content", "truncated", "refusal", "stream_incomplete", "response_too_large", "delivery_error", "unknown"] as const;
const parserCodes = ["missing_marker", "invalid_json", "invalid_record", "invalid_sequence", "duplicate_card", "invalid_conclusion", "incomplete_report", "response_too_large"] as const;
const finishSchema = z.object({
  outcome: z.enum(["complete", "incomplete"]), failureCode: z.enum(failureCodes).optional(), parserCode: z.enum(parserCodes).optional(),
  finishReason: z.enum(["stop", "length", "content_filter", "tool_calls", "function_call", "unknown"]).optional(), doneReceived: z.boolean().optional(),
}).strip();
export type DiscoverySyntheticCaptureFinish = z.infer<typeof finishSchema>;
const headerSchema = z.object({
  type: z.literal("header"), schemaVersion: z.literal("saitu.discovery-synthetic-content-capture.v1"), source: z.literal(SOURCE),
  callId: z.string().regex(UUID), inputSha256: hash, catalogSha256: hash, runtimeBinding: hash,
  caseId: discoverySyntheticCaptureEntrySchema.shape.caseId, presentationVersion: format,
  benchmarkVariant: version.optional(), protocolVersion: version, round: z.number().int().min(1).max(100).optional(),
  model: z.literal("deepseek-flash"), reasoningEffort: z.enum(["high", "max"]), promptVersion: version, createdAtEpochMs: epoch,
  messagesSha256: hash.optional(),
}).strict();
const contentSchema = z.object({ type: z.literal("content"), atEpochMs: epoch, delta: z.string(), index: integer }).strict();
const timingRecordSchema = z.object({ type: z.literal("timing"), timing: timingSchema }).strict();
const hostedSourceSchema = z.object({
  url: z.string().max(8192).refine(value => safeDiscoverySourceUrl(value) !== null)
    .transform(value => safeDiscoverySourceUrl(value)!),
  title: z.string().max(500),
}).strip();
const hostedSourcesRecordSchema = z.object({
  type: z.literal("hosted_sources"), atEpochMs: epoch, sources: z.array(hostedSourceSchema).min(1),
}).strict();
const endSchema = finishSchema.extend({
  type: z.literal("end"), captureTruncated: z.boolean(), receivedChunks: integer, capturedChunks: integer,
  receivedCodeUnits: integer, capturedCodeUnits: integer, finishedAtEpochMs: epoch,
}).strict();
export type DiscoverySyntheticCapture = {
  header: z.infer<typeof headerSchema>; chunks: z.infer<typeof contentSchema>[]; timings: z.infer<typeof timingSchema>[];
  observedSources: (z.infer<typeof hostedSourceSchema> & { atEpochMs: number })[];
  end?: z.infer<typeof endSchema>; rawPrefix: string; complete: boolean;
  integrity: "complete" | "prefix"; readFailure?: "missing_end" | "invalid_record" | "invalid_counts";
};
export type DiscoverySyntheticCaptureRecorder = {
  /** Invoke before any presentation parser consumes the same content delta. */
  content(delta: string, atEpochMs?: number): void;
  /** Unknown metadata fields are discarded; no provider/tool payloads survive. */
  timing(value: unknown): void;
  /** Only the normalized URL/title projection from completed hosted metadata.
   * Call before parsing content from the same provider frame. */
  hostedSources?(sources: unknown, atEpochMs?: number): void;
  finish(value: DiscoverySyntheticCaptureFinish): Promise<void>;
};

export async function openDiscoverySyntheticCapture(input: {
  callId: string; inputSha256: string; catalogSha256: string; model: string; reasoningEffort: "max" | "high";
  presentationVersion?: "legacy" | "discovery-cards.v1"; protocolVersion: string; promptVersion: string; messagesSha256?: string;
}, controls: Controls = {}): Promise<DiscoverySyntheticCaptureRecorder | null> {
  let file: FileHandle | undefined;
  try {
    const paths = localPaths(controls);
    if (!paths || !UUID.test(input.callId) || !HASH.test(input.inputSha256) || !HASH.test(input.catalogSha256)) return null;
    await localBoundary(paths);
    const allowlist = await loadAllowlist(paths), now = paths.now();
    const entry = allowlist.entries.find(entry => entry.callId === input.callId && entry.inputSha256 === input.inputSha256
      && entry.catalogSha256 === input.catalogSha256 && entry.presentationVersion === (input.presentationVersion ?? "legacy")
      && entry.protocolVersion === input.protocolVersion
      && Date.parse(entry.expiresAt) > now && Date.parse(entry.expiresAt) <= now + 24 * 60 * 60 * 1000);
    if (!entry) return null;
    const { expiresAt: _expiresAt, ...binding } = entry;
    const header = headerSchema.parse({ type: "header", schemaVersion: "saitu.discovery-synthetic-content-capture.v1", source: SOURCE,
      ...binding, runtimeBinding: paths.runtimeBinding, model: input.model, reasoningEffort: input.reasoningEffort,
      promptVersion: input.promptVersion, createdAtEpochMs: now,
      ...(input.messagesSha256 ? { messagesSha256: input.messagesSha256 } : {}) });
    await privateDirectory(paths.directory, true);
    file = await open(path.join(paths.directory, `${input.callId}.ndjson`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let queue = Promise.resolve(), fileBytes = 0, closed = false, failed = false, captureTruncated = false;
    let receivedChunks = 0, capturedChunks = 0, receivedCodeUnits = 0, capturedCodeUnits = 0;
    const handle = file;
    const write = (value: unknown, footer = false): boolean => {
      const line = `${JSON.stringify(value)}\n`, bytes = Buffer.byteLength(line);
      if (fileBytes + bytes > DISCOVERY_SYNTHETIC_CAPTURE_MAX_BYTES - (footer ? 0 : FOOTER_RESERVE_BYTES)) { captureTruncated = true; return false; }
      fileBytes += bytes;
      queue = queue.then(async () => { if (!failed) await handle.writeFile(line); }).catch(() => { failed = true; });
      return true;
    };
    write(header);
    return {
      content(delta, atEpochMs = paths.now()) {
        if (closed || typeof delta !== "string" || !delta) return;
        receivedChunks += 1; receivedCodeUnits += delta.length;
        if (captureTruncated || failed || !epoch.safeParse(atEpochMs).success) { captureTruncated = true; return; }
        if (write({ type: "content", atEpochMs, delta, index: capturedChunks })) { capturedChunks += 1; capturedCodeUnits += delta.length; }
      },
      timing(value) {
        if (closed || captureTruncated || failed) return;
        const parsed = timingSchema.safeParse(value);
        if (parsed.success) write({ type: "timing", timing: parsed.data });
      },
      hostedSources(value, atEpochMs = paths.now()) {
        if (closed || captureTruncated || failed || !Array.isArray(value) || !epoch.safeParse(atEpochMs).success) return;
        try {
          const sources = value.flatMap(source => {
            const parsed = hostedSourceSchema.safeParse(source);
            return parsed.success ? [parsed.data] : [];
          });
          if (sources.length) write({ type: "hosted_sources", atEpochMs, sources });
        } catch { /* Invalid optional metadata never changes model delivery. */ }
      },
      async finish(value) {
        if (closed) return;
        closed = true;
        const parsed = finishSchema.safeParse(value);
        const safe = parsed.success ? parsed.data : { outcome: "incomplete" as const, failureCode: "unknown" as const };
        const complete = safe.outcome === "complete" && safe.finishReason === "stop" && safe.doneReceived === true
          && !safe.failureCode && !safe.parserCode && !captureTruncated;
        write({ ...safe, type: "end", outcome: complete ? "complete" : "incomplete", captureTruncated,
          receivedChunks, capturedChunks, receivedCodeUnits, capturedCodeUnits, finishedAtEpochMs: paths.now() }, true);
        await queue;
        await handle.close().catch(() => undefined);
      },
    };
  } catch {
    await file?.close().catch(() => undefined);
    return null;
  }
}

/** Reads synthetic final-content deltas and bounded URL/title observations.
 * Older files without source observations return an empty observedSources.
 * An absent/partial footer
 * stays an explicitly incomplete raw prefix, even when a parser accepts it. */
export async function readDiscoverySyntheticCapture(filename: string): Promise<DiscoverySyntheticCapture> {
  const handle = await privateFile(filename, DISCOVERY_SYNTHETIC_CAPTURE_MAX_BYTES);
  let raw: string;
  try { raw = await handle.readFile("utf8"); } finally { await handle.close(); }
  const lines = raw.split("\n");
  const first = lines.shift();
  let header: z.infer<typeof headerSchema>;
  try { header = headerSchema.parse(JSON.parse(first ?? "")); } catch { throw new Error("SYNTHETIC_CAPTURE_HEADER_INVALID"); }
  const chunks: DiscoverySyntheticCapture["chunks"] = [], timings: DiscoverySyntheticCapture["timings"] = [],
    observedSources: DiscoverySyntheticCapture["observedSources"] = [];
  let end: DiscoverySyntheticCapture["end"], readFailure: DiscoverySyntheticCapture["readFailure"];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line && index === lines.length - 1) continue;
    try {
      if (end) throw new Error("record_after_end");
      const value = JSON.parse(line) as { type?: unknown };
      if (value?.type === "content") {
        const content = contentSchema.parse(value);
        if (content.index !== chunks.length) throw new Error("content_gap");
        chunks.push(content);
      } else if (value?.type === "timing") timings.push(timingRecordSchema.parse(value).timing);
      else if (value?.type === "hosted_sources") {
        const observed = hostedSourcesRecordSchema.parse(value);
        observedSources.push(...observed.sources.map(source => ({ ...source, atEpochMs: observed.atEpochMs })));
      }
      else if (value?.type === "end") end = endSchema.parse(value);
      else throw new Error("unknown_record");
    } catch { readFailure = "invalid_record"; break; }
  }
  const rawPrefix = chunks.map(chunk => chunk.delta).join("");
  if (!end) readFailure ??= "missing_end";
  else if (end.capturedChunks !== chunks.length || end.capturedCodeUnits !== rawPrefix.length || end.receivedChunks < end.capturedChunks
    || end.receivedCodeUnits < end.capturedCodeUnits || !end.captureTruncated && (end.receivedChunks !== end.capturedChunks || end.receivedCodeUnits !== end.capturedCodeUnits)) readFailure = "invalid_counts";
  const complete = !readFailure && end?.outcome === "complete" && end.finishReason === "stop" && end.doneReceived === true
    && !end.failureCode && !end.parserCode && !end.captureTruncated;
  return { header, chunks, timings, observedSources, ...(end ? { end } : {}), rawPrefix, complete, integrity: complete ? "complete" : "prefix", ...(readFailure ? { readFailure } : {}) };
}

/** Parser acceptance is separate from source completeness and recommendation
 * quality. A saved failed/truncated prefix is never promoted to success. */
export async function replayDiscoverySyntheticCapture(capture: DiscoverySyntheticCapture, consumer: {
  push(delta: string): unknown | Promise<unknown>; finish(): unknown | Promise<unknown>;
}): Promise<{ sourceComplete: boolean; parserAccepted: boolean; replayedChunks: number; parserErrorCode?: string }> {
  let replayedChunks = 0;
  try {
    for (const chunk of capture.chunks) { replayedChunks += 1; await consumer.push(chunk.delta); }
    await consumer.finish();
    return { sourceComplete: capture.complete, parserAccepted: true, replayedChunks };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return { sourceComplete: capture.complete, parserAccepted: false, replayedChunks,
      parserErrorCode: typeof code === "string" && (parserCodes as readonly string[]).includes(code) ? code : "unknown" };
  }
}
