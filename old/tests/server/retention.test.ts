import { describe, expect, it } from "vitest";
import { retentionDatabaseUrl } from "../../scripts/server/retention.mjs";

describe("maintenance database boundary", () => {
  it("uses a separate peer-authenticated maintenance connection ahead of the runtime connection", () => {
    const maintenance = "postgresql:///saitu_production?host=/var/run/postgresql";
    expect(retentionDatabaseUrl({ SAITU_MAINTENANCE_DATABASE_URL: maintenance,
      DATABASE_URL: "postgresql://runtime@127.0.0.1:5432/saitu_production" })).toBe(maintenance);
    expect(retentionDatabaseUrl({ DATABASE_URL: "postgresql://admin@127.0.0.1:5433/isolated_test" }))
      .toBe("postgresql://admin@127.0.0.1:5433/isolated_test");
  });

  it("rejects a missing connection, remote hosts and arbitrary socket/query options", () => {
    expect(() => retentionDatabaseUrl({})).toThrow("RETENTION_DATABASE_URL_REQUIRED");
    for (const value of [
      "https://127.0.0.1/saitu", "postgresql://remote.example/saitu", "postgresql://127.0.0.1:9999/saitu",
      "postgresql:///saitu?host=/tmp", "postgresql:///saitu?host=/var/run/postgresql&host=/tmp",
      "postgresql://127.0.0.1/saitu?options=-csearch_path%3Dother", "postgresql://127.0.0.1/saitu#x",
    ]) expect(() => retentionDatabaseUrl({ DATABASE_URL: value })).toThrow(/RETENTION_/);
  });
});
