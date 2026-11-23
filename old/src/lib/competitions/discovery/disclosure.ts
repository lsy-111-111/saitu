/** Public disclosure; no server configuration or credentials belong here. */
const serverRuntime = process.env.SAITU_RUNTIME_MODE === "server";
export const DISCOVERY_CONSENT_VERSION = serverRuntime
  ? "2026-11-20.discovery.server.v1" : "2026-11-20.discovery.v2";

/** Existing submitted reports retain the consent given when they were created. */
export function isSupportedDiscoveryConsentVersion(version: string): boolean {
  return version === DISCOVERY_CONSENT_VERSION || !serverRuntime && version === "2026-11-19.discovery.v1";
}

export const DISCOVERY_CONSENT_DISCLOSURE = {
  schemaVersion: "ai-consent-disclosure.v1" as const,
  version: DISCOVERY_CONSENT_VERSION,
  heading: "发送前，请确认这次 AI 使用",
  body: `我单独同意赛途将我主动提交的学习阶段、学籍、专业、目标、兴趣、实际经历、时间、组队与资源、参加方式、预算的选项与逐题文字回答，以及我保留的历史补充说明，连同公开竞赛资料发送给 DeepSeek。核对提交后直接生成一次性推荐报告，DeepSeek 自主决定是否联网搜索与阅读资料；搜索可能使用与推荐有关的条件。请勿填写姓名、联系方式、身份证号等与推荐无关的个人信息。报告由 AI 生成，可能存在遗漏或错误，参赛资格和当届安排需自行核验。草稿在当前浏览器自最后编辑起保留24小时；提交的问答、任务和报告在${serverRuntime ? "网站服务器" : "本机服务端"}加密暂存，任务结束后保留24小时，同一浏览器可恢复最近一份。关闭页面后任务仍可继续，可主动停止或清除；不建立账号或报告历史。${serverRuntime ? "服务器每日生成备份并保留7天；清除当前内容不会改写已有备份，恢复时不延长过期内容的有效期。" : ""}费用与同意审计不保存问答原文。`,
  privacyHref: "/privacy"
};

export const DISCOVERY_AI_NOTICE = "本报告由 AI 生成，仅供参考。请以当届官方资料核验资格、赛程和费用。";
