import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DiscoveryCatalogSnapshot } from "./transport";

export const DISCOVERY_NESTED_CATALOG_CODEC_VERSION = "discovery-catalog.nested-scope.v1" as const;
const CODEC_FIELDS = ["eligibility", "scopedRules", "legacyFeeFacts", "trackTasks"];
const ENTRY_SHAPE = "entries仍按原columns排列。只将eligibility、scopedRules、legacyFeeFacts及其sources、trackTasks的元组按原位置命名；其他字段和全部原始资料不变。原formats/extraFormats是转换前元组说明，当前显示以命名字段为准。";
const REFERENCE_SHAPE = "引用仅限当前赛事本行，显示为{originalIndex,value}。track/note的value逐字取本行tracks/localNotes原值；source的value只取本行localSources对应项的准确URL，不继承来源表的性质或日期。完整原表及顺序保留，evidence/费用条目各自的性质、状态、日期与范围按自身原值理解。track原索引-1依原formats表示系列范围，此时value为null；原null仍为null。来源原日期不是本轮联网，费用及全部例外不合并、不推断。";
const FIELDS = {
  eligibility: ["state", "notes", "source", "requirements", "special"],
  scopedRules: ["track", "edition", "group", "rules", "cost", "evidence"],
  rule: ["field", "operator", "value", "note"],
  cost: ["personalMinCny", "personalMaxCny", "scope", "note"],
  evidence: ["source", "scope", "checkedAt", "kind", "status"],
  trackTasks: ["track", "task", "source", "scope"],
  feeFact: ["id", "text", "scope", "kind", "status", "reviewStatus", "checkedAt", "lastVerifiedAt", "sources"],
  feeSource: ["sourceId", "title", "publisher", "authority", "scope", "checkedAt", "publishedAt", "accessStatus", "verificationMethod", "integrity", "localSource"],
} as const;
type ObjectValue = Record<string, unknown>;
export type DiscoveryNestedCatalogPayload = ObjectValue & { columns: string[]; entries: unknown[][] };
type ErrorCode = "invalid_snapshot" | "invalid_integrity" | "invalid_json" | "invalid_payload" | "invalid_columns"
  | "invalid_entries" | "invalid_tuple" | "invalid_reference" | "invalid_codec" | "roundtrip_mismatch";
export class DiscoveryNestedCatalogError extends Error {
  constructor(readonly code: ErrorCode) {
    super(`discovery_catalog_nested_${code}`);
    this.name = "DiscoveryNestedCatalogError";
  }
}
const invalid = (code: ErrorCode): never => { throw new DiscoveryNestedCatalogError(code); };
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype ? value as ObjectValue : invalid("invalid_payload");
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid("invalid_entries");
const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, at) => key === b[at]);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function cloneJsonObject(value: unknown): ObjectValue {
  object(value);
  let copy: unknown;
  try { copy = JSON.parse(JSON.stringify(value)); }
  catch { return invalid("invalid_payload"); }
  if (!isDeepStrictEqual(value, copy)) return invalid("invalid_payload");
  return object(copy);
}

function payloadOf(value: unknown): DiscoveryNestedCatalogPayload {
  const payload = cloneJsonObject(value);
  if (payload.schemaVersion !== "competition-discovery-catalog.v7" || typeof payload.version !== "string" || !payload.version) return invalid("invalid_payload");
  if (!Array.isArray(payload.columns) || !payload.columns.length || !payload.columns.every(v => typeof v === "string" && v.length > 0)
    || new Set(payload.columns).size !== payload.columns.length) return invalid("invalid_columns");
  const columns = payload.columns as string[];
  if (!["id", "tracks", "localNotes", "localSources", ...CODEC_FIELDS].every(name => columns.includes(name))
    || !sameKeys(Object.keys(Object.fromEntries(columns.map(key => [key, null]))), columns)
    || !isDeepStrictEqual(payload.legacyFeeFactColumns, FIELDS.feeFact)
    || !isDeepStrictEqual(payload.legacyFeeSourceColumns, FIELDS.feeSource)) return invalid("invalid_columns");
  const entries = array(payload.entries);
  if (!entries.length || entries.some(row => !Array.isArray(row) || row.length !== columns.length)) return invalid("invalid_entries");
  const ids = entries.map(row => (row as unknown[])[columns.indexOf("id")]);
  if (ids.some(id => typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) || new Set(ids).size !== ids.length) return invalid("invalid_entries");
  return payload as DiscoveryNestedCatalogPayload;
}

