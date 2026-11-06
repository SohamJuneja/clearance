#!/usr/bin/env node
/**
 * Runs canva-gate.mjs against a stand-in for Canva, so the owner's one sitting with a real app isn't spent finding
 * bugs in the probe. Says nothing about Canva itself. `node spikes/track03/canva-gate.check.mjs`
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCESS = "access-token-value-that-must-not-show";
const REFRESH = "refresh-token-value-that-must-not-show";
const SECRET = "client-secret-value-that-must-not-show";

function standIn({ mcpStatus = () => 200, callRefused = false } = {}) {
  const seen = { authorize: null, tokens: [], revoked: false, refreshes: 0 };
  let base = "";
  let challenge = "";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url, base);
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/mcp") {
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ")) return json(401, {}, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        const message = JSON.parse(raw);
        if (seen.revoked) return json(401, { error: "invalid_token" });
        if (message.method === "initialize") {
          const status = mcpStatus(seen);
          if (status !== 200) return json(status, { error: "internal_error", message: `Unknown error, not ${ACCESS}` });
          return json(200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": "s1" });
        }
        if (message.method === "notifications/initialized") return json(202, {});
        if (message.method === "tools/list") {
          // Server-sent events, the other shape an answer can take.
          res.writeHead(200, { "content-type": "text/event-stream" });
          return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search-designs" }, { name: "edit-design" }] } })}\n\n`);
        }
        if (message.method === "tools/call") {
          return json(200, { jsonrpc: "2.0", id: 3, result: callRefused ? { isError: true, content: [{ type: "text", text: "needs design:content:write" }] } : { content: [] } });
        }
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(200, { authorization_servers: [base], scopes_supported: ["one", "two", "three"] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
      if (url.pathname === "/authorize") {
        seen.authorize = url.searchParams;
        challenge = url.searchParams.get("code_challenge");
        const back = new URL(url.searchParams.get("redirect_uri"));
        back.searchParams.set("code", "the-code");
        back.searchParams.set("state", url.searchParams.get("state"));
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(raw);
        seen.tokens.push({ form, auth: req.headers.authorization });
        if (form.get("grant_type") === "authorization_code") {
          const hashed = createHash("sha256").update(form.get("code_verifier")).digest("base64url");
          if (hashed !== challenge) return json(400, { error: "invalid_grant" });
          return json(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 14400, scope: "one two" });
        }
        seen.refreshes += 1;
        if (seen.refreshes > 1 || seen.revoked) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: `${ACCESS}-2`, refresh_token: `${REFRESH}-2`, expires_in: 14400 });
      }
      if (url.pathname === "/users/me") return json(200, { team_user: { user_id: "stand-in", team_id: "t" } });
      if (url.pathname === "/revoke") {
        seen.revoked = true;
        return json(200, {});
      }
      json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, base, seen });
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "canva-gate-"));
const clientFile = join(dir, "client.json");
writeFileSync(clientFile, JSON.stringify({ client_id: "the-client", client_secret: SECRET }), { mode: 0o600 });

/** Runs the probe, plays the person in the browser, and returns what it said. */
async function run(stand, args = []) {
  const child = spawn(process.execPath, [join(HERE, "canva-gate.mjs"), "--client", clientFile, ...args], {
    env: { ...process.env, CANVA_GATE_MCP_URL: `${stand.base}/mcp`, CANVA_GATE_IDENTITY_URL: `${stand.base}/users/me`, CANVA_GATE_REVOKE_URL: `${stand.base}/revoke`, CANVA_GATE_WAIT_MS: "15000" },
  });
  let out = "";
  let opened = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      out += chunk;
      const url = /^(http\S+\/authorize\S+)$/m.exec(out)?.[1];
      if (url && !opened) {
        opened = true;
        void fetch(url);
      }
    });
  }
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return { code, out };
}

function neverShowsASecret(out) {
  for (const secret of [ACCESS, REFRESH, SECRET]) assert.ok(!out.includes(secret), `the output showed ${secret}`);
}

const checks = [];
const check = (name, body) => checks.push({ name, body });

check("a working server is a go, signed in the way Switch signs in", async () => {
  const stand = await standIn();
  const { code, out } = await run(stand);
  stand.server.close();
  assert.equal(code, 0, out);
  assert.match(out, /^GO:/m);
  assert.match(out, /expires_in \(token\.max_lifetime\): 14400/);
  assert.match(out, /refresh token returned: yes/);
  assert.match(out, /identity call with this token: HTTP 200/);
  assert.match(out, /team_user\.user_id present: yes/);
  assert.match(out, /MCP initialize: HTTP 200/);
  assert.match(out, /tools: search-designs, edit-design/);
  assert.equal(stand.seen.authorize.get("redirect_uri"), "http://127.0.0.1:39231/switch-services/callback");
  assert.equal(stand.seen.authorize.get("code_challenge_method"), "S256");
  assert.equal(stand.seen.authorize.get("resource"), `${stand.base}/mcp`);
  assert.equal(stand.seen.authorize.get("scope"), "design:meta:read design:content:read design:content:write");
  assert.equal(stand.seen.tokens[0].form.get("resource"), `${stand.base}/mcp`);
  assert.match(stand.seen.tokens[0].auth, /^Basic /);
  neverShowsASecret(out);
});

check("a 500 with the least scopes says to try every scope, not to give up yet", async () => {
  const stand = await standIn({ mcpStatus: () => 500 });
  const { code, out } = await run(stand);
  stand.server.close();
  assert.equal(code, 2, out);
  assert.match(out, /^NOT YET:/m);
  assert.match(out, /--scopes all/);
  assert.match(out, /MCP initialize: HTTP 500/);
  neverShowsASecret(out);
});

check("a 500 with every scope is a drop", async () => {
  const stand = await standIn({ mcpStatus: () => 500 });
  const { code, out } = await run(stand, ["--scopes", "all"]);
  stand.server.close();
  assert.equal(code, 2, out);
  assert.match(out, /^DROP:/m);
  assert.equal(stand.seen.authorize.get("scope"), "one two three");
  neverShowsASecret(out);
});

check("--measure records rotation and revocation, and shows no tokens", async () => {
  const stand = await standIn();
  const { code, out } = await run(stand, ["--measure"]);
  stand.server.close();
  assert.equal(code, 0, out);
  assert.match(out, /refresh: HTTP 200/);
  assert.match(out, /new refresh token \(auth\.refresh: rotating\): yes/);
  assert.match(out, /the old refresh token, used again: HTTP 400/);
  assert.match(out, /revoke at .*: HTTP 200/);
  assert.match(out, /MCP after revoking: HTTP 401/);
  assert.match(out, /refresh after revoking: HTTP 400/);
  neverShowsASecret(out);
  assert.ok(!out.includes(`${ACCESS}-2`));
});

check("a read level is shown to be real, or not", async () => {
  const refused = await standIn({ callRefused: true });
  const first = await run(refused, ["--scopes", "read", "--call", "edit-design", "{}"]);
  refused.server.close();
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /calling edit-design with --scopes read: REFUSED/);
  assert.equal(refused.seen.authorize.get("scope"), "design:meta:read design:content:read");

  const allowed = await standIn({ callRefused: false });
  const second = await run(allowed, ["--scopes", "read", "--call", "edit-design", "{}"]);
  allowed.server.close();
  assert.match(second.out, /calling edit-design with --scopes read: IT WORKED/);
});

let failed = 0;
for (const { name, body } of checks) {
  try {
    await body();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${String(error.message).slice(0, 600)}`);
  }
}
rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks.length - failed} of ${checks.length} passed`);
process.exit(failed > 0 ? 1 : 0);
