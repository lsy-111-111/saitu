import "server-only";
import { createHash } from "node:crypto";
import type { DiscoveryCatalogSnapshot } from "./transport";
import { discoveryCatalogDetailSchema, type DiscoveryCatalogDetail } from "./presentation";

type Source = { url: string; title: string };
type Section = DiscoveryCatalogDetail["sections"][number];
type ObjectValue = Record<string, unknown>;

// This reader deliberately does not import the live catalog. A saved report must
// continue to describe the exact material used for that run after a release.
const COLUMNS = ["id", "name", "aliases", "task", "tracks", "editorialPreparation", "audience", "team", "mode", "eligibility", "schedule", "localSources", "scopedRules", "localNotes", "legacyFeeFacts", "trackTasks", "detailPath", "archivedMaterials", "criticalScopeNotes"];
const FEE_COLUMNS = ["id", "text", "scope", "kind", "status", "reviewStatus", "checkedAt", "lastVerifiedAt", "sources"];
const FEE_SOURCE_COLUMNS = ["sourceId", "title", "publisher", "authority", "scope", "checkedAt", "publishedAt", "accessStatus", "verificationMethod", "integrity", "localSource"];

export class DiscoveryCatalogPresentationError extends Error {
  constructor() { super("discovery_catalog_presentation_invalid"); this.name = "DiscoveryCatalogPresentationError"; }
}
const invalid = (): never => { throw new DiscoveryCatalogPresentationError(); };
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : invalid();
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid();
const text = (value: unknown): string => typeof value === "string" ? value : invalid();
const texts = (value: unknown): string[] => array(value).map(text);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const unique = <T>(values: T[]): T[] => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];

const LABELS: Record<string, string> = {
  unknown: "未知", unrestricted: "不限（仍须核对当届）", partial: "部分核实，仍有待核条件", verified: "原目录已核实（不代表本轮或新届核验）",
  scheduled: "已有所列届次的安排", historical: "历史资料", verified_current: "原资料标为已核验（不代表本轮或新届核验）", pending_review: "待复核",
  conflicting: "资料存在冲突", not_applicable: "不适用", official_fact: "原分类为官方事实", organizer_claim: "主办方陈述", editorial_inference: "平台分析",
  participant_report: "参赛者经验", published_price: "公开价格资料", ai_dual_reviewed: "原资料经双重审阅", human_reviewed: "原资料经人工审阅",
  body_read: "曾读取正文", excerpt_read: "曾读取摘录", metadata_only: "仅有资料元信息", unavailable: "当时无法读取", imported_unrechecked: "历史导入，未重新核验",
  agent_web_read: "原记录为联网读取", legacy_import: "历史导入", human_review: "原记录为人工审阅", unassessed: "尚未评估", consistent: "原记录未见不一致", requires_recheck: "需重新核验",
  organizer: "主办方资料", official_host: "官方承办方资料", university_local: "高校本地通知", supplier: "供应方资料", other: "其他来源",
  "official-competition": "赛事官方资料", "education-authority": "教育部门或高校资料", "school-notice": "学校通知", "media-report": "媒体报道", "editorial-inference": "平台分析",
  vocational: "专科", undergraduate: "本科", master: "硕士", doctorate: "博士", "high-school": "高中", "other-or-non-full-time": "其他或非全日制",
  "undergraduate-1": "本科一年级", "undergraduate-2": "本科二年级", "undergraduate-3": "本科三年级", "undergraduate-4": "本科四年级",
  individual: "个人参赛", team: "团队参赛", either: "个人或团队参赛", remote: "线上（不保证全程）", offline: "线下", hybrid: "线上线下结合",
};
const label = (value: unknown): string => typeof value === "string" ? LABELS[value] ?? value : typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "boolean" ? value ? "是" : "否" : invalid();
const readable = (value: unknown): string => Array.isArray(value) ? value.map(label).join("、") : label(value);
const audience = (value: unknown): string => text(value).split("、").map(label).join("、");
const optionalDate = (value: unknown): string => value === null || value === undefined ? "未知" : text(value).replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3");
const safeUrl = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 8192) return invalid();
  try { const url = new URL(value); return /^https?:$/u.test(url.protocol) && !url.username && !url.password ? url.href : invalid(); }
  catch { return invalid(); }
};

