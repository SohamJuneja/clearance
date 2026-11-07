import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fetchOnceMore } from "./gateway-owner.ts";
import { OPENCODE_AGENTS } from "./model-refusal.ts";
import { MACHINES, planAgents } from "./setup-agents.ts";
import { OPEN_BASELINE } from "./setup-baseline.ts";

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

describe("the machine that tries free models", () => {
  const machine = "clearance-opencode-probe";

  it("runs OpenCode, and can never be enrolled, since it has no owner", () => {
    expect(fence(`fence_providers ${machine}`).trim()).toBe("opencode");
    expect(() => fence(`fence_owner ${machine}`)).toThrow();
  });

  it("gets no agent's folder, no login and no shared remote", () => {
    expect(fence(`fence_agents ${machine}`).trim()).toBe("");
    const args = argsOf(machine).join("\n");
    for (const hidden of [".credentials.json", "auth.json", ".origin", "/ops-agent", "/refunds-agent"]) {
      expect(args).not.toContain(hidden);
    }
  });

  it("has a home of its own, so it can't touch a running agent's state", () => {
    const args = argsOf(machine);
    expect(args[args.indexOf(home) - 1]).toContain("clearance-opencode-probe");
  });

  it("hides the real home like any other machine", () => {
    const args = argsOf(machine);
    for (let i = 0; i < args.length; i++) {
      if (!/^--(ro-)?bind(-try)?$/.test(args[i]!)) continue;
      expect(args[i + 1]).not.toBe(home);
      expect(args[i + 1]!.startsWith(join(home, ".ssh"))).toBe(false);
      expect(args[i + 1]!.startsWith(repo)).toBe(false);
    }
  });
});

describe("fence_opencode_auth", () => {
  const envFile = () => join(repo, ".env");
  const authFile = (machine: string) => join(tools, "homes", machine, ".local/share/opencode/auth.json");
  const KEY = "not-a-real-provider-key";

  afterEach(() => {
    rmSync(envFile(), { force: true });
    rmSync(join(tools, "homes"), { recursive: true, force: true });
  });

  it("gives OpenCode's machines their auth file, in the shape OpenCode reads, mode 600", () => {
    writeFileSync(envFile(), `OPENCODE_PROVIDER_KEY=${KEY}\nCLEARANCE_OPENCODE_MODEL=anthropic/claude-haiku-5-5\n`);
    for (const machine of ["clearance-alex-open", "clearance-priya-open-base"]) {
      fence(`fence_opencode_auth ${machine}`);
      expect(JSON.parse(readFileSync(authFile(machine), "utf8"))).toEqual({ anthropic: { type: "api", key: KEY } });
      expect(statSync(authFile(machine)).mode & 0o777).toBe(0o600);
    }
  });

  it("never prints the key", () => {
    writeFileSync(envFile(), `OPENCODE_PROVIDER_KEY=${KEY}\nCLEARANCE_OPENCODE_MODEL=anthropic/claude-haiku-5-5\n`);
    const said = fence("fence_opencode_auth clearance-alex-open");
    expect(said).toContain("anthropic");
    expect(said).not.toContain(KEY);
  });

  it("never gives it to a machine that doesn't run OpenCode, or to the one that tries free models", () => {
    writeFileSync(envFile(), `OPENCODE_PROVIDER_KEY=${KEY}\nCLEARANCE_OPENCODE_MODEL=anthropic/claude-haiku-5-5\n`);
    for (const machine of ["clearance-host", "clearance-priya", "clearance-priya-base", "clearance-alex", "clearance-opencode-probe"]) {
      fence(`fence_opencode_auth ${machine}`);
      expect(existsSync(authFile(machine)), machine).toBe(false);
    }
  });

  it("isn't bound into any other machine, whose home is a different folder", () => {
    writeFileSync(envFile(), `OPENCODE_PROVIDER_KEY=${KEY}\nCLEARANCE_OPENCODE_MODEL=anthropic/claude-haiku-5-5\n`);
    fence("fence_opencode_auth clearance-alex-open");
    for (const machine of ["clearance-host", "clearance-priya", "clearance-priya-base", "clearance-alex", "clearance-priya-open-base"]) {
      expect(argsOf(machine).join("\n"), machine).not.toContain(join(tools, "homes", "clearance-alex-open"));
    }
  });

  it("takes the key back out when it's gone from .env", () => {
    writeFileSync(envFile(), `OPENCODE_PROVIDER_KEY=${KEY}\nCLEARANCE_OPENCODE_MODEL=anthropic/claude-haiku-5-5\n`);
    fence("fence_opencode_auth clearance-alex-open");
    writeFileSync(envFile(), "OPENCODE_PROVIDER_KEY=\nCLEARANCE_OPENCODE_MODEL=anthropic/claude-haiku-5-5\n");
    fence("fence_opencode_auth clearance-alex-open");
    expect(existsSync(authFile("clearance-alex-open"))).toBe(false);
  });

  it("writes nothing when there's no model to say which provider it's for", () => {
    writeFileSync(envFile(), `OPENCODE_PROVIDER_KEY=${KEY}\n`);
    fence("fence_opencode_auth clearance-alex-open");
    expect(existsSync(authFile("clearance-alex-open"))).toBe(false);
    writeFileSync(envFile(), `OPENCODE_PROVIDER_KEY=${KEY}\nCLEARANCE_OPENCODE_MODEL=no-provider-here\n`);
    fence("fence_opencode_auth clearance-alex-open");
    expect(existsSync(authFile("clearance-alex-open"))).toBe(false);
  });

  it("copes with a key that has quotes and odd characters in it", () => {
    writeFileSync(envFile(), `OPENCODE_PROVIDER_KEY="sk-a'b$c\\d"\nCLEARANCE_OPENCODE_MODEL=anthropic/x\n`);
    fence("fence_opencode_auth clearance-alex-open");
    const held = JSON.parse(readFileSync(authFile("clearance-alex-open"), "utf8")) as { anthropic: { key: string } };
    expect(held.anthropic.key).toBe("sk-a'b$c\\d");
  });
});

