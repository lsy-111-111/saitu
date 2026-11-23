import { useState } from "react";
import { findCanonicalCatalogCompetition } from "@/lib/competitions/catalog";
import { getCompetitionFactSheet } from "@/content/competition-facts";
import { clearSavedCompetitionStore, saveRecommendationResult, type SavedCompetitionStorageFailure } from "@/lib/competitions/saved-competitions";
import type { CompetitionRecommendationResponseV5 } from "@/types/competition-recommendation";

const box = "rounded-2xl border border-border bg-white px-5 py-4";
const disclosure = "cursor-pointer py-1 font-semibold text-brand-700";

function HistoricalCompetitionReference({ items }: { items: CompetitionRecommendationResponseV5["recommendations"] }) {
  if (!items.length) return null;
  return <details className={box}>
    <summary className={disclosure}>查看历史届次资料与官方入口</summary>
    <div className="mt-3" data-testid="historical-registration-reference">
      <p className="text-sm text-muted-foreground">以下按标注届次保留资料，仅用于了解赛事任务与赛程。参赛资格和开赛时间请自行核查官网。</p>
      <ol className="mt-3 divide-y divide-border">{items.map(item => {
        const facts = getCompetitionFactSheet(item.competitionId);
        const nodes = facts?.nodes ?? [];
        const source = facts?.sources[0];
        return <li key={item.competitionId} className="py-3 text-sm leading-6" data-historical-series={item.competitionId}>
          <h3 className="font-semibold text-ink">{item.name}</h3>
          <p className="text-xs text-muted-foreground">{facts ? `${facts.edition} · 资料核查于 ${facts.checkedAt}` : "历史届次资料，范围请核对来源"}</p>
          {nodes.length > 0 && <ul className="mt-1 space-y-1">{nodes.map((node, index) =>
            <li key={index}><a href={node.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-700 underline underline-offset-2">
              {node.date} · {node.kind}</a> · {node.scope}</li>)}</ul>}
          <a href={source?.url || item.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-brand-700 underline underline-offset-2">
            {source?.title || "核对赛事公开来源"}</a>
        </li>;
      })}</ol>
    </div>
  </details>;
}

export function SelectionResultActions({ result, openDetails }: {
  result: CompetitionRecommendationResponseV5;
  openDetails: (id: string) => void;
}) {
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<{reason: SavedCompetitionStorageFailure; message: string} | null>(null);
  const candidates = [...result.recommendations, ...(result.alternatives ?? [])];
  function save() {
    const outcome = saveRecommendationResult(result);
    if (outcome.ok) window.location.assign("/competitions/saved");
    else setSaveError(outcome);
  }
  function clearDamaged() {
    if (saveError?.reason === "quota" && !window.confirm("确定清理当前浏览器中已保存的竞赛吗？")) return;
    const outcome = clearSavedCompetitionStore();
    setSaveError(outcome.ok ? null : outcome);
  }
  return <div className="mt-5 grid gap-3">
    <HistoricalCompetitionReference items={result.recommendations} />
    {Boolean(result.alternatives?.length) && <details className={box}><summary className={disclosure}>展开更多候选</summary>
      <ul className="mt-3 space-y-3">{result.alternatives?.map(item => <li key={item.competitionId}>
        <button className="font-semibold text-brand-700 underline underline-offset-2" type="button" onClick={() => openDetails(item.competitionId)}>{item.name}</button>
        <p className="mt-1 text-sm text-muted-foreground">{item.reason}</p></li>)}</ul></details>}
    {candidates.length > 1 && <details className={box}><summary className={disclosure}>比较两到三项竞赛</summary>
      <fieldset className="mt-3 flex flex-wrap gap-3"><legend className="mb-2 text-sm text-muted-foreground">选择想比较的竞赛</legend>
        {candidates.map(item => <label className="flex items-center gap-2 text-sm" key={item.competitionId}>
          <input type="checkbox" checked={compareIds.includes(item.competitionId)} disabled={!compareIds.includes(item.competitionId) && compareIds.length >= 3}
            onChange={e => setCompareIds(e.target.checked ? [...compareIds, item.competitionId] : compareIds.filter(id => id !== item.competitionId))} />
          {item.name}</label>)}</fieldset>
      {compareIds.length >= 2 && <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{compareIds.map(id => {
        const item = findCanonicalCatalogCompetition(id);
        if (!item) return null;
        const match = result.recommendations.find(candidate => candidate.competitionId === id);
        const extra = result.alternatives?.find(candidate => candidate.competitionId === id);
        return <article className="rounded-xl bg-brand-50 p-4 text-sm leading-6" key={id}>
          <h3 className="font-semibold">{item.name}</h3>
          <dl className="mt-3 space-y-2"><div><dt className="font-semibold">任务与赛道</dt>
            <dd>{match?.recommendedTrack?.label || item.category} · {item.summary}</dd></div>
            <div><dt className="font-semibold">对你的价值</dt><dd>{match?.explanation.matchReasons[0] || extra?.reason}</dd></div>
          </dl>
        </article>;
      })}</div>}</details>}
    {result.recommendations.length > 0 && <button className="min-h-11 justify-self-start rounded-full bg-brand-600 px-5 py-2 font-semibold text-white" type="button" onClick={save}>保存并打开我的竞赛</button>}
    {saveError && <div role="alert" className="text-sm text-error-700">{saveError.message}
      {(saveError.reason === "quota" || saveError.reason === "corrupt") && <button type="button" className="ml-2 underline" onClick={clearDamaged}>清理后重试</button>}</div>}
  </div>;
}
