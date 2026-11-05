import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ActionSchema } from "@clearance/contracts";
import {
  ACME_ENDPOINTS,
  ADMIN_KEY,
  ALL_ENDPOINTS,
  HELD_TEXT,
  INTERNAL_TOKEN,
  MERGE_ENDPOINT,
  TOK_ALL,
  TOK_READER,
  bearer,
  buildGateServer,
  gateConfig,
  holdFor,
  rawRequest,
  startFakeAcme,
  startFakeCore,
  tempDb,
  type FakeAcme,
  type FakeCore,
  type TempDb,
} from "./helpers.js";

let core: FakeCore;
let acme: FakeAcme;
let db: TempDb;
let gate: FastifyInstance;

beforeEach(async () => {
  core = await startFakeCore();
  acme = await startFakeAcme();
  db = tempDb();
  gate = buildGateServer(gateConfig(core, acme, db));
  await gate.ready();
});

afterEach(async () => {
  await gate.close();
  await core.close();
  await acme.close();
  db.cleanup();
});

describe.each(ALL_ENDPOINTS)("$method $url ($name)", (ep) => {
  const send = (headers: Record<string, string> = {}) =>
    gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: { ...bearer(TOK_ALL), ...headers },
    });

  it("sends core a gate Action whose identity comes from the token", async () => {
    await send({ "x-clearance-room": "!room", "x-clearance-thread": "thread-1" });
    expect(core.checks).toHaveLength(1);
    const { action, authorization } = core.checks[0]!;
    expect(authorization).toBe(`Bearer ${INTERNAL_TOKEN}`);
    expect(ActionSchema.safeParse(action).success).toBe(true);
    expect(action.source).toBe("gate");
    expect(action.vendor).toBe("gate");
    expect(action.kind).toBe("business");
    expect(action.agent).toEqual({ name: "ops-agent" });
    expect(action.business).toEqual({ endpoint: ep.endpoint, args: ep.args });
    expect(action.session).toEqual({ switchRoomId: "!room", threadId: "thread-1" });
    expect(action.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(action.at))).toBe(false);
  });

  it("allow executes now with the custody key and returns the result", async () => {
    const res = await send();
    expect(res.statusCode).toBeLessThan(300);
    const upstream = acme.calls.find(
      (c) => c.url === ep.upstreamUrl && c.method === ep.upstreamMethod,
    );
    expect(upstream).toBeDefined();
    expect(upstream!.headers["x-acme-admin-key"]).toBe(ADMIN_KEY);
    if (ep.method === "POST") expect(upstream!.body).toEqual(ep.upstreamBody ?? ep.args);
  });

  it("hold stores the call and answers 202 with core's reason verbatim", async () => {
    core.decide(holdFor("CLR-0042"));
    const res = await send();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      status: "pending",
      request_id: "CLR-0042",
      poll_after_s: 15,
      message: HELD_TEXT,
    });
    expect(acme.mutations()).toHaveLength(0);
    expect(acme.calls.filter((c) => c.url === ep.upstreamUrl)).toHaveLength(0);
  });

  it("deny answers 403 and touches nothing", async () => {
    core.decide(() => ({ decision: "deny", reason: "protected" }));
    const res = await send();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "denied", message: "protected" });
    expect(acme.calls.filter((c) => c.url === ep.upstreamUrl)).toHaveLength(0);
  });

  it("refuses a missing or wrong token without asking core", async () => {
    const noToken = await gate.inject({ method: ep.method, url: ep.url, payload: ep.payload });
    const wrong = await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: bearer("nope"),
    });
    expect(noToken.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(core.checks).toHaveLength(0);
    expect(acme.calls).toHaveLength(0);
  });
});

