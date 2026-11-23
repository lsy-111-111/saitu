import type { Competition, CompetitionMetadataSource, CompetitionTrackMetadata } from "./competitions";
import type { CompetitionStudentStage } from "@/types/competition-recommendation";

// Discovery-only evidence refresh: the published legacy ranking weights and
// record identities stay intact. The former metadata is archived in its row.
export const INNOVATION_2026_SOURCES = {
  notice: "https://www.moe.gov.cn/srcsite/A08/s5672/202607/t20260731_1445670.html",
  higher: "https://xxgk.dhu.edu.cn/_upload/article/files/10/91/bd9d5e844d5d840f20f3572295d9/8149f006-4449-4ecd-9589-d8bdf64cc83d.pdf",
  higherFull: "https://www.lzpu.edu.cn/upload/gcxlzx/contentmanage/article/file/2026/10/27/教育部关于举办中国国际大学生创新大赛（2026）的通知-教高函〔2026〕26号.pdf",
  red: "https://www.dhu.edu.cn/_upload/article/files/41/df/3a50d88f4e039479dd47100b171f/f1c11ac2-4026-41af-898c-ac347ec56f96.pdf",
  vocational: "https://2026ds.jlbtc.edu.cn/info/2065/16401.htm",
  industry: "https://ugs.hust.edu.cn/info/1142/7540.htm",
  challenge: "https://gaoxiao.tiaozhanbei.net/d1204/article/49690/",
  challengeFinal: "https://gach.dlut.edu.cn/info/1077/23155.htm",
} as const;

const checkedAt = "2026-11-20";
export const REVIEWED_SCOPE_SOURCES = {
  milan: "https://www.czu.cn/_t1006/2026/0323/c6a171373/page.htm",
  academic: "https://www.tiaozhanbei.net/rules",
} as const;
const college: CompetitionStudentStage[] = ["vocational", "undergraduate-1", "undergraduate-2", "undergraduate-3", "undergraduate-4"];
const university: CompetitionStudentStage[] = [...college, "master", "doctorate"];
const source = (key: keyof typeof INNOVATION_2026_SOURCES): CompetitionMetadataSource => ({
  url: INNOVATION_2026_SOURCES[key], sourceType: key === "challenge" || key === "challengeFinal" ? "organizer" : "education-authority",
  verifiedAt: checkedAt, evidenceRef: `reviewed:20261120:${key}`,
  facts: key === "challengeFinal" ? ["schedule", "participationMode"] : ["identity", "eligibility", "trackEligibility"],
});

function track(id: string, label: string, taskSummary: string, key: keyof typeof INNOVATION_2026_SOURCES,
  scope: string, rules: Partial<CompetitionTrackMetadata> = {}): CompetitionTrackMetadata {
  return { id, label, taskSummary, document: { title: `2026${label}官方资料`, url: INNOVATION_2026_SOURCES[key], scope },
    evidenceRef: source(key).evidenceRef, ...rules };
}

