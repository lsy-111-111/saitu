import { describe, expect, it } from "vitest";
import { DISCOVERY_EXPERIMENT_PROTOCOLS, DISCOVERY_INITIAL_SCREENING_PROTOCOLS, DISCOVERY_SCREENING_CASE_IDS, buildDiscoveryExperimentSchedule,
  discoveryExperimentJobKey, discoveryExperimentProtocol, discoveryExperimentResultFilename,
  discoveryExperimentRound, parseDiscoveryExperimentProtocols, parseDiscoveryExperimentShard,
  partitionDiscoveryExperimentSchedule } from "../../scripts/competitions/discovery/experiment-schedule.mjs";
import { discoveryExperimentArguments } from "../../scripts/competitions/discovery/experiment-live.mjs";
import { discoveryComparisonArguments } from "../../scripts/competitions/discovery/compare-live.mjs";
import { DISCOVERY_ACCEPTANCE_PROFILES } from "./fixtures";
import { DEFAULT_DISCOVERY_GENERATION_PROTOCOL, DEFAULT_DISCOVERY_PRESENTATION_VERSION, DISCOVERY_GENERATION_PROTOCOLS,
  isDiscoveryGenerationProtocol } from "../../src/lib/competitions/discovery/generation-protocol";

describe("synthetic experiment matrix", () => {
  it("registers narrative arms consistently without expanding the original screening matrix", () => {
    expect(DISCOVERY_EXPERIMENT_PROTOCOLS.filter(protocol => protocol !== "legacy")).toEqual([...DISCOVERY_GENERATION_PROTOCOLS]);
    expect(DEFAULT_DISCOVERY_GENERATION_PROTOCOL).toBe("v16");
    expect(DEFAULT_DISCOVERY_PRESENTATION_VERSION).toBe("legacy");
    expect(DISCOVERY_EXPERIMENT_PROTOCOLS.slice(-8)).toEqual(["narrative", "narrative-rules", "narrative-index", "markdown-v16", "markdown-single", "markdown-nested", "markdown-late", "markdown-grounded-scope"]);
    expect(DISCOVERY_INITIAL_SCREENING_PROTOCOLS).toEqual([
      "legacy", "v16", "rules", "blocks", "refs", "json-optimized", "blocks-optimized",
    ]);
    for (const protocol of ["narrative", "narrative-rules", "markdown-grounded-scope"] as const) {
      expect(isDiscoveryGenerationProtocol(protocol)).toBe(true);
      expect(discoveryExperimentProtocol(protocol)).toBe(protocol);
      const [job] = buildDiscoveryExperimentSchedule([{ id: "one" }], [protocol], { startRound: 2 });
      expect(job).toMatchObject({ benchmarkVariant: protocol, protocolVersion: protocol,
        presentationVersion: "discovery-cards.v1", round: 2 });
      expect(discoveryExperimentResultFilename(job)).toBe(`one.r2.${protocol}.json`);
      expect(discoveryExperimentArguments(["--phase", "final", "--candidate", protocol])).toContain(`legacy,${protocol}`);
    }
  });

  it("schedules every predefined screening cell exactly once with independent evidence names", () => {
    const profiles = DISCOVERY_SCREENING_CASE_IDS.map(id => DISCOVERY_ACCEPTANCE_PROFILES.find(profile => profile.id === id)!);
    expect(profiles.every(Boolean)).toBe(true);
    const jobs = buildDiscoveryExperimentSchedule(profiles, DISCOVERY_INITIAL_SCREENING_PROTOCOLS, { rounds: 2 });
    expect(jobs).toHaveLength(70);
    expect(new Set(jobs.map(job => discoveryExperimentJobKey({ round: job.round, caseId: job.profile.id, benchmarkVariant: job.benchmarkVariant }))).size).toBe(70);
    expect(new Set(jobs.map(job => discoveryExperimentResultFilename(job))).size).toBe(70);
    for (const profile of profiles) for (const round of [1, 2]) {
      const cells = jobs.filter(job => job.profile.id === profile.id && job.round === round);
      expect(cells.map(job => job.benchmarkVariant).sort()).toEqual([...DISCOVERY_INITIAL_SCREENING_PROTOCOLS].sort());
      for (const cell of cells) {
        expect(cell.presentationVersion).toBe(cell.benchmarkVariant === "legacy" ? "legacy" : "discovery-cards.v1");
        expect(cell.protocolVersion).toBe(cell.benchmarkVariant === "legacy" ? undefined : cell.benchmarkVariant);
      }
    }
  });

  it("pairs all 15 cases across three rounds and crosses arm order for each case", () => {
    expect(DISCOVERY_ACCEPTANCE_PROFILES).toHaveLength(15);
    const jobs = buildDiscoveryExperimentSchedule(DISCOVERY_ACCEPTANCE_PROFILES, ["legacy", "refs"], { rounds: 3 });
    expect(jobs).toHaveLength(90);
    for (const profile of DISCOVERY_ACCEPTANCE_PROFILES) {
      const order = [1, 2, 3].map(round => jobs.filter(job => job.profile.id === profile.id && job.round === round).map(job => job.benchmarkVariant));
      expect(order[1]).toEqual([...order[0]].reverse());
      expect(order[2]).toEqual(order[0]);
    }
    expect(jobs.find(job => job.round === 2)?.profile.id).toBe(DISCOVERY_ACCEPTANCE_PROFILES.at(-1)?.id);
  });

  it("keeps absolute round identities when a fixed round is run separately", () => {
    const complete = buildDiscoveryExperimentSchedule([{ id: "one" }, { id: "two" }], ["legacy", "blocks"], { rounds: 3 });
    const single = buildDiscoveryExperimentSchedule([{ id: "one" }, { id: "two" }], ["legacy", "blocks"], { startRound: 3 });
    expect(single).toEqual(complete.filter(job => job.round === 3));
    expect(single.map(job => discoveryExperimentResultFilename(job))).toEqual([
      "one.r3.legacy.json", "one.r3.blocks.json", "two.r3.blocks.json", "two.r3.legacy.json",
    ]);
  });

  it("splits screening 3+2 without changing the global round and arm rotation", () => {
    const profiles = DISCOVERY_SCREENING_CASE_IDS.map(id => ({ id }));
    const global = buildDiscoveryExperimentSchedule(profiles, DISCOVERY_INITIAL_SCREENING_PROTOCOLS, { rounds: 2 });
    const first = partitionDiscoveryExperimentSchedule(global, profiles, parseDiscoveryExperimentShard("1/2"));
    const second = partitionDiscoveryExperimentSchedule(global, profiles, parseDiscoveryExperimentShard("2/2"));
    expect(first).toHaveLength(42);
    expect(second).toHaveLength(28);
    expect(new Set(first.map(job => job.profile.id)).size).toBe(3);
    expect(new Set(second.map(job => job.profile.id)).size).toBe(2);
    const key = (job: typeof global[number]) => discoveryExperimentJobKey({ round: job.round, caseId: job.profile.id, benchmarkVariant: job.benchmarkVariant });
    expect(new Set([...first, ...second].map(key)).size).toBe(global.length);
    for (const job of [...first, ...second]) expect(global).toContain(job);
    expect(() => parseDiscoveryExperimentShard("0/2")).toThrow();
    expect(() => parseDiscoveryExperimentShard("3/2")).toThrow("INVALID_EXPERIMENT_SHARD");
    expect(() => partitionDiscoveryExperimentSchedule(global, profiles, { index: 1, count: 6 })).toThrow("EMPTY_EXPERIMENT_SHARD");
  });

  it("rejects ambiguous arms, invalid ranges and path-like case identifiers", () => {
    expect(() => discoveryExperimentProtocol("production")).toThrow("INVALID_EXPERIMENT_PROTOCOL");
    expect(parseDiscoveryExperimentProtocols("legacy,refs")).toEqual(["legacy", "refs"]);
    expect(() => parseDiscoveryExperimentProtocols("legacy,legacy")).toThrow("DUPLICATE_EXPERIMENT_PROTOCOL");
    for (const round of [0, -1, 1.5, "1e2", "", 101]) expect(() => discoveryExperimentRound(round)).toThrow("INVALID_EXPERIMENT_ROUND");
    expect(() => buildDiscoveryExperimentSchedule([{ id: "one" }], ["legacy"], { startRound: 100, rounds: 2 })).toThrow("INVALID_EXPERIMENT_ROUND_RANGE");
    expect(() => buildDiscoveryExperimentSchedule([{ id: "one" }, { id: "one" }], ["legacy"])).toThrow("INVALID_EXPERIMENT_CASES");
    expect(() => buildDiscoveryExperimentSchedule([{ id: "../one" }], ["legacy"])).toThrow("INVALID_EXPERIMENT_CASES");
  });
});

