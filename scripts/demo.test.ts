/**
 * The first thing a judge runs, at the only step that can stop them: what it says when something is missing. It runs the
 * real scripts in a throwaway root, with a scratch home and stubs for the tools, so nothing here reaches a real stack.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sayUntilHeard } from "./lib-provisioning.ts";

const HERE = import.meta.dirname;
const STUBS = ["docker", "pnpm", "just", "git", "curl", "rsync", "bwrap"];

describe("sayUntilHeard", () => {
  const fast = { rounds: 3, checksPerRound: 2, waitMs: 1 };

  it("says it again when nobody was listening the first time, as on a stack that only just started", async () => {
    let said = 0;
    const found = await sayUntilHeard(
      async () => {
        said += 1;
      },
      async () => (said >= 2 ? "room" : undefined),
      fast,
    );
    expect(found).toBe("room");
    expect(said).toBe(2);
  });

  it("says it once when it's heard", async () => {
    let said = 0;
    const found = await sayUntilHeard(
      async () => {
        said += 1;
      },
      async () => "room",
      fast,
    );
    expect(found).toBe("room");
    expect(said).toBe(1);
  });

  it("gives up with nothing, so the caller can say what failed", async () => {
    let said = 0;
    const found = await sayUntilHeard(
      async () => {
        said += 1;
      },
      async () => undefined,
      fast,
    );
    expect(found).toBeUndefined();
    expect(said).toBe(3);
  });

  it("lets a failed post stop it, rather than wait a minute", async () => {
    await expect(
      sayUntilHeard(
        async () => {
          throw new Error("Mattermost said no");
        },
        async () => undefined,
        fast,
      ),
    ).rejects.toThrow("Mattermost said no");
  });
});

describe("an agent home with a key", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-home-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("doesn't need Claude Code in ~/.local/bin, where npm's install isn't", () => {
    const agentHome = join(root, "agent");
    const result = spawnSync("bash", [join(HERE, "setup-agent-home.sh")], {
      encoding: "utf8",
      env: {
        HOME: join(root, "home"),
        PATH: "/usr/bin:/bin",
        CLEARANCE_ROOT: root,
        CLEARANCE_AGENT_HOME: agentHome,
        CLEARANCE_AGENT_API_KEY: "not-a-real-key",
      },
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("not-a-real-key");
    expect(existsSync(join(agentHome, ".claude/settings.json"))).toBe(true);
    expect(statSync(join(agentHome, ".claude/api-key")).mode & 0o777).toBe(0o600);
  });
});

describe("just demo, at its first step", () => {
  let root: string;
  let home: string;
  let bin: string;

  const stub = (name: string, body = "exit 0"): void => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };

  const demo = (...args: string[]) => {
    const result = spawnSync("bash", [join(root, "scripts/demo.sh"), ...args], {
      encoding: "utf8",
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
      timeout: 30_000,
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "demo-"));
    home = join(root, "home");
    bin = join(root, "bin");
    for (const dir of [home, bin, join(root, "scripts")]) mkdirSync(dir, { recursive: true });
    for (const file of ["demo.sh", "fence.sh"]) copyFileSync(join(HERE, file), join(root, "scripts", file));
    copyFileSync(join(HERE, "../justfile"), join(root, "justfile"));
    for (const name of STUBS) stub(name);
    symlinkSync(process.execPath, join(bin, "node"));
    stub("claude", `echo '{"loggedIn": false}'`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const signIn = () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude/.credentials.json"), "{}\n");
  };

  it("stops there with no key and no login, says what to do, and starts nothing", () => {
    const { status, output } = demo();
    expect(status).toBe(1);
    expect(output).toContain("Blocked: Claude agents have no way to sign in");
    expect(output).toContain("ANTHROPIC_API_KEY in .env");
    expect(output).toContain("claude login");
    expect(output).toContain("just demo --no-agents");
    expect(output).not.toContain("== fetch");
  });

  it("says the same from --check, which is the first thing the README suggests", () => {
    const { status, output } = demo("--check", "--only", "tools");
    expect(status).toBe(1);
    expect(output).toContain("Blocked: Claude agents have no way to sign in");
  });

  it("goes on with a key in .env", () => {
    writeFileSync(join(root, ".env"), "ANTHROPIC_API_KEY=not-a-real-key\n");
    const { status, output } = demo("--check", "--only", "tools");
    expect(status).toBe(0);
    expect(output).toContain("will use ANTHROPIC_API_KEY from .env");
    expect(output).not.toContain("not-a-real-key");
  });

  it("goes on with a Claude login in this home, and doesn't look for one anywhere else", () => {
    signIn();
    const { status, output } = demo("--check", "--only", "tools");
    expect(status).toBe(0);
    expect(output).toContain("will use this host's Claude login");
  });

  it("names Claude Code when it isn't installed, even with a key", () => {
    rmSync(join(bin, "claude"));
    writeFileSync(join(root, ".env"), "ANTHROPIC_API_KEY=not-a-real-key\n");
    const { status, output } = demo("--check", "--only", "tools");
    expect(status).toBe(1);
    expect(output).toContain("Blocked: Claude Code is not installed");
    expect(output).toContain("just demo --no-agents");
  });

  it("needs none of that for --no-agents", () => {
    rmSync(join(bin, "claude"));
    rmSync(join(bin, "bwrap"));
    const { status, output } = demo("--check", "--no-agents", "--only", "tools");
    expect(status).toBe(0);
    expect(output).toContain("needs no key and no bubblewrap");
  });

  it("takes a login with no file behind it only with --no-fence, as macOS keeps it in the keychain", () => {
    stub("claude", `echo '{"loggedIn": true}'`);
    expect(demo("--check", "--only", "tools").status).toBe(1);
    const unfenced = demo("--check", "--no-fence", "--only", "tools");
    expect(unfenced.status).toBe(0);
    expect(unfenced.output).toContain("will use this host's Claude login");
  });

  it("blocks --no-fence too when Claude says nobody is logged in", () => {
    const { status, output } = demo("--check", "--no-fence", "--only", "tools");
    expect(status).toBe(1);
    expect(output).toContain("Blocked: Claude agents have no way to sign in");
  });

  it("names the command that would run when --check is about --no-agents", () => {
    const { output } = demo("--check", "--no-agents", "--only", "tools,reset,smoke");
    expect(output).toContain("just demo --no-agents would");
    expect(output).toContain("run the spine");
  });
});
