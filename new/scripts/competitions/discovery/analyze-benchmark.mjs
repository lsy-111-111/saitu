#!/usr/bin/env node
/** Offline artifact analysis only: no environment, application or model imports.
 * --plan is the predeclared acceptance options JSON, not selected after results.
 * Original result/review files are never modified; --output uses exclusive create.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateDiscoveryBenchmark } from "./benchmark-stats.mjs";

export function parseDiscoveryBenchmarkAnalysisArgs(args) {
  const parsed = { directories: [], timingReviewFiles: [], qualityReviewFiles: [] };
  const multiple = { "--directory": "directories", "--timing-review": "timingReviewFiles", "--quality-review": "qualityReviewFiles" };
  const single = { "--plan": "planFile", "--output": "outputFile" };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index], value = args[++index];
    if ((!multiple[key] && !single[key]) || !value || value.startsWith("--")) throw new Error("BENCHMARK_ANALYSIS_ARGUMENTS_INVALID");
    if (multiple[key]) parsed[multiple[key]].push(value);
    else if (parsed[single[key]]) throw new Error("BENCHMARK_ANALYSIS_ARGUMENT_DUPLICATED");
    else parsed[single[key]] = value;
  }
  if (!parsed.directories.length || !parsed.planFile) throw new Error("BENCHMARK_ANALYSIS_REQUIRES_DIRECTORY_AND_PLAN");
  if (new Set(parsed.directories.map(value => path.resolve(value))).size !== parsed.directories.length) throw new Error("BENCHMARK_ANALYSIS_DIRECTORY_DUPLICATED");
  return parsed;
}

async function jsonArtifact(filename) {
  const text = await readFile(filename, "utf8");
  return { value: JSON.parse(text), evidence: { filename: path.resolve(filename), sha256: createHash("sha256").update(text).digest("hex") } };
}
function reviewRows(value) {
  const rows = Array.isArray(value) ? value : value?.cases ?? value?.rows;
  if (!Array.isArray(rows)) throw new Error("BENCHMARK_ANALYSIS_REVIEW_ROWS_INVALID");
  return rows;
}

export async function analyzeDiscoveryBenchmarkArtifacts(options) {
  const plan = await jsonArtifact(options.planFile), results = [], resultFiles = [], ignoredFiles = [];
  for (const directory of options.directories) {
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".json")).sort()) {
      const file = await jsonArtifact(path.join(directory, name));
      if (file.value?.schemaVersion === "saitu.discovery-live-acceptance.v1") {
        results.push(file.value); resultFiles.push(file.evidence);
      } else ignoredFiles.push(path.resolve(directory, name));
    }
  }
  const timingReviews = [], timingReviewFiles = [], qualityFiles = [], qualityRows = [], qualityValues = [];
  for (const filename of options.timingReviewFiles ?? []) {
    const file = await jsonArtifact(filename); timingReviews.push(...reviewRows(file.value)); timingReviewFiles.push(file.evidence);
  }
  for (const filename of options.qualityReviewFiles ?? []) {
    const file = await jsonArtifact(filename);
    qualityRows.push(...reviewRows(file.value)); qualityValues.push(file.value); qualityFiles.push(file.evidence);
  }
  const quality = qualityValues.length ? { rows: qualityRows,
    complete: qualityValues.every(value => value.complete === true),
    blinded: qualityValues.some(value => value.blinded === false) ? false : qualityValues.every(value => value.blinded === true) ? true : undefined,
    noRegression: qualityValues.some(value => value.noRegression === false) ? false : qualityValues.every(value => value.noRegression === true) ? true : undefined,
  } : undefined;
  const acceptance = evaluateDiscoveryBenchmark(results, { ...plan.value, timingReviews, quality });
  return { ...acceptance, inputEvidence: { plan: plan.evidence, resultFiles, timingReviewFiles, qualityFiles, ignoredFiles,
    actualResultRecords: results.length, analysis: "offline_saved_artifacts_only" } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseDiscoveryBenchmarkAnalysisArgs(process.argv.slice(2));
    const output = JSON.stringify(await analyzeDiscoveryBenchmarkArtifacts(options), null, 2) + "\n";
    if (options.outputFile) await writeFile(options.outputFile, output, { flag: "wx", mode: 0o600 });
    else process.stdout.write(output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "BENCHMARK_ANALYSIS_FAILED"); process.exitCode = 1;
  }
}