function teamText(value: unknown): string {
  if (!Array.isArray(value)) return label(value);
  if (value.length !== 3 || !["team", "individual", "either"].includes(text(value[0]))) return invalid();
  const bound = (item: unknown) => item === "未知" || typeof item === "number" && Number.isFinite(item) && item >= 0 ? String(item) : invalid();
  return `${label(value[0])}；人数下限：${bound(value[1])}；人数上限：${bound(value[2])}。人数未知不表示不限，最少1人不表示必须找队友。`;
}

function flags(value: unknown): string[] {
  const record = object(value), lines: string[] = [];
  for (const [key, item] of Object.entries(record)) {
    if (["要求全日制", "要求在籍", "必须同校组队"].includes(key)) {
      if (typeof item !== "boolean") return invalid();
      lines.push(`${key}：${item ? "是" : "否（不要求此项，不代表其他资格已满足）"}`);
    } else if (key === "全日制适用学段" || key === "专业范围") lines.push(`${key}：${readable(item)}`);
    else return invalid();
  }
  return lines;
}

const RULE_FIELDS: Record<string, string> = {
  degree: "学历", year: "年级", age: "年龄", major: "专业", region: "地区", institution: "院校", enrolled: "在籍要求", fullTime: "全日制要求",
  teamSize: "队伍人数", sameInstitutionTeam: "同校要求", sameCountryTeam: "同国别要求", mentor: "指导教师", priorQualification: "前置资格",
  professionalDeveloper: "职业开发者身份", priorDegree: "既往学历", language: "语言", equipment: "设备", membership: "会员资格", stage: "适用学段",
  team: "参赛形式与人数", qualification: "资格说明", requiresFullTime: "全日制要求", requiresCurrentEnrollment: "在籍要求",
};
const OPERATORS: Record<string, string> = { eq: "为", in: "包括", not_in: "不包括", min: "至少", max: "至多", requires_confirmation: "须核对" };

