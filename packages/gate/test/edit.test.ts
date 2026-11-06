/**
 * F20 at the gate: an approver edited a held refund. The gate is where a call becomes money, so it checks the rules
 * again whatever core says: only the amount, only on a refund, only down, and the original can never run after.
 */
import { GATE_WORDS, readExecuteResult } from "@clearance/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACME_ENDPOINTS,
  ALL_ENDPOINTS,
  INTERNAL_TOKEN,
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

const REFUND = ACME_ENDPOINTS.find((ep) => ep.name === "refund") as EndpointCase;
const ORIGINAL_AMOUNT = (REFUND.payload as { amount: number }).amount;
const LOWER = ORIGINAL_AMOUNT - 1;

async function hold(ep: EndpointCase, id: string) {
  core.decide(holdFor(id));
  const res = await gate.inject({ method: ep.method, url: ep.url, payload: ep.payload, headers: bearer(TOK_ALL) });
  expect(res.statusCode).toBe(202);
}

const edit = (id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = bearer(INTERNAL_TOKEN)) =>
  gate.inject({
    method: "POST",
    url: `/internal/edit/${id}`,
    payload: { call_hash: `hash-${id}`, new_request_id: "CLR-0002", new_call_hash: "hash-CLR-0002", amount: LOWER, ...body },
    headers,
  });

const execute = (id: string, callHash = `hash-${id}`) =>
  gate.inject({ method: "POST", url: `/internal/execute/${id}`, payload: { call_hash: callHash }, headers: bearer(INTERNAL_TOKEN) });

const refundCalls = () => acme.calls.filter((call) => call.method === "POST" && call.url === "/refunds");

describe("POST /internal/edit/:requestId", () => {
  it("runs the edited amount, once, and everything else as it was held", async () => {
    await hold(REFUND, "CLR-0001");
    expect((await edit("CLR-0001")).json()).toEqual({ ok: true });
    const first = await execute("CLR-0002");
    expect(first.json()).toMatchObject({ ok: true, alreadyExecuted: false });
    const second = await execute("CLR-0002");
    expect(second.json()).toMatchObject({ ok: true, alreadyExecuted: true });
    expect(refundCalls()).toHaveLength(1);
    expect(refundCalls()[0]?.body).toEqual({ ...(REFUND.payload as object), amount: LOWER });
  });

  it("uses the new request's id for Acme's exactly-once, not the original's", async () => {
    await hold(REFUND, "CLR-0001");
    await edit("CLR-0001");
    await execute("CLR-0002");
    expect(refundCalls()[0]?.headers["idempotency-key"]).toBe("CLR-0002");
  });

  it("closes the original, so it can never run afterwards", async () => {
    await hold(REFUND, "CLR-0001");
    await edit("CLR-0001");
    const late = await execute("CLR-0001");
    expect(late.json()).toMatchObject({ ok: false });
    expect(refundCalls()).toEqual([]);
    await execute("CLR-0002");
    await execute("CLR-0001");
    expect(refundCalls()).toHaveLength(1);
  });

  it("gives the same answer when asked again, which is what makes a retry safe", async () => {
    await hold(REFUND, "CLR-0001");
    expect((await edit("CLR-0001")).json()).toEqual({ ok: true });
    expect((await edit("CLR-0001")).json()).toEqual({ ok: true });
    await execute("CLR-0002");
    expect((await edit("CLR-0001")).json()).toEqual({ ok: true });
    expect(refundCalls()).toHaveLength(1);
  });

  it("won't take a second, different edit of the same call", async () => {
    await hold(REFUND, "CLR-0001");
    await edit("CLR-0001");
    const other = await edit("CLR-0001", { new_request_id: "CLR-0003", new_call_hash: "hash-CLR-0003", amount: LOWER - 1 });
    expect(other.statusCode).toBe(409);
    const changed = await edit("CLR-0001", { amount: LOWER - 1 });
    expect(changed.statusCode).toBe(409);
    expect((await execute("CLR-0003", "hash-CLR-0003")).statusCode).toBe(404);
  });

  it.each([
    ["an increase", { amount: ORIGINAL_AMOUNT + 1 }],
    ["the same amount", { amount: ORIGINAL_AMOUNT }],
  ])("refuses %s, and the original stays held", async (_name, body) => {
    await hold(REFUND, "CLR-0001");
    const response = await edit("CLR-0001", body);
    expect(response.statusCode).toBe(409);
    expect(response.json().ok).toBe(false);
    expect((await execute("CLR-0001")).json()).toMatchObject({ ok: true });
    expect(refundCalls()).toHaveLength(1);
  });

  it.each([
    ["zero", { amount: 0 }],
    ["a negative", { amount: -5 }],
    ["a fraction", { amount: 1.5 }],
    ["text", { amount: "1" }],
    ["no amount", { amount: undefined }],
    ["a new destination", { destination: "evil@okaxis" }],
    ["a new customer", { customer_id: "cus_evil" }],
    ["a new order", { order_id: "A-1" }],
    ["a new body", { body: { amount: 1 } }],
  ])("refuses a body with %s: only the amount can change", async (_name, body) => {
    await hold(REFUND, "CLR-0001");
    const response = await edit("CLR-0001", body);
    expect(response.statusCode).toBe(400);
    expect((await execute("CLR-0001")).json()).toMatchObject({ ok: true });
    expect(refundCalls()[0]?.body).toEqual(REFUND.payload);
  });

  it.each(ALL_ENDPOINTS.filter((ep) => ep.name !== "refund").map((ep) => [ep.name, ep] as const))("refuses %s, which has no amount", async (_name, ep) => {
    await hold(ep, "CLR-0001");
    const response = await edit("CLR-0001", { amount: 1 });
    expect(response.statusCode).toBe(409);
    expect((await execute("CLR-0002", "hash-CLR-0002")).statusCode).toBe(404);
  });

  it("refuses the wrong hash, an unknown call, and a new id already in use", async () => {
    await hold(REFUND, "CLR-0001");
    expect((await edit("CLR-0001", { call_hash: "nope" })).statusCode).toBe(409);
    expect((await edit("CLR-9999")).statusCode).toBe(404);
    await hold(REFUND, "CLR-0005");
    expect((await edit("CLR-0001", { new_request_id: "CLR-0005", new_call_hash: "hash-CLR-0005" })).statusCode).toBe(409);
    expect((await execute("CLR-0005")).json().result).toBeDefined();
    expect(refundCalls()[0]?.body).toEqual(REFUND.payload);
  });

  it("takes the agent sending the edited call itself as that same call, and runs it once", async () => {
    await hold(REFUND, "CLR-0001");
    await hold({ ...REFUND, payload: { ...(REFUND.payload as object), amount: LOWER } }, "CLR-0002");
    expect((await edit("CLR-0001")).json()).toEqual({ ok: true });
    await execute("CLR-0002");
    await execute("CLR-0001");
    expect(refundCalls()).toHaveLength(1);
    expect(refundCalls()[0]?.body).toEqual({ ...(REFUND.payload as object), amount: LOWER });
  });

  it("refuses a call that has already run or started", async () => {
    await hold(REFUND, "CLR-0001");
    await execute("CLR-0001");
    const late = await edit("CLR-0001");
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toContain("already");
    expect(refundCalls()).toHaveLength(1);
  });

  it("is core's alone: an agent's token and no token are both refused", async () => {
    await hold(REFUND, "CLR-0001");
    expect((await edit("CLR-0001", {}, bearer(TOK_ALL))).statusCode).toBe(401);
    expect((await edit("CLR-0001", {}, {})).statusCode).toBe(401);
    expect((await execute("CLR-0002", "hash-CLR-0002")).statusCode).toBe(404);
  });
});

