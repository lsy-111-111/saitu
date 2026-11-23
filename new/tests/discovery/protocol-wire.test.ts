import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDiscoveryProtocolParser, createDiscoveryProtocolSourceIndex, resolveDiscoveryProtocolRecord,
  DISCOVERY_PROTOCOL_VERSIONS, discoveryProtocolVersionSchema, type DiscoveryProtocolVersion,
} from "@/lib/competitions/discovery/protocol-wire";
import {
  REPORT_START_MARKER, REPORT_END_MARKER, PresentationError,
  type DiscoveryModelPresentationRecord, type DiscoveryCardRecord,
} from "@/lib/competitions/discovery/presentation";
import type { DiscoveryCatalogSnapshot } from "@/lib/competitions/discovery/transport";

function catalogFixture(): DiscoveryCatalogSnapshot {
  const text = JSON.stringify({ schemaVersion: "competition-discovery-catalog.v7", version: "test.v1", columns: ["id", "name", "localSources"], entries: [
    ["science-one", "科学竞赛甲", [["https://example.org/one", "official-competition", "2026-01-01"], "https://example.org/archive"]],
    ["science-two", "科学竞赛乙", [["https://example.org/two", "organizer", "2026-02-01"]]],
  ] });
  return { version: "test.v1", count: 2, ids: ["science-one", "science-two"], text, clarifyText: "[]", byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}
const profile: DiscoveryModelPresentationRecord = {
  type: "profile", summary: "全日制博士，已有未发表原型；可用资源形式未明。",
  groups: { background: ["博士在读"], goals: ["首要积累研究记录"], experience: ["未发表原型及阶段数据"], constraints: ["队伍人数/同校/学段未知", "只接受全程线上"] },
};
const card: DiscoveryCardRecord = {
  type: "card", key: "r1", competitionId: "science-one", title: "科学竞赛甲", track: "研究类",
  summary: '已做资料整理，可了解该任务；复用“待核”。', timing: "下一届通知本次未查到",
  details: {
    tasks: ["先核原型权属与复用，再独立完成符合规则的作品。"],
    reasons: ["做过资料整理。", "首要目标为研究记录。"],
    value: ["积累实验与方法记录，不承诺发表。"],
    conditions: ["出生日期须为1991年3月1日及以后；本人年龄未提供。", "个人总费用、全流程方式待核，不据团队费用推个人承担。"],
  }, sources: [{ url: "https://example.org/one", title: "原届次规则" }],
};
const conclusion: DiscoveryModelPresentationRecord = { type: "conclusion", priorities: [{ cardKey: "r1", reason: "科学竞赛甲关联研究目标，先核复用与资格后再准备。" }], note: "未知不等于没有能力。", exceptions: [] };

function compactCard(value: DiscoveryCardRecord = card): Record<string, unknown> {
  const { title: _title, sources: _sources, ...rest } = value;
  return { ...rest, sourceRefs: [0] };
}
function jsonReport(records: readonly unknown[]): string {
  return `${REPORT_START_MARKER}\n${records.map(record => JSON.stringify(record, null, 2)).join("\n")}`;
}
const list = (values: readonly string[]) => values.map(value => `- ${value}`).join("\n");
function block(kind: string, fields: [string, string][]): string {
  return `<${kind}>\n${fields.map(([key, value]) => `[${key}]\n${value}`).join("\n")}\n</${kind}>\n`;
}
function profileBlock(): string {
  if (profile.type !== "profile") throw new Error("fixture");
  return block("PROFILE", [["summary", profile.summary], ...Object.entries(profile.groups).map(([key, values]): [string, string] => [key, list(values)])]);
}
function cardBlock(refs = false, value: DiscoveryCardRecord = card): string {
  return block("CARD", [
    ["key", value.key], ["competitionId", value.competitionId ?? "null"],
    ...(!refs || value.competitionId === null ? [["title", value.title] as [string, string]] : []),
    ["track", value.track], ["summary", value.summary], ["timing", value.timing ?? ""],
    ...Object.entries(value.details).map(([key, values]): [string, string] => [key, list(values)]),
    ...(refs ? [["sourceRefs", value.competitionId === null ? "" : "- 0"] as [string, string]] : []),
    ["sources", refs && value.competitionId !== null ? "" : value.sources.map(source => `- [${source.title}](<${source.url}>)`).join("\n")],
  ]);
}
function conclusionBlock(noResults = false): string {
  return block("CONCLUSION", [["priorities", noResults ? "" : "- r1 | 科学竞赛甲关联研究目标，先核复用与资格后再准备。"], ["note", "未知不等于没有能力。"], ["exceptions", ""]]);
}
function textReport(refs = false): string {
  return `${REPORT_START_MARKER}\n${profileBlock()}${cardBlock(refs)}${conclusionBlock()}${REPORT_END_MARKER}`;
}
function narrativeCardBlock(value: DiscoveryCardRecord = card): string {
  return block("CARD", [
    ["competitionId", value.competitionId ?? "null"],
    ...(value.competitionId === null ? [["title", value.title] as [string, string]] : []), ["track", value.track],
    ...Object.entries(value.details).map(([key, values]): [string, string] => [key, list(values)]),
    ["sourceRefs", value.competitionId === null ? "" : "- 0"],
    ...(value.competitionId === null ? [["sources", value.sources.map(source => `- [${source.title}](<${source.url}>)`).join("\n")] as [string, string]] : []),
  ]);
}
function inlineFields(text: string): string {
  return text.replace(/^(\[[A-Za-z][A-Za-z0-9]*\])\n(?!\[|<|\n)([^\n]+)/gmu, "$1\t$2");
}
function chunkText(text: string, chunking: string): string[] {
  if (chunking === "whole") return [text];
  if (chunking === "code-unit") return text.split("");
  const size = Number(chunking), bytes = Buffer.from(text), decoder = new TextDecoder(), chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(decoder.decode(bytes.subarray(offset, offset + size), { stream: true }));
  chunks.push(decoder.decode());
  return chunks;
}
function create(protocolVersion: DiscoveryProtocolVersion) {
  const records: DiscoveryModelPresentationRecord[] = [];
  return { records, parser: createDiscoveryProtocolParser({ protocolVersion, catalog: catalogFixture(), onRecord: record => { records.push(record); } }) };
}

describe("private discovery protocol adapters", () => {
  it("shares the internal protocol list and rejects an HTTP-style legacy selector", () => {
    expect(DISCOVERY_PROTOCOL_VERSIONS).toEqual(["v16", "rules", "blocks", "refs", "json-optimized", "blocks-optimized", "blocks-flow", "json-flat", "blocks-flow-named", "narrative", "narrative-rules", "narrative-index", "markdown-v16", "markdown-single", "markdown-nested", "markdown-late", "markdown-grounded-scope"]);
    expect(discoveryProtocolVersionSchema.safeParse("legacy").success).toBe(false);
    expect(discoveryProtocolVersionSchema.safeParse("invented").success).toBe(false);
  });

  it.each(["v16", "rules"] as const)("keeps the full JSON record semantics for %s", async protocol => {
    const { parser, records } = create(protocol);
    await parser.push(jsonReport([profile, card, conclusion]));
    const state = await parser.finish();
    expect(records).toEqual([profile, card, conclusion]);
    expect(state.cards[0]).toEqual(card);
  });

  it.each(["refs", "json-optimized"] as const)("restores selected frozen name and source without changing personal details for %s", async protocol => {
    const { parser, records } = create(protocol);
    await parser.push(jsonReport([profile, compactCard(), conclusion]));
    const state = await parser.finish();
    expect(records).toHaveLength(3);
    expect(state.cards[0].title).toBe("科学竞赛甲");
    expect(state.cards[0].details).toEqual(card.details);
    expect(state.cards[0].sources).toEqual([{ url: "https://example.org/one", title: "科学竞赛甲 · 原目录来源1（原目录核查日期：2026-01-01）" }]);
  });

  it.each(["blocks", "blocks-optimized"] as const)("converts bounded text to the existing public records for %s", async protocol => {
    const { parser, records } = create(protocol);
    const input = `我先核对关键资料。\n${textReport(protocol === "blocks-optimized").replaceAll("\n", "\r\n")}`;
    for (const char of input) await parser.push(char);
    const state = await parser.finish();
    expect(records).toHaveLength(3);
    expect(state.profile).toEqual(profile);
    expect(state.cards[0].details).toEqual(card.details);
    expect(state.cards[0].summary).toBe(card.summary);
    expect(state.cards[0].sources[0].url).toBe(card.sources[0].url);
    expect(state.conclusion).toEqual(conclusion);
  });

  it("emits a valid text card before a malformed later block in the same chunk", async () => {
    const { parser, records } = create("blocks");
    const bad = cardBlock().replace("[tasks]", "[omitted]").replace("[key]\nr1", "[key]\nr2");
    await expect(parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${cardBlock()}${bad}`)).rejects.toBeInstanceOf(PresentationError);
    expect(records.map(record => record.type)).toEqual(["profile", "card"]);
  });

  it("requires every text card to close and never publishes partial personal details", async () => {
    const { parser, records } = create("blocks");
    await parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${cardBlock().replace("</CARD>\n", "")}`);
    expect(records).toEqual([profile]);
    await expect(parser.finish()).rejects.toMatchObject({ code: "incomplete_report" });
  });

  it("requires the outer text end marker and rejects trailing data", async () => {
    const missing = create("blocks");
    await missing.parser.push(textReport().replace(REPORT_END_MARKER, ""));
    await expect(missing.parser.finish()).rejects.toMatchObject({ code: "incomplete_report" });
    const trailing = create("blocks");
    await expect(trailing.parser.push(`${textReport()}\n额外结论\n`)).rejects.toBeInstanceOf(PresentationError);
  });

  it.each(["<UNKNOWN>", "</CAR>", "<CARD extra=1>"])("rejects standalone unknown protocol marker %s without discarding it", async marker => {
    const { parser } = create("blocks");
    await expect(parser.push(`${REPORT_START_MARKER}\n<PROFILE>\n[summary]\n${marker}\n`)).rejects.toBeInstanceOf(PresentationError);
  });

  it("retains ordinary qualified prose containing comparison operators or tags", async () => {
    const { parser } = create("blocks");
    const varied = { ...card, details: { ...card.details, tasks: ["先核样本量 < 10 的情形；正文提及 <DNA> 不是协议标记。"] } };
    await parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${cardBlock(false, varied)}${conclusionBlock()}${REPORT_END_MARKER}`);
    expect((await parser.finish()).cards[0].details.tasks).toEqual(varied.details.tasks);
  });

  it.each(["- [规则](https://example.org/one) 但仅限本校", "- [规则](https://example.org/one)仅限本校)", "来源：[规则](https://example.org/one)", "- [规则](javascript:alert(1))"])("rejects incomplete source-only line %s rather than silently dropping qualifiers", async source => {
    const { parser } = create("blocks");
    const sourceBlock = cardBlock().replace("- [原届次规则](<https://example.org/one>)", source);
    await expect(parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${sourceBlock}`)).rejects.toBeInstanceOf(PresentationError);
  });

  it("accepts a complete, explained zero-card text report", async () => {
    const { parser } = create("blocks-optimized");
    await parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${conclusionBlock(true)}${REPORT_END_MARKER}`);
    expect((await parser.finish()).cards).toEqual([]);
  });

  it("reads one static source index per physical line, with optional Markdown list separators", async () => {
    for (const indexes of ["0\n1", "- 0\n- 1"]) {
      const { parser } = create("blocks-optimized");
      await parser.push(textReport(true).replace("[sourceRefs]\n- 0", `[sourceRefs]\n${indexes}`));
      expect((await parser.finish()).cards[0].sources.map(source => source.url)).toEqual(["https://example.org/one", "https://example.org/archive"]);
    }
  });

  it("keeps external competitions and new web sources, requiring an authored external name", async () => {
    const index = createDiscoveryProtocolSourceIndex(catalogFixture());
    const external = { ...card, competitionId: null, title: "开放研究挑战" };
    expect(resolveDiscoveryProtocolRecord(external, index)).toEqual(external);
    expect(() => resolveDiscoveryProtocolRecord({ ...external, sourceRefs: [0] }, index)).toThrow(PresentationError);
    const { title: _title, ...missing } = external;
    expect(() => resolveDiscoveryProtocolRecord(missing, index)).toThrow(PresentationError);
    const enriched = resolveDiscoveryProtocolRecord({ ...compactCard(), sources: [{ url: "https://example.org/current", title: "本次工具返回的一手新通知" }] }, index);
    expect(enriched.type === "card" && enriched.sources.map(source => source.url)).toEqual(["https://example.org/one", "https://example.org/current"]);
  });

  it("rejects unknown, repeated or cross-owner indexes without URL correction or source substitution", () => {
    const index = createDiscoveryProtocolSourceIndex(catalogFixture());
    for (const sourceRefs of [[2], [-1], [0, 0], ["0"]]) expect(() => resolveDiscoveryProtocolRecord({ ...compactCard(), sourceRefs }, index)).toThrow(PresentationError);
    expect(() => resolveDiscoveryProtocolRecord({ ...compactCard(), sourceRefs: null }, index)).toThrow(PresentationError);
    expect(() => resolveDiscoveryProtocolRecord({ ...compactCard(), sources: null }, index)).toThrow(PresentationError);
    expect(() => resolveDiscoveryProtocolRecord({ ...compactCard(), competitionId: "unknown" }, index)).toThrow(PresentationError);
    expect(() => resolveDiscoveryProtocolRecord({ ...compactCard(), title: "科学竞赛乙" }, index)).toThrow(PresentationError);
    const second = resolveDiscoveryProtocolRecord({ ...compactCard(), competitionId: "science-two" }, index);
    expect(second.type === "card" && second.sources[0].url).toBe("https://example.org/two");
    const urlOnly = resolveDiscoveryProtocolRecord({ ...compactCard(), sourceRefs: [1] }, index);
    expect(urlOnly.type === "card" && urlOnly.sources[0].title).not.toContain("核查日期");
  });

  it("refuses changed snapshot contents and does not use a current catalog to repair them", () => {
    const catalog = catalogFixture();
    expect(() => createDiscoveryProtocolSourceIndex({ ...catalog, text: catalog.text.replace("科学竞赛甲", "科学竞赛丙") })).toThrow(PresentationError);
    expect(() => createDiscoveryProtocolSourceIndex({ ...catalog, ids: [...catalog.ids].reverse() })).toThrow(PresentationError);
  });

  it.each(["blocks-flow", "blocks-flow-named"] as const)("publishes complete implicit sibling blocks without losing any details for %s", async protocol => {
    const { parser, records } = create(protocol);
    const input = textReport(true).replaceAll(/<\/(?:PROFILE|CARD|CONCLUSION)>\n/gu, "");
    for (const char of input) await parser.push(char);
    expect(records.map(record => record.type)).toEqual(["profile", "card"]);
    const state = await parser.finish();
    expect(records.map(record => record.type)).toEqual(["profile", "card", "conclusion"]);
    expect(state.profile).toEqual(profile);
    expect(state.cards[0].details).toEqual(card.details);
    expect(state.cards[0].sources[0].url).toBe(card.sources[0].url);
    expect(state.conclusion).toEqual(conclusion);
  });

  it("accepts a mixture of explicit and implicit sibling boundaries, with atomic ordered delivery", async () => {
    const { parser, records } = create("blocks-flow");
    const second = { ...card, key: "r2", competitionId: "science-two", title: "科学竞赛乙" };
    await parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${cardBlock(true).replace("</CARD>\n", "")}${cardBlock(true, second)}${conclusionBlock().replace("</CONCLUSION>\n", "")}${REPORT_END_MARKER}\n`);
    const state = await parser.finish();
    expect(records.map(record => record.type)).toEqual(["profile", "card", "card", "conclusion"]);
    expect(state.cards.map(value => [value.key, value.title])).toEqual([["r1", "科学竞赛甲"], ["r2", "科学竞赛乙"]]);
  });

  it("never completes missing mandatory fields at an implicit boundary", async () => {
    const { parser, records } = create("blocks-flow");
    const missing = profileBlock().replace("[constraints]\n- 队伍人数/同校/学段未知\n- 只接受全程线上\n", "").replace("</PROFILE>\n", "");
    await expect(parser.push(`${REPORT_START_MARKER}\n${missing}<CARD>\n`)).rejects.toMatchObject({ code: "invalid_record" });
    expect(records).toEqual([]);
  });

  it("retains earlier valid flow cards when the next incomplete card fails", async () => {
    const { parser, records } = create("blocks-flow");
    const incomplete = cardBlock(true, { ...card, key: "r2", competitionId: "science-two" })
      .replace("[conditions]", "[unrecognized]").replace("</CARD>\n", "");
    await expect(parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${cardBlock(true).replace("</CARD>\n", "")}${incomplete}<CONCLUSION>\n`)).rejects.toBeInstanceOf(PresentationError);
    expect(records.map(record => record.type)).toEqual(["profile", "card"]);
  });

  it("keeps the total END mandatory and does not accept it before a conclusion", async () => {
    const missing = create("blocks-flow");
    await missing.parser.push(textReport(true).replaceAll(/<\/(?:PROFILE|CARD|CONCLUSION)>\n/gu, "").replace(REPORT_END_MARKER, ""));
    await expect(missing.parser.finish()).rejects.toMatchObject({ code: "incomplete_report" });
    expect(missing.records.map(record => record.type)).toEqual(["profile", "card"]);
    const early = create("blocks-flow");
    await expect(early.parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${cardBlock(true).replace("</CARD>\n", "")}${REPORT_END_MARKER}\n`)).rejects.toMatchObject({ code: "invalid_sequence" });
    expect(early.records).toEqual([profile]);
    const oldNormal = create("blocks-flow");
    await oldNormal.parser.push(textReport(true).replace(REPORT_END_MARKER, ""));
    await expect(oldNormal.parser.finish({ upstreamEndedNormally: true })).rejects.toMatchObject({ code: "incomplete_report" });
  });

  it("rejects invalid sibling order, mismatched closes and post-conclusion records", async () => {
    for (const input of [
      `${REPORT_START_MARKER}\n${profileBlock().replace("</PROFILE>\n", "")}<PROFILE>\n`,
      `${REPORT_START_MARKER}\n${profileBlock().replace("</PROFILE>", "</CARD>")}`,
      `${REPORT_START_MARKER}\n${profileBlock()}${conclusionBlock(true).replace("</CONCLUSION>\n", "")}<CARD>\n`,
      `${textReport(true)}\n<CARD>\n`,
    ]) await expect(create("blocks-flow").parser.push(input)).rejects.toMatchObject({ code: "invalid_sequence" });
  });

  it("accepts explained zero-card flow and rejects more than two priorities", async () => {
    const zero = create("blocks-flow");
    await zero.parser.push(`${REPORT_START_MARKER}\n${profileBlock().replace("</PROFILE>\n", "")}${conclusionBlock(true).replace("</CONCLUSION>\n", "")}${REPORT_END_MARKER}`);
    expect((await zero.parser.finish()).cards).toEqual([]);
    const bad = create("blocks-flow");
    const three = conclusionBlock().replace("[note]", "- r2 | 先核资格\n- r3 | 先核费用\n[note]");
    await expect(bad.parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${cardBlock(true)}${three}`)).rejects.toBeInstanceOf(PresentationError);
    expect(bad.records.map(record => record.type)).toEqual(["profile", "card"]);
  });

  it("maps every flat personal field verbatim while resolving only frozen names and selected sources", async () => {
    const { parser, records } = create("json-flat");
    const { details, ...base } = compactCard() as Omit<DiscoveryCardRecord, "title" | "sources">;
    const input = jsonReport([profile, { ...base, ...details }, conclusion]);
    for (const char of input) await parser.push(char);
    const state = await parser.finish();
    expect(records).toHaveLength(3);
    expect(state.cards[0].details).toEqual(card.details);
    expect(state.cards[0].summary).toBe(card.summary);
    expect(state.cards[0].title).toBe(card.title);
    expect(state.cards[0].sources[0].url).toBe(card.sources[0].url);
  });

  it("rejects ambiguous, missing, nested or unknown flat fields without repairing them", async () => {
    const { details, ...base } = compactCard() as Omit<DiscoveryCardRecord, "title" | "sources">;
    const flat = { ...base, ...details };
    const { tasks: _tasks, ...missingTasks } = flat;
    for (const malformed of [compactCard(), { ...flat, details }, missingTasks, { ...flat, invented: "不能丢弃" }, { ...flat, conditions: [] }]) {
      const { parser, records } = create("json-flat");
      await expect(parser.push(jsonReport([profile, malformed, conclusion]))).rejects.toBeInstanceOf(PresentationError);
      expect(records).toEqual([profile]);
    }
  });

  describe.each(["narrative", "narrative-rules", "narrative-index"] as const)("%s lossless authored narrative", protocol => {
    it.each(["whole", "code-unit", "1", "7", "257"])("derives only repeated display fields and delivers the full card atomically under %s chunks", async chunking => {
      const { parser, records } = create(protocol);
      const reason = "做过资料整理，愿意进一步研究；原型和阶段数据的权属、授权及复用待核，不直接视为可申报作品。".repeat(4);
      const condition = "原资料为2025—2026届，未来届次本次未查到；年龄边界为1991年3月1日及以后，个人实际承担与全程方式仍待核。";
      const value = { ...card, details: { ...card.details, reasons: [reason, ...card.details.reasons], conditions: [condition, ...card.details.conditions] } };
      const wire = inlineFields(`${REPORT_START_MARKER}\n${profileBlock()}${narrativeCardBlock(value)}${conclusionBlock()}${REPORT_END_MARKER}`)
        .replaceAll(/<\/(?:PROFILE|CARD|CONCLUSION)>\n/gu, "");
      for (const chunk of chunkText(wire, chunking)) await parser.push(chunk);
      const state = await parser.finish();
      expect(records.map(record => record.type)).toEqual(["profile", "card", "conclusion"]);
      expect(state.profile).toEqual(profile);
      expect(state.cards[0]).toMatchObject({ key: "r1", title: card.title, track: card.track, summary: reason, timing: condition, details: value.details });
      expect(state.cards[0].sources[0].url).toBe(card.sources[0].url);
      expect(state.conclusion).toEqual(conclusion);
    });

    it("assigns keys only by complete published card order, preserving the selected priority", async () => {
      const { parser, records } = create(protocol), second = { ...card, competitionId: "science-two", title: "科学竞赛乙" };
      const final = conclusionBlock().replace("- r1 |", "- r2 |");
      await parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${narrativeCardBlock()}${narrativeCardBlock(second)}${final}${REPORT_END_MARKER}\n`);
      const state = await parser.finish();
      expect(records.map(record => record.type)).toEqual(["profile", "card", "card", "conclusion"]);
      expect(state.cards.map(value => value.key)).toEqual(["r1", "r2"]);
      expect(state.conclusion?.priorities[0].cardKey).toBe("r2");
    });

    it.each(["key", "summary", "timing", "title", "unknown_field"])("rejects authored internal-only or unknown card field %s rather than dropping it", async field => {
      for (const form of [`[${field}]\nr1`, `[${field}] r1`]) {
        const { parser, records } = create(protocol);
        const bad = narrativeCardBlock().replace("</CARD>", `${form}\n</CARD>`);
        await expect(parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${bad}`)).rejects.toMatchObject({ code: "invalid_record" });
        expect(records).toEqual([profile]);
      }
    });

    it("accepts a named external recommendation with exact explicit sources but no static source borrowing", async () => {
      const { parser } = create(protocol), external = { ...card, competitionId: null, title: "开放研究挑战" };
      await parser.push(inlineFields(`${REPORT_START_MARKER}\n${profileBlock()}${narrativeCardBlock(external)}${conclusionBlock()}${REPORT_END_MARKER}`));
      const result = (await parser.finish()).cards[0];
      expect(result).toMatchObject({ competitionId: null, title: external.title, sources: external.sources, details: external.details });
      for (const bad of [
        narrativeCardBlock(external).replace("[title]\n开放研究挑战\n", ""),
        narrativeCardBlock(external).replace("[sourceRefs]\n\n", "[sourceRefs]\n- 0\n"),
      ]) await expect(create(protocol).parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${bad}`)).rejects.toBeInstanceOf(PresentationError);
    });

    it("does not synthesize missing narrative arrays, missing reference intent or missing completion", async () => {
      for (const missing of [
        narrativeCardBlock().replace("[tasks]", "[unrecognized]"),
        narrativeCardBlock().replace("[reasons]\n- 做过资料整理。\n- 首要目标为研究记录。", "[reasons]"),
        narrativeCardBlock().replace(/\[sourceRefs\]\n- 0\n/u, ""),
      ]) {
        const { parser, records } = create(protocol);
        await expect(parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${missing}`)).rejects.toBeInstanceOf(PresentationError);
        expect(records).toEqual([profile]);
      }
      const incomplete = create(protocol);
      await incomplete.parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${narrativeCardBlock()}${conclusionBlock().replace("</CONCLUSION>\n", "")}`);
      await expect(incomplete.parser.finish()).rejects.toMatchObject({ code: "incomplete_report" });
      expect(incomplete.records.map(record => record.type)).toEqual(["profile", "card"]);
    });

    it("delivers earlier complete records before rejecting a later malformed sibling", async () => {
      const { parser, records } = create(protocol), second = { ...card, competitionId: "science-two" };
      const broken = narrativeCardBlock(second).replace("[conditions]", "[unknown]").replace("</CARD>\n", "");
      await expect(parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${narrativeCardBlock().replace("</CARD>\n", "")}${broken}<CONCLUSION>\n`)).rejects.toBeInstanceOf(PresentationError);
      expect(records.map(record => record.type)).toEqual(["profile", "card"]);
    });

    it("accepts explained zero cards with inline values but rejects duplicate, unknown and invalid inline references", async () => {
      const zero = create(protocol);
      await zero.parser.push(inlineFields(`${REPORT_START_MARKER}\n${profileBlock()}${conclusionBlock(true)}${REPORT_END_MARKER}\n`));
      expect((await zero.parser.finish()).cards).toEqual([]);
      for (const badProfile of [
        profileBlock().replace("</PROFILE>", "[summary] 重复字段\n</PROFILE>"),
        profileBlock().replace("</PROFILE>", "[unknown] 不得丢弃\n</PROFILE>"),
      ]) await expect(create(protocol).parser.push(`${REPORT_START_MARKER}\n${badProfile}`)).rejects.toMatchObject({ code: "invalid_record" });
      await expect(create(protocol).parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${narrativeCardBlock().replace("[sourceRefs]\n- 0", "[sourceRefs] 0 1")}`)).rejects.toMatchObject({ code: "invalid_record" });
    });
  });

  it("keeps previous block experiments strict and does not read Markdown links as inline field names", async () => {
    const old = create("blocks-flow");
    await expect(old.parser.push(`${REPORT_START_MARKER}\n${inlineFields(profileBlock())}`)).rejects.toMatchObject({ code: "invalid_record" });
    const external = { ...card, competitionId: null, title: "新赛", sources: [{ url: "https://example.org/new", title: "summary" }] }, fresh = create("narrative");
    await fresh.parser.push(`${REPORT_START_MARKER}\n${profileBlock()}${narrativeCardBlock(external).replace("- [summary]", "[summary]")}${conclusionBlock()}${REPORT_END_MARKER}`);
    expect((await fresh.parser.finish()).cards[0].sources).toEqual(external.sources);
  });
});
