#!/usr/bin/env node
/** Explicit synthetic experiments only. This entrypoint never starts services,
 * changes model settings or retries an entire failed experiment in secret. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "../../lib/direct-execution.mjs";
import { DISCOVERY_INITIAL_SCREENING_PROTOCOLS, DISCOVERY_SCREENING_CASE_IDS, discoveryExperimentProtocol } from "./experiment-schedule.mjs";

export function discoveryExperimentArguments(args) {
  const rest = [];
  let phase, candidate;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--phase" && ["screening", "final"].includes(args[index + 1])) phase = args[++index];
    else if (args[index] === "--candidate" && args[index + 1]) candidate = discoveryExperimentProtocol(args[++index]);
    else rest.push(args[index]);
  }
  if (!phase) throw new Error("Choose --phase screening|final; add explicit --live to dispatch paid calls.");
  if (rest.some(arg => ["--compare", "--protocol", "--presentation", "--variants", "--rounds", "--round"].includes(arg)))
    throw new Error("EXPERIMENT_PHASE_OWNS_VARIANTS_AND_ROUNDS");
  if (phase === "screening") {
    if (candidate) throw new Error("SCREENING_TESTS_ALL_PREDEFINED_VARIANTS");
    const selected = rest.includes("--case") || rest.includes("--all") ? [] : ["--case", DISCOVERY_SCREENING_CASE_IDS.join(",")];
    return [...rest, ...selected, "--variants", DISCOVERY_INITIAL_SCREENING_PROTOCOLS.join(","), "--rounds", "2"];
  }
  if (!candidate || candidate === "legacy") throw new Error("FINAL_EXPERIMENT_REQUIRES_SELECTED_CANDIDATE");
  const selected = rest.includes("--case") || rest.includes("--all") ? [] : ["--all"];
  return [...rest, ...selected, "--variants", ["legacy", candidate].join(","), "--rounds", "3"];
}

export async function runDiscoveryExperiment(args = process.argv.slice(2)) {
  const forwarded = discoveryExperimentArguments(args);
  const entry = fileURLToPath(new URL("./verify-live.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry, ...forwarded], { stdio: "inherit", env: process.env });
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

if (isDirectExecution(import.meta.url)) process.exitCode = await runDiscoveryExperiment();
