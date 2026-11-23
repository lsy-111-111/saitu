import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DiscoveryCatalogSnapshot } from "./transport";

export const DISCOVERY_CATALOG_ORIENTATION_SCHEMA_VERSION = "competition-discovery-orientation.v1" as const;
export const DISCOVERY_CATALOG_ORIENTATION_COLUMNS = ["id", "name", "task", "tracks", "audience"] as const;
export const DISCOVERY_CATALOG_ORIENTATION_BOUNDARY = "仅作完整目录的任务导航，不是候选筛选、资格结论或事实证据。以下每项均逐值复制同一冻结目录，顺序与完整目录相同；未增加或删除任何赛事。不得依据本表认定资格、可报名、费用、全程线上、具体赛道适用范围或来源已核验。判断必须回到随后保留的完整竞赛条目及其来源、届次、资格例外和历史状态；若看似不一致，以完整条目的同范围材料为准。本表不替代完整目录，也不改变任何推荐规则。";

type OrientationRow = [id: string, name: string, task: string, tracks: string[], audience: string];
export type DiscoveryCatalogOrientationPayload = {
  schemaVersion: typeof DISCOVERY_CATALOG_ORIENTATION_SCHEMA_VERSION;
  catalogVersion: string;
  sourceSha256: string;
  count: number;
  boundary: typeof DISCOVERY_CATALOG_ORIENTATION_BOUNDARY;
  columns: typeof DISCOVERY_CATALOG_ORIENTATION_COLUMNS;
  entries: OrientationRow[];
};
export type DiscoveryCatalogOrientation = {
  text: string; byteLength: number; count: number; ids: string[]; sourceSha256: string;
};
export class DiscoveryCatalogOrientationError extends Error {
  constructor(readonly code: "invalid_snapshot" | "invalid_integrity" | "invalid_payload" | "projection_mismatch") {
    super(`discovery_catalog_orientation_${code}`);
    this.name = "DiscoveryCatalogOrientationError";
  }
}
const invalid = (code: DiscoveryCatalogOrientationError["code"]): never => { throw new DiscoveryCatalogOrientationError(code); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : invalid("invalid_payload");

function orientationOf(catalog: DiscoveryCatalogSnapshot): DiscoveryCatalogOrientationPayload {
  if (!catalog || typeof catalog.text !== "string" || typeof catalog.version !== "string" || !catalog.version
    || !Number.isSafeInteger(catalog.count) || catalog.count < 1 || !Array.isArray(catalog.ids) || catalog.ids.length !== catalog.count
    || !catalog.ids.every(id => typeof id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))
    || new Set(catalog.ids).size !== catalog.count) return invalid("invalid_snapshot");
  if (!Number.isSafeInteger(catalog.byteLength) || catalog.byteLength > 6_000_000 || Buffer.byteLength(catalog.text, "utf8") !== catalog.byteLength
    || typeof catalog.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(catalog.sha256)
    || createHash("sha256").update(catalog.text).digest("hex") !== catalog.sha256) return invalid("invalid_integrity");
  let parsed: unknown;
  try { parsed = JSON.parse(catalog.text); } catch { return invalid("invalid_payload"); }
  const source = object(parsed);
  if (source.schemaVersion !== "competition-discovery-catalog.v7" || source.version !== catalog.version
    || !Array.isArray(source.columns) || !source.columns.every(value => typeof value === "string")
    || new Set(source.columns).size !== source.columns.length || !Array.isArray(source.entries) || source.entries.length !== catalog.count) return invalid("invalid_payload");
  const columns = source.columns as string[], indexes = DISCOVERY_CATALOG_ORIENTATION_COLUMNS.map(name => columns.indexOf(name));
  if (indexes.some(index => index < 0)) return invalid("invalid_payload");
  const entries = source.entries.map((value, rowIndex): OrientationRow => {
    if (!Array.isArray(value) || value.length !== columns.length) return invalid("invalid_payload");
    const [id, name, task, tracks, audience] = indexes.map(index => value[index]);
    if (id !== catalog.ids[rowIndex] || typeof name !== "string" || !name.trim() || typeof task !== "string" || typeof audience !== "string"
      || !Array.isArray(tracks) || !tracks.every(track => typeof track === "string")) return invalid("invalid_payload");
    // This copy has no truncation, normalization, ranking or inferred fields.
    return [id, name, task, [...tracks], audience];
  });
  return { schemaVersion: DISCOVERY_CATALOG_ORIENTATION_SCHEMA_VERSION, catalogVersion: catalog.version,
    sourceSha256: catalog.sha256, count: catalog.count, boundary: DISCOVERY_CATALOG_ORIENTATION_BOUNDARY,
    columns: DISCOVERY_CATALOG_ORIENTATION_COLUMNS, entries };
}

/** Optional navigation sidecar only. Callers must retain catalog.text verbatim
 * in the same request; this function never returns a replacement catalog. */
export function makeDiscoveryCatalogOrientation(catalog: DiscoveryCatalogSnapshot): DiscoveryCatalogOrientation {
  const payload = orientationOf(catalog), text = JSON.stringify(payload);
  return { text, byteLength: Buffer.byteLength(text, "utf8"), count: payload.count,
    ids: payload.entries.map(entry => entry[0]), sourceSha256: catalog.sha256 };
}

/** Projection roundtrip proof: every selected value and the entire ID sequence
 * must equal this source. Five fields cannot reconstruct the full catalog. */
export function readDiscoveryCatalogOrientation(text: string, catalog: DiscoveryCatalogSnapshot): DiscoveryCatalogOrientationPayload {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 6_000_000) return invalid("invalid_payload");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid("invalid_payload"); }
  const expected = orientationOf(catalog);
  if (!isDeepStrictEqual(parsed, expected)) return invalid("projection_mismatch");
  return parsed as DiscoveryCatalogOrientationPayload;
}