/** Known tuple lengths, optional tails and exact key order are part of the
 * codec. An unknown key can never disappear during decoding. */
function tuple(value: unknown, fields: readonly string[], lengths: readonly number[], decode: boolean,
  visit: (value: unknown, position: number) => unknown = value => value): unknown {
  if (!decode) {
    const values = array(value);
    if (!lengths.includes(values.length)) return invalid("invalid_tuple");
    return Object.fromEntries(values.map((item, at) => [fields[at], visit(item, at)]));
  }
  const named = object(value), keys = Object.keys(named);
  if (!lengths.includes(keys.length) || !sameKeys(keys, fields.slice(0, keys.length))) return invalid("invalid_tuple");
  return keys.map((key, at) => visit(named[key], at));
}

function transformEntries(payload: DiscoveryNestedCatalogPayload, decode: boolean): unknown[][] {
  return payload.entries.map(original => {
    const row = [...original], get = (name: string) => row[payload.columns.indexOf(name)];
    const set = (name: string, value: unknown) => { row[payload.columns.indexOf(name)] = value; };
    const tracks = array(get("tracks")), notes = array(get("localNotes")), sources = array(get("localSources"));
    if (!tracks.every(v => typeof v === "string") || !notes.every(v => typeof v === "string")) return invalid("invalid_entries");
    const reference = (kind: "track" | "note" | "source", value: unknown): unknown => {
      if (value === null) return null;
      const table = kind === "track" ? tracks : kind === "note" ? notes : sources;
      const ref = decode ? object(value) : undefined;
      if (ref && !sameKeys(Object.keys(ref), ["originalIndex", "value"])) return invalid("invalid_reference");
      const index = ref ? ref.originalIndex : value;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 && !(kind === "track" && index === -1)
        || index >= table.length) return invalid("invalid_reference");
      const originalValue = index === -1 ? null : table[index];
      const resolved = kind !== "source" ? originalValue : typeof originalValue === "string" ? originalValue
        : Array.isArray(originalValue) && typeof originalValue[0] === "string" ? originalValue[0] : invalid("invalid_reference");
      if (ref) {
        if (!isDeepStrictEqual(ref.value, resolved)) return invalid("invalid_reference");
        return index;
      }
      return { originalIndex: index, value: structuredClone(resolved) };
    };
    const t = (value: unknown, fields: readonly string[], lengths: readonly number[], visit?: (value: unknown, at: number) => unknown) => tuple(value, fields, lengths, decode, visit);
    const map = (value: unknown, visit: (value: unknown) => unknown): unknown[] => array(value).map(visit);
    const special = (value: unknown): unknown => {
      if (value === null) return null;
      return Object.fromEntries(Object.entries(object(value)).map(([key, item]) => [key, key !== "firstYear" || item === null ? item
        : Object.fromEntries(Object.entries(object(item)).map(([field, content]) => [field, field === "source" ? reference("source", content) : content]))]));
    };
    set("eligibility", t(get("eligibility"), FIELDS.eligibility, [4, 5], (value, at) => at === 2 ? reference("source", value) : at === 4 ? special(value) : value));
    set("scopedRules", map(get("scopedRules"), scope => t(scope, FIELDS.scopedRules, [6], (value, at) => {
      if (at === 0) return reference("track", value);
      if (at === 3 && value !== null) return map(value, rule => t(rule, FIELDS.rule, [3, 4], (item, position) => position === 3 ? reference("note", item) : item));
      if (at === 4 && value !== null) return t(value, FIELDS.cost, [4], (item, position) => position >= 2 ? reference("note", item) : item);
      if (at === 5) return map(value, evidence => t(evidence, FIELDS.evidence, [5], (item, position) => position === 0 ? reference("source", item) : position === 1 ? reference("note", item) : item));
      return value;
    })));
    set("legacyFeeFacts", map(get("legacyFeeFacts"), fact => t(fact, FIELDS.feeFact, [FIELDS.feeFact.length], (value, at) => at === 8
      ? map(value, source => t(source, FIELDS.feeSource, [FIELDS.feeSource.length], (item, position) => position === 10 ? reference("source", item) : item)) : value)));
    set("trackTasks", map(get("trackTasks"), task => t(task, FIELDS.trackTasks, [4], (value, at) => at === 0 ? reference("track", value) : at === 2 ? reference("source", value) : at === 3 ? reference("note", value) : value)));
    return row;
  });
}

