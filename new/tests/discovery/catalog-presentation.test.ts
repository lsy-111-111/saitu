import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeDiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/catalog";
import { createDiscoveryCatalogPresentation, DiscoveryCatalogPresentationError } from "@/lib/competitions/discovery/catalog-presentation";
import type { DiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/transport";

type Material = { entries: unknown[][]; columns: string[]; version: string; schemaVersion: string };
function changed(snapshot: DiscoveryCatalogSnapshot, edit: (material: Material) => void): DiscoveryCatalogSnapshot {
  const material = JSON.parse(snapshot.text) as Material;
  edit(material);
  const text = JSON.stringify(material);
  return { ...snapshot, text, byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}
const snapshot = makeDiscoveryCatalogSnapshot();
const plain = (detail: ReturnType<typeof createDiscoveryCatalogPresentation> extends Map<string, infer V> ? V | undefined : never) => detail?.sections.flatMap(section => section.paragraphs).join("\n") ?? "";

describe("frozen catalog presentation", () => {
  it("decodes every frozen series without importing current contents into the report", () => {
    const details = createDiscoveryCatalogPresentation(snapshot);
    expect([...details.keys()]).toEqual(snapshot.ids);
    for (const [id, detail] of details) {
      expect(detail.id).toBe(id);
      expect(detail.detailPath).toBe(`/competitions/${id}`);
      expect(detail.version).toBe(snapshot.version);
      expect(detail.sha256).toBe(snapshot.sha256);
      expect(detail.sections.length).toBeGreaterThan(2);
      expect(detail.sources.length).toBeGreaterThan(0);
      expect(detail.sources.every(source => /^https?:\/\//u.test(source.url))).toBe(true);
      expect(plain(detail)).not.toMatch(/"(?:requiresFullTime|localSources|pending_review|legacy_import)"\s*:/u);
      expect(plain(detail)).not.toContain("other-or-non-full-time");
      expect(detail.sources.some(source => /报名入口|立即报名/u.test(source.title))).toBe(false);
    }
    const altered = changed(snapshot, material => { material.entries[0][1] = "冻结资料专用名称"; });
    expect(createDiscoveryCatalogPresentation(altered).get(altered.ids[0])?.title).toBe("冻结资料专用名称");
    expect(details.get(snapshot.ids[0])?.title).not.toBe("冻结资料专用名称");
  });

  it("keeps innovation track scope, qualification exceptions and unknown event end separate from historical material", () => {
    const detail = createDiscoveryCatalogPresentation(snapshot).get("china-international-college-innovation")!;
    const currentSections = detail.sections.filter(section => !section.heading.includes("历史归档"));
    const current = currentSections.flatMap(section => section.paragraphs).join("\n");
    expect(current).toContain("高教主赛道不要求参加红旅活动");
    expect(current).toContain("只限制申报负责人");
    expect(current).toContain("当前非全日制在读不能单独排除");
    expect(current).toContain("国内非全日制研究生不能作为该组的符合者");
    expect(current).toContain("比赛结束：未知");
    expect(current).toContain("不能从当前已到11月或报名截止推出总决赛已结束");
    expect(detail.sections.find(section => section.heading.includes("历史归档"))?.paragraphs[0]).toContain("仅历史归档");
    expect(currentSections.find(section => section.heading === "赛道任务：高教主赛道 · 新工科")?.sources?.[0].url).toContain("/2026/10/27/");
  });

  it("retains doctoral and non-full-time exceptions and first-education alternative paths", () => {
    const details = createDiscoveryCatalogPresentation(snapshot);
    const academic = plain(details.get("challenge-cup-academic-science"));
    expect(academic).toContain("普通博士不是本赛道无条件符合者");
    expect(academic).toContain("前两年按硕士");
    const eligibility = [...details.values()].find(detail => plain(detail).includes("首次高等教育年限通道"));
    expect(plain(eligibility)).toContain("2026/27");
    expect(plain(eligibility)).toContain("2022");
    expect(plain(eligibility)).toContain("2003");
    expect(plain(eligibility)).toContain("可申请资格延长：是");
  });

  it("preserves each fee text, scope, payer and historical verification status", () => {
    const details = createDiscoveryCatalogPresentation(snapshot);
    const acca = plain(details.get("acca-job-hunting"));
    expect(acca).toContain("2025指南写明学生可免费报名。新届费用待核实。");
    expect(acca).toContain("2026年高校校选；另有2025年历史指南");
    expect(acca).toContain("历史导入，未重新核验");
    expect(acca).toContain("原复核状态：待复核");
    const ccpc = plain(details.get("ccpc-collegiate"));
    expect(ccpc).toContain("每队1600元，交通食宿另计");
    expect(ccpc).toContain("其他分站和赛季不可套用");
    expect(ccpc).toContain("队伍或学校缴费不等于个人必付");
    const withoutFees = [...details.values()].find(detail => !detail.sections.some(section => section.heading.startsWith("费用资料")));
    expect(plain(withoutFees)).toContain("没有费用条目也不表示免费");
  });

  it("rejects modified hashes, unsupported schema, changed columns and mismatched identities", () => {
    expect(() => createDiscoveryCatalogPresentation({ ...snapshot, sha256: "0".repeat(64) })).toThrow(DiscoveryCatalogPresentationError);
    expect(() => createDiscoveryCatalogPresentation({ ...snapshot, byteLength: snapshot.byteLength - 1 })).toThrow(DiscoveryCatalogPresentationError);
    for (const edit of [
      (material: Material) => { material.schemaVersion = "competition-discovery-catalog.v8"; },
      (material: Material) => { material.version = "different-version"; },
      (material: Material) => { material.columns[0] = "otherId"; },
      (material: Material) => { material.entries[0][0] = "retired-alias"; },
      (material: Material) => { material.entries[0][16] = "/competitions/another-competition"; },
    ]) expect(() => createDiscoveryCatalogPresentation(changed(snapshot, edit))).toThrow(DiscoveryCatalogPresentationError);
    expect(() => createDiscoveryCatalogPresentation({ ...snapshot, ids: [...snapshot.ids.slice(1), snapshot.ids[0]] })).toThrow(DiscoveryCatalogPresentationError);
  });

  it("rejects foreign local references and unsafe source URLs instead of silently omitting facts", () => {
    const badSource = changed(snapshot, material => { (material.entries[0][11] as unknown[])[0] = "javascript:alert(1)"; });
    expect(() => createDiscoveryCatalogPresentation(badSource)).toThrow(DiscoveryCatalogPresentationError);
    const badQualification = changed(snapshot, material => { (material.entries[0][9] as unknown[])[2] = 999_999; });
    expect(() => createDiscoveryCatalogPresentation(badQualification)).toThrow(DiscoveryCatalogPresentationError);
    const badNote = changed(snapshot, material => {
      const scope = material.entries.flatMap(row => row[12] as unknown[][]).find(scope => (scope[5] as unknown[][]).length > 0)!;
      (scope[5] as unknown[][])[0][1] = 999_999;
    });
    expect(() => createDiscoveryCatalogPresentation(badNote)).toThrow(DiscoveryCatalogPresentationError);
  });
});
