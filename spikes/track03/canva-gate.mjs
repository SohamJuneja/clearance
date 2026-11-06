#!/usr/bin/env node
/**
 * Track 03's go-or-drop question, for whoever holds a Canva developer app: does Canva's MCP server answer a third
 * party's token at all? #1133 reported `500` on `initialize` for developer apps, and if that still holds nobody can
 * record the video the issue requires, so this comes before any other effort.
 *
 * It signs in the way Switch's OAuth adapter does (core/switch_core/connections/adapters/oauth.py): the server's 401
 * names its metadata, PKCE S256, `resource` on the authorize and token requests, the client as HTTP Basic because
 * Canva's metadata lists no methods, and redirects on Switch Console's loopback callback. So a failure here is a
 * failure for Switch too. It prints what to record and never prints a token. It writes nothing to disk.
 *
 *   node spikes/track03/canva-gate.mjs --client <file>                      least scopes, read and write
 *   node spikes/track03/canva-gate.mjs --client <file> --scopes all         every scope the server lists
 *   node spikes/track03/canva-gate.mjs --client <file> --scopes read        the read level alone
 *   node spikes/track03/canva-gate.mjs --client <file> --measure            also refresh and revoke, which ends the sign-in
 *   node spikes/track03/canva-gate.mjs --client <file> --scopes read --call <tool> '<json args>'
 *
 * <file> holds {"client_id": "...", "client_secret": "..."} and should stay outside any repo.
 * Exit 0 means go, 2 means Canva's MCP server refused, 3 means the sign-in itself failed.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const LEAST_READ = ["design:meta:read", "design:content:read"];
const LEAST_WRITE = [...LEAST_READ, "design:content:write"];
const PORT = 39231;
const CALLBACK = `http://127.0.0.1:${PORT}/switch-services/callback`;
const MCP_URL = process.env.CANVA_GATE_MCP_URL ?? "https://api.canva.com/connect/v1/mcp";
const IDENTITY_URL = process.env.CANVA_GATE_IDENTITY_URL ?? "https://api.canva.com/rest/v1/users/me";
const REVOKE_URL = process.env.CANVA_GATE_REVOKE_URL ?? "https://api.canva.com/rest/v1/oauth/revoke";
const SIGN_IN_WAIT_MS = Number(process.env.CANVA_GATE_WAIT_MS ?? 5 * 60_000);
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "switch", version: "1.0.0" } },
};

const { values, positionals } = parseArgs({
  options: {
    client: { type: "string" },
    scopes: { type: "string", default: "write" },
    measure: { type: "boolean", default: false },
    call: { type: "string" },
  },
  allowPositionals: true,
});
if (!values.client || !["read", "write", "all"].includes(values.scopes)) {
  console.error("usage: canva-gate.mjs --client <file> [--scopes read|write|all] [--measure] [--call <tool> '<json args>']");
  process.exit(64);
}

const client = JSON.parse(readFileSync(values.client, "utf8"));
if (!client.client_id || !client.client_secret) {
  console.error(`${values.client} needs client_id and client_secret`);
  process.exit(64);
}

/** Everything shown goes through here, so that nothing secret can reach the screen, or a recording of it. */
const secrets = new Set([client.client_secret]);
const clean = (text) => {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join("<hidden>");
  return out;
};
const say = (line = "") => console.log(clean(line));
const record = (name, value) => say(`RECORD  ${name}: ${value}`);
const finish = (code, verdict) => {
  say();
  say(verdict);
  process.exit(code);
};

const b64url = (buffer) => buffer.toString("base64url");
const basic = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}`;

async function metadata() {
  const anonymous = await fetch(MCP_URL, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(INITIALIZE) });
  const named = /resource_metadata="([^"]+)"/.exec(anonymous.headers.get("www-authenticate") ?? "")?.[1];
  if (anonymous.status !== 401 || !named) finish(3, `STOP: expected a 401 naming its metadata, and got HTTP ${anonymous.status}. Canva has changed something.`);
  const resource = await (await fetch(named)).json();
  const issuer = new URL(resource.authorization_servers[0]);
  const server = await (await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`)).json();
  return { resource, server };
}

/** Prints the address to open, then waits for Canva to send the browser back. */
function signIn(server, scopes) {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const url = new URL(server.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    scope: scopes.join(" "),
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    resource: MCP_URL,
  }).toString();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(3, "STOP: nobody came back from Canva within 5 minutes."), SIGN_IN_WAIT_MS);
    const listener = createServer((req, res) => {
      const back = new URL(req.url, CALLBACK);
      if (back.pathname !== "/switch-services/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end("You can close this tab and go back to the terminal.");
      clearTimeout(timer);
      listener.close();
      if (back.searchParams.get("state") !== state) finish(3, "STOP: the state didn't match, so this sign-in was thrown away.");
      const error = back.searchParams.get("error");
      if (error) finish(3, `STOP: Canva refused the sign-in: ${error} ${back.searchParams.get("error_description") ?? ""}`);
      resolve({ code: back.searchParams.get("code"), verifier });
    });
    listener.on("error", (error) => finish(3, `STOP: can't listen on port ${PORT}: ${error.message}`));
    listener.listen(PORT, "127.0.0.1", () => {
      say(`Open this in a browser and accept:\n\n${url}\n`);
    });
  });
}

