import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCTION_ACCEPTANCE_CASE_IDS } from "../../scripts/server/verify-live.mjs";

const project = process.cwd();
let temporary: string, current: string;
beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "saitu-current-cli-"));
  current = path.join(temporary, "current");
  await symlink(project, current, "dir");
});
afterAll(async () => { await rm(temporary, { recursive: true, force: true }); });

function node(args: string[], overrides: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: project,
      env: { ...process.env, DATABASE_URL: "", SAITU_MAINTENANCE_DATABASE_URL: "", AI_API_KEY: "", OPENAI_API_KEY: "",
        AI_CONVERSATION_SIGNING_SECRET: "", ...overrides },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI regression subprocess timed out")); }, 5_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
    child.stdin.end();
  });
}

describe("server CLIs invoked through the deployed current symlink", () => {
  it("runs the live runner's read-only list entrypoint and prints all eight cases", async () => {
    const result = await node([path.join(current, "scripts/server/verify-live.mjs"), "--list"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Explicit paid acceptance:");
    expect(result.stdout.split("\n").filter(line => PRODUCTION_ACCEPTANCE_CASE_IDS.includes(line)))
      .toEqual(PRODUCTION_ACCEPTANCE_CASE_IDS);
    expect(result.stderr).toBe("");
  });

  it("actually executes retention and fails clearly when no database was configured", async () => {
    const result = await node([path.join(current, "scripts/server/retention.mjs")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"event":"saitu_retention_failed"');
    expect(result.stdout).not.toContain("saitu_retention_completed");
  });

  it("actually executes restore verification and fails before connecting when its secret is missing", async () => {
    const result = await node([path.join(current, "scripts/server/verify-restored-data.mjs")], {
      SAITU_MAINTENANCE_DATABASE_URL: "postgresql:///saitu_restore_cli_regression?host=/var/run/postgresql"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"event":"saitu_restored_data_verification_failed"');
    expect(result.stdout).not.toContain("saitu_restored_data_verified");
  });

  it("keeps ordinary imports inert when argv has no script entrypoint", async () => {
    const modules = ["verify-live.mjs", "retention.mjs", "verify-restored-data.mjs"]
      .map(name => pathToFileURL(path.join(current, "scripts/server", name)).href);
    const source = `${modules.map(url => `await import(${JSON.stringify(url)});`).join("\n")}\nconsole.log("imported without main");`;
    const result = await node(["--input-type=module", "--eval", source]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("imported without main");
    expect(result.stderr).toBe("");
  });

  it("keeps imports inert when another real script is the entrypoint", async () => {
    const modules = ["verify-live.mjs", "retention.mjs", "verify-restored-data.mjs"]
      .map(name => pathToFileURL(path.join(current, "scripts/server", name)).href);
    const entrypoint = path.join(temporary, "import-server-clis.mjs");
    await writeFile(entrypoint, `${modules.map(url => `await import(${JSON.stringify(url)});`).join("\n")}\nconsole.log("imported by another script");`);
    const result = await node([entrypoint]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("imported by another script");
    expect(result.stderr).toBe("");
  });

  it("also executes a direct path that does not contain a symlink", async () => {
    const source = path.join(project, "scripts/server/verify-live.mjs");
    const result = await node([source, "--list"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(PRODUCTION_ACCEPTANCE_CASE_IDS[7]);
    expect(result.stderr).toBe("");
  });
});
