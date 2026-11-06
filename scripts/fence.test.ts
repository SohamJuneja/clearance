import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchOnceMore } from "./gateway-owner.ts";
import { MACHINES, planAgents } from "./setup-agents.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FENCE = join(REPO, "scripts/fence.sh");
const plans = planAgents(readFileSync(join(REPO, "templates/acme-mini.template.yaml"), "utf8"));

let root: string;
let home: string;
let repo: string;
let tools: string;

function fence(script: string): string {
  return execFileSync("bash", ["-c", `set -euo pipefail\nREPO_ROOT=${JSON.stringify(repo)}\nsource ${JSON.stringify(FENCE)}\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, CLEARANCE_TOOLS: tools },
  });
}

/** The arguments a machine runs with, one per line. */
function argsOf(machine: string): string[] {
  return fence(`fence_prepare ${machine}\nfence_args ${machine}\nprintf '%s\\n' "\${FENCE_ARGS[@]}"`).trim().split("\n");
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fence-")));
  home = join(root, "home");
  repo = join(root, "repo");
  tools = join(home, ".local/share/clearance-tools");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/id_ed25519"), "not a real key\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/.credentials.json"), "{}\n");
  mkdirSync(join(repo, "data"), { recursive: true });
  writeFileSync(join(repo, "data/secrets.json"), "{}\n");
  mkdirSync(join(tools, "controller-src"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the machines in fence.sh", () => {
  it("match the template and setup-agents, so an agent always lands on a machine that can run it", () => {
    for (const plan of plans) {
      const machine = MACHINES[plan.name]!;
      expect(machine, plan.name).toBeTruthy();
      expect(fence(`fence_owner ${machine}`).trim(), plan.name).toBe(plan.owner);
      expect(fence(`fence_agents ${machine}`).trim().split(" "), plan.name).toContain(plan.name);
      expect(fence(`fence_providers ${machine}`).trim().split(" "), plan.name).toContain(plan.provider);
    }
  });

  it("put OpenCode on a machine with no Claude or Codex login, since a third-party model is on the other end", () => {
    const machine = MACHINES["ops-agent"]!;
    expect(fence(`fence_providers ${machine}`).trim()).toBe("opencode");
    const args = argsOf(machine).join("\n");
    expect(args).not.toContain(".credentials.json");
    expect(args).not.toContain("auth.json");
  });

  it("keep the baseline away from the fenced agents, because its folder holds the Acme admin key", () => {
    const machine = "clearance-priya-base";
    expect(fence(`fence_agents ${machine}`).trim()).toBe("refunds-agent-vanilla");
    for (const plan of plans) expect(MACHINES[plan.name]).not.toBe(machine);
  });
});

describe("E2's OpenCode baseline", () => {
  const machine = "clearance-priya-open-base";

  it("shares its machine with nobody, and has no Claude or Codex login", () => {
    expect(fence(`fence_agents ${machine}`).trim()).toBe("ops-agent-vanilla");
    expect(fence(`fence_providers ${machine}`).trim()).toBe("opencode");
    for (const plan of plans) expect(MACHINES[plan.name]).not.toBe(machine);
    const args = argsOf(machine).join("\n");
    expect(args).not.toContain(".credentials.json");
    expect(args).not.toContain("auth.json");
  });

  it("can't see the other baseline's folder, which holds the same key", () => {
    const args = argsOf(machine).join("\n");
    expect(args).toContain("/ops-agent-vanilla");
    expect(args).not.toContain("/refunds-agent-vanilla");
  });
});

describe("fence_path", () => {
  it("finds Claude Code where npm put it, which isn't always on the usual list", () => {
    const dir = mkdtempSync(join(tmpdir(), "npm-global-"));
    try {
      writeFileSync(join(dir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
      const path = fence(`PATH="${dir}:$PATH"; fence_path`).trim();
      expect(path.split(":")).toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doesn't change when Claude Code is in the usual place, so a running machine isn't restarted for nothing", () => {
    const nodeDir = dirname(process.execPath);
    const usual = join(home, ".local/bin");
    mkdirSync(usual, { recursive: true });
    writeFileSync(join(usual, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    const installed = fence(`PATH="${usual}:${nodeDir}:/usr/bin:/bin"; fence_path`).trim();
    rmSync(join(usual, "claude"));
    const absent = fence(`PATH="${nodeDir}:/usr/bin:/bin"; fence_path`).trim();
    expect(installed).toBe(absent);
  });
});

describe("fence_args", () => {
  it("shares the network and nothing else", () => {
    const args = argsOf("clearance-priya");
    for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts"]) expect(args).toContain(flag);
    expect(args).not.toContain("--unshare-net");
    expect(args).not.toContain("--share-net");
  });

  it("never binds the real home, the repo, data/, ~/.ssh or ~/.claude back in", () => {
    for (const machine of ["clearance-host", "clearance-priya", "clearance-alex", "clearance-alex-open"]) {
      const args = argsOf(machine);
      for (let i = 0; i < args.length; i++) {
        if (!/^--(ro-)?bind(-try)?$/.test(args[i]!)) continue;
        const source = args[i + 1]!;
        expect(source, machine).not.toBe(home);
        expect(source.startsWith(repo), `${machine} binds ${source}`).toBe(false);
        expect(source.startsWith(join(home, ".ssh")), `${machine} binds ${source}`).toBe(false);
        expect(source.startsWith(join(home, ".claude")), `${machine} binds ${source}`).toBe(false);
      }
    }
  });

  it("binds a machine's own agents and no other machine's", () => {
    const args = argsOf("clearance-alex-open").join("\n");
    expect(args).toContain("/ops-agent");
    for (const other of ["refunds-agent", "support-agent", "coder", "reviewer", "refunds-agent-vanilla"]) {
      expect(args).not.toContain(`/${other}`);
    }
  });

  it("hides a repo outside the home by name", () => {
    const args = fence(`fence_prepare clearance-host\nREPO_ROOT=/srv/clearance\nfence_args clearance-host\nprintf '%s\\n' "\${FENCE_ARGS[@]}"`)
      .trim()
      .split("\n");
    expect(args[args.indexOf("/srv/clearance") - 1]).toBe("--tmpfs");
  });
});

describe("the shell scripts", () => {
  it("all parse", () => {
    for (const script of ["fence.sh", "check-fence.sh", "fence-claude-token.sh", "setup-controller.sh", "setup-agent-home.sh", "demo.sh", "services.sh"]) {
      const result = spawnSync("bash", ["-n", join(REPO, "scripts", script)], { encoding: "utf8" });
      expect(result.status, `${script}: ${result.stderr}`).toBe(0);
    }
  });
});

describe("services.sh after a reboot", () => {
  /** A real process group, standing in for whatever now holds the number a service's pgid file names. */
  function innocent(): number {
    const child = spawn("setsid", ["sleep", "30"], { stdio: "ignore", detached: false });
    return child.pid!;
  }
  const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;
  const services = (run: string, ...args: string[]) =>
    spawnSync("bash", [join(REPO, "scripts/services.sh"), ...args], { encoding: "utf8", env: { ...process.env, CLEARANCE_RUN_DIR: run } });

  it("does not signal a process group recorded before this boot, because that number can be anyone's now", () => {
    const run = join(root, "run-stale");
    mkdirSync(run, { recursive: true });
    const pid = innocent();
    writeFileSync(join(run, "acme.pgid"), `${pid}\n`);
    writeFileSync(join(run, "acme.boot"), "an-earlier-boot\n");
    expect(services(run, "down", "acme").status).toBe(0);
    expect(alive(pid)).toBe(true);
    expect(readFileSync(join(run, "acme.pgid"), "utf8")).toBe("");
    spawnSync("kill", [String(pid)]);
  });

  it("still stops a service started in this boot", async () => {
    const run = join(root, "run-live");
    mkdirSync(run, { recursive: true });
    const pid = innocent();
    writeFileSync(join(run, "acme.pgid"), `${pid}\n`);
    writeFileSync(join(run, "acme.boot"), readFileSync("/proc/sys/kernel/random/boot_id", "utf8"));
    // Not spawnSync: a blocked event loop could not reap the stopped child, and services.sh would wait on the zombie.
    await promisify(execFile)("bash", [join(REPO, "scripts/services.sh"), "down", "acme"], { env: { ...process.env, CLEARANCE_RUN_DIR: run } });
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    expect(state === "" || state.startsWith("Z")).toBe(true);
  });
});

const works = spawnSync("bwrap", ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"]).status === 0;

describe.skipIf(!works)("the real sandbox", () => {
  it("hides the home and repo, and lets the machine write its own agent's folder", () => {
    const workspaces = fence("fence_workspaces").trim();
    const out = fence(`
      fence_prepare clearance-alex-open
      fence_args clearance-alex-open
      bwrap "\${FENCE_ARGS[@]}" /bin/bash -c '
        for hidden in ${home}/.ssh/id_ed25519 ${home}/.claude/.credentials.json ${repo}/data/secrets.json; do
          [ -e "$hidden" ] && echo "VISIBLE $hidden"
        done
        : >${workspaces}/ops-agent/.probe && echo WROTE
        { : >/usr/.probe; } 2>/dev/null && echo "WROTE USR"
        echo DONE
      '
    `);
    expect(out).not.toContain("VISIBLE");
    expect(out).not.toContain("WROTE USR");
    expect(out).toContain("WROTE");
    expect(out).toContain("DONE");
  });
});

describe("fetchOnceMore", () => {
  const ok = new Response("{}", { status: 200 });

  it("sends once more when a kept-alive socket closed under the request", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok;
    }) as typeof fetch;
    expect((await fetchOnceMore("http://x", {}, flaky)).status).toBe(200);
    expect(calls).toBe(2);
  });

  it("does not hide a second failure, or retry a timeout", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(fetchOnceMore("http://x", {}, down)).rejects.toThrow("fetch failed");
    let calls = 0;
    const timedOut = (async () => {
      calls += 1;
      throw new DOMException("timed out", "TimeoutError");
    }) as typeof fetch;
    await expect(fetchOnceMore("http://x", {}, timedOut)).rejects.toThrow("timed out");
    expect(calls).toBe(1);
  });
});