async function tokenRequest(server, params) {
  const res = await fetch(server.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic, accept: "application/json" },
    body: new URLSearchParams({ ...params, resource: MCP_URL }).toString(),
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Reported by status alone.
  }
  if (body.access_token) secrets.add(body.access_token);
  if (body.refresh_token) secrets.add(body.refresh_token);
  return { status: res.status, body };
}

/** A streamable HTTP answer is JSON, or server-sent events holding it. */
function parseMcp(text) {
  const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).at(-1);
  try {
    return JSON.parse(data ?? text);
  } catch {
    return null;
  }
}

async function mcp(token, session, body) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { ...MCP_HEADERS, authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-06-18", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, session: res.headers.get("mcp-session-id"), text, json: parseMcp(text) };
}

async function listTools(token) {
  const hello = await mcp(token, null, INITIALIZE);
  if (hello.status !== 200 || hello.json?.error) return { hello };
  await mcp(token, hello.session, { jsonrpc: "2.0", method: "notifications/initialized" });
  const listed = await mcp(token, hello.session, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  return { hello, listed, tools: listed.json?.result?.tools?.map((tool) => tool.name) ?? null };
}

const pathValue = (body, path) => path.split(".").reduce((value, key) => value?.[key], body);

// ── Sign in ──────────────────────────────────────────────────────────────────
const { resource, server } = await metadata();
const scopes = values.scopes === "all" ? resource.scopes_supported : values.scopes === "read" ? LEAST_READ : LEAST_WRITE;
say(`Scopes asked for (${values.scopes}): ${scopes.join(" ")}`);
const { code, verifier } = await signIn(server, scopes);
const token = await tokenRequest(server, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK });
if (!token.body.access_token) {
  finish(3, `STOP: the token request answered HTTP ${token.status}: ${token.body.error ?? "no token"} ${token.body.error_description ?? ""}`);
}
say();
record("sign-in through the loopback redirect", "worked");
record("expires_in (token.max_lifetime)", token.body.expires_in ?? "not given");
record("scopes granted", token.body.scope ?? "not given");
record("refresh token returned", token.body.refresh_token ? "yes" : "NO");

// ── Who it says this is ──────────────────────────────────────────────────────
const who = await fetch(IDENTITY_URL, { headers: { authorization: `Bearer ${token.body.access_token}` } });
const whoBody = await who.json().catch(() => ({}));
record("identity call with this token", `HTTP ${who.status}`);
record("team_user.user_id present", typeof pathValue(whoBody, "team_user.user_id") === "string" ? "yes" : "NO");

// ── The question ─────────────────────────────────────────────────────────────
const first = await listTools(token.body.access_token);
record("MCP initialize", `HTTP ${first.hello.status}`);
if (first.hello.status !== 200 || first.hello.json?.error) {
  say(`        said: ${clean(first.hello.text).slice(0, 200)}`);
  finish(
    2,
    values.scopes === "all"
      ? "DROP: Canva's MCP server refused this app even with every scope it lists. Nobody can record the required video with this app. Don't build further: see \"If the gate fails\" in docs/track03.md."
      : "NOT YET: refused with the least scopes. Run again with --scopes all, to tell a missing scope from a block on the app. If that also fails, this is a drop.",
  );
}
record("tools/list", `HTTP ${first.listed.status}`);
record("tools", first.tools ? first.tools.join(", ") : "none readable");

// ── A level is only real if Canva refuses a write ────────────────────────────
if (values.call) {
  const args = positionals[0] ? JSON.parse(positionals[0]) : {};
  const called = await mcp(token.body.access_token, first.hello.session, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: values.call, arguments: args } });
  const refused = called.status !== 200 || called.json?.error || called.json?.result?.isError;
  record(`calling ${values.call} with --scopes ${values.scopes}`, refused ? "REFUSED" : "IT WORKED");
  say(`        said: ${clean(called.text).slice(0, 240)}`);
}

// ── What the entry's comments must state ─────────────────────────────────────
if (values.measure) {
  if (token.body.refresh_token) {
    const renewed = await tokenRequest(server, { grant_type: "refresh_token", refresh_token: token.body.refresh_token });
    record("refresh", `HTTP ${renewed.status}`);
    const rotated = Boolean(renewed.body.refresh_token) && renewed.body.refresh_token !== token.body.refresh_token;
    record("refresh returned a new refresh token (auth.refresh: rotating)", rotated ? "yes" : "NO");
    const again = await tokenRequest(server, { grant_type: "refresh_token", refresh_token: token.body.refresh_token });
    record("the old refresh token, used again", `HTTP ${again.status}`);
    const fresh = renewed.body.access_token ?? token.body.access_token;
    record("MCP with the new access token", `HTTP ${(await listTools(fresh)).hello.status}`);
    record("MCP with the old access token", `HTTP ${(await listTools(token.body.access_token)).hello.status}`);

    const revoked = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic },
      body: new URLSearchParams({ token: renewed.body.refresh_token ?? token.body.refresh_token }).toString(),
    });
    record(`revoke at ${REVOKE_URL}`, `HTTP ${revoked.status}`);
    record("MCP after revoking", `HTTP ${(await listTools(fresh)).hello.status}`);
    const afterRefresh = await tokenRequest(server, { grant_type: "refresh_token", refresh_token: renewed.body.refresh_token ?? token.body.refresh_token });
    record("refresh after revoking", `HTTP ${afterRefresh.status}`);
  } else {
    record("refresh and revoke", "not measured: no refresh token came back");
  }
}

finish(0, "GO: Canva's MCP server answered this app. Carry on with the hand QA in docs/track03.md.");
