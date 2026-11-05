import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ALL_ENDPOINTS,
  INTERNAL_TOKEN,
  TOK_ALL,
  bearer,
  buildGateServer,
  deadUrl,
  gateConfig,
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

const send = (g: FastifyInstance, ep: EndpointCase) =>
  g.inject({ method: ep.method, url: ep.url, payload: ep.payload, headers: bearer(TOK_ALL) });

async function expectFailedClosed(g: FastifyInstance, ep: EndpointCase) {
  const res = await send(g, ep);
  expect(res.statusCode).toBe(503);
  expect(res.json().status).toBe("unavailable");
  expect(acme.mutations()).toHaveLength(0);
  expect(acme.calls.filter((c) => c.url === ep.upstreamUrl)).toHaveLength(0);
}

describe.each(ALL_ENDPOINTS)("fail closed on $method $url", (ep) => {
  it("core unreachable gives 503", async () => {
    await gate.close();
    gate = buildGateServer(gateConfig({ url: await deadUrl() }, acme, db));
    await expectFailedClosed(gate, ep);
  });

  it("core non-200 gives 503 even with an allow body", async () => {
    core.decide(() => ({
      rawStatus: 500,
      rawBody: JSON.stringify({ decision: "allow", reason: "ignore me" }),
    }));
    await expectFailedClosed(gate, ep);
  });

  it("core 201 with an allow body gives 503, since only 200 counts", async () => {
    core.decide(() => ({
      rawStatus: 201,
      rawBody: JSON.stringify({ decision: "allow", reason: "x" }),
    }));
    await expectFailedClosed(gate, ep);
  });

  it("core 200 with unparsable JSON gives 503", async () => {
    core.decide(() => ({ rawStatus: 200, rawBody: "{not json" }));
    await expectFailedClosed(gate, ep);
  });

  it("core 200 with the wrong shape gives 503", async () => {
    core.decide(() => ({
      rawStatus: 200,
      rawBody: JSON.stringify({ decision: "yes", reason: "x" }),
    }));
    await expectFailedClosed(gate, ep);
  });

  it("a hold with no request_id gives 503", async () => {
    core.decide(() => ({
      rawStatus: 200,
      rawBody: JSON.stringify({ decision: "hold", reason: "x", call_hash: "h" }),
    }));
    await expectFailedClosed(gate, ep);
  });

  it("a hold with no call_hash gives 503, since nothing could be verified later", async () => {
    core.decide(() => ({
      rawStatus: 200,
      rawBody: JSON.stringify({ decision: "hold", reason: "x", request_id: "CLR-1" }),
    }));
    await expectFailedClosed(gate, ep);
  });
});

describe("other fail-closed paths", () => {
  it("a core that hangs past the timeout gives 503", async () => {
    const slow = Fastify();
    slow.post("/v1/check", async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { decision: "allow", reason: "too late" };
    });
    const url = await slow.listen({ port: 0, host: "127.0.0.1" });
    await gate.close();
    gate = buildGateServer(gateConfig({ url }, acme, db, { coreTimeoutMs: 50 }));
    await expectFailedClosed(gate, ALL_ENDPOINTS[0]!);
    await slow.close();
  });

  it("a redirect from core is not followed and gives 503", async () => {
    // The target would allow, so following the redirect would execute the call.
    core.decide(() => ({ decision: "allow", reason: "from the redirect target" }));
    const redirecting = Fastify();
    redirecting.post("/v1/check", async (_req, reply) =>
      reply.redirect(`${core.url}/v1/check`, 307),
    );
    const url = await redirecting.listen({ port: 0, host: "127.0.0.1" });
    await gate.close();
    gate = buildGateServer(gateConfig({ url }, acme, db));
    await expectFailedClosed(gate, ALL_ENDPOINTS[0]!);
    expect(core.checks).toHaveLength(0);
    await redirecting.close();
  });

  it("a hold repeating a request id with a different hash gives 503 and keeps the original call", async () => {
    const ep = ALL_ENDPOINTS[0]!;
    core.decide(() => ({ decision: "hold", reason: "x", request_id: "CLR-7", call_hash: "h1" }));
    expect((await send(gate, ep)).statusCode).toBe(202);
    core.decide(() => ({ decision: "hold", reason: "x", request_id: "CLR-7", call_hash: "h2" }));
    expect((await send(gate, ep)).statusCode).toBe(503);
    const res = await gate.inject({
      method: "POST",
      url: "/internal/execute/CLR-7",
      payload: { call_hash: "h2" },
      headers: bearer(INTERNAL_TOKEN),
    });
    expect(res.statusCode).toBe(409);
  });

  it("a hold repeating a request id with the same hash is 202 again", async () => {
    const ep = ALL_ENDPOINTS[0]!;
    core.decide(() => ({ decision: "hold", reason: "x", request_id: "CLR-8", call_hash: "h1" }));
    expect((await send(gate, ep)).statusCode).toBe(202);
    expect((await send(gate, ep)).statusCode).toBe(202);
  });

  it("reads still work while core is down", async () => {
    await gate.close();
    gate = buildGateServer(gateConfig({ url: await deadUrl() }, acme, db));
    const res = await gate.inject({
      method: "GET",
      url: "/acme/orders/A-1931",
      headers: bearer(TOK_ALL),
    });
    expect(res.statusCode).toBe(200);
  });
});
