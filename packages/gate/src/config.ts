import { DEFAULT_PORTS } from "@clearance/contracts";
import { z } from "zod";
import { GATE_CLASSES, type GateClass } from "./operations.js";

export type AgentGrant = { agent: string; classes: GateClass[] };

export type GateConfig = {
  /** Per-agent gate tokens: token to the agent it identifies and the classes it may call. */
  agentTokens: Record<string, AgentGrant>;
  coreUrl: string;
  acmeUrl: string;
  /** Custody credential. Lives only here; never logged, stored or returned. */
  acmeAdminKey: string;
  /**
   * Shared with core in both directions: sent on /v1/check and /v1/requests, required on /internal/*.
   * Not the hook token, which agents can read.
   */
  internalToken: string;
  dbPath: string;
  port?: number;
  host?: string;
  coreTimeoutMs?: number;
  acmeTimeoutMs?: number;
};

const PLACEHOLDER = "change-me";

const GrantSchema = z
  .object({ agent: z.string().min(1), classes: z.array(z.enum(GATE_CLASSES)) })
  .strict();

function secret(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  if (value === PLACEHOLDER) throw new Error(`${name} still has its .env.example placeholder`);
  return value;
}

/** Errors name the entry by position and never echo a token, since the keys here are secrets. */
function parseAgentTokens(raw: string | undefined): Record<string, AgentGrant> {
  if (!raw) throw new Error("GATE_AGENT_TOKENS is required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GATE_AGENT_TOKENS is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GATE_AGENT_TOKENS must be a JSON object of token to {agent, classes}");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error("GATE_AGENT_TOKENS has no tokens");
  const tokens: Record<string, AgentGrant> = {};
  entries.forEach(([token, grant], index) => {
    const result = GrantSchema.safeParse(grant);
    if (!token || !result.success) {
      const why = result.success
        ? "empty token"
        : result.error.issues.map((i) => i.message).join("; ");
      throw new Error(`GATE_AGENT_TOKENS entry ${index + 1} is invalid: ${why}`);
    }
    tokens[token] = result.data;
  });
  return tokens;
}

export function loadGateConfig(
  env: Record<string, string | undefined>,
): GateConfig & { port: number; host: string } {
  const port = Number(env.CLEARANCE_GATE_PORT ?? DEFAULT_PORTS.gate);
  if (!Number.isInteger(port) || port <= 0)
    throw new Error("CLEARANCE_GATE_PORT is not a port number");
  return {
    agentTokens: parseAgentTokens(env.GATE_AGENT_TOKENS),
    coreUrl: env.CLEARANCE_CORE_URL ?? `http://127.0.0.1:${DEFAULT_PORTS.core}`,
    acmeUrl: env.ACME_URL ?? `http://127.0.0.1:${DEFAULT_PORTS.acme}`,
    acmeAdminKey: secret(env, "ACME_ADMIN_KEY"),
    internalToken: secret(env, "CLEARANCE_INTERNAL_TOKEN"),
    dbPath: env.CLEARANCE_GATE_DB_PATH ?? "./data/gate.sqlite",
    port,
    host: env.CLEARANCE_GATE_HOST ?? "127.0.0.1",
  };
}
