"use client";

import { useDeferredValue, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DiscoveryPresentationState } from "@/lib/competitions/discovery/presentation";
import DiscoveryPresentation from "./DiscoveryPresentation";
import { DiscoveryReportContact } from "./DiscoveryReportContact";

export type DiscoveryReportSource = { url: string; title?: string };
export type DiscoveryReportDetailLink = { id: string; path: string };
const NO_DETAIL_LINKS: readonly DiscoveryReportDetailLink[] = [];
const EMPTY_PRESENTATION: DiscoveryPresentationState = { version: "discovery-cards.v1", cards: [] };

export function discoveryWebUrl(value: string): string | null {
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:") ? url.href : null; } catch { return null; }
}

/** Only server-supplied canonical catalog destinations are valid local links. */
export function discoveryReportUrl(value: string, detailLinks: readonly DiscoveryReportDetailLink[] = NO_DETAIL_LINKS): string | null {
  const match = /^\/competitions\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(value);
  if (match) return detailLinks.some(link => link.id === match[1] && link.path === value) ? value : null;
  return discoveryWebUrl(value);
}

export function discoveryReportCopy(markdown: string, sources: readonly DiscoveryReportSource[]): string {
  const links = sources.filter(source => discoveryWebUrl(source.url)).map((source, index) => `${index + 1}. ${source.title || "参考来源"}：${source.url}`);
  return links.length ? `${markdown}\n\n来源\n${links.join("\n")}` : markdown;
}

export default function DiscoveryReport({ markdown, sources, complete, statusText, pending = !complete, detailLinks = NO_DETAIL_LINKS, presentationVersion, presentation }: {
  markdown: string; sources: readonly DiscoveryReportSource[]; complete: boolean; statusText: string; pending?: boolean; detailLinks?: readonly DiscoveryReportDetailLink[];
  presentationVersion?: string; presentation?: DiscoveryPresentationState;
}) {
  const shownMarkdown = useDeferredValue(markdown);
  const [copyState, setCopyState] = useState("");
  const links = sources.filter(source => discoveryWebUrl(source.url));
  const hasPresentation = presentationVersion === "discovery-cards.v1" || presentation?.version === "discovery-cards.v1";
  async function copy() {
    try { await navigator.clipboard.writeText(discoveryReportCopy(markdown, sources)); setCopyState("已复制报告和来源。"); }
    catch { setCopyState("暂时无法复制，请选择报告文字手动复制。"); }
  }
  return <section className="space-y-6" aria-labelledby="discovery-report-heading" data-testid="discovery-report" data-complete={complete}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-brand-200 pb-5">
      <div><h2 className="font-serif text-2xl font-semibold text-ink" id="discovery-report-heading">你的选赛报告</h2><p className="mt-2 text-sm leading-6 text-muted-foreground" role="status">{statusText}</p></div>
      {markdown ? <button type="button" className="min-h-11 rounded-full border border-brand-300 bg-white px-5 text-sm font-semibold text-brand-700" onClick={() => void copy()}>复制报告与来源</button> : null}
    </div>
    {copyState ? <p className="text-sm text-brand-700" role="status">{copyState}</p> : null}
    {hasPresentation ? <DiscoveryPresentation presentation={presentation ?? EMPTY_PRESENTATION} complete={complete} pending={pending} detailLinks={detailLinks} /> : shownMarkdown ? <div className="break-words text-sm leading-8 text-ink [overflow-wrap:anywhere] [&_a]:font-medium [&_a]:text-brand-700 [&_a]:underline [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-brand-300 [&_blockquote]:pl-4 [&_h1]:mb-4 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_table]:my-4 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:p-3 [&_th]:border [&_th]:border-border [&_th]:bg-brand-50 [&_th]:p-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={value => discoveryReportUrl(value, detailLinks) ?? ""} components={{ a: ({ href, children }) => href ? href.startsWith("/competitions/") ? <Link href={href}>{children}</Link> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>, img: () => null }}>{shownMarkdown}</ReactMarkdown>
    </div> : <p className="rounded-2xl bg-brand-50 p-5 text-sm leading-7 text-brand-800">{pending ? "乐乐正在比较你的回答与竞赛资料。正文准备好后会逐步显示；你可以离开页面，稍后回来继续查看。" : "本次没有可展示的报告正文。"}</p>}
    {links.length ? <section className="border-t border-brand-200 pt-5" aria-label="报告来源"><h3 className="font-semibold text-ink">来源与核验入口</h3><ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6">{links.map(source => <li key={source.url}><a className="break-all text-brand-700 underline underline-offset-4" href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li>)}</ol></section> : null}
    {complete && markdown.trim() ? <DiscoveryReportContact /> : null}
    <p className="border-t border-brand-200 pt-4 text-xs leading-6 text-muted-foreground">内容由 AI 生成，仅供参考。参赛资格、当届安排与费用请以官方最新通知为准；本校认定需向学校核实。</p>
  </section>;
}
