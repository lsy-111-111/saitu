import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeDiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/catalog";
import {
  DISCOVERY_CATALOG_ORIENTATION_BOUNDARY, DISCOVERY_CATALOG_ORIENTATION_COLUMNS,
  makeDiscoveryCatalogOrientation, readDiscoveryCatalogOrientation,
} from "@/lib/competitions/discovery/catalog-orientation";
import type { DiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/transport";

const snapshot = makeDiscoveryCatalogSnapshot();
function changed(edit: (payload: { entries: unknown[][]; columns: string[]; version: string; schemaVersion: string }) => void): DiscoveryCatalogSnapshot {
  const payload = JSON.parse(snapshot.text); edit(payload);
  const text = JSON.stringify(payload);
  return { ...snapshot, text, byteLength: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text).digest("hex") };
}

describe("full catalog navigation sidecar", () => {
  it("copies all 135 series in frozen order and leaves every source byte intact", () => {
    const before = JSON.stringify(snapshot), originalText = snapshot.text;
    const sidecar = makeDiscoveryCatalogOrientation(snapshot), decoded = readDiscoveryCatalogOrientation(sidecar.text, snapshot);
    expect(sidecar.count).toBe(135); expect(sidecar.ids).toEqual(snapshot.ids);
    expect(decoded.entries.map(entry => entry[0])).toEqual(snapshot.ids);
    expect(decoded.columns).toEqual(DISCOVERY_CATALOG_ORIENTATION_COLUMNS);
    expect(sidecar.sourceSha256).toBe(snapshot.sha256);
    expect(sidecar.byteLength).toBe(Buffer.byteLength(sidecar.text, "utf8"));
    expect(snapshot.text).toBe(originalText); expect(JSON.stringify(snapshot)).toBe(before);
    expect(createHash("sha256").update(snapshot.text).digest("hex")).toBe(sidecar.sourceSha256);
    const source = JSON.parse(snapshot.text) as { columns: string[]; entries: unknown[][] };
    expect(decoded.entries).toEqual(source.entries.map(entry => DISCOVERY_CATALOG_ORIENTATION_COLUMNS.map(name => entry[source.columns.indexOf(name)])));
  });

  it("retains exact task, track and audience wording instead of inferring eligibility", () => {
    const decoded = readDiscoveryCatalogOrientation(makeDiscoveryCatalogOrientation(snapshot).text, snapshot);
    expect(decoded.boundary).toBe(DISCOVERY_CATALOG_ORIENTATION_BOUNDARY);
    expect(decoded.boundary).toContain("不是候选筛选、资格结论或事实证据");
    expect(decoded.boundary).toContain("完整竞赛条目");
    expect(decoded.entries.every(entry => entry.length === 5)).toBe(true);
    const innovation = decoded.entries.find(entry => entry[0] === "china-international-college-innovation")!;
    expect(innovation[3]).toContain("红旅赛道 · 公益组");
    // The source's broad label is copied, not upgraded to a claim that every
    // listed degree or non-full-time branch qualifies for every track.
    expect(innovation[4]).toContain("other-or-non-full-time");
    expect(decoded.entries.at(-1)?.[0]).toBe(snapshot.ids.at(-1));
  });

  it("roundtrips only the declared projection and rejects changed content or dropped tail rows", () => {
    const sidecar = makeDiscoveryCatalogOrientation(snapshot);
    expect(readDiscoveryCatalogOrientation(JSON.stringify(JSON.parse(sidecar.text), null, 2), snapshot).entries).toHaveLength(snapshot.count);
    for (const edit of [
      (payload: Record<string, unknown>) => { (payload.entries as unknown[][])[0][2] = "invented task"; },
      (payload: Record<string, unknown>) => { (payload.entries as unknown[][]).pop(); },
      (payload: Record<string, unknown>) => { (payload.entries as unknown[][]).reverse(); },
      (payload: Record<string, unknown>) => { payload.sourceSha256 = "0".repeat(64); },
      (payload: Record<string, unknown>) => { payload.boundary = "eligible candidates"; },
      (payload: Record<string, unknown>) => { payload.scores = [1]; },
    ]) {
      const payload = JSON.parse(sidecar.text) as Record<string, unknown>; edit(payload);
      expect(() => readDiscoveryCatalogOrientation(JSON.stringify(payload), snapshot)).toThrow("projection_mismatch");
    }
  });

  it("binds rows to their exact frozen source rather than reading a current catalog", () => {
    const altered = changed(payload => { payload.entries[0][1] = "冻结名称：保留空格 与标点"; payload.entries[0][3] = "task\n逐字保留"; });
    const sidecar = makeDiscoveryCatalogOrientation(altered), decoded = readDiscoveryCatalogOrientation(sidecar.text, altered);
    expect(decoded.entries[0][1]).toBe("冻结名称：保留空格 与标点");
    expect(decoded.entries[0][2]).toBe("task\n逐字保留");
    expect(() => readDiscoveryCatalogOrientation(sidecar.text, snapshot)).toThrow("projection_mismatch");
  });

  it("rejects invalid source integrity, schema, identities and ambiguous fields", () => {
    expect(() => makeDiscoveryCatalogOrientation({ ...snapshot, sha256: "0".repeat(64) })).toThrow("invalid_integrity");
    expect(() => makeDiscoveryCatalogOrientation({ ...snapshot, byteLength: snapshot.byteLength - 1 })).toThrow("invalid_integrity");
    expect(() => makeDiscoveryCatalogOrientation({ ...snapshot, ids: [...snapshot.ids].reverse() })).toThrow("invalid_payload");
    for (const edit of [
      (payload: { schemaVersion: string }) => { payload.schemaVersion = "unknown"; },
      (payload: { version: string }) => { payload.version = "other"; },
      (payload: { columns: string[] }) => { payload.columns[1] = "id"; },
      (payload: { entries: unknown[][] }) => { payload.entries.pop(); },
      (payload: { entries: unknown[][] }) => { payload.entries[0][4] = ["one", 2]; },
    ]) expect(() => makeDiscoveryCatalogOrientation(changed(edit))).toThrow("invalid_payload");
  });
});
