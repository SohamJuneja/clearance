/**
 * What the setup scripts share: talking to Mattermost and Switch's Gateway as an admin or as a person,
 * and writing private files. Nothing here prints a credential.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = resolve(process.env.CLEARANCE_DATA_DIR ?? join(REPO_ROOT, "data"));
export const SWITCH_ENV_FILE = resolve(process.env.SWITCH_ENV_FILE ?? join(REPO_ROOT, "vendor/switch/.env"));
export const BRIDGE_URL = (process.env.SWITCH_BRIDGE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
export const MATTERMOST_URL = (process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065").replace(/\/$/, "");
export const EMAIL_DOMAIN = "clearance.example";

export function log(step: string): void {
  process.stdout.write(`${step}\n`);
}

export function fail(message: string): never {
  throw new Error(message);
}

/** Only what a dotenv file in Switch's own shape needs. Values never leave this process. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) fail(`Switch env file not found: ${path}. Set SWITCH_ENV_FILE.`);
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export function need(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) fail(`${key} is missing from ${SWITCH_ENV_FILE}`);
  return value;
}

/** A short reason from an error body. Both servers' errors carry `detail` or `message`, neither echoes a credential. */
export function reason(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const detail = record.detail ?? record.message ?? record.id;
    if (typeof detail === "string") return detail.slice(0, 300);
    if (detail !== undefined) return JSON.stringify(detail).slice(0, 300);
  }
  return String(body).slice(0, 300);
}

export type Res = { status: number; body: unknown; headers: Headers };

/**
 * Says something until it's heard, or gives up and returns nothing. A chat bridge can take a moment to start listening
 * for an account that was only just made, and what's said before then is gone: saying it once and waiting never ends.
 */
export async function sayUntilHeard<T>(
  say: () => Promise<void>,
  heard: () => Promise<T | undefined>,
  options: { rounds?: number; checksPerRound?: number; waitMs?: number } = {},
): Promise<T | undefined> {
  const { rounds = 12, checksPerRound = 10, waitMs = 500 } = options;
  for (let round = 0; round < rounds; round++) {
    await say();
    for (let check = 0; check < checksPerRound; check++) {
      await new Promise((done) => setTimeout(done, waitMs));
      const found = await heard();
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export async function call(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; cookie?: string; json?: unknown; connectionId?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.connectionId) headers["x-switch-connection-id"] = opts.connectionId;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: res.status, body, headers: res.headers };
}

export function expectOk(res: Res, what: string): Record<string, unknown> {
  if (res.status < 200 || res.status >= 300) fail(`${what} failed: HTTP ${res.status}: ${reason(res.body)}`);
  return res.body as Record<string, unknown>;
}

// ── Mattermost ───────────────────────────────────────────────────────────────

export async function mattermostLogin(login: string, password: string): Promise<string> {
  const res = await call(MATTERMOST_URL, "POST", "/api/v4/users/login", { json: { login_id: login, password } });
  expectOk(res, `Mattermost login as ${login}`);
  const token = res.headers.get("token");
  if (!token) fail(`Mattermost login as ${login} returned no session token`);
  return token;
}

export async function ensureMattermostAccount(
  adminToken: string,
  teamId: string,
  name: string,
  password: string,
): Promise<string> {
  const email = `${name}@${EMAIL_DOMAIN}`;
  let res = await call(MATTERMOST_URL, "GET", `/api/v4/users/username/${name}`, { token: adminToken });
  if (res.status === 404) {
    res = await call(MATTERMOST_URL, "POST", "/api/v4/users", {
      token: adminToken,
      json: { username: name, email, password, first_name: name[0]!.toUpperCase() + name.slice(1) },
    });
    log(`mattermost: created account ${name}`);
  }
  const userId = String(expectOk(res, `Mattermost account ${name}`).id);
  const joined = await call(MATTERMOST_URL, "POST", `/api/v4/teams/${teamId}/members`, {
    token: adminToken,
    json: { team_id: teamId, user_id: userId },
  });
  expectOk(joined, `joining ${name} to the team`);
  return userId;
}

/** A token is shown once, so a saved one is kept while it still works and a new one minted when it does not. */
export async function ensureAccessToken(
  adminToken: string,
  name: string,
  userId: string,
  existing: string | undefined,
): Promise<string> {
  if (existing) {
    const me = await call(MATTERMOST_URL, "GET", "/api/v4/users/me", { token: existing });
    if (me.status === 200 && (me.body as { id?: string }).id === userId) return existing;
  }
  const res = await call(MATTERMOST_URL, "POST", `/api/v4/users/${userId}/tokens`, {
    token: adminToken,
    json: { description: `clearance demo driver for ${name}` },
  });
  const token = expectOk(res, `personal access token for ${name}`).token;
  if (typeof token !== "string") fail(`personal access token for ${name} came back empty`);
  log(`mattermost: minted access token for ${name}`);
  return token;
}

// ── Switch gateway ───────────────────────────────────────────────────────────

export async function gatewayLogin(email: string, password: string): Promise<string> {
  const res = await call(BRIDGE_URL, "POST", "/gateway/auth/login", { json: { email, password } });
  expectOk(res, `gateway login as ${email}`);
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    if (pair?.startsWith("switch_auth=")) return pair;
  }
  return fail(`gateway login as ${email} set no switch_auth cookie`);
}

