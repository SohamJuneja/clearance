import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ExecuteResultSchema } from "@clearance/contracts";
import {
  ACME_ENDPOINTS,
  ADMIN_KEY,
  ALL_ENDPOINTS,
  INTERNAL_TOKEN,
  MERGE_ENDPOINT,
  TOK_ALL,
  bearer,
  buildGateServer,
  gateConfig,
  holdFor,
  startFakeAcme,
  startFakeCore,
  tempDb,
  type EndpointCase,
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

async function hold(ep: EndpointCase, id: string, g: FastifyInstance = gate) {
  core.decide(holdFor(id));
  const res = await g.inject({
    method: ep.method,
    url: ep.url,
    payload: ep.payload,
    headers: bearer(TOK_ALL),
  });
  expect(res.statusCode).toBe(202);
}

const execute = (id: string, callHash = `hash-${id}`, g: FastifyInstance = gate) =>
  g.inject({
    method: "POST",
    url: `/internal/execute/${id}`,
    payload: { call_hash: callHash },
    headers: bearer(INTERNAL_TOKEN),
  });

const REFUND = ACME_ENDPOINTS[0]!;
const refundCalls = () => acme.calls.filter((c) => c.method === "POST" && c.url === "/refunds");

describe("POST /internal/execute/:requestId", () => {
  it.each(ALL_ENDPOINTS)(
    "executes exactly the stored $name call with the custody key",
    async (ep) => {
      await hold(ep, "CLR-0100");
      const res = await execute("CLR-0100");
      expect(res.statusCode).toBe(200);
      const parsed = ExecuteResultSchema.parse(res.json());
      expect(parsed).toMatchObject({ ok: true, alreadyExecuted: false });
      const upstream = acme.calls.find(
        (c) => c.url === ep.upstreamUrl && c.method === ep.upstreamMethod,
      );
      expect(upstream!.headers["x-acme-admin-key"]).toBe(ADMIN_KEY);
      if (ep.method === "POST") expect(upstream!.body).toEqual(ep.upstreamBody ?? ep.args);
    },
  );

  it("sends the request id as an idempotency key on held calls", async () => {
    await hold(REFUND, "CLR-0101");
    await execute("CLR-0101");
    expect(refundCalls()[0]!.headers["idempotency-key"]).toBe("CLR-0101");
  });

  it("the second call returns the first result and does not execute again", async () => {
    await hold(REFUND, "CLR-0102");
    const first = (await execute("CLR-0102")).json();
    const second = await execute("CLR-0102");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ...first, alreadyExecuted: true });
    expect(first.result).toMatchObject({ id: "re_7731" });
    expect(refundCalls()).toHaveLength(1);
  });

  it("merge exactly once: racing executes merge in Acme once", async () => {
    await hold(MERGE_ENDPOINT, "CLR-0103");
    const results = await Promise.all([
      execute("CLR-0103"),
      execute("CLR-0103"),
      execute("CLR-0103"),
    ]);
    expect(acme.mutations()).toHaveLength(1);
    expect(acme.mutations()[0]).toMatchObject({ method: "POST", url: "/pulls/42/merge" });
    for (const res of results)
      expect(res.json()).toMatchObject({ ok: true, result: { sha: "abc123" } });
  });

  it("racing executes call Acme once; losers get the winner's result", async () => {
    acme.respond((req) => ({ status: 201, body: { id: "re_race", at: req.url }, delayMs: 100 }));
    await hold(REFUND, "CLR-0104");
    const results = await Promise.all(Array.from({ length: 8 }, () => execute("CLR-0104")));
    expect(refundCalls()).toHaveLength(1);
    const bodies = results.map((r) => r.json());
    expect(bodies.filter((b) => b.alreadyExecuted === false)).toHaveLength(1);
    expect(bodies.filter((b) => b.alreadyExecuted === true)).toHaveLength(7);
    for (const body of bodies) {
      expect(body.ok).toBe(true);
      expect(body.result).toMatchObject({ id: "re_race" });
    }
  });

  it("a second gate process on the same database cannot run a call already claimed", async () => {
    const other = buildGateServer(gateConfig(core, acme, db));
    await other.ready();
    acme.respond(() => ({ status: 201, body: { id: "re_1" }, delayMs: 100 }));
    await hold(REFUND, "CLR-0105");
    const [a, b] = await Promise.all([
      execute("CLR-0105"),
      execute("CLR-0105", "hash-CLR-0105", other),
    ]);
    expect(refundCalls()).toHaveLength(1);
    expect([a.json().ok, b.json().ok].filter(Boolean)).toHaveLength(1);
    await other.close();
  });

  it("refuses a call_hash mismatch and executes nothing", async () => {
    await hold(REFUND, "CLR-0106");
    const res = await execute("CLR-0106", "hash-of-a-different-call");
    expect(res.statusCode).toBe(409);
    expect(ExecuteResultSchema.parse(res.json())).toMatchObject({
      ok: false,
      alreadyExecuted: false,
    });
    expect(refundCalls()).toHaveLength(0);
    const ok = await execute("CLR-0106");
    expect(ok.json().ok).toBe(true);
  });

  it("refuses a mismatch even after execution, and leaks no result", async () => {
    await hold(REFUND, "CLR-0107");
    await execute("CLR-0107");
    const res = await execute("CLR-0107", "wrong");
    expect(res.statusCode).toBe(409);
    expect(res.json().result).toBeUndefined();
  });

  it("answers 404 for an unknown request", async () => {
    const res = await execute("CLR-9999");
    expect(res.statusCode).toBe(404);
    expect(ExecuteResultSchema.parse(res.json()).ok).toBe(false);
  });

  it("rejects a body that tries to change the call", async () => {
    await hold(REFUND, "CLR-0108");
    const res = await gate.inject({
      method: "POST",
      url: "/internal/execute/CLR-0108",
      payload: { call_hash: "hash-CLR-0108", args: { amount: 1 } },
      headers: bearer(INTERNAL_TOKEN),
    });
    expect(res.statusCode).toBe(400);
    expect(refundCalls()).toHaveLength(0);
  });

  it("stores an Acme rejection as the final result and does not retry it", async () => {
    acme.respond(() => ({ status: 422, body: { error: "too much" } }));
    await hold(REFUND, "CLR-0109");
    const first = await execute("CLR-0109");
    expect(first.json()).toMatchObject({
      ok: false,
      alreadyExecuted: false,
      status: 422,
      result: { error: "too much" },
    });
    acme.respond(null);
    const second = await execute("CLR-0109");
    expect(second.json()).toMatchObject({ ok: false, alreadyExecuted: true, status: 422 });
    expect(refundCalls()).toHaveLength(1);
  });

  it("lets a retry through when Acme was definitely not reached", async () => {
    await hold(REFUND, "CLR-0110");
    const acmeUrl = acme.url;
    await acme.close();
    const down = await execute("CLR-0110");
    expect(down.statusCode).toBe(502);
    expect(down.json()).toMatchObject({ ok: false, alreadyExecuted: false });
    acme = await startFakeAcme();
    expect(acme.url).not.toBe(acmeUrl);
    await gate.close();
    gate = buildGateServer(gateConfig(core, acme, db));
    const retried = await execute("CLR-0110");
    expect(retried.json()).toMatchObject({ ok: true, alreadyExecuted: false });
    expect(refundCalls()).toHaveLength(1);
  });

  it("never re-runs a call whose outcome is unknown after a timeout", async () => {
    await gate.close();
    gate = buildGateServer(gateConfig(core, acme, db, { acmeTimeoutMs: 30 }));
    acme.respond(() => ({ status: 201, body: { id: "re_slow" }, delayMs: 200 }));
    await hold(REFUND, "CLR-0111");
    const first = await execute("CLR-0111");
    expect(first.statusCode).toBe(502);
    expect(first.json()).toMatchObject({ ok: false, alreadyExecuted: false });
    await new Promise((r) => setTimeout(r, 250));
    const second = await execute("CLR-0111");
    expect(second.json().ok).toBe(false);
    expect(refundCalls()).toHaveLength(1);
  });
});

