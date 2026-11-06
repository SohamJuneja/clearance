/**
 * Prepares the Acme agents of PLAN 8.4 and creates them through the Gateway as their owners. Idempotent.
 * Never prints a secret. Run it from the main checkout: `.clearance/hook-cli` records this copy's path.
 *
 *   pnpm exec tsx scripts/setup-agents.ts --source acme-mini-app --codex-home ~/.codex
 *     [--agents refunds-agent,coder]   only these (default: all five)
 *     [--base <dir>]                   where the working copies go (default: the owner's machine's folder)
 *     [--prefix spike-]                prefix Switch names and folders, for tests
 *     [--no-create]                    prepare the folders only
 *
 * Each agent gets a working copy of --source, with tokens and Codex trust from packages/hook-cli/src/setup.ts,
 * and connector containment in its gitignored .claude/settings.local.json. Models, briefs and addressing come
 * from templates/acme-mini.template.yaml, so there is one source of truth. An existing folder is left as it is,
 * so an agent's work survives a rerun; to start one over, delete its folder first.
 *
 * Every run also writes each agent's own hook token, to data/hook-tokens.json and to its folder, kept or new.
 * That is how a folder set up with the old shared token moves over. Core loads the file at start, so restart
 * core after this: until then the hooks of any agent given a new token are denied, which fails closed.
 *
 * Agents are created directly, not by running the template: a template refuses a machine whose provider has no
 * login, and it creates a whole group or nothing. refunds-agent-vanilla has its own script, scripts/setup-baseline.ts.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import {
  defaultHookTokensPath,
  hookTokenFor,
  seedCodexTrust,
  writeAgentSecrets,
} from "../packages/hook-cli/src/setup.ts";
import {
  agentIdOf,
  defaultWorkspacesDir,
  ownerGateway,
  ownerMachine,
  rootEnv,
  type AgentDefinition,
  type ManagedAgent,
  type OwnerGateway,
} from "./gateway-owner.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** PLAN 8.4's owners. An agent can only run on a machine its owner holds. */
export const OWNERS: Record<string, string> = {
  "refunds-agent": "priya",
  "support-agent": "priya",
  coder: "alex",
  "ops-agent": "alex",
  reviewer: "alex",
};

export type AgentPlan = {
  name: string;
  owner: string;
  provider: string;
  model: string;
  display_name?: string;
  description: string;
  instructions: string;
  auto_mode: boolean;
  addressing: string;
};

type TemplateResource = {
  type?: string;
  name?: string;
  provider?: string;
  model?: string;
  display_name?: string;
  description?: string;
  instructions?: string;
  auto_mode?: boolean;
  addressing?: string;
};
type TemplateDoc = {
  params?: { clearance_rules?: { default?: string } };
  resources?: Record<string, TemplateResource>;
};

export function planAgents(templateText: string): AgentPlan[] {
  const doc = parse(templateText) as TemplateDoc;
  const rules = doc.params?.clearance_rules?.default;
  if (!rules) throw new Error("the template has no clearance_rules default");
  const agents = Object.values(doc.resources ?? {}).filter((r) => r.type === "agent");
  return agents.map((resource) => {
    const name = resource.name;
    if (!name) throw new Error("the template has an agent with no name");
    const owner = OWNERS[name];
    if (!owner) throw new Error(`${name} has no owner in PLAN 8.4`);
    if (!resource.model) throw new Error(`${name} has no model: it would run its owner's default`);
    if (!resource.provider) throw new Error(`${name} has no provider`);
    return {
      name,
      owner,
      provider: resource.provider,
      model: resource.model,
      display_name: resource.display_name,
      description: resource.description ?? "",
      instructions: (resource.instructions ?? "").replaceAll("{clearance_rules}", rules),
      auto_mode: resource.auto_mode ?? true,
      addressing: resource.addressing ?? "owner-agents",
    };
  });
}

export type LocalSettings = {
  env?: Record<string, string>;
  disableClaudeAiConnectors?: boolean;
  permissions?: { deny?: string[]; [key: string]: unknown };
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
};

const CONNECTOR_RULE = "mcp__claude_ai_*";

/**
 * Agents on the operator's login inherit his claude.ai connectors and his plugins. In this file so it holds
 * whatever the repo's own settings say. See spikes/RESULTS-vendors.md for which layers really work.
 */
