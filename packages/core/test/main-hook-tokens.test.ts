/**
 * The real packages/core/src/main.ts, as its own process, refusing to start without per-agent hook tokens.
 * A shared token must not silently come back, so none of these may get as far as listening. It stops at the
 * tokens, before identities, so nothing here reaches Switch, and the port is one nothing else uses.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

const PACKAGE = join(import.meta.dirname, "..");

function dataDir(tokens: string | null, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "core-main-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  if (tokens !== null) {
    const file = join(dir, "hook-tokens.json");
    writeFileSync(file, tokens, { mode });
    chmodSync(file, mode);
  }
  return dir;
}

/** `node` may be a Volta shim here, so the child leads its own process group and the group gets killed. */
function startCore(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(PACKAGE, "src/main.ts")], {
      cwd: PACKAGE,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CLEARANCE_INTERNAL_TOKEN: "an-internal-token",
        CLEARANCE_CORE_PORT: "7799",
        SWITCH_BRIDGE_URL: "http://127.0.0.1:1",
        ...env,
      },
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone, which is the normal case.
      }
    };
    const limit = setTimeout(killGroup, 25_000);
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(limit);
      killGroup();
      resolve({ code, stderr });
    });
  });
}

describe("core refuses to start without per-agent hook tokens", { timeout: 30_000 }, () => {
  it.each([
    ["the file is missing", null],
    ["the file is empty", ""],
    ["the file holds no tokens", "{}"],
    ["the file is not JSON", "not json"],
  ])("when %s", async (_name, tokens) => {
    const out = await startCore({ CLEARANCE_DATA_DIR: dataDir(tokens) });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("hook-tokens.json");
    expect(out.stderr).toContain("setup-agents");
  });

  it("when the file is open to others", async () => {
    const dir = dataDir(JSON.stringify({ "a-token": "coder" }), 0o644);
    const out = await startCore({ CLEARANCE_DATA_DIR: dir });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("hook-tokens.json");
    expect(out.stderr).not.toContain("a-token");
  });

  it("even when a shared CLEARANCE_HOOK_TOKEN is still in the env", async () => {
    const out = await startCore({
      CLEARANCE_DATA_DIR: dataDir(null),
      CLEARANCE_HOOK_TOKEN: "a-shared-token",
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("hook-tokens.json");
  });

  it("gets past the tokens with a good file, and stops at the next thing it needs", async () => {
    const dir = dataDir(JSON.stringify({ "a-token": "coder" }));
    const out = await startCore({ CLEARANCE_DATA_DIR: dir });
    expect(out.code).toBe(1);
    expect(out.stderr).not.toContain("hook-tokens.json");
    expect(out.stderr).toContain("identities");
  });

  it("takes the file's place from CLEARANCE_HOOK_TOKENS_PATH", async () => {
    const elsewhere = dataDir(JSON.stringify({ "a-token": "coder" }));
    const out = await startCore({
      CLEARANCE_DATA_DIR: dataDir(null),
      CLEARANCE_HOOK_TOKENS_PATH: join(elsewhere, "hook-tokens.json"),
    });
    expect(out.stderr).not.toContain("hook-tokens.json");
    expect(out.stderr).toContain("identities");
  });
});