describe("restart", () => {
  it("a held call survives a restart and executes once", async () => {
    await hold(REFUND, "CLR-0200");
    await gate.close();
    gate = buildGateServer(gateConfig(core, acme, db));
    const first = await execute("CLR-0200");
    expect(first.json()).toMatchObject({ ok: true, alreadyExecuted: false });
    expect(refundCalls()[0]!.body).toEqual(REFUND.args);

    await gate.close();
    gate = buildGateServer(gateConfig(core, acme, db));
    const second = await execute("CLR-0200");
    expect(second.json()).toMatchObject({
      ok: true,
      alreadyExecuted: true,
      result: { id: "re_7731" },
    });
    expect(refundCalls()).toHaveLength(1);
  });

  it("a crash during execution never runs the call a second time", async () => {
    await hold(REFUND, "CLR-0201");
    await gate.close();
    // The state a crash leaves behind: claimed, no result recorded.
    const raw = new Database(db.path);
    raw.prepare("UPDATE held_calls SET state = 'executing' WHERE request_id = ?").run("CLR-0201");
    raw.close();

    gate = buildGateServer(gateConfig(core, acme, db));
    const res = await execute("CLR-0201");
    expect(res.json()).toMatchObject({ ok: false, alreadyExecuted: false });
    expect(res.json().error).toMatch(/unknown/i);
    expect(refundCalls()).toHaveLength(0);
  });
});

