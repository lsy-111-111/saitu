#!/usr/bin/env node
/** Offline diagnosis only: no environment secrets, database, server lifecycle,
 * model authorization or paid API are loaded. Stdout never contains prose. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installSourceLoader } from "../../lib/load-typescript-source.mjs";
import { isDirectExecution } from "../../lib/direct-execution.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
installSourceLoader(root);
const { readDiscoverySyntheticCapture, replayDiscoverySyntheticCapture } = await import("../../../src/lib/competitions/discovery/diagnostics.ts");
const { makeDiscoveryCatalogSnapshot } = await import("../../../src/lib/competitions/discovery/catalog.ts");
const { createDiscoveryCatalogPresentation } = await import("../../../src/lib/competitions/discovery/catalog-presentation.ts");
const { createDiscoveryProtocolParser } = await import("../../../src/lib/competitions/discovery/protocol-wire.ts");
const { DISCOVERY_GENERATION_PROTOCOLS } = await import("../../../src/lib/competitions/discovery/generation-protocol.ts");
const CHUNKINGS = ["original", "one-code-unit", "utf8-1", "utf8-7", "utf8-257"];
const fail = code => Object.assign(new Error(code), { safeCode: code });

function argumentsOf(args) {
  let capture, catalog, protocol;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--help") return { help: true };
    if (!["--capture", "--catalog", "--protocol"].includes(name) || !args[index + 1]) throw fail("REPLAY_ARGUMENTS_INVALID");
    const value = args[++index];
    if (name === "--capture") { if (capture) throw fail("REPLAY_ARGUMENTS_INVALID"); capture = path.resolve(value); }
    if (name === "--catalog") { if (catalog) throw fail("REPLAY_ARGUMENTS_INVALID"); catalog = path.resolve(value); }
    if (name === "--protocol") { if (protocol) throw fail("REPLAY_ARGUMENTS_INVALID"); protocol = value; }
  }
  if (!capture) throw fail("REPLAY_CAPTURE_REQUIRED");
  if (protocol && protocol !== "all" && protocol !== "legacy" && !DISCOVERY_GENERATION_PROTOCOLS.includes(protocol)) throw fail("REPLAY_PROTOCOL_INVALID");
  return { capture, catalog, protocol };
}

function* contentChunks(capture, chunking) {
  if (chunking === "original") { for (const chunk of capture.chunks) yield chunk.delta; return; }
  if (chunking === "one-code-unit") { for (let index = 0; index < capture.rawPrefix.length; index += 1) yield capture.rawPrefix[index]; return; }
  const size = Number(chunking.slice(5)), bytes = Buffer.from(capture.rawPrefix, "utf8"), decoder = new TextDecoder("utf-8", { fatal: true });
  // Byte encoding cannot preserve a lone UTF-16 surrogate. Never silently
  // replace such a captured prefix just to make a replay pass.
  if (bytes.toString("utf8") !== capture.rawPrefix) throw fail("REPLAY_UNICODE_ROUNDTRIP_LOSS");
  for (let offset = 0; offset < bytes.length; offset += size) {
    const delta = decoder.decode(bytes.subarray(offset, offset + size), { stream: true });
    if (delta) yield delta;
  }
  const tail = decoder.decode(); if (tail) yield tail;
}

async function runOne(capture, catalog, protocol, chunking) {
  let recordCount = 0, cardCount = 0, profile = false, conclusion = false;
  const digest = createHash("sha256");
  const onRecord = record => {
    recordCount += 1; cardCount += Number(record.type === "card");
    profile ||= record.type === "profile"; conclusion ||= record.type === "conclusion";
    digest.update(JSON.stringify(record)).update("\n");
  };
  const consumer = protocol === "legacy" ? { async push() {}, async finish() {} }
    : createDiscoveryProtocolParser({ protocolVersion: protocol, catalog, onRecord });
  // Keep the original completeness flag. Rechunking a captured prefix does not
  // add missing provider data, a normal finish reason, or [DONE].
  if (chunking.startsWith("utf8-") && Buffer.from(capture.rawPrefix, "utf8").toString("utf8") !== capture.rawPrefix) {
    return { protocol, chunking, sourceComplete: capture.complete, parserAccepted: false, skipped: true,
      reason: "REPLAY_UNICODE_ROUNDTRIP_LOSS" };
  }
  // Stream rechunked values rather than allocating millions of per-character
  // objects for a capture near the size limit.
  const chunks = (function* () {
    let index = 0;
    for (const delta of contentChunks(capture, chunking)) yield { type: "content", index: index++, atEpochMs: capture.header.createdAtEpochMs, delta };
  })();
  const replay = await replayDiscoverySyntheticCapture({ ...capture, chunks }, consumer);
  return { protocol, chunking, validation: protocol === "legacy" ? "text-only-no-structured-validation" : "presentation-protocol-parser",
    ...replay, recordCount, cardCount, profile, conclusion, recordSha256: digest.digest("hex") };
}

export async function replayDiscoveryCapture(args = process.argv.slice(2)) {
  const options = argumentsOf(args);
  if (options.help) return { usage: "replay-capture.mjs --capture FILE [--catalog FROZEN-SNAPSHOT.json] [--protocol NAME|all]",
    protocols: ["legacy", ...DISCOVERY_GENERATION_PROTOCOLS], chunkings: CHUNKINGS, offline: true };
  let capture;
  try { capture = await readDiscoverySyntheticCapture(options.capture); } catch { throw fail("REPLAY_CAPTURE_READ_FAILED"); }
  let catalog;
  try {
    if (options.catalog) {
      if ((await stat(options.catalog)).size > 16 * 1024 * 1024) throw fail("REPLAY_CATALOG_TOO_LARGE");
      catalog = JSON.parse(await readFile(options.catalog, "utf8"));
    } else catalog = makeDiscoveryCatalogSnapshot();
    if (catalog?.sha256 !== capture.header.catalogSha256) throw fail("REPLAY_CATALOG_HASH_MISMATCH");
    createDiscoveryCatalogPresentation(catalog);
  } catch (error) {
    if (["REPLAY_CATALOG_HASH_MISMATCH", "REPLAY_CATALOG_TOO_LARGE"].includes(error.safeCode)) throw error;
    throw fail("REPLAY_CATALOG_INVALID");
  }
  const requested = options.protocol ?? capture.header.protocolVersion;
  const protocols = requested === "all" ? [...DISCOVERY_GENERATION_PROTOCOLS] : [requested];
  if (protocols.some(protocol => protocol !== "legacy" && !DISCOVERY_GENERATION_PROTOCOLS.includes(protocol))) throw fail("REPLAY_PROTOCOL_INVALID");
  const results = [];
  for (const protocol of protocols) {
    const originalIndex = results.length;
    for (const chunking of CHUNKINGS) {
      const result = await runOne(capture, catalog, protocol, chunking);
      const original = results[originalIndex];
      results.push({ ...result, ...(original && !result.skipped ? { consistentWithOriginalChunks:
        result.parserAccepted === original.parserAccepted && result.parserErrorCode === original.parserErrorCode
        && result.recordCount === original.recordCount && result.recordSha256 === original.recordSha256 } : {}) });
    }
  }
  return { schemaVersion: "saitu.discovery-synthetic-replay.v1", synthetic: true, offline: true,
    callId: capture.header.callId, caseId: capture.header.caseId, inputSha256: capture.header.inputSha256,
    catalogSha256: catalog.sha256, catalogSource: options.catalog ? "provided-matching-hash" : "current-matching-hash",
    sourceProtocolVersion: capture.header.protocolVersion, sourcePresentationVersion: capture.header.presentationVersion,
    sourceComplete: capture.complete, integrity: capture.integrity, ...(capture.readFailure ? { readFailure: capture.readFailure } : {}),
    capturedChunks: capture.chunks.length, capturedCodeUnits: capture.rawPrefix.length,
    ...(capture.end ? { sourceOutcome: capture.end.outcome, sourceFailureCode: capture.end.failureCode, sourceParserCode: capture.end.parserCode, captureTruncated: capture.end.captureTruncated } : {}),
    results, limitations: ["Parser acceptance does not certify facts, eligibility, source provenance, or recommendation quality.",
      "Provider reasoning, tool payloads, credentials and student answers are deliberately absent; this replay cannot validate new web sources.",
      "An incomplete source remains incomplete even when an offline parser accepts its saved prefix."] };
}

if (isDirectExecution(import.meta.url)) {
  try { console.info(JSON.stringify(await replayDiscoveryCapture(), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ schemaVersion: "saitu.discovery-synthetic-replay.v1", offline: true,
      error: typeof error?.safeCode === "string" && /^REPLAY_[A-Z0-9_]+$/u.test(error.safeCode) ? error.safeCode : "REPLAY_FAILED" }));
    process.exitCode = 1;
  }
}
