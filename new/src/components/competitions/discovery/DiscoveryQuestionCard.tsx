"use client";

import { useEffect, useRef } from "react";
import { GradientProgress } from "@/components/brand/GradientProgress";
import type { DiscoveryAnswers, DiscoveryFieldAnswer, DiscoveryFieldId } from "@/lib/competitions/discovery/contracts";
import { validateDiscoveryStep } from "@/lib/competitions/discovery/contracts";
import type { DiscoveryQuestion } from "@/lib/competitions/discovery/questionnaire";
import { DiscoveryChoices } from "./DiscoveryChoices";
import { DiscoveryMessage } from "./DiscoveryMessage";

export const discoveryPrimaryButton = "min-h-12 rounded-full bg-brand-gradient px-6 py-3 text-sm font-semibold text-white shadow-soft transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500";
export const discoverySecondaryButton = "min-h-12 rounded-full border border-brand-300 bg-white px-5 py-3 text-sm font-semibold text-brand-700 transition-colors hover:border-brand-500 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500";

export function DiscoveryQuestionCard({ question, index, total, answers, onChange, onNext, onBack }: {
  question: DiscoveryQuestion; index: number; total: number; answers: DiscoveryAnswers;
  onChange: (id: DiscoveryFieldId, answer: DiscoveryFieldAnswer) => void;
  onNext: () => void; onBack: () => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const validation = validateDiscoveryStep(question, answers);
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    title.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [question.id]);

  return <DiscoveryMessage><section className="overflow-hidden rounded-3xl border border-brand-200 bg-white shadow-soft" data-testid="discovery-question" data-question-id={question.id}>
    <div className="space-y-4 border-b border-brand-200 p-5 md:p-8">
      <div className="flex items-center justify-between gap-4"><p className="text-sm font-semibold text-brand-700">问题 {index + 1}/{total} · {question.title}</p><span className="text-xs text-muted-foreground">{Math.round((index + 1) / total * 100)}%</span></div>
      <GradientProgress label="基础问题完成进度" value={(index + 1) / total * 100} />
      <h2 className="scroll-mt-28 text-xl font-semibold leading-8 text-ink outline-none" style={{ outline: "none" }} ref={title} tabIndex={-1}>{question.title}</h2>
      <p className="text-xs leading-6 text-muted-foreground">每项都需要回答，可以选择“没有／暂不确定”，也可以自己填写。选择后点击下一步，随时可以返回修改。{question.fields.length > 1 ? `本回合有 ${question.fields.length} 项相关问题，请分别作答。` : ""}</p>
    </div>
    <div className="space-y-8 p-5 md:p-8">{question.fields.map(field => <DiscoveryChoices key={field.id} field={field} answer={answers[field.id]} onChange={answer => onChange(field.id, answer)} />)}</div>
    {!validation.valid ? <p className="px-5 pb-4 text-sm leading-6 text-brand-700 md:px-8" role="status">{validation.errors[0]}</p> : null}
    <div className="flex flex-wrap items-center gap-3 border-t border-brand-200 bg-white px-5 py-4 md:px-8">
      <button type="button" className={discoverySecondaryButton} disabled={index === 0} onClick={onBack}>上一步</button>
      <button type="button" className={`${discoveryPrimaryButton} ml-auto`} disabled={!validation.valid} onClick={onNext}>{index === total - 1 ? "核对回答" : "下一步"}</button>
    </div>
  </section></DiscoveryMessage>;
}
