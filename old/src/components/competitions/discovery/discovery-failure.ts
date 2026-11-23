export type DiscoveryFailurePresentation = { message: string; canRetry: boolean };

const configurationErrors = new Set([
  "DISCOVERY_MISSING_API_KEY", "DISCOVERY_PROVIDER_NOT_ALLOWED", "DISCOVERY_AUTHENTICATION_ERROR", "DISCOVERY_INVALID_REQUEST",
  "DISCOVERY_CALL_CONFIGURATION_INVALID", "DISCOVERY_RUNTIME_GRANT_REQUIRED", "DISCOVERY_DISPATCH_RECEIPT_REQUIRED",
]);

/** Display only code-owned explanations, never provider messages or protocol data. */
export function discoveryFailurePresentation(code?: string): DiscoveryFailurePresentation {
  if (code === "DISCOVERY_CATALOG_CONTEXT_TOO_LARGE") return { message: "完整竞赛资料超出当前服务容量，需要调整资料后再生成；系统没有省略赛事。", canRetry: false };
  if (code && configurationErrors.has(code)) return { message: "AI 服务的连接或授权配置暂不可用，请修复本机配置后再试。", canRetry: false };
  if (code === "DISCOVERY_INSUFFICIENT_BALANCE") return { message: "AI 服务余额不足，本次报告未完成。需要补充余额后再试。", canRetry: false };
  if (code === "DISCOVERY_CONSENT_CHANGED") return { message: "AI 使用说明已更新，请清除这次记录并重新确认后再生成。", canRetry: false };
  if (code === "DISCOVERY_IMPLEMENTATION_CHANGED") return { message: "本机服务已更新，这次任务无法继续。请清除记录后重新作答。", canRetry: false };
  if (code === "DISCOVERY_TIMEOUT" || code === "DISCOVERY_CALL_DEADLINE") return { message: "本次生成因超时停止，等待上限为三分钟。可以稍后重新生成。", canRetry: true };
  if (code === "DISCOVERY_WORKER_INTERRUPTED") return { message: "本机服务中断，这次生成未完成。服务恢复后可以手动重新生成。", canRetry: true };
  if (code === "DISCOVERY_REFUSAL" || code === "DISCOVERY_MODEL_REFUSAL") return { message: "AI 服务未生成可展示的报告，本次内容已撤回。可以调整回答后重新尝试。", canRetry: true };
  if (code === "DISCOVERY_RATE_LIMITED") return { message: "AI 服务当前请求较多，这次报告未完成。请稍后重试。", canRetry: true };
  if (code && /^DISCOVERY_(?:DISCOVERY_)?MODEL_GATE_DAILY_BUDGET_EXHAUSTED$/.test(code)) return { message: "AI 服务当前可用额度已用完，待额度恢复后再试。", canRetry: false };
  return { message: "本次报告未完成，已显示的文字仅供查看，可以重新生成。", canRetry: true };
}
