import type { DiscoveryAnswer, DiscoveryAnswers, DiscoveryFollowupAnswer, DiscoveryFollowupQuestion } from "./contracts";

export const DISCOVERY_FIELD_IDS = [
  "learningStage", "enrollmentStatus", "major", "goals", "interests", "taskPreferences",
  "completedTasks", "achievements", "weeklyTime", "teamStatus", "resources", "participationMode", "budget"
] as const;

export type DiscoveryFieldId = (typeof DISCOVERY_FIELD_IDS)[number];
export type DiscoveryOption = { value: string; label: string; meaning?: "unknown" | "none" | "other" };
export type DiscoveryField = {
  id: DiscoveryFieldId;
  label: string;
  hint?: string;
  selection: "single" | "multiple" | "ranked";
  maxSelections: number;
  exclusiveValues: readonly string[];
  options: readonly DiscoveryOption[];
};
export type DiscoveryQuestion = { id: string; title: string; fields: readonly DiscoveryField[] };

export const DISCOVERY_QUESTIONS: readonly DiscoveryQuestion[] = [
  {
    id: "q1", title: "学习阶段与学籍", fields: [
      {
        id: "learningStage", label: "你的学习阶段最接近哪一项？", selection: "single", maxSelections: 1, exclusiveValues: [],
        options: [
          { value: "vocational-1", label: "高职或专科一年级" },
          { value: "vocational-2-plus", label: "高职或专科二年级及以上" },
          { value: "undergraduate-1", label: "本科一年级" },
          { value: "undergraduate-2", label: "本科二年级" },
          { value: "undergraduate-3", label: "本科三年级" },
          { value: "undergraduate-4-plus", label: "本科四年级及以上" },
          { value: "masters-1", label: "硕士研究生一年级" },
          { value: "masters-2-plus", label: "硕士研究生二年级及以上" },
          { value: "doctoral", label: "博士研究生" },
          { value: "unknown", label: "其他或暂不确定", meaning: "unknown" }
        ]
      },
      {
        id: "enrollmentStatus", label: "你目前的学籍情况是？", selection: "single", maxSelections: 1, exclusiveValues: [],
        options: [
          { value: "full-time", label: "全日制在读" },
          { value: "part-time", label: "非全日制在读" },
          { value: "suspended", label: "休学或保留学籍" },
          { value: "incoming", label: "即将入学，尚未正式注册" },
          { value: "graduated", label: "已经毕业" },
          { value: "unknown", label: "其他或暂不确定", meaning: "unknown" }
        ]
      }
    ]
  },
  {
    id: "q2", title: "专业背景", fields: [{
      id: "major", label: "你的主修专业最接近哪一类？", selection: "single", maxSelections: 1, exclusiveValues: [],
      hint: "可以在本题文字中写明具体专业；专业背景不限制你探索跨专业竞赛。",
      options: [
        { value: "science", label: "数学、统计、物理等理学" },
        { value: "computing", label: "计算机、软件、人工智能、数据相关专业" },
        { value: "electronics", label: "电子、通信、自动化、电气" },
        { value: "manufacturing", label: "机械、材料、能源、化工、制造" },
        { value: "civil-architecture", label: "土木、建筑、交通、测绘" },
        { value: "business", label: "经济、管理、金融、商贸" },
        { value: "social-science", label: "法学、社会学、公共管理等" },
        { value: "language-media", label: "中文、外语、新闻传播" },
        { value: "education-psychology", label: "教育、心理" },
        { value: "art-design", label: "艺术、设计、数字媒体创作" },
        { value: "medicine", label: "医学、药学、护理、公共卫生" },
        { value: "life-environment", label: "生物、农林、食品、环境" },
        { value: "other", label: "其他或交叉专业", meaning: "other" },
        { value: "unknown", label: "暂未确定或不清楚", meaning: "unknown" }
      ]
    }]
  },
  {
    id: "q3", title: "参赛目标", fields: [{
      id: "goals", label: "你最希望通过竞赛获得什么？", selection: "ranked", maxSelections: 3, exclusiveValues: ["unknown"],
      hint: "最多选 3 项，再明确第一、第二、第三优先级。选项点击顺序不会自动作为你确认的排序。",
      options: [
        { value: "career-portfolio", label: "形成求职、实习时能够展示的项目或作品" },
        { value: "research", label: "积累研究经验、研究记录或成果，为继续深造做准备" },
        { value: "skills", label: "练会某项方法或工具，提高解决实际问题的能力" },
        { value: "awards", label: "争取奖项与荣誉，积累竞赛经历" },
        { value: "exploration", label: "探索兴趣，判断自己适合什么方向" },
        { value: "idea-validation", label: "验证一个创意或商业想法，形成方案、原型或项目" },
        { value: "collaboration", label: "锻炼协作和表达，接触不同专业的同学" },
        { value: "unknown", label: "目前没有明确目标，先帮我找到值得尝试的方向", meaning: "unknown" }
      ]
    }]
  },
  {
    id: "q4", title: "兴趣与愿意持续承担的任务", fields: [
      {
        id: "interests", label: "哪些领域最能吸引你？", selection: "multiple", maxSelections: 2, exclusiveValues: ["unknown"],
        options: [
          { value: "mathematics", label: "数理、统计与数学建模" },
          { value: "software-intelligence", label: "软件、人工智能、电子与机器人" },
          { value: "engineering", label: "工程设计、制造、能源与建筑" },
          { value: "life-environment", label: "生命医药、农业与环境" },
          { value: "business", label: "商业、创业、金融与管理" },
          { value: "society-education-law", label: "社会调查、公共治理、教育与法律" },
          { value: "creative-media", label: "设计、文创、影像与数字媒体" },
          { value: "language-communication", label: "语言、写作、演讲与传播" },
          { value: "vocational-skills", label: "职业技能与专业实践操作" },
          { value: "unknown", label: "还没有明显偏好，愿意尝试不同方向", meaning: "unknown" }
        ]
      },
      {
        id: "taskPreferences", label: "真正投入准备时，你更愿意持续做哪些事情？", selection: "multiple", maxSelections: 2, exclusiveValues: ["unknown"],
        options: [
          { value: "coding", label: "写代码、解题，反复调试和优化" },
          { value: "research-analysis", label: "研究开放问题，收集数据、分析或建立模型" },
          { value: "experiments-building", label: "做实验、制作实物、测试和改进" },
          { value: "creative-prototyping", label: "创作设计作品，制作内容或产品原型" },
          { value: "writing", label: "查阅资料，组织论证，撰写报告或论文" },
          { value: "business-analysis", label: "分析市场和用户需求，提出商业或管理方案" },
          { value: "presentation", label: "演讲、答辩、辩论或外语表达" },
          { value: "vocational-practice", label: "完成专业技能操作，反复练习具体流程" },
          { value: "coordination", label: "协调分工、组织沟通，推动项目按时完成" },
          { value: "unknown", label: "暂时不清楚，想先了解不同任务是什么样的", meaning: "unknown" }
        ]
      }
    ]
  },
  {
    id: "q5", title: "实际完成过的任务", fields: [{
      id: "completedTasks", label: "你实际完成过哪些任务？课堂、自学、实习或团队项目都可以。", selection: "multiple", maxSelections: 4, exclusiveValues: ["none", "unknown"],
      hint: "做过不等于已经独立熟练掌握；最多选 4 项。",
      options: [
        { value: "literature", label: "查找资料、记录来源，并整理成有条理的说明或综述" },
        { value: "survey", label: "设计或开展访谈、问卷、实地调查，整理结果" },
        { value: "data-analysis", label: "用 Excel、统计软件或代码处理数据，制作图表并解释结果" },
        { value: "software", label: "写出可运行的程序、网站、应用或其他软件功能" },
        { value: "modeling", label: "建立数学模型、实现算法，或训练和评估简单的机器学习模型" },
        { value: "experiments-hardware", label: "完成实验、硬件搭建、机械制作或相关测试" },
        { value: "engineering-design", label: "使用 CAD、三维建模、工程设计或仿真软件完成任务" },
        { value: "digital-creation", label: "完成视觉、交互、视频或其他数字创作作品" },
        { value: "report-plan", label: "写出结构完整的报告、论文、策划案或商业计划" },
        { value: "presentation", label: "完成演讲、答辩、辩论或外语展示" },
        { value: "coordination", label: "拆分任务、安排进度，并协调多人完成一项工作" },
        { value: "none", label: "暂时没有完成过上述任务", meaning: "none" },
        { value: "other", label: "有其他实际做过的任务", meaning: "other" },
        { value: "unknown", label: "暂时不确定如何归类，按已有情况推荐", meaning: "unknown" }
      ]
    }]
  },
  {
    id: "q6", title: "已有经历与成果", fields: [{
      id: "achievements", label: "以下哪些经历或成果，你目前确实拥有？", selection: "multiple", maxSelections: 3, exclusiveValues: ["none", "unknown"],
      hint: "最多选 3 项；已有成果是否可以再次提交，仍需核对赛事规则。",
      options: [
        { value: "competition", label: "完整参加过至少一次竞赛" },
        { value: "award", label: "获得过竞赛奖项或名次" },
        { value: "project", label: "有可以展示的课程、自学或实习项目" },
        { value: "research", label: "有研究、实验或调研成果" },
        { value: "prototype", label: "有一个准备继续开发的项目、题目或原型" },
        { value: "creative-work", label: "有准备继续修改的设计作品、视频、文稿或策划方案" },
        { value: "none", label: "以上暂时都没有", meaning: "none" },
        { value: "other", label: "有其他相关经历或成果", meaning: "other" },
        { value: "unknown", label: "暂时不确定有哪些适用的经历或成果", meaning: "unknown" }
      ]
    }]
  },
  {
    id: "q7", title: "每周投入", fields: [{
      id: "weeklyTime", label: "现阶段，你每周大约能稳定投入多少时间？", selection: "single", maxSelections: 1, exclusiveValues: [],
      options: [
        { value: "under-2", label: "不足 2 小时" },
        { value: "2-5", label: "约 2—5 小时" },
        { value: "6-10", label: "约 6—10 小时" },
        { value: "11-15", label: "约 11—15 小时" },
        { value: "16-plus", label: "16 小时及以上" },
        { value: "unknown", label: "目前还无法确定", meaning: "unknown" }
      ]
    }]
  },
  {
    id: "q8", title: "组队与资源", fields: [
      {
        id: "teamStatus", label: "你的组队状态最接近哪一种？", selection: "single", maxSelections: 1, exclusiveValues: [],
        options: [
          { value: "solo-preferred", label: "目前独自准备，优先考虑可以个人参加的形式" },
          { value: "seeking", label: "目前没有队伍，但愿意寻找队友" },
          { value: "potential", label: "已有可能合作的同学，还没有稳定分工" },
          { value: "stable", label: "已有相对稳定的队伍" },
          { value: "unknown", label: "暂时没有考虑", meaning: "unknown" }
        ]
      },
      {
        id: "resources", label: "你现在有哪些可以稳定使用的支持？", selection: "multiple", maxSelections: 3, exclusiveValues: ["none", "unknown"],
        options: [
          { value: "learning", label: "相关软件、学习资料或在线课程" },
          { value: "mentor", label: "老师、导师或有经验的学长学姐" },
          { value: "equipment", label: "实验室、设备、专业场地或制作条件" },
          { value: "data-access", label: "可用的数据、调研对象、行业联系或实践机会" },
          { value: "funding", label: "明确可用的项目经费或报销支持" },
          { value: "school-support", label: "学校组织、社团或相关报名支持" },
          { value: "none", label: "暂时没有稳定的额外支持", meaning: "none" },
          { value: "unknown", label: "还不清楚有哪些支持可用", meaning: "unknown" }
        ]
      }
    ]
  },
  {
    id: "q9", title: "参加方式", fields: [{
      id: "participationMode", label: "哪种参赛安排在现实中可以接受？", selection: "single", maxSelections: 1, exclusiveValues: [],
      options: [
        { value: "online-only", label: "只接受全程线上参与" },
        { value: "local", label: "可以线上参与，也可以参加本地线下活动" },
        { value: "domestic-travel", label: "国内异地活动可以考虑和安排" },
        { value: "international-travel", label: "必要时也可以考虑境外参赛" },
        { value: "unknown", label: "暂时不确定", meaning: "unknown" }
      ]
    }]
  },
  {
    id: "q10", title: "个人预算", fields: [{
      id: "budget", label: "对一项竞赛，你个人能够承担的总支出大致是多少？", selection: "single", maxSelections: 1, exclusiveValues: [],
      hint: "合计考虑报名、材料、必要软件和可能的差旅；不清楚可以选择待定。",
      options: [
        { value: "no-personal-cost", label: "仅考虑无需个人支出，或有明确经费覆盖的情况" },
        { value: "under-100", label: "100 元以内" },
        { value: "101-500", label: "101—500 元" },
        { value: "501-1500", label: "501—1,500 元" },
        { value: "over-1500", label: "超过 1,500 元也可以视价值考虑" },
        { value: "unlimited", label: "目前不设明确上限" },
        { value: "unknown", label: "还不了解相关费用，预算待定", meaning: "unknown" }
      ]
    }]
  }
];

