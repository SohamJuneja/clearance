import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import {
  agentNeedsUpdate,
  gateTokenFor,
  OWNERS,
  planAgents,
  prepareDirectory,
  setUpAgentDirectory,
  withContainment,
  writeContainment,
} from "./setup-agents.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const template = readFileSync(join(REPO, "templates/acme-mini.template.yaml"), "utf8");

describe("planAgents", () => {
  const plans = planAgents(template);

  it("plans the five agents of PLAN 8.4 with the owner and vendor it names", () => {
    expect(plans.map((p) => [p.name, p.owner, p.provider])).toEqual([
      ["refunds-agent", "priya", "claude"],
      ["support-agent", "priya", "codex"],
      ["coder", "alex", "claude"],
      ["ops-agent", "alex", "opencode"],
      ["reviewer", "alex", "cursor"],
    ]);
  });

  it("always sets a model, since an agent with none runs its owner's default", () => {
    for (const plan of plans) expect(plan.model, plan.name).toBeTruthy();
    expect(plans.filter((p) => p.provider === "claude").map((p) => p.model)).toEqual(["haiku", "haiku"]);
  });

  it("puts the Clearance rules into every brief and leaves no placeholder behind", () => {
    for (const plan of plans) {
      expect(plan.instructions, plan.name).toContain("Clearance rules");
      expect(plan.instructions, plan.name).not.toContain("{clearance_rules}");
    }
  });

  it("keeps every agent addressable by Clearance, which has its own owner", () => {
    for (const plan of plans) expect(plan.addressing, plan.name).toBe("anyone");
  });

  it("refuses a template whose agent has no model", () => {
    const broken = template.replace("    model: haiku\n", "");
    expect(() => planAgents(broken)).toThrow(/refunds-agent has no model/);
  });

  it("refuses an agent PLAN 8.4 gives no owner", () => {
    expect(Object.keys(OWNERS)).not.toContain("stranger");
    const broken = template.replace("name: coder", "name: stranger");
    expect(() => planAgents(broken)).toThrow(/stranger has no owner/);
  });
});

describe("withContainment", () => {
  it("turns connectors off and hides their tools", () => {
    const out = withContainment({}, []);
    expect(out.disableClaudeAiConnectors).toBe(true);
    expect(out.permissions?.deny).toEqual(["mcp__claude_ai_*"]);
  });

  it("keeps what is already there, including the tokens setup wrote", () => {
    const out = withContainment({ env: { CLEARANCE_HOOK_TOKEN: "x" }, permissions: { deny: ["Other"], allow: ["A"] } }, []);
    expect(out.env).toEqual({ CLEARANCE_HOOK_TOKEN: "x" });
    expect(out.permissions).toEqual({ deny: ["Other", "mcp__claude_ai_*"], allow: ["A"] });
  });

  it("is stable when applied twice", () => {
    const once = withContainment({}, ["a@b"]);
    expect(withContainment(once, ["a@b"])).toEqual(once);
  });

  it("turns off each of the operator's plugins by name", () => {
    expect(withContainment({}, ["a@b", "c@d"]).enabledPlugins).toEqual({ "a@b": false, "c@d": false });
  });
});

describe("gateTokenFor", () => {
  const tokens = JSON.stringify({ t1: { agent: "coder", classes: ["merge"] }, t2: { agent: "ops-agent", classes: [] } });

  it("finds the agent's own token", () => {
    expect(gateTokenFor(tokens, "ops-agent")).toBe("t2");
  });

  it("fails closed when the agent has none", () => {
    expect(() => gateTokenFor(tokens, "reviewer")).toThrow(/no gate token for reviewer/);
    expect(() => gateTokenFor(undefined, "coder")).toThrow(/GATE_AGENT_TOKENS/);
  });

  it("never puts a token in its error", () => {
    let message = "";
    try {
      gateTokenFor(tokens, "reviewer");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/no gate token/);
    expect(message).not.toContain("t1");
  });
});

describe("agentNeedsUpdate", () => {
  const want = { provider: "claude", model: "haiku", instructions: "x", auto_mode: true, auto_approve: false, directory: "/d", isolation: "shared" };

  it("is false when the definition already matches, ignoring fields the server adds", () => {
    expect(agentNeedsUpdate({ ...want, advanced_config: {} }, want)).toBe(false);
  });

  it("is true when a field we set differs", () => {
    expect(agentNeedsUpdate({ ...want, model: "opus" }, want)).toBe(true);
    expect(agentNeedsUpdate({ ...want, directory: "/other" }, want)).toBe(true);
    expect(agentNeedsUpdate({ ...want, auto_mode: false }, want)).toBe(true);
  });
});