function renderEntry(entry: unknown[], version: string, sha256: string): DiscoveryCatalogDetail {
  if (entry.length !== COLUMNS.length) return invalid();
  const get = (name: string) => entry[COLUMNS.indexOf(name)];
  const id = text(get("id")), title = text(get("name")), detailPath = text(get("detailPath"));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || !title.trim() || detailPath !== `/competitions/${id}`) return invalid();
  const tracks = texts(get("tracks")), notes = texts(get("localNotes"));
  const sources: Source[] = array(get("localSources")).map(value => {
    if (typeof value === "string") return { url: safeUrl(value), title: "核验来源" };
    const tuple = array(value);
    if (tuple.length !== 3) return invalid();
    return { url: safeUrl(tuple[0]), title: `核验来源（${label(text(tuple[1]))}；原资料核验日期：${optionalDate(tuple[2])}）` };
  });
  const localSource = (index: unknown, nullable = false): Source[] => {
    if (nullable && index === null) return [];
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= sources.length) return invalid();
    return [sources[index]];
  };
  const localNote = (index: unknown): string => typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < notes.length ? notes[index] : invalid();
  const trackName = (index: unknown): string => index === -1 ? "赛事系列范围" : typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < tracks.length ? tracks[index] : invalid();
  const sections: Section[] = [];
  const add = (heading: string, paragraphs: string[], refs: Source[] = []) => {
    const lines = unique(paragraphs.filter(value => value.trim()));
    if (lines.length) sections.push({ heading, paragraphs: lines, ...(refs.length ? { sources: unique(refs) } : {}) });
  };

  const preparation = array(get("editorialPreparation"));
  if (preparation.length !== 2) return invalid();
  add("任务与成果", [text(get("task")), ...(texts(get("aliases")).length ? [`别名：${texts(get("aliases")).join("、")}`] : []),
    ...(tracks.length ? [`目录中的赛道：${tracks.join("；")}`] : []),
    ...(text(preparation[0]) ? [`平台分析的可能成果：${text(preparation[0])}。不代表官方必需交付物。`] : []),
    ...(text(preparation[1]) ? [`平台分析的准备资源：${text(preparation[1])}。不代表官方强制条件或本人已具备。`] : [])]);

  for (const task of array(get("trackTasks"))) {
    const tuple = array(task);
    if (tuple.length !== 4) return invalid();
    add(`赛道任务：${trackName(tuple[0])}`, [text(tuple[1]), "任务说明为平台基于所引方向的分析，不证明本人已有能力，也不自动成为官方强制交付物。", ...(tuple[3] === null ? [] : [localNote(tuple[3])])], localSource(tuple[2], true));
  }

  const qualification = array(get("eligibility"));
  if (qualification.length < 4 || qualification.length > 5) return invalid();
  const eligibilityLines = [`目录资料状态：${label(qualification[0])}`, `适用对象：${audience(get("audience"))}`, ...texts(qualification[1]), ...flags(qualification[3])];
  const eligibilitySources = localSource(qualification[2], true);
  if (qualification[4] !== undefined) {
    for (const [key, value] of Object.entries(object(qualification[4]))) {
      if (key === "unknown") eligibilityLines.push(...texts(value).map(line => `待核条件：${line}`));
      else if (key === "stageExceptions" || key === "partTimeExceptions") for (const [stage, note] of Object.entries(object(value))) eligibilityLines.push(`${key === "stageExceptions" ? "学段例外" : "非全日制适用说明"}（${label(stage)}）：${text(note)}`);
      else if (key === "firstYear") {
        const first = object(value);
        for (const name of Object.keys(first)) if (!["edition", "minimumYear", "alternativeBirthYear", "rule", "petition", "notes", "source"].includes(name)) return invalid();
        eligibilityLines.push(`首次高等教育年限通道（${text(first.edition)}）：首次接受高等教育年份下限为${first.minimumYear == null ? "未知" : label(first.minimumYear)}；替代出生年份下限为${first.alternativeBirthYear == null ? "未知" : label(first.alternativeBirthYear)}。仅按所引规则核对，不独立证明全部资格。`, text(first.rule), `可申请资格延长：${first.petition == null ? "未知" : label(first.petition)}`, ...texts(first.notes));
        eligibilitySources.push(...localSource(first.source, true));
      } else return invalid();
    }
  }
  add("资格及例外", eligibilityLines, eligibilitySources);
  add("队伍与参加方式", [`参赛形式：${teamText(get("team"))}`, `目录所列参加方式：${texts(get("mode")).map(value => label(value)).join("、") || "未知"}。未知不表示全程线上。`]);

  const schedule = array(get("schedule"));
  if (schedule.length !== 7) return invalid();
  add("届次与赛期", [`所列届次：${text(schedule[1])}；资料状态：${label(schedule[0])}`, `报名开始：${optionalDate(schedule[2])}；报名截止：${optionalDate(schedule[3])}`, `比赛开始：${optionalDate(schedule[4])}；比赛结束：${optionalDate(schedule[5])}`, `原资料核验日期：${optionalDate(schedule[6])}。该日期不是赛期，也不是本轮联网核验日期；历史或未知不表示当前可报名，报名截止不等于比赛结束。`]);

  for (const material of array(get("scopedRules"))) {
    const scope = array(material);
    if (scope.length !== 6) return invalid();
    const lines = [`适用范围：${trackName(scope[0])}；届次：${scope[1] === null ? "按该赛道来源" : text(scope[1])}；组别：${scope[2] === null ? "仅该赛道范围，不扩大至全赛事" : text(scope[2])}`];
    for (const value of scope[3] == null ? [] : array(scope[3])) {
      const rule = array(value), field = RULE_FIELDS[text(rule[0])], operator = OPERATORS[text(rule[1])];
      if (!field || !operator || rule.length < 3 || rule.length > 4) return invalid();
      lines.push(`${field}${operator}：${rule[0] === "team" ? teamText(rule[2]) : readable(rule[2])}${rule.length === 4 ? `；${localNote(rule[3])}` : ""}`);
    }
    if (scope[4] !== null && scope[4] !== undefined) {
      const cost = array(scope[4]);
      if (cost.length !== 4 || !cost.slice(0, 2).every(value => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0)) return invalid();
      lines.push(`原资料所列个人费用范围：下限${cost[0] === null ? "未知" : `${cost[0]}元`}，上限${cost[1] === null ? "未知" : `${cost[1]}元`}；适用范围：${localNote(cost[2])}；完整说明：${localNote(cost[3])}。不据此推断个人必付额、分摊、资助或完整总支出。`);
    }
    const refs: Source[] = [];
    for (const value of array(scope[5])) {
      const evidence = array(value);
      if (evidence.length !== 5) return invalid();
      refs.push(...localSource(evidence[0]));
      lines.push(`所引资料范围：${localNote(evidence[1])}；原核验日期：${optionalDate(evidence[2])}；资料性质：${label(evidence[3])}；原状态：${label(evidence[4])}`);
    }
    add("赛道与组别条件", lines, refs);
  }

  for (const value of array(get("legacyFeeFacts"))) {
    const tuple = array(value);
    if (tuple.length !== FEE_COLUMNS.length) return invalid();
    const fact = Object.fromEntries(FEE_COLUMNS.map((key, index) => [key, tuple[index]]));
    text(fact.id);
    const lines = [text(fact.text), `适用范围：${text(fact.scope)}`, `资料性质：${label(fact.kind)}；原事实状态：${label(fact.status)}；原复核状态：${fact.reviewStatus === null ? "未知" : label(fact.reviewStatus)}`, `原检查日期：${optionalDate(fact.checkedAt)}；原最近核验日期：${optionalDate(fact.lastVerifiedAt)}`], refs: Source[] = [];
    for (const sourceValue of array(fact.sources)) {
      const sourceTuple = array(sourceValue);
      if (sourceTuple.length !== FEE_SOURCE_COLUMNS.length) return invalid();
      const source = Object.fromEntries(FEE_SOURCE_COLUMNS.map((key, index) => [key, sourceTuple[index]]));
      text(source.sourceId);
      const url = localSource(source.localSource)[0].url;
      refs.push({ url, title: text(source.title) || "核验来源" });
      lines.push(`所引来源：${text(source.title)}；发布方：${text(source.publisher)}；来源性质：${label(source.authority)}；来源适用范围：${text(source.scope)}；原检查日期：${optionalDate(source.checkedAt)}；发布日期：${optionalDate(source.publishedAt)}；原读取情况：${label(source.accessStatus)}；原核验方式：${label(source.verificationMethod)}；一致性检查：${source.integrity === null ? "未知" : label(source.integrity)}`);
    }
    add("费用资料（保留原范围与待核状态）", lines, refs);
  }
  add("费用理解边界", ["报名费与个人全程总费用不同。历史导入、待复核或未知的费用线索不代表本轮或当届已核实；队伍或学校缴费不等于个人必付，不自行推算分摊、报销或资助。没有费用条目也不表示免费。"]);
  add("重要范围说明", texts(get("criticalScopeNotes")));

  const archived = get("archivedMaterials");
  if (archived !== null) renderArchive(object(archived), add);
  const result = discoveryCatalogDetailSchema.safeParse({ version, sha256, id, title, detailPath, sections, sources: unique([...sources, ...sections.flatMap(section => section.sources ?? [])]) });
  return result.success ? result.data : invalid();
}