export function encodeDiscoveryNestedCatalogPayload(value: unknown): DiscoveryNestedCatalogPayload {
  const payload = payloadOf(value);
  if (Object.hasOwn(payload, "displayCodec")) return invalid("invalid_codec");
  return { ...payload, entries: transformEntries(payload, false), displayCodec: {
    version: DISCOVERY_NESTED_CATALOG_CODEC_VERSION, sourceSha256: sha256(JSON.stringify(payload)),
    fields: [...CODEC_FIELDS], entryShape: ENTRY_SHAPE, referenceShape: REFERENCE_SHAPE,
  } };
}

export function decodeDiscoveryNestedCatalogPayload(value: unknown): DiscoveryNestedCatalogPayload {
  const payload = payloadOf(value), codec = object(payload.displayCodec);
  if (!sameKeys(Object.keys(codec), ["version", "sourceSha256", "fields", "entryShape", "referenceShape"])
    || codec.version !== DISCOVERY_NESTED_CATALOG_CODEC_VERSION || typeof codec.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(codec.sourceSha256)
    || !isDeepStrictEqual(codec.fields, CODEC_FIELDS) || codec.entryShape !== ENTRY_SHAPE || codec.referenceShape !== REFERENCE_SHAPE) return invalid("invalid_codec");
  const restored: DiscoveryNestedCatalogPayload = { ...payload, entries: transformEntries(payload, true) };
  delete restored.displayCodec;
  if (sha256(JSON.stringify(restored)) !== codec.sourceSha256) return invalid("roundtrip_mismatch");
  return restored;
}

/** Alternate model input only. The original frozen snapshot remains the sole
 * catalog used for source indexes, public details, persisted reports and IDs. */
export function makeDiscoveryNestedCatalogText(snapshot: DiscoveryCatalogSnapshot): string {
  if (!snapshot || typeof snapshot.text !== "string" || typeof snapshot.version !== "string" || !snapshot.version
    || typeof snapshot.clarifyText !== "string" || !Number.isSafeInteger(snapshot.count) || snapshot.count < 1
    || !Array.isArray(snapshot.ids) || snapshot.ids.length !== snapshot.count
    || !snapshot.ids.every(id => typeof id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))
    || new Set(snapshot.ids).size !== snapshot.count) return invalid("invalid_snapshot");
  if (!Number.isSafeInteger(snapshot.byteLength) || Buffer.byteLength(snapshot.text, "utf8") !== snapshot.byteLength
    || typeof snapshot.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(snapshot.sha256) || sha256(snapshot.text) !== snapshot.sha256) return invalid("invalid_integrity");
  let parsed: unknown;
  try { parsed = JSON.parse(snapshot.text); }
  catch { return invalid("invalid_json"); }
  const encoded = encodeDiscoveryNestedCatalogPayload(parsed);
  if (encoded.version !== snapshot.version || encoded.entries.length !== snapshot.count
    || encoded.entries.some((row, at) => row[encoded.columns.indexOf("id")] !== snapshot.ids[at])) return invalid("invalid_entries");
  const restored = decodeDiscoveryNestedCatalogPayload(encoded);
  if (!isDeepStrictEqual(restored, parsed) || JSON.stringify(restored) !== snapshot.text) return invalid("roundtrip_mismatch");
  return JSON.stringify(encoded);
}
