import { competitionReadingClaim, competitionReadingList, competitionReadingText } from "@/lib/competitions/presentation";
import type { DecisionClaim, DecisionCompetitionRecord, DecisionModule, ValueDimension } from "@/lib/competitions/v6/catalog-types";

type ReadingModule=Exclude<DecisionModule,"skills"|"nextStep">;
const moduleLabels:Record<ReadingModule,string>={task:"你会做什么",eligibility:"报名资格",track:"赛道与组别",participation:"怎样参与",deliverables:"需要交付什么",rubric:"作品怎样被评价",investment:"时间、费用与资源",difficulty:"难点在哪里",benefits:"可能获得什么",value:"怎样判断对你的价值"};
const valueLabels:Record<ValueDimension,string>={governance:"赛事组织与评价机制",taskRelevance:"任务与你的目标有多相关",portfolio:"能否留下可展示成果",learningFeedback:"训练与反馈机会",industryAcademicAccess:"行业或学术接触机会",recognition:"外部认可与适用范围"};
const kindLabels={official_fact:"赛事事实",organizer_claim:"主办方介绍",editorial_inference:"赛途分析与建议",published_price: "供应商公开价格", participant_report:"参与者反馈",unknown:"信息待核实"};
const statusLabels={verified_current:"已核对适用资料",historical:"往届资料",pending_review:"待进一步审核",conflicting:"来源存在差异",unknown:"信息未知",not_applicable:"不适用"};

function CatalogClaim({claim: original,record}:{claim:DecisionClaim;record:DecisionCompetitionRecord}) {
  const claim=competitionReadingClaim(original);
  if(!claim)return null;
  const facts=record.facts.filter(fact=>claim.factIds.includes(fact.id)).flatMap(fact=>{const text=competitionReadingText(fact.text);return text?[{...fact,text}]:[];});
  const sourceIds=new Set(record.facts.filter(fact=>claim.factIds.includes(fact.id)).flatMap(fact=>fact.sourceIds));
  const sources=record.sources.filter(source=>sourceIds.has(source.id));
  return <div className="text-sm leading-7"><p>{claim.text}</p><details className="mt-1 text-xs leading-6 text-muted-foreground"><summary className="cursor-pointer text-brand-700">{kindLabels[claim.kind]} · 依据与适用条件</summary><div className="mt-2 space-y-2 rounded-xl bg-brand-50/50 p-3">
    {facts.map(fact=><p key={fact.id}>{fact.text} · {fact.scope} · {statusLabels[fact.status]}</p>)}
    {sources.map(source=><p key={source.id}><a className="font-semibold text-brand-700 underline" href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> · {source.scope}{source.checkedAt?` · 核查于 ${source.checkedAt}`:""}</p>)}
    {claim.conditions.map((condition,index)=><p key={index}>条件：{condition}</p>)}
    {claim.unknownReason?<p>目前不能确定：{claim.unknownReason}</p>:null}
    {!facts.length&&!claim.conditions.length&&!claim.unknownReason?<p>此处为选赛参考，尚无可进一步确认的事实依据。</p>:null}
  </div></details></div>;
}

