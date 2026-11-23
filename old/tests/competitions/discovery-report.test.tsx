import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import DiscoveryReport, { discoveryReportCopy, discoveryReportUrl, discoveryWebUrl } from "@/components/competitions/discovery/DiscoveryReport";

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
});