describe("prepareDirectory", () => {
  let root: string;
  let source: string;
  let base: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "setup-agents-"));
    source = join(root, "source");
    base = join(root, "base");
    mkdirSync(join(source, ".claude"), { recursive: true });
    mkdirSync(join(source, "node_modules/x"), { recursive: true });
    mkdirSync(join(source, ".clearance"), { recursive: true });
    writeFileSync(join(source, "README.md"), "one\n");
    writeFileSync(join(source, ".claude/settings.json"), "{}\n");
    writeFileSync(join(source, ".claude/settings.local.json"), '{"env":{"LEAK":"1"}}\n');
    writeFileSync(join(source, ".clearance/hook-token"), "LEAK\n");
    writeFileSync(join(source, "node_modules/x/a.js"), "x\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const log = (dir: string) => execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().split("\n");

  it("copies a plain directory into a real repo with a local origin, and no secrets or node_modules", () => {
    const dir = join(base, "coder");
    expect(prepareDirectory(source, dir, join(base, ".origin"))).toBe("created");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("one\n");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    expect(existsSync(join(dir, ".clearance/hook-token"))).toBe(false);
    expect(existsSync(join(dir, ".claude/settings.local.json"))).toBe(false);
    expect(log(dir)).toHaveLength(1);
    execFileSync("git", ["push", "--dry-run", "origin", "main"], { cwd: dir, stdio: "ignore" });
  });

  it("keeps secrets out of git, whatever the source's own ignore file says", () => {
    const dir = join(base, "coder");
    prepareDirectory(source, dir, join(base, ".origin"));
    mkdirSync(join(dir, ".clearance"), { recursive: true });
    writeFileSync(join(dir, ".clearance/hook-token"), "secret\n");
    writeFileSync(join(dir, ".claude/settings.local.json"), "{}\n");
    writeFileSync(join(dir, ".codex-probe"), "");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(status).not.toContain("hook-token");
    expect(status).not.toContain("settings.local.json");
  });

  it("clones a source that is already a git repo", () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: source });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "README.md"], { cwd: source });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "first"], { cwd: source });
    const dir = join(base, "coder");
    expect(prepareDirectory(source, dir, join(base, ".origin"))).toBe("created");
    expect(log(dir)).toHaveLength(1);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  it("leaves an existing directory alone on a second run, so an agent's work survives", () => {
    const dir = join(base, "coder");
    prepareDirectory(source, dir, join(base, ".origin"));
    writeFileSync(join(dir, "work.txt"), "mine\n");
    writeFileSync(join(source, "README.md"), "two\n");
    expect(prepareDirectory(source, dir, join(base, ".origin"))).toBe("kept");
    expect(readFileSync(join(dir, "work.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("one\n");
  });

  it("gives two agents separate working copies of one shared origin", () => {
    const a = join(base, "a");
    const b = join(base, "b");
    prepareDirectory(source, a, join(base, ".origin"));
    prepareDirectory(source, b, join(base, ".origin"));
    const remote = (dir: string) => execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8" }).trim();
    expect(remote(a)).toBe(remote(b));
    expect(a).not.toBe(b);
  });
});

describe("writeContainment", () => {
  it("writes the gitignored local settings with mode 600 and keeps the tokens in them", () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-agents-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".claude"));
    const file = join(dir, ".claude/settings.local.json");
    writeFileSync(file, '{"env":{"CLEARANCE_HOOK_TOKEN":"x"}}\n');
    writeContainment(dir, []);
    const out = JSON.parse(readFileSync(file, "utf8"));
    expect(out.env.CLEARANCE_HOOK_TOKEN).toBe("x");
    expect(out.disableClaudeAiConnectors).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("setUpAgentDirectory, which is what a rerun applies to a folder set up before", () => {
  const setUp = (dir: string, tokensPath: string, agent = "coder") =>
    setUpAgentDirectory(dir, { agent, tokensPath, gateToken: "gate-token", gateUrl: "http://g", plugins: [] });
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), "setup-agents-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "coder"));
    mkdirSync(join(root, "ops-agent"));
    return { root, tokensPath: join(root, "data/hook-tokens.json") };
  };
  const hookFile = (dir: string) => readFileSync(join(dir, ".clearance/hook-token"), "utf8").trim();
  const local = (dir: string) => JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8"));

  it("replaces the old shared token in a kept folder, in both places vendors read it", () => {
    const { root, tokensPath } = fresh();
    const dir = join(root, "coder");
    mkdirSync(join(dir, ".clearance"));
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".clearance/hook-token"), "old-shared-token\n");
    writeFileSync(join(dir, ".claude/settings.local.json"), '{"env":{"CLEARANCE_HOOK_TOKEN":"old-shared-token"}}\n');
    writeFileSync(join(dir, "work.txt"), "mine\n");
    setUp(dir, tokensPath);
    const token = hookFile(dir);
    expect(token).not.toBe("old-shared-token");
    expect(local(dir).env.CLEARANCE_HOOK_TOKEN).toBe(token);
    expect(JSON.parse(readFileSync(tokensPath, "utf8"))).toEqual({ [token]: "coder" });
    expect(readFileSync(join(dir, "work.txt"), "utf8")).toBe("mine\n");
  });

  it("gives two agents different tokens, and each keeps its own on a rerun", () => {
    const { root, tokensPath } = fresh();
    setUp(join(root, "coder"), tokensPath, "coder");
    setUp(join(root, "ops-agent"), tokensPath, "ops-agent");
    const coder = hookFile(join(root, "coder"));
    expect(coder).not.toBe(hookFile(join(root, "ops-agent")));
    setUp(join(root, "coder"), tokensPath, "coder");
    expect(hookFile(join(root, "coder"))).toBe(coder);
  });

  it("still contains connectors, whatever else it writes", () => {
    const { root, tokensPath } = fresh();
    setUp(join(root, "coder"), tokensPath);
    expect(local(join(root, "coder")).disableClaudeAiConnectors).toBe(true);
  });
});