describe("POST /internal/execute with look_only", () => {
  const look = (id: string, callHash = `hash-${id}`) =>
    gate.inject({ method: "POST", url: `/internal/execute/${id}`, payload: { call_hash: callHash, look_only: true }, headers: bearer(INTERNAL_TOKEN) });

  it("says nothing started, and starts nothing, on a call that's held", async () => {
    await hold(REFUND, "CLR-0001");
    const answer = await look("CLR-0001");
    expect(answer.json()).toEqual({ ok: false, alreadyExecuted: false, error: GATE_WORDS.nothingStarted });
    expect(readExecuteResult(answer.json())).toBe("refused");
    expect(refundCalls()).toEqual([]);
    // And it's still there to run, if anyone were to ask properly.
    expect((await execute("CLR-0001")).json()).toMatchObject({ ok: true });
  });

  it("gives the original result of a call that ran, without running it again", async () => {
    await hold(REFUND, "CLR-0001");
    await execute("CLR-0001");
    expect((await look("CLR-0001")).json()).toMatchObject({ ok: true, alreadyExecuted: true });
    expect(refundCalls()).toHaveLength(1);
  });

  it("says outcome unknown for a call Acme took and never answered", async () => {
    await hold(REFUND, "CLR-0001");
    acme.respond(() => {
      throw new Error("no answer");
    });
    await execute("CLR-0001");
    const answer = (await look("CLR-0001")).json();
    expect(answer.ok).toBe(false);
    expect(typeof answer.error).toBe("string");
  });

  it("refuses an unknown call and the wrong hash, as a run does", async () => {
    await hold(REFUND, "CLR-0001");
    expect((await look("CLR-9999")).json()).toMatchObject({ ok: false, error: GATE_WORDS.unknownRequest });
    expect((await look("CLR-0001", "nope")).statusCode).toBe(409);
    expect(refundCalls()).toEqual([]);
  });
});

