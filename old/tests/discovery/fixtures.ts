import {
  discoveryAnswersSchema,
  type DiscoveryAnswer,
  type DiscoveryAnswers,
  type DiscoveryFieldId
} from "../../src/lib/competitions/discovery/contracts";
import { createEmptyDiscoveryAnswers } from "../../src/lib/competitions/discovery/questionnaire";

/** Entirely synthetic acceptance inputs. No student or account data belongs here. */
export type DiscoveryAcceptanceProfile = {
  id: string;
  name: string;
  answers: DiscoveryAnswers;
  additionalText: string;
  reviewChecks: readonly string[];
  /** Useful candidates for human coverage review; these are never sent to the model. */
  coverageCandidates?: readonly string[];
};

type Selections = Partial<Record<DiscoveryFieldId, readonly string[]>>;
function answers(selections: Selections): DiscoveryAnswers {
  const result = createEmptyDiscoveryAnswers();
  for (const [key, values] of Object.entries(selections) as [DiscoveryFieldId, readonly string[]][]) {
    result[key] = {
      status: "answered", values: [...values],
      ...(key === "goals" && values.length > 1 ? { orderConfirmed: true } : {})
    } satisfies DiscoveryAnswer;
  }
  return discoveryAnswersSchema.parse(result);
}

export const DISCOVERY_ACCEPTANCE_PROFILES: readonly DiscoveryAcceptanceProfile[] = [
  {
    id: "vocational-first-entry", name: "专科技能基础、首次参赛",
    answers: answers({ learningStage: ["vocational-2-plus"], enrollmentStatus: ["full-time"], major: ["manufacturing"],
      goals: ["skills", "career-portfolio"], interests: ["vocational-skills", "engineering"],
      taskPreferences: ["vocational-practice", "experiments-building"], completedTasks: ["engineering-design", "experiments-hardware"],
      achievements: ["none"], weeklyTime: ["6-10"], teamStatus: ["seeking"], resources: ["equipment", "learning"],
      participationMode: ["local"], budget: ["101-500"] }),
    additionalText: "练习过CAD绘图和基础加工操作，还没有参加过竞赛。",
    reviewChecks: ["不能把专科生写成本科生", "区分实际技能起点与竞赛经验为零", "不将仅限本科的组别描述为当前可参加", "解释技能训练和可展示成果的联系"]
  },
  {
    id: "undergraduate-cross-major", name: "本科低年级、跨专业探索",
    answers: answers({ learningStage: ["undergraduate-1"], enrollmentStatus: ["full-time"], major: ["language-media"],
      goals: ["exploration", "career-portfolio"], interests: ["software-intelligence", "creative-media"],
      taskPreferences: ["creative-prototyping", "writing"], completedTasks: ["digital-creation", "report-plan"],
      achievements: ["creative-work"], weeklyTime: ["6-10"], teamStatus: ["potential"], resources: ["learning"],
      participationMode: ["domestic-travel"], budget: ["101-500"] }),
    additionalText: "对AI应用感兴趣，愿意做交互原型与说明文稿，目前不会独立编程。",
    reviewChecks: ["不只按专业名称推荐语言比赛", "不把AI兴趣等同编程能力", "推荐任务应关联设计原型与写作偏好", "跨专业选择须说明角色与条件缺口"]
  },
  {
    id: "senior-software-portfolio", name: "本科高年级、软件项目求职",
    answers: answers({ learningStage: ["undergraduate-3"], enrollmentStatus: ["full-time"], major: ["computing"],
      goals: ["career-portfolio", "skills"], interests: ["software-intelligence"], taskPreferences: ["coding", "creative-prototyping"],
      completedTasks: ["software", "data-analysis", "report-plan", "coordination"], achievements: ["project", "prototype"],
      weeklyTime: ["11-15"], teamStatus: ["stable"], resources: ["learning", "mentor", "data-access"],
      participationMode: ["domestic-travel"], budget: ["501-1500"] }),
    additionalText: "独立做过可运行的网站和数据看板，希望继续改进现有原型，求职时展示本人贡献。",
    reviewChecks: ["以可展示软件成果服务第一目标", "说明现有项目能否复用仍需核对规则", "不保证获奖或求职收益", "结合编码、原型、项目证据解释选择"]
  },
  {
    id: "masters-research", name: "硕士研究积累",
    answers: answers({ learningStage: ["masters-2-plus"], enrollmentStatus: ["full-time"], major: ["science"],
      goals: ["research", "skills"], interests: ["mathematics", "software-intelligence"],
      taskPreferences: ["research-analysis", "writing"], completedTasks: ["literature", "data-analysis", "modeling", "report-plan"],
      achievements: ["research", "project"], weeklyTime: ["11-15"], teamStatus: ["potential"],
      resources: ["mentor", "data-access", "learning"], participationMode: ["domestic-travel"], budget: ["501-1500"] }),
    additionalText: "做过统计建模课程研究和实验复现，希望积累可解释的研究过程。",
    reviewChecks: ["不能推荐明确仅本科可参加的组别为当前机会", "研究记录和方法训练应占价值说明重点", "不承诺论文发表或升学加分"]
  },
  {
    id: "low-time-long-term", name: "目标明确但投入很少",
    answers: answers({ learningStage: ["undergraduate-2"], enrollmentStatus: ["full-time"], major: ["electronics"],
      goals: ["skills", "career-portfolio"], interests: ["software-intelligence", "engineering"],
      taskPreferences: ["experiments-building", "coding"], completedTasks: ["experiments-hardware"], achievements: ["none"],
      weeklyTime: ["under-2"], teamStatus: ["seeking"], resources: ["learning"], participationMode: ["local"], budget: ["under-100"] }),
    additionalText: "本学期每周只能稳定投入一小时，希望先选一个值得长期准备的方向。",
    reviewChecks: ["不得把高强度赛事写成完全符合现有时间", "仍可保留有长期价值的方向", "说明投入与资源缺口，不能只给速成承诺"]
  },
  {
    id: "no-team-no-mentor", name: "无队伍导师、愿意补足条件",
    answers: answers({ learningStage: ["undergraduate-2"], enrollmentStatus: ["full-time"], major: ["business"],
      goals: ["career-portfolio", "collaboration"], interests: ["business", "society-education-law"],
      taskPreferences: ["research-analysis", "business-analysis"], completedTasks: ["survey", "data-analysis", "report-plan"],
      achievements: ["project"], weeklyTime: ["6-10"], teamStatus: ["seeking"], resources: ["none"],
      participationMode: ["domestic-travel"], budget: ["101-500"] }),
    additionalText: "做过课堂问卷和Excel分析，当前没有导师、队伍或额外经费，但愿意寻找合作者。",
    reviewChecks: ["无队友导师不等于无发展价值", "不得假定已有团队、导师或经费", "调研任务、已有能力、作品目标之间应有具体联系"]
  },
  {
    id: "online-only-hard-limit", name: "明确只接受全程线上",
    answers: answers({ learningStage: ["undergraduate-3"], enrollmentStatus: ["full-time"], major: ["art-design"],
      goals: ["career-portfolio", "skills"], interests: ["creative-media"], taskPreferences: ["creative-prototyping", "writing"],
      completedTasks: ["digital-creation", "report-plan"], achievements: ["creative-work"], weeklyTime: ["6-10"],
      teamStatus: ["solo-preferred"], resources: ["learning"], participationMode: ["online-only"], budget: ["101-500"] }),
    additionalText: "任何必须到现场的环节都不能参加，包括决赛和答辩。",
    reviewChecks: ["不能因初赛在线就称全程线上", "明确需要线下到场的赛事不得进入正式推荐", "规则未知应标待核验，冲突例外只可末尾简述"]
  },
  {
    id: "zero-personal-budget", name: "明确不能个人自费",
    answers: answers({ learningStage: ["undergraduate-2"], enrollmentStatus: ["full-time"], major: ["social-science"],
      goals: ["skills", "exploration"], interests: ["society-education-law"], taskPreferences: ["writing", "research-analysis"],
      completedTasks: ["literature", "survey", "report-plan"], achievements: ["none"], weeklyTime: ["6-10"],
      teamStatus: ["seeking"], resources: ["learning"], participationMode: ["local"], budget: ["no-personal-cost"] }),
    additionalText: "个人不能承担报名、材料或差旅费用，也没有已确认的报销或资助。",
    reviewChecks: ["不得默认学校报销或赛事免费", "已知必须自费的赛事不进正式推荐", "费用未知需说明核验，不声称符合零支出条件"]
  },
  {
    id: "all-uncertain", name: "所有可用字段均不确定",
    answers: answers({ learningStage: ["unknown"], enrollmentStatus: ["unknown"], major: ["unknown"], goals: ["unknown"],
      interests: ["unknown"], taskPreferences: ["unknown"], weeklyTime: ["unknown"], teamStatus: ["unknown"],
      resources: ["unknown"], participationMode: ["unknown"], budget: ["unknown"] }),
    additionalText: "",
    reviewChecks: ["不能编造能力、专业、经历或资格", "说明信息不足与探索性质", "未答任务与成果不等于明确没有", "不为达到数量强行推荐"]
  },
  {
    id: "all-skipped", name: "全部跳过",
    answers: answers({}), additionalText: "",
    reviewChecks: ["允许生成且明确依据极少", "不能把全跳过写成零基础或不感兴趣", "不输出虚构个性化联系", "宁少勿凑"]
  },
  {
    id: "catalog-tail-geophysics", name: "目录末尾方向覆盖",
    answers: answers({ learningStage: ["undergraduate-3"], enrollmentStatus: ["full-time"], major: ["science"],
      goals: ["research", "career-portfolio"], interests: ["engineering", "mathematics"],
      taskPreferences: ["research-analysis", "experiments-building"], completedTasks: ["data-analysis", "modeling", "report-plan"],
      achievements: ["research", "project"], weeklyTime: ["11-15"], teamStatus: ["stable"],
      resources: ["mentor", "data-access", "equipment"], participationMode: ["domestic-travel"], budget: ["501-1500"] }),
    additionalText: "主修地球物理，处理过地震波与重磁数据，做过地质解释课程项目，希望用真实勘探资料继续实践。",
    reviewChecks: ["检查是否关注完整目录尾部的相关赛事", "即使不入选也应评估与该方向的任务联系", "不能只因理学专业泛推数学建模"],
    coverageCandidates: ["exploration-geophysics"]
  },
  {
    id: "sparse-feasible-options", name: "严格现实条件、允许少推荐",
    answers: answers({ learningStage: ["vocational-1"], enrollmentStatus: ["full-time"], major: ["medicine"],
      goals: ["exploration"], interests: ["life-environment"], taskPreferences: ["vocational-practice"],
      completedTasks: ["none"], achievements: ["none"], weeklyTime: ["under-2"], teamStatus: ["solo-preferred"],
      resources: ["none"], participationMode: ["online-only"], budget: ["no-personal-cost"] }),
    additionalText: "暂不考虑组队、付费或线下环节，只希望了解能从零探索的少量机会。",
    reviewChecks: ["合适且有依据不足六项应少给并解释", "不能将确定需团队、付费、线下的赛事塞入正文", "不把医学兴趣写成已有临床技能"]
  },
  {
    id: "graduated-eligibility", name: "已经毕业、资格冲突",
    answers: answers({ learningStage: ["undergraduate-4-plus"], enrollmentStatus: ["graduated"], major: ["computing"],
      goals: ["career-portfolio"], interests: ["software-intelligence"], taskPreferences: ["coding"],
      completedTasks: ["software"], achievements: ["project"], weeklyTime: ["6-10"], teamStatus: ["solo-preferred"],
      resources: ["learning"], participationMode: ["online-only"], budget: ["101-500"] }),
    additionalText: "本科已经毕业，不保留在校学籍，希望仅了解确实向毕业生开放的赛事或开放挑战。",
    reviewChecks: ["已经毕业不得按全日制在读处理", "明确只面向在校生的赛事不能当成当前机会", "可联网发现库外开放赛事，但来源与资格须有依据"]
  },
  {
    id: "doctoral-life-science", name: "博士科研与成果边界",
    answers: answers({ learningStage: ["doctoral"], enrollmentStatus: ["full-time"], major: ["life-environment"],
      goals: ["research", "idea-validation"], interests: ["life-environment"],
      taskPreferences: ["research-analysis", "experiments-building"], completedTasks: ["literature", "experiments-hardware", "data-analysis", "report-plan"],
      achievements: ["research", "prototype"], weeklyTime: ["11-15"], teamStatus: ["stable"],
      resources: ["mentor", "equipment", "funding"], participationMode: ["domestic-travel"], budget: ["over-1500"] }),
    additionalText: "有农业环境传感实验原型和阶段数据，尚未公开发表；重视研究过程与原型验证，不考虑本校加分判断。",
    reviewChecks: ["资格须兼容博士学段", "不能默认已有成果允许重复参赛或公开", "不承诺科研发表或学校认定", "区分原型验证与商业化承诺"]
  },
  {
    id: "part-time-law", name: "非全日制与法律实践",
    answers: answers({ learningStage: ["masters-1"], enrollmentStatus: ["part-time"], major: ["social-science"],
      goals: ["skills", "career-portfolio"], interests: ["society-education-law", "language-communication"],
      taskPreferences: ["writing", "presentation"], completedTasks: ["literature", "report-plan", "presentation"],
      achievements: ["project"], weeklyTime: ["2-5"], teamStatus: ["seeking"], resources: ["learning"],
      participationMode: ["local"], budget: ["101-500"] }),
    additionalText: "非全日制法律硕士，做过案例检索和模拟答辩，希望训练论证与表达。",
    reviewChecks: ["不得把非全日制写成全日制", "当届组别与学籍要求未知时标明待核验", "结合案例检索、论证、表达解释任务匹配"]
  }
];

export function getDiscoveryAcceptanceProfile(id: string): DiscoveryAcceptanceProfile | undefined {
  return DISCOVERY_ACCEPTANCE_PROFILES.find((profile) => profile.id === id);
}
