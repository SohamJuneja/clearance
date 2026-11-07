/**
 * The connector's settings, from its environment. It refuses to start rather than run on a missing or placeholder token,
 * a token file others can read, or a plain-HTTP core away from this machine, which would send the token in the clear.
 *
 * The token is core's CLEARANCE_INTERNAL_TOKEN, the one the Desk uses. Agents never hold it: they have only their own hook
 * and gate tokens, and the fence keeps the repo, data/ and .env out of their sight. So inside an agent's fence this has no
 * token to read and won't start, which is the point. Errors name a file or a variable, never a token.
 */
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

export const DEFAULT_CORE_URL = "http://127.0.0.1:7700";
/** Long enough for a healthy local core and a dry run's lookups, short enough that a stuck core is reported. */
export const DEFAULT_TIMEOUT_MS = 8000;

export type ConnectorConfig = {
  coreUrl: string;
  token: string;
  /** The team id of the person using this, as in policy/team.yaml: whose cards "waiting on me" lists. Not an identity. */
  person: string | null;
  timeoutMs: number;
};

export class ConfigError extends Error {}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PLACEHOLDERS = new Set(["change-me", "changeme", "placeholder", "your-token-here"]);

/** An empty variable is one nobody set. */
const optionalText = z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().optional());

const EnvSchema = z.object({
  CLEARANCE_CORE_URL: optionalText,
  CLEARANCE_TOKEN_FILE: optionalText,
  CLEARANCE_INTERNAL_TOKEN: optionalText,
  CLEARANCE_PERSON: optionalText,
  CLEARANCE_CONNECTOR_TIMEOUT_MS: optionalText,
});

function coreUrlFrom(value: string | undefined): string {
  const text = (value ?? DEFAULT_CORE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`CLEARANCE_CORE_URL is not a URL: ${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError("CLEARANCE_CORE_URL must be http or https");
  if (url.username || url.password) throw new ConfigError("CLEARANCE_CORE_URL must not carry a user or password");
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    throw new ConfigError(`CLEARANCE_CORE_URL would send the token in the clear to ${url.hostname}: use https, or core on this machine`);
  }
  return text;
}

function tokenFromFile(path: string): string {
  let mode: number;
  let text: string;
  try {
    mode = statSync(path).mode;
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`CLEARANCE_TOKEN_FILE ${path} can't be read`);
  }
  if ((mode & 0o077) !== 0) throw new ConfigError(`CLEARANCE_TOKEN_FILE ${path} must be mode 600, and is open to others: chmod 600 it`);
  return text.trim();
}

function checkedToken(token: string, from: string): string {
  if (!token) throw new ConfigError(`${from} is empty`);
  if (PLACEHOLDERS.has(token.toLowerCase()) || /^<.*>$/.test(token)) {
    throw new ConfigError(`${from} is still a placeholder. Use core's CLEARANCE_INTERNAL_TOKEN from .env`);
  }
  if (/\s/.test(token)) throw new ConfigError(`${from} must hold the token and nothing else`);
  return token;
}

export function loadConfig(env: Record<string, string | undefined>): ConnectorConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError("the connector's environment can't be read");
  const vars = parsed.data;

  const coreUrl = coreUrlFrom(vars.CLEARANCE_CORE_URL);
  let token: string;
  if (vars.CLEARANCE_TOKEN_FILE !== undefined) {
    token = checkedToken(tokenFromFile(vars.CLEARANCE_TOKEN_FILE), `CLEARANCE_TOKEN_FILE ${vars.CLEARANCE_TOKEN_FILE}`);
  } else if (vars.CLEARANCE_INTERNAL_TOKEN !== undefined) {
    token = checkedToken(vars.CLEARANCE_INTERNAL_TOKEN.trim(), "CLEARANCE_INTERNAL_TOKEN");
  } else {
    throw new ConfigError("no token: set CLEARANCE_TOKEN_FILE to a mode 600 file holding core's CLEARANCE_INTERNAL_TOKEN, or set CLEARANCE_INTERNAL_TOKEN");
  }

  const person = vars.CLEARANCE_PERSON ?? null;
  if (person !== null && !/^[A-Za-z0-9_.-]{1,64}$/.test(person)) throw new ConfigError("CLEARANCE_PERSON must be a team id, as in policy/team.yaml");

  const timeout = vars.CLEARANCE_CONNECTOR_TIMEOUT_MS === undefined ? DEFAULT_TIMEOUT_MS : Number(vars.CLEARANCE_CONNECTOR_TIMEOUT_MS);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) throw new ConfigError("CLEARANCE_CONNECTOR_TIMEOUT_MS must be whole milliseconds from 100 to 60000");

  return { coreUrl, token, person, timeoutMs: timeout };
}
