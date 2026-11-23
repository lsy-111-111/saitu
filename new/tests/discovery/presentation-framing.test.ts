import { describe, expect, it } from "vitest";
import { DiscoveryJsonObjectFramer, DiscoveryPresentationParser } from "@/lib/competitions/discovery/presentation-parser";
import {
  REPORT_START_MARKER, REPORT_END_MARKER,
  type DiscoveryModelPresentationRecord,
} from "@/lib/competitions/discovery/presentation";

const profile: DiscoveryModelPresentationRecord = { type: "profile", summary: "合成画像", groups: {
  background: ["学籍待核"], goals: ["作品积累"], experience: [], constraints: ["预算待核"],
} };
const card: DiscoveryModelPresentationRecord = { type: "card", key: "r1", competitionId: null, title: "合成赛事", track: "",
  summary: "保留真实文字", details: { tasks: ["任务说明"], reasons: ["与回答关联"], value: ["可能的成果"], conditions: ["条件待核"] }, sources: [],
};
const conclusion: DiscoveryModelPresentationRecord = { type: "conclusion", priorities: [{ cardKey: "r1", reason: "优先核对" }], note: "整体待核", exceptions: [] };
const expected = [profile, card, conclusion];
const json = (value: unknown) => JSON.stringify(value);
function setup() {
  const records: DiscoveryModelPresentationRecord[] = [];
  const parser = new DiscoveryPresentationParser({ onRecord: record => { records.push(record); } });
  return { parser, records };
}

