/** Fifth review, at the gate: a lookup kind is only a kind if the table has it, and `constructor` is nobody's. */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateServer, gateConfig, INTERNAL_TOKEN, startFakeAcme, startFakeCore, tempDb, type FakeAcme, type FakeCore, type TempDb } from "./helpers.js";

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

describe("F1: a lookup keyed by something typed", () => {
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])("%s is no kind of lookup", async (kind) => {
    const res = await gate.inject({ method: "GET", url: `/internal/lookup/${kind}/x`, headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
    expect(res.statusCode).toBe(404);
    expect(acme.calls).toEqual([]);
  });
});