export function withContainment(local: LocalSettings, operatorPlugins: string[]): LocalSettings {
  const deny = local.permissions?.deny ?? [];
  const plugins = { ...local.enabledPlugins };
  for (const plugin of operatorPlugins) plugins[plugin] = false;
  return {
    ...local,
    disableClaudeAiConnectors: true,
    permissions: { ...local.permissions, deny: deny.includes(CONNECTOR_RULE) ? deny : [...deny, CONNECTOR_RULE] },
    ...(Object.keys(plugins).length > 0 ? { enabledPlugins: plugins } : {}),
  };
}

function operatorPlugins(): string[] {
  const path = join(homedir(), ".claude/settings.json");
  if (!existsSync(path)) return [];
  const settings = JSON.parse(readFileSync(path, "utf8")) as { enabledPlugins?: Record<string, boolean> };
  return Object.keys(settings.enabledPlugins ?? {});
}

export function writeContainment(dir: string, plugins: string[]): void {
  const path = join(dir, ".claude/settings.local.json");
  const local = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LocalSettings) : {};
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(withContainment(local, plugins), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Everything a folder gets on every run, kept or new. A rerun over an old folder is what moves it over. */
export function setUpAgentDirectory(
  dir: string,
  options: { agent: string; tokensPath: string; gateToken: string; gateUrl: string; plugins: string[] },
): void {
  writeAgentSecrets(dir, {
    hookToken: hookTokenFor(options.tokensPath, options.agent),
    gateToken: options.gateToken,
    gateUrl: options.gateUrl,
  });
  writeContainment(dir, options.plugins);
}

/** The agent's own gate token, by reversing GATE_AGENT_TOKENS. Fails closed. Errors never hold a token. */
export function gateTokenFor(raw: string | undefined, agent: string): string {
  if (!raw) throw new Error("GATE_AGENT_TOKENS is empty in the root .env");
  const tokens = JSON.parse(raw) as Record<string, { agent?: string }>;
  const found = Object.entries(tokens).find(([, grant]) => grant.agent === agent);
  if (!found) throw new Error(`no gate token for ${agent} in GATE_AGENT_TOKENS`);
  return found[0];
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=Clearance setup", "-c", "user.email=setup@clearance.example", ...args], {
    cwd,
    stdio: "ignore",
  });
};

/** Secrets setup writes per agent: never in a copy, and never tracked in a clone. */
const LOCAL_ONLY = [".clearance/", ".claude/settings.local.json", ".codex/config.toml"];
const NOT_COPIED = new Set(["node_modules", ".git", ".clearance"]);

function copySource(source: string, dir: string): void {
  const root = resolve(source);
  cpSync(root, dir, {
    recursive: true,
    filter: (path) => {
      const rel = relative(root, path);
      if (rel === "") return true;
      if (rel.split(sep).some((part) => NOT_COPIED.has(part))) return false;
      return !LOCAL_ONLY.includes(rel);
    },
  });
}

/**
 * A working copy of the source, as a real repo. A plain directory gets a shared local bare origin, so a
 * `git push` that gets through is visible and can never leave this machine. An existing folder is left alone.
 */
export function prepareDirectory(source: string, dir: string, originsDir: string): "created" | "kept" {
  if (existsSync(dir)) return "kept";
  mkdirSync(dirname(dir), { recursive: true });
  if (existsSync(join(source, ".git"))) {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", resolve(source), dir], { stdio: "ignore" });
  } else {
    const origin = join(originsDir, `${basename(resolve(source))}.git`);
    copySource(source, dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", "Acme working copy");
    if (existsSync(origin)) {
      git(dir, "remote", "add", "origin", origin);
    } else {
      mkdirSync(originsDir, { recursive: true });
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "ignore" });
      git(dir, "remote", "add", "origin", origin);
      git(dir, "push", "-q", "-u", "origin", "main");
    }
  }
  writeFileSync(join(dir, ".git/info/exclude"), `${LOCAL_ONLY.join("\n")}\n`, { flag: "a" });
  return "created";
}

const COMPARED: (keyof AgentDefinition)[] = ["provider", "model", "instructions", "auto_mode", "auto_approve", "directory", "isolation"];

export function agentNeedsUpdate(current: AgentDefinition, want: AgentDefinition): boolean {
  return COMPARED.some((field) => current[field] !== want[field]);
}