describe("explicit paid experiment arguments", () => {
  it("expands the screening plan without granting paid execution", () => {
    const args = discoveryExperimentArguments(["--phase", "screening"]);
    expect(args).toEqual(["--case", DISCOVERY_SCREENING_CASE_IDS.join(","), "--variants", DISCOVERY_INITIAL_SCREENING_PROTOCOLS.join(","), "--rounds", "2"]);
    expect(args).not.toContain("--live");
    expect(discoveryExperimentArguments(["--phase", "screening", "--live", "--capture-synthetic"])).toContain("--live");
  });

  it("requires a selected final candidate and preserves the complete three-round plan", () => {
    expect(discoveryExperimentArguments(["--phase", "final", "--candidate", "refs", "--live"])).toEqual([
      "--live", "--all", "--variants", "legacy,refs", "--rounds", "3",
    ]);
    expect(discoveryExperimentArguments(["--phase", "final", "--candidate", "v16"])).toContain("legacy,v16");
    expect(() => discoveryExperimentArguments(["--phase", "final"])).toThrow("FINAL_EXPERIMENT_REQUIRES_SELECTED_CANDIDATE");
    expect(() => discoveryExperimentArguments(["--phase", "final", "--candidate", "legacy"])).toThrow("FINAL_EXPERIMENT_REQUIRES_SELECTED_CANDIDATE");
    expect(() => discoveryExperimentArguments(["--phase", "screening", "--rounds", "1"])).toThrow("EXPERIMENT_PHASE_OWNS_VARIANTS_AND_ROUNDS");
  });

  it("retains historical comparison defaults while accepting an explicit internal arm", () => {
    expect(discoveryComparisonArguments(["--case", "one"])).toEqual(["--compare", "--case", "one"]);
    expect(discoveryComparisonArguments(["--compare", "--case", "one"])).toEqual(["--compare", "--case", "one"]);
    expect(discoveryComparisonArguments(["--protocol", "rules", "--round", "2"])).toEqual(["--protocol", "rules", "--round", "2"]);
    expect(discoveryComparisonArguments(["--variants", "legacy,rules", "--rounds", "3"])).toEqual(["--variants", "legacy,rules", "--rounds", "3"]);
  });
});
