import { describe, expect, it } from "vitest";
import {
  DISCOVERY_PRESENTATION_VERSION, REPORT_START_MARKER, REPORT_END_MARKER, PresentationError,
  applyDiscoveryPresentationRecord, discoveryPresentationMarkdown, discoveryPresentationSchema,
  emptyDiscoveryPresentation, persistedPresentationRecordSchema, presentationRecordMarkdown, presentationRecordSchema,
  type DiscoveryCardRecord, type DiscoveryCatalogDetail, type DiscoveryConclusionRecord,
  type DiscoveryPresentationRecord, type DiscoveryProfileRecord,
} from "@/lib/competitions/discovery/presentation";
import { DiscoveryPresentationParser } from "@/lib/competitions/discovery/presentation-parser";

const profile: DiscoveryProfileRecord = {
  type: "profile", summary: "希望通过编程项目积累作品；已有课堂实践，仍需核对具体赛道资格。",
  groups: { background: ["计算机相关专业"], goals: ["积累求职作品"], experience: ["做过可运行的课堂程序"], constraints: ["每周约六小时" ] },
};
const card: DiscoveryCardRecord = {
  type: "card", key: "r1", competitionId: "icpc-programming", title: "程序设计竞赛", track: "大学生赛道",
  summary: "实际写过程序，可进一步了解算法任务。", timing: "报名安排待核",
  details: { tasks: ["编程解题，测试并解释结果。"], reasons: ["你自述做过可运行程序。"], value: ["积累算法训练与协作经验。"], conditions: ["当前学籍与赛区要求仍须核对。"] },
  sources: [{ title: "规则资料", url: "https://example.org/rules" }],
};
const conclusion: DiscoveryConclusionRecord = {
  type: "conclusion", priorities: [{ cardKey: "r1", reason: "可先核对程序设计竞赛的参赛规则，再决定是否准备。" }],
  note: "只列出当前有依据的方向。", exceptions: [],
};
const catalog: DiscoveryCatalogDetail = {
  id: "icpc-programming", title: "程序设计竞赛", version: "2026-11-20.v14", sha256: "a".repeat(64), detailPath: "/competitions/icpc-programming",
  sections: [{ heading: "参赛资格", paragraphs: ["适用范围：所引往届规则；当届资格待核。"], sources: card.sources }], sources: card.sources,
};
const line = (record: unknown) => JSON.stringify(record);
const report = (records: readonly unknown[]) => `${REPORT_START_MARKER}\n${records.map(line).join("\n")}`;
function createParser() {
  const records: DiscoveryPresentationRecord[] = [];
  const parser = new DiscoveryPresentationParser({ onRecord(record) { records.push(record); } });
  return { parser, records };
}

