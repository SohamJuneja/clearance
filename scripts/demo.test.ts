/**
 * The first thing a judge runs, at the only step that can stop them: what it says when something is missing. It runs the
 * real scripts in a throwaway root, with a scratch home and stubs for the tools, so nothing here reaches a real stack.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    for (const file of ["demo.sh", "fence.sh"])
      copyFileSync(join(HERE, file), join(root, "scripts", file));
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

  it("ends a good run with success whether or not there's a warning about OpenCode to repeat", () => {
    const script = readFileSync(join(HERE, "demo.sh"), "utf8");
    const line = script
      .split("\n")
      .find((text) => text.includes("opencode-model.ts check 2>/dev/null"));
    // It's the script's last command, and a grep that finds nothing would otherwise be the script's exit status.
    expect(line).toMatch(/\|\| true$/);
  });

  it("has a step for OpenCode's model between the machines and the agents, and only with agents", () => {
    signIn();
    const steps = (output: string) => [...output.matchAll(/^== (\S+)/gm)].map((match) => match[1]);
    const real = steps(demo("--check").output);
    expect(real.indexOf("opencode")).toBe(real.indexOf("controllers") + 1);
    expect(real.indexOf("agents")).toBe(real.indexOf("opencode") + 1);
    expect(steps(demo("--check", "--no-agents").output)).not.toContain("opencode");
  });

  it("names the command that would run when --check is about --no-agents", () => {
    const { output } = demo("--check", "--no-agents", "--only", "tools,reset,smoke");
    expect(output).toContain("just demo --no-agents would");
    expect(output).toContain("run the spine");
  });
});

describe("a service running older code than the checkout", () => {
  let root: string;
  let bin: string;
  const running = ["acme", "gate", "core", "desk"];

  const stub = (file: string, body: string): void => {
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  const checkoutAt = (commit: string): void => writeFileSync(join(root, "head"), `${commit}\n`);
  const env = () => ({ HOME: join(root, "home"), PATH: `${bin}:/usr/bin:/bin` });
  const services = (...args: string[]) =>
    spawnSync("bash", [join(root, "scripts/services.sh"), ...args], {
      encoding: "utf8",
      env: env(),
      timeout: 30_000,
    });
  const demo = (...args: string[]) => {
    const result = spawnSync("bash", [join(root, "scripts/demo.sh"), ...args], {
      encoding: "utf8",
      env: env(),
      timeout: 30_000,
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const built = (): string[] =>
    existsSync(join(root, "builds"))
      ? readFileSync(join(root, "builds"), "utf8").trim().split("\n")
      : [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "services-"));
    bin = join(root, "bin");
    for (const dir of [
      bin,
      join(root, "home"),
      join(root, "scripts"),
      join(root, "node_modules/.bin"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const file of ["services.sh", "new-session.sh", "demo.sh", "fence.sh"]) {
      copyFileSync(join(HERE, file), join(root, "scripts", file));
      chmodSync(join(root, "scripts", file), 0o755);
    }
    copyFileSync(join(HERE, "../justfile"), join(root, "justfile"));
    // SYNTHETIC: a service is a process that sleeps, and the checkout's commit is a word in a file.
    stub(join(root, "node_modules/.bin/tsx"), "exec sleep 60");
    // A port answers only while its service runs, or the script rightly says another checkout has it.
    stub(
      join(bin, "curl"),
      `for a in "$@"; do case "$a" in *:7800*) s=acme ;; *:7710*) s=gate ;; *:7700*) s=core ;; *:7900*) s=desk ;; esac; done
[ -s "${root}/data/run/$s.pgid" ] || { echo 000; exit 7; }
echo 200`,
    );
    stub(join(bin, "git"), `[ -f "${root}/head" ] || exit 1\ncat "${root}/head"`);
    stub(
      join(bin, "pnpm"),
      `[ "$1" = desk:build ] || exit 0\necho built >>"${root}/builds"\nmkdir -p "${root}/packages/desk/dist"\ntouch "${root}/packages/desk/dist/index.html"`,
    );
    symlinkSync(process.execPath, join(bin, "node"));
    checkoutAt("aaaaaaa");
  });

  afterEach(() => {
    services("down", ...running);
    rmSync(root, { recursive: true, force: true });
  });

  it("calls nothing old while the checkout stays where a service started", () => {
    services("up", "acme");
    expect(readFileSync(join(root, "data/run/acme.commit"), "utf8").trim()).toBe("aaaaaaa");
    expect(services("stale").stdout.trim()).toBe("");
  });

  it("names a running service once the checkout has moved", () => {
    services("up", "acme", "desk");
    checkoutAt("bbbbbbb");
    expect(services("stale").stdout.trim().split("\n")).toEqual(["acme", "desk"]);
  });

  it("names a running service with no record, which an older script started", () => {
    services("up", "acme");
    rmSync(join(root, "data/run/acme.commit"));
    expect(services("stale").stdout.trim()).toBe("acme");
  });

  it("doesn't call a stopped service old, so a fresh clone has nothing to redo", () => {
    expect(services("stale").stdout.trim()).toBe("");
    services("up", "acme");
    services("down", "acme");
    checkoutAt("bbbbbbb");
    expect(services("stale").stdout.trim()).toBe("");
  });

  it("calls nothing old with no git to ask, as in an unpacked tarball", () => {
    services("up", "acme");
    rmSync(join(root, "head"));
    expect(services("stale").stdout.trim()).toBe("");
  });

  it("makes it a to do in --check, without restarting anything", () => {
    demo("--only", "services");
    const pid = readFileSync(join(root, "data/run/acme.pgid"), "utf8");
    expect(demo("--check", "--only", "services").output).not.toContain("todo");

    checkoutAt("bbbbbbb");
    const { output } = demo("--check", "--only", "services");
    expect(output).toMatch(/todo\s+acme\b.*older code/);
    expect(output).toMatch(/todo\s+desk\b.*older code/);
    expect(output).toMatch(/todo\s+the Desk's build/);
    expect(readFileSync(join(root, "data/run/acme.pgid"), "utf8")).toBe(pid);
  });

  it("restarts Acme and the Desk and rebuilds the Desk once the checkout has moved", () => {
    demo("--only", "services");
    const pid = readFileSync(join(root, "data/run/acme.pgid"), "utf8");
    expect(built()).toHaveLength(1);

    checkoutAt("bbbbbbb");
    const { status } = demo("--only", "services");
    expect(status).toBe(0);
    expect(readFileSync(join(root, "data/run/acme.pgid"), "utf8")).not.toBe(pid);
    expect(readFileSync(join(root, "data/run/desk.commit"), "utf8").trim()).toBe("bbbbbbb");
    expect(built()).toHaveLength(2);
    expect(demo("--check", "--only", "services").output).not.toContain("todo");
  });

  it("leaves Acme and the Desk's build alone when the code hasn't moved", () => {
    demo("--only", "services");
    const pid = readFileSync(join(root, "data/run/acme.pgid"), "utf8");
    rmSync(join(root, "data/run/gate.commit"));
    demo("--only", "services");
    expect(readFileSync(join(root, "data/run/acme.pgid"), "utf8")).toBe(pid);
    expect(built()).toHaveLength(1);
  });

  it("rebuilds an old build even when the Desk isn't running to be called old", () => {
    demo("--only", "services");
    services("down", ...running);
    checkoutAt("bbbbbbb");
    demo("--only", "services");
    expect(built()).toHaveLength(2);
  });

  it("builds a fresh clone's Desk once", () => {
    const { status } = demo("--only", "services");
    expect(status).toBe(0);
    expect(built()).toHaveLength(1);
    expect(readFileSync(join(root, "data/run/desk-build.commit"), "utf8").trim()).toBe("aaaaaaa");
  });
});

describe("a token loop running an older script", () => {
  const script = readFileSync(join(import.meta.dirname, "demo.sh"), "utf8");
  const fn = /token_loop_current\(\) \{[\s\S]*?\n\}\n/.exec(script)?.[0] ?? "";

  function current(scriptAge: "older" | "newer"): boolean {
    const root = mkdtempSync(join(tmpdir(), "clearance-loop-"));
    mkdirSync(join(root, "scripts"));
    const file = join(root, "scripts/fence-claude-token.sh");
    writeFileSync(file, "");
    const when = scriptAge === "older" ? "2020-01-01" : "2099-01-01";
    const out = spawnSync("bash", ["-c", `touch -d ${when} "${file}"\nROOT="${root}"\n${fn}\ntoken_loop_current $$`]);
    rmSync(root, { recursive: true, force: true });
    return out.status === 0;
  }

  it("counts when the script hasn't changed since the loop started", () => {
    expect(fn).not.toBe("");
    expect(current("older")).toBe(true);
  });

  it("is out of date once the script changed after it started", () => {
    expect(current("newer")).toBe(false);
  });
});