describe("what core makes of the gate's answers", () => {
  it("reads each one the way the gate means it", () => {
    const read = (error: string) => readExecuteResult({ ok: false, alreadyExecuted: false, error });
    expect(read(GATE_WORDS.unknownRequest)).toBe("retry");
    expect(read(GATE_WORDS.nothingRan)).toBe("retry");
    expect(read(GATE_WORDS.busy)).toBe("retry");
    expect(read(`${GATE_WORDS.outcomeUnknown}: acme did not answer`)).toBe("unknown");
    expect(read("call_hash does not match the stored call")).toBe("refused");
    expect(readExecuteResult({ ok: true, alreadyExecuted: false })).toBe("ran");
  });
});

describe("what an approved call's answer from Acme means", () => {
  it.each([
    [500, "unknown"],
    [503, "unknown"],
    [422, "refused"],
    [409, "refused"],
  ])("Acme answering %i reads as %s, and asking again gives the same answer without running it again", async (status, reading) => {
    await hold(REFUND, "CLR-0001");
    acme.respond(() => ({ status, body: { error: "no" } }));
    const first = (await execute("CLR-0001")).json();
    expect(readExecuteResult(first)).toBe(reading);
    const again = (await execute("CLR-0001")).json();
    expect(readExecuteResult(again)).toBe(reading);
    expect(refundCalls()).toHaveLength(1);
  });
});

describe("what earned autonomy allowed, and didn't go through", () => {
  const allowed = { decision: "allow", reason: "Autonomy L3", request_id: "CLR-0009", call_hash: "h" } as const;
  const run = () => gate.inject({ method: REFUND.method, url: REFUND.url, payload: REFUND.payload, headers: bearer(TOK_ALL) });

  it("tells core it never ran when Acme refused the connection", async () => {
    core.decide(() => allowed);
    await acme.close();
    expect((await run()).statusCode).toBe(502);
    expect(core.runFailures).toEqual([
      { id: "CLR-0009", body: { never_ran: true, error: "acme was not reached" }, authorization: bearer(INTERNAL_TOKEN).authorization },
    ]);
    acme = await startFakeAcme();
  });

  it("tells core it never ran when Acme refused the call", async () => {
    core.decide(() => allowed);
    acme.respond(() => ({ status: 422, body: { error: "no" } }));
    await run();
    expect(core.runFailures[0]).toMatchObject({ id: "CLR-0009", body: { never_ran: true, error: "acme answered 422" } });
  });

  it("tells core nobody knows when Acme fell over", async () => {
    core.decide(() => allowed);
    acme.respond(() => ({ status: 500, body: { error: "no" } }));
    await run();
    expect(core.runFailures[0]).toMatchObject({ id: "CLR-0009", body: { never_ran: false, error: "acme answered 500" } });
  });

  it("says nothing when it went through, or when nothing was on record for it", async () => {
    core.decide(() => allowed);
    await run();
    core.decide(() => ({ decision: "allow", reason: "safe" }));
    await acme.close();
    await run();
    expect(core.runFailures).toEqual([]);
    acme = await startFakeAcme();
  });
});

describe("GET /pending/:id with nobody able to say whether it ran", () => {
  it("says so, and says not to retry", async () => {
    await hold(REFUND, "CLR-0001");
    core.requests.set("CLR-0001", { status: 200, body: JSON.stringify({ state: "OUTCOME_UNKNOWN", agent: "ops-agent" }) });
    const response = await gate.inject({ method: "GET", url: "/pending/CLR-0001", headers: bearer(TOK_ALL) });
    expect(response.json()).toMatchObject({ status: "outcome_unknown", state: "OUTCOME_UNKNOWN" });
    expect(response.json().message).toBe("CLR-0001: nobody can say whether it ran. Do not retry it. A person has to check.");
  });
});

describe("GET /pending/:id on an edited call", () => {
  it("says it won't run, and where it went, in words an agent can't read as an approval", async () => {
    await hold(REFUND, "CLR-0001");
    core.requests.set("CLR-0001", { status: 200, body: JSON.stringify({ state: "EDITED", agent: "ops-agent", edited_to: "CLR-0002" }) });
    const response = await gate.inject({ method: "GET", url: "/pending/CLR-0001", headers: bearer(TOK_ALL) });
    expect(response.json()).toMatchObject({ status: "edited", state: "EDITED", edited_to: "CLR-0002" });
    expect(response.json().message).toBe("CLR-0001 did not run and will not. An approver edited it to CLR-0002. Do not try it again.");
    expect(response.json().result).toBeUndefined();
  });
});
