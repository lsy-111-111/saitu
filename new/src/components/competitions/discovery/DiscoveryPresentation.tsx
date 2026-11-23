"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { DiscoveryCardRecord, DiscoveryPresentationState } from "@/lib/competitions/discovery/presentation";
import { safeDiscoverySourceUrl } from "@/lib/competitions/discovery/sources";

type DetailLink = { id: string; path: string };
type Source = { url: string; title: string };
const PROFILE_GROUPS = [
  ["background", "背景"],
  ["goals", "目标"],
  ["experience", "已有经历与能力"],
  ["constraints", "条件与约束"],
] as const;

function SourceLinks({ sources, label = "依据与核验来源" }: { sources: readonly Source[]; label?: string }) {
  const usable = sources.filter(source => safeDiscoverySourceUrl(source.url));
  if (!usable.length) return null;
  return <section className="space-y-2" aria-label={label}>
    <h5 className="text-sm font-semibold text-ink">{label}</h5>
    <ul className="space-y-2 text-sm leading-6">{usable.map(source => <li key={source.url}><a href={safeDiscoverySourceUrl(source.url)!} target="_blank" rel="noopener noreferrer" className="break-words text-brand-700 underline underline-offset-4 [overflow-wrap:anywhere]">{source.title || source.url}</a></li>)}</ul>
  </section>;
}

function DetailList({ title, items }: { title: string; items: readonly string[] }) {
  if (!items.length) return null;
  return <section>
    <h4 className="font-semibold text-ink">{title}</h4>
    <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-7 text-ink">{items.map((item, index) => <li key={index} className="whitespace-pre-line break-words [overflow-wrap:anywhere]">{item}</li>)}</ul>
  </section>;
}

/** The complete card and its frozen catalog facts are already in memory. */
export function DiscoveryCardDetail({ card, detailLinks, onClose }: { card: DiscoveryCardRecord; detailLinks: readonly DetailLink[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const detail = card.catalogDetail;
  const detailPath = card.competitionId && detail?.id === card.competitionId
    ? detailLinks.find(link => link.id === card.competitionId && link.path === detail.detailPath && link.path === `/competitions/${card.competitionId}`)?.path
    : undefined;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={dialogRef} id="discovery-card-dialog" aria-labelledby="discovery-card-dialog-title" className="fixed inset-0 m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-[26px] border border-brand-200 bg-white p-0 text-ink shadow-lift backdrop:bg-ink/55 backdrop:backdrop-blur-sm md:m-auto md:max-h-[90dvh] md:w-[calc(100%_-_2.5rem)] md:max-w-[55rem] md:rounded-3xl"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      const activeIndex = focusable.findIndex(element => element === document.activeElement);
      if (!focusable.length) { event.preventDefault(); return; }
      if (event.shiftKey && activeIndex <= 0) { event.preventDefault(); focusable[focusable.length - 1].focus(); }
      else if (!event.shiftKey && (activeIndex < 0 || activeIndex === focusable.length - 1)) { event.preventDefault(); focusable[0].focus(); }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div className="flex max-h-[92dvh] flex-col md:max-h-[90dvh]">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-brand-200 bg-brand-50/60 px-5 py-4 md:px-8">
        <div className="min-w-0"><p className="text-xs font-semibold text-brand-700">推荐详情</p><h3 id="discovery-card-dialog-title" className="mt-1 break-words font-serif text-xl font-semibold leading-8 md:text-2xl">{card.title}</h3></div>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭推荐详情" className="min-h-11 shrink-0 rounded-full border border-brand-200 bg-white px-4 text-sm font-semibold text-brand-700 hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">关闭</button>
      </header>
      <div className="conversation-scrollbar min-h-0 space-y-7 overflow-y-auto px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 md:px-8 md:pt-7">
        <section aria-labelledby="discovery-personal-detail-heading" className="space-y-5">
          <div><h4 id="discovery-personal-detail-heading" className="text-lg font-semibold text-ink">本次个性化说明</h4><p className="mt-2 whitespace-pre-line text-sm leading-7 text-ink">{card.summary}</p>{card.track ? <p className="mt-2 text-sm leading-7 text-brand-800">建议赛道或任务：{card.track}</p> : null}{card.timing ? <p className="mt-2 whitespace-pre-line text-sm leading-7 text-muted-foreground">{card.timing}</p> : null}</div>
          <DetailList title="为什么与你有关" items={card.details.reasons} />
          <DetailList title="可以做什么" items={card.details.tasks} />
          <DetailList title="价值与可能成果" items={card.details.value} />
          <DetailList title="资格、缺口与待核事项" items={card.details.conditions} />
          <SourceLinks sources={card.sources} />
        </section>
        {detailPath ? <div className="border-t border-brand-200 pt-5"><Link href={detailPath} className="inline-flex min-h-11 items-center rounded-full border border-brand-300 bg-brand-50 px-5 py-2.5 text-sm font-semibold text-brand-700 hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">打开站内赛事详情<span aria-hidden="true" className="ml-2">↗</span></Link></div> : null}
        {detail ? <section aria-labelledby="discovery-catalog-detail-heading" className="space-y-5 border-t border-brand-200 pt-6">
          <div><h4 id="discovery-catalog-detail-heading" className="text-lg font-semibold text-ink">本次使用的站内资料</h4><p className="mt-2 text-xs leading-6 text-muted-foreground">以下保留本次匹配使用的资料及其届次、赛道和来源范围。历史安排或待核信息不代表当前可以报名。</p></div>
          {detail.sections.map((section, index) => <section key={index} className="space-y-2"><h5 className="font-semibold text-ink">{section.heading}</h5>{section.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex} className="whitespace-pre-line break-words text-sm leading-7 [overflow-wrap:anywhere]">{paragraph}</p>)}{section.sources?.length ? <SourceLinks sources={section.sources} label={`${section.heading}的核验来源`} /> : null}</section>)}
          <SourceLinks sources={detail.sources} label="站内资料核验来源" />
        </section> : null}
      </div>
    </div>
  </dialog>;
}

