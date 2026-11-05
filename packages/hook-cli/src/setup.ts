/**
 * What an agent's directory needs before its first session. The controller's env file does not reach
 * a session (spikes/RESULTS-vendors.md), so tokens are written here, one set per agent.
 *
 * The agent can read all of these. They prove "this is a hook of this agent", and they are not
 * secrets from the agent. The Acme admin key is never among them.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type AgentSecrets = { hookToken: string; gateToken: string; gateUrl: string };

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  // writeFile only applies the mode to a new file.
  chmodSync(path, 0o600);
}

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function writeAgentSecrets(dir: string, secrets: AgentSecrets): void {
  const clearance = join(dir, ".clearance");
  privateDir(clearance);
  writePrivate(join(clearance, "hook-token"), `${secrets.hookToken}\n`);
  writePrivate(join(clearance, "gate-token"), `${secrets.gateToken}\n`);
  // Agents run from clones outside this repo with no env of ours, so bin/clearance-hook reads this.
  writePrivate(
    join(clearance, "hook-cli"),
    `${fileURLToPath(new URL("./main.ts", import.meta.url))}\n`,
  );

  // Claude reads CLEARANCE_HOOK_TOKEN from here for its http hook header, and ACME_GATE_TOKEN for
  // .mcp.json. It is the one env route measured to reach a session.
  const claude = join(dir, ".claude");
  mkdirSync(claude, { recursive: true });
  const localPath = join(claude, "settings.local.json");
  const local = existsSync(localPath)
    ? (JSON.parse(readFileSync(localPath, "utf8")) as { env?: Record<string, string> })
    : {};
  const merged = {
    ...local,
    env: {
      ...local.env,
      CLEARANCE_HOOK_TOKEN: secrets.hookToken,
      ACME_GATE_TOKEN: secrets.gateToken,
    },
  };
  writePrivate(localPath, `${JSON.stringify(merged, null, 2)}\n`);

  // Codex has no env route, and this file holds the token, so it is written here and gitignored.
  const codex = join(dir, ".codex");
  mkdirSync(codex, { recursive: true });
  const base = secrets.gateUrl.replace(/\/+$/, "");
  writePrivate(
    join(codex, "config.toml"),
    `[mcp_servers.clearance_gate]\nurl = ${JSON.stringify(`${base}/mcp`)}\n` +
      `http_headers = { Authorization = ${JSON.stringify(`Bearer ${secrets.gateToken}`)} }\n`,
  );
}

/** Sets a whole TOML table, replacing any earlier copy and leaving everything else as it was. */
function withTable(text: string, header: string, body: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (line.trim() === header) {
      skipping = true;
      continue;
    }
    if (skipping && line.trimStart().startsWith("[")) skipping = false;
    if (!skipping) kept.push(line);
  }
  const rest = kept.join("\n").trim();
  return `${rest ? `${rest}\n\n` : ""}${header}\n${body}\n`;
}

export function trustProject(toml: string, dir: string): string {
  return withTable(toml, `[projects.${JSON.stringify(dir)}]`, 'trust_level = "trusted"');
}

export function trustHooks(toml: string, hooks: Pick<CodexHook, "key" | "currentHash">[]): string {
  return hooks.reduce(
    (text, hook) =>
      withTable(
        text,
        `[hooks.state.${JSON.stringify(hook.key)}]`,
        `trusted_hash = ${JSON.stringify(hook.currentHash)}`,
      ),
    toml,
  );
}

export type CodexHook = { key: string; currentHash: string; trustStatus: string };
export type ListCodexHooks = (codexHome: string, dir: string) => Promise<CodexHook[]>;

/**
 * Asks `codex app-server` for `hooks/list`. `codex` on this host is a Volta shim, so killing the
 * child alone can leave the real server running: it leads its own process group, and the group is
 * what gets killed.
 */
export const listCodexHooks: ListCodexHooks = (codexHome, dir) =>
  new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], {
      cwd: dir,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    const stop = () => {
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const fail = (err: Error) => {
      stop();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new Error("codex app-server did not answer hooks/list in time")),
      20_000,
    );
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", fail);
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as {
        id?: number;
        error?: unknown;
        result?: { data: { hooks: CodexHook[] }[] };
      };
      if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "hooks/list", params: { cwds: [dir] } });
      }
      if (message.id === 2) {
        stop();
        if (message.error) reject(new Error("codex app-server refused hooks/list"));
        else resolve((message.result?.data ?? []).flatMap((entry) => entry.hooks));
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "clearance_setup", title: "Clearance setup", version: "0.1.0" },
      },
    });
  });

/**
 * Codex silently skips hooks nobody has reviewed and then runs the command, so an unseeded
 * `.codex/hooks.json` does nothing at all. This records the project as trusted and this project's
 * hooks as reviewed, then checks that Codex agrees. Other hooks are left for a person to review.
 * Switch reads this at agent start: use `agent.restart` afterwards, since `!reset` is not enough.
 */
export async function seedCodexTrust(
  codexHome: string,
  dir: string,
  list: ListCodexHooks = listCodexHooks,
): Promise<number> {
  mkdirSync(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  const read = () => (existsSync(configPath) ? readFileSync(configPath, "utf8") : "");

  // Codex lists no project hooks until the project is trusted.
  writeFileSync(configPath, trustProject(read(), dir));
  const ours = (hooks: CodexHook[]) => hooks.filter((hook) => hook.key.startsWith(`${dir}/`));

  const hooks = ours(await list(codexHome, dir));
  if (hooks.length === 0) throw new Error(`Codex shows no hooks for ${dir}`);
  writeFileSync(configPath, trustHooks(read(), hooks));

  const after = ours(await list(codexHome, dir));
  const notTrusted = after.filter((hook) => hook.trustStatus !== "trusted");
  if (after.length === 0 || notTrusted.length > 0) {
    throw new Error(
      `Codex says these hooks are not trusted: ${notTrusted.map((h) => h.key).join(", ")}`,
    );
  }
  return hooks.length;
}
