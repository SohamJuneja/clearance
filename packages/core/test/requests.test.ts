import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestState } from "@clearance/contracts";
import { RequestStateSchema } from "@clearance/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/index.js";
import { Ledger, verifyLedger } from "../src/ledger/ledger.js";
import { IllegalTransition, RequestStore, TRANSITIONS, type NewRequest } from "../src/requests/store.js";
import { FakeClock } from "./fakes.js";

const NOW = Date.parse("2026-11-04T14:00:00+05:30");
let db: Db;
let clock: FakeClock;
let store: RequestStore;

const input: NewRequest = {
  actionId: "a1",
  source: "gate",
  vendor: "gate",
  agent: "refunds-agent",
  callHash: "h1",
  cls: "refund",
  target: "POST /acme/refunds",
  call: { class: "refund", target: "POST /acme/refunds", args: { amount: 40000 } },
  tier: "high",
  score: 55,
  requesterIds: ["priya"],
  agentOwnerId: "priya",
  originRoom: "#support",
  originThread: "t1",
  evidence: {},
  flags: [],
  quorumRequired: 1,
  expiresAtMs: NOW + 25 * 60_000,
};

beforeEach(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), "clearance-req-")), "t.sqlite"));
  clock = new FakeClock(NOW);
  store = new RequestStore(db, new Ledger(db, clock), clock);
});

describe("request ids", () => {
  it("numbers requests CLR-0001, CLR-0002, ...", () => {
    expect(store.create(input).id).toBe("CLR-0001");
    expect(store.create(input).id).toBe("CLR-0002");
  });

  it("keeps counting across a restart", () => {
    store.create(input);
    const again = new RequestStore(db, new Ledger(db, clock), clock);
    expect(again.create(input).id).toBe("CLR-0002");
  });

  it("does not truncate past four digits", () => {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('request_seq', '12345')`).run();
    expect(store.create(input).id).toBe("CLR-12346");
  });
});

describe("request lifecycle", () => {
  it("starts HELD with what was asked for, and records it in the ledger", () => {
    const request = store.create(input);
    expect(request.state).toBe("HELD");
    expect(request.requesterIds).toEqual(["priya"]);
    expect(request.call.args).toEqual({ amount: 40000 });
    expect(request.createdAtMs).toBe(NOW);
    const entries = new Ledger(db, clock).list({ requestId: request.id });
    expect(entries.map((entry) => entry.type)).toEqual(["held"]);
    expect(entries[0]?.payload).toMatchObject({ class: "refund", call_hash: "h1", tier: "high" });
  });

  const legal: [RequestState, RequestState][] = [
    ["HELD", "ROUTED"],
    ["HELD", "EXPIRED"],
    ["HELD", "CANCELLED"],
    ["ROUTED", "APPROVED"],
    ["ROUTED", "DENIED"],
    ["ROUTED", "EXPIRED"],
    ["ROUTED", "CANCELLED"],
    ["ROUTED", "BREAK_GLASS"],
    ["ROUTED", "EDITED"],
    ["APPROVED", "EXECUTED"],
    ["APPROVED", "GRANTED"],
    ["APPROVED", "VOIDED"],
    ["APPROVED", "OUTCOME_UNKNOWN"],
    ["BREAK_GLASS", "OUTCOME_UNKNOWN"],
    ["BREAK_GLASS", "EXECUTED"],
    ["BREAK_GLASS", "GRANTED"],
    ["BREAK_GLASS", "VOIDED"],
    ["GRANTED", "CONSUMED"],
    ["GRANTED", "VOIDED"],
  ];

  /** Walk a fresh request to `state` along legal edges. */
  function at(state: RequestState) {
    const request = store.create(input);
    const path = pathTo(state);
    for (const step of path) store.transition(request.id, step);
    return request.id;
  }

  function pathTo(state: RequestState): RequestState[] {
    const seen = new Map<RequestState, RequestState[]>([["HELD", []]]);
    const queue: RequestState[] = ["HELD"];
    while (queue.length > 0) {
      const current = queue.shift() as RequestState;
      if (current === state) return seen.get(current) as RequestState[];
      for (const next of TRANSITIONS[current]) {
        if (!seen.has(next)) {
          seen.set(next, [...(seen.get(current) as RequestState[]), next]);
          queue.push(next);
        }
      }
    }
    throw new Error(`no path to ${state}`);
  }

  it.each(legal)("allows %s -> %s", (from, to) => {
    const id = at(from);
    store.transition(id, to);
    expect(store.get(id)?.state).toBe(to);
  });

  it("refuses every other edge", () => {
    // AUTO has no way in: a request is created in it, or never in it. It has its own test below.
    const allStates = RequestStateSchema.options.filter((state) => state !== "AUTO");
    const legalKeys = new Set(legal.map(([from, to]) => `${from}->${to}`));
    for (const from of allStates) {
      for (const to of allStates) {
        if (legalKeys.has(`${from}->${to}`)) continue;
        const id = at(from);
        expect(() => store.transition(id, to), `${from} -> ${to}`).toThrow(IllegalTransition);
        expect(store.get(id)?.state).toBe(from);
      }
    }
  });

  it("reaches AUTO only by being created there, and leaves it only if the gate reports the run didn't go through", () => {
    expect(TRANSITIONS.AUTO).toEqual(["VOIDED", "OUTCOME_UNKNOWN"]);
    for (const state of RequestStateSchema.options) expect(TRANSITIONS[state]).not.toContain("AUTO");
  });

  it("has no INELIGIBLE_ANSWER or REROUTED state: those are ledger events", () => {
    expect(RequestStateSchema.options as string[]).not.toContain("INELIGIBLE_ANSWER");
    expect(RequestStateSchema.options as string[]).not.toContain("REROUTED");
  });

  it("refuses a transition on a request that does not exist", () => {
    expect(() => store.transition("CLR-9999", "ROUTED")).toThrow(/no request/i);
  });

  it("finds an open request for a call and agent, and only an open one", () => {
    const request = store.create(input);
    expect(store.findOpen("h1", "refunds-agent")?.id).toBe(request.id);
    expect(store.findOpen("h1", "other-agent")).toBeNull();
    expect(store.findOpen("h2", "refunds-agent")).toBeNull();
    store.transition(request.id, "ROUTED");
    expect(store.findOpen("h1", "refunds-agent")?.id).toBe(request.id);
    store.transition(request.id, "DENIED");
    expect(store.findOpen("h1", "refunds-agent")).toBeNull();
  });

  it("keeps the ledger verifiable through all of it", () => {
    const request = store.create(input);
    store.transition(request.id, "ROUTED");
    expect(verifyLedger(db).ok).toBe(true);
  });
});