/** One server-selected record only. This module never imports the catalog. */
export function DecisionCatalogDetail({record}:{record:DecisionCompetitionRecord}) {
  const firstModules:ReadingModule[]=["task","deliverables","investment"];
  const otherModules:ReadingModule[]=["eligibility","track","participation","rubric","difficulty","benefits","value"];
  const difficulty=record.difficulty.flatMap(item=>{const summary=competitionReadingText(item.summary);return summary?[{...item,summary,assumptions:competitionReadingList(item.assumptions)}]:[];});
  const values=record.valueDimensions.filter(value=>competitionReadingText(value.assessment.text));
  return <section className="mt-7 space-y-5" aria-labelledby={`decision-guide-${record.recordId}`} data-testid="decision-catalog-detail">
    <header className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5"><h2 className="text-xl font-semibold" id={`decision-guide-${record.recordId}`}>在决定参赛前，先看懂这场比赛</h2><p className="mt-2 text-sm leading-7">{competitionReadingText(record.summary)}</p><p className="mt-3 text-xs leading-6 text-muted-foreground">适用资料：{record.edition} · {record.track.name} · {record.scope}</p><p className="mt-1 text-sm leading-6">{competitionReadingText(record.registration.note)}</p>
      {record.publication.mode!=="decision_ready"?<p className="mt-3 rounded-xl bg-white p-3 text-sm leading-6">这份内容适合先了解赛事任务，部分关键条件仍待核实。不能据此认定目前可以报名。</p>:null}
    </header>
    <div className="grid gap-4 md:grid-cols-2">{firstModules.map(module=><section key={module} className={`rounded-2xl border border-border p-4 ${module==="investment"?"md:col-span-2":""}`}><h3 className="mb-3 font-semibold">{moduleLabels[module]}</h3><div className="space-y-3">{record.sections[module].some(claim=>competitionReadingText(claim.text))?record.sections[module].map((claim,index)=><CatalogClaim key={index} claim={claim} record={record}/>):<p className="text-sm text-muted-foreground">目前资料不足，需进一步核对具体赛道要求。</p>}</div></section>)}</div>
    <section className="rounded-2xl border border-border p-5"><h3 className="font-semibold">参赛难度</h3><div className="mt-4 grid gap-4 md:grid-cols-2">{difficulty.map(item=><div className="rounded-xl bg-slate-50 p-4" key={item.stage}><h4 className="text-sm font-semibold">{{entry:"参赛基础",completion:"完成有效作品或提交",award:"竞争奖项"}[item.stage]}</h4><p className="mt-2 text-sm leading-6">{item.summary}</p>{item.assumptions.length?<ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground">{item.assumptions.map((assumption,index)=><li key={index}>{assumption}</li>)}</ul>:null}</div>)}</div><p className="mt-3 text-xs text-muted-foreground">以上为赛事难度分析。个人难度还取决于已有经历、投入与队友分工，不等于获奖概率。</p></section>
    <section className="rounded-2xl border border-border p-5"><h3 className="font-semibold">“含金量”具体体现在哪里</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">分别看以下维度，再对照自己的目标；没有足够依据的部分保持未知。</p><div className="mt-4 grid gap-4 md:grid-cols-2">{values.map(value=><section key={value.dimension}><h4 className="mb-2 text-sm font-semibold">{valueLabels[value.dimension]}<span className="ml-2 text-xs font-normal text-muted-foreground">{value.evidenceLevel==="supported"?"有资料支持":value.evidenceLevel==="partial"?"部分资料支持":"信息不足"}</span></h4><CatalogClaim claim={value.assessment} record={record}/></section>)}</div><p className="mt-4 text-xs leading-6 text-muted-foreground">{record.schoolPolicyReminder}</p></section>
    <details className="rounded-2xl border border-border p-5"><summary className="cursor-pointer font-semibold text-brand-700">继续核对资格、参与方式与评价要求</summary><div className="mt-4 space-y-5">{otherModules.map(module=><section key={module}><h3 className="mb-2 font-semibold">{moduleLabels[module]}</h3><div className="space-y-3">{record.sections[module].some(claim=>competitionReadingText(claim.text))?record.sections[module].map((claim,index)=><CatalogClaim key={index} claim={claim} record={record}/>):<p className="text-sm text-muted-foreground">对应信息仍需核对。</p>}</div></section>)}</div></details>
    <details className="rounded-2xl border border-border p-5"><summary className="cursor-pointer font-semibold text-brand-700">哪些情况下值得考虑，哪些情况下先缓一缓</summary><div className="mt-4 grid gap-4 md:grid-cols-2"><div><h3 className="text-sm font-semibold">可能适合的情况</h3><ul className="mt-2 list-disc space-y-2 pl-4 text-sm leading-6">{competitionReadingList(record.suitability.goodFit).map((text,index)=><li key={index}>{text}</li>)}</ul></div><div><h3 className="text-sm font-semibold">需要先考虑的限制</h3><ul className="mt-2 list-disc space-y-2 pl-4 text-sm leading-6">{competitionReadingList([...record.suitability.poorFit,...record.suitability.uncertainties]).map((text,index)=><li key={index}>{text}</li>)}</ul></div></div></details>
  </section>;
}
