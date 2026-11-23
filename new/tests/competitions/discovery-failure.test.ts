import { describe, expect, it } from "vitest";
import { discoveryFailurePresentation } from "@/components/competitions/discovery/discovery-failure";

describe("discovery report failure explanations", () => {
  it("requires fixing capacity or configuration failures before a new paid attempt", () => {
    expect(discoveryFailurePresentation("DISCOVERY_CATALOG_CONTEXT_TOO_LARGE")).toEqual({ message: expect.stringContaining("调整资料"), canRetry: false });
    expect(discoveryFailurePresentation("DISCOVERY_AUTHENTICATION_ERROR")).toEqual({ message: expect.stringContaining("修复本机配置"), canRetry: false });
    expect(discoveryFailurePresentation("DISCOVERY_INSUFFICIENT_BALANCE").canRetry).toBe(false);
  });

  it("explains timeout and interrupted local service while retaining explicit manual retry", () => {
    expect(discoveryFailurePresentation("DISCOVERY_TIMEOUT")).toEqual({ message: expect.stringContaining("三分钟"), canRetry: true });
    expect(discoveryFailurePresentation("DISCOVERY_WORKER_INTERRUPTED")).toEqual({ message: expect.stringContaining("本机服务中断"), canRetry: true });
  });

  it("does not expose protocol codes or provider text, including unknown errors", () => {
    const refusal = discoveryFailurePresentation("DISCOVERY_REFUSAL");
    expect(refusal.message).toContain("未生成可展示的报告");
    expect(refusal.message).not.toContain("DISCOVERY_");
    expect(discoveryFailurePresentation("raw-provider-message-secret").message).not.toContain("raw-provider");
  });
});