function renderArchive(archive: ObjectValue, add: (heading: string, lines: string[], refs?: Source[]) => void) {
  const lines = [text(archive.notice), `历史对象范围：${audience(archive.audience)}`], refs: Source[] = [];
  if (archive.eligibility) {
    const eligibility = object(archive.eligibility);
    if (eligibility.source) refs.push({ url: safeUrl(eligibility.source), title: "历史归档核验来源" });
    lines.push(`历史资格资料状态：${label(eligibility.state)}`, ...texts(eligibility.notes));
    if (eligibility.blockingClarifications) lines.push(...texts(eligibility.blockingClarifications).map(note => `历史待核：${note}`));
    for (const [key, title] of [["stageClarificationNotes", "历史学段说明"], ["partTimeStageClarificationNotes", "历史非全日制说明"]]) if (eligibility[key]) {
      for (const [stage, note] of Object.entries(object(eligibility[key]))) lines.push(`${title}（${label(stage)}）：${text(note)}`);
    }
    for (const [key, title] of [["requiresFullTime", "历史全日制要求"], ["requiresCurrentEnrollment", "历史在籍要求"], ["sameInstitutionTeam", "历史同校要求"]]) if (eligibility[key] !== undefined) lines.push(`${title}：${label(eligibility[key])}`);
  }
  const team = object(archive.team);
  lines.push(`历史队伍资料：${team.state === "known" ? teamText([team.mode, team.minSize ?? "未知", team.maxSize ?? "未知"]) : label(team.state)}`);
  const schedule = object(archive.schedule);
  lines.push(`历史赛期：届次${schedule.edition ? text(schedule.edition) : "未知"}；原资料状态：${label(schedule.state)}；报名${optionalDate(schedule.registrationStart)}至${optionalDate(schedule.registrationEnd)}；比赛${optionalDate(schedule.competitionStart)}至${optionalDate(schedule.competitionEnd)}；原核验日期${optionalDate(schedule.verifiedAt)}`);
  if (schedule.sourceUrl) refs.push({ url: safeUrl(schedule.sourceUrl), title: "历史赛期核验来源" });
  for (const value of array(archive.tracks)) {
    const track = array(value);
    if (track.length !== 8) return invalid();
    lines.push(`历史赛道：${text(track[0])}；学段：${track[1] === null ? "未知" : text(track[1])}`);
    if (track[2] !== null) {
      const team = object(track[2]);
      lines.push(`该历史赛道队伍：${team.state === "known" ? teamText([team.mode, team.minSize ?? "未知", team.maxSize ?? "未知"]) : label(team.state)}`);
    }
    for (const [index, name] of [[3, "全日制"], [4, "在籍"], [5, "同校"]] as const) if (track[index] !== null) lines.push(`该历史赛道${name}要求：${label(track[index])}`);
    lines.push(...texts(track[6]), ...texts(track[7]).map(note => `历史待核：${note}`));
  }
  add("历史归档（不作现行资格）", lines, refs);
}

