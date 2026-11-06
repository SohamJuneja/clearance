import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { onTestFinished } from "vitest";
import type { Action, CheckResponse } from "@clearance/contracts";
import { buildGateServer, type GateConfig } from "../src/index.js";

export const ADMIN_KEY = "acme-admin-key-super-secret-value";
export const INTERNAL_TOKEN = "internal-token-for-core";
export const HELD_TEXT =
  "HELD CLR-0042: refunds over ₹10,000 need finance approval. Do not try another way.";

export const TOK_ALL = "tok-all-classes-agent";
export const TOK_REFUNDS = "tok-refunds-agent-only";
export const TOK_READER = "tok-reader-no-classes";

export const AGENT_TOKENS: GateConfig["agentTokens"] = {
  [TOK_ALL]: {
    agent: "ops-agent",
    classes: ["refund", "deploy", "customer_email", "payout_change", "delete", "merge"],
  },
  [TOK_REFUNDS]: { agent: "refunds-agent", classes: ["refund"] },
  [TOK_READER]: { agent: "reader", classes: [] },
};

export type Recorded = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

type Reply = {
  status: number;
  body?: unknown;
  delayMs?: number;
  contentType?: string;
  location?: string;
};
type Responder = (req: Recorded) => Reply;

/** Mirrors the routes and shapes of packages/acme/src/server.ts. */
function defaultAcme(req: Recorded, merged: Set<string>): Reply {
  const path = req.url.split("?")[0] ?? "";
  if (req.method === "POST" && path.startsWith("/pulls/") && path.endsWith("/merge")) {
    const repo = (req.body as { repo?: string } | null)?.repo;
    if (path !== "/pulls/42/merge" || (repo !== undefined && repo !== "acme/acme-mini-app")) {
      return { status: 404, body: { error: "not_found", what: "pull" } };
    }
    if (merged.has(path)) return { status: 409, body: { error: "already_merged", number: 42 } };
    merged.add(path);
    return {
      status: 201,
      body: { merged: true, number: 42, repo: "acme/acme-mini-app", sha: "abc123" },
    };
  }
  if (req.method === "GET") {
    if (path === "/orders/A-1931") {
      return {
        status: 200,
        body: { id: "A-1931", customer_id: "cus_8812", total: 4000, status: "paid", items: [] },
      };
    }
    if (path === "/customers/cus_8812") {
      return {
        status: 200,
        body: { id: "cus_8812", name: "Meera K.", default_destination: "meera.old@okhdfcbank" },
      };
    }
    if (path === "/customers/cus_nodest") return { status: 200, body: { id: "cus_nodest" } };
    if (path === "/files/customers.csv") {
      return {
        status: 200,
        body: { name: "customers.csv", rows: 3000, bytes: 90000, synthetic: true },
      };
    }
    if (path === "/customers") return { status: 200, body: [{ id: "cus_8812", name: "Meera K." }] };
    if (path === "/destinations/meera.k%40okaxis") {
      return {
        status: 200,
        body: { id: "meera.k@okaxis", customer_id: "cus_8812", age_hours: 0.1 },
      };
    }
    if (path === "/ci/v2.14.0")
      return { status: 200, body: { version: "v2.14.0", status: "failing", failing: ["a"] } };
    if (path === "/services/checkout") {
      return { status: 200, body: { name: "checkout", live_version: "v2.13.2", owner: "alex" } };
    }
    if (path === "/tickets/T-77") return { status: 200, body: { id: "T-77", order_id: "A-1931" } };
    if (path === "/pulls/42") {
      return {
        status: 200,
        body: { number: 42, repo: "acme/acme-mini-app", author: "coder", changes: 12, files: [] },
      };
    }
    return { status: 404, body: { error: "not found" } };
  }
  if (req.method === "POST" && path === "/refunds") {
    return { status: 201, body: { id: "re_7731", ...(req.body as object) } };
  }
  if (req.method === "POST") return { status: 200, body: { ok: true, echoed: req.body } };
  if (req.method === "DELETE") return { status: 200, body: { deleted: path } };
  return { status: 405, body: { error: "method" } };
}

export type FakeAcme = {
  url: string;
  calls: Recorded[];
  mutations: () => Recorded[];
  respond: (responder: Responder | null) => void;
  close: () => Promise<void>;
};

export async function startFakeAcme(): Promise<FakeAcme> {
  const app: FastifyInstance = Fastify();
  const calls: Recorded[] = [];
  const merged = new Set<string>();
  let responder: Responder | null = null;
  app.all("/*", async (req, reply) => {
    const recorded: Recorded = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
    };
    calls.push(recorded);
    const out = responder ? responder(recorded) : defaultAcme(recorded, merged);
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    if (out.contentType) reply.header("content-type", out.contentType);
    if (out.location) reply.header("location", out.location);
    return reply.status(out.status).send(out.body ?? null);
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    url,
    calls,
    mutations: () => calls.filter((c) => c.method !== "GET"),
    respond: (r) => {
      responder = r;
    },
    close: () => app.close(),
  };
}

type Decider = (action: Action) => CheckResponse | { rawStatus: number; rawBody: string };

export type FakeCore = {
  url: string;
  checks: { action: Action; authorization: string | undefined }[];
  decide: (decider: Decider) => void;
  requests: Map<string, { status: number; body: string }>;
  requestAuth: () => string | undefined;
  close: () => Promise<void>;
};

export const holdFor =
  (requestId: string, callHash = `hash-${requestId}`, reason = HELD_TEXT): Decider =>
  () => ({ decision: "hold", reason, request_id: requestId, call_hash: callHash, class: "refund" });