const higherScope = "教育部教高函〔2026〕26号附件1；类别是项目方向，不是排他专业资格。3—15人可跨校。国内本科创意组负责人及成员均为全日制在校本专科生；国内研究生创意组负责人须全日制在校研究生，成员须全日制在校研究生或本专科生（不含在职教育），非全日制不能套用。创意组在通知前未登记并有较成型原型或服务模式；创业组在通知前登记，负责人为法人且为对应全日制在校生或毕业5年内全日制学历学生，法人股权至少10%、团队合计至少1/3。港澳台及国际参赛项目可按当地教育情况适当调整学籍学历要求，不能反向放宽国内项目。成果归属、重复报赛及其他资格另核。";
const redApplicantQualification = "2026红旅附件2一（三）是三组共同的申报负责人条件：全日制在校本专科生或研究生（不含在职教育），或毕业5年内的全日制学历学生；国家开放大学学历教育学生另有通道。只限制申报负责人，不直接推定所有成员须全日制。当前非全日制在读不能单独排除其此前全日制学历毕业5年内或开放大学通道，替代条件未确认时保持待核。";
const redScope = `教育部教高函〔2026〕26号附件2第17—19页；须参加红旅活动，3—15人可跨校；${redApplicantQualification}公益、创意、创业三组另有项目性质与登记要求，公益组不豁免共同负责人条件。`;
const challengeScope = "第十五届组委会2026正式通知的主体赛；8个赛道按项目内容选择，不沿用旧5组或旧章程甲乙类分类；人数等未列条件保持待核。";
const innovationTracks: CompetitionTrackMetadata[] = [
  track("higher-engineering-2026", "高教主赛道 · 新工科", "围绕软件、电子、机械、机器人、智能建造等真实需求开发或改进产品，用原型、测试与市场调研说明价值。", "higherFull", higherScope),
  track("higher-medicine-2026", "高教主赛道 · 新医科", "围绕医疗技术、康复护理、健康康养等问题形成产品或服务模式，核对技术验证、服务证据及适用规范。", "higherFull", higherScope),
  track("higher-agriculture-2026", "高教主赛道 · 新农科", "围绕智慧农业、食品营养、休闲农业、生态修复等问题调研与验证，说明方案如何服务实际生产生活。", "higherFull", higherScope),
  track("higher-humanities-2026", "高教主赛道 · 新文科", "围绕文化教育、财经法务、翻译传播、文旅非遗、电商物流、社工养老等需求，验证可持续产品或服务。", "higherFull", higherScope),
  track("higher-ai-2026", "高教主赛道 · 人工智能+", "从具体行业问题设计AI应用，验证使用效果与实施条件，结合专业、产品、设计、调研和运营分工。", "higherFull", higherScope),
  track("red-public-benefit-2026", "红旅赛道 · 公益组", "针对乡村或社区公共问题开展不以营利为目的的服务创新，记录受益对象、实际效果与持续运营方式。", "higherFull", redScope, {
    teamRequirement: { state: "known", mode: "team", minSize: 3, maxSize: 15 }, sameInstitutionTeam: false,
    eligibilityNotes: [redApplicantQualification, "2026红旅公益组须为参加红旅活动的独立公益项目或社会组织；注册或未注册均可，不以营利为目标。公益项目登记豁免不等于负责人学籍豁免。"],
  }),
  track("red-creative-2026", "红旅赛道 · 创意组", "基于专业或资源解决农业农村、城乡社区问题，以调研、服务试点或产品原型说明经济与社会价值。", "higherFull", redScope, {
    eligibilityNotes: [redApplicantQualification, "2026红旅创意组须参加红旅活动；项目在通知下发前尚未完成工商等登记。"],
  }),
  track("red-startup-2026", "红旅赛道 · 创业组", "用商业方式解决乡村或社区问题，以实际运营说明需求、收益、社会作用与可持续性。", "higherFull", redScope, {
    eligibilityNotes: [redApplicantQualification, "2026红旅创业组须参加红旅活动并在通知下发前完成登记；负责人为法人，法人股权至少10%、参赛成员合计至少1/3。"],
  }),
  track("vocational-project-2026", "职教赛道 · 创意组/创业组", "从职业技能、生产加工工艺或生活服务需求出发，形成改良技术、产品原型、服务模式或商业模式并验证。", "vocational", "教育部2026通知附件3；仅职教赛道，不把职业学校与开放大学通道外推为高教主赛道资格。", {
    teamRequirement: { state: "known", mode: "team", minSize: 3, maxSize: 15 }, sameInstitutionTeam: false,
    eligibilityNotes: ["2026职教赛道面向职业学校学历教育（不含在职教育）及国家开放大学学历教育学生。创意组须有较成型原型、服务模式或改良技术且未登记；创业组须核对法人、登记、毕业年限及股权条件。"],
  }),
  track("industry-brief-2026", "产业赛道 · 企业命题组", "从已公布企业命题选择适合的技术或管理问题，提交可验证的解决方案；可关注产教协同、区域产业或国产操作系统软件方向。", "industry", "华中科技大学转述2026产业赛道全国要求；校内提交时间只限该校；具体企业榜题、契合度与资格须逐题核对。", {
    eligibilityNotes: ["2026产业赛道负责人为全日制在校本专科生、研究生或毕业5年内学生；指导教师须为2026年7月15日前入职的高校教师。"],
  }),
  track("industry-transfer-2026", "产业赛道 · 成果转化组", "围绕已有高校技术、专利或实验室成果探索应用、市场与产业协同，说明转化路径、实际贡献和权利归属。", "industry", "2026产业赛道成果转化组；不能将本组师生组队、企业和股权条件扩为高教或红旅组规则。", {
    eligibilityNotes: ["2026成果转化组鼓励师生共同组队；若已成立公司须核对注册年限，师生股权合计至少51%、学生参赛成员合计至少10%。不以只有兴趣代替成果与授权条件。"],
  }),
];