export const DISCOVERY_FIELDS: readonly DiscoveryField[] = DISCOVERY_QUESTIONS.flatMap((question) => question.fields);
export const DISCOVERY_FIELD_BY_ID = Object.fromEntries(DISCOVERY_FIELDS.map((field) => [field.id, field])) as Record<DiscoveryFieldId, DiscoveryField>;
export const DISCOVERY_SUPPLEMENT_LABEL = "还有影响推荐的重要情况吗？";
export const DISCOVERY_SUPPLEMENT_HINT = "选填，最多 200 字。例如具体专业、实际做过的项目、确定不想参加的类型，或选项没有覆盖的情况。请勿填写姓名、学校名称、成绩排名或联系方式。";

export function createEmptyDiscoveryAnswers(): DiscoveryAnswers {
  const answers = {} as DiscoveryAnswers;
  for (const id of DISCOVERY_FIELD_IDS) answers[id] = { status: "unanswered", values: [] };
  return answers;
}

/** Works for both base questions and generated followups, including a full selection. */
export function toggleDiscoverySelection(
  field: Pick<DiscoveryField, "selection" | "maxSelections" | "exclusiveValues">,
  selectedValues: readonly string[],
  value: string
): string[] {
  if (field.selection === "single") return [value];
  if (selectedValues.includes(value)) return selectedValues.filter((selected) => selected !== value);
  if (field.exclusiveValues.includes(value)) return [value];
  const selected = selectedValues.filter((item) => !field.exclusiveValues.includes(item));
  return selected.length >= field.maxSelections ? selected : [...selected, value];
}

