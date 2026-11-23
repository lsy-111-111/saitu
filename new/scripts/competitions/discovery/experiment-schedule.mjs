/** Pure synthetic experiment scheduling. No network, credentials or dispatch. */
export const DISCOVERY_EXPERIMENT_PROTOCOLS = [
  "legacy", "v16", "rules", "blocks", "refs", "json-optimized", "blocks-optimized",
  "blocks-flow", "json-flat", "blocks-flow-named",
  "narrative", "narrative-rules", "narrative-index",
  "markdown-v16", "markdown-single", "markdown-nested", "markdown-late",
  "markdown-grounded-scope",
];
export const DISCOVERY_INITIAL_SCREENING_PROTOCOLS = DISCOVERY_EXPERIMENT_PROTOCOLS.slice(0, 7);
export const DISCOVERY_SCREENING_CASE_IDS = [
  "senior-software-portfolio", "doctoral-life-science", "catalog-tail-geophysics", "online-only-hard-limit", "all-uncertain",
];

export function discoveryExperimentProtocol(value) {
  if (!DISCOVERY_EXPERIMENT_PROTOCOLS.includes(value)) throw new Error("INVALID_EXPERIMENT_PROTOCOL");
  return value;
}

export function discoveryExperimentRound(value) {
  const number = typeof value === "number" ? value : /^\d+$/u.test(value ?? "") ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > 100) throw new Error("INVALID_EXPERIMENT_ROUND");
  return number;
}

export function parseDiscoveryExperimentProtocols(value) {
  if (typeof value !== "string" || !value) throw new Error("INVALID_EXPERIMENT_PROTOCOLS");
  const variants = value.split(",").map(discoveryExperimentProtocol);
  if (new Set(variants).size !== variants.length) throw new Error("DUPLICATE_EXPERIMENT_PROTOCOL");
  return variants;
}

export const discoveryExperimentJobKey = ({ round, caseId, benchmarkVariant }) => JSON.stringify([round, caseId, benchmarkVariant]);

export function parseDiscoveryExperimentShard(value) {
  const match = typeof value === "string" && /^(\d+)\/(\d+)$/u.exec(value);
  if (!match) throw new Error("INVALID_EXPERIMENT_SHARD");
  const index = discoveryExperimentRound(match[1]), count = discoveryExperimentRound(match[2]);
  if (index > count) throw new Error("INVALID_EXPERIMENT_SHARD");
  return { index, count };
}

/** Partition cases after global arm rotation is fixed. Independent runners
 * therefore reproduce the same round/arm order as the unsharded matrix. */
export function partitionDiscoveryExperimentSchedule(jobs, profiles, shard) {
  if (!shard) return [...jobs];
  const { index, count } = parseDiscoveryExperimentShard(`${shard.index}/${shard.count}`);
  if (count > profiles.length) throw new Error("EMPTY_EXPERIMENT_SHARD");
  const caseIds = new Set(profiles.filter((_, caseIndex) => caseIndex % count === index - 1).map(profile => profile.id));
  return jobs.filter(job => caseIds.has(job.profile.id));
}

/** Rotate arm order within each case, and reverse case order on alternate rounds.
 * Every predefined case/round/arm remains scheduled, including failed runs. */
export function buildDiscoveryExperimentSchedule(profiles, variants, { startRound = 1, rounds = 1 } = {}) {
  startRound = discoveryExperimentRound(startRound);
  rounds = discoveryExperimentRound(rounds);
  if (startRound + rounds - 1 > 100) throw new Error("INVALID_EXPERIMENT_ROUND_RANGE");
  if (!Array.isArray(profiles) || !profiles.length || profiles.some(profile => !profile || typeof profile.id !== "string" || !/^[a-z0-9-]+$/u.test(profile.id))
    || new Set(profiles.map(profile => profile.id)).size !== profiles.length)
    throw new Error("INVALID_EXPERIMENT_CASES");
  if (!Array.isArray(variants)) throw new Error("INVALID_EXPERIMENT_PROTOCOLS");
  const protocols = variants.map(discoveryExperimentProtocol);
  if (!protocols.length || new Set(protocols).size !== protocols.length) throw new Error("INVALID_EXPERIMENT_PROTOCOLS");
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  let stride = Math.max(1, profiles.length % protocols.length);
  while (gcd(stride, protocols.length) !== 1) stride += 1;
  const jobs = [];
  for (let round = startRound; round < startRound + rounds; round += 1) {
    const indices = profiles.map((_, index) => index);
    if (round % 2 === 0) indices.reverse();
    for (const caseIndex of indices) {
      // Coprime rotation covers each arm position over a full cycle. For a
      // two-arm comparison it alternates AB/BA for the same case each round.
      const offset = (caseIndex + (round - 1) * stride) % protocols.length;
      const ordered = [...protocols.slice(offset), ...protocols.slice(0, offset)];
      for (const protocol of ordered) jobs.push({
        profile: profiles[caseIndex], round, benchmarkVariant: protocol,
        presentationVersion: protocol === "legacy" ? "legacy" : "discovery-cards.v1",
        protocolVersion: protocol === "legacy" ? undefined : protocol,
      });
    }
  }
  return jobs;
}

export function discoveryExperimentResultFilename(job, { legacyFilenames = false } = {}) {
  if (!/^[a-z0-9-]+$/u.test(job.profile.id)) throw new Error("INVALID_EXPERIMENT_CASE_ID");
  const variant = discoveryExperimentProtocol(job.benchmarkVariant);
  const round = discoveryExperimentRound(job.round);
  if (legacyFilenames) return `${job.profile.id}.${variant === "legacy" ? "legacy" : "cards"}.json`;
  return `${job.profile.id}.r${round}.${variant}.json`;
}
