import type { DiscoveryRunSnapshot } from "@/lib/competitions/discovery/transport";

export function discoveryRetryStatus(run: DiscoveryRunSnapshot | null): string | null {
  return run && (run.status === "queued" || run.status === "running") && run.attempt > 1
    ? "上一次生成未完成，乐乐正在重新生成报告，正文会从头显示。"
    : null;
}