export async function startFakeCore(): Promise<FakeCore> {
  const app = Fastify();
  const checks: FakeCore["checks"] = [];
  let decider: Decider = () => ({ decision: "allow", reason: "ok" });
  const requests = new Map<string, { status: number; body: string }>();
  let lastRequestAuth: string | undefined;
  app.post("/v1/check", async (req, reply) => {
    const body = req.body as { action: Action };
    checks.push({ action: body.action, authorization: req.headers.authorization });
    const out = decider(body.action);
    if ("rawStatus" in out) {
      return reply
        .status(out.rawStatus)
        .header("content-type", "application/json")
        .send(out.rawBody);
    }
    return reply.status(200).send(out);
  });
  app.get("/v1/requests/:id", async (req, reply) => {
    lastRequestAuth = req.headers.authorization;
    const entry = requests.get((req.params as { id: string }).id);
    if (!entry) return reply.status(404).send({ error: "not found" });
    return reply.status(entry.status).header("content-type", "application/json").send(entry.body);
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    url,
    checks,
    decide: (d) => {
      decider = d;
    },
    requests,
    requestAuth: () => lastRequestAuth,
    close: () => app.close(),
  };
}

/** A port nothing is listening on, for "core is down" and "acme is down". */
export async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${address.port}`;
}

export type TempDb = { path: string; cleanup: () => void };

export function tempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "clearance-gate-"));
  // /tmp is RAM-backed on the demo host. This runs however the test ends, even if an afterEach throws first.
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return {
    path: join(dir, "nested", "gate.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function gateConfig(
  core: { url: string },
  acme: { url: string },
  db: TempDb,
  extra: Partial<GateConfig> = {},
): GateConfig {
  return {
    agentTokens: AGENT_TOKENS,
    coreUrl: core.url,
    acmeUrl: acme.url,
    acmeAdminKey: ADMIN_KEY,
    internalToken: INTERNAL_TOKEN,
    dbPath: db.path,
    ...extra,
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Sends `path` byte for byte. `app.inject` runs URLs through WHATWG URL first, which resolves `..`
 * and `%2e%2e` before the server sees them, so path handling has to be tested over a real socket.
 */
export function rawRequest(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

export type EndpointCase = {
  name: string;
  cls: string;
  method: "POST" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
  upstreamMethod: string;
  upstreamUrl: string;
  endpoint: string;
  args: Record<string, unknown>;
  /** What Acme receives, when that is not `args`. */
  upstreamBody?: Record<string, unknown>;
};

/** Every mutating gate endpoint in the contract that proxies straight to Acme. */
export const ACME_ENDPOINTS: EndpointCase[] = [
  {
    name: "refund",
    cls: "refund",
    method: "POST",
    url: "/acme/refunds",
    payload: {
      order_id: "A-1931",
      customer_id: "cus_8812",
      amount: 4000,
      destination: "meera.k@okaxis",
    },
    upstreamMethod: "POST",
    upstreamUrl: "/refunds",
    endpoint: "POST /acme/refunds",
    args: {
      order_id: "A-1931",
      customer_id: "cus_8812",
      amount: 4000,
      destination: "meera.k@okaxis",
    },
  },
  {
    name: "deploy",
    cls: "deploy",
    method: "POST",
    url: "/acme/deploys",
    payload: { service: "checkout", env: "prod", version: "v2.14.0" },
    upstreamMethod: "POST",
    upstreamUrl: "/deploys",
    endpoint: "POST /acme/deploys",
    args: { service: "checkout", env: "prod", version: "v2.14.0" },
  },
  {
    name: "rollback",
    cls: "deploy",
    method: "POST",
    url: "/acme/rollbacks",
    payload: { service: "checkout", env: "prod" },
    upstreamMethod: "POST",
    upstreamUrl: "/rollbacks",
    endpoint: "POST /acme/rollbacks",
    args: { service: "checkout", env: "prod" },
  },
  {
    name: "email",
    cls: "customer_email",
    method: "POST",
    url: "/acme/emails",
    payload: {
      to: "meera@example.com",
      subject: "Refund",
      body: "Done",
      attachments: ["customers.csv"],
    },
    upstreamMethod: "POST",
    upstreamUrl: "/emails",
    endpoint: "POST /acme/emails",
    args: {
      to: "meera@example.com",
      subject: "Refund",
      body: "Done",
      attachments: ["customers.csv"],
    },
  },
  {
    name: "payout destination",
    cls: "payout_change",
    method: "POST",
    url: "/acme/payouts/destinations",
    payload: { customer_id: "cus_8812", upi: "meera.k@okaxis" },
    upstreamMethod: "POST",
    upstreamUrl: "/payouts/destinations",
    endpoint: "POST /acme/payouts/destinations",
    args: { customer_id: "cus_8812", upi: "meera.k@okaxis" },
  },
  {
    name: "delete record",
    cls: "delete",
    method: "DELETE",
    url: "/acme/records/customers/cus_8812",
    upstreamMethod: "DELETE",
    upstreamUrl: "/records/customers/cus_8812",
    endpoint: "DELETE /acme/records/customers/cus_8812",
    args: { table: "customers", id: "cus_8812" },
  },
];

export const MERGE_ENDPOINT: EndpointCase = {
  name: "merge",
  cls: "merge",
  method: "POST",
  url: "/github/merge",
  payload: { repo: "acme/acme-mini-app", pr: 42 },
  upstreamMethod: "POST",
  upstreamUrl: "/pulls/42/merge",
  endpoint: "POST /github/merge",
  args: { repo: "acme/acme-mini-app", pr: 42 },
  upstreamBody: { repo: "acme/acme-mini-app" },
};

export const ALL_ENDPOINTS: EndpointCase[] = [...ACME_ENDPOINTS, MERGE_ENDPOINT];

export { buildGateServer };
