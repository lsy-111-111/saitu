import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeDiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/catalog";
import {
  DISCOVERY_NESTED_CATALOG_CODEC_VERSION, DiscoveryNestedCatalogError, decodeDiscoveryNestedCatalogPayload,
  encodeDiscoveryNestedCatalogPayload, makeDiscoveryNestedCatalogText, type DiscoveryNestedCatalogPayload,
} from "@/lib/competitions/discovery/catalog-nested";
import type { DiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/transport";

const snapshot = makeDiscoveryCatalogSnapshot();
const raw = JSON.parse(snapshot.text) as DiscoveryNestedCatalogPayload;
const at = (payload: DiscoveryNestedCatalogPayload, field: string) => payload.columns.indexOf(field);
const cell = (payload: DiscoveryNestedCatalogPayload, field: string) => payload.entries[0][at(payload, field)];
const obj = (value: unknown) => value as Record<string, unknown>;
function probe(): DiscoveryNestedCatalogPayload {
  const value = structuredClone(raw), row = value.entries[0];
  row[at(value, "tracks")] = ["同赛事赛道甲", "同赛事赛道乙"];
  row[at(value, "localNotes")] = ["仅甲组；1991年3月1日及以后", "学校支付不推个人额", "历史已核不代表本轮", "未引用也保留"];
  row[at(value, "localSources")] = [["https://example.org/one", "official-competition", "2026-01-01"],
    ["https://example.org/one", "school-notice", "2025-02-01"], "https://example.org/two"];
  row[at(value, "eligibility")] = ["partial", ["原范围及以上"], null, { "要求全日制": false, "必须同校组队": false },
    { unknown: ["身份未知不是没有"], firstYear: { edition: "2026/27", minimumYear: null, petition: false, source: 1 }, opaque: [false, null, "", 0] }];
  row[at(value, "scopedRules")] = [
    [-1, null, null, [["fullTime", "eq", false], ["age", "min", 35, 0], ["unknown", "eq", null, null]], [0, null, 1, 2], [[1, 0, "2026-02-01", "official_fact", "pending_review"]]],
    [1, "2026/27", "只限乙组", null, null, []],
  ];
  row[at(value, "trackTasks")] = [[0, "先核权属，不扩大组别", 2, 0], [-1, "仅系列范围", null, null]];
  row[at(value, "legacyFeeFacts")] = [["fact", "原学校费用，不推个人承担", "仅所引届次", "official_fact", "pending_review", null, "2025-01-01", null,
    [["source-id", "原来源", null, "university_local", "仅本校", null, null, "imported_unrechecked", "legacy_import", "unassessed", 1]]]];
  return value;
}

describe("lossless nested catalog input codec", () => {
  it("roundtrips every full-catalog series, original table, metadata and original byte", () => {
    const before = JSON.stringify(snapshot), text = makeDiscoveryNestedCatalogText(snapshot), named = JSON.parse(text);
    expect(named.displayCodec.version).toBe(DISCOVERY_NESTED_CATALOG_CODEC_VERSION);
    expect(named.entries).toHaveLength(snapshot.count);
    expect(named.entries.every(Array.isArray)).toBe(true);
    expect(named.columns).toEqual(raw.columns);
    expect(named.entries.map((row: unknown[]) => row[at(raw, "id")])).toEqual(snapshot.ids);
    const restored = decodeDiscoveryNestedCatalogPayload(named);
    expect(restored).toEqual(raw);
    expect(JSON.stringify(restored)).toBe(snapshot.text);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(makeDiscoveryNestedCatalogText(snapshot)).toBe(text);
    for (const field of ["localSources", "localNotes", "tracks", "archivedMaterials", "criticalScopeNotes"]) {
      expect(named.entries.map((row: unknown[]) => row[at(raw, field)])).toEqual(raw.entries.map(row => row[at(raw, field)]));
    }
  });

  it("binds exact same-row scopes, duplicate URL metadata, false, null, missing tails and negative track sentinel", () => {
    const original = probe(), named = encodeDiscoveryNestedCatalogPayload(original), scopes = cell(named, "scopedRules") as Record<string, unknown>[];
    expect(scopes[0].track).toEqual({ originalIndex: -1, value: null });
    expect(scopes[0].edition).toBeNull();
    expect(scopes[1].track).toEqual({ originalIndex: 1, value: "同赛事赛道乙" });
    expect(scopes[1].rules).toBeNull();
    expect(obj((scopes[0].rules as unknown[])[0])).not.toHaveProperty("note");
    expect(obj((scopes[0].rules as unknown[])[2]).note).toBeNull();
    expect(obj((scopes[0].evidence as unknown[])[0]).source).toEqual({ originalIndex: 1, value: "https://example.org/one" });
    expect(obj((scopes[0].evidence as unknown[])[0]).checkedAt).toBe("2026-02-01");
    expect(obj((scopes[0].evidence as unknown[])[0]).status).toBe("pending_review");
    expect(obj(cell(named, "eligibility")).source).toBeNull();
    expect(obj(obj(obj(cell(named, "eligibility")).special).firstYear).source).toEqual({ originalIndex: 1, value: "https://example.org/one" });
    const feeSource = obj((obj((cell(named, "legacyFeeFacts") as unknown[])[0]).sources as unknown[])[0]);
    expect(feeSource.localSource).toEqual({ originalIndex: 1, value: "https://example.org/one" });
    expect(feeSource.checkedAt).toBeNull();
    expect(feeSource.accessStatus).toBe("imported_unrechecked");
    expect((cell(named, "localSources") as unknown[])[1]).toEqual(["https://example.org/one", "school-notice", "2025-02-01"]);
    expect(decodeDiscoveryNestedCatalogPayload(named)).toEqual(original);
    const noTail = structuredClone(original);
    (cell(noTail, "eligibility") as unknown[]).pop();
    expect(obj(cell(encodeDiscoveryNestedCatalogPayload(noTail), "eligibility"))).not.toHaveProperty("special");
    expect(decodeDiscoveryNestedCatalogPayload(encodeDiscoveryNestedCatalogPayload(noTail))).toEqual(noTail);
  });

  it("rejects altered, cross-row, negative or out-of-range references without substitution", () => {
    for (const edit of [
      (named: DiscoveryNestedCatalogPayload) => { obj(obj(cell(named, "eligibility")).requirements)["要求全日制"] = true; },
      (named: DiscoveryNestedCatalogPayload) => { obj(obj(obj(obj(cell(named, "eligibility")).special).firstYear).source).value = "https://another.example/"; },
      (named: DiscoveryNestedCatalogPayload) => { obj(obj((cell(named, "scopedRules") as unknown[])[0]).track).originalIndex = -2; },
      (named: DiscoveryNestedCatalogPayload) => { obj(obj((cell(named, "trackTasks") as unknown[])[0]).source).originalIndex = 999; },
      (named: DiscoveryNestedCatalogPayload) => { obj(obj((cell(named, "trackTasks") as unknown[])[0]).source).value = raw.entries[1][at(raw, "localSources")]; },
    ]) {
      const named = encodeDiscoveryNestedCatalogPayload(probe()); edit(named);
      expect(() => decodeDiscoveryNestedCatalogPayload(named)).toThrow(DiscoveryNestedCatalogError);
    }
    for (const index of [-1, 999, 0.5, "0"]) {
      const value = probe(); (cell(value, "eligibility") as unknown[])[2] = index;
      expect(() => encodeDiscoveryNestedCatalogPayload(value)).toThrow(DiscoveryNestedCatalogError);
    }
  });

  it("rejects unknown named keys, extra tuple slots, reordered keys and codec collisions rather than discarding them", () => {
    for (const edit of [
      (named: DiscoveryNestedCatalogPayload) => { obj(cell(named, "eligibility")).unknown = "must not vanish"; },
      (named: DiscoveryNestedCatalogPayload) => { obj((cell(named, "trackTasks") as unknown[])[0]).extra = false; },
      (named: DiscoveryNestedCatalogPayload) => { obj(obj((cell(named, "trackTasks") as unknown[])[0]).source).extra = null; },
      (named: DiscoveryNestedCatalogPayload) => { named.entries[0][at(named, "eligibility")] = Object.fromEntries(Object.entries(obj(cell(named, "eligibility"))).reverse()); },
      (named: DiscoveryNestedCatalogPayload) => { obj(named.displayCodec).unknown = true; },
    ]) {
      const named = encodeDiscoveryNestedCatalogPayload(probe()); edit(named);
      expect(() => decodeDiscoveryNestedCatalogPayload(named)).toThrow(DiscoveryNestedCatalogError);
    }
    const extra = probe(); (cell(extra, "trackTasks") as unknown[][])[0].push("unknown slot");
    expect(() => encodeDiscoveryNestedCatalogPayload(extra)).toThrow(DiscoveryNestedCatalogError);
    expect(() => encodeDiscoveryNestedCatalogPayload({ ...probe(), displayCodec: {} })).toThrow(DiscoveryNestedCatalogError);
  });

  it("keeps unknown original metadata and opaque optional facts instead of filling or dropping them", () => {
    const value = probe(); value.originalMetadata = { text: "原状态和范围", unknown: null, flag: false };
    const named = encodeDiscoveryNestedCatalogPayload(value);
    expect(named.originalMetadata).toEqual(value.originalMetadata);
    expect(decodeDiscoveryNestedCatalogPayload(named)).toEqual(value);
    obj(obj(cell(named, "eligibility")).requirements)["要求全日制"] = true;
    expect(obj((cell(value, "eligibility") as unknown[])[3])["要求全日制"]).toBe(false);
  });

  it("validates frozen integrity, schema, dimensions, version, identities and canonical serialization", () => {
    for (const edit of [{ byteLength: snapshot.byteLength - 1 }, { sha256: "0".repeat(64) }, { count: snapshot.count + 1 },
      { version: "different" }, { ids: [...snapshot.ids].reverse() }]) {
      expect(() => makeDiscoveryNestedCatalogText({ ...snapshot, ...edit })).toThrow(DiscoveryNestedCatalogError);
    }
    for (const text of ["{bad", JSON.stringify(raw, null, 2), JSON.stringify({ ...raw, schemaVersion: "future" }),
      JSON.stringify({ ...raw, entries: raw.entries.slice(1) })]) {
      const value: DiscoveryCatalogSnapshot = { ...snapshot, text, byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
      expect(() => makeDiscoveryNestedCatalogText(value)).toThrow(DiscoveryNestedCatalogError);
    }
    const columns = probe(); columns.columns[0] = columns.columns[1];
    expect(() => encodeDiscoveryNestedCatalogPayload(columns)).toThrow(DiscoveryNestedCatalogError);
  });

  it("rejects non-JSON coercion and emits only fixed content-free errors", () => {
    for (const value of [undefined, NaN, -0, new Date("2026-01-01"), Array(1)]) {
      const payload = probe(); payload.unsafeValue = value;
      expect(() => encodeDiscoveryNestedCatalogPayload(payload)).toThrow(DiscoveryNestedCatalogError);
    }
    const payload = probe(); (cell(payload, "eligibility") as unknown[])[2] = "synthetic-sensitive-value";
    expect(() => encodeDiscoveryNestedCatalogPayload(payload)).toThrow("discovery_catalog_nested_invalid_reference");
    try { encodeDiscoveryNestedCatalogPayload(payload); }
    catch (error) { expect(String(error)).not.toContain("synthetic-sensitive-value"); }
  });
});
