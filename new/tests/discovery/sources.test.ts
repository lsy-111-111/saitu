import { describe, expect, it } from "vitest";
import { extractDiscoveryMarkdownSources } from "@/lib/competitions/discovery/sources";
import { presentationRecordMarkdown, type DiscoveryCardRecord } from "@/lib/competitions/discovery/presentation";

const url = "https://example.org/rules_(2026)?group=A&track=1";
function projectedSource(title: string) {
  const card: DiscoveryCardRecord = { type: "card", key: "one", competitionId: null, title: "合成竞赛", track: "方向",
    summary: "真实任务关联", details: { tasks: ["任务"], reasons: ["依据"], value: ["价值"], conditions: ["待核"] }, sources: [{ url, title }] };
  return presentationRecordMarkdown(card);
}

describe("Markdown source label projection", () => {
  it("roundtrips projected dates, escaped brackets, every ASCII punctuation and literal backslashes", () => {
    const punctuation = Array.from({ length: 94 }, (_, i) => String.fromCharCode(i + 33)).filter(char => /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/u.test(char)).join("");
    const title = String.raw`核验来源 [2026-11-20] ${punctuation} 保留\q和\中及路径\目录`;
    expect(extractDiscoveryMarkdownSources(projectedSource(title))).toEqual([{ url, title }]);
  });

  it("unescapes punctuation once while retaining non-punctuation escape meaning", () => {
    const markdown = String.raw`[规则 \[A\]：2026\-11\-20，保留\q与\中和\\路径](https://example.org/rules)`;
    expect(extractDiscoveryMarkdownSources(markdown)).toEqual([
      { url: "https://example.org/rules", title: String.raw`规则 [A]：2026-11-20，保留\q与\中和\路径` },
    ]);
  });

  it("keeps image and code destinations excluded when labels contain escaped brackets", () => {
    const markdown = [
      String.raw`![海报 \[A\]](https://example.org/image.png)`,
      String.raw`![](<https://example.org/empty-image.png>)`,
      "`[代码 \\[A\\]](https://example.org/inline-code)`",
      "```md\n[代码 \\[A\\]](https://example.org/fenced-code)\n```",
      String.raw`[公开 \[A\]](https://example.org/public)`,
    ].join("\n");
    expect(extractDiscoveryMarkdownSources(markdown)).toEqual([{ url: "https://example.org/public", title: "公开 [A]" }]);
  });
});
