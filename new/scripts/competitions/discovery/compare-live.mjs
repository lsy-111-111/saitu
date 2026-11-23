#!/usr/bin/env node
/** Explicit paid comparison entrypoint. No service lifecycle or model settings
 * are changed; verify-live owns signals, evidence and sequential dispatch. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "../../lib/direct-execution.mjs";

export async function runDiscoveryLiveComparison(args = process.argv.slice(2)) {
  const entry = fileURLToPath(new URL("./verify-live.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry, ...discoveryComparisonArguments(args)], { stdio: "inherit", env: process.env });
  // Forward interruption so the runner can cancel its active persisted run.
  const handlers = new Map(["SIGINT", "SIGTERM"].map(name => {
    const handler = () => child.kill(name);
    process.on(name, handler);
    return [name, handler];
  }));
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
    });
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
}

/** Keep the historical two-format default while allowing an explicit internal
 * protocol/multi-arm experiment. The wrapper never grants --live itself. */
export function discoveryComparisonArguments(args) {
  const selector = args.some(arg => ["--compare", "--presentation", "--protocol", "--variants"].includes(arg));
  return selector ? [...args] : ["--compare", ...args];
}

if (isDirectExecution(import.meta.url)) process.exitCode = await runDiscoveryLiveComparison();
