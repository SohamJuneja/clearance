import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "fence-claude-token.sh");

const login = (accessToken: string): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: "refresh-secret", expiresAt: Date.now() + 8 * 3600_000 },
  });

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return check();
}

describe("following the host's Claude login", () => {
  let dir = "";
  let follower: ChildProcess | undefined;

  afterEach(() => {
    follower?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("picks up a refresh in about a second, and never copies the refresh token", async () => {
    dir = mkdtempSync(join(tmpdir(), "clearance-token-"));
    const home = join(dir, "home");
    const fence = join(dir, "fence");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const source = join(home, ".claude/.credentials.json");
    const copy = join(fence, ".claude/.credentials.json");
    writeFileSync(source, login("first"));

    follower = spawn("bash", [SCRIPT, fence, "--follow", String(process.pid)], {
      env: { ...process.env, HOME: home },
      stdio: "ignore",
    });
    expect(await until(() => existsSync(copy) && readFileSync(copy, "utf8").includes("first"), 10_000)).toBe(true);

    // Claude replaces the file by rename, so the test does too. A sleeping loop would take up to its whole interval.
    await new Promise((done) => setTimeout(done, 1500));
    writeFileSync(`${source}.new`, login("second"));
    renameSync(`${source}.new`, source);
    expect(await until(() => readFileSync(copy, "utf8").includes("second"), 4000)).toBe(true);
    expect(readFileSync(copy, "utf8")).not.toContain("refresh-secret");
  }, 20_000);
});