const RecommendationCard = memo(function RecommendationCard({ card, index, onOpen }: { card: DiscoveryCardRecord; index: number; onOpen: (key: string) => void }) {
  return <li data-testid="discovery-card" data-card-key={card.key} className="min-w-0">
    <button type="button" onClick={() => onOpen(card.key)} aria-haspopup="dialog" aria-controls="discovery-card-dialog" className="group flex h-full w-full flex-col rounded-2xl border border-brand-200 bg-white p-5 text-left shadow-soft transition-colors hover:border-brand-400 hover:bg-brand-50/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600 md:p-6">
      <span className="text-xs font-semibold tracking-[0.12em] text-brand-600">推荐 {String(index + 1).padStart(2, "0")}</span>
      <span role="heading" aria-level={3} className="mt-3 break-words font-serif text-xl font-semibold leading-8 text-ink">{card.title}</span>
      {card.track ? <span className="mt-2 break-words text-sm font-semibold leading-6 text-brand-700">{card.track}</span> : null}
      <span className="mt-3 whitespace-pre-line break-words text-sm leading-7 text-ink">{card.summary}</span>
      {card.timing ? <span className="mt-4 whitespace-pre-line rounded-xl bg-brand-50 px-3 py-2 text-xs leading-6 text-brand-800">{card.timing}</span> : null}
      <span className="mt-auto flex w-full items-center justify-between gap-3 pt-5 text-sm font-semibold text-brand-700"><span>查看推荐详情</span><span aria-hidden="true" className="text-lg transition-transform group-hover:translate-x-1 motion-reduce:transform-none">→</span></span>
    </button>
  </li>;
});

