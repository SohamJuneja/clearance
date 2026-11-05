/**
 * The Switch Gateway, signed in as a person. Managed agents and machines belong to whoever is signed in,
 * so setup scripts act as the owner rather than as the admin. Never prints a credential.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(process.env.CLEARANCE_ROOT ?? "/home/prashant/projects/Clearance");
export const BRIDGE_URL = (process.env.SWITCH_BRIDGE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
export const EMAIL_DOMAIN = "clearance.example";

export type Machine = {
  id: string;
  name: string;
  revoked_at?: string | null;
  status?: { machine?: { workspaces_dir?: string; sessions_running?: number }; agents?: unknown[] };
};

export type AgentDefinition = {
  provider: string;
  model?: string | null;
  instructions?: string;
  auto_mode?: boolean;
  auto_approve?: boolean;
  directory?: string | null;
  isolation?: string;
  advanced_config?: Record<string, unknown>;
};

export type ManagedAgent = {
  name: string;
  agent_id?: string;
  id?: string;
  desired_state?: string;
  revision?: number;
  controller_id?: string | null;
  definition: AgentDefinition;
};

export const agentIdOf = (agent: ManagedAgent): string => {
  const id = agent.agent_id ?? agent.id;
  if (!id) throw new Error(`agent ${agent.name} came back with no id`);
  return id;
};

/** Where a machine keeps agents with no directory of their own, for this server (`paths.ts` in Switch). */
export function defaultWorkspacesDir(): string {
  return join(homedir(), ".switch", "agents", new URL(BRIDGE_URL).host.replace(/[^A-Za-z0-9._-]+/g, "-"));
}

export function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) throw new Error(`env file not found: ${path}`);
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export const rootEnv = (): Record<string, string> => readDotenv(join(ROOT, ".env"));

export type Res = { status: number; body: unknown };

export type OwnerGateway = {
  owner: string;
  call(method: string, path: string, json?: unknown): Promise<Res>;
  /** Throws on anything but 2xx, with the server's own short reason. */
  must<T = unknown>(method: string, path: string, json?: unknown): Promise<T>;
};

export async function ownerGateway(owner: string): Promise<OwnerGateway> {
  let email: string | undefined;
  let password: string | undefined;
  if (owner === "admin") {
    const env = readDotenv(join(ROOT, "vendor/switch/.env"));
    email = env.GATEWAY_ADMIN_EMAIL;
    password = env.GATEWAY_ADMIN_PASSWORD;
  } else {
    email = `${owner}@${EMAIL_DOMAIN}`;
    password = rootEnv().PERSONA_PASSWORD;
  }
  if (!email || !password) throw new Error(`no credentials for ${owner}`);
  const login = await fetch(`${BRIDGE_URL}/gateway/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`gateway login as ${owner}: HTTP ${login.status}`);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const call = async (method: string, path: string, json?: unknown): Promise<Res> => {
    const res = await fetch(`${BRIDGE_URL}/gateway${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON.
    }
    return { status: res.status, body };
  };
  const must = async <T = unknown>(method: string, path: string, json?: unknown): Promise<T> => {
    const res = await call(method, path, json);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${owner}: ${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 600)}`);
    }
    return res.body as T;
  };
  return { owner, call, must };
}

/** The live machine this owner holds, by name or else the first. Throws when there is none. */
export async function ownerMachine(gateway: OwnerGateway, name?: string): Promise<Machine> {
  const machines = await gateway.must<Machine[]>("GET", "/management/controllers");
  const live = machines.filter((m) => !m.revoked_at && (name ? m.name === name : true));
  const machine = live[0];
  if (!machine) {
    throw new Error(
      `${gateway.owner} holds no machine${name ? ` named ${name}` : ""}: run scripts/setup-controller.sh --owner ${gateway.owner}`,
    );
  }
  return machine;
}
