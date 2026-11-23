import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { analyzeDiscoveryBenchmarkArtifacts, parseDiscoveryBenchmarkAnalysisArgs } from "../../scripts/competitions/discovery/analyze-benchmark.mjs";
import { DISCOVERY_ACCEPTANCE_PROFILES } from "./fixtures";
import { DISCOVERY_OPTIONAL_CARD_CASE_IDS } from "../../scripts/competitions/discovery/benchmark-stats.mjs";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function inputs() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "discovery-statistics-"));
  temporary.push(directory);
  const results = path.join(directory, "results"); await mkdir(results);
  const planFile = path.join(directory, "plan.json");
  await writeFile(planFile, JSON.stringify({ baselineVariant: "legacy", candidateVariant: "blocks", rounds: 3,
    cases: DISCOVERY_ACCEPTANCE_PROFILES.map(profile => ({ caseId: profile.id,
      cardExpectation: DISCOVERY_OPTIONAL_CARD_CASE_IDS.includes(profile.id) ? "optional" : "required" })) }));
  return { directory, results, planFile };
}

describe("offline artifact analysis", () => {
  it("accepts independent evidence files and rejects accidental duplicate flags/directories", () => {
    expect(parseDiscoveryBenchmarkAnalysisArgs(["--directory", "a", "--directory", "b", "--plan", "plan.json",
      "--timing-review", "t1.json", "--timing-review", "t2.json", "--quality-review", "quality.json"]))
      .toEqual({ directories: ["a", "b"], planFile: "plan.json", timingReviewFiles: ["t1.json", "t2.json"], qualityReviewFiles: ["quality.json"] });
    expect(() => parseDiscoveryBenchmarkAnalysisArgs(["--directory", "a", "--plan", "x", "--plan", "y"])).toThrow("DUPLICATED");
    expect(() => parseDiscoveryBenchmarkAnalysisArgs(["--directory", "a", "--directory", "./a", "--plan", "x"])).toThrow("DIRECTORY_DUPLICATED");
    expect(() => parseDiscoveryBenchmarkAnalysisArgs(["--live", "yes"])).toThrow("ARGUMENTS_INVALID");
  });

  it("hashes original per-run evidence and holds with the full fixed denominator", async () => {
    const { directory, results, planFile } = await inputs();
    const resultFile = path.join(results, "vocational-first-entry.r1.blocks.json");
    const original = JSON.stringify({ schemaVersion: "saitu.discovery-live-acceptance.v1", caseId: "vocational-first-entry", round: 1,
      benchmarkVariant: "blocks", presentationVersion: "discovery-cards.v1", runId: "failed-run", passed: false,
      status: "failed", error: "INVALID_OUTPUT", elapsedMs: 180_000 });
    await writeFile(resultFile, original);
    await writeFile(path.join(results, "summary.json"), JSON.stringify({ schemaVersion: "saitu.discovery-experiment-summary.v1" }));
    const qualityFile = path.join(directory, "quality.json");
    await writeFile(qualityFile, JSON.stringify({ complete: false, rows: [] }));
    const output = await analyzeDiscoveryBenchmarkArtifacts({ directories: [results], planFile, qualityReviewFiles: [qualityFile] });
    expect(output.decision).toBe("hold");
    expect(output.metrics.firstCard.count).toBe(33);
    expect(output.metrics.whole.count).toBe(45);
    expect(output.gates.qualityReview.status).toBe("pending");
    expect(output.inputEvidence).toMatchObject({ actualResultRecords: 1, analysis: "offline_saved_artifacts_only" });
    expect(output.inputEvidence.resultFiles[0].sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(output.inputEvidence.ignoredFiles).toEqual([path.join(results, "summary.json")]);
    expect(await readFile(resultFile, "utf8")).toBe(original);
  });

  it("refuses to overwrite an existing output artifact", async () => {
    const { directory, results, planFile } = await inputs();
    const output = path.join(directory, "acceptance.json");
    await writeFile(output, "preserved original evidence");
    const run = spawnSync(process.execPath, [path.resolve("scripts/competitions/discovery/analyze-benchmark.mjs"),
      "--directory", results, "--plan", planFile, "--output", output], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("EEXIST");
    expect(await readFile(output, "utf8")).toBe("preserved original evidence");
  });
});
