import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ALL_ENDPOINTS,
  INTERNAL_TOKEN,
  TOK_ALL,
  TOK_READER,
  TOK_REFUNDS,
  bearer,
  buildGateServer,
  gateConfig,
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

describe("a refusal outside the agent's role goes on the record", () => {
  const deploy = ALL_ENDPOINTS.find((ep) => ep.cls === "deploy")!;
  const refuse = () =>
    gate.inject({ method: deploy.method, url: deploy.url, payload: deploy.payload, headers: bearer(TOK_REFUNDS) });

  it("tells core who tried what, with the identity from the token and the core token", async () => {
    const res = await refuse();
    expect(res.statusCode).toBe(403);
    expect(core.refusals).toHaveLength(1);
    const { body, authorization } = core.refusals[0]!;
    expect(authorization).toBe(`Bearer ${INTERNAL_TOKEN}`);
    expect(body.action.agent.name).toBe("refunds-agent");
    expect(body.action.source).toBe("gate");
    expect(body.action.business?.endpoint).toContain(deploy.method);
    expect(body.class).toBe("deploy");
    expect(body.reason).toContain("not allowed to call deploy");
  });

  it("doesn't take the agent's word for who it is", async () => {
    await gate.inject({
      method: deploy.method,
      url: deploy.url,
      payload: { ...(deploy.payload as object), agent: "ops-agent", on_behalf_of: "ops-agent" },
      headers: bearer(TOK_REFUNDS),
    });
    expect(core.refusals[0]!.body.action.agent.name).toBe("refunds-agent");
  });

  it("still refuses when core can't be told, because a record can't turn a no into a yes", async () => {
    await core.close();
    const res = await refuse();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ status: "denied" });
    expect(acme.calls).toHaveLength(0);
  });

  it("records a call whose body wouldn't even parse, since trying it is the fact worth keeping", async () => {
    const res = await gate.inject({ method: deploy.method, url: deploy.url, payload: { nonsense: true }, headers: bearer(TOK_REFUNDS) });
    expect(res.statusCode).toBe(403);
    expect(core.refusals).toHaveLength(1);
    expect(core.refusals[0]!.body.class).toBe("deploy");
  });

  it("isn't sent for a call inside the agent's role", async () => {
    const ep = ALL_ENDPOINTS.find((e) => e.cls === "refund")!;
    await gate.inject({ method: ep.method, url: ep.url, payload: ep.payload, headers: bearer(TOK_REFUNDS) });
    expect(core.refusals).toHaveLength(0);
  });
});

describe("token scoping", () => {
  it.each(ALL_ENDPOINTS.filter((ep) => ep.cls !== "refund"))(
    "a refund-only token gets 403 on $name without asking core or reaching Acme",
    async (ep) => {
      const res = await gate.inject({
        method: ep.method,
        url: ep.url,
        payload: ep.payload,
        headers: bearer(TOK_REFUNDS),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ status: "denied" });
      expect(res.json().message).toContain("refunds-agent");
      expect(core.checks).toHaveLength(0);
      expect(acme.calls).toHaveLength(0);
    },
  );

  it("a refund-only token reaches core on a refund", async () => {
    const ep = ALL_ENDPOINTS.find((e) => e.cls === "refund")!;
    const res = await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: bearer(TOK_REFUNDS),
    });
    expect(res.statusCode).toBe(201);
    expect(core.checks[0]!.action.agent.name).toBe("refunds-agent");
  });

  it.each(ALL_ENDPOINTS)("a token with no classes cannot call $name", async (ep) => {
    const res = await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: bearer(TOK_READER),
    });
    expect(res.statusCode).toBe(403);
    expect(core.checks).toHaveLength(0);
  });

  it("a token with no classes can still read", async () => {
    const res = await gate.inject({
      method: "GET",
      url: "/acme/orders/A-1931",
      headers: bearer(TOK_READER),
    });
    expect(res.statusCode).toBe(200);
  });

  it("agent identity headers are ignored: the name comes only from the token", async () => {
    const ep = ALL_ENDPOINTS[0]!;
    await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: { ...bearer(TOK_ALL), "x-clearance-agent": "sam", "x-agent-name": "sam" },
    });
    expect(core.checks[0]!.action.agent.name).toBe("ops-agent");
  });

  it("accepts the bearer scheme in any case but nothing else", async () => {
    const ep = ALL_ENDPOINTS[0]!;
    const lower = await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: { authorization: `bearer ${TOK_ALL}` },
    });
    expect(lower.statusCode).toBe(201);
    const basic = await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: { authorization: `Basic ${TOK_ALL}` },
    });
    expect(basic.statusCode).toBe(401);
  });
});
