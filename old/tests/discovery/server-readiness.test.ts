import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checks = vi.hoisted(() => ({
  active: vi.fn(), realpath: vi.fn(), readFile: vi.fn(), query: vi.fn(), release: vi.fn(), verify: vi.fn(), governor: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: checks.readFile, realpath: checks.realpath }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ connect: async () => ({ query: checks.query, release: checks.release }) }) }));
vi.mock("@/lib/ai/discovery-authority", () => ({ configuredDiscoveryAuthority: () => ({ mode: "server" }), verifyDiscoveryAuthority: checks.verify }));
vi.mock("@/lib/ai/model-call-governor", () => ({ getModelCallGovernorConfigurationSnapshot: checks.governor }));
vi.mock("@/lib/competitions/v7/active-release", () => ({ isActiveDecisionReleaseV7: checks.active }));
import { isServerDiscoveryReady } from "@/lib/competitions/discovery/server-readiness";
import { GET } from "@/app/api/health/ready/route";

const release = "/opt/resume-ai/releases/20261120T040000Z";
const healthFile = "/var/cache/resume-ai/20261120T040000Z/decision-worker-health.json";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const source = "a".repeat(64);
const governor = { schemaVersion: "saitu.model-call-governor.configuration.v3", executionMode: "finite",
  policyVersion: "saitu.model-call-governor.server-discovery-4.v1", transportConcurrencyHardMax: 4,
  transportConcurrencyEffectiveMax: 4, dailyCallLimit: null, persistentRequired: true, databaseConfigured: true };
let files: Map<string, string | Buffer>;

describe("production readiness", () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-20T04:00:00.000Z"));
    for (const [key, value] of Object.entries({ NODE_ENV: "production", SAITU_RUNTIME_MODE: "server", APP_RELEASE_DIR: release,
      SAITU_V7_WORKER_HEALTH_FILE: healthFile, SAITU_V7_SOURCE_SHA256: source, SAITU_DISCOVERY_SOURCE_SHA256: source })) vi.stubEnv(key, value);
    checks.active.mockReturnValue(true); checks.realpath.mockResolvedValue(release);
    checks.governor.mockReturnValue(governor); checks.query.mockResolvedValue({ rows: [{ one: 1 }] }); checks.verify.mockResolvedValue(undefined);
    const worker = Buffer.from("synthetic immutable worker");
    const binding = JSON.stringify({ schemaVersion: "saitu.next-worker-binding.v7", sourceSha256: source,
      workerArtifactSha256: sha(worker), nextBuildId: "synthetic-build" });
    files = new Map<string, string | Buffer>([
      [`${release}/dist/decision-worker/worker.mjs`, worker],
      [`${release}/.next/decision-worker-binding.json`, binding],
      [`${release}/.next/BUILD_ID`, "synthetic-build\n"],
      [`${release}/dist/decision-worker/manifest.json`, JSON.stringify({ schemaVersion: "saitu.worker-build.v7", nodeMajor: 24,
        sourceSha256: source, artifactSha256: sha(worker), nextBindingSha256: sha(binding), nextBuildId: "synthetic-build" })],
      [healthFile, JSON.stringify({ schemaVersion: "saitu.worker-health.v7", sourceSha256: source,
        releaseDirectory: release, status: "active", databaseReady: true, concurrency: 4, updatedAt: new Date().toISOString(), governor })],
    ]);
    checks.readFile.mockImplementation(async (filename: string) => {
      const value = files.get(filename);
      if (value === undefined) throw new Error("file missing");
      return value;
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  it("requires matching immutable artifacts, fresh worker evidence and an enabled database authority", async () => {
    expect(await isServerDiscoveryReady()).toBe(true);
    expect(checks.query).toHaveBeenCalledOnce();
    expect(checks.verify).toHaveBeenCalledWith(expect.anything(), { mode: "server" }, false, 1_500);
    expect(checks.release).toHaveBeenCalledOnce();
  });

  it.each(["worker bytes", "build id", "stale heartbeat", "worker policy", "inactive release", "local mode"])("rejects %s without certifying readiness", async reason => {
    if (reason === "worker bytes") files.set(`${release}/dist/decision-worker/worker.mjs`, Buffer.from("changed worker"));
    if (reason === "build id") files.set(`${release}/.next/BUILD_ID`, "different-build");
    if (reason === "stale heartbeat") vi.advanceTimersByTime(10_001);
    if (reason === "worker policy") {
      const heartbeat = JSON.parse(String(files.get(healthFile)));
      heartbeat.governor.dailyCallLimit = 1200;
      files.set(healthFile, JSON.stringify(heartbeat));
    }
    if (reason === "inactive release") checks.active.mockReturnValue(false);
    if (reason === "local mode") vi.stubEnv("SAITU_RUNTIME_MODE", "local");
    expect(await isServerDiscoveryReady()).toBe(false);
    expect(checks.verify).not.toHaveBeenCalled();
  });

  it("returns only a boolean and releases the connection when authorization fails", async () => {
    checks.verify.mockRejectedValue(new Error("sensitive database detail"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ready: false });
    expect(checks.release).toHaveBeenCalledOnce();
  });
});
