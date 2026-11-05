import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  seedCodexTrust,
  trustHooks,
  trustProject,
  writeAgentSecrets,
  type CodexHook,
} from "../src/setup.ts";
import { REPO_ROOT, run } from "./helpers.js";

const SETUP_MAIN = join(REPO_ROOT, "packages", "hook-cli", "src", "setup-agent.ts");
const HOOK_TOKEN = "hook-token-secret-value";
const GATE_TOKEN = "gate-token-secret-value";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "setup-agent-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (path: string) => statSync(path).mode & 0o777;
const opts = { hookToken: HOOK_TOKEN, gateToken: GATE_TOKEN, gateUrl: "http://127.0.0.1:7710" };

describe("writeAgentSecrets", () => {
  it("gives Claude its tokens through settings.local.json, the route measured to work", () => {
    writeAgentSecrets(dir, opts);
    const file = join(dir, ".claude", "settings.local.json");
    expect(JSON.parse(readFileSync(file, "utf8")).env).toEqual({
      CLEARANCE_HOOK_TOKEN: HOOK_TOKEN,
      ACME_GATE_TOKEN: GATE_TOKEN,
    });
    expect(mode(file)).toBe(0o600);
  });

  it("keeps whatever else is in settings.local.json", () => {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, ".claude", "settings.local.json"),
      JSON.stringify({ model: "haiku", env: { OTHER: "x" } }),
    );
    writeAgentSecrets(dir, opts);
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));
    expect(settings.model).toBe("haiku");
    expect(settings.env.OTHER).toBe("x");
    expect(settings.env.CLEARANCE_HOOK_TOKEN).toBe(HOOK_TOKEN);
  });

  it("writes the token files the CLI, the plugin and the MCP helper read", () => {
    writeAgentSecrets(dir, opts);
    for (const [name, value] of [
      ["hook-token", HOOK_TOKEN],
      ["gate-token", GATE_TOKEN],
    ] as const) {
      const file = join(dir, ".clearance", name);
      expect(readFileSync(file, "utf8").trim()).toBe(value);
      expect(mode(file)).toBe(0o600);
    }
    expect(mode(join(dir, ".clearance"))).toBe(0o700);
  });

  it("records where the hook CLI is, since bin/clearance-hook cannot use the env or a relative path", () => {
    writeAgentSecrets(dir, opts);
    const file = join(dir, ".clearance", "hook-cli");
    const recorded = readFileSync(file, "utf8").trim();
    expect(recorded).toBe(join(REPO_ROOT, "packages", "hook-cli", "src", "main.ts"));
    expect(existsSync(recorded)).toBe(true);
  });

  it("points Codex at the gate's MCP server with this agent's token", () => {
    writeAgentSecrets(dir, opts);
    const file = join(dir, ".codex", "config.toml");
    const toml = readFileSync(file, "utf8");
    expect(toml).toContain("[mcp_servers.clearance_gate]");
    expect(toml).toContain('url = "http://127.0.0.1:7710/mcp"');
    expect(toml).toContain(`http_headers = { Authorization = "Bearer ${GATE_TOKEN}" }`);
    expect(mode(file)).toBe(0o600);
  });

  it("can be run again with new tokens", () => {
    writeAgentSecrets(dir, opts);
    writeAgentSecrets(dir, { ...opts, gateToken: "rotated" });
    expect(readFileSync(join(dir, ".clearance", "gate-token"), "utf8").trim()).toBe("rotated");
    expect(readFileSync(join(dir, ".codex", "config.toml"), "utf8")).not.toContain(GATE_TOKEN);
  });
});

describe("Codex config text", () => {
  it("trustProject adds the table the spike needed", () => {
    expect(trustProject("", "/a/b")).toBe('[projects."/a/b"]\ntrust_level = "trusted"\n');
  });

  it("trustProject keeps everything else and does not repeat itself", () => {
    const start = 'model = "x"\n\n[other]\na = 1\n';
    const once = trustProject(start, "/a/b");
    expect(once).toContain('model = "x"');
    expect(once).toContain("[other]\na = 1");
    expect(trustProject(once, "/a/b")).toBe(once);
  });

  it("trustProject replaces an entry that says something else", () => {
    const text = '[projects."/a/b"]\ntrust_level = "untrusted"\n\n[other]\na = 1\n';
    const out = trustProject(text, "/a/b");
    expect(out).toContain('trust_level = "trusted"');
    expect(out).not.toContain("untrusted");
    expect(out).toContain("[other]\na = 1");
  });

  it("trustHooks records each hook's current hash", () => {
    const out = trustHooks("", [
      { key: "/a/.codex/hooks.json:pre_tool_use:0:0", currentHash: "h1" },
    ]);
    expect(out).toBe(
      '[hooks.state."/a/.codex/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "h1"\n',
    );
  });

  it("trustHooks replaces a stale hash, so edited hooks.json can be re-seeded", () => {
    const hook = { key: "k", currentHash: "new" };
    const out = trustHooks(trustHooks("", [{ key: "k", currentHash: "old" }]), [hook]);
    expect(out).toContain('trusted_hash = "new"');
    expect(out).not.toContain("old");
  });
});

