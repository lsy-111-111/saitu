import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DISCOVERY_CARDS_REPORT_PROMPT } from "@/lib/competitions/discovery/presentation-prompt";
import {
  buildDiscoveryProtocolConfig, DISCOVERY_PROTOCOL_RULE_PRESERVATION, DISCOVERY_COMPACT_QUALITY_RULES,
  DISCOVERY_MARKDOWN_V16_DELTAS, DISCOVERY_MARKDOWN_RULE_PRESERVATION,
  DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE,
} from "@/lib/competitions/discovery/protocol-prompts";
import { DISCOVERY_REPORT_PROMPT } from "@/lib/competitions/discovery/prompts";
import { decodeDiscoveryNestedCatalogPayload } from "@/lib/competitions/discovery/catalog-nested";
import type { DiscoveryProtocolVersion } from "@/lib/competitions/discovery/protocol-wire";
import type { DiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/transport";
import { makeDiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/catalog";

const catalogText = JSON.stringify({ schemaVersion: "competition-discovery-catalog.v7", version: "frozen", columns: ["id", "name", "localSources"], entries: [["science-one", "完整目录原文", [["https://example.org/rule", "official-competition", "2026-01-01"]]]] });
const catalog: DiscoveryCatalogSnapshot = {
  version: "frozen", text: catalogText, count: 1, ids: ["science-one"], clarifyText: "[]",
  byteLength: Buffer.byteLength(catalogText), sha256: createHash("sha256").update(catalogText).digest("hex"),
};
const review = "来源在sources中填写名称及真实完整URL。严格使用约定的JSON字段；任务与优先建议保留复用前提。结语JSON对象结束后立即结束回答，不另写结束语或新的标记。";
const config = (protocolVersion: DiscoveryProtocolVersion) => buildDiscoveryProtocolConfig({ protocolVersion, v16ReportPrompt: DISCOVERY_CARDS_REPORT_PROMPT, structuredReview: review, catalog });
const wireAt = DISCOVERY_CARDS_REPORT_PROMPT.indexOf("最终回答使用逐行JSON文本");
const originalWire = DISCOVERY_CARDS_REPORT_PROMPT.slice(wireAt);
const originalQuality = DISCOVERY_CARDS_REPORT_PROMPT.slice(0, wireAt);

describe("discovery private prompt experiments", () => {
  it("keeps the frozen v16 control and full catalog bytes unchanged", () => {
    expect(config("v16")).toEqual({ reportPrompt: DISCOVERY_CARDS_REPORT_PROMPT, reviewTail: review });
    for (const arm of ["rules", "blocks", "refs", "json-optimized", "blocks-optimized"] as const) expect(config(arm).catalogText).toBeUndefined();
    expect(catalog.text).toBe(catalogText);
  });

  it("changes only the quality-rule placement for R, retaining the v16 wire suffix verbatim", () => {
    const value = config("rules");
    expect(value.reportPrompt.endsWith(originalWire)).toBe(true);
    expect(value.reviewTail).toBe("");
    expect(value.reportPrompt).not.toContain("连续JSON对象文本");
    expect(value.reportPrompt).not.toContain("sourceRefs");
    expect(value.reportPrompt.match(/groups用于去重的短语标签/gu)).toHaveLength(1);
  });

  it("keeps the original quality and non-reference wire clauses for S", () => {
    const value = config("refs");
    expect(value.reportPrompt.startsWith(originalQuality)).toBe(true);
    expect(value.reportPrompt).toContain('"sourceRefs":[0],"sources":[]');
    expect(value.reportPrompt).not.toContain('"title":"赛事名称",');
    expect(value.reportPrompt).toContain(originalWire.slice(originalWire.indexOf("conclusion结构：")));
    expect(value.reportPrompt).toContain(originalWire.slice(0, originalWire.indexOf("card结构：")));
    expect(value.reportPrompt).toContain('"details":{"tasks":["具体任务"],"reasons":["关联真实回答的理由，保持不同维度2—4条"]');
    expect(value.reviewTail).toBe(review.replace("来源在sources中填写名称及真实完整URL", "来源使用本赛事sourceRefs或sources中的名称及真实完整URL"));
  });

  it("uses full-field text blocks for P without static-reference savings or rule removal", () => {
    const value = config("blocks");
    expect(value.reportPrompt.startsWith(originalQuality)).toBe(true);
    expect(value.reportPrompt).toContain("<PROFILE>");
    expect(value.reportPrompt).toContain("[tasks]、[reasons]、[value]、[conditions]");
    expect(value.reportPrompt).toContain("[title]（完整赛事名）");
    expect(value.reportPrompt).not.toContain("sourceRefs");
    expect(value.reviewTail).toContain("任务与优先建议保留复用前提");
    expect(value.reviewTail).not.toContain("JSON对象结束");
    expect(value.reportPrompt).toContain("有CARD时priorities只保留1—2项");
  });

  it.each(["json-optimized", "blocks-optimized"] as const)("combines only the declared R/P/S changes for %s", arm => {
    const value = config(arm);
    expect(value.reviewTail).toBe("");
    expect(value.reportPrompt).toContain("sourceRefs");
    expect(value.reportPrompt).toContain("只接受本地线下不等于可国内异地");
    expect(value.reportPrompt).toContain("先核来源与禁项");
    expect(value.reportPrompt).toContain("不能靠conditions后置补救");
    expect(value.reportPrompt).toContain("pending_review、imported_unrechecked、legacy_import");
    expect(value.reportPrompt).toContain("库外正式推荐和优先建议");
    expect(value.reportPrompt).toContain("个人全程总预算");
  });

  it("keeps an auditable rule map covering the original decision and v16 failure boundaries", () => {
    const ids = DISCOVERY_PROTOCOL_RULE_PRESERVATION.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["questionnaire_fidelity", "qualification_exceptions", "real_hard_conflicts", "complete_participation", "cost_scope", "historical_fact_status", "reuse_at_action", "whole_report_fidelity", "search_bounds", "source_identity", "featured_candidates", "unknown_only"]));
    expect(DISCOVERY_PROTOCOL_RULE_PRESERVATION.every(item => item.from && item.rule)).toBe(true);
  });

  it.each(["blocks-flow", "json-flat", "blocks-flow-named"] as const)("preserves full v16 factual safeguards and soft authored length for %s", arm => {
    const value = config(arm);
    expect(value.reportPrompt.startsWith(originalQuality)).toBe(true);
    expect(value.reviewTail).toContain("任务与优先建议保留复用前提");
    expect(value.reviewTail).toContain("本赛事sourceRefs");
    expect(value.reportPrompt).toContain("1500—2500中文字");
    expect(value.reportPrompt).toContain("不是硬性长度上限");
    expect(value.reportPrompt).toContain("关键条件、例外、证据范围及就地行动前提始终优先");
    expect(value.reportPrompt).toContain("必要的全目录比较与核查");
    expect(value.reportPrompt).toContain("sourceRefs");
    expect(value.reportPrompt).toContain("1—2项");
    expect(value.reportPrompt).toContain("groups用于去重的短语标签");
  });

  it("describes sibling delimiters and a mandatory total end only in the flow arms", () => {
    for (const arm of ["blocks-flow", "blocks-flow-named"] as const) {
      const value = config(arm);
      expect(value.reportPrompt).toContain("下一个<CARD>或<CONCLUSION>");
      expect(value.reportPrompt).toContain("前块所有必需字段齐全且内容完整");
      expect(value.reportPrompt).toContain("总结束标记必须保留");
    }
    expect(config("blocks").reportPrompt).not.toContain("下一个<CARD>或<CONCLUSION>");
  });

  it("generates flat named arrays without a nested details object", () => {
    const value = config("json-flat");
    const example = /card=(\{.+\})。key/u.exec(value.reportPrompt)?.[1];
    expect(example).toBeDefined();
    const card = JSON.parse(example!);
    expect(card).not.toHaveProperty("details");
    expect(card).toMatchObject({ tasks: expect.any(Array), reasons: expect.any(Array), value: expect.any(Array), conditions: expect.any(Array), sourceRefs: [0] });
    expect(value.reportPrompt).toContain("不要输出details");
    expect(value.reviewTail).toContain("约定的JSON字段");
  });

  it("changes only model-readable catalog text for the named arm, retaining every raw value", () => {
    const plain = config("blocks-flow"), named = config("blocks-flow-named");
    expect(named.reportPrompt).toBe(plain.reportPrompt);
    expect(named.reviewTail).toBe(plain.reviewTail);
    expect(plain.catalogText).toBeUndefined();
    expect(JSON.parse(named.catalogText!).entries).toEqual([{ id: "science-one", name: "完整目录原文", localSources: [["https://example.org/rule", "official-competition", "2026-01-01"]] }]);
    expect(catalog.text).toBe(catalogText);
    expect(catalog.sha256).toBe(createHash("sha256").update(catalogText).digest("hex"));
  });

  it.each(["narrative", "narrative-rules"] as const)("authors each personalized part once with deterministic display reuse for %s", arm => {
    const value = config(arm);
    expect(value.reportPrompt).toContain("CARD必需字段为[competitionId]");
    expect(value.reportPrompt).toContain("[tasks]、[reasons]、[value]、[conditions]、[sourceRefs]");
    expect(value.reportPrompt).toContain("reasons合计关联2—4个不同维度");
    expect(value.reportPrompt).toContain("平台原样复用第一条reasons及conditions");
    expect(value.reportPrompt).toContain("不要在CARD输出key、summary或timing");
    expect(value.reportPrompt).toContain("库内title取冻结目录name");
    expect(value.reportPrompt).toContain("库外必须另写[title]");
    expect(value.reportPrompt).toContain("1—2项");
    expect(value.reportPrompt).toContain("1500—2500中文字");
    expect(value.reportPrompt).toContain("不是硬性长度上限");
    expect(value.reportPrompt).toContain("无需反复枚举全部候选");
    expect(value.reportPrompt).toContain("未知按规则标待核");
    expect(value.reportPrompt).toContain("目录已有URL一律用sourceRefs");
    expect(value.reportPrompt).toContain("只有本次工具新取得且支持本项的准确URL");
    expect(value.reportPrompt).toContain("至少一个空格/Tab");
    expect(value.reportPrompt).toContain("无可靠推荐不输出CARD");
    expect(value.catalogText).toBeUndefined();
  });

  it("retains v16 quality and rewrites the narrative review to the fields actually authored", () => {
    const value = buildDiscoveryProtocolConfig({ protocolVersion: "narrative", v16ReportPrompt: DISCOVERY_CARDS_REPORT_PROMPT, catalog,
      structuredReview: `${review}\nsummary只描述已知事实；以上前提同时约束摘要、任务、时机、价值与结语，关键条件不能删除。` });
    expect(value.reportPrompt.startsWith(originalQuality)).toBe(true);
    expect(value.reviewTail).toContain("reasons第一条只描述已知事实");
    expect(value.reviewTail).toContain("匹配理由、任务、条件、价值与结语");
    expect(value.reviewTail).toContain("关键条件不能删除");
    expect(value.reviewTail).toContain("sources只填本次工具新取得的准确URL");
    expect(value.reviewTail).not.toMatch(/\b(?:summary|timing|key|JSON)\b/u);
  });

  it("uses the existing complete 21-rule copy once with no separate review for narrative-rules", () => {
    const value = config("narrative-rules");
    expect(value.reportPrompt.startsWith(`${DISCOVERY_COMPACT_QUALITY_RULES}\n`)).toBe(true);
    expect(value.reviewTail).toBe("");
    for (const { rule } of DISCOVERY_PROTOCOL_RULE_PRESERVATION) expect(value.reportPrompt.split(rule)).toHaveLength(2);
  });

  it("keeps the exact v13 quality prefix and explicitly retains all audited leaf guards in markdown-single", () => {
    const value = config("markdown-single"), base = DISCOVERY_REPORT_PROMPT.slice(0, DISCOVERY_REPORT_PROMPT.indexOf("目标6—8个不同赛事"));
    expect(value.reportPrompt.startsWith(base)).toBe(true);
    expect(value.reviewTail).toBe("");
    expect(value.catalogText).toBeUndefined();
    for (const delta of DISCOVERY_MARKDOWN_V16_DELTAS) expect(value.reportPrompt.split(delta.text)).toHaveLength(2);
    const ids = DISCOVERY_MARKDOWN_RULE_PRESERVATION.map(leaf => leaf.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(75);
    expect(new Set(DISCOVERY_MARKDOWN_RULE_PRESERVATION.map(leaf => leaf.family))).toEqual(new Set(DISCOVERY_PROTOCOL_RULE_PRESERVATION.map(rule => rule.id)));
    for (const leaf of DISCOVERY_MARKDOWN_RULE_PRESERVATION) expect(value.reportPrompt, leaf.id).toContain(leaf.quote);
    expect(value.reportPrompt).toContain("正文不用字段名、结构化状态等实现术语");
    expect(value.reportPrompt).toContain("不输出占位示例");
    expect(value.reportPrompt).toContain("站内详情也不冒充官方来源");
  });

  it("preserves v16 quality with Chinese terms and the complete review in markdown-v16", () => {
    const value = buildDiscoveryProtocolConfig({ protocolVersion: "markdown-v16", v16ReportPrompt: DISCOVERY_CARDS_REPORT_PROMPT, catalog,
      structuredReview: `${review}\nsummary只描述已知事实；tasks与优先建议保留就地前提，不能靠conditions后置待核补救。原届次、博士例外和个人预算未知不删除。` });
    const base = DISCOVERY_REPORT_PROMPT.slice(0, DISCOVERY_REPORT_PROMPT.indexOf("目标6—8个不同赛事"));
    expect(value.reportPrompt.startsWith(base)).toBe(true);
    expect(value.reportPrompt).toContain("画像、首条推荐理由、首条条件、推荐理由、收获和优先建议");
    expect(value.reportPrompt).toContain("即使原文含“已核”“已确认”");
    expect(value.reportPrompt).toContain("已有作品、原型和队伍只是准备起点");
    expect(value.reviewTail).toContain("首条推荐理由只描述已知事实");
    expect(value.reviewTail).toContain("任务与优先建议保留就地前提，不能靠后置条件待核补救");
    expect(value.reviewTail).toContain("原届次、博士例外和个人预算未知不删除");
    expect(value.reviewTail).not.toMatch(/\b(?:summary|timing|key|sourceRefs|sources|tasks|conditions|JSON)\b/u);
  });

  it.each(["markdown-v16", "markdown-single"] as const)("uses the same six-field Chinese producer and optional genuinely new sources for %s", protocol => {
    const value = config(protocol);
    for (const heading of ["## 用户画像", "## 赛事：目录id", "### 任务", "### 推荐理由", "### 收获", "### 条件", "## 优先建议"]) expect(value.reportPrompt).toContain(heading);
    expect(value.reportPrompt).toContain("不要生成目录来源索引、目录URL或站内路径");
    expect(value.reportPrompt).toContain("仅有本次工具返回且支持本项的准确新增URL");
    expect(value.reportPrompt).toContain("平台附带静态来源不证明任何新增断言");
    expect(value.reportPrompt).toContain("30—60字");
    expect(value.reportPrompt).toContain("必要限定始终优先，可以更长，不硬截断");
    expect(value.reportPrompt).toContain("原样复用完整首条理由/条件");
    expect(value.reportPrompt).toContain("1500—2500中文字");
    expect(value.reportPrompt).toContain("不是硬性长度上限");
    expect(value.reportPrompt).not.toContain("sourceRefs");
    expect(value.reportPrompt).not.toContain("<CARD>");
  });

  it("changes only catalog representation in markdown-nested, with exact raw payload restoration", () => {
    const frozen = makeDiscoveryCatalogSnapshot(), ordinary = buildDiscoveryProtocolConfig({ protocolVersion: "markdown-v16", v16ReportPrompt: DISCOVERY_CARDS_REPORT_PROMPT, structuredReview: review, catalog: frozen });
    const nested = buildDiscoveryProtocolConfig({ protocolVersion: "markdown-nested", v16ReportPrompt: DISCOVERY_CARDS_REPORT_PROMPT, structuredReview: review, catalog: frozen });
    expect(nested.reportPrompt).toBe(ordinary.reportPrompt);
    expect(nested.reviewTail).toBe(ordinary.reviewTail);
    expect(ordinary.catalogText).toBeUndefined();
    expect(JSON.stringify(decodeDiscoveryNestedCatalogPayload(JSON.parse(nested.catalogText!)))).toBe(frozen.text);
    expect(frozen.count).toBe(135);
  });

  it("moves the complete identical single-copy instruction block for markdown-late", () => {
    const ordinary = config("markdown-single"), late = config("markdown-late");
    expect(late.reportPrompt).toBe("");
    expect(late.postCatalogPrompt).toBe(ordinary.reportPrompt);
    expect(late.reviewTail).toBe(ordinary.reviewTail);
    expect(late.catalogText).toBeUndefined();
    expect(ordinary.postCatalogPrompt).toBeUndefined();
  });

  it("adds only the approved static/person-specific division paragraph before the unchanged v16 wire", () => {
    const base = config("markdown-v16"), scoped = config("markdown-grounded-scope");
    expect(scoped.reportPrompt.split(DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE)).toHaveLength(2);
    expect(scoped.reportPrompt.replace(`${DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE}\n`, "")).toBe(base.reportPrompt);
    expect(scoped.reviewTail).toBe(base.reviewTail);
    expect(scoped.catalogText).toBeUndefined();
    expect(scoped.postCatalogPrompt).toBeUndefined();
    expect(scoped.reportPrompt.indexOf(DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE)).toBeGreaterThan(scoped.reportPrompt.indexOf("不把查清所有未知作为成稿前提"));
    expect(scoped.reportPrompt.indexOf(DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE)).toBeLessThan(scoped.reportPrompt.indexOf("只输出一份中文Markdown"));
    expect(DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE).toContain("原届次、赛道、组别和参赛角色");
    expect(DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE).toContain("不能用‘资格/费用/方式均待核’代替逐项个人判断");
    expect(DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE).toContain("若所用范围或关键限制无法在已附资料中明确定位，就在本卡写齐该限制，不得省略");
    expect(DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE).toContain("附带资料本身不证明本人符合或预算内");
    expect(DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE.startsWith("库内卡片详情会原样附上")).toBe(true);
    expect(DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE).toContain("库外没有这份附带原文，仍须完整写明本次一手依据及适用条件");
    expect(DISCOVERY_MARKDOWN_GROUNDED_SCOPE_GUIDANCE.endsWith("数字若被用于本人资格、费用、当前可报的正向或排除结论，仍须就地准确写明。")).toBe(true);
  });

  it.each(["markdown-v16", "markdown-single", "markdown-nested", "markdown-late"] as const)("keeps START mandatory but allows a normally completed final conclusion without END in %s", protocolVersion => {
    const value = buildDiscoveryProtocolConfig({ protocolVersion, v16ReportPrompt: DISCOVERY_CARDS_REPORT_PROMPT, structuredReview: review, catalog: makeDiscoveryCatalogSnapshot() });
    const instructions = value.postCatalogPrompt ?? value.reportPrompt;
    expect(instructions).toContain("首行<SAITU_REPORT_V1>");
    expect(instructions).toContain("正常完成时也可直接结束");
    expect(instructions).toContain("正常结束只作为完整结语的边界，缺必需内容不得填补");
    expect(instructions).not.toContain("总结束标记必须保留");
    expect(value.reviewTail).not.toContain("总结束标记后立即结束回答");
    expect(config("blocks-flow").reportPrompt).toContain("总结束标记必须保留");
  });

  it("adds navigation for every entry while retaining the byte-identical full catalog and narrative rules", () => {
    const frozen = makeDiscoveryCatalogSnapshot();
    const base = { v16ReportPrompt: DISCOVERY_CARDS_REPORT_PROMPT, structuredReview: review, catalog: frozen };
    const plain = buildDiscoveryProtocolConfig({ ...base, protocolVersion: "narrative" });
    const indexed = buildDiscoveryProtocolConfig({ ...base, protocolVersion: "narrative-index" });
    expect(indexed.reportPrompt).toBe(plain.reportPrompt);
    expect(indexed.reviewTail).toBe(plain.reviewTail);
    expect(indexed.catalogText).toContain(`<原始完整目录>\n${frozen.text}\n</原始完整目录>`);
    const orientation = JSON.parse(indexed.catalogText!.split("<全量任务导航>\n")[1].split("\n</全量任务导航>")[0]);
    expect(orientation.entries.map((row: unknown[]) => row[0])).toEqual(frozen.ids);
    expect(orientation.count).toBe(frozen.count);
    expect(orientation.sourceSha256).toBe(frozen.sha256);
    expect(frozen.sha256).toBe(createHash("sha256").update(frozen.text).digest("hex"));
  });
});
