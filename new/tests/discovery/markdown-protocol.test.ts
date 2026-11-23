import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDiscoveryProtocolParser, DISCOVERY_PROTOCOL_FEATURES, type DiscoveryProtocolVersion } from "@/lib/competitions/discovery/protocol-wire";
import { PresentationError, REPORT_START_MARKER, REPORT_END_MARKER, type DiscoveryModelPresentationRecord } from "@/lib/competitions/discovery/presentation";
import type { DiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/transport";

const protocols = ["markdown-v16", "markdown-single", "markdown-nested", "markdown-late"] as const;
const raw = JSON.stringify({ schemaVersion: "competition-discovery-catalog.v7", version: "frozen.v1", columns: ["id", "name", "localSources"], entries: [
  ["science-one", "科学竞赛甲", [["https://example.org/archive", "official-competition", "2025-01-01"]]],
  ["science-two", "科学竞赛乙", [["https://example.org/two", "organizer", "2026-01-01"]]],
] });
const catalog: DiscoveryCatalogSnapshot = { text: raw, version: "frozen.v1", ids: ["science-one", "science-two"], count: 2,
  byteLength: Buffer.byteLength(raw), sha256: createHash("sha256").update(raw).digest("hex"), clarifyText: "[]" };
const profile = {
  summary: "全日制博士，希望积累研究记录；已有原型仅是准备起点，复用与队伍构成未确认。",
  groups: { background: ["全日制博士"], goals: ["首选研究记录"], experience: ["未发表原型与阶段数据"], constraints: ["个人全程预算501—1500元", "只接受全程线上"] },
};
const details = {
  tasks: ["先核课程成果来源、权属和禁项，不能排除时另做符合章程的独立原创项目。", "说明方法、证据与个人贡献。"],
  reasons: ["做过资料整理，愿继续研究；原型与阶段数据复用待核，不据此认定已可申报。", "首要目标是研究记录，不等于已经掌握全部方法。"],
  value: ["形成方法与过程记录，不承诺发表、升学或获奖。"],
  conditions: ["原资料为2025—2026届，未来届通知本次未查到；资格及个人全程费用待核。", "出生日期应为1991年3月1日及以后，不能改成此日后；本人年龄未确认。", "集体作品条件不扩大到个人作品；非全日制但全脱产不等于非全脱产。"],
};
const list = (values: readonly string[]) => values.map(value => `- ${value}`).join("\n");
function profileText(): string {
  return `## 用户画像\n${profile.summary}\n### 背景\n${list(profile.groups.background)}\n### 目标\n${list(profile.groups.goals)}\n### 已有经历\n${list(profile.groups.experience)}\n### 现实条件\n${list(profile.groups.constraints)}\n`;
}
function cardText(id = "science-one", custom = details): string {
  return `## 赛事：${id}\n赛道：研究类\n### 任务\n${list(custom.tasks)}\n### 推荐理由\n${list(custom.reasons)}\n### 收获\n${list(custom.value)}\n### 条件\n${list(custom.conditions)}\n`;
}
function conclusionText(zero = false): string {
  return `## 优先建议\n${zero ? "" : "- r1 | 科学竞赛甲关联研究目标，先核作品来源与资格后准备。"}\n### 整体说明\n${zero ? "没有可靠推荐，因为未知和泛探索不足以支撑个性化；未知不等于没有经历或能力。" : "本次仅保留有依据的准备方向。"}\n### 冲突例外\n`;
}
const report = () => `${REPORT_START_MARKER}\n${profileText()}${cardText()}${conclusionText()}${REPORT_END_MARKER}`;
function create(protocolVersion: DiscoveryProtocolVersion = "markdown-v16", onRecord?: (value: DiscoveryModelPresentationRecord) => Promise<void>) {
  const records: DiscoveryModelPresentationRecord[] = [];
  return { records, parser: createDiscoveryProtocolParser({ protocolVersion, catalog, onRecord: async value => { await onRecord?.(value); records.push(value); } }) };
}
function chunks(value: string, size: string): string[] {
  if (size === "whole") return [value];
  if (size === "code-unit") return value.split("");
  const bytes = Buffer.from(value), decoder = new TextDecoder(), result: string[] = [];
  for (let at = 0; at < bytes.length; at += Number(size)) result.push(decoder.decode(bytes.subarray(at, at + Number(size)), { stream: true }));
  return [...result, decoder.decode()];
}

describe.each(protocols)("strict Chinese Markdown %s", protocol => {
  it.each(["whole", "code-unit", "1", "7", "257"])("preserves full personalized arrays, qualifiers and exact derived fields under %s chunks", async chunking => {
    const { parser, records } = create(protocol);
    for (const chunk of chunks(`检索时的正常序言。\n${report().replaceAll("\n", "\r\n")}`, chunking)) await parser.push(chunk);
    const state = await parser.finish();
    expect(records.map(value => value.type)).toEqual(["profile", "card", "conclusion"]);
    expect(state.profile).toEqual({ type: "profile", ...profile });
    expect(state.cards[0]).toEqual({ type: "card", key: "r1", competitionId: "science-one", title: "科学竞赛甲", track: "研究类",
      summary: details.reasons[0], timing: details.conditions[0], details, sources: [] });
  });

  it("uses server evidence instead of generating references and leaves URL authentication enabled", () => {
    expect(DISCOVERY_PROTOCOL_FEATURES[protocol]).toMatchObject({ refs: true, markdown: true, hostedOnlySources: true });
  });

  it("publishes only a complete first card and awaits delivery before the next sibling", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }), seen: string[] = [];
    const { parser, records } = create(protocol, async value => { seen.push(value.type); if (value.type === "card") await wait; });
    await parser.push(`${REPORT_START_MARKER}\n${profileText()}${cardText()}`);
    expect(records.map(value => value.type)).toEqual(["profile"]);
    const pending = parser.push(conclusionText());
    await Promise.resolve();
    expect(seen).toEqual(["profile", "card"]);
    expect(records.map(value => value.type)).toEqual(["profile"]);
    release(); await pending;
    expect(records.map(value => value.type)).toEqual(["profile", "card"]);
    await parser.push(REPORT_END_MARKER);
    expect((await parser.finish()).conclusion?.priorities[0].cardKey).toBe("r1");
  });

  it("keeps a valid earlier card even when a later card is invalid in the same input chunk", async () => {
    const { parser, records } = create(protocol), bad = cardText("science-two").replace("### 条件", "### 省略条件");
    await expect(parser.push(`${REPORT_START_MARKER}\n${profileText()}${cardText()}${bad}${conclusionText()}`)).rejects.toBeInstanceOf(PresentationError);
    expect(records.map(value => value.type)).toEqual(["profile", "card"]);
  });

  it("keeps the complete first reason and condition without sentence extraction or truncation", async () => {
    const longReason = `${details.reasons[0]}\n原始换行、引号“待核”、数学记号 a < 10 与 emoji 🧪 均保留。`.repeat(4);
    const longCondition = `${details.conditions[0]}\n另有“及以上”“及以后”和≤35等包含边界，仍按原文。`.repeat(3);
    const custom = { ...details, reasons: [longReason, ...details.reasons], conditions: [longCondition, ...details.conditions] }, { parser } = create(protocol);
    await parser.push(`${REPORT_START_MARKER}\n${profileText()}${cardText("science-one", custom)}${conclusionText()}${REPORT_END_MARKER}`);
    const value = (await parser.finish()).cards[0];
    expect(value.summary).toBe(longReason);
    expect(value.timing).toBe(longCondition);
    expect(value.details).toEqual(custom);
  });

  it("accepts explained zero recommendations with all profile and conclusion fields", async () => {
    const { parser, records } = create(protocol);
    await parser.push(`${REPORT_START_MARKER}\n${profileText()}${conclusionText(true)}${REPORT_END_MARKER}\n`);
    expect((await parser.finish()).cards).toEqual([]);
    expect(records.map(value => value.type)).toEqual(["profile", "conclusion"]);
  });

  it("requires a normal complete end and does not turn an incomplete final card into a recommendation", async () => {
    const noEnd = create(protocol);
    await noEnd.parser.push(report().replace(REPORT_END_MARKER, ""));
    await expect(noEnd.parser.finish()).rejects.toMatchObject({ code: "incomplete_report" });
    expect(noEnd.records.map(value => value.type)).toEqual(["profile", "card"]);
    const truncated = create(protocol);
    await truncated.parser.push(`${REPORT_START_MARKER}\n${profileText()}${cardText().split("### 条件")[0]}`);
    await expect(truncated.parser.finish()).rejects.toMatchObject({ code: "incomplete_report" });
    expect(truncated.records).toEqual([{ type: "profile", ...profile }]);
  });

  it.each(["whole", "code-unit", "1", "7", "257"])("accepts only a trusted normal upstream boundary for a complete conclusion under %s chunks", async chunking => {
    const { parser, records } = create(protocol), wire = report().replace(REPORT_END_MARKER, "").trimEnd();
    for (const chunk of chunks(wire, chunking)) await parser.push(chunk);
    expect(records.map(record => record.type)).toEqual(["profile", "card"]);
    const value = await parser.finish({ upstreamEndedNormally: true });
    expect(records.map(record => record.type)).toEqual(["profile", "card", "conclusion"]);
    expect(value.cards[0].details).toEqual(details);
    expect(value.conclusion?.priorities).toHaveLength(1);
    await expect(parser.finish({ upstreamEndedNormally: true })).rejects.toMatchObject({ code: "invalid_sequence" });
  });

  it("accepts a trusted complete zero-card conclusion but never synthesizes missing headings or a missing conclusion", async () => {
    const zero = create(protocol);
    await zero.parser.push(`${REPORT_START_MARKER}\n${profileText()}${conclusionText(true)}`);
    expect((await zero.parser.finish({ upstreamEndedNormally: true })).cards).toEqual([]);
    for (const incomplete of [
      `${REPORT_START_MARKER}\n${profileText()}`,
      `${REPORT_START_MARKER}\n${profileText()}${cardText()}`,
      `${REPORT_START_MARKER}\n${profileText()}${cardText()}${conclusionText().replace("### 冲突例外\n", "")}`,
      `${REPORT_START_MARKER}\n${profileText()}${cardText()}${conclusionText().replace(`### 整体说明\n本次仅保留有依据的准备方向。\n`, "")}`,
    ]) {
      const { parser, records } = create(protocol);
      await parser.push(incomplete);
      await expect(parser.finish({ upstreamEndedNormally: true })).rejects.toBeInstanceOf(PresentationError);
      expect(records.some(record => record.type === "conclusion")).toBe(false);
    }
  });

  it("does not let a normal terminal bypass conclusion schema, source callbacks or a false/default trust flag", async () => {
    for (const invalid of [
      report().replace(REPORT_END_MARKER, "").replace("- r1 |", "- r2 |"),
      report().replace(REPORT_END_MARKER, "").replace("### 整体说明", "- r1 | 重复优先项\n### 整体说明"),
    ]) {
      const { parser, records } = create(protocol);
      await parser.push(invalid);
      await expect(parser.finish({ upstreamEndedNormally: true })).rejects.toBeInstanceOf(PresentationError);
      expect(records.some(record => record.type === "conclusion")).toBe(false);
    }
    const explicitFalse = create(protocol);
    await explicitFalse.parser.push(report().replace(REPORT_END_MARKER, ""));
    await expect(explicitFalse.parser.finish({ upstreamEndedNormally: false })).rejects.toMatchObject({ code: "incomplete_report" });
    const failedDelivery = create(protocol, async record => { if (record.type === "conclusion") throw new Error("Synthetic delivery rejection"); });
    await failedDelivery.parser.push(report().replace(REPORT_END_MARKER, ""));
    await expect(failedDelivery.parser.finish({ upstreamEndedNormally: true })).rejects.toThrow("Synthetic delivery rejection");
    expect(failedDelivery.records.some(record => record.type === "conclusion")).toBe(false);
  });

  it("rejects explicit partial report markers even when upstream normally stopped", async () => {
    for (const marker of ["</SAITU_", "</SAITU_REPORT_V1", "<SAITU_REPORT", "</SAITU_REPORT_V2>"]) {
      const { parser } = create(protocol);
      await parser.push(report().replace(REPORT_END_MARKER, marker));
      await expect(parser.finish({ upstreamEndedNormally: true })).rejects.toBeInstanceOf(PresentationError);
    }
    const missing = create(protocol);
    await missing.parser.push("正常终止不能替代起始标记");
    await expect(missing.parser.finish({ upstreamEndedNormally: true })).rejects.toMatchObject({ code: "missing_marker" });
  });

  it("rejects missing, duplicate, unknown or empty required card sections", async () => {
    for (const bad of [
      cardText().replace("赛道：研究类\n", ""), cardText().replace("### 收获", "### 未知"),
      cardText().replace("### 条件", "### 任务\n重复\n### 条件"),
      cardText().replace(`### 推荐理由\n${list(details.reasons)}\n`, "### 推荐理由\n"),
      cardText().replace(`### 条件\n${list(details.conditions)}\n`, "### 条件\n"),
    ]) {
      const { parser, records } = create(protocol);
      await expect(parser.push(`${REPORT_START_MARKER}\n${profileText()}${bad}${conclusionText()}`)).rejects.toBeInstanceOf(PresentationError);
      expect(records).toEqual([{ type: "profile", ...profile }]);
    }
  });

  it("rejects authored source indexes, derived fields, duplicate IDs and invalid priority references", async () => {
    for (const field of ["key", "summary", "timing", "sourceRefs"]) {
      const bad = cardText().replace("### 任务", `[${field}] 0\n### 任务`);
      await expect(create(protocol).parser.push(`${REPORT_START_MARKER}\n${profileText()}${bad}${conclusionText()}`)).rejects.toMatchObject({ code: "invalid_record" });
      await expect(create(protocol).parser.push(`${REPORT_START_MARKER}\n${profileText()}${cardText()}[${field}]0\n${conclusionText()}`)).rejects.toMatchObject({ code: "invalid_record" });
    }
    await expect(create(protocol).parser.push(`${REPORT_START_MARKER}\n${profileText()}${cardText()}${cardText()}${conclusionText()}`)).rejects.toMatchObject({ code: "duplicate_card" });
    const invalid = create(protocol);
    await invalid.parser.push(report().replace("- r1 |", "- r2 |"));
    await expect(invalid.parser.finish()).rejects.toMatchObject({ code: "invalid_conclusion" });
  });

  it("requires library names to come from the frozen ID and external names plus explicit new sources", async () => {
    const url = "https://example.org/current_(rule)", external = cardText("库外").replace("赛道：研究类", "名称：开放研究挑战\n赛道：研究类")
      + `### 新增依据\n- [本次工具取得的一手任务与资格](<${url}>)\n`;
    const { parser } = create(protocol);
    await parser.push(`${REPORT_START_MARKER}\n${profileText()}${external}${conclusionText()}${REPORT_END_MARKER}`);
    expect((await parser.finish()).cards[0]).toMatchObject({ competitionId: null, title: "开放研究挑战", sources: [{ title: "本次工具取得的一手任务与资格", url }] });
    for (const bad of [
      cardText().replace("赛道：研究类", "名称：科学竞赛甲\n赛道：研究类"),
      external.replace("名称：开放研究挑战\n", ""),
      cardText("库外").replace("赛道：研究类", "名称：开放研究挑战\n赛道：研究类"),
    ]) await expect(create(protocol).parser.push(`${REPORT_START_MARKER}\n${profileText()}${bad}${conclusionText()}`)).rejects.toMatchObject({ code: "invalid_record" });
  });
});