describe("incremental JSON object report framing", () => {
  it("accepts pretty-printed objects and arrays across physical lines without altering their contents", async () => {
    const { parser, records } = setup();
    await parser.push(`${REPORT_START_MARKER}\r\n${expected.map(value => JSON.stringify(value, null, 2)).join("\n\n")}`);
    expect(records).toEqual(expected);
    expect((await parser.finish()).cards).toEqual([card]);
  });

  it("emits complete adjacent objects immediately without waiting for LF or finish", async () => {
    const { parser, records } = setup();
    await parser.push(REPORT_START_MARKER + json(profile));
    expect(records).toEqual([profile]);
    const split = Math.floor(json(card).length / 2);
    await parser.push(json(card).slice(0, split));
    expect(records).toEqual([profile]);
    await parser.push(json(card).slice(split) + json(conclusion));
    expect(records).toEqual(expected);
    await parser.finish();
    expect(records).toEqual(expected);
  });

  it.each([1, 2, 7, 31])("handles arbitrary UTF-16, escape and marker cuts of %i code units", async size => {
    const { parser, records } = setup();
    const special = { ...card, summary: `符号 } ] { [、引号\"、反斜杠\\、换行\n、emoji😀与${REPORT_END_MARKER}均为原文。` };
    const input = `序言中的{"irrelevant":true}不是报告\n${REPORT_START_MARKER}${[profile, special, conclusion].map(value => JSON.stringify(value, null, 2)).join("")}\n${REPORT_END_MARKER}\t\r\n`;
    for (let index = 0; index < input.length; index += size) await parser.push(input.slice(index, index + size));
    await parser.finish();
    expect(records).toEqual([profile, special, conclusion]);
  });

  it("exposes schema-independent framing and awaits each callback before the next object", async () => {
    let release: () => void = () => { throw new Error("callback_not_started"); };
    const delivered: unknown[] = [];
    const framer = new DiscoveryJsonObjectFramer({ onObject: async value => {
      delivered.push(value);
      if (delivered.length === 1) await new Promise<void>(resolve => { release = resolve; });
    } });
    const pending = framer.push(`${REPORT_START_MARKER}{"wireOnly":[{"literal":"}"}]}{"other":true}`);
    await Promise.resolve();
    expect(delivered).toEqual([{ wireOnly: [{ literal: "}" }] }]);
    release();
    await pending;
    expect(delivered).toEqual([{ wireOnly: [{ literal: "}" }] }, { other: true }]);
    await framer.finish();
  });

  it("keeps the strict schema and prior records when a complete object has the wrong field shape", async () => {
    const { parser, records } = setup();
    const malformed = { ...card, details: { ...card.details, reasons: "不转换成数组" } };
    await expect(parser.push(REPORT_START_MARKER + json(profile) + JSON.stringify(malformed, null, 2))).rejects.toMatchObject({
      code: "invalid_record", schemaIssues: [{ code: "invalid_type", path: ["details", "reasons"] }],
    });
    expect(records).toEqual([profile]);
  });

  it("never publishes early source fields or silently drops unknown source properties", async () => {
    const { parser, records } = setup();
    const malformed = { ...card, sources: [{ url: "https://example.org/rules", title: "规则资料", publisherNote: "不静默丢弃" }] };
    const text = json(malformed);
    await parser.push(REPORT_START_MARKER + json(profile) + text.slice(0, -1));
    expect(records).toEqual([profile]);
    await expect(parser.push(text.slice(-1))).rejects.toMatchObject({ code: "invalid_record",
      schemaIssues: [{ code: "unrecognized_keys", path: ["sources", 0] }],
    });
    expect(records).toEqual([profile]);
  });

  it.each([
    '{"type":"card",}',
    '{"type":"card" "key":"r1"}',
    '{"type":"card","sources":[}',
    '{"type":"card","summary":"真实\n未转义换行"}',
    '{"type":"card","summary":"unescaped" quote"}',
    '```json\n{"type":"card"}\n```',
    '// commentary\n{"type":"card"}',
  ])("rejects malformed JSON instead of repairing %j", async malformed => {
    const { parser, records } = setup();
    const consume = async () => { await parser.push(REPORT_START_MARKER + json(profile) + malformed); await parser.finish(); };
    await expect(consume()).rejects.toMatchObject({ code: "invalid_json" });
    expect(records).toEqual([profile]);
  });

  it.each(['{"type":"card","details":{', '{"type":"card","summary":"unfinished\\', '{"type":"card","sources":['])(
    "does not emit a truncated object %j", async incomplete => {
      const { parser, records } = setup();
      await parser.push(REPORT_START_MARKER + json(profile) + incomplete);
      expect(records).toEqual([profile]);
      await expect(parser.finish()).rejects.toMatchObject({ code: "invalid_json" });
    },
  );

  it("requires completion even when a valid profile and card have already been emitted", async () => {
    const { parser, records } = setup();
    await parser.push(REPORT_START_MARKER + json(profile) + json(card));
    expect(records).toEqual([profile, card]);
    await expect(parser.finish()).rejects.toMatchObject({ code: "incomplete_report" });
  });

  it.each(["", "\n", "\r\n\t "])("accepts one optional closing marker after the complete conclusion with %j", async ending => {
    const { parser, records } = setup();
    await parser.push(REPORT_START_MARKER + expected.map(json).join("") + REPORT_END_MARKER.slice(0, 7));
    expect(records).toEqual(expected);
    await parser.push(REPORT_END_MARKER.slice(7) + ending);
    expect((await parser.finish()).conclusion).toEqual(conclusion);
  });

  it.each([REPORT_END_MARKER, "trailing text", json(profile)])("rejects data after the closing marker: %j", async tail => {
    const { parser } = setup();
    await expect(parser.push(REPORT_START_MARKER + expected.map(json).join("") + REPORT_END_MARKER + tail)).rejects.toMatchObject({ code: "invalid_sequence" });
  });

  it("rejects an early or truncated closing marker", async () => {
    await expect(setup().parser.push(REPORT_START_MARKER + json(profile) + REPORT_END_MARKER)).rejects.toMatchObject({ code: "invalid_sequence" });
    const { parser } = setup();
    await parser.push(REPORT_START_MARKER + expected.map(json).join("") + REPORT_END_MARKER.slice(0, -1));
    await expect(parser.finish()).rejects.toMatchObject({ code: "invalid_json" });
  });

  it("honors a caller's closing-marker guard without applying the public record schema", async () => {
    let ended = false;
    const framer = new DiscoveryJsonObjectFramer({ canEnd: () => ended, onObject: () => { ended = true; } });
    await framer.push(REPORT_START_MARKER + '{"privateWire":true}' + REPORT_END_MARKER);
    await framer.finish();
    await expect(new DiscoveryJsonObjectFramer({ canEnd: () => false, onObject: () => undefined }).push(REPORT_START_MARKER + REPORT_END_MARKER)).rejects.toMatchObject({ code: "invalid_sequence" });
  });

  it("retains the size bound for an unfinished object while allowing many smaller objects in one chunk", async () => {
    const framer = new DiscoveryJsonObjectFramer({ onObject: () => undefined });
    await expect(framer.push(REPORT_START_MARKER + '{"text":"' + "x".repeat(2_000_001))).rejects.toMatchObject({ code: "response_too_large" });
    let count = 0;
    const many = new DiscoveryJsonObjectFramer({ onObject: () => { count += 1; } });
    await many.push(REPORT_START_MARKER + json({ text: "x".repeat(10_000) }).repeat(201));
    await many.finish();
    expect(count).toBe(201);
  });
});
