import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeDiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/catalog";
import {
  DISCOVERY_NAMED_CATALOG_CODEC_VERSION, DiscoveryNamedCatalogError, decodeDiscoveryNamedCatalogPayload,
  encodeDiscoveryNamedCatalogPayload, makeDiscoveryNamedCatalogText,
} from "@/lib/competitions/discovery/catalog-readable";
import type { DiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/transport";

const snapshot = makeDiscoveryCatalogSnapshot();
const raw = JSON.parse(snapshot.text);
function changed(edit: (payload: typeof raw) => void): DiscoveryCatalogSnapshot {
  const payload = JSON.parse(snapshot.text);
  edit(payload);
  const text = JSON.stringify(payload);
  return { ...snapshot, text, byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}

describe("lossless model-readable named catalog", () => {
  it("retains every frozen series, column, nested value and metadata byte after decode", () => {
    const before = JSON.stringify(snapshot), text = makeDiscoveryNamedCatalogText(snapshot), named = JSON.parse(text);
    expect(named.displayCodec.version).toBe(DISCOVERY_NAMED_CATALOG_CODEC_VERSION);
    expect(named.entries).toHaveLength(snapshot.count);
    expect(named.entries.map((row: Record<string, unknown>) => row.id)).toEqual(snapshot.ids);
    expect(named.columns).toEqual(raw.columns);
    expect(named.schemaVersion).toBe(raw.schemaVersion);
    expect(named.version).toBe(snapshot.version);
    const restored = decodeDiscoveryNamedCatalogPayload(named);
    expect(restored).toEqual(raw);
    expect(JSON.stringify(restored)).toBe(snapshot.text);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(makeDiscoveryNamedCatalogText(snapshot)).toBe(text);
  });

  it("preserves false, null, empty, numeric indexes, source ownership, scope and archived status", () => {
    const probe = { schemaVersion: "probe", version: "frozen", boundary: "原范围不扩大", columns: ["id", "scope", "flags", "archive"],
      entries: [["probe", "1991年3月1日及以后；集体作品条件", [false, null, "", [], 0],
        { status: "pending_review", text: "原文已核", sourceRefs: [1, 0], fee: [0, null, "学校支付，不推个人额"] }]],
      formats: { source: "只限同赛事", nested: { retained: true } } };
    const named = encodeDiscoveryNamedCatalogPayload(probe);
    expect(decodeDiscoveryNamedCatalogPayload(named)).toEqual(probe);
    (named.entries[0].flags as unknown[]).push("changed copy");
    expect(probe.entries[0][2]).toEqual([false, null, "", [], 0]);
  });

  it("rejects incorrect integrity and snapshot identities before rendering", () => {
    for (const edit of [
      { byteLength: snapshot.byteLength - 1 }, { sha256: "0".repeat(64) }, { count: snapshot.count + 1 },
      { ids: [...snapshot.ids.slice(1), snapshot.ids[0]] }, { ids: snapshot.ids.map(() => snapshot.ids[0]) },
    ]) expect(() => makeDiscoveryNamedCatalogText({ ...snapshot, ...edit })).toThrow(DiscoveryNamedCatalogError);
    for (const edit of [
      (value: typeof raw) => { value.schemaVersion = "competition-discovery-catalog.v8"; },
      (value: typeof raw) => { value.version = "different"; },
      (value: typeof raw) => { value.entries.pop(); },
      (value: typeof raw) => { value.entries[0][0] = "wrong-owner"; },
      (value: typeof raw) => { value.columns[0] = "otherId"; },
    ]) expect(() => makeDiscoveryNamedCatalogText(changed(edit))).toThrow(DiscoveryNamedCatalogError);
  });

  it("rejects duplicate columns, wrong row width and codec-name collisions without dropping values", () => {
    const malformed = [
      { columns: ["id", "id"], entries: [["one", "two"]] },
      { columns: ["id", "name"], entries: [["one"]] },
      { columns: ["id"], entries: [["one", "extra"]] },
      { columns: ["id"], entries: [{ id: "one" }] },
      { columns: ["id", 1], entries: [["one", "two"]] },
      { columns: ["id", "0"], entries: [["one", "two"]] },
      { columns: ["id"], entries: [["one"]], displayCodec: { retained: "must not overwrite" } },
    ];
    for (const value of malformed) expect(() => encodeDiscoveryNamedCatalogPayload(value)).toThrow(DiscoveryNamedCatalogError);
  });

  it("rejects missing, extra, reordered or changed named fields and codec metadata", () => {
    const value = { columns: ["id", "name"], entries: [["one", "original"]], metadata: { state: "unknown" } };
    const edits = [
      (named: ReturnType<typeof encodeDiscoveryNamedCatalogPayload>) => { delete named.entries[0].name; },
      (named: ReturnType<typeof encodeDiscoveryNamedCatalogPayload>) => { named.entries[0].extra = "must not discard"; },
      (named: ReturnType<typeof encodeDiscoveryNamedCatalogPayload>) => { named.entries[0] = { name: "original", id: "one" }; },
      (named: ReturnType<typeof encodeDiscoveryNamedCatalogPayload>) => { named.displayCodec.entryShape = "changed"; },
      (named: ReturnType<typeof encodeDiscoveryNamedCatalogPayload>) => { (named.displayCodec as Record<string, unknown>).extra = "unknown"; },
    ];
    for (const edit of edits) {
      const named = encodeDiscoveryNamedCatalogPayload(value); edit(named);
      expect(() => decodeDiscoveryNamedCatalogPayload(named)).toThrow(DiscoveryNamedCatalogError);
    }
  });

  it("rejects values JSON serialization would silently omit or coerce", () => {
    for (const value of [undefined, NaN, Infinity, -0, new Date("2026-01-01"), [undefined], Array(1)]) {
      expect(() => encodeDiscoveryNamedCatalogPayload({ columns: ["id"], entries: [[value]] })).toThrow(DiscoveryNamedCatalogError);
    }
    const sensitive = "synthetic-content-that-must-not-enter-errors";
    try { encodeDiscoveryNamedCatalogPayload({ columns: ["id"], entries: [[sensitive, undefined]] }); }
    catch (error) {
      expect(error).toBeInstanceOf(DiscoveryNamedCatalogError);
      expect(String(error)).not.toContain(sensitive);
    }
  });

  it("fails explicitly on invalid JSON or a noncanonical frozen serialization", () => {
    for (const text of ["{bad", JSON.stringify(raw, null, 2)]) {
      const candidate = { ...snapshot, text, byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
      expect(() => makeDiscoveryNamedCatalogText(candidate)).toThrow(DiscoveryNamedCatalogError);
    }
  });
});
