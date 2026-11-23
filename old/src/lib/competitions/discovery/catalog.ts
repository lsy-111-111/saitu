import "server-only";
import { createHash } from "node:crypto";
import type { Competition, CompetitionMetadataSource, ThreeStateConstraint } from "@/content/competitions";
import { COMPETITION_CATALOG_VERSION, getCompetitionCatalog } from "@/lib/competitions/catalog";
import { getDecisionCatalog } from "@/lib/competitions/v6/catalog";
import type { DecisionCompetitionRecord } from "@/lib/competitions/v6/catalog-types";
import { discoveryCriticalScopeNotes, reviewedDiscoveryCompetition } from "@/content/competition-innovation-2026";

export const DISCOVERY_CATALOG_SCHEMA_VERSION = "competition-discovery-catalog.v7";
// Application storage/request-size protection, not the provider user-token or
// model-context limit. Every series is retained; oversized material fails.
export const DISCOVERY_CATALOG_MAX_BYTES = 750_000;
export const DISCOVERY_CATALOG_COLUMNS = ["id", "name", "aliases", "task", "tracks", "editorialPreparation", "audience", "team", "mode", "eligibility", "schedule", "localSources", "scopedRules", "localNotes", "legacyFeeFacts", "trackTasks", "detailPath", "archivedMaterials", "criticalScopeNotes"] as const;
export const DISCOVERY_FEE_FACT_COLUMNS = ["id", "text", "scope", "kind", "status", "reviewStatus", "checkedAt", "lastVerifiedAt", "sources"] as const;
export const DISCOVERY_FEE_SOURCE_COLUMNS = ["sourceId", "title", "publisher", "authority", "scope", "checkedAt", "publishedAt", "accessStatus", "verificationMethod", "integrity", "localSource"] as const;

export type DiscoveryCatalogSnapshot = { version: string; count: number; ids: string[]; sha256: string; text: string; clarifyText: string; byteLength: number };
type ScopedMaterial = { track: string; edition: string; group: string; rules?: unknown[][]; cost?: { personalMinCny: number | null; personalMaxCny: number | null; scope: string; note: number }; evidence: unknown[] };
const unique = <T>(items: T[]): T[] => [...new Map(items.map(item => [JSON.stringify(item), item])).values()];

