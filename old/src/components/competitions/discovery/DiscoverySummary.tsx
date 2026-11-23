"use client";

import Link from "next/link";
import type { DiscoveryAnswers } from "@/lib/competitions/discovery/contracts";
import { DISCOVERY_CONSENT_DISCLOSURE } from "@/lib/competitions/discovery/disclosure";
import { DISCOVERY_QUESTIONS, formatDiscoveryAnswer } from "@/lib/competitions/discovery/questionnaire";
import { containsCompetitionNotePersonalInfo } from "@/lib/ai/competition-note";
import { DiscoveryMessage } from "./DiscoveryMessage";
import { discoveryPrimaryButton } from "./DiscoveryQuestionCard";

export function DiscoverySummary({ answers, additionalText, consentAccepted, busy, error, onEdit, onRemoveLegacyText, onConsent, onSubmit }: {
  answers: DiscoveryAnswers; additionalText: string; consentAccepted: boolean; busy: boolean; error: string;
  onEdit: (index: number) => void; onRemoveLegacyText: () => void; onConsent: (value: boolean) => void; onSubmit: () => void;
}) {
  const privateText = [additionalText, ...Object.values(answers).map(answer => answer.text ?? "")].some(text => Boolean(text.trim()) && containsCompetitionNotePersonalInfo(text));
  return <DiscoveryMessage><section className="space-y-6 rounded-3xl border border-brand-200 bg-white p-5 shadow-soft md:p-8" aria-labelledby="discovery-review-heading" data-testid="discovery-summary">
    <div><h2 id="discovery-review-heading" className="font-serif text-2xl font-semibold text-ink">先核对，再请乐乐推荐</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">确认这些回答反映你的实际情况。可以点击各回合的“修改”继续调整；你的自述用于推荐，并不代表能力已被客观测评。确认后直接生成报告。</p></div>
    <ol className="divide-y divide-brand-100">
      {DISCOVERY_QUESTIONS.map((question, index) => <li className="py-4 first:pt-0" key={question.id}>
        <div className="flex items-start justify-between gap-3"><h3 className="font-semibold text-ink">{index + 1}. {question.title}</h3><button type="button" className="min-h-11 shrink-0 px-2 text-sm font-semibold text-brand-700 underline" disabled={busy} onClick={() => onEdit(index)} aria-label={`修改${question.title}`}>修改</button></div>
        <dl className="space-y-2 text-sm leading-6">{question.fields.map(field => <div key={field.id}><dt className="text-muted-foreground">{field.label}</dt><dd className="mt-1 text-ink">{formatDiscoveryAnswer(field, answers[field.id])}</dd></div>)}</dl>
      </li>)}
    </ol>
    {additionalText ? <div className="space-y-2 rounded-2xl border border-brand-200 bg-brand-50/40 p-4">
      <h3 className="font-semibold text-ink">上次草稿保留的整体说明</h3>
      <p className="whitespace-pre-wrap break-words text-sm leading-7 text-ink">{additionalText}</p>
      <p className="text-xs leading-6 text-muted-foreground">这段旧说明会一并用于推荐。需要更新时，请删除后填写到对应问题。</p>
      <button type="button" disabled={busy} onClick={onRemoveLegacyText} className="min-h-11 text-sm font-semibold text-brand-700 underline">删除这段历史说明</button>
    </div> : null}
    {privateText ? <p className="text-sm text-error-700" role="alert">请先修改对应回答，删除姓名、学校、联系方式等与推荐无关的个人信息。</p> : null}
    <div className="space-y-4 rounded-2xl border border-brand-200 bg-brand-50/60 p-4 md:p-5">
      <h3 className="font-semibold text-brand-800">{DISCOVERY_CONSENT_DISCLOSURE.heading}</h3>
      <p className="text-sm leading-7 text-ink/80">{DISCOVERY_CONSENT_DISCLOSURE.body}</p>
      <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl bg-white p-3 text-sm font-semibold leading-7 text-brand-800"><input className="mt-2" type="checkbox" disabled={busy} checked={consentAccepted} onChange={event => onConsent(event.target.checked)} /><span>我已阅读并单独同意以上 AI 使用说明与<Link className="underline" href="/privacy" target="_blank" rel="noopener noreferrer">隐私政策</Link></span></label>
    </div>
    {error ? <p role="alert" className="rounded-xl bg-error-50 p-4 text-sm leading-6 text-error-700">{error}</p> : null}
    <div className="flex justify-end"><button className={discoveryPrimaryButton} type="button" disabled={busy || !consentAccepted || privateText} onClick={onSubmit}>{busy ? "正在提交…" : "同意，请乐乐开始选赛"}</button></div>
  </section></DiscoveryMessage>;
}