describe("internal routes need the internal token", () => {
  it.each([
    ["no token", {}],
    ["an agent token", bearer(TOK_ALL)],
    ["the wrong token", bearer("wrong")],
  ])("execute refuses %s", async (_name, headers) => {
    await hold(REFUND, "CLR-0300");
    const res = await gate.inject({
      method: "POST",
      url: "/internal/execute/CLR-0300",
      payload: { call_hash: "hash-CLR-0300" },
      headers,
    });
    expect(res.statusCode).toBe(401);
    expect(refundCalls()).toHaveLength(0);
  });

  it.each([
    ["no token", {}],
    ["an agent token", bearer(TOK_ALL)],
  ])("lookup refuses %s", async (_name, headers) => {
    const res = await gate.inject({
      method: "GET",
      url: "/internal/lookup/orders/A-1931",
      headers,
    });
    expect(res.statusCode).toBe(401);
    expect(acme.calls).toHaveLength(0);
  });

  it("agent routes refuse the internal token", async () => {
    const res = await gate.inject({
      method: "GET",
      url: "/acme/orders/A-1931",
      headers: bearer(INTERNAL_TOKEN),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /internal/lookup/:kind/:id", () => {
  const lookup = (kind: string, id: string) =>
    gate.inject({
      method: "GET",
      url: `/internal/lookup/${kind}/${encodeURIComponent(id)}`,
      headers: bearer(INTERNAL_TOKEN),
    });

  it.each([
    ["orders", "A-1931", "/orders/A-1931"],
    ["customers", "cus_8812", "/customers/cus_8812"],
    ["destinations", "meera.k@okaxis", "/destinations/meera.k%40okaxis"],
    ["ci", "v2.14.0", "/ci/v2.14.0"],
    ["github", "42", "/pulls/42"],
    ["services", "checkout", "/services/checkout"],
    ["tickets", "T-77", "/tickets/T-77"],
    ["files", "customers.csv", "/files/customers.csv"],
    ["pulls", "42", "/pulls/42"],
  ])("maps %s/%s to Acme %s", async (kind, id, url) => {
    const res = await lookup(kind, id);
    expect(res.statusCode).toBe(200);
    expect(acme.calls[0]!.url).toBe(url);
    expect(acme.calls[0]!.headers["x-acme-admin-key"]).toBe(ADMIN_KEY);
  });

  it("returns 404 when Acme does not know the id", async () => {
    expect((await lookup("orders", "nope")).statusCode).toBe(404);
  });

  it("returns 404 for a kind that is not on the list, without calling Acme", async () => {
    expect((await lookup("state", "x")).statusCode).toBe(404);
    expect(acme.calls).toHaveLength(0);
  });

  it("returns 502, not 404, when Acme is down, so a lookup failure is never read as absent", async () => {
    await acme.close();
    expect((await lookup("orders", "A-1931")).statusCode).toBe(502);
    acme = await startFakeAcme();
  });

  it("returns 502, not 404, when Acme errors, for the same reason", async () => {
    acme.respond(() => ({ status: 500, body: { error: "boom" } }));
    const res = await lookup("orders", "A-1931");
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("boom");
  });
});