/** Build once per run; callers send only the selected records to the browser. */
export function createDiscoveryCatalogPresentation(snapshot: DiscoveryCatalogSnapshot): Map<string, DiscoveryCatalogDetail> {
  if (typeof snapshot.text !== "string" || Buffer.byteLength(snapshot.text, "utf8") !== snapshot.byteLength || snapshot.byteLength > 6_000_000
    || createHash("sha256").update(snapshot.text).digest("hex") !== snapshot.sha256) return invalid();
  let parsed: ObjectValue;
  try { parsed = object(JSON.parse(snapshot.text)); } catch { return invalid(); }
  if (parsed.schemaVersion !== "competition-discovery-catalog.v7" || typeof parsed.version !== "string" || !parsed.version || parsed.version !== snapshot.version
    || !same(parsed.columns, COLUMNS) || !same(parsed.legacyFeeFactColumns, FEE_COLUMNS) || !same(parsed.legacyFeeSourceColumns, FEE_SOURCE_COLUMNS)
    || !Array.isArray(snapshot.ids) || snapshot.count !== snapshot.ids.length || new Set(snapshot.ids).size !== snapshot.count) return invalid();
  const entries = array(parsed.entries);
  if (entries.length !== snapshot.count || !same(entries.map(entry => array(entry)[0]), snapshot.ids)) return invalid();
  return new Map(entries.map(value => {
    const detail = renderEntry(array(value), snapshot.version, snapshot.sha256);
    return [detail.id, detail];
  }));
}
