import "server-only";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getPool } from "@/lib/db/pool";
import { configuredDiscoveryAuthority, verifyDiscoveryAuthority } from "@/lib/ai/discovery-authority";
import { getModelCallGovernorConfigurationSnapshot } from "@/lib/ai/model-call-governor";
import { isActiveDecisionReleaseV7 } from "../v7/active-release";
import { isServerDiscoveryRuntime, SERVER_DISCOVERY_RUNNING_MAX } from "./server-admission";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const governorSchema = z.object({
  schemaVersion: z.literal("saitu.model-call-governor.configuration.v3"),
  executionMode: z.literal("finite"),
  policyVersion: z.literal("saitu.model-call-governor.server-discovery-4.v1"),
  transportConcurrencyHardMax: z.literal(4), transportConcurrencyEffectiveMax: z.literal(4),
  dailyCallLimit: z.null(), persistentRequired: z.literal(true), databaseConfigured: z.literal(true),
});
const manifestSchema = z.object({
  schemaVersion: z.literal("saitu.worker-build.v7"), nodeMajor: z.literal(24),
  sourceSha256: sha, artifactSha256: sha, nextBindingSha256: sha, nextBuildId: z.string().min(1),
});
const bindingSchema = z.object({
  schemaVersion: z.literal("saitu.next-worker-binding.v7"), sourceSha256: sha,
  workerArtifactSha256: sha, nextBuildId: z.string().min(1),
});
const heartbeatSchema = z.object({
  schemaVersion: z.literal("saitu.worker-health.v7"), sourceSha256: sha,
  releaseDirectory: z.string(), status: z.literal("active"), databaseReady: z.literal(true),
  concurrency: z.literal(SERVER_DISCOVERY_RUNNING_MAX), updatedAt: z.string().datetime(),
  governor: governorSchema,
});

/** Content-free readiness for the host's local monitor. Maintenance deliberately
 * leaves this available so deployment can validate a release before reopening
 * submissions. The public reverse proxy denies the health namespace. */
export async function isServerDiscoveryReady(): Promise<boolean> {
  try {
    if (!isServerDiscoveryRuntime() || process.env.NODE_ENV !== "production" || !isActiveDecisionReleaseV7()) return false;
    const authority = configuredDiscoveryAuthority();
    if (authority.mode !== "server") return false;
    governorSchema.parse(getModelCallGovernorConfigurationSnapshot());
    const release = process.env.APP_RELEASE_DIR;
    if (!release || await realpath(process.cwd()) !== release) return false;
    const healthFile = `/var/cache/resume-ai/${path.basename(release)}/decision-worker-health.json`;
    if (process.env.SAITU_V7_WORKER_HEALTH_FILE !== healthFile) return false;
    const [manifestBytes, bindingBytes, workerBytes, buildIdBytes, heartbeatBytes] = await Promise.all([
      readFile(path.join(release, "dist/decision-worker/manifest.json"), "utf8"),
      readFile(path.join(release, ".next/decision-worker-binding.json"), "utf8"),
      readFile(path.join(release, "dist/decision-worker/worker.mjs")),
      readFile(path.join(release, ".next/BUILD_ID"), "utf8"),
      readFile(healthFile, "utf8"),
    ]);
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes));
    const binding = bindingSchema.parse(JSON.parse(bindingBytes));
    const heartbeat = heartbeatSchema.parse(JSON.parse(heartbeatBytes));
    const heartbeatAge = Date.now() - Date.parse(heartbeat.updatedAt);
    if (heartbeatAge < -1_000 || heartbeatAge > 10_000
      || heartbeat.releaseDirectory !== release || heartbeat.sourceSha256 !== manifest.sourceSha256
      || manifest.sourceSha256 !== process.env.SAITU_V7_SOURCE_SHA256
      || manifest.sourceSha256 !== process.env.SAITU_DISCOVERY_SOURCE_SHA256
      || binding.sourceSha256 !== manifest.sourceSha256
      || manifest.artifactSha256 !== hash(workerBytes) || binding.workerArtifactSha256 !== manifest.artifactSha256
      || manifest.nextBindingSha256 !== hash(bindingBytes)
      || binding.nextBuildId !== manifest.nextBuildId || buildIdBytes.trim() !== manifest.nextBuildId) return false;
    const client = await getPool().connect();
    try {
      const probe = { text: "select 1", query_timeout: 1_500 };
      await client.query(probe);
      await verifyDiscoveryAuthority(client, authority, false, 1_500);
    } finally { client.release(); }
    return true;
  } catch { return false; }
}