const challengeTracks = [
  ["advanced-manufacturing-2026", "先进制造", "围绕装备、工业母机、机器人、低空经济等需求设计创业项目，验证技术方案、产品原型及应用市场。"],
  ["information-technology-2026", "新一代信息技术", "围绕集成电路、AI、基础软件、网络安全等问题开发方案，并验证用户需求、技术效果和商业可行性。"],
  ["medicine-health-2026", "生物医药与健康科技", "围绕医疗装备、生物制造、中医药等形成创业项目，以研究或服务验证支撑实际应用和市场价值。"],
  ["energy-materials-2026", "新能源新材料", "围绕绿色能源、先进材料、低碳环保等问题开展创新，结合实验、工程验证与产业需求说明转化路径。"],
  ["agriculture-food-2026", "现代农业与食品科技", "围绕农业生产、育种、绿色农业或食品健康设计项目，以实地调研、验证数据与实际用户论证方案。"],
  ["consumption-culture-2026", "新消费与文化创意", "围绕国潮文创、沉浸式消费、农文旅、品牌运营等设计产品或服务，做用户调研、试点与经营模式验证。"],
  ["services-governance-2026", "现代服务与社会治理", "围绕智慧城市、政务、乡村治理、社区或供应链服务设计项目，验证服务效果、实施条件与可持续模式。"],
  ["international-cooperation-2026", "国际交流合作", "围绕国际合作的真实需求设计创业项目，结合语言、区域研究或专业方案论证受益对象、合作条件与价值；专项身份要求待核。"],
].map(([id, label, taskSummary]) => track(id, `主体赛 · ${label}`, taskSummary, "challenge", challengeScope));

/** These notes describe the evidence boundary of this row, not new eligibility
 * requirements. In particular, an unknown event end cannot become an end date. */
export function discoveryCriticalScopeNotes(id: string): readonly string[] {
  if (id === "china-international-college-innovation") return [
    "只证实2026国内报名9月25日12时截止；总决赛仅知11月，未核实是否结束，不能从当前已到11月或报名截止推出总决赛已结束。",
    "参加红旅活动仅是红旅赛道条件；高教主赛道不要求参加红旅活动。按所选赛道单独核对登记、学籍、成果和股权条件。",
    "2026国内高教研究生创意组负责人须全日制在校研究生，成员须全日制在校研究生或本专科生（不含在职教育）；国内非全日制研究生不能作为该组的符合者。港澳台/国际学历调整不外推国内项目。",
    `${redApplicantQualification}红旅公益组同样继承此条，不因公益小节未重复而豁免；不得仅凭当前非全日制学籍断言所有红旅角色或整项赛事都不符合。`,
  ];
  if (id === "milan-design-week-china") return [
    "2026第十届通知的本科生研究生组、高职高专学生组本身均含在校及毕业5年内学生；旧“在校学生作品组”和强制在籍说明是目录旧误标，不能据此排除毕业生。",
    "毕业年限与目标组别仍须确认；2026资格不得自动变成2027新届资格。旧官网FAQ中的人数若未核明届次，不作为新届确定人数。",
  ];
  if (id === "challenge-cup-academic-science") return [
    "当前所读官网章程未标届次：一般申报范围为在校本专科、硕士；普通博士不据扁平学段标签视为符合。连读/直博仅在第18条所列阶段可按硕士等学历核对，例外尚未确认即保持未知。",
    "自然科学论文只限本专科；哲社调查、科技发明制作中的博士例外必须紧随赛道一起理解。不得把未标届章程覆盖明确旧届PDF，也不据此声称2026或2027规则已确认。",
  ];
  return [];
}

