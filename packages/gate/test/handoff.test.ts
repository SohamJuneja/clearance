/** F24: a refusal outside the agent's job says who does that job, and is still a refusal. */
import { JOB_ROLES } from "@clearance/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refusalFor } from "../src/service.js";
import {
  ALL_ENDPOINTS,
  HELD_TEXT,
  TOK_REFUNDS,
  bearer,
  buildGateServer,
  gateConfig,
  holdFor,
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

const TOK_CODER = "tok-coder-merges-only";
const endpoint = (cls: string) => ALL_ENDPOINTS.find((ep) => ep.cls === cls)!;

beforeEach(async () => {
  core = await startFakeCore();
  acme = await startFakeAcme();
  db = tempDb();
  const config = gateConfig(core, acme, db);
  gate = buildGateServer({
    ...config,
    agentTokens: { ...config.agentTokens, [TOK_CODER]: { agent: "coder", classes: ["merge"] } },
  });
  await gate.ready();
});

afterEach(async () => {
  await gate.close();
  await core.close();
  await acme.close();
  db.cleanup();
});

const call = (cls: string, token: string, extra: Record<string, string> = {}) => {
  const ep = endpoint(cls);
  return gate.inject({ method: ep.method, url: ep.url, payload: ep.payload, headers: { ...bearer(token), ...extra } });
};

describe("refusalFor", () => {
  it("names the role, its room and how to address it", () => {
    const { message, handoff } = refusalFor("refunds-agent", "merge");
    expect(message).toContain("refunds-agent is not allowed to call merge actions.");
    expect(message).toContain("@merges");
    expect(message).toContain("#eng");
    expect(message).toMatch(/who asked/);
    expect(handoff).toEqual({ role: "merges", room: "eng", address: "@merges" });
  });

  it("gives today's refusal for a class with no role", () => {
    expect(refusalFor("refunds-agent", "secrets")).toEqual({
      message: "refunds-agent is not allowed to call secrets actions.",
    });
  });

  it.each(["constructor", "__proto__", "toString", ""])("treats %j as a class with no role", (cls) => {
    expect(refusalFor("refunds-agent", cls).handoff).toBeUndefined();
  });

  it("gives today's refusal when the mapping is empty, because no role is known", () => {
    expect(refusalFor("refunds-agent", "merge", () => null)).toEqual({
      message: "refunds-agent is not allowed to call merge actions.",
    });
  });

  it("never sends an agent back to itself, however its token was narrowed", () => {
    const { message, handoff } = refusalFor("coder", "merge");
    expect(handoff).toBeUndefined();
    expect(message).toBe("coder is not allowed to call merge actions.");
  });

  it("is deterministic: the same call gets the same words", () => {
    expect(refusalFor("ops-agent", "customer_email")).toEqual(refusalFor("ops-agent", "customer_email"));
  });

  it("names a role for every class the gate can refuse", () => {
    for (const ep of ALL_ENDPOINTS) expect(JOB_ROLES[ep.cls], ep.cls).toBeDefined();
  });
});

describe("a refusal at the gate", () => {
  it("tells a refused agent who does the job, and stays a refusal", async () => {
    const res = await call("merge", TOK_REFUNDS);
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.status).toBe("denied");
    expect(body.message).toContain("is not allowed to call merge actions.");
    expect(body.message).toContain("@merges");
    expect(body.handoff).toEqual({ role: "merges", room: "eng", address: "@merges" });
  });

  it("asks core nothing and reaches nothing upstream, whichever role it names", async () => {
    for (const ep of ALL_ENDPOINTS.filter((one) => one.cls !== "refund")) {
      const res = await call(ep.cls, TOK_REFUNDS);
      expect(res.statusCode, ep.name).toBe(403);
    }
    expect(core.checks).toHaveLength(0);
    expect(acme.calls).toHaveLength(0);
  });

  it("puts the bare refusal on the record: where the work may go next isn't what the agent did", async () => {
    await call("merge", TOK_REFUNDS);
    expect(core.refusals[0]!.body.reason).toBe("refunds-agent is not allowed to call merge actions.");
  });

  it("still refuses and still names the role when core can't be told", async () => {
    await core.close();
    const res = await call("merge", TOK_REFUNDS);
    expect(res.statusCode).toBe(403);
    expect(res.json().handoff).toEqual({ role: "merges", room: "eng", address: "@merges" });
    expect(acme.calls).toHaveLength(0);
  });

  it("hands nothing around for a held call: a hold names no role", async () => {
    core.decide(holdFor("CLR-0042"));
    const res = await call("merge", TOK_CODER);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("pending");
    expect(body.message).toBe(HELD_TEXT);
    expect(body.handoff).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("@merges");
  });
});

describe("taking a role grants nothing", () => {
  it.each([
    ["a header", { "x-switch-role": "merges", "x-clearance-role": "merges" }],
    ["a room hint", { "x-clearance-room": "eng" }],
  ])("an agent that says it holds the role in %s, with no grant, is still refused", async (_how, headers) => {
    const res = await call("merge", TOK_REFUNDS, headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().status).toBe("denied");
    expect(core.checks).toHaveLength(0);
    expect(acme.calls).toHaveLength(0);
  });

  it("an agent that says so in the call's own body is still refused, and the body changes nothing", async () => {
    const ep = endpoint("merge");
    const res = await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: { ...(ep.payload as object), role: "merges", holds_role: true },
      headers: bearer(TOK_REFUNDS),
    });
    expect(res.statusCode).toBe(403);
    expect(acme.calls).toHaveLength(0);
  });

  it("the agent with the grant reaches core with the same call, with or without a role", async () => {
    const res = await call("merge", TOK_CODER);
    expect(res.statusCode).not.toBe(403);
    expect(core.checks).toHaveLength(1);
    expect(JSON.stringify(core.checks[0]!.action)).not.toMatch(/merges/);
  });
});