export function formatDiscoveryAnswer(field: DiscoveryField, answer: DiscoveryAnswer): string {
  if (answer.status === "skipped") return "暂未回答（未知；不能据此判断为没有能力、不感兴趣或不符合资格）";
  if (answer.status === "unanswered") return "尚未回答";
  const selected = answer.values.map((value, index) => {
    const label = field.options.find((option) => option.value === value)?.label ?? "未识别选项";
    return field.selection === "ranked" && value !== "unknown" ? `第${index + 1}优先：${label}` : label;
  }).join("；");
  return [selected, answer.text?.trim() ? `本人文字回答：${answer.text}` : ""].filter(Boolean).join("\n");
}

/** The same readable meaning is used for the student's review and the model input. */
export function formatDiscoveryAnswers(answers: DiscoveryAnswers): string {
  return DISCOVERY_QUESTIONS.map((question, index) => [
    `第 ${index + 1} 回合：${question.title}`,
    ...question.fields.map((field) => `${field.label}\n${formatDiscoveryAnswer(field, answers[field.id])}`)
  ].join("\n")).join("\n\n");
}

export function formatDiscoveryFollowups(questions: readonly DiscoveryFollowupQuestion[], answers: readonly DiscoveryFollowupAnswer[]): string {
  return questions.map((question, index) => {
    const answer = answers.find((item) => item.questionId === question.id);
    const text = !answer || answer.status === "skipped" ? "暂未回答，保持未知" : answer.values.map((value) => question.options.find((option) => option.value === value)?.label ?? "未识别选项").join("；");
    return `补充问题 ${index + 1}：${question.prompt}\n${text}`;
  }).join("\n\n");
}