describe("bounded Markdown control syntax", () => {
  it("keeps grounded-scope parsing, deterministic records and source guards identical to markdown-v16", async () => {
    const base = create("markdown-v16"), scoped = create("markdown-grounded-scope");
    const input = report().replace(REPORT_END_MARKER, "");
    await base.parser.push(input); await scoped.parser.push(input);
    expect(await scoped.parser.finish({ upstreamEndedNormally: true })).toEqual(await base.parser.finish({ upstreamEndedNormally: true }));
    expect(scoped.records).toEqual(base.records);
    const { groundedScope, ...sameFeatures } = DISCOVERY_PROTOCOL_FEATURES["markdown-grounded-scope"];
    expect(groundedScope).toBe(true);
    expect(sameFeatures).toEqual(DISCOVERY_PROTOCOL_FEATURES["markdown-v16"]);
  });

  it("accepts bold known labels and inline known section values without removing ordinary body text", async () => {
    const { parser } = create();
    const body = report().replace("## 用户画像", "## **用户画像**").replace("### 背景", "### **背景**")
      .replace("## 赛事：", "## **赛事**：").replace("赛道：研究类", "**赛道**：研究类")
      .replace(`### 推荐理由\n- ${details.reasons[0]}`, `### **推荐理由**：- ${details.reasons[0]}`);
    await parser.push(body);
    expect((await parser.finish()).cards[0].details).toEqual(details);
  });

  it.each(["- [规则](https://example.org/current) 仅适用于本校", "- [规则](https://example.org/current)仅适用于本校)", "来源：[规则](https://example.org/current)", "- [规则](javascript:alert(1))"])("rejects malformed or qualified source-only line %s without discarding any wording", async line => {
    const { parser } = create();
    await expect(parser.push(`${REPORT_START_MARKER}\n${profileText()}${cardText()}### 新增依据\n${line}\n${conclusionText()}`)).rejects.toBeInstanceOf(PresentationError);
  });

  it("keeps a source title equal to an old field name as an ordinary complete Markdown link", async () => {
    const { parser } = create();
    await parser.push(`${REPORT_START_MARKER}\n${profileText()}${cardText()}### 新增依据\n[summary](https://example.org/current)\n${conclusionText()}${REPORT_END_MARKER}`);
    expect((await parser.finish()).cards[0].sources).toEqual([{ title: "summary", url: "https://example.org/current" }]);
  });

  it("rejects missing markers, early or duplicate end, unknown headings and trailing text", async () => {
    const missing = create(); await missing.parser.push("无正式标记");
    await expect(missing.parser.finish()).rejects.toMatchObject({ code: "missing_marker" });
    for (const bad of [
      `${REPORT_START_MARKER}\n${profileText()}${REPORT_END_MARKER}\n`, `${report()}\n${REPORT_END_MARKER}\n`,
      `${report()}\n额外正文\n`, `${REPORT_START_MARKER}\n## 画像\n`,
      `${REPORT_START_MARKER}\n${profileText()}${cardText().replace("### 任务", "#### 任务")}`,
      `${REPORT_START_MARKER}\n${profileText()}<CARD>\n`,
    ]) await expect(create().parser.push(bad)).rejects.toBeInstanceOf(PresentationError);
  });

  it("does not reinterpret Chinese Markdown as a successful old producer protocol", async () => {
    const old = create("narrative");
    await expect(old.parser.push(`${report()}\n`)).rejects.toBeInstanceOf(PresentationError);
  });
});
