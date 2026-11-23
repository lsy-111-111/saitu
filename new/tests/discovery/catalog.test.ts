import { describe, expect, it } from "vitest";
import { findCanonicalCatalogCompetition, getCompetitionCatalog } from "@/lib/competitions/catalog";
import { INNOVATION_2026_SOURCES, REVIEWED_SCOPE_SOURCES, reviewedDiscoveryCompetition } from "@/content/competition-innovation-2026";
import { getDecisionCatalog } from "@/lib/competitions/v6/catalog";
import { makeDiscoveryCatalogSnapshot, safeDiscoveryUrl } from "@/lib/competitions/discovery/catalog";

type Material = { columns: string[]; entries: unknown[][]; legacyFeeFactColumns: string[]; legacyFeeSourceColumns: string[] };
type LocalSource = string | [string, string, string];
const isoDate = (value: string) => /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
function rowOf(payload: Material, id: string) { return payload.entries.find(entry => entry[0] === id)!; }
function localSourcesOf(payload: Material, entry: unknown[]) { return entry[payload.columns.indexOf("localSources")] as LocalSource[]; }
function localUrlOf(payload: Material, entry: unknown[], index: number) {
  const source = localSourcesOf(payload, entry)[index];
  return safeDiscoveryUrl(typeof source === "string" ? source : source[0]);
}
function feeFactsOf(payload: Material, entry: unknown[]) {
  return (entry[payload.columns.indexOf("legacyFeeFacts")] as unknown[][]).map(values => {
    const fact = Object.fromEntries(payload.legacyFeeFactColumns.map((key, index) => [key, values[index]]));
    const sources = (fact.sources as unknown[][]).map((values): Record<string, unknown> => {
      const source = Object.fromEntries(payload.legacyFeeSourceColumns.map((key, index) => [key, values[index]]));
      return { ...source, url: localUrlOf(payload, entry, Number(source.localSource)) };
    });
    return { ...fact, id: String(fact.id), text: String(fact.text), scope: String(fact.scope), kind: String(fact.kind), status: String(fact.status), sources };
  });
}
function qualificationOf(payload: Material, entry: unknown[]) {
  const qualification = entry[payload.columns.indexOf("eligibility")] as [string, string[], number | null, Record<string, unknown>, Record<string, unknown>?];
  const sources = localSourcesOf(payload, entry);
  const source = (index: number | null) => {
    if (index === null) return null;
    const material = sources[index];
    if (typeof material === "string") throw new Error("qualification must reference its actual metadata, not a URL-only scope pointer");
    return { url: safeDiscoveryUrl(material[0]), kind: material[1], checkedAt: isoDate(material[2]) };
  };
  const labels: Record<string, string> = { "要求全日制": "fullTime", "全日制适用学段": "fullTimeStages", "要求在籍": "enrolled", "必须同校组队": "sameSchool", "专业范围": "majors" };
  const extra = { ...Object.fromEntries(Object.entries(qualification[3]).map(([key, value]) => [labels[key] ?? key, value])), ...(qualification[4] ?? {}) };
  return { state: qualification[0], notes: qualification[1], source: source(qualification[2]), extra, resolveSource: source };
}