function reviewedMilanCompetition(competition: Competition): Competition {
  const r = competition.recommendation;
  const primary: CompetitionMetadataSource = { url: REVIEWED_SCOPE_SOURCES.milan, sourceType: "education-authority", verifiedAt: checkedAt,
    evidenceRef: "reviewed:20261120:milan-2026-student-groups", facts: ["identity", "eligibility", "trackEligibility"] };
  const scope = "常州工学院转述2026第十届参赛对象：本科生研究生组、高职高专学生组均含在校及毕业5年内；学校报送流程仅适用于该校，不推定2027条件。";
  const tracks: CompetitionTrackMetadata[] = [
    { id: "undergraduate-postgraduate-work-2026", label: "2026本科生研究生组（含毕业5年内）", preferenceQuestionEligible: false,
      document: { title: "2026第十届米兰设计周参赛对象", url: primary.url, scope }, evidenceRef: primary.evidenceRef,
      eligibilityNotes: ["2026本科生研究生组包括在校及毕业5年内的博士、硕士、本科和进修生；毕业生不能被“在校”旧标签排除。"],
      blockingClarifications: ["须核本人对应学历组别、毕业年限与目标届次；目前在读学段或已毕业状态都不单独证明全部资格。"] },
    { id: "vocational-work-2026", label: "2026高职高专学生组（含毕业5年内）", preferenceQuestionEligible: false,
      document: { title: "2026第十届米兰设计周参赛对象", url: primary.url, scope }, evidenceRef: primary.evidenceRef,
      eligibilityNotes: ["2026高职高专学生组包括在校及毕业5年内的专科生；不是只限当年在籍。"],
      blockingClarifications: ["须核本人学历组别、毕业年限与目标届次。"] },
  ];
  return { ...competition, recommendation: { ...r, source: primary, stages: { state: "unknown" },
    teamRequirement: { state: "unknown" }, tracks,
    supportingSources: [...(r.supportingSources ?? []), ...(r.source ? [r.source] : []), primary],
    eligibility: { state: "partial", source: primary,
      notes: ["2026第十届通知明确本科生研究生组和高职高专学生组均接收在校及毕业5年内学生，另有教师及专业设计师类别；不能将学生组强制改成只有在校生。",
        "原“在校学生作品组”及其在籍限定仅保留作目录旧误标追溯，不是官方独立排他组；2026通知明确非命题赛场可提交个人设计作品，但没有同范围确认其他赛场合作人数。旧未标届FAQ的作品类3人/数媒类5人仅保留原范围待核，不作为2026或未来届确定人数。"],
      blockingClarifications: ["当前已毕业不等于不符合；本人毕业年限、组别、目标届次、作品权利与复用条件仍须核对。"],
    },
  } };
}

function reviewedAcademicCompetition(competition: Competition): Competition {
  const r = competition.recommendation;
  const primary: CompetitionMetadataSource = { url: REVIEWED_SCOPE_SOURCES.academic, sourceType: "official-competition", verifiedAt: checkedAt,
    evidenceRef: "reviewed:20261120:academic-charter-undated", facts: ["eligibility", "stages", "trackEligibility"] };
  const exception = "所引官网章程未标届次：第18条仅允许硕博连读/直博在决赛当年6月1日前未通过博士资格考试时按硕士申报；无资格考制度的前两年按硕士，本硕博按4年/2年分别对应本/硕，后续不可。普通博士不是本赛道无条件符合者；例外须确认，不能据此确认2026/2027资格。";
  const tracks = (r.tracks ?? []).map(item => ({ ...item,
    stages: item.stages?.state === "known" ? { state: "known" as const, values: item.stages.values.filter(value => value !== "doctorate") } : item.stages,
    document: { title: "挑战杯大挑官网章程（未标届次）", url: primary.url, scope: "仅所读未标届官网章程第17—19条；不覆盖明确旧届PDF，也不升级为已确认2026/2027全国规则。" },
    evidenceRef: primary.evidenceRef,
    eligibilityNotes: [...(item.eligibilityNotes ?? []), ...(item.id === "natural-science-paper"
      ? ["所引未标届官网章程第19条自然科学类学术论文作者仅限本专科，硕士和普通博士不能直接套入。"]
      : ["所引未标届官网章程一般范围为在校本专科、硕士；不得概括为普通博士可报。", exception])],
  }));
  return { ...competition, recommendation: { ...r, source: primary, tracks,
    stages: { state: "known", values: [...college, "master"] },
    supportingSources: [...(r.supportingSources ?? []), ...(r.source ? [r.source] : []), primary],
    eligibility: { ...r.eligibility, state: "partial", source: primary, requiresFullTime: true, requiresCurrentEnrollment: true,
      notes: ["所读官网章程未标适用届次，第17条一般申报范围为全日制非成人教育在校专科、本科、硕士（不含在职研究生）；不据此确认未来届资格。",
        exception, "自然科学论文仅限本专科；哲社调查和科技发明制作按本专科/硕士范围及同一博士例外核对；保留作品来源、完成时间、课程/学位论文等限制。"],
      stageClarificationNotes: { ...(r.eligibility?.stageClarificationNotes ?? {}), doctorate: exception },
    },
  } };
}

