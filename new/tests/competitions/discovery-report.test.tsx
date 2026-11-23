import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import DiscoveryReport, { discoveryReportCopy, discoveryReportUrl, discoveryWebUrl } from "@/components/competitions/discovery/DiscoveryReport";
import { DiscoveryCardDetail } from "@/components/competitions/discovery/DiscoveryPresentation";
import { presentationRecordMarkdown, type DiscoveryCardRecord, type DiscoveryPresentationState } from "@/lib/competitions/discovery/presentation";
import { extractDiscoveryMarkdownSources } from "@/lib/competitions/discovery/sources";

const card: DiscoveryCardRecord = {
  type: "card", key: "recommendation-1", competitionId: "icpc-programming", title: "国际大学生程序设计竞赛", track: "算法与程序实现",
  summary: "你做过可运行的软件功能，也希望通过实际任务积累项目经验。", timing: "可提前准备；当届资格与赛区安排待核。",
  details: { tasks: ["尝试一道算法题并说明实现思路。"], reasons: ["依据你回答中已完成的软件任务与项目积累目标。"], value: ["形成问题分析和代码实现的成果。"], conditions: ["稳定队伍不证明人数、同校和学段符合，须核对当届条件。"] },
  sources: [{ url: "https://example.com/current-rules", title: "本次说明依据" }],
  catalogDetail: { version: "catalog-frozen-v1", id: "icpc-programming", title: "国际大学生程序设计竞赛", detailPath: "/competitions/icpc-programming", sections: [{ heading: "历史届次与资格", paragraphs: ["历史资料：2025届；当前报名状态未知。", "仅本赛道要求全日制；保留原有例外范围。"], sources: [{ url: "https://example.com/2025-rules", title: "2025届规则" }] }], sources: [{ url: "https://example.com/catalog-source", title: "目录核验来源" }] },
};
const presentation: DiscoveryPresentationState = {
  version: "discovery-cards.v1",
  profile: { type: "profile", summary: "你希望从真实做过的软件任务出发，选择能够形成成果的竞赛；具体资格和资源仍按已知信息判断。", groups: { background: ["本科在读"], goals: ["积累项目经验"], experience: ["做过可运行的软件功能"], constraints: [] } },
  cards: [card],
  conclusion: { type: "conclusion", priorities: [{ cardKey: "recommendation-1", reason: "先了解任务与当届资格，再决定投入。" }], note: "只推荐有依据的方向，不以数量补齐。", exceptions: ["已知必须线下参加的其他方向未列入正式推荐。"] },
};
const detailLinks = [{ id: "icpc-programming", path: "/competitions/icpc-programming" }];