export default function DiscoveryPresentation({ presentation, complete, pending, detailLinks }: { presentation: DiscoveryPresentationState; complete: boolean; pending: boolean; detailLinks: readonly DetailLink[] }) {
  const [openCardKey, setOpenCardKey] = useState<string | null>(null);
  const recommendationsHeading = useRef<HTMLHeadingElement>(null);
  const onOpen = useCallback((key: string) => setOpenCardKey(key), []);
  const onClose = useCallback(() => setOpenCardKey(null), []);
  const openCard = openCardKey ? presentation.cards.find(card => card.key === openCardKey) : undefined;
  const { profile, cards, conclusion } = presentation;

  return <div data-testid="discovery-presentation" data-presentation-version={presentation.version}>
    <div className="space-y-7">
    {profile ? <section aria-labelledby="discovery-profile-heading" data-testid="discovery-profile" className="rounded-2xl border border-brand-200 bg-brand-50/60 p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2"><div><p className="text-xs font-semibold tracking-[0.12em] text-brand-700">从你的回答出发</p><h3 id="discovery-profile-heading" className="mt-2 font-serif text-xl font-semibold text-ink">你的用户画像</h3></div>{cards.length ? <a href="#discovery-recommendations-heading" onClick={() => recommendationsHeading.current?.focus({ preventScroll: true })} className="inline-flex min-h-11 items-center rounded-full border border-brand-200 bg-white px-4 py-2 text-sm font-semibold text-brand-700 underline underline-offset-4 hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">查看推荐竞赛<span aria-hidden="true" className="ml-2">↓</span></a> : null}</div>
      <p className="mt-3 whitespace-pre-line break-words text-sm leading-8 text-ink">{profile.summary}</p>
      <dl className="mt-5 grid gap-4 sm:grid-cols-2">{PROFILE_GROUPS.map(([key, label]) => <div key={key} className="rounded-xl border border-brand-100 bg-white/80 p-4"><dt className="text-xs font-semibold text-brand-700">{label}</dt><dd className="mt-2 flex flex-wrap gap-2">{profile.groups[key].length ? profile.groups[key].map((item, index) => <span key={index} className="max-w-full whitespace-pre-line break-words rounded-lg bg-brand-50 px-2.5 py-1 text-sm leading-6 text-ink [overflow-wrap:anywhere]">{item}</span>) : <span className="text-sm leading-6 text-muted-foreground">暂未确认</span>}</dd></div>)}</dl>
    </section> : <p className="rounded-2xl bg-brand-50 p-5 text-sm leading-7 text-brand-800">{pending ? "乐乐正在比较你的回答与竞赛资料。画像准备好后会先显示，推荐卡片随后逐张出现；你可以离开页面，稍后回来继续查看。" : "本次尚未生成完整画像。"}</p>}
    {cards.length ? <section aria-labelledby="discovery-recommendations-heading"><div className="mb-4 flex flex-wrap items-baseline justify-between gap-2"><h3 ref={recommendationsHeading} id="discovery-recommendations-heading" tabIndex={-1} className="scroll-mt-28 rounded font-serif text-xl font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600">为你推荐的竞赛</h3><p className="text-xs leading-6 text-muted-foreground">点击卡片查看完整说明与赛事资料</p></div><ol className="grid items-stretch gap-4 md:grid-cols-2">{cards.map((card, index) => <RecommendationCard key={card.key} card={card} index={index} onOpen={onOpen} />)}</ol></section> : profile ? <p className="rounded-2xl border border-brand-100 bg-brand-50/50 p-5 text-sm leading-7 text-brand-800">{pending ? "正在整理与你相关的竞赛，完整一项后就会显示。" : complete ? "本次没有可靠推荐，具体原因见下方说明。" : "本次尚未生成完整推荐卡片。"}</p> : null}
    {!complete && cards.length ? <p role="status" className={`rounded-xl p-4 text-sm leading-7 ${pending ? "bg-brand-50 text-brand-800" : "border border-warning-200 bg-warning-50 text-ink"}`}>{pending ? `已显示 ${cards.length} 项完整推荐，其余内容仍在生成。` : "已保留上方完整卡片，但本次报告未完整生成，请结合未完成状态查看。"}</p> : null}
    {conclusion ? <section aria-labelledby="discovery-conclusion-heading" className="space-y-4 rounded-2xl border border-brand-200 bg-white p-5 md:p-6"><h3 id="discovery-conclusion-heading" className="font-serif text-xl font-semibold text-ink">优先建议与说明</h3>{conclusion.priorities.length ? <ul className="space-y-4">{conclusion.priorities.map((priority, index) => {
      const card = cards.find(item => item.key === priority.cardKey);
      return <li key={index} className="text-sm leading-7">{card ? <button type="button" className="min-h-11 py-2 text-left font-semibold text-brand-700 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600" onClick={() => onOpen(card.key)} aria-haspopup="dialog" aria-controls="discovery-card-dialog">{card.title}</button> : null}<p className="whitespace-pre-line break-words text-ink">{priority.reason}</p></li>;
    })}</ul> : null}{conclusion.note ? <p className="whitespace-pre-line break-words text-sm leading-7 text-ink">{conclusion.note}</p> : null}{conclusion.exceptions.length ? <section className="border-t border-brand-100 pt-4"><h4 className="text-sm font-semibold text-ink">未列入正式推荐的方向</h4><ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-7 text-muted-foreground">{conclusion.exceptions.map((item, index) => <li key={index} className="whitespace-pre-line break-words">{item}</li>)}</ul></section> : null}</section> : null}
    </div>
    {openCard ? <DiscoveryCardDetail key={openCard.key} card={openCard} detailLinks={detailLinks} onClose={onClose} /> : null}
  </div>;
}