describe("discovery card presentation contract", () => {
  it("appends complete records immutably and validates partial snapshots", () => {
    const empty = emptyDiscoveryPresentation();
    const first = applyDiscoveryPresentationRecord(empty, profile);
    const partial = applyDiscoveryPresentationRecord(first, { ...card, catalogDetail: catalog });
    expect(empty).toEqual({ version: DISCOVERY_PRESENTATION_VERSION, cards: [] });
    expect(first.cards).toEqual([]);
    expect(discoveryPresentationSchema.parse(partial).cards[0].catalogDetail).toEqual(catalog);
    const final = applyDiscoveryPresentationRecord(partial, conclusion);
    expect(discoveryPresentationSchema.parse(final).conclusion).toEqual(conclusion);
  });

  it("keeps server catalog material outside the model record schema and binds its identity", () => {
    const enriched = { ...card, catalogDetail: catalog };
    expect(presentationRecordSchema.safeParse(enriched).success).toBe(false);
    expect(persistedPresentationRecordSchema.safeParse(enriched).success).toBe(true);
    expect(persistedPresentationRecordSchema.safeParse({ ...enriched, competitionId: null }).success).toBe(false);
    expect(persistedPresentationRecordSchema.safeParse({ ...enriched, catalogDetail: { ...catalog, detailPath: "/competitions/different" } }).success).toBe(false);
  });

  it("normalizes safe source URLs before persisting or serializing them", () => {
    const normalized = presentationRecordSchema.parse({ ...card, sources: [{ title: "规则", url: "https://example.org/规则?q=>\n" }] });
    expect(normalized.type).toBe("card");
    if (normalized.type !== "card") throw new Error("unexpected fixture");
    expect(normalized.sources[0].url).toBe("https://example.org/%E8%A7%84%E5%88%99?q=%3E");
    expect(normalized.sources[0].url).not.toMatch(/[<>\r\n]/u);
  });

  it("bounds schema diagnostics and never retains authored field names or Zod messages", () => {
    const error = new PresentationError("invalid_record", Array.from({ length: 8 }, () => ({
      code: "custom" as const, path: ["sources", 0, "private-authored-field"], message: "private authored value and message",
    })));
    expect(error.schemaIssues).toEqual(Array.from({ length: 5 }, () => ({ code: "custom", path: [] })));
    expect(JSON.stringify(error)).not.toMatch(/private|message|authored|value/);
  });

  it.each(["javascript:alert(1)", "file:///private/report", "https://user:secret@example.org/rules", "//example.org/rules"])("rejects unsafe source %s", url => {
    expect(presentationRecordSchema.safeParse({ ...card, sources: [{ title: "来源", url }] }).success).toBe(false);
  });

  it("rejects sequence, duplicate cards and invalid priority references without deduplicating", () => {
    const start = applyDiscoveryPresentationRecord(emptyDiscoveryPresentation(), profile);
    const one = applyDiscoveryPresentationRecord(start, card);
    expect(() => applyDiscoveryPresentationRecord(emptyDiscoveryPresentation(), card)).toThrow(PresentationError);
    expect(() => applyDiscoveryPresentationRecord(start, profile)).toThrow(PresentationError);
    expect(() => applyDiscoveryPresentationRecord(one, { ...card, key: "r2" })).toThrow(PresentationError);
    expect(() => applyDiscoveryPresentationRecord(one, { ...card, competitionId: null })).toThrow(PresentationError);
    expect(() => applyDiscoveryPresentationRecord(one, { ...conclusion, priorities: [{ cardKey: "unknown", reason: "未知引用" }] })).toThrow(PresentationError);
    expect(() => applyDiscoveryPresentationRecord(one, { ...conclusion, priorities: [] })).toThrow(PresentationError);
    const complete = applyDiscoveryPresentationRecord(one, conclusion);
    expect(() => applyDiscoveryPresentationRecord(complete, { ...card, key: "r2", competitionId: null })).toThrow(PresentationError);
  });

  it("rejects exact normalized duplicates among external competitions and keeps only two conflict exceptions", () => {
    const start = applyDiscoveryPresentationRecord(emptyDiscoveryPresentation(), profile);
    const first = applyDiscoveryPresentationRecord(start, { ...card, competitionId: null, title: "  ＡＢＣ竞赛 " });
    expect(() => applyDiscoveryPresentationRecord(first, { ...card, key: "r2", competitionId: null, title: "ABC竞赛" })).toThrow(PresentationError);
    expect(presentationRecordSchema.safeParse({ ...conclusion, exceptions: ["冲突一", "冲突二", "冲突三"] }).success).toBe(false);
  });

  it("accepts zero recommendations only with an explicit conclusion note", () => {
    const state = applyDiscoveryPresentationRecord(emptyDiscoveryPresentation(), profile);
    expect(() => applyDiscoveryPresentationRecord(state, { type: "conclusion", priorities: [], note: "  ", exceptions: [] })).toThrow(PresentationError);
    expect(applyDiscoveryPresentationRecord(state, { type: "conclusion", priorities: [], note: "缺少可靠匹配依据，暂不推荐。", exceptions: [] }).cards).toEqual([]);
  });

  it("serializes visible content, scope and sources deterministically without rendering authored markup", () => {
    const enriched = { ...card, title: "[程序] <script>", catalogDetail: catalog };
    const state = applyDiscoveryPresentationRecord(applyDiscoveryPresentationRecord(applyDiscoveryPresentationRecord(emptyDiscoveryPresentation(), profile), enriched), conclusion);
    const markdown = discoveryPresentationMarkdown(state);
    expect(markdown).toBe([profile, enriched, conclusion].map(presentationRecordMarkdown).join(""));
    expect(markdown).toContain("已有经历与能力自述");
    expect(markdown).toContain("\\[程序\\] \\<script\\>");
    expect(markdown).toContain("适用范围：所引往届规则；当届资格待核。");
    expect(markdown).toContain("[规则资料](<https://example.org/rules>)");
    expect(markdown).toContain("[打开站内赛事详情](/competitions/icpc-programming)");
    expect(markdown).not.toContain('"competitionId"');
  });
});