describe("discovery markdown report", () => {
  beforeAll(() => vi.stubGlobal("React", React));
  afterAll(() => vi.unstubAllGlobals());

  it("renders headings and source links while removing raw HTML and unsafe destinations", () => {
    const html = renderToStaticMarkup(<DiscoveryReport markdown={'## 推荐\n\n[官方](https://example.com/rules) [危险](javascript:alert(1))\n\n<script>alert(1)</script>'} sources={[{ url: "https://example.com/rules", title: "当届通知" }]} complete statusText="已完成" />);
    expect(html).toContain("<h2>推荐</h2>");
    expect(html).toContain('href="https://example.com/rules"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('data-complete="true"');
  });

  it("copies the report together with usable sources and rejects links containing credentials", () => {
    expect(discoveryWebUrl("https://user:password@example.com/rules")).toBeNull();
    expect(discoveryWebUrl("file:///private/path")).toBeNull();
    expect(discoveryReportCopy("报告正文", [{ url: "https://example.com/rules", title: "官方通知" }, { url: "javascript:alert(1)", title: "危险" }])).toBe("报告正文\n\n来源\n1. 官方通知：https://example.com/rules");
  });

  it("shows and copies projected source titles without Markdown escapes while preserving literal backslashes", () => {
    const source = { url: "https://example.com/roundtrip-rules", title: String.raw`核验来源 [资格]：2026-11-20，保留\q与\中` };
    const markdown = presentationRecordMarkdown({ ...card, sources: [source] });
    const sources = extractDiscoveryMarkdownSources(markdown);
    expect(sources.find(item => item.url === source.url)).toEqual(source);
    const html = renderToStaticMarkup(<DiscoveryReport markdown={markdown} sources={sources} complete statusText="已完成" presentationVersion="discovery-cards.v1" presentation={presentation} />);
    expect(html).toContain(source.title);
    expect(html).not.toContain(String.raw`2026\-11\-20`);
    expect(discoveryReportCopy(markdown, sources)).toContain(`${source.title}：${source.url}`);
  });

  it("does not claim work is still running when a failed or cancelled report has no text", () => {
    const html = renderToStaticMarkup(<DiscoveryReport markdown="" sources={[]} complete={false} pending={false} statusText="已停止生成。" />);
    expect(html).toContain("已停止生成。");
    expect(html).toContain("本次没有可展示的报告正文。");
    expect(html).not.toContain("乐乐正在比较");
    expect(html).not.toContain("正文准备好后会逐步显示");
  });

  it("allows canonical catalog details and rejects invented or modified local destinations", () => {
    const detailLinks = [{ id: "icpc-programming", path: "/competitions/icpc-programming" }];
    expect(discoveryReportUrl("/competitions/icpc-programming", detailLinks)).toBe("/competitions/icpc-programming");
    for (const value of ["/competitions/invented", "/competitions/icpc-programming?redirect=https://example.com", "/competitions/icpc-programming/../../private", "//example.com/competitions/icpc-programming", "/teams"]) {
      expect(discoveryReportUrl(value, detailLinks)).toBeNull();
    }
    const html = renderToStaticMarkup(<DiscoveryReport markdown="[查看赛事详情](/competitions/icpc-programming) [无效详情](/competitions/invented)" sources={[]} complete statusText="已完成" detailLinks={detailLinks} />);
    expect(html).toContain('href="/competitions/icpc-programming"');
    expect(html).not.toContain('href="/competitions/invented"');
  });

  it("adds contact and a single unfiltered teams entrance only after a completed report", () => {
    const completed = renderToStaticMarkup(<DiscoveryReport markdown="推荐正文" sources={[]} complete statusText="已完成" />);
    expect(completed).toContain("想了解更多竞赛信息？");
    expect(completed).toContain('aria-haspopup="dialog"');
    expect(completed).toContain('id="discovery-emily-dialog"');
    expect(completed).toContain('href="/community/emily.png"');
    expect(completed).toContain('href="/teams"');
    expect(completed).not.toMatch(/href="\/teams[?#]/);
    const pending = renderToStaticMarkup(<DiscoveryReport markdown="生成中" sources={[]} complete={false} statusText="生成中" />);
    expect(pending).not.toContain("想了解更多竞赛信息？");
  });

  it("renders the AI profile and complete cards without showing a second Markdown report", () => {
    const html = renderToStaticMarkup(<DiscoveryReport markdown="只用于复制的报告正文" sources={[]} complete statusText="已完成" presentationVersion="discovery-cards.v1" presentation={presentation} detailLinks={detailLinks} />);
    expect(html).toContain('data-testid="discovery-profile"');
    expect(html).toContain("你的用户画像");
    expect(html).toContain("本科在读");
    expect(html).toContain("已有经历与能力");
    expect(html).toContain("暂未确认");
    expect(html).toContain('data-testid="discovery-card"');
    expect(html).toContain("查看推荐详情");
    expect(html).toContain('href="#discovery-recommendations-heading"');
    expect(html).toMatch(/id="discovery-recommendations-heading"[^>]*tabindex="-1"/);
    expect(html).toContain("算法与程序实现");
    expect(html).toContain("先了解任务与当届资格，再决定投入。");
    expect(html).toContain("未列入正式推荐的方向");
    expect(html).not.toContain("只用于复制的报告正文");
    expect(html).not.toContain("尝试一道算法题并说明实现思路。");
    expect(html).not.toContain("2025届规则");
  });

  it("keeps validated cards visible and marks them unfinished after a failure", () => {
    const partial = { ...presentation, conclusion: undefined };
    const html = renderToStaticMarkup(<DiscoveryReport markdown="已完成的一项说明" sources={[]} complete={false} pending={false} statusText="上游连接中断" presentationVersion="discovery-cards.v1" presentation={partial} />);
    expect(html).toContain("国际大学生程序设计竞赛");
    expect(html).toContain("本次报告未完整生成");
    expect(html).not.toContain("其余内容仍在生成");
    expect(html).not.toContain("想了解更多竞赛信息？");
  });

  it("distinguishes waiting for the profile, waiting for cards, and a valid zero-recommendation result", () => {
    const waiting = renderToStaticMarkup(<DiscoveryReport markdown="" sources={[]} complete={false} pending statusText="生成中" presentationVersion="discovery-cards.v1" />);
    expect(waiting).toContain("画像准备好后会先显示");
    const profileOnly = renderToStaticMarkup(<DiscoveryReport markdown="用户画像" sources={[]} complete={false} pending statusText="生成中" presentationVersion="discovery-cards.v1" presentation={{ ...presentation, cards: [], conclusion: undefined }} />);
    expect(profileOnly).toContain("完整一项后就会显示");
    expect(profileOnly).not.toContain('href="#discovery-recommendations-heading"');
    const empty = renderToStaticMarkup(<DiscoveryReport markdown="没有可靠推荐的完整说明" sources={[]} complete statusText="已完成" presentationVersion="discovery-cards.v1" presentation={{ ...presentation, cards: [], conclusion: { type: "conclusion", priorities: [], note: "目前均为未知，缺少可靠匹配依据；未知不等于没有经历。", exceptions: [] } }} />);
    expect(empty).toContain("本次没有可靠推荐");
    expect(empty).toContain("未知不等于没有经历");
    expect(empty).not.toContain('data-testid="discovery-card"');
  });

  it("opens complete personal details together with frozen catalog facts and the canonical destination", () => {
    const html = renderToStaticMarkup(<DiscoveryCardDetail card={card} detailLinks={detailLinks} onClose={vi.fn()} />);
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-labelledby="discovery-card-dialog-title"');
    expect(html).toContain("本次个性化说明");
    expect(html).toContain("尝试一道算法题并说明实现思路。");
    expect(html).toContain("稳定队伍不证明人数、同校和学段符合");
    expect(html).toContain("本次使用的站内资料");
    expect(html).toContain("历史资料：2025届；当前报名状态未知。");
    expect(html).toContain("仅本赛道要求全日制；保留原有例外范围。");
    expect(html).toContain('href="/competitions/icpc-programming"');
    expect(html.indexOf("打开站内赛事详情")).toBeLessThan(html.indexOf('id="discovery-catalog-detail-heading"'));
    expect(html).toContain('href="https://example.com/2025-rules"');
    expect(html).not.toContain("报名入口");
  });

  it("escapes supplied text and never guesses local, official, or registration links", () => {
    const unsafe = { ...card, competitionId: null, title: '<script>alert("unsafe")</script>', sources: [{ url: "javascript:alert(1)", title: "危险" }, { url: "https://user:pass@example.com/private", title: "带凭据" }, { url: "https://example.com/source", title: "来源通知" }], catalogDetail: undefined };
    const html = renderToStaticMarkup(<DiscoveryCardDetail card={unsafe} detailLinks={detailLinks} onClose={vi.fn()} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("user:pass");
    expect(html).toContain('href="https://example.com/source"');
    expect(html).not.toContain('href="/competitions/');
    expect(html).not.toContain("报名入口");
    expect(html).not.toContain("官网");
    const unapproved = renderToStaticMarkup(<DiscoveryCardDetail card={card} detailLinks={[]} onClose={vi.fn()} />);
    expect(unapproved).not.toContain('href="/competitions/');
  });
});
