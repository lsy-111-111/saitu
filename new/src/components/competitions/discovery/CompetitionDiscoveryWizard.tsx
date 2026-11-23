"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { OrbitBackdrop } from "@/components/brand/OrbitBackdrop";
import { validateDiscoveryStep } from "@/lib/competitions/discovery/contracts";
import { DISCOVERY_QUESTIONS } from "@/lib/competitions/discovery/questionnaire";
import { discoveryRunEnded } from "./discovery-client-state";
import { discoveryFailurePresentation } from "./discovery-failure";
import { discoveryRetryStatus } from "./discovery-retry-status";
import { DiscoveryMessage } from "./DiscoveryMessage";
import { DiscoveryQuestionCard, discoveryPrimaryButton, discoverySecondaryButton } from "./DiscoveryQuestionCard";
import { DiscoverySummary } from "./DiscoverySummary";
import { useCompetitionDiscovery } from "./useCompetitionDiscovery";

const DiscoveryReport = dynamic(() => import("./DiscoveryReport"), { loading: () => <p className="p-5 text-sm text-muted-foreground" role="status">正在打开报告…</p> });

export function CompetitionDiscoveryWizard({ detailLinks = [] }: { detailLinks?: { id: string; path: string }[] }) {
  const discovery = useCompetitionDiscovery();
  const { state } = discovery;
  const stage = useRef<HTMLElement>(null);
  const run = state.snapshot?.run ?? null;
  const active = Boolean(run && !discoveryRunEnded(run));
  const failure = run?.status === "failed" ? discoveryFailurePresentation(run.error) : null;
  const retryStatus = discoveryRetryStatus(run);
  useEffect(() => {
    if (state.phase === "questions") return;
    stage.current?.focus({ preventScroll: true });
    stage.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [state.phase]);

  if (!discovery.hydrated) return <p className="rounded-2xl bg-brand-50 p-5 text-sm text-brand-700" role="status">正在恢复最近一次问答…</p>;
  if (discovery.newerRecordAvailable) return <section className="space-y-4 rounded-3xl border border-brand-200 bg-brand-50 p-6" aria-labelledby="discovery-newer-record-heading"><h1 className="text-xl font-semibold text-ink" id="discovery-newer-record-heading">另一标签页已更新最近一次问答</h1><p className="text-sm leading-7 text-muted-foreground">此页已暂停保存与接收更新，避免覆盖较新的记录。请打开最近一次问答继续查看。</p><button className={discoveryPrimaryButton} type="button" onClick={() => window.location.reload()}>恢复最近一次问答</button></section>;

  let reportStatus = discovery.busy ? "正在提交报告任务…" : "乐乐正在准备报告正文。";
  if (run?.status === "complete") reportStatus = "这份报告已完整生成。";
  else if (run?.status === "cancelled") reportStatus = "已停止生成，已显示的内容属于未完成报告。";
  else if (failure) reportStatus = failure.message;
  else if (run && discoveryRunEnded(run)) reportStatus = "这次报告已结束更新，可以重新生成。";
  else if (run?.status === "queued") reportStatus = "报告任务已接收，正在等待前面的报告完成。";
  else if (retryStatus) reportStatus = retryStatus;
  else if (discovery.connection === "reconnecting") reportStatus = "连接暂时中断，正在自动恢复；后台任务仍会继续。";
  else if (discovery.toolStatus) reportStatus = discovery.toolStatus;
  else if (run?.markdown) reportStatus = run.presentationVersion ? "推荐卡片正在逐张生成，报告尚未完成。" : "正文正在逐步生成，尚未完成。";
  else if (!run && discovery.error && !discovery.busy) reportStatus = "暂时没有取得报告任务，可以原地重试。";

  return <div className="mx-auto w-full max-w-[1360px]" data-testid="competition-discovery" data-phase={state.phase}>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><Link href="/competitions" className="min-h-11 py-3 text-sm font-semibold text-brand-700 underline underline-offset-4">返回竞赛信息</Link><button type="button" className="min-h-11 rounded-full px-3 text-sm font-semibold text-muted-foreground underline underline-offset-4 disabled:opacity-40" disabled={discovery.busy} onClick={() => void discovery.clearAll()}>清除并重新开始</button></div>
    <p className="mb-4 text-xs leading-6 text-muted-foreground">同一浏览器保留最近一份问答与报告。草稿自最后编辑起保留 24 小时；任务结束后，报告继续保留 24 小时。关闭页面后任务仍会继续。</p>
    {discovery.storageUnavailable ? <p className="mb-4 rounded-xl border border-warning-200 bg-warning-50 p-4 text-sm leading-6" role="status">当前浏览器无法保存恢复记录。页面内仍可使用，离开后可能无法恢复。</p> : null}
    {discovery.notice ? <p className="mb-4 rounded-xl bg-brand-50 p-4 text-sm leading-6 text-brand-800" role="status">{discovery.notice}</p> : null}
    {discovery.deleteFailed ? <div className="mb-4 rounded-xl border border-error-200 bg-error-50 p-4"><p className="text-sm leading-6 text-error-700" role="alert">{discovery.error}</p><div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={discovery.busy} className={discoverySecondaryButton} onClick={() => void discovery.clearAll()}>重试后台清除</button><button type="button" className={discoverySecondaryButton} onClick={discovery.forceLocalClear}>仅清除本机记录</button></div></div> : null}
    <section className="relative isolate rounded-3xl bg-brand-50/40 p-3 sm:border sm:border-brand-200 sm:p-5 md:p-8" aria-label="乐乐竞赛助手">
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"><OrbitBackdrop className="bottom-auto left-auto h-64 w-64 -translate-y-24 translate-x-20 opacity-30" compact /></div>
      <div className="relative space-y-7">
        <header className="px-2"><h1 className="font-serif text-2xl font-semibold leading-10 text-ink md:text-3xl">和乐乐一起选赛</h1><p className="mt-2 max-w-3xl text-sm leading-7 text-muted-foreground">用 10 个回合、13 项回答了解你的起点、目标与现实条件。每项都能选择或自己填写，确认后直接生成报告。乐乐会结合竞赛资料，按需联网，整理适合你进一步了解的竞赛。</p></header>
        {state.phase === "questions" ? <nav aria-label="已答题修改导航" className="flex flex-wrap gap-2 px-2">{DISCOVERY_QUESTIONS.map((question, index) => {
          const answered = validateDiscoveryStep(question, state.answers).valid;
          return <button key={question.id} type="button" aria-current={index === state.questionIndex ? "step" : undefined}
            disabled={index > state.questionIndex && !question.fields.some(field => state.answers[field.id].status === "answered")}
            onClick={() => discovery.editQuestion(index)} className={`min-h-11 rounded-full border px-3 text-xs font-semibold disabled:opacity-35 ${index === state.questionIndex ? "border-brand-500 bg-brand-500 text-white" : "border-brand-200 bg-white text-brand-700"}`}>{index + 1}. {question.title}{answered ? " ✓" : ""}</button>;
        })}</nav> : null}
        {state.phase === "questions" ? <DiscoveryQuestionCard key={state.questionIndex} question={DISCOVERY_QUESTIONS[state.questionIndex]} index={state.questionIndex} total={DISCOVERY_QUESTIONS.length} answers={state.answers} onChange={discovery.changeAnswer} onNext={discovery.nextQuestion} onBack={discovery.previousQuestion} /> : null}
        <section ref={stage} className="scroll-mt-28 outline-none" style={{ outline: "none" }} tabIndex={-1} aria-label="当前选赛阶段">
          {state.phase === "review" ? <DiscoverySummary answers={state.answers} additionalText={state.additionalText} consentAccepted={discovery.consentAccepted} busy={discovery.busy} error={discovery.error} onEdit={discovery.editQuestion} onRemoveLegacyText={discovery.removeLegacyText} onConsent={discovery.changeConsent} onSubmit={discovery.submit} /> : null}
          {state.phase === "report" ? <DiscoveryMessage><div className="rounded-3xl border border-brand-200 bg-white p-5 shadow-soft md:p-8">
            <DiscoveryReport key={run ? `${run.runId}:${run.attempt}` : "preparing"} detailLinks={detailLinks} markdown={run?.markdown ?? ""} sources={run?.sources ?? []} complete={run?.status === "complete"} pending={run ? active : discovery.busy || !discovery.error} statusText={reportStatus} presentationVersion={run?.presentationVersion} presentation={run?.presentation} />
            {run?.status === "complete" && run.webSearchUsed === false ? <p className="mt-4 text-xs leading-6 text-muted-foreground">本次未调用联网工具，报告引用基于提供给乐乐的竞赛资料。</p> : null}
            {discovery.error && !discovery.deleteFailed ? <p className="mt-5 rounded-xl bg-error-50 p-4 text-sm leading-6 text-error-700" role="alert">{discovery.error}</p> : null}
            <div className="mt-5 flex flex-wrap gap-3 border-t border-brand-200 pt-5">
              {active ? <button type="button" className={discoverySecondaryButton} disabled={discovery.busy} onClick={() => void discovery.cancelRun()}>停止生成</button> : null}
              {active && discovery.connection === "reconnecting" ? <button type="button" className={discoverySecondaryButton} onClick={discovery.reconnect}>立即恢复连接</button> : null}
              {!active && run && run.status !== "complete" && failure?.canRetry !== false ? <button type="button" className={discoveryPrimaryButton} disabled={discovery.busy} onClick={() => void discovery.startReport(true)}>重新生成报告</button> : null}
              {!run && discovery.error ? <button type="button" className={discoveryPrimaryButton} disabled={discovery.busy} onClick={() => state.session ? void discovery.startReport() : discovery.submit()}>重试获取报告</button> : null}
            </div>
          </div></DiscoveryMessage> : null}
        </section>
      </div>
    </section>
  </div>;
}