describe("Acme pass-through details", () => {
  it("forwards Acme's status and body on an allowed write", async () => {
    const ep = ACME_ENDPOINTS[0]!;
    const res = await gate.inject({
      method: "POST",
      url: ep.url,
      payload: ep.payload,
      headers: bearer(TOK_ALL),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "re_7731", amount: 4000 });
  });

  it("forwards an Acme 4xx on an allowed write", async () => {
    acme.respond(() => ({ status: 422, body: { error: "amount exceeds order" } }));
    const ep = ACME_ENDPOINTS[0]!;
    const res = await gate.inject({
      method: "POST",
      url: ep.url,
      payload: ep.payload,
      headers: bearer(TOK_ALL),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "amount exceeds order" });
  });

  it("answers 502 when core allowed but Acme is unreachable", async () => {
    await acme.close();
    const ep = ACME_ENDPOINTS[0]!;
    const res = await gate.inject({
      method: "POST",
      url: ep.url,
      payload: ep.payload,
      headers: bearer(TOK_ALL),
    });
    expect(res.statusCode).toBe(502);
    acme = await startFakeAcme();
  });

  it("does not route other verbs or unlisted write paths", async () => {
    for (const [method, url] of [
      ["POST", "/acme/admin/reset"],
      ["PUT", "/acme/refunds"],
      ["PATCH", "/acme/refunds"],
      ["POST", "/acme/records/customers/cus_1"],
      ["DELETE", "/acme/refunds"],
    ] as const) {
      const res = await gate.inject({ method, url, payload: {}, headers: bearer(TOK_ALL) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(acme.calls).toHaveLength(0);
    expect(core.checks).toHaveLength(0);
  });
});

describe("refund enrichment", () => {
  const refund = (payload: Record<string, unknown>) =>
    gate.inject({ method: "POST", url: "/acme/refunds", payload, headers: bearer(TOK_ALL) });
  const FILLED = {
    order_id: "A-1931",
    amount: 4000,
    customer_id: "cus_8812",
    destination: "meera.old@okhdfcbank",
  };

  it("fills the customer and destination, so omitting them cannot dodge the rules that read them", async () => {
    const res = await refund({ order_id: "A-1931", amount: 4000 });
    expect(res.statusCode).toBe(201);
    expect(core.checks[0]!.action.business!.args).toEqual(FILLED);
    expect(acme.mutations()[0]!.body).toEqual(FILLED);
  });

  it("holds the filled-in call, so what was approved is what runs", async () => {
    core.decide(holdFor("CLR-0090"));
    await refund({ order_id: "A-1931", amount: 4000 });
    await gate.inject({
      method: "POST",
      url: "/internal/execute/CLR-0090",
      payload: { call_hash: "hash-CLR-0090" },
      headers: bearer(INTERNAL_TOKEN),
    });
    expect(acme.mutations()[0]!.body).toEqual(FILLED);
  });

  it("keeps what the agent did send, and reads nothing it does not need", async () => {
    await refund({
      order_id: "A-1931",
      amount: 4000,
      customer_id: "cus_other",
      destination: "new@okaxis",
    });
    expect(core.checks[0]!.action.business!.args).toEqual({
      order_id: "A-1931",
      amount: 4000,
      customer_id: "cus_other",
      destination: "new@okaxis",
    });
    expect(acme.calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  it("fills only the destination when the customer was given", async () => {
    await refund({ order_id: "A-1931", amount: 4000, customer_id: "cus_8812" });
    expect(core.checks[0]!.action.business!.args).toEqual(FILLED);
    expect(acme.calls.filter((c) => c.url.startsWith("/orders"))).toHaveLength(0);
  });

  it("leaves args alone when the order is unknown, so core sees the gap and holds", async () => {
    await refund({ order_id: "A-404", amount: 4000 });
    expect(core.checks[0]!.action.business!.args).toEqual({ order_id: "A-404", amount: 4000 });
  });

  it("leaves the destination out when the customer has none", async () => {
    await refund({ order_id: "A-1931", amount: 4000, customer_id: "cus_nodest" });
    expect(core.checks[0]!.action.business!.args).toEqual({
      order_id: "A-1931",
      amount: 4000,
      customer_id: "cus_nodest",
    });
  });

  it("still asks core when Acme cannot be read, and core sees the gap", async () => {
    await acme.close();
    core.decide(holdFor("CLR-0091"));
    const res = await refund({ order_id: "A-1931", amount: 4000 });
    expect(res.statusCode).toBe(202);
    expect(core.checks[0]!.action.business!.args).toEqual({ order_id: "A-1931", amount: 4000 });
    acme = await startFakeAcme();
  });

  it("does not touch other operations", async () => {
    await gate.inject({
      method: "POST",
      url: "/acme/payouts/destinations",
      payload: { customer_id: "cus_8812", upi: "x@y" },
      headers: bearer(TOK_ALL),
    });
    expect(acme.calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });
});

describe("input validation at the boundary", () => {
  const refund = (payload: Record<string, unknown>) =>
    gate.inject({ method: "POST", url: "/acme/refunds", payload, headers: bearer(TOK_ALL) });

  it.each([
    ["amount as a string", { order_id: "A-1", amount: "40000" }],
    ["fractional amount", { order_id: "A-1", amount: 40.5 }],
    ["negative amount", { order_id: "A-1", amount: -5 }],
    ["zero amount", { order_id: "A-1", amount: 0 }],
    ["amount as an array", { order_id: "A-1", amount: [40000] }],
    // Acme requires an order, so without one a person would approve a call that cannot run.
    ["no order", { customer_id: "cus_8812", amount: 100 }],
    ["agent name in the body", { order_id: "A-1", amount: 100, agent: { name: "sam" } }],
    ["unknown field", { order_id: "A-1", amount: 100, approved_by: "sam" }],
  ])("rejects %s with 400 and never asks core", async (_name, payload) => {
    const res = await refund(payload);
    expect(res.statusCode).toBe(400);
    expect(core.checks).toHaveLength(0);
    expect(acme.mutations()).toHaveLength(0);
  });

  it.each([
    ["no subject", { to: "a@b.in", body: "x" }],
    ["no body", { to: "a@b.in", subject: "x" }],
    ["two recipients", { to: "a@b.in,c@d.in", subject: "x", body: "y" }],
    ["no recipient", { subject: "x", body: "y" }],
  ])("rejects an email with %s before anyone is asked to approve it", async (_name, payload) => {
    const res = await gate.inject({
      method: "POST",
      url: "/acme/emails",
      payload,
      headers: bearer(TOK_ALL),
    });
    expect(res.statusCode).toBe(400);
    expect(core.checks).toHaveLength(0);
  });

  it("defaults email attachments to an empty list, so core always sees one", async () => {
    await gate.inject({
      method: "POST",
      url: "/acme/emails",
      payload: { to: "a@b.in", subject: "x", body: "y" },
      headers: bearer(TOK_ALL),
    });
    expect(core.checks[0]!.action.business!.args).toEqual({
      to: "a@b.in",
      subject: "x",
      body: "y",
      attachments: [],
    });
  });

  it("rejects malformed JSON", async () => {
    const res = await gate.inject({
      method: "POST",
      url: "/acme/refunds",
      payload: "{not json",
      headers: { ...bearer(TOK_ALL), "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(core.checks).toHaveLength(0);
  });

  it("rejects a prototype-poisoning body", async () => {
    const res = await gate.inject({
      method: "POST",
      url: "/acme/refunds",
      payload: '{"order_id":"A-1","amount":1,"__proto__":{"admin":true}}',
      headers: { ...bearer(TOK_ALL), "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(core.checks).toHaveLength(0);
  });

  it.each([
    "/acme/records/..%2Fadmin/reset",
    "/acme/records/%2e%2e/reset",
    "/acme/records/customers/..",
    "/acme/records/customers/%2e%2e",
    "/acme/records/cus%2Ftomers/1",
  ])("rejects traversal in delete path %s", async (url) => {
    const base = await gate.listen({ port: 0, host: "127.0.0.1" });
    const res = await rawRequest(base, "DELETE", url, bearer(TOK_ALL));
    expect(res.status).toBe(400);
    expect(core.checks).toHaveLength(0);
    expect(acme.calls).toHaveLength(0);
  });

  it("ignores absurd session hints rather than passing them on", async () => {
    await gate.inject({
      method: "POST",
      url: "/acme/refunds",
      payload: { order_id: "A-1931", customer_id: "c", amount: 1 },
      headers: { ...bearer(TOK_ALL), "x-clearance-room": "r".repeat(5000) },
    });
    expect(core.checks[0]!.action.session).toBeUndefined();
  });
});

describe("GET /acme/* read pass-through", () => {
  it("passes reads through without asking core, query string intact", async () => {
    const res = await gate.inject({
      method: "GET",
      url: "/acme/customers?query=meera%20k",
      headers: bearer(TOK_READER),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: "cus_8812", name: "Meera K." }]);
    expect(core.checks).toHaveLength(0);
    expect(acme.calls[0]!.url).toBe("/customers?query=meera%20k");
    expect(acme.calls[0]!.headers["x-acme-admin-key"]).toBe(ADMIN_KEY);
  });

  it("passes Acme's 404 through", async () => {
    const res = await gate.inject({
      method: "GET",
      url: "/acme/orders/nope",
      headers: bearer(TOK_READER),
    });
    expect(res.statusCode).toBe(404);
  });

  it("requires a token", async () => {
    const res = await gate.inject({ method: "GET", url: "/acme/orders/A-1931" });
    expect(res.statusCode).toBe(401);
    expect(acme.calls).toHaveLength(0);
  });

  it("answers 502 when Acme is down", async () => {
    await acme.close();
    const res = await gate.inject({
      method: "GET",
      url: "/acme/orders/A-1931",
      headers: bearer(TOK_READER),
    });
    expect(res.statusCode).toBe(502);
    acme = await startFakeAcme();
  });

  it.each([
    "/acme/../admin/reset",
    "/acme/%2e%2e/admin",
    "/acme/orders/..%2F..%2Fstate",
    "/acme/./orders",
    "/acme/orders/%5c..%5cstate",
    "/acme/orders/%0d%0ax-evil:1",
    "/acme/orders/%zz",
  ])("refuses a bad read path %s", async (url) => {
    const base = await gate.listen({ port: 0, host: "127.0.0.1" });
    const res = await rawRequest(base, "GET", url, bearer(TOK_READER));
    expect(res.status).toBe(400);
    expect(acme.calls).toHaveLength(0);
  });

  it("cannot be steered to another host with a // path", async () => {
    const other = await startFakeAcme();
    const { host } = new URL(other.url);
    const base = await gate.listen({ port: 0, host: "127.0.0.1" });
    const res = await rawRequest(base, "GET", `/acme//${host}/orders/A-1931`, bearer(TOK_READER));
    expect(res.status).toBe(400);
    expect(other.calls).toHaveLength(0);
    expect(acme.calls).toHaveLength(0);
    await other.close();
  });
});

describe("POST /github/merge (fake GitHub through Acme)", () => {
  const merge = (payload: Record<string, unknown>) =>
    gate.inject({ method: "POST", url: MERGE_ENDPOINT.url, payload, headers: bearer(TOK_ALL) });

  it("lands in Acme, so /state reports it, and returns Acme's answer", async () => {
    const res = await merge({ repo: "acme/acme-mini-app", pr: 42 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ merged: true, number: 42, repo: "acme/acme-mini-app" });
    expect(acme.mutations()).toHaveLength(1);
    expect(acme.mutations()[0]).toMatchObject({
      method: "POST",
      url: "/pulls/42/merge",
      body: { repo: "acme/acme-mini-app" },
    });
    expect(acme.mutations()[0]!.headers["x-acme-admin-key"]).toBe(ADMIN_KEY);
  });

  it("passes on Acme's refusal to merge twice", async () => {
    await merge({ repo: "acme/acme-mini-app", pr: 42 });
    const again = await merge({ repo: "acme/acme-mini-app", pr: 42 });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "already_merged" });
  });

  it("answers 404 for a pull request that does not exist", async () => {
    const res = await merge({ repo: "acme/acme-mini-app", pr: 9999 });
    expect(res.statusCode).toBe(404);
  });

  it("answers 404 when the pull request belongs to another repo", async () => {
    const res = await merge({ repo: "acme/other", pr: 42 });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a pr that is not a positive integer", async () => {
    const res = await merge({ repo: "acme/acme-mini-app", pr: "42" });
    expect(res.statusCode).toBe(400);
    expect(core.checks).toHaveLength(0);
  });
});

describe("GET /pending/:id", () => {
  async function hold(id: string) {
    core.decide(holdFor(id));
    await gate.inject({
      method: "POST",
      url: "/acme/refunds",
      payload: { order_id: "A-1931", customer_id: "c", amount: 40000 },
      headers: bearer(TOK_ALL),
    });
  }

  it("asks core with the hook token and reports pending without evidence", async () => {
    await hold("CLR-0042");
    core.requests.set("CLR-0042", {
      status: 200,
      body: JSON.stringify({ id: "CLR-0042", state: "ROUTED", evidence: { x: 1 } }),
    });
    const res = await gate.inject({
      method: "GET",
      url: "/pending/CLR-0042",
      headers: bearer(TOK_ALL),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "pending",
      request_id: "CLR-0042",
      state: "ROUTED",
      poll_after_s: 15,
    });
    expect(res.json().evidence).toBeUndefined();
    expect(core.requestAuth()).toBe(`Bearer ${INTERNAL_TOKEN}`);
  });

  it.each([
    ["APPROVED", "approved"],
    ["DENIED", "denied"],
    ["EXPIRED", "expired"],
    ["CANCELLED", "cancelled"],
    ["EXECUTED", "executed"],
    ["GRANTED", "approved"],
    ["CONSUMED", "executed"],
    ["VOIDED", "denied"],
  ])("maps core state %s to %s", async (state, status) => {
    await hold("CLR-0043");
    core.requests.set("CLR-0043", { status: 200, body: JSON.stringify({ state }) });
    const res = await gate.inject({
      method: "GET",
      url: "/pending/CLR-0043",
      headers: bearer(TOK_ALL),
    });
    expect(res.json()).toMatchObject({ status, state });
  });

  it("includes the stored result once the gate has executed the call", async () => {
    await hold("CLR-0044");
    await gate.inject({
      method: "POST",
      url: "/internal/execute/CLR-0044",
      payload: { call_hash: "hash-CLR-0044" },
      headers: bearer(INTERNAL_TOKEN),
    });
    core.requests.set("CLR-0044", { status: 200, body: JSON.stringify({ state: "EXECUTED" }) });
    const res = await gate.inject({
      method: "GET",
      url: "/pending/CLR-0044",
      headers: bearer(TOK_ALL),
    });
    expect(res.json()).toMatchObject({ status: "executed", result: { id: "re_7731" } });
  });

  it("does not show one agent another agent's request", async () => {
    await hold("CLR-0045");
    core.requests.set("CLR-0045", { status: 200, body: JSON.stringify({ state: "HELD" }) });
    const res = await gate.inject({
      method: "GET",
      url: "/pending/CLR-0045",
      headers: bearer(TOK_READER),
    });
    expect(res.statusCode).toBe(404);
  });

  it("answers 404 when core does not know the id", async () => {
    const res = await gate.inject({
      method: "GET",
      url: "/pending/CLR-9999",
      headers: bearer(TOK_ALL),
    });
    expect(res.statusCode).toBe(404);
  });

  it("answers 503 on an unusable core answer", async () => {
    core.requests.set("CLR-0046", { status: 200, body: "{not json" });
    const res = await gate.inject({
      method: "GET",
      url: "/pending/CLR-0046",
      headers: bearer(TOK_ALL),
    });
    expect(res.statusCode).toBe(503);
    core.requests.set("CLR-0047", { status: 500, body: "{}" });
    const res2 = await gate.inject({
      method: "GET",
      url: "/pending/CLR-0047",
      headers: bearer(TOK_ALL),
    });
    expect(res2.statusCode).toBe(503);
  });

  it("requires a token", async () => {
    const res = await gate.inject({ method: "GET", url: "/pending/CLR-0042" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /health", () => {
  it("needs no token and reveals nothing", async () => {
    const res = await gate.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