describe("discovery NDJSON presentation parser", () => {
  it("reports declared nested fields for a schema failure without retaining values or unknown keys", async () => {
    const { parser, records } = createParser();
    const malformed = { ...card, details: { ...card.details, reasons: "private-reason-value" },
      sources: [{ url: "javascript:private-source-value", title: "private-source-title", "private-source-key": "private-extra-value" }],
      "private-root-key": "private-root-value" };
    const caught = await parser.push(`${report([profile, malformed])}\n`).catch(error => error);
    expect(caught).toBeInstanceOf(PresentationError);
    expect(caught).toMatchObject({ code: "invalid_record", schemaIssues: [
      { code: "invalid_type", path: ["details", "reasons"] },
      { code: "custom", path: ["sources", 0, "url"] },
      { code: "unrecognized_keys", path: ["sources", 0] },
      { code: "unrecognized_keys", path: [] },
    ] });
    expect(JSON.stringify(caught)).not.toMatch(/private|javascript|message|keys":/);
    expect(records).toEqual([profile]);
  });

  it("handles split markers, CRLF, escaped content, emoji and final record without newline", async () => {
    const { parser, records } = createParser();
    const specialCard = { ...card, summary: '处理数据后解释结果😀；可写“报告”与路径\\示例。', details: { ...card.details, tasks: ['任务第一行\n第二行，含"引号"。'] } };
    const input = `我先核查关键规则。\n${report([profile, specialCard, conclusion]).replaceAll("\n", "\r\n")}`;
    for (const character of input) await parser.push(character);
    const state = await parser.finish();
    expect(records).toEqual([profile, specialCard, conclusion]);
    expect(state.cards[0].details.tasks).toEqual(specialCard.details.tasks);
    expect(state.conclusion).toEqual(conclusion);
  });

  it("does not emit an unfinished record and awaits delivery in record order", async () => {
    const delivered: string[] = [];
    const parser = new DiscoveryPresentationParser({ async onRecord(record) {
      delivered.push(`start:${record.type}`);
      await Promise.resolve();
      delivered.push(`end:${record.type}`);
    } });
    await parser.push(`${REPORT_START_MARKER}\n${line(profile)}\n${line(card).slice(0, 10)}`);
    expect(delivered).toEqual(["start:profile", "end:profile"]);
    await parser.push(`${line(card).slice(10)}\n${line(conclusion)}`);
    expect(delivered).toEqual(["start:profile", "end:profile", "start:card", "end:card", "start:conclusion", "end:conclusion"]);
    await parser.finish();
    expect(delivered.slice(-2)).toEqual(["start:conclusion", "end:conclusion"]);
  });

  it("publishes valid preceding records before a bad later line in the same chunk", async () => {
    const { parser, records } = createParser();
    await expect(parser.push(`${report([profile, card])}\n{broken}\n`)).rejects.toMatchObject({ code: "invalid_json" });
    expect(records).toEqual([profile, card]);
    await expect(parser.finish()).rejects.toBeInstanceOf(PresentationError);
  });

  it.each([
    { label: "bad record", tail: { ...card, key: "r2", competitionId: null, details: { ...card.details, reasons: [] } }, code: "invalid_record" },
    { label: "duplicate identity", tail: { ...card, key: "r2" }, code: "duplicate_card" },
    { label: "second profile", tail: profile, code: "invalid_sequence" },
    { label: "unknown priority", tail: { ...conclusion, priorities: [{ cardKey: "missing", reason: "不存在" }] }, code: "invalid_conclusion" },
  ])("does not silently drop $label", async ({ tail, code }) => {
    const { parser, records } = createParser();
    await expect(parser.push(`${report([profile, card, tail])}\n`)).rejects.toMatchObject({ code });
    expect(records).toEqual([profile, card]);
  });

  it("rejects a truncated last card, code fences and trailing prose", async () => {
    const truncated = createParser();
    await truncated.parser.push(`${report([profile])}\n${line(card).slice(0, -4)}`);
    await expect(truncated.parser.finish()).rejects.toMatchObject({ code: "invalid_json" });
    expect(truncated.records).toEqual([profile]);
    for (const input of [`${REPORT_START_MARKER}\n\x60\x60\x60json\n`, `${report([profile, card, conclusion])}\n稍后继续为你补充。\n`]) {
      await expect(createParser().parser.push(input)).rejects.toBeInstanceOf(PresentationError);
    }
  });

  it.each(["", "\n", "\r\n\t\n"])("accepts a single optional closing marker after the conclusion with trailing whitespace %j", async ending => {
    const { parser, records } = createParser();
    const input = `${report([profile, card, conclusion])}\n${REPORT_END_MARKER}${ending}`;
    for (const character of input) await parser.push(character);
    const state = await parser.finish();
    expect(state.conclusion).toEqual(conclusion);
    expect(records).toEqual([profile, card, conclusion]);
  });

  it.each([
    `${REPORT_START_MARKER}\n${REPORT_END_MARKER}\n`,
    `${report([profile, card])}\n${REPORT_END_MARKER}\n`,
    `${report([profile, card, conclusion])}\n${REPORT_END_MARKER}\n${REPORT_END_MARKER}\n`,
    `${report([profile, card, conclusion])}\n${REPORT_END_MARKER}\n${line(profile)}\n`,
    `${report([profile, card, conclusion])}\n${REPORT_END_MARKER}\n补充内容\n`,
    `${report([profile, card, conclusion])}\n${REPORT_END_MARKER} 补充内容\n`,
  ])("rejects early, repeated, non-standalone or followed closing markers", async input => {
    await expect(createParser().parser.push(input)).rejects.toBeInstanceOf(PresentationError);
  });

  it("rejects missing start/completion and accepts an explained no-result report", async () => {
    const noMarker = createParser();
    await noMarker.parser.push(line(profile));
    await expect(noMarker.parser.finish()).rejects.toMatchObject({ code: "missing_marker" });
    const unfinished = createParser();
    await unfinished.parser.push(`${report([profile, card])}\n`);
    await expect(unfinished.parser.finish()).rejects.toMatchObject({ code: "incomplete_report" });
    const noResults = createParser();
    await noResults.parser.push(report([profile, { type: "conclusion", priorities: [], note: "目前只有未知信息，缺少可靠依据，暂不推荐。", exceptions: [] }]));
    expect((await noResults.parser.finish()).cards).toEqual([]);
  });

  it("keeps previously delivered records when a later oversized line fails", async () => {
    const { parser, records } = createParser();
    await expect(parser.push(`${report([profile, card])}\n${"x".repeat(2_000_001)}`)).rejects.toMatchObject({ code: "response_too_large" });
    expect(records).toEqual([profile, card]);
  });

  it("cannot mix parser attempts or accept further data after completion", async () => {
    const first = createParser();
    await first.parser.push(`${report([profile, card])}\n`);
    await expect(first.parser.finish()).rejects.toBeInstanceOf(PresentationError);
    const retry = createParser();
    const retryCard = { ...card, key: "r2", competitionId: null };
    await retry.parser.push(report([profile, retryCard, { ...conclusion, priorities: [{ cardKey: "r2", reason: "优先核对该方向的规则。" }] }]));
    const state = await retry.parser.finish();
    expect(state.cards.map(item => item.key)).toEqual(["r2"]);
    await expect(retry.parser.push("\n")).rejects.toBeInstanceOf(PresentationError);
  });
});