describe("seedCodexTrust", () => {
  const hook = (over: Partial<CodexHook>): CodexHook => ({
    key: `${dir}/.codex/hooks.json:pre_tool_use:0:0`,
    currentHash: "hash-1",
    trustStatus: "untrusted",
    ...over,
  });

  /** A stand-in for `codex app-server`: hooks read as trusted once their hash is in the config. */
  const fakeCodex = (home: string, hooks: () => CodexHook[], seen: string[] = []) => {
    return async () => {
      const config = existsSync(join(home, "config.toml"))
        ? readFileSync(join(home, "config.toml"), "utf8")
        : "";
      seen.push(config);
      return hooks().map((h) => ({
        ...h,
        trustStatus: config.includes(`trusted_hash = "${h.currentHash}"`) ? "trusted" : "untrusted",
      }));
    };
  };

  it("trusts the project first, since Codex shows no hooks otherwise, then seeds them", async () => {
    const home = join(dir, "codex-home");
    const seen: string[] = [];
    const seeded = await seedCodexTrust(
      home,
      dir,
      fakeCodex(home, () => [hook({})], seen),
    );
    expect(seeded).toBe(1);
    expect(seen[0]).toContain(`[projects."${dir}"]`);
    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain(`[hooks.state."${dir}/.codex/hooks.json:pre_tool_use:0:0"]`);
    expect(config).toContain('trusted_hash = "hash-1"');
  });

  it("does not trust hooks from anywhere but this project", async () => {
    const home = join(dir, "codex-home");
    const other = hook({
      key: "/elsewhere/.codex/hooks.json:pre_tool_use:0:0",
      currentHash: "evil",
    });
    await seedCodexTrust(
      home,
      dir,
      fakeCodex(home, () => [hook({}), other]),
    );
    expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain("evil");
  });

  it("fails when Codex shows no hooks, since they would be silently skipped", async () => {
    const home = join(dir, "codex-home");
    await expect(
      seedCodexTrust(
        home,
        dir,
        fakeCodex(home, () => []),
      ),
    ).rejects.toThrow(/no hooks/i);
  });

  it("fails when a hook still is not trusted afterwards", async () => {
    const home = join(dir, "codex-home");
    const stubborn = async () => [hook({})];
    await expect(seedCodexTrust(home, dir, stubborn)).rejects.toThrow(/not trusted/i);
  });

  it("can be run twice", async () => {
    const home = join(dir, "codex-home");
    await seedCodexTrust(
      home,
      dir,
      fakeCodex(home, () => [hook({})]),
    );
    const first = readFileSync(join(home, "config.toml"), "utf8");
    await seedCodexTrust(
      home,
      dir,
      fakeCodex(home, () => [hook({})]),
    );
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(first);
  });

  it("re-seeds after hooks.json changes", async () => {
    const home = join(dir, "codex-home");
    let hash = "hash-1";
    const hooks = () => [hook({ currentHash: hash })];
    await seedCodexTrust(home, dir, fakeCodex(home, hooks));
    hash = "hash-2";
    await seedCodexTrust(home, dir, fakeCodex(home, hooks));
    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain('trusted_hash = "hash-2"');
    expect(config).not.toContain("hash-1");
  });
});

describe("setup-agent command", () => {
  const setup = (args: string[], env: Record<string, string> = {}) =>
    run("node", ["--disable-warning=ExperimentalWarning", SETUP_MAIN, ...args], { env });

  it("writes the secrets and never prints a token", async () => {
    const out = await setup([dir], {
      CLEARANCE_HOOK_TOKEN: HOOK_TOKEN,
      ACME_GATE_TOKEN: GATE_TOKEN,
    });
    expect(out.code).toBe(0);
    expect(existsSync(join(dir, ".clearance", "gate-token"))).toBe(true);
    expect(out.stdout + out.stderr).not.toContain(HOOK_TOKEN);
    expect(out.stdout + out.stderr).not.toContain(GATE_TOKEN);
  });

  it.each(["CLEARANCE_HOOK_TOKEN", "ACME_GATE_TOKEN"])("refuses without %s", async (name) => {
    const env: Record<string, string> = {
      CLEARANCE_HOOK_TOKEN: HOOK_TOKEN,
      ACME_GATE_TOKEN: GATE_TOKEN,
    };
    delete env[name];
    const out = await setup([dir], env);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(name);
    expect(existsSync(join(dir, ".clearance"))).toBe(false);
  });

  it("refuses a directory that does not exist, and no arguments", async () => {
    const env = { CLEARANCE_HOOK_TOKEN: HOOK_TOKEN, ACME_GATE_TOKEN: GATE_TOKEN };
    expect((await setup([join(dir, "nope")], env)).code).toBe(1);
    expect((await setup([], env)).code).toBe(1);
  });
});
