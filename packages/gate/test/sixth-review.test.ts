/** A teammate's review (REVIEW.md, L1): an agent's token read everything Acme has, through `GET /acme/state`. */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateServer, gateConfig, startFakeAcme, startFakeCore, tempDb, TOK_ALL, type FakeAcme, type FakeCore, type TempDb } from "./helpers.js";

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

const read = (url: string) => gate.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOK_ALL}` } });
const readsOfAcme = () => acme.calls.filter((call) => call.method === "GET");

describe("what an agent's token can read", () => {
  it.each(["/acme/state", "/acme/state/", "/acme/state?x=1", "/acme/%73tate", "/acme/STATE", "/acme/admin/reset", "/acme/health", "/acme/nothing-we-know"])("refuses %s, and never asks Acme", async (url) => {
    const res = await read(url);
    expect(res.statusCode).toBe(403);
    expect(res.json().status).toBe("denied");
    expect(readsOfAcme()).toEqual([]);
  });

  it.each(["/acme/orders/A-1931", "/acme/customers/cus_1", "/acme/customers?query=meera", "/acme/tickets/T-77", "/acme/destinations/d1", "/acme/services", "/acme/services/checkout", "/acme/ci/v1", "/acme/pulls/418", "/acme/files/customers.csv", "/acme/emails/templates"])("guard: goes on reading %s", async (url) => {
    const res = await read(url);
    expect(res.statusCode).not.toBe(403);
    expect(readsOfAcme()).toHaveLength(1);
  });
});