describe("fence_opencode_refresh", () => {
  const stubbed = (body: string) => {
    const bin = mkdtempSync(join(tmpdir(), "bwrap-stub-"));
    writeFileSync(join(bin, "bwrap"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  };
  const refresh = (machine: string, bin: string) =>
    fence(`mkdir -p "$(fence_data_dir ${machine})" "$(fence_home ${machine})/tmp"; PATH="${bin}:$PATH"; fence_opencode_refresh ${machine} && echo refreshed || echo failed`).trim();

  afterEach(() => {
    rmSync(join(tools, "homes"), { recursive: true, force: true });
  });

  it("asks OpenCode for the fresh list, inside that machine's fence", () => {
    const bin = stubbed(`printf '%s\\n' "$@" > "${join(root, "bwrap-args")}"`);
    expect(refresh("clearance-alex-open", bin)).toBe("refreshed");
    const args = readFileSync(join(root, "bwrap-args"), "utf8");
    expect(args).toContain("--unshare-user");
    expect(args).toContain("--die-with-parent");
    expect(args.trim().split("\n").slice(-3)).toEqual(["opencode", "models", "--refresh"]);
    rmSync(bin, { recursive: true, force: true });
  });

  it("says when it couldn't, so the caller can warn and carry on", () => {
    const bin = stubbed("exit 7");
    expect(refresh("clearance-alex-open", bin)).toBe("failed");
    rmSync(bin, { recursive: true, force: true });
  });

  it("does nothing on a machine that doesn't run OpenCode, or hasn't been set up", () => {
    const bin = stubbed(`touch "${join(root, "bwrap-ran")}"`);
    expect(refresh("clearance-priya", bin)).toBe("refreshed");
    // Other tests here prepare every machine, and a machine that was never set up has no data folder.
    rmSync(join(tools, "controller-data-priya-open-base"), { recursive: true, force: true });
    expect(fence(`PATH="${bin}:$PATH"; fence_opencode_refresh clearance-priya-open-base && echo fine`).trim()).toBe("fine");
    expect(existsSync(join(root, "bwrap-ran"))).toBe(false);
    rmSync(bin, { recursive: true, force: true });
  });
});

describe("OpenCode's agents", () => {
  it("are on the machines the refusal check reads the logs of", () => {
    expect(OPENCODE_AGENTS["ops-agent"]).toBe(MACHINES["ops-agent"]);
    expect(OPENCODE_AGENTS["ops-agent-vanilla"]).toBe(OPEN_BASELINE.machine);
    expect(OPEN_BASELINE.agent).toBe("ops-agent-vanilla");
  });

  it("are the ones `just demo` gives the key to", () => {
    const demo = readFileSync(join(REPO, "scripts/demo.sh"), "utf8");
    for (const machine of Object.values(OPENCODE_AGENTS)) expect(demo).toContain(machine);
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

describe("fence_hook_paths", () => {
  const folder = () => join(fence("fence_workspaces").trim(), "ops-agent");
  const fill = (dir: string, paths: string[]) => {
    rmSync(dir, { recursive: true, force: true });
    for (const path of paths) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), "as set up\n");
    }
  };
  const HOOKED = [".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json", ".opencode/plugins/clearance.ts", "bin/clearance-hook", "bin/mcp-headers", ".mcp.json", "opencode.json"];

  it("names what runs an agent's hook, read-only, after the bind of its folder", () => {
    const dir = folder();
    fill(dir, HOOKED);
    const args = argsOf("clearance-alex-open");
    const at = args.indexOf(dir);
    expect(at, "its folder is bound").toBeGreaterThan(-1);
    for (const path of [".claude", ".codex", ".cursor", ".opencode/plugins", "bin", ".mcp.json", "opencode.json"]) {
      const locked = args.indexOf(join(dir, path));
      expect(locked, path).toBeGreaterThan(at);
      expect(args[locked - 1]).toBe("--ro-bind");
    }
  });

  it("locks Claude's settings for the whole machine where Claude reads them, which is under $HOME inside", () => {
    const settingsFile = join(fence("fence_home clearance-alex-open").trim(), ".claude/settings.json");
    const args = argsOf("clearance-alex-open");
    const at = args.indexOf(settingsFile);
    expect(args[at - 1]).toBe("--ro-bind-try");
    expect(args[at + 1]).toBe(join(home, ".claude/settings.json"));
    expect(at, "after the bind of the home itself").toBeGreaterThan(args.indexOf(home));
  });

  it("leaves OpenCode's own folder writable, where it installs its plugin's packages", () => {
    const dir = folder();
    fill(dir, HOOKED);
    expect(argsOf("clearance-alex-open")).not.toContain(join(dir, ".opencode"));
  });

  it("leaves a folder alone that has no hook, as a baseline agent's hasn't", () => {
    const dir = folder();
    fill(dir, [".claude/settings.json", "opencode.json"]);
    const args = argsOf("clearance-alex-open");
    expect(args).toContain(dir);
    expect(args).not.toContain(join(dir, ".claude"));
    expect(args).not.toContain(join(dir, "opencode.json"));
  });
});

describe.skipIf(!works)("the real sandbox", () => {
  it("the kernel refuses every way of rewriting a hook, whatever a command looks like, and the agent's other files stay its own", () => {
    const dir = join(fence("fence_workspaces").trim(), "ops-agent");
    for (const path of [".claude/settings.json", ".opencode/plugins/clearance.ts", "bin/clearance-hook", ".mcp.json", "opencode.json"]) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), "as set up\n");
    }
    // Written where setup writes it. Attacked where Claude reads it: inside, the machine's own home is at $HOME.
    const settingsFile = join(fence("fence_home clearance-alex-open").trim(), ".claude/settings.json");
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, "as set up\n");
    const machineSettings = join(home, ".claude/settings.json");
    const attacks = [
      "echo gone > .claude/settings.json",
      "echo extra > .claude/settings.local.json",
      "rm -f .claude/settings.json",
      "rm -rf .claude",
      "mv .claude .claude-old",
      "mv bin bin-old",
      "printf exit > bin/clearance-hook",
      "chmod -x bin/clearance-hook",
      "rm -f bin/clearance-hook",
      "ln -sf /tmp/x bin/clearance-hook",
      "echo gone > opencode.json",
      "rm -f opencode.json",
      "mv opencode.json opencode.old",
      "echo gone > .mcp.json",
      "echo gone > .opencode/plugins/clearance.ts",
      "rm -rf .opencode/plugins",
      `echo '{"disableAllHooks":true}' > ${machineSettings}`,
      `rm -f ${machineSettings}`,
      `mv ${machineSettings} ${machineSettings}.old`,
    ];
    const script = attacks.map((attack) => `( ${attack} ) 2>/dev/null && echo "WENT THROUGH: ${attack.replace(/"/g, "")}"`).join("\n");
    const out = fence(`
      fence_prepare clearance-alex-open
      fence_args clearance-alex-open
      bwrap "\${FENCE_ARGS[@]}" /bin/bash -c 'cd ${dir}
${script.replace(/'/g, "'\\''")}
        : >notes.txt && echo NOTES
        : >.opencode/package.json && echo OPENCODE_OWN
        : >${dirname(machineSettings)}/sessions-probe && echo CLAUDE_OWN
        echo DONE
      '
    `);
    expect(out).not.toContain("WENT THROUGH");
    expect(out).toContain("NOTES");
    expect(out).toContain("OPENCODE_OWN");
    expect(out, "Claude keeps its sessions in that folder").toContain("CLAUDE_OWN");
    expect(readFileSync(settingsFile, "utf8")).toBe("as set up\n");
    expect(out).toContain("DONE");
    for (const path of [".claude/settings.json", "bin/clearance-hook", ".mcp.json", "opencode.json", ".opencode/plugins/clearance.ts"]) {
      expect(readFileSync(join(dir, path), "utf8"), path).toBe("as set up\n");
    }
    expect(existsSync(join(dir, ".claude/settings.local.json"))).toBe(false);
  });

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