async function ensureAgent(
  gateway: OwnerGateway,
  name: string,
  plan: AgentPlan,
  definition: AgentDefinition,
  controllerId: string,
): Promise<string> {
  const existing = (await gateway.must<ManagedAgent[]>("GET", "/management/agents")).find((a) => a.name === name);
  let id: string;
  let state: string;
  if (existing) {
    id = agentIdOf(existing);
    if (agentNeedsUpdate(existing.definition, definition)) {
      await gateway.must("PATCH", `/management/agents/${id}`, { definition: { ...existing.definition, ...definition } });
      state = "updated";
    } else {
      state = "unchanged";
    }
  } else {
    const created = await gateway.must<ManagedAgent>("POST", "/management/agents", {
      name,
      display_name: plan.display_name ?? null,
      description: plan.description,
      controller_id: controllerId,
      desired_state: "running",
      definition,
    });
    id = agentIdOf(created);
    state = "created";
  }
  // `anyone` is a cleared policy. The default, owner-agents, would refuse Clearance: it has its own owner.
  if (plan.addressing === "anyone") {
    await gateway.must("PUT", `/agents/${id}/addressing-policy`, { policy: null });
  }
  return state;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      agents: { type: "string" },
      base: { type: "string" },
      prefix: { type: "string", default: "" },
      "codex-home": { type: "string" },
      "no-create": { type: "boolean", default: false },
    },
  });
  if (!values.source) throw new Error("--source <dir> is required");
  const source = resolve(values.source);
  if (!existsSync(source)) throw new Error(`no source directory at ${source}`);
  const env = rootEnv();
  const tokensPath = defaultHookTokensPath(env);
  const gateUrl = env.CLEARANCE_GATE_URL ?? "http://127.0.0.1:7710";
  const wanted = values.agents?.split(",").map((a) => a.trim());
  const plans = planAgents(readFileSync(join(REPO, "templates/acme-mini.template.yaml"), "utf8")).filter(
    (plan) => !wanted || wanted.includes(plan.name),
  );
  if (plans.length === 0) throw new Error(`no agents match ${String(values.agents)}`);
  if (plans.some((p) => p.provider === "codex") && !values["codex-home"]) {
    // A Codex agent with no seeded trust silently runs no hooks, so refuse rather than leave one unenforced.
    throw new Error("--codex-home is required for Codex agents, usually ~/.codex: unseeded hooks silently do nothing");
  }
  const plugins = operatorPlugins();
  const gateways = new Map<string, OwnerGateway>();
  const problems: string[] = [];

  for (const plan of plans) {
    const name = `${values.prefix}${plan.name}`;
    let gateway = gateways.get(plan.owner);
    if (!gateway) {
      gateway = await ownerGateway(plan.owner);
      gateways.set(plan.owner, gateway);
    }
    const machine = await ownerMachine(gateway, `clearance-${plan.owner}`);
    const base = values.base ? resolve(values.base) : (machine.status?.machine?.workspaces_dir ?? defaultWorkspacesDir());
    const target = join(base, name);
    const folder = prepareDirectory(source, target, join(base, ".origin"));
    // Codex keys hook trust by the real path, so a symlinked base has to be resolved first.
    const dir = realpathSync(target);
    setUpAgentDirectory(dir, {
      agent: name,
      tokensPath,
      gateToken: gateTokenFor(env.GATE_AGENT_TOKENS, plan.name),
      gateUrl,
      plugins,
    });
    let trust = "n/a";
    if (plan.provider === "codex") {
      const seeded = await seedCodexTrust(resolve(values["codex-home"]!.replace(/^~/, homedir())), dir);
      trust = `${seeded} hooks trusted`;
    }
    let agent = "skipped";
    if (!values["no-create"]) {
      const definition: AgentDefinition = {
        provider: plan.provider,
        model: plan.model,
        instructions: plan.instructions,
        auto_mode: plan.auto_mode,
        auto_approve: false,
        directory: dir,
        isolation: "shared",
      };
      try {
        agent = await ensureAgent(gateway, name, plan, definition, machine.id);
      } catch (error) {
        agent = "FAILED";
        problems.push(`${name}: ${(error as Error).message}`);
      }
    }
    console.log(`${name}: owner=${plan.owner} machine=${machine.name} provider=${plan.provider} model=${plan.model} folder=${folder} agent=${agent} codex_trust=${trust} dir=${dir}`);
  }
  console.log(`hook tokens are in ${tokensPath}. Restart core to load them: scripts/services.sh down core && scripts/services.sh up core`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