export function safeDiscoveryUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 8192) return null;
  try { const url = new URL(input); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

const labels: Record<string, string> = {
  vocational: "专科", master: "硕士", doctorate: "博士", remote: "线上（不保证全程）", offline: "线下", hybrid: "线上线下结合", unknown: "未知",
  prototype: "原型", software: "软件", "research-paper": "论文报告", "business-plan": "商业方案", presentation: "展示答辩", design: "设计作品", video: "视频",
  mentor: "导师", lab: "实验室", equipment: "设备", funding: "经费", dataset: "数据", "industry-access": "行业联系", "research-access": "研究条件"
};
function audiences(value: ThreeStateConstraint<string>): string {
  if (value.state !== "known") return value.state === "unrestricted" ? "不限（仍须核对当届）" : "未知";
  const undergraduate = value.values.filter(item => /^undergraduate-[1-4]$/.test(item));
  return [...(undergraduate.length === 4 ? ["本科各年级"] : undergraduate.map(item => `本科${item.at(-1)}年级`)),
    ...value.values.filter(item => !/^undergraduate-[1-4]$/.test(item)).map(item => labels[item] ?? item)].join("、");
}

const basicDate = (value: string): string => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll("-", "") : value;

/** Keep complete qualifications and every URL beside their owner. Only short
 * common enums cross series boundaries; rule notes and source refs never do. */
function localizeDiscoveryMaterials(entries: unknown[][], notes: string[], sourceRecords: unknown[][], qualificationValues: Record<string, unknown>[], sourceUrls: string[]) {
  const qualificationConditions: Record<string, unknown>[] = [];
  const localized = entries.map(original => {
    const entry = structuredClone(original), qualification = entry[9] as unknown[];
    const localNotes: string[] = [];
    const completeNote = (index: unknown): string => {
      const text = notes[Number(index)];
      if (typeof text !== "string") throw new Error("discovery_catalog_note_invalid");
      return text;
    };
    const localNote = (index: unknown): number => {
      const text = completeNote(index), found = localNotes.indexOf(text);
      if (found >= 0) return found;
      localNotes.push(text); return localNotes.length - 1;
    };
    const sourceMetadata = (index: unknown): unknown[] => {
      const metadata = sourceRecords[Number(index)];
      if (!metadata) throw new Error("discovery_catalog_source_invalid");
      if (typeof metadata[0] !== "number") throw new Error("discovery_catalog_source_invalid");
      const url = sourceUrls[Number(metadata[0])];
      if (!url) throw new Error("discovery_catalog_source_invalid");
      return [url, ...metadata.slice(1)];
    };
    const localSources: (string | unknown[])[] = (entry[11] as number[]).map(sourceMetadata);
    const localSource = (index: unknown): number | null => {
      if (index === null) return null;
      const metadata = sourceMetadata(index);
      const found = localSources.findIndex(value => JSON.stringify(value) === JSON.stringify(metadata));
      if (found >= 0) return found;
      localSources.push([...metadata]); return localSources.length - 1;
    };
    const localUrl = (index: unknown): number => {
      if (typeof index !== "number") throw new Error("discovery_catalog_source_invalid");
      const url = sourceUrls[Number(index)];
      if (!url) throw new Error("discovery_catalog_source_invalid");
      const found = localSources.findIndex(value => (typeof value === "string" ? value : value[0]) === url);
      if (found >= 0) return found;
      // This URL already has evidence nature/date in the scoped rule. A plain
      // string adds no invented publisher or verification metadata.
      localSources.push(url); return localSources.length - 1;
    };
    const extra = Object.fromEntries(Object.entries(structuredClone(qualificationValues[Number(qualification[3])])).filter(([, value]) => value !== undefined));
    if (Array.isArray(extra.unknown)) extra.unknown = extra.unknown.map(completeNote);
    if (extra.firstYear) {
      const firstYear = extra.firstYear as Record<string, unknown>;
      firstYear.notes = (firstYear.notes as unknown[]).map(completeNote);
      firstYear.source = localSource(firstYear.source);
    }
    const conditions: Record<string, unknown> = {};
    for (const key of ["fullTime", "fullTimeStages", "enrolled", "sameSchool", "majors"]) {
      if (extra[key] !== undefined) { conditions[key] = extra[key]; delete extra[key]; }
    }
    let conditionIndex = qualificationConditions.findIndex(value => JSON.stringify(value) === JSON.stringify(conditions));
    if (conditionIndex < 0) { conditionIndex = qualificationConditions.length; qualificationConditions.push(conditions); }
    entry[9] = [qualification[0], (qualification[1] as unknown[]).map(completeNote), localSource(qualification[2]), conditionIndex,
      ...(Object.keys(extra).length ? [extra] : [])];
    entry[11] = localSources;
    if (Array.isArray(entry[10])) entry[10] = entry[10].map((value, index) => index >= 2 && index <= 5 && typeof value === "string" ? basicDate(value) : value);
    entry[12] = (entry[12] as unknown[][]).map(scope => {
      const edition = completeNote(scope[1]), group = completeNote(scope[2]);
      scope[1] = edition === "以赛道来源为准" ? null : edition.replaceAll(String(entry[1]), "本赛事");
      scope[2] = group === "赛道范围，不能升级为全赛事限制" ? null : group.replaceAll(String(entry[1]), "本赛事");
      for (const rule of (scope[3] as unknown[][] | undefined) ?? []) if (rule.length > 3) rule[3] = localNote(rule[3]);
      if (Array.isArray(scope[4])) { scope[4][2] = localNote(scope[4][2]); scope[4][3] = localNote(scope[4][3]); }
      for (const evidence of scope[5] as unknown[][]) { evidence[0] = localUrl(evidence[0]); evidence[1] = localNote(evidence[1]); }
      return scope;
    });
    entry.push(localNotes);
    return entry;
  });
  return { entries: localized, qualificationConditions };
}

/** Column names and dictionaries are included in the same input. No text is
 * sliced: core rules and uncertainty notes remain complete within their scope. */
export function makeDiscoveryCatalogSnapshot(options: { competitions?: readonly Competition[]; records?: DecisionCompetitionRecord[]; maxBytes?: number } = {}): DiscoveryCatalogSnapshot {
  const originals = new Map((options.competitions ?? getCompetitionCatalog()).map(item => [item.id, item]));
  const all = [...(options.competitions ?? getCompetitionCatalog())].map(reviewedDiscoveryCompetition).sort((a, b) => a.id.localeCompare(b.id));
  const ids = all.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("discovery_catalog_duplicate_id");
  if (!ids.length) throw new Error("discovery_catalog_empty");
  if (ids.some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new Error("discovery_catalog_invalid_id");
  const grouped = new Map<string, DecisionCompetitionRecord[]>();
  for (const record of options.records ?? getDecisionCatalog()) grouped.set(record.seriesId, [...(grouped.get(record.seriesId) ?? []), record]);
  const sources: string[] = [], notes: string[] = [], dates: string[] = [], sourceRecords: unknown[][] = [];
  const sourceKinds: string[] = [], evidenceKinds: string[] = [], evidenceStates: string[] = [], audienceValues: string[] = [], teamValues: unknown[] = [], modeValues: string[][] = [], preparationValues: unknown[][] = [];
  const eligibilityStates = ["unknown", "partial", "verified"], ruleFields: string[] = [], ruleOperators: string[] = [];
  const qualificationValues: Record<string, unknown>[] = [];
  const redundantRuleNotes = new Set(["在校学生", "在校", "在籍", "正式在校学籍", "全日制", "通知明确全日制。", "同校。", "同一学校", "不同学校不能联合组队", "本科或研究生", "至少1人", "1—3人", "至少两名学生", "至多五名学生", "不超过4名学生", "在校本科生", "科普赛道3人"]);
  function intern<T>(values: T[], input: T): number { const key = JSON.stringify(input), found = values.findIndex(item => JSON.stringify(item) === key); if (found >= 0) return found; values.push(input); return values.length - 1; }
  const sourceMap = new Map<string, number>(), noteMap = new Map<string, number>(), dateMap = new Map<string, number>(), sourceRecordMap = new Map<string, number>();
  function source(input: string | undefined): number | null {
    const url = safeDiscoveryUrl(input); if (!url) return null;
    if (!sourceMap.has(url)) {
      sourceMap.set(url, sources.length);
      // Decode percent-encoded Unicode without changing URL identity. This
      // avoids spending dozens of tokens on one encoded Chinese filename.
      let readable = url;
      try { readable = decodeURI(url).replace(/\s/gu, value => encodeURIComponent(value)); } catch { /* Keep the validated original. */ }
      sources.push(readable);
    }
    return sourceMap.get(url)!;
  }
  function note(input: string): number {
    if (!noteMap.has(input)) { noteMap.set(input, notes.length); notes.push(input); }
    return noteMap.get(input)!;
  }
  function date(input: string | undefined) {
    const value = input ?? "未知";
    if (!dateMap.has(value)) { dateMap.set(value, dates.length); dates.push(value); }
    return dateMap.get(value)!;
  }
  function metadata(input: CompetitionMetadataSource | undefined) {
    if (!input) return null;
    const value = [source(input.url), intern(sourceKinds, input.sourceType), date(input.verifiedAt)], key = JSON.stringify(value);
    if (!sourceRecordMap.has(key)) {
      const packed = [...value];
      if (packed[2] === 0) { packed.pop(); if (packed[1] === 0) packed.pop(); }
      sourceRecordMap.set(key, sourceRecords.length); sourceRecords.push(packed);
    }
    return sourceRecordMap.get(key)!;
  }
  const entries = all.map(competition => {
    const r = competition.recommendation, e = r.eligibility, records = grouped.get(competition.id) ?? [];
    const reviewedLabels = (r.tracks ?? []).map(item => item.label);
    const recordTrackName = (name: string) => originals.get(competition.id) !== competition && !reviewedLabels.includes(name)
      ? `历史归档 · ${name}` : name;
    const tracks = unique([...reviewedLabels, ...records.map(item => recordTrackName(item.track.name))])
      .filter(item => !["系列概览", "待核验路径", "赛事系列概览", "系列探索路径", "系列概览，赛道待核验"].includes(item));
    const qualificationNoteIds = e?.notes.map(note) ?? [];
    const unknownNoteIds = (e?.blockingClarifications ?? []).map(note).filter(id => !qualificationNoteIds.includes(id));
    const eligibility = e ? {
      state: e.state, fullTime: e.requiresFullTime, fullTimeStages: e.requiresFullTimeStages?.map(item => labels[item] ?? item),
      enrolled: e.requiresCurrentEnrollment, sameSchool: e.sameInstitutionTeam, majors: e.allowedMajorFields,
      notes: qualificationNoteIds, unknown: unknownNoteIds.length ? unknownNoteIds : undefined,
      stageExceptions: e.stageClarificationNotes, partTimeExceptions: e.partTimeStageClarificationNotes,
      firstYear: e.firstHigherEducationYearCutoff ? {
        edition: e.firstHigherEducationYearCutoff.contestCycle, minimumYear: e.firstHigherEducationYearCutoff.minimumYear,
        alternativeBirthYear: e.firstHigherEducationYearCutoff.alternativeMinimumBirthYear,
        rule: e.firstHigherEducationYearCutoff.determinationRule, petition: e.firstHigherEducationYearCutoff.petitionAvailable,
        notes: e.firstHigherEducationYearCutoff.notes.map(note), source: metadata(e.firstHigherEducationYearCutoff.source)
      } : undefined,
      source: metadata(e.source)
    } : { state: "unknown" };
    const scopedRules: ScopedMaterial[] = records.filter(record => record.eligibilityRules?.length || record.cost).map(record => ({
      track: recordTrackName(record.track.name), edition: record.edition, group: record.group,
      rules: record.eligibilityRules?.map(rule => [rule.field, rule.operator, rule.value, ...(redundantRuleNotes.has(rule.note) ? [] : [note(rule.note)])]),
      cost: record.cost ? { personalMinCny: record.cost.minimumPersonalCny, personalMaxCny: record.cost.maximumPersonalCny, scope: record.cost.scope, note: note(record.cost.note) } : undefined,
      evidence: unique(record.facts.filter(fact => record.eligibilityRules?.some(rule => rule.factIds.includes(fact.id)) || record.cost?.factIds.includes(fact.id))
        .flatMap(fact => fact.sourceIds.map(id => {
          const item = record.sources.find(candidate => candidate.id === id);
          return item ? [source(item.url), intern(evidenceKinds, fact.kind), intern(evidenceStates, fact.status), date(fact.checkedAt ?? undefined), note(fact.scope)] : null;
        })).filter(Boolean))
    }));
    const team = r.teamRequirement.state === "known" ? [r.teamRequirement.mode, r.teamRequirement.minSize ?? "未知", r.teamRequirement.maxSize ?? "未知"] : r.teamRequirement.state;
    for (const track of r.tracks ?? []) {
      const stageOverride = track.stages && JSON.stringify(track.stages) !== JSON.stringify(r.stages);
      const teamOverride = track.teamRequirement && JSON.stringify(track.teamRequirement) !== JSON.stringify(r.teamRequirement);
      const flags = (["requiresFullTime", "requiresCurrentEnrollment", "sameInstitutionTeam"] as const).filter(field => track[field] !== undefined && track[field] !== e?.[field]);
      if (!(stageOverride || teamOverride || flags.length || track.eligibilityNotes?.length || track.blockingClarifications?.length)) continue;
      scopedRules.push({ track: track.label, edition: track.document?.title ?? "以赛道来源为准", group: "赛道范围，不能升级为全赛事限制",
        rules: [
          ...(stageOverride && track.stages ? [["stage", "in", audiences(track.stages)]] : []),
          ...(teamOverride && track.teamRequirement ? [["team", "eq", track.teamRequirement.state === "known" ? [track.teamRequirement.mode, track.teamRequirement.minSize ?? "未知", track.teamRequirement.maxSize ?? "未知"] : track.teamRequirement.state]] : []),
          ...flags.map(field => [field, "eq", track[field]]),
          ...[...(track.eligibilityNotes ?? []), ...(track.blockingClarifications ?? [])].map(text => ["qualification", "requires_confirmation", "见说明", note(text)])
        ], cost: undefined, evidence: track.document ? [[source(track.document.url), intern(evidenceKinds, "official_fact"), intern(evidenceStates, "按来源届次"), date(r.source?.verifiedAt), note(track.document.scope)]]
          : (r.supportingSources ?? []).filter(item => item.evidenceRef && item.evidenceRef === track.evidenceRef).map(item => [source(item.url), intern(evidenceKinds, "official_fact"), intern(evidenceStates, "按来源届次"), date(item.verifiedAt), note(`仅所引${track.label}赛道范围`)]) });
    }
    const sourceRefs = unique([metadata(r.source), metadata(e?.source), metadata({ url: competition.sourceUrl, sourceType: r.source?.sourceType ?? "unknown", verifiedAt: r.source?.verifiedAt }), metadata({ url: r.schedule.sourceUrl, sourceType: r.schedule.sourceType, verifiedAt: r.schedule.verifiedAt }),
      ...(r.supportingSources ?? []).filter(item => item.facts?.some(field => ["stages", "eligibility", "teamRequirement", "requiredResources", "participationMode"].includes(field))).map(metadata)
    ].filter(value => value !== null));
    const schedule = r.schedule.state === "unknown" && !r.schedule.edition && !r.schedule.registrationStart && !r.schedule.registrationEnd && !r.schedule.competitionStart && !r.schedule.competitionEnd
      ? date(r.schedule.verifiedAt) : [r.schedule.state, r.schedule.edition ?? "未知", r.schedule.registrationStart ?? null, r.schedule.registrationEnd ?? null, r.schedule.competitionStart ?? null, r.schedule.competitionEnd ?? null, date(r.schedule.verifiedAt)];
    const { state, notes: qualificationNotes, source: qualificationSource, ...extraQualification } = eligibility as Record<string, unknown>;
    return [competition.id, competition.name, competition.identity.aliases.filter(alias => alias !== competition.name), competition.summary, tracks,
      intern(preparationValues, [r.preferredOutputs.map(item => labels[item] ?? item).join("/"), (r.requiredResources ?? []).map(item => labels[item] ?? item).join("/")]),
      intern(audienceValues, audiences(r.stages)), intern(teamValues, team), intern(modeValues, r.participationModes.map(item => labels[item] ?? item)),
      [eligibilityStates.indexOf(String(state)), qualificationNotes ?? [], qualificationSource ?? null, intern(qualificationValues, extraQualification)],
      schedule, sourceRefs, scopedRules.map(scope => [tracks.indexOf(scope.track), note(scope.edition), note(scope.group), scope.rules?.map(rule => [intern(ruleFields, String(rule[0])), intern(ruleOperators, String(rule[1])), ...rule.slice(2)]),
        scope.cost ? [scope.cost.personalMinCny, scope.cost.personalMaxCny, note(scope.cost.scope), scope.cost.note] : null,
        scope.evidence.map(evidence => {
          const item = evidence as unknown[], packed = [item[0], item[4], item[3], item[1], item[2]];
          if (packed[4] === 0) { packed.pop(); if (packed[3] === 0) packed.pop(); }
          return packed;
        })])];
  });
  const localized = localizeDiscoveryMaterials(entries, notes, sourceRecords, qualificationValues, sources);
  const conditionLabels: Record<string, string> = { fullTime: "要求全日制", fullTimeStages: "全日制适用学段", enrolled: "要求在籍", sameSchool: "必须同校组队", majors: "专业范围" };
  const feePlaceholders = new Set(["报名费及收费环节待核实。", "所选赛道报名费、阶段费用及个人总费用待核。"]);
  const inlineEntries = localized.entries.map(original => {
    const entry = structuredClone(original), qualification = entry[9] as unknown[];
    entry[5] = structuredClone(preparationValues[Number(entry[5])]);
    entry[6] = audienceValues[Number(entry[6])];
    entry[7] = structuredClone(teamValues[Number(entry[7])]);
    entry[8] = structuredClone(modeValues[Number(entry[8])]);
    qualification[0] = eligibilityStates[Number(qualification[0])];
    qualification[3] = Object.fromEntries(Object.entries(localized.qualificationConditions[Number(qualification[3])]).map(([key, value]) => [conditionLabels[key] ?? key, value]));
    const schedule = entry[10];
    entry[10] = Array.isArray(schedule) ? schedule.map((value, index) => index === 6 ? dates[Number(value)] : typeof value === "string" && /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value)
      : ["unknown", "未知", null, null, null, null, dates[Number(schedule)]];
    const localSources = entry[11] as (string | unknown[])[];
    entry[11] = localSources.map(value => typeof value === "string" ? value : [value[0], sourceKinds[Number(value[1] ?? 0)], dates[Number(value[2] ?? 0)]]);
    for (const scope of entry[12] as unknown[][]) {
      for (const rule of (scope[3] as unknown[][] | null) ?? []) { rule[0] = ruleFields[Number(rule[0])]; rule[1] = ruleOperators[Number(rule[1])]; }
      for (const evidence of scope[5] as unknown[][]) { evidence[2] = dates[Number(evidence[2])]; evidence[3] = evidenceKinds[Number(evidence[3] ?? 0)]; evidence[4] = evidenceStates[Number(evidence[4] ?? 0)]; }
    }
    const renderedSources = entry[11] as (string | unknown[])[];
    const feeFacts: Record<string, unknown>[] = [], seen = new Set<string>();
    for (const record of grouped.get(String(entry[0])) ?? []) for (const fact of record.facts) {
      if (fact.field !== "fee" || feePlaceholders.has(fact.text)) continue;
      const matchedSources = fact.sourceIds.map(id => {
        const source = record.sources.find(value => value.id === id);
        if (!source) throw new Error("discovery_catalog_fact_source_invalid");
        return source;
      });
      const originalValue = { id: fact.id, text: fact.text, scope: fact.scope, kind: fact.kind, status: fact.status,
        reviewStatus: fact.reviewStatus, checkedAt: fact.checkedAt, lastVerifiedAt: fact.lastVerifiedAt,
        sources: matchedSources.map(source => ({ sourceId: source.id, url: source.url, title: source.title, publisher: source.publisher,
          authority: source.authority, scope: source.scope, checkedAt: source.checkedAt, publishedAt: source.publishedAt,
          accessStatus: source.accessStatus, verificationMethod: source.verificationMethod, integrity: source.integrity })) };
      const key = JSON.stringify(originalValue);
      if (seen.has(key)) continue;
      seen.add(key);
      const feeSources = originalValue.sources.map(source => {
        const canonical = safeDiscoveryUrl(source.url);
        if (!canonical) throw new Error("discovery_catalog_fact_source_invalid");
        let url = canonical;
        try { url = decodeURI(canonical).replace(/\s/gu, value => encodeURIComponent(value)); } catch { /* Preserve the validated URL. */ }
        let localSource = renderedSources.findIndex(value => safeDiscoveryUrl(String(typeof value === "string" ? value : value[0])) === canonical);
        if (localSource < 0) { localSource = renderedSources.length; renderedSources.push(url); }
        return { ...source, url, localSource };
      });
      feeFacts.push({ ...originalValue, sources: feeSources });
    }
    // Repeated field names cost tokens too. Tuples retain every original fact
    // and source value; their explicit column names are sent once below.
    entry.push(feeFacts.map(fact => DISCOVERY_FEE_FACT_COLUMNS.map(key => key === "sources"
      ? (fact.sources as Record<string, unknown>[]).map(item => DISCOVERY_FEE_SOURCE_COLUMNS.map(field => item[field] ?? null))
      : fact[key] ?? null)));
    const competition = all.find(item => item.id === entry[0])!;
    const localNotes = entry[13] as string[], tracks = entry[4] as string[];
    const taskRows = (competition.recommendation.tracks ?? []).filter(item => item.taskSummary).map(item => {
      let sourceIndex: number | null = null, scopeIndex: number | null = null;
      if (item.document) {
        const url = safeDiscoveryUrl(item.document.url);
        if (!url) throw new Error("discovery_catalog_track_source_invalid");
        sourceIndex = renderedSources.findIndex(value => safeDiscoveryUrl(String(typeof value === "string" ? value : value[0])) === url);
        if (sourceIndex < 0) {
          const provenance = competition.recommendation.supportingSources?.find(value => value.evidenceRef === item.evidenceRef);
          sourceIndex = renderedSources.length;
          renderedSources.push(provenance ? [url, provenance.sourceType, provenance.verifiedAt ?? "未知"] : url);
        }
        scopeIndex = localNotes.indexOf(item.document.scope);
        if (scopeIndex < 0) { scopeIndex = localNotes.length; localNotes.push(item.document.scope); }
      }
      return [tracks.indexOf(item.label), item.taskSummary, sourceIndex, scopeIndex];
    });
    const originalCompetition = originals.get(competition.id)!;
    const archivedMaterials = originalCompetition === competition ? null : {
      notice: "仅历史归档：以下是更新前目录原值与来源，保留追溯；可能含旧误标，不作无条件现行结论。按原届次和赛道理解，新复核也不覆盖明确不同届次材料；未标届规则不得升为2026/2027当届资格。",
      eligibility: originalCompetition.recommendation.eligibility && {
        ...Object.fromEntries(Object.entries(originalCompetition.recommendation.eligibility).filter(([key]) => key !== "source")),
        source: originalCompetition.recommendation.eligibility.source.url,
      },
      audience: audiences(originalCompetition.recommendation.stages),
      team: originalCompetition.recommendation.teamRequirement,
      schedule: originalCompetition.recommendation.schedule,
      tracks: (originalCompetition.recommendation.tracks ?? []).map(item => [item.label, item.stages ? audiences(item.stages) : null,
        item.teamRequirement ?? null, item.requiresFullTime ?? null, item.requiresCurrentEnrollment ?? null, item.sameInstitutionTeam ?? null,
        item.eligibilityNotes ?? [], item.blockingClarifications ?? []]),
    };
    entry.push(taskRows, `/competitions/${competition.id}`, archivedMaterials, discoveryCriticalScopeNotes(competition.id));
    return entry;
  });
  const text = JSON.stringify({ schemaVersion: DISCOVERY_CATALOG_SCHEMA_VERSION, version: COMPETITION_CATALOG_VERSION,
    boundary: "全量系列与既有事实材料，不是完整规则原文。aliases只列不同于name的别名。task/editorialPreparation为编辑分析，不是官方认定。资格、赛道、费用和来源只在原届次、赛项、组别、学校及地区范围内适用，不合并为全赛事当届资格。历史或未知不等于当前可报名；缺字段不表示不限、免费或全程线上。所有来源和说明只在本赛事内引用；资料核验日期不是本轮联网记录。旧库费用线索保留未复核与未知状态，不推个人必付额、不自行分摊或假定资助。",
    formats: {"dictionaries": "全部学段、队伍、参加方式、编辑准备、资格、日期、来源性质和规则字段均在本行直接写明，不需跨赛事数字字典。只有同一赛事内localSources/localNotes使用局部引用。", "eligibility": "[资料状态,完整资格说明,本行localSources资格来源编号,明确资格要求对象,可选特殊条件]；要求全日制/要求在籍/必须同校组队的false表示不要求该条件，不是学生属性；未列字段未知。保留全日制适用学段、专业范围及全部例外，不能把限定学段的要求扩大到全赛事。firstYear.source也仅查本行localSources。", "team": "[个人/团队/either,最少人数,最多人数]或unknown/unrestricted；人数是范围不是固定值，最少1表示不能仅凭此强制找队友。未知不表示不限。", "schedule": "[状态,届次,报名开始,报名结束,比赛开始,比赛结束,资料核验日期]；null日期未知，核验日期不是赛期，不自动升级历史窗口为当届。", "source": "localSources中的数组=[URL,来源性质,核验日期]；单独URL字符串仅是网址，不额外声明发布方/核验时间。资格与evidence编号只查本行，不跨赛事。", "scopedRules": "每项=[本行tracks下标(-1为系列范围),届次,组别,条件数组,费用,evidence]；条件=[字段,操作,值,可选本行localNotes下标]；费用=[个人下限或null,个人上限或null,适用范围localNotes下标,完整说明localNotes下标]；evidence=[本行localSources下标(只取URL),范围localNotes下标,核验日,事实性质,状态]。条件只限该赛道；届次null=按该赛道来源，组别null=不可升全赛事。“本赛事”指本行name。", "editorialPreparation": "[可能成果,编辑准备资源标签]；均为平台分析，不是已确认的官方必需条件，不是学生已具备的资源。空白资源不表示确认不需要资源。", "legacyFeeFacts": "原fee fact全文、完整scope含届次、kind/status/reviewStatus/checkedAt/lastVerifiedAt及全部原来源元数据逐条保留。pending_review/imported_unrechecked/legacy_import不代表本轮或当届已核；official_fact仅为原分类。sources.localSource只借本行URL，旧来源核验性质以本条sources元数据为准，不继承其他元数据。〔n〕为原表脚注，准确URL已绑定该条sources，不是localSources下标。按人/队/单位/赛段及学校地区范围不得扩用。个人实际承担、报销与完整总费用除原文明示外仍未知；空数组只表示没有非占位费用线索，绝非免费。"},
    legacyFeeFactColumns: DISCOVERY_FEE_FACT_COLUMNS, legacyFeeSourceColumns: DISCOVERY_FEE_SOURCE_COLUMNS,
    extraFormats: {
      trackTasks: "[本行tracks下标,任务说明,本行localSources编号或null,本行localNotes范围编号或null]。任务说明是基于所引官方方向的编辑分析，不证明学生能力，也不是官方强制交付物；资格只按对应scopedRules和来源范围。",
      detailPath: "本站已存在赛事的稳定详情路径，只能逐字复制本行路径；库外赛事没有本站详情，不拼猜ID。",
      archivedMaterials: "复核条目更新前的历史材料，保留原值和来源；与同范围已复核更正冲突时不作现行依据，不同明确届次分别保留。tracks=[旧名称,学段,队伍,全日制,在籍,同校,旧规则,旧待核]，null为未提供。",
      criticalScopeNotes: "本行已核实的重要范围与时间边界，须与该行资格/赛道一起理解；不是额外资格要求。未知结束时间、毕业例外、博士替代学历通道均不可忽略；不外推届次或其他赛道。",
      legacyFeeFacts: "每条按legacyFeeFactColumns排列，sources按legacyFeeSourceColumns排列，来源URL查该项localSource所指的本行localSources（不重复网址）。与原对象同义，null为未提供；状态、原文、范围及全部来源元数据均保留，来源编号只限本赛事。",
    },
    columns: DISCOVERY_CATALOG_COLUMNS, entries: inlineEntries });
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > (options.maxBytes ?? DISCOVERY_CATALOG_MAX_BYTES)) throw Object.assign(new Error("discovery_catalog_context_too_large"), { reason: "application_material_bytes", applicationLimitBytes: options.maxBytes ?? DISCOVERY_CATALOG_MAX_BYTES });
  const clarifyText = JSON.stringify({ columns: ["id", "name", "task", "tracks", "audience"], entries: entries.map(entry => [entry[0], entry[1], entry[3], entry[4], audienceValues[entry[6] as number]]) });
  return { version: COMPETITION_CATALOG_VERSION, count: ids.length, ids, sha256: createHash("sha256").update(text).digest("hex"), text, clarifyText, byteLength };
}
