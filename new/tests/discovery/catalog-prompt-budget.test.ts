import { describe, expect, it } from "vitest";
import { getCompetitionCatalog } from "@/lib/competitions/catalog";
import { makeDiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/catalog";
import { countDiscoveryInputTokens } from "@/lib/competitions/discovery/input-budget";
import { DISCOVERY_CLARIFY_PROMPT, DISCOVERY_REPORT_PROMPT } from "@/lib/competitions/discovery/prompts";

describe("discovery catalog material budget", () => {
  it("measures the complete catalog with the bundled provider tokenizer", () => {
    const snapshot = makeDiscoveryCatalogSnapshot();
    const catalogTokens = countDiscoveryInputTokens(snapshot.text, "");
    expect(snapshot.count).toBe(getCompetitionCatalog().length);
    // 2026-11-20 baseline: 135 series, 48,457 catalog tokens, before sourced
    // task descriptions, 2026 rule corrections and explicit detail paths.
    expect(catalogTokens).toBeLessThan(55_000);
    if (process.env.SAITU_CATALOG_METRICS === "1") {
      const material = JSON.parse(snapshot.text) as { columns: string[]; entries: unknown[][] };
      console.info(JSON.stringify({ count: snapshot.count, bytes: snapshot.byteLength, catalogTokens,
        promptTokens: countDiscoveryInputTokens(DISCOVERY_REPORT_PROMPT, ""),
        columns: material.columns.map((name, column) => [name, material.entries.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row[column]) ?? ""), 0)]) }));
    }
  });

  it("keeps the two preferred series conditional and forbids follow-up or invented detail links", () => {
    expect(DISCOVERY_REPORT_PROMPT).toContain("至少2个不同维度的真实回答");
    expect(DISCOVERY_REPORT_PROMPT).toContain("尽量在原6—8项内包含至少1项");
    expect(DISCOVERY_REPORT_PROMPT).toContain("两项均不适合可都不推荐");
    expect(DISCOVERY_REPORT_PROMPT).toContain("不为此新增强制搜索");
    expect(DISCOVERY_REPORT_PROMPT).toContain("文字明确更正选项时以更正事实为准");
    expect(DISCOVERY_REPORT_PROMPT).toContain("无法消解的矛盾保持未知");
    expect(DISCOVERY_REPORT_PROMPT).toContain("全程不追加任何AI问题");
    expect(DISCOVERY_REPORT_PROMPT).toContain("完整路径逐字复制该行detailPath；库外不造站内路径");
    expect(DISCOVERY_CLARIFY_PROMPT).toContain('{"questions":[]}');
  });
});
