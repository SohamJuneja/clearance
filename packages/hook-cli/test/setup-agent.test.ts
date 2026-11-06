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
  defaultHookTokensPath,
  hookTokenFor,
  seedCodexTrust,
  trustHooks,
  trustProject,
  writeAgentSecrets,
  type CodexHook,
} from "../src/setup.ts";
import { loadHookTokens } from "@clearance/adapters";
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

  it("tightens files an earlier setup left open", () => {
    mkdirSync(join(dir, ".clearance"));
    mkdirSync(join(dir, ".claude"));
    const left = [
      join(dir, ".clearance", "hook-token"),
      join(dir, ".claude", "settings.local.json"),
    ];
    for (const file of left) writeFileSync(file, "{}\n", { mode: 0o644 });
    writeAgentSecrets(dir, opts);
    for (const file of left) expect(mode(file)).toBe(0o600);
  });

  it("can be run again with new tokens", () => {
    writeAgentSecrets(dir, opts);
    writeAgentSecrets(dir, { ...opts, gateToken: "rotated" });
    expect(readFileSync(join(dir, ".clearance", "gate-token"), "utf8").trim()).toBe("rotated");
    expect(readFileSync(join(dir, ".codex", "config.toml"), "utf8")).not.toContain(GATE_TOKEN);
  });
});

describe("hookTokenFor", () => {
  const file = () => join(dir, "data", "hook-tokens.json");
  const read = () => JSON.parse(readFileSync(file(), "utf8")) as Record<string, string>;

  it("creates the file, mode 600, with a long random token for the agent", () => {
    const token = hookTokenFor(file(), "coder");
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(read()).toEqual({ [token]: "coder" });
    expect(mode(file())).toBe(0o600);
  });

  it("gives each agent its own token", () => {
    const a = hookTokenFor(file(), "coder");
    const b = hookTokenFor(file(), "ops-agent");
    expect(a).not.toBe(b);
    expect(read()).toEqual({ [a]: "coder", [b]: "ops-agent" });
  });

  it("keeps an agent's token across reruns, so rerunning setup does not lock it out", () => {
    const first = hookTokenFor(file(), "coder");
    expect(hookTokenFor(file(), "coder")).toBe(first);
    expect(Object.keys(read())).toHaveLength(1);
  });

  it("tightens a file that was left open", () => {
    mkdirSync(join(dir, "data"));
    writeFileSync(file(), JSON.stringify({ "existing-token": "coder" }), { mode: 0o644 });
    hookTokenFor(file(), "ops-agent");
    expect(mode(file())).toBe(0o600);
    expect(read()["existing-token"]).toBe("coder");
  });

  it.each(["not json", "[]", '"string"'])(
    "refuses to overwrite a file it can't read: %s",
    (bad) => {
      mkdirSync(join(dir, "data"));
      writeFileSync(file(), bad);
      expect(() => hookTokenFor(file(), "coder")).toThrow(/hook-tokens\.json/);
      expect(readFileSync(file(), "utf8")).toBe(bad);
    },
  );

  it("writes what core's loader accepts", () => {
    const token = hookTokenFor(file(), "coder");
    expect(loadHookTokens(file())).toEqual({ [token]: "coder" });
  });

  it("defaults to data/hook-tokens.json in the repo, where core looks", () => {
    expect(defaultHookTokensPath({})).toBe(join(REPO_ROOT, "data", "hook-tokens.json"));
    expect(defaultHookTokensPath({ CLEARANCE_DATA_DIR: "/d" })).toBe("/d/hook-tokens.json");
    expect(defaultHookTokensPath({ CLEARANCE_HOOK_TOKENS_PATH: "/x/t.json" })).toBe("/x/t.json");
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
  const tokensFile = () => join(dir, "tokens", "hook-tokens.json");
  const setup = (args: string[], env: Record<string, string> = {}) =>
    run("node", ["--disable-warning=ExperimentalWarning", SETUP_MAIN, ...args], { env });
  const gate = { ACME_GATE_TOKEN: GATE_TOKEN };

  it("gives the agent its own token, in its directory and in the file core loads", async () => {
    const out = await setup([dir, "--agent", "coder", "--tokens-file", tokensFile()], gate);
    expect(out.code, out.stderr).toBe(0);
    const inDir = readFileSync(join(dir, ".clearance", "hook-token"), "utf8").trim();
    expect(loadHookTokens(tokensFile())).toEqual({ [inDir]: "coder" });
    const local = JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));
    expect(local.env.CLEARANCE_HOOK_TOKEN).toBe(inDir);
    expect(existsSync(join(dir, ".clearance", "gate-token"))).toBe(true);
  });

  it("never prints a token", async () => {
    const out = await setup([dir, "--agent", "coder", "--tokens-file", tokensFile()], gate);
    const hookToken = readFileSync(join(dir, ".clearance", "hook-token"), "utf8").trim();
    expect(out.stdout + out.stderr).not.toContain(hookToken);
    expect(out.stdout + out.stderr).not.toContain(GATE_TOKEN);
  });

  it("ignores a shared CLEARANCE_HOOK_TOKEN, so one can't come back through setup", async () => {
    await setup([dir, "--agent", "coder", "--tokens-file", tokensFile()], {
      ...gate,
      CLEARANCE_HOOK_TOKEN: HOOK_TOKEN,
    });
    expect(readFileSync(join(dir, ".clearance", "hook-token"), "utf8")).not.toContain(HOOK_TOKEN);
    expect(readFileSync(tokensFile(), "utf8")).not.toContain(HOOK_TOKEN);
  });

  it("replaces the old shared token in a directory set up before", async () => {
    mkdirSync(join(dir, ".clearance"));
    writeFileSync(join(dir, ".clearance", "hook-token"), `${HOOK_TOKEN}\n`);
    await setup([dir, "--agent", "coder", "--tokens-file", tokensFile()], gate);
    expect(readFileSync(join(dir, ".clearance", "hook-token"), "utf8")).not.toContain(HOOK_TOKEN);
  });

  it("reads the tokens file's place from CLEARANCE_HOOK_TOKENS_PATH", async () => {
    const out = await setup([dir, "--agent", "coder"], {
      ...gate,
      CLEARANCE_HOOK_TOKENS_PATH: tokensFile(),
    });
    expect(out.code, out.stderr).toBe(0);
    expect(Object.values(loadHookTokens(tokensFile()))).toEqual(["coder"]);
  });

  it("refuses without --agent, since a token has to prove someone", async () => {
    const out = await setup([dir, "--tokens-file", tokensFile()], gate);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("--agent");
    expect(existsSync(join(dir, ".clearance"))).toBe(false);
    expect(existsSync(tokensFile())).toBe(false);
  });

  it("refuses without ACME_GATE_TOKEN", async () => {
    const out = await setup([dir, "--agent", "coder", "--tokens-file", tokensFile()]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("ACME_GATE_TOKEN");
    expect(existsSync(join(dir, ".clearance"))).toBe(false);
    expect(existsSync(tokensFile())).toBe(false);
  });

  it("refuses a directory that does not exist, and no arguments", async () => {
    const missing = [join(dir, "nope"), "--agent", "coder", "--tokens-file", tokensFile()];
    expect((await setup(missing, gate)).code).toBe(1);
    expect((await setup([], gate)).code).toBe(1);
  });
});
