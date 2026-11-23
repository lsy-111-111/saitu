import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({ lstat: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), lstatSync: filesystem.lstat }));
import {
  assertServerDiscoveryAdmissionsOpen, assertServerDiscoveryQueueCapacity,
  lockServerDiscoveryAdmission, SERVER_DISCOVERY_ADMISSION_LOCK,
  SERVER_DISCOVERY_MAINTENANCE_FILE, serverDiscoveryCanStartQueuedRun,
} from "@/lib/competitions/discovery/server-admission";

describe("server discovery admission", () => {
  beforeEach(() => {
    vi.stubEnv("SAITU_RUNTIME_MODE", "server");
    filesystem.lstat.mockReset().mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses the shared deployment barrier and rejects new work while maintenance exists", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await lockServerDiscoveryAdmission({ query });
    expect(query).toHaveBeenCalledWith("select pg_advisory_xact_lock($1::bigint)", [SERVER_DISCOVERY_ADMISSION_LOCK]);
    expect(() => assertServerDiscoveryAdmissionsOpen()).not.toThrow();
    filesystem.lstat.mockReturnValue({});
    expect(() => assertServerDiscoveryAdmissionsOpen()).toThrow("DISCOVERY_MAINTENANCE");
    expect(filesystem.lstat).toHaveBeenCalledWith(SERVER_DISCOVERY_MAINTENANCE_FILE);
  });

  it("fails closed when the maintenance marker cannot be inspected", () => {
    filesystem.lstat.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(() => assertServerDiscoveryAdmissionsOpen()).toThrow("DISCOVERY_UNAVAILABLE");
  });

  it("bounds outstanding reports at eight and running reports at four", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: 7 }] });
    await expect(assertServerDiscoveryQueueCapacity({ query })).resolves.toBeUndefined();
    query.mockResolvedValue({ rows: [{ count: 8 }] });
    await expect(assertServerDiscoveryQueueCapacity({ query })).rejects.toThrow("DISCOVERY_BUSY");
    query.mockResolvedValue({ rows: [{ count: 3 }] });
    expect(await serverDiscoveryCanStartQueuedRun({ query })).toBe(true);
    query.mockResolvedValue({ rows: [{ count: 4 }] });
    expect(await serverDiscoveryCanStartQueuedRun({ query })).toBe(false);
  });

  it("preserves local admission without querying the production queue or marker", async () => {
    vi.stubEnv("SAITU_RUNTIME_MODE", "local");
    const query = vi.fn();
    await lockServerDiscoveryAdmission({ query });
    assertServerDiscoveryAdmissionsOpen();
    await assertServerDiscoveryQueueCapacity({ query });
    expect(await serverDiscoveryCanStartQueuedRun({ query })).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(filesystem.lstat).not.toHaveBeenCalled();
  });
});
