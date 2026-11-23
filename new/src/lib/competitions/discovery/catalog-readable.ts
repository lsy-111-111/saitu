import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DiscoveryCatalogSnapshot } from "./transport";

export const DISCOVERY_NAMED_CATALOG_CODEC_VERSION = "discovery-catalog.named-top.v1" as const;
const ENTRY_SHAPE = "entries每项使用columns中的原字段名；只展开赛事顶层字段。所有内层元组、来源/注释索引、历史归档、状态和说明均按原格式完整保留。";
type ObjectValue = Record<string, unknown>;
export type DiscoveryCatalogPayload = ObjectValue & { columns: string[]; entries: unknown[][] };
export type DiscoveryNamedCatalogPayload = ObjectValue & {
  columns: string[]; entries: ObjectValue[];
  displayCodec: { version: typeof DISCOVERY_NAMED_CATALOG_CODEC_VERSION; entryShape: string };
};
type ErrorCode = "invalid_snapshot" | "invalid_integrity" | "invalid_json" | "invalid_payload" | "invalid_columns"
  | "invalid_entries" | "invalid_ids" | "invalid_codec" | "roundtrip_mismatch";
export class DiscoveryNamedCatalogError extends Error {
  constructor(readonly code: ErrorCode) {
    super(`discovery_catalog_named_${code}`);
    this.name = "DiscoveryNamedCatalogError";
  }
}
const invalid = (code: ErrorCode): never => { throw new DiscoveryNamedCatalogError(code); };
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype ? value as ObjectValue : invalid("invalid_payload");
const sameKeys = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((key, at) => key === right[at]);

/** Helpers accept JSON data only: stringify must never drop undefined, sparse
 * slots, non-finite numbers or custom values while producing a readable view. */
function cloneJsonObject(value: unknown): ObjectValue {
  object(value);
  let copy: unknown;
  try { copy = JSON.parse(JSON.stringify(value)); }
  catch { return invalid("invalid_payload"); }
  if (!isDeepStrictEqual(value, copy)) return invalid("invalid_payload");
  return object(copy);
}

function columnsOf(payload: ObjectValue): string[] {
  if (!Array.isArray(payload.columns) || !payload.columns.length
    || !payload.columns.every(key => typeof key === "string" && key.length > 0)
    || new Set(payload.columns).size !== payload.columns.length) return invalid("invalid_columns");
  const columns = payload.columns as string[];
  // Integer property names have a different JavaScript key enumeration order.
  if (!sameKeys(Object.keys(Object.fromEntries(columns.map(key => [key, null]))), columns)) return invalid("invalid_columns");
  return columns;
}

/** Top-level row names only. All other metadata and every nested value remain
 * JSON-identical; callers cannot mutate the frozen input through this copy. */
export function encodeDiscoveryNamedCatalogPayload(value: unknown): DiscoveryNamedCatalogPayload {
  const payload = cloneJsonObject(value), columns = columnsOf(payload);
  if (Object.hasOwn(payload, "displayCodec")) return invalid("invalid_codec");
  if (!Array.isArray(payload.entries)) return invalid("invalid_entries");
  const entries = payload.entries.map(row => {
    if (!Array.isArray(row) || row.length !== columns.length) return invalid("invalid_entries");
    return Object.fromEntries(columns.map((key, at) => [key, row[at]]));
  });
  return { ...payload, columns, entries, displayCodec: { version: DISCOVERY_NAMED_CATALOG_CODEC_VERSION, entryShape: ENTRY_SHAPE } };
}

/** Decode the declared codec, rejecting missing, extra or reordered row keys
 * instead of silently discarding data or guessing which field owns a value. */
export function decodeDiscoveryNamedCatalogPayload(value: unknown): DiscoveryCatalogPayload {
  const payload = cloneJsonObject(value), columns = columnsOf(payload), codec = object(payload.displayCodec);
  if (!sameKeys(Object.keys(codec), ["version", "entryShape"]) || codec.version !== DISCOVERY_NAMED_CATALOG_CODEC_VERSION
    || codec.entryShape !== ENTRY_SHAPE) return invalid("invalid_codec");
  if (!Array.isArray(payload.entries)) return invalid("invalid_entries");
  const entries = payload.entries.map(value => {
    const row = object(value);
    if (!sameKeys(Object.keys(row), columns)) return invalid("invalid_entries");
    return columns.map(key => row[key]);
  });
  const restored: ObjectValue = { ...payload, entries };
  delete restored.displayCodec;
  return restored as DiscoveryCatalogPayload;
}

/** Experimental model input only. The original snapshot, IDs, source indexes
 * and UI projection remain canonical; this function returns no new snapshot. */
export function makeDiscoveryNamedCatalogText(catalog: DiscoveryCatalogSnapshot): string {
  if (!catalog || typeof catalog.text !== "string" || typeof catalog.version !== "string" || !catalog.version
    || typeof catalog.clarifyText !== "string" || !Number.isSafeInteger(catalog.count) || catalog.count < 1
    || !Array.isArray(catalog.ids) || catalog.ids.length !== catalog.count
    || !catalog.ids.every(id => typeof id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))
    || new Set(catalog.ids).size !== catalog.count) return invalid("invalid_snapshot");
  if (!Number.isSafeInteger(catalog.byteLength) || Buffer.byteLength(catalog.text, "utf8") !== catalog.byteLength
    || typeof catalog.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(catalog.sha256)
    || createHash("sha256").update(catalog.text).digest("hex") !== catalog.sha256) return invalid("invalid_integrity");
  let parsed: unknown;
  try { parsed = JSON.parse(catalog.text); }
  catch { return invalid("invalid_json"); }
  const payload = object(parsed);
  if (payload.schemaVersion !== "competition-discovery-catalog.v7" || payload.version !== catalog.version) return invalid("invalid_payload");
  const named = encodeDiscoveryNamedCatalogPayload(payload);
  if (named.entries.length !== catalog.count || !named.columns.includes("id")
    || named.entries.some((row, at) => row.id !== catalog.ids[at])) return invalid("invalid_ids");
  const restored = decodeDiscoveryNamedCatalogPayload(named);
  // Frozen snapshots are produced as canonical compact JSON. Compare both
  // values and serialized bytes so metadata, order and no field can disappear.
  if (!isDeepStrictEqual(restored, parsed) || JSON.stringify(restored) !== catalog.text) return invalid("roundtrip_mismatch");
  return JSON.stringify(named);
}