export async function ensureSwitchUser(adminCookie: string, name: string, email: string, password: string): Promise<string> {
  const listed = await call(BRIDGE_URL, "GET", "/gateway/users", { cookie: adminCookie });
  expectOk(listed, "listing Switch users");
  const existing = (listed.body as { id: string; email: string }[]).find((user) => user.email === email);
  if (existing) return existing.id;
  const created = await call(BRIDGE_URL, "POST", "/gateway/users", {
    cookie: adminCookie,
    json: { name, email, password, role: "user" },
  });
  log(`switch: created user ${name}`);
  return String(expectOk(created, `creating Switch user ${name}`).id);
}

export type Linked = { id: string; bridge_id: string; external_user_id: string; verified: boolean };

/**
 * Claim then confirm, as the persona. `verify-session` takes the account's own session token as proof,
 * which is what lets this run with no browser and no posted one-time code.
 */
export async function linkAccount(
  cookie: string,
  bridgeId: string,
  name: string,
  mattermostUserId: string,
  password: string,
): Promise<string> {
  const mine = await call(BRIDGE_URL, "GET", "/gateway/auth/me/identities", { cookie });
  expectOk(mine, `reading ${name}'s identities`);
  const found = (mine.body as Linked[]).find(
    (identity) => identity.bridge_id === bridgeId && identity.external_user_id === mattermostUserId,
  );
  if (found?.verified) return found.id;

  // The bridge's adapter may still be starting, and a claim on an unseen account is a 409 until it has.
  let claim: Res | undefined;
  for (let attempt = 0; attempt < 24; attempt++) {
    claim = await call(BRIDGE_URL, "POST", `/gateway/collaborations/${bridgeId}/identities`, {
      cookie,
      json: { external_user_id: mattermostUserId, username: name, expects_confirmation: true },
    });
    if (claim.status !== 409) break;
    await new Promise((done) => setTimeout(done, 2500));
  }
  const identity = expectOk(claim as Res, `claiming Mattermost account ${name}`);
  const identityId = String(identity.id);
  if (identity.link_request === null || identity.link_request === undefined) return identityId;

  const session = await mattermostLogin(name, password);
  try {
    const confirmed = await call(
      BRIDGE_URL,
      "POST",
      `/gateway/collaborations/${bridgeId}/identities/${identityId}/verify-session`,
      { cookie, json: { token: session } },
    );
    expectOk(confirmed, `confirming the link for ${name}`);
  } finally {
    await call(MATTERMOST_URL, "POST", "/api/v4/users/logout", { token: session });
  }
  log(`switch: linked ${name} to its Mattermost account`);
  return identityId;
}

export function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

export function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
