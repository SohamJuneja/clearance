import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { GatePort, LookupPort } from "@clearance/contracts";
import { createGateClient } from "../src/index.js";
import {
  ACME_ENDPOINTS,
  INTERNAL_TOKEN,
  TOK_ALL,
  bearer,
  buildGateServer,
  deadUrl,
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
let baseUrl: string;
let client: GatePort & LookupPort;

beforeEach(async () => {
  core = await startFakeCore();
  acme = await startFakeAcme();
  db = tempDb();
  gate = buildGateServer(gateConfig(core, acme, db));
  baseUrl = await gate.listen({ port: 0, host: "127.0.0.1" });
  client = createGateClient({ baseUrl, internalToken: INTERNAL_TOKEN });
});

afterEach(async () => {
  await gate.close();
  await core.close();
  await acme.close();
  db.cleanup();
});

async function hold(id: string) {
  const ep = ACME_ENDPOINTS[0]!;
  core.decide(holdFor(id));
  await gate.inject({
    method: ep.method,
    url: ep.url,
    payload: ep.payload,
    headers: bearer(TOK_ALL),
  });
}

describe("createGateClient GatePort", () => {
  it("executes, then reports alreadyExecuted with the original result", async () => {
    await hold("CLR-1");
    const first = await client.execute("CLR-1", "hash-CLR-1");
    expect(first).toMatchObject({ ok: true, alreadyExecuted: false, result: { id: "re_7731" } });
    const second = await client.execute("CLR-1", "hash-CLR-1");
    expect(second).toMatchObject({ ok: true, alreadyExecuted: true, result: { id: "re_7731" } });
  });

  it("returns a failed result on a hash mismatch or an unknown request", async () => {
    await hold("CLR-2");
    expect(await client.execute("CLR-2", "wrong")).toMatchObject({
      ok: false,
      alreadyExecuted: false,
    });
    expect(await client.execute("CLR-404", "x")).toMatchObject({
      ok: false,
      alreadyExecuted: false,
    });
  });

  it("throws when the gate is down, so core keeps the approval and retries", async () => {
    const dead = createGateClient({ baseUrl: await deadUrl(), internalToken: INTERNAL_TOKEN });
    await expect(dead.execute("CLR-3", "x")).rejects.toThrow();
    await expect(dead.edit("CLR-3", { callHash: "x", newRequestId: "CLR-4", newCallHash: "y", amount: 1 })).rejects.toThrow();
  });

  it("returns a failed result when the gate answers with a refusal, so core voids at once", async () => {
    const wrongToken = createGateClient({ baseUrl, internalToken: "wrong" });
    const result = await wrongToken.execute("CLR-3", "x");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("encodes the request id", async () => {
    expect((await client.execute("CLR/../x", "h")).ok).toBe(false);
  });
});

describe("createGateClient LookupPort", () => {
  it("returns the record", async () => {
    expect(await client.lookup("orders", "A-1931")).toMatchObject({ id: "A-1931", total: 4000 });
  });

  it("handles ids that need encoding", async () => {
    expect(await client.lookup("destinations", "meera.k@okaxis")).toMatchObject({
      id: "meera.k@okaxis",
    });
  });

  it("returns null only for not found", async () => {
    expect(await client.lookup("orders", "nope")).toBeNull();
    expect(await client.lookup("unknownkind", "x")).toBeNull();
  });

  it("throws when the gate cannot answer, so absence is never assumed", async () => {
    await acme.close();
    await expect(client.lookup("orders", "A-1931")).rejects.toThrow();
    acme = await startFakeAcme();
    const dead = createGateClient({ baseUrl: await deadUrl(), internalToken: INTERNAL_TOKEN });
    await expect(dead.lookup("orders", "A-1931")).rejects.toThrow();
    const wrongToken = createGateClient({ baseUrl, internalToken: "wrong" });
    await expect(wrongToken.lookup("orders", "A-1931")).rejects.toThrow();
  });
});