describe("discovery full catalog context", () => {
  it("includes every current series, the last entry, provenance and historical boundaries without the old matching gate", () => {
    const all = getCompetitionCatalog(), snapshot = makeDiscoveryCatalogSnapshot();
    const payload = JSON.parse(snapshot.text) as Material;
    expect(snapshot.ids).toEqual(all.map(item => item.id).sort((a, b) => a.localeCompare(b)));
    expect(payload.entries.map(item => item[0])).toEqual(snapshot.ids);
    expect(snapshot.count).toBe(all.length);
    expect(snapshot.ids).toContain(all[all.length - 1].id);
    expect(snapshot.byteLength).toBe(Buffer.byteLength(snapshot.text));
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.entries.every(entry => localSourcesOf(payload, entry).length > 0)).toBe(true);
    expect(payload.entries.some(entry => (entry[12] as unknown[][]).some(scope => (scope[5] as unknown[][]).some(evidence => evidence[4] === "historical")))).toBe(true);
    expect(payload.entries.every(entry => localSourcesOf(payload, entry).every(source => safeDiscoveryUrl(typeof source === "string" ? source : source[0])))).toBe(true);
    expect(payload.entries.some(entry => Boolean(qualificationOf(payload, entry).extra.firstYear))).toBe(true);
    expect(snapshot.text).not.toMatch(/"(?:goalValues|credibility|dataCompleteness|coverImage|sourceRecords|qualificationValues)"/);
    expect(payload).not.toHaveProperty("notes");
    expect(payload).not.toHaveProperty("sources");
    expect(payload.columns).toContain("localNotes");
    expect(payload.columns).toContain("legacyFeeFacts");
    expect(payload.columns).toContain("trackTasks");
    expect(payload.columns).toContain("detailPath");
    for (const dictionary of ["audienceValues", "teamValues", "modeValues", "preparationValues", "qualificationConditions", "eligibilityStates", "dates", "sourceKinds", "ruleFields", "ruleOperators"]) expect(payload).not.toHaveProperty(dictionary);
    expect(JSON.parse(snapshot.clarifyText).entries.map((entry: unknown[]) => entry[0])).toEqual(snapshot.ids);
    expect(JSON.parse(snapshot.clarifyText).entries.every((entry: unknown[]) => typeof entry[4] === "string")).toBe(true);
  });

  it("rejects duplicates and oversized contexts instead of silently dropping entries", () => {
    const first = getCompetitionCatalog()[0];
    expect(() => makeDiscoveryCatalogSnapshot({ competitions: [first, first], records: [] })).toThrow("discovery_catalog_duplicate_id");
    expect(() => makeDiscoveryCatalogSnapshot({ maxBytes: 1 })).toThrow("discovery_catalog_context_too_large");
    expect(() => makeDiscoveryCatalogSnapshot({ competitions: [{ ...first, id: "../outside" }], records: [] })).toThrow("discovery_catalog_invalid_id");
  });

  it("gives every current series one real canonical detail path and scoped task descriptions", () => {
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    for (const entry of payload.entries) {
      const detailPath = entry[payload.columns.indexOf("detailPath")];
      expect(detailPath).toBe(`/competitions/${entry[0]}`);
      expect(findCanonicalCatalogCompetition(String(entry[0]))).not.toBeNull();
      const competition = reviewedDiscoveryCompetition(findCanonicalCatalogCompetition(String(entry[0]))!);
      const tasks = entry[payload.columns.indexOf("trackTasks")] as [number, string, number | null, number | null][];
      for (const track of (competition.recommendation.tracks ?? []).filter(value => value.taskSummary)) {
        const task = tasks.find(value => (entry[4] as string[])[value[0]] === track.label)!;
        expect(task?.[1], `${competition.id}/${track.id}`).toBe(track.taskSummary);
        if (track.document) {
          expect(localUrlOf(payload, entry, task[2]!)).toBe(safeDiscoveryUrl(track.document.url));
          expect((entry[13] as string[])[task[3]!]).toBe(track.document.scope);
        }
      }
    }
  });

  it("uses reviewed 2026 innovation and eight entrepreneurship tracks while archiving superseded qualifications", () => {
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    for (const id of ["china-international-college-innovation", "challenge-cup-entrepreneurship-plan"]) {
      const original = findCanonicalCatalogCompetition(id)!;
      const row = rowOf(payload, id);
      const archive = row[payload.columns.indexOf("archivedMaterials")] as { notice: string; eligibility: { notes: string[] }; tracks: unknown[][] };
      expect(archive.notice).toContain("仅历史归档");
      expect(archive.eligibility.notes).toEqual(original.recommendation.eligibility!.notes);
      expect(archive.tracks.map(value => value[0])).toEqual(original.recommendation.tracks!.map(value => value.label));
      expect(qualificationOf(payload, row).source?.checkedAt).toBe("2026-11-20");
    }
    const innovation = rowOf(payload, "china-international-college-innovation");
    const tasks = innovation[payload.columns.indexOf("trackTasks")] as unknown[][];
    expect(tasks).toHaveLength(11);
    expect((innovation[4] as string[])).toContain("高教主赛道 · 新文科");
    expect((innovation[4] as string[])).toContain("红旅赛道 · 公益组");
    expect(qualificationOf(payload, innovation).notes.join("\n")).toContain("9月25日12时截止");
    expect(qualificationOf(payload, innovation).extra).not.toHaveProperty("fullTime");
    expect((innovation[13] as string[]).join("\n")).toContain("本科创意组负责人及成员均为全日制在校本专科生");
    expect(localSourcesOf(payload, innovation).some(value => safeDiscoveryUrl(typeof value === "string" ? value : value[0]) === INNOVATION_2026_SOURCES.higher)).toBe(true);
    const challenge = rowOf(payload, "challenge-cup-entrepreneurship-plan");
    expect(challenge[payload.columns.indexOf("trackTasks")]).toHaveLength(8);
    expect(challenge[4]).toContain("主体赛 · 国际交流合作");
    expect(challenge[4]).not.toContain("已创业类");
    expect(challenge[7]).toEqual(["team", "未知", "未知"]);
    expect((challenge[10] as unknown[]).slice(4, 6)).toEqual(["2026-10-30", "2026-11-02"]);
    expect(qualificationOf(payload, challenge).notes.join("\n")).toContain("创业计划小挑");
    expect(qualificationOf(payload, challenge).source?.url).toBe(INNOVATION_2026_SOURCES.challenge);
  });

  it("retains complete qualifications, explicit false values, their own sources and all calendar dates", () => {
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    for (const competition of getCompetitionCatalog().map(reviewedDiscoveryCompetition)) {
      const row = rowOf(payload, competition.id), retained = qualificationOf(payload, row), original = competition.recommendation.eligibility;
      const notes = new Set([...retained.notes, ...(retained.extra.unknown as string[] | undefined ?? [])]);
      for (const note of [...(original?.notes ?? []), ...(original?.blockingClarifications ?? [])]) expect(notes.has(note), `${competition.id}: ${note}`).toBe(true);
      for (const [sourceKey, retainedKey] of [["requiresFullTime", "fullTime"], ["requiresCurrentEnrollment", "enrolled"], ["sameInstitutionTeam", "sameSchool"]] as const) {
        if (original?.[sourceKey] !== undefined) expect(retained.extra[retainedKey], `${competition.id}: ${sourceKey}`).toBe(original[sourceKey]);
      }
      if (original?.source) expect(retained.source).toEqual({ url: safeDiscoveryUrl(original.source.url), kind: original.source.sourceType, checkedAt: original.source.verifiedAt ?? "未知" });
      if (original?.firstHigherEducationYearCutoff) {
        const firstYear = retained.extra.firstYear as { minimumYear: number; alternativeBirthYear: number; rule: string; petition: boolean; notes: string[]; source: number };
        const expected = original.firstHigherEducationYearCutoff;
        expect(firstYear).toMatchObject({ minimumYear: expected.minimumYear, alternativeBirthYear: expected.alternativeMinimumBirthYear, rule: expected.determinationRule, petition: expected.petitionAvailable, notes: expected.notes });
        expect(retained.resolveSource(firstYear.source)?.url).toBe(safeDiscoveryUrl(expected.source.url));
      }
      const schedule = row[payload.columns.indexOf("schedule")];
      if (Array.isArray(schedule)) for (const [index, field] of [[2, "registrationStart"], [3, "registrationEnd"], [4, "competitionStart"], [5, "competitionEnd"]] as const) {
        const value = schedule[index];
        expect(typeof value === "string" ? isoDate(value) : value).toBe(competition.recommendation.schedule[field] ?? null);
      }
    }
  });

  it("does not turn the innovation registration deadline into an event end or red-track conditions into main-track conditions", () => {
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    const row = rowOf(payload, "china-international-college-innovation");
    const boundary = (row[payload.columns.indexOf("criticalScopeNotes")] as string[]).join("\n");
    expect(boundary).toContain("未核实是否结束");
    expect(boundary).toContain("高教主赛道不要求参加红旅活动");
    expect((row[10] as unknown[])[5]).toBeNull();
    const reviewed = reviewedDiscoveryCompetition(findCanonicalCatalogCompetition(String(row[0]))!);
    expect(reviewed.recommendation.eligibility?.blockingClarifications?.join("\n")).toContain("仅在推荐红旅赛道时");
    for (const track of reviewed.recommendation.tracks!.filter(track => track.id.startsWith("higher-"))) {
      expect(track.document?.scope).toContain("国内研究生创意组负责人须全日制在校研究生");
      expect(track.document?.scope).toContain("成员须全日制在校研究生或本专科生");
      expect(track.document?.scope).toContain("不能反向放宽国内项目");
      expect(track.document?.url).toBe(INNOVATION_2026_SOURCES.higherFull);
    }
  });

  it("keeps the common red-track applicant condition across all groups without excluding every part-time team role", () => {
    const reviewed = reviewedDiscoveryCompetition(findCanonicalCatalogCompetition("china-international-college-innovation")!);
    const redTracks = reviewed.recommendation.tracks!.filter(track => track.id.startsWith("red-"));
    expect(redTracks).toHaveLength(3);
    for (const track of redTracks) {
      expect(track.document?.url).toBe(INNOVATION_2026_SOURCES.higherFull);
      expect(track.document?.scope).toContain("附件2第17—19页");
      const notes = track.eligibilityNotes!.join("\n");
      expect(notes).toContain("三组共同的申报负责人条件");
      expect(notes).toContain("毕业5年内的全日制学历学生");
      expect(notes).toContain("国家开放大学学历教育学生另有通道");
      expect(notes).toContain("不直接推定所有成员须全日制");
      expect(track.requiresFullTime).not.toBe(true);
    }
    expect(redTracks[0].eligibilityNotes!.join("\n")).toContain("公益项目登记豁免不等于负责人学籍豁免");
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    const row = rowOf(payload, "china-international-college-innovation");
    const boundary = (row[payload.columns.indexOf("criticalScopeNotes")] as string[]).join("\n");
    expect(boundary).toContain("当前非全日制在读不能单独排除");
    expect(boundary).toContain("不得仅凭当前非全日制学籍断言所有红旅角色或整项赛事都不符合");
    expect(qualificationOf(payload, row).extra).not.toHaveProperty("fullTime");
  });

  it("uses the actual 2026 Milan student groups without excluding the graduates they explicitly accept", () => {
    const original = findCanonicalCatalogCompetition("milan-design-week-china")!;
    const reviewed = reviewedDiscoveryCompetition(original);
    expect(reviewed.recommendation.teamRequirement).toEqual({ state: "unknown" });
    expect(reviewed.recommendation.tracks!.map(track => track.label)).toEqual([
      "2026本科生研究生组（含毕业5年内）", "2026高职高专学生组（含毕业5年内）",
    ]);
    expect(reviewed.recommendation.eligibility?.requiresCurrentEnrollment).not.toBe(true);
    for (const track of reviewed.recommendation.tracks!) {
      expect(track.eligibilityNotes?.join("\n")).toContain("毕业5年内");
      expect(track.requiresCurrentEnrollment).not.toBe(true);
      expect(track.document?.url).toBe(REVIEWED_SCOPE_SOURCES.milan);
    }
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    const row = rowOf(payload, original.id);
    const archived = row[payload.columns.indexOf("archivedMaterials")] as { tracks: unknown[][] };
    expect(archived.tracks.map(track => track[0])).toEqual(original.recommendation.tracks!.map(track => track.label));
    expect((row[payload.columns.indexOf("criticalScopeNotes")] as string[]).join("\n")).toContain("不能据此排除毕业生");
  });

  it("keeps undated academic-charter doctoral exceptions beside their applicable tracks while preserving the former record", () => {
    const original = findCanonicalCatalogCompetition("challenge-cup-academic-science")!;
    const reviewed = reviewedDiscoveryCompetition(original);
    expect(reviewed.recommendation.stages).toMatchObject({ state: "known" });
    if (reviewed.recommendation.stages.state === "known") expect(reviewed.recommendation.stages.values).not.toContain("doctorate");
    for (const track of reviewed.recommendation.tracks!) {
      expect(track.document?.title).toContain("未标届次");
      expect(track.document?.scope).toContain("不覆盖明确旧届PDF");
      const notes = track.eligibilityNotes!.join("\n");
      if (track.id === "natural-science-paper") expect(notes).toContain("作者仅限本专科");
      else {
        expect(notes).toContain("普通博士不是本赛道无条件符合者");
        expect(notes).toContain("未通过博士资格考试时按硕士申报");
        expect(notes).toContain("不能据此确认2026/2027资格");
      }
    }
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    const row = rowOf(payload, original.id);
    const archive = row[payload.columns.indexOf("archivedMaterials")] as { eligibility: { notes: string[] }; audience: string };
    expect(archive.eligibility.notes).toEqual(original.recommendation.eligibility!.notes);
    expect(archive.audience).toContain("博士");
  });

  it("exports the graduate modeling competition period from the invitation instead of its later PDF submission period", () => {
    const invitation = "https://cpipc.acge.org.cn/cw/contestNews/detail/4/2c9080189dcfa24e019dddacc24a1314?page=0";
    const competition = getCompetitionCatalog().find(item => item.id === "graduate-math-modeling")!;
    expect(competition.recommendation.schedule).toMatchObject({
      registrationStart: "2026-06-01", registrationEnd: "2026-09-19",
      competitionStart: "2026-09-23", competitionEnd: "2026-09-27",
      verifiedAt: "2026-11-20", sourceUrl: invitation, sourceType: "official-competition"
    });
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    const row = rowOf(payload, competition.id), schedule = row[payload.columns.indexOf("schedule")] as unknown[];
    expect(schedule.slice(2, 6)).toEqual(["2026-06-01", "2026-09-19", "2026-09-23", "2026-09-27"]);
    // Invitation section IV.4 separately places PDF upload on September 27–28.
    expect(schedule.slice(4, 6)).not.toEqual(["20260927", "20260928"]);
    expect(schedule[6]).toBe("2026-11-20");
    expect(localSourcesOf(payload, row).some(source => typeof source !== "string" && source[0] === invitation
      && source[1] === "official-competition" && source[2] === "2026-11-20")).toBe(true);
  });

  it("keeps exact decision rules and costs inside the correct series, track, edition and source scope", () => {
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    const currentIds = new Set(getCompetitionCatalog().map(item => item.id));
    for (const record of getDecisionCatalog().filter(item => currentIds.has(item.seriesId) && (item.eligibilityRules?.length || item.cost))) {
      const row = rowOf(payload, record.seriesId), localNotes = row[payload.columns.indexOf("localNotes")] as string[];
      const tracks = row[payload.columns.indexOf("tracks")] as string[], scopes = row[payload.columns.indexOf("scopedRules")] as unknown[][];
      const scope = scopes.find(value => tracks[Number(value[0])] === record.track.name && String(value[1]).replaceAll("本赛事", String(row[1])) === record.edition && String(value[2]).replaceAll("本赛事", String(row[1])) === record.group);
      expect(scope, record.recordId).toBeDefined();
      const actualRules = ((scope![3] as unknown[][] | null) ?? []).map(rule => ({ field: String(rule[0]), operator: String(rule[1]), value: rule[2] }));
      expect(actualRules).toEqual((record.eligibilityRules ?? []).map(({ field, operator, value }) => ({ field, operator, value })));
      if (record.cost) {
        const cost = scope![4] as [number | null, number | null, number, number];
        expect([cost[0], cost[1], localNotes[cost[2]], localNotes[cost[3]]]).toEqual([record.cost.minimumPersonalCny, record.cost.maximumPersonalCny, record.cost.scope, record.cost.note]);
      }
      const evidence = scope![5] as [number, number, string, string, string][];
      for (const fact of record.facts.filter(item => record.eligibilityRules?.some(rule => rule.factIds.includes(item.id)) || record.cost?.factIds.includes(item.id))) {
        for (const sourceId of fact.sourceIds) {
          const original = record.sources.find(item => item.id === sourceId)!;
          expect(evidence.some(item => localUrlOf(payload, row, item[0]) === safeDiscoveryUrl(original.url) && localNotes[item[1]] === fact.scope && isoDate(item[2]) === (fact.checkedAt ?? "未知")), `${record.recordId}: ${sourceId}`).toBe(true);
        }
      }
    }
  });

  it("places the two design competitions' different qualifications and exact evidence beside their own identities", () => {
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    const computer = qualificationOf(payload, rowOf(payload, "china-college-computer-design"));
    const creative = qualificationOf(payload, rowOf(payload, "china-good-design"));
    expect(computer.notes.join("\n")).toContain("同校2至9名本科生");
    expect(computer.notes.join("\n")).not.toContain("作者不超过8人");
    expect(computer.source?.url).toMatch(/^https:\/\/jsjds\.hdu\.edu\.cn\/.*\.pdf$/);
    expect(creative.notes.join("\n")).toContain("每件作品作者不超过8人，跨校合作最多3所院校");
    expect(creative.source?.url).toBe("https://www.cdec.org.cn/articleDetail/2283");
    expect(computer.extra).toMatchObject({ fullTime: true, enrolled: true, sameSchool: true });
    expect(localSourcesOf(payload, rowOf(payload, "china-good-design")).map((_, index) => localUrlOf(payload, rowOf(payload, "china-good-design"), index))).not.toContain("https://www.culsc.cn/");
  });

  it("keeps scope-only URLs in their owning series without inventing publisher metadata", () => {
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    let urlOnlyReferences = 0;
    for (const entry of payload.entries) {
      const sources = localSourcesOf(payload, entry), scopes = entry[payload.columns.indexOf("scopedRules")] as unknown[][];
      const referenced = new Set(scopes.flatMap(scope => (scope[5] as unknown[][]).map(item => Number(item[0]))));
      for (const fee of feeFactsOf(payload, entry)) for (const source of fee.sources) referenced.add(Number(source.localSource));
      for (const task of entry[payload.columns.indexOf("trackTasks")] as unknown[][]) if (task[2] !== null) referenced.add(Number(task[2]));
      for (const index of referenced) {
        expect(Number.isInteger(index) && index >= 0 && index < sources.length, String(entry[0])).toBe(true);
        expect(localUrlOf(payload, entry, index)).not.toBeNull();
      }
      for (const [index, source] of sources.entries()) if (typeof source === "string") {
        urlOnlyReferences += 1;
        expect(referenced.has(index), String(entry[0])).toBe(true);
      }
    }
    expect(urlOnlyReferences).toBeGreaterThan(0);
  });

  it("only accepts ordinary web source URLs", () => {
    expect(safeDiscoveryUrl("https://example.org/rules")).toBe("https://example.org/rules");
    expect(safeDiscoveryUrl("javascript:alert(1)")).toBeNull();
    expect(safeDiscoveryUrl("https://user:password@example.org/rules")).toBeNull();
    expect(safeDiscoveryUrl("/private/source.md")).toBeNull();
  });

  it("exposes meaningful fee facts with their original pending/unknown state, scope and accurate sources", () => {
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    const ids = new Set(getCompetitionCatalog().map(item => item.id));
    const placeholders = new Set(["报名费及收费环节待核实。", "所选赛道报名费、阶段费用及个人总费用待核。"]);
    for (const record of getDecisionCatalog().filter(item => ids.has(item.seriesId))) for (const fact of record.facts.filter(value => value.field === "fee" && !placeholders.has(value.text))) {
      const row = rowOf(payload, record.seriesId);
      const facts = feeFactsOf(payload, row);
      const retained = facts.find(value => value.id === fact.id && value.text === fact.text && value.scope === fact.scope && value.kind === fact.kind && value.status === fact.status)!;
      expect(retained, `${record.seriesId}: ${fact.text}`).toBeDefined();
      expect(retained).toMatchObject({ checkedAt: fact.checkedAt, lastVerifiedAt: fact.lastVerifiedAt, reviewStatus: fact.reviewStatus });
      expect(retained).not.toHaveProperty("minimumPersonalCny");
      expect(retained).not.toHaveProperty("maximumPersonalCny");
      for (const sourceId of fact.sourceIds) {
        const source = record.sources.find(value => value.id === sourceId)!;
        const result = retained.sources.find(value => value.sourceId === sourceId)!;
        expect(result).toMatchObject({ scope: source.scope, authority: source.authority, publisher: source.publisher, checkedAt: source.checkedAt,
          accessStatus: source.accessStatus, verificationMethod: source.verificationMethod, integrity: source.integrity });
        expect(safeDiscoveryUrl(result.url)).toBe(safeDiscoveryUrl(source.url));
        expect(localUrlOf(payload, row, Number(result.localSource))).toBe(safeDiscoveryUrl(source.url));
      }
    }
    const metallographic = feeFactsOf(payload, rowOf(payload, "metallographic-skills"));
    expect(metallographic.some(value => value.text.includes("500元") && value.text.includes("800元") && value.scope.includes("2027") && value.status === "pending_review")).toBe(true);
    const life = feeFactsOf(payload, rowOf(payload, "culsc-life-sciences"));
    expect(life.some(value => value.text.includes("400元") && value.kind === "unknown")).toBe(true);
    expect(life.some(value => value.text.includes("320元") && value.kind === "unknown")).toBe(true);
    expect(feeFactsOf(payload, rowOf(payload, "collegiate-welding")).some(value => value.text.includes("无须缴纳报名费"))).toBe(true);
  });

  it("keeps the corrected edition boundaries and clear full-time requirements directly in each row", () => {
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    const creativeSchedule = rowOf(payload, "china-good-design")[10] as unknown[];
    expect(String(creativeSchedule[1])).toContain("21");
    expect(creativeSchedule.slice(2, 6)).toEqual([null, null, null, null]);
    const cultureSchedule = rowOf(payload, "graduate-culture-china")[10] as unknown[];
    expect(cultureSchedule[3]).toBe("2026-09-13");
    const cultureQualification = rowOf(payload, "understanding-contemporary-china-foreign-language")[9] as unknown[];
    expect(cultureQualification[3]).toMatchObject({ "要求全日制": true });
    expect((cultureQualification[1] as string[]).join("\n")).toContain("全日制");
    for (const entry of payload.entries) {
      expect(typeof entry[6]).toBe("string");
      expect(Array.isArray(entry[5])).toBe(true);
      expect(Array.isArray(entry[8])).toBe(true);
      expect(typeof (entry[9] as unknown[])[0]).toBe("string");
      expect(typeof (entry[9] as unknown[])[3]).toBe("object");
    }
  });

  it("keeps classical-reading and handwriting eligibility in their distinct historical groups", () => {
    const source = "https://rwxy.huznu.edu.cn/2025/1118/c7008a242491/page.htm";
    const competition = getCompetitionCatalog().find(item => item.id === "chinese-classics")!;
    const payload = JSON.parse(makeDiscoveryCatalogSnapshot().text) as Material;
    const row = rowOf(payload, competition.id), qualification = qualificationOf(payload, row);
    const notes = qualification.notes.join("\n");

    const stages = competition.recommendation.stages;
    expect(stages).toMatchObject({ state: "known" });
    expect(stages.state === "known" ? stages.values : []).toContain("vocational");
    expect(notes).toContain("2025年第七届历史方案");
    expect(notes).toContain("诵读中国、诗教中国的职业学校学生组含中职、高职，大学生组含研究生");
    expect(notes).toContain("诵读除社会人员组外不得跨组");
    expect(notes).toContain("笔墨中国硬笔、毛笔的大学生组另含高职、研究生、留学生");
    expect(notes).toContain("不能把诵读的组别限制外推到整个大赛");
    expect(notes).toContain("诵读初赛由各省自定");
    expect(notes).toContain("邀请部分作品线下角逐一等奖，其余作品评其他奖");
    expect(notes).toContain("不表示全体须线下或已确认全程线上");
    expect(notes).toContain("诗教总决赛以现场比赛角逐一、二等奖");
    expect(notes).toContain("硬笔、毛笔决赛须寄送纸质作品");
    expect(notes).toContain("邮寄、材料及个人总费用待核");
    expect(notes).toContain("新届组别、选拔、参加方式及日期仍待核");
    expect(qualification.source).toEqual({ url: source, kind: "education-authority", checkedAt: "2026-11-20" });
    expect(localSourcesOf(payload, row)).toContainEqual([
      "https://www.moe.gov.cn/srcsite/A18/s3137/202503/t20250320_1183929.html",
      "education-authority",
      "2026-08-23"
    ]);
    expect(competition.recommendation.participationModes).toEqual(["unknown"]);
    expect(competition.recommendation.schedule).toMatchObject({ state: "unknown", verifiedAt: "2026-08-23" });
    expect((row[payload.columns.indexOf("schedule")] as unknown[]).slice(2, 6)).toEqual([null, null, null, null]);
  });
});