export function reviewedDiscoveryCompetition(competition: Competition): Competition {
  if (competition.id === "milan-design-week-china") return reviewedMilanCompetition(competition);
  if (competition.id === "challenge-cup-academic-science") return reviewedAcademicCompetition(competition);
  const innovation = competition.id === "china-international-college-innovation";
  if (!innovation && competition.id !== "challenge-cup-entrepreneurship-plan") return competition;
  const r = competition.recommendation;
  const primary = source(innovation ? "notice" : "challenge");
  const { requiresFullTime: _fullTime, requiresCurrentEnrollment: _enrolled, sameInstitutionTeam: _sameSchool,
    ...previousEligibility } = r.eligibility ?? { state: "unknown" as const, notes: [], source: primary };
  return { ...competition, recommendation: { ...r,
    stages: { state: "known", values: innovation ? [...university, "other-or-non-full-time"] : university },
    teamRequirement: { state: "known", mode: "team", minimumSizeUnknown: true },
    source: primary,
    supportingSources: [...(r.supportingSources ?? []), ...(r.source ? [r.source] : []), ...Object.keys(INNOVATION_2026_SOURCES)
      .filter(key => innovation ? !key.startsWith("challenge") : key.startsWith("challenge"))
      .map(key => source(key as keyof typeof INNOVATION_2026_SOURCES))],
    tracks: innovation ? innovationTracks : challengeTracks,
    eligibility: { ...previousEligibility, state: "partial", source: primary,
      ...(innovation ? {} : { requiresFullTime: true, requiresCurrentEnrollment: true }),
      notes: innovation ? [
        "2026规则：高教分本专科/研究生及创意/创业组；创意组也须有较成型产品原型或服务模式。组别学籍、登记、成果归属及股权须分别核对，不能只凭专业覆盖广断言符合。",
        "高教、红旅、职教官方附件均允许3—15人跨校团队；产业赛道另核。年龄不超过35岁（1991年3月1日及以后出生），每项目仅选一赛道，往年总决赛获奖项目不得再报。",
        "红旅须参加红旅活动；职业学校与国家开放大学另有赛道通道。不能将全日制在校、毕业5年内或开放大学身份跨赛道套用。",
        "仅证实2026国内报名9月25日12时截止；总决赛仅知11月且含现场，未核实是否已结束，不能因报名截止或当前已到11月推出总决赛已结束。未来届规则和费用待核，不称当前可报名或全程线上。",
      ] : [
        "2026第十五届正式通知：6月1日前注册的国内全日制非成人教育在校专科、本科、硕士、博士及全日制职教学生可申报；不含在职研究生，国外学生通道另核。",
        "2026主体赛设8赛道，按团队最高学历分专科、本科、研究生组评审。考察科技攻关或商业模式创新、真实市场前景及落地价值；不是只写计划书即可符合。",
        "2026最新正式通知未列主体赛统一队伍人数、导师上限及跨校细则，保持待核；不套用未标届旧章程10人、旧5组或专项赛人数。",
        "2026终审决赛10月30日至11月2日在大连理工大学举行，已结束；可推荐提前准备，不能称当前可报名，不推算下一届月份。它是创业计划小挑，不是学术科技作品大挑。",
      ],
      blockingClarifications: innovation
        ? ["实际项目成熟度、年龄、登记、权利归属及目标组别资格须核对；参加红旅活动仅在推荐红旅赛道时核对，高教主赛道不要求红旅活动；不追加AI问题。"]
        : ["个人及项目资格、实际队伍条件、作品与授权情况及未来届规则仍须核对；不追加AI问题。"],
    },
    schedule: innovation ? { state: "scheduled", edition: "2026", registrationStart: "2026-08-10", registrationEnd: "2026-09-25",
      datePrecision: "day", verifiedAt: checkedAt, sourceUrl: primary.url, sourceType: primary.sourceType }
      : { state: "scheduled", edition: "2026第十五届", competitionStart: "2026-10-30", competitionEnd: "2026-11-02",
        datePrecision: "day", verifiedAt: checkedAt, sourceUrl: INNOVATION_2026_SOURCES.challengeFinal, sourceType: "organizer" },
  } };
}
