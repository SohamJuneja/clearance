/**
 * What the live cases decide, on stand-in stacks. None of this touches a real one. The point is that a live result comes
 * from what was seen: a stack that lets everything through must fail, and one where nothing works must fail too.
 * Whether the real stack passes is what `pnpm eval:authority --live` is for.
 */
import { describe, expect, it } from "vitest";
import { CASES } from "./cases.ts";
import {
  answerPlan,
  type HookAnswer,
  type HttpAnswer,
  type LiveCard,
  LIVE_ADAPTED,
  LIVE_CASE_IDS,
  LIVE_NOTES,
  LiveBlocked,
  type LiveLedgerRow,
  type LivePerson,
  type LiveStage,
  type LiveState,
  NOT_LIVE,
  runLiveCase,
  summariseLive,
} from "./live-cases.ts";

interface FakeOptions {
  /** Anyone's yes executes the request, and every guard opens. */
  open?: boolean;
  /** Nobody's answer does anything: no approval ever executes. */
  dead?: boolean;
  /** Whether a Switch agent other than Clearance exists. */
  agent?: boolean;
  /** Whether Sam has a second account linked. */
  second?: boolean;
}

/** A stack reduced to what the cases read. It has no rules, only the two extremes the tests need. */
class FakeStage implements LiveStage {
  refunds: { amount: number }[] = [];
  merges = 0;
  requests = new Map<string, { id: string; amount: number; state: string; granted?: boolean }>();
  ledgerRows: LiveLedgerRow[] = [];
  counter = 0;
  policyHash = "hash-a";
  freshCalls: unknown[] = [];

  constructor(private readonly options: FakeOptions) {}

  async fresh(options?: unknown): Promise<void> {
    this.freshCalls.push(options);
    this.refunds = [];
    this.merges = 0;
    this.requests.clear();
    this.ledgerRows = [];
  }
  async settle(): Promise<void> {}
  async say(): Promise<void> {}

  hasSecondAccount(): boolean {
    return this.options.second !== false;
  }
  otherAgentName(): string | undefined {
    return this.options.agent === false ? undefined : "e1-live-test";
  }
  async agentSays(): Promise<void> {
    if (this.options.agent === false) throw new LiveBlocked("no other agent");
    if (!this.options.open) return;
    // Every guard is open, so an agent's words are enough.
    for (const request of this.requests.values()) {
      if (request.state !== "ROUTED") continue;
      request.state = "EXECUTED";
      this.refunds.push({ amount: request.amount });
    }
  }
  async typeBeside(): Promise<void> {}
  listedCalls = 0;
  async withSecondAccountListed<T>(work: () => Promise<T>): Promise<T> {
    this.listedCalls += 1;
    return work();
  }
  async buttonsLeft(): Promise<number> {
    return 2;
  }

  private openRequest(amount: number): string {
    this.counter += 1;
    const id = `CLR-${String(this.counter).padStart(4, "0")}`;
    this.requests.set(id, { id, amount, state: "ROUTED" });
    return id;
  }

  async gate(_agent: string, method: string, path: string, body?: unknown): Promise<HttpAnswer> {
    if (method === "GET") return { status: 200, json: {} };
    const args = (body ?? {}) as { amount?: number; pr?: number };
    if (path.startsWith("/github/merge")) {
      return { status: 202, json: { request_id: this.openRequest(0) } };
    }
    return { status: 202, json: { request_id: this.openRequest(args.amount ?? 0) } };
  }

  async gateExecute(id: string): Promise<HttpAnswer> {
    if (this.options.open) {
      const request = this.requests.get(id);
      this.refunds.push({ amount: request?.amount ?? 1 });
      return { status: 200, json: { ok: true } };
    }
    return { status: 409, json: {} };
  }

  async acmeWithoutKey(): Promise<number> {
    if (this.options.open) this.refunds.push({ amount: 40000 });
    return this.options.open ? 201 : 401;
  }

  async acmeEffects(): Promise<number> {
    return this.refunds.length + this.merges;
  }
  async refundAmounts(): Promise<number[]> {
    return this.refunds.map((refund) => refund.amount);
  }
  async merged(): Promise<number> {
    return this.merges;
  }

  async hook(_agent: string, _tool: string, _input: Record<string, unknown>): Promise<HookAnswer> {
    if (this.options.open) return { allow: true, reason: "ok", status: 200 };
    const id = this.openRequest(0);
    return { allow: false, reason: `HELD ${id}`, status: 200 };
  }
  async hookCli(): Promise<string> {
    return this.options.open ? "{}" : '"deny"';
  }

  async coreGet(path: string): Promise<HttpAnswer> {
    if (path === "/v1/health") return { status: 200, json: { policy_hash: this.policyHash } };
    return { status: 200, json: {} };
  }
  async corePost(path: string): Promise<HttpAnswer> {
    if (path === "/v1/drills/send") return { status: 200, json: { request_id: this.openRequest(0) } };
    if (path === "/v1/policy/propose") return { status: 202, json: { request_id: this.openRequest(0) } };
    return { status: 200, json: {} };
  }
  async request(id: string): Promise<LiveState> {
    return {
      state: this.requests.get(id)?.state ?? "",
      requester_ids: ["priya", "sam"],
      quorum_required: 2,
      call_hash: "hash",
      approvals: [],
      agent_owner_id: "priya",
    };
  }
  async stateOf(id: string): Promise<string> {
    return this.requests.get(id)?.state ?? "";
  }
  async waitState(id: string): Promise<string> {
    return this.requests.get(id)?.state ?? "";
  }
  async ledger(): Promise<LiveLedgerRow[]> {
    return this.ledgerRows;
  }
  async waitLedger(): Promise<boolean> {
    return false;
  }
  async ledgerVerifies(): Promise<boolean> {
    return true;
  }

  private card(id: string): LiveCard {
    return { postId: id, channelId: "c", text: id, handle: "A1" };
  }
  async roomCard(_person: LivePerson, _room: string, id: string): Promise<LiveCard> {
    return this.card(id);
  }
  async dmCard(_person: LivePerson, id: string): Promise<LiveCard> {
    return this.card(id);
  }
  async dmCardMatching(): Promise<LiveCard> {
    return this.card("proposal");
  }
  async answer(_person: LivePerson, card: LiveCard, decision: "allow" | "deny") {
    if (this.options.dead || decision === "deny") return { reached: true, detail: "pressed" };
    const request = this.requests.get(card.postId);
    if (this.options.open && request) {
      request.state = "EXECUTED";
      this.refunds.push({ amount: request.amount });
      this.ledgerRows.push({ type: "approved", payload: {} });
      this.policyHash = `${this.policyHash}x`;
    }
    return { reached: true, detail: "pressed" };
  }
  async seen(): Promise<boolean> {
    return this.options.open === true;
  }
  async crash(): Promise<void> {}
  async start(): Promise<void> {}
  async changeClearanceAddressing() {
    return { as: "e1-live-test", accepted: this.options.open === true, refusal: "refused", changed: this.options.open === true };
  }
}

const everyLiveCase = [...LIVE_CASE_IDS];

describe("the list of live cases", () => {
  it("accounts for every one of the 25, each exactly once", () => {
    const notLive = NOT_LIVE.map((entry) => entry.id);
    expect([...everyLiveCase, ...notLive].sort((a, b) => a - b)).toEqual(CASES.map((one) => one.id));
  });

  it("gives a reason for every case that stays out", () => {
    for (const entry of NOT_LIVE) expect(entry.why.length, `case ${entry.id}`).toBeGreaterThan(30);
  });

  it("says, for each live case, how it differs from the isolated run", () => {
    for (const id of everyLiveCase) expect(LIVE_NOTES[id]?.length ?? 0, `case ${id}`).toBeGreaterThan(20);
  });

  it("marks which cases ran as something other than the isolated scenario, so the count can say so", async () => {
    expect([...LIVE_ADAPTED].sort((a, b) => a - b)).toEqual([2, 10, 11, 12, 13]);
    for (const id of everyLiveCase) {
      const result = await runLiveCase(id, new FakeStage({ dead: true }));
      expect(result.adapted === true, `case ${id}`).toBe(LIVE_ADAPTED.has(id));
    }
  });

  it("runs the four cases where chat is the point", () => {
    for (const id of [1, 4, 5, 22]) expect(everyLiveCase).toContain(id);
  });
});

describe("a stack that lets everything through", () => {
  it.each(everyLiveCase)("case %i does not come back prevented", async (id) => {
    const result = await runLiveCase(id, new FakeStage({ open: true }));
    expect(result.outcome, result.why).not.toBe("prevented");
    expect(result.outcome, result.why).not.toBe("blocked");
  });
});

describe("a stack where nobody's answer does anything", () => {
  it.each(everyLiveCase)("case %i does not come back prevented", async (id) => {
    const result = await runLiveCase(id, new FakeStage({ dead: true }));
    expect(result.outcome, `${id}: ${result.why}`).not.toBe("prevented");
  });
});

describe("what a run reports", () => {
  it("comes back blocked, not failed, when there's no other agent to speak", async () => {
    for (const id of [5, 12, 16, 17, 22]) {
      const result = await runLiveCase(id, new FakeStage({ dead: true, agent: false }));
      expect(result.outcome, `case ${id}`).toBe("blocked");
      expect(result.why).toContain("no other agent");
    }
  });

  it("comes back blocked for case 10 when Sam has no second account linked", async () => {
    const result = await runLiveCase(10, new FakeStage({ dead: true, second: false }));
    expect(result.outcome).toBe("blocked");
    expect(result.why).toContain("e1-live-second-account");
  });

  it("runs case 10 as the stack stands, then again with the second account listed", async () => {
    const stage = new FakeStage({ dead: true });
    const result = await runLiveCase(10, stage);
    expect(stage.freshCalls.length).toBeGreaterThanOrEqual(2);
    expect(stage.listedCalls).toBe(1);
    // With nobody refused as counted, it can't claim the rule that's left once Switch lets the account through.
    expect(result.outcome).toBe("not prevented");
    expect(result.why).toContain("refused as already counted");
  });

  it("carries what differs from the isolated run, and the case's title", async () => {
    const result = await runLiveCase(14, new FakeStage({ dead: true }));
    expect(result.title).toBe(CASES.find((one) => one.id === 14)?.title);
    expect(result.differs).toBe(LIVE_NOTES[14]);
  });

  it("starts each case from a fresh world, because who asked lingers for 10 minutes", async () => {
    const stage = new FakeStage({ dead: true });
    await runLiveCase(14, stage);
    expect(stage.freshCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("runs case 8 on the demo's faster clock, and says so", async () => {
    const stage = new FakeStage({ dead: true });
    await runLiveCase(8, stage);
    expect(stage.freshCalls[0]).toMatchObject({ timeScale: 10 });
    expect(LIVE_NOTES[8]).toMatch(/time scale 10|CLEARANCE_TIME_SCALE=10/);
  });

  it("turns an unexpected error into not prevented, never a pass", async () => {
    const stage = new FakeStage({ dead: true });
    stage.gate = async () => {
      throw new Error("the gate fell over");
    };
    const result = await runLiveCase(3, stage);
    expect(result.outcome).toBe("not prevented");
    expect(result.why).toContain("the gate fell over");
  });

  it("fails a case whose ledger no longer verifies, whatever else it saw", async () => {
    const stage = new FakeStage({ dead: true });
    stage.ledgerVerifies = async () => false;
    const result = await runLiveCase(14, stage);
    expect(result.outcome).not.toBe("prevented");
  });
});

describe("the summary", () => {
  it("counts what ran, what was prevented and what stayed out, from the rows", () => {
    expect(
      summariseLive(
        [
          { id: 1, outcome: "prevented", why: "" },
          { id: 2, outcome: "not prevented", why: "" },
          { id: 3, outcome: "blocked", why: "" },
          { id: "1-private-chat", outcome: "prevented", why: "" },
        ],
        [{ id: 10 }],
        25,
      ),
    ).toEqual({ cases: 25, ran: 2, prevented: 1, not_prevented: 1, blocked: 1, not_run: 1 });
  });
});

describe("how a person answers a card", () => {
  const buttons = ["1. Approve", "2. Deny"];

  it("presses Approve on a plain card", () => {
    expect(answerPlan({ text: "Permission needed", buttons, handle: "A1" }, "allow")).toEqual({
      kind: "press",
      button: "1. Approve",
    });
  });

  it("presses Deny on a plain card", () => {
    expect(answerPlan({ text: "Permission needed", buttons, handle: "A1" }, "deny")).toEqual({
      kind: "press",
      button: "2. Deny",
    });
  });

  it("types what a type-to-confirm card asks for, read off the card", () => {
    const text = "CLR-0001 · REFUND ₹150,000 · CRITICAL\nto approve, type the refund amount";
    expect(answerPlan({ text, buttons: ["1. Deny"], handle: "A3" }, "allow")).toEqual({
      kind: "type",
      message: 'A3 "150000"',
    });
  });

  it("presses the card's own No on a type-to-confirm card", () => {
    const text = "to approve, type the refund amount";
    expect(answerPlan({ text, buttons: ["1. Deny"], handle: "A3" }, "deny")).toEqual({
      kind: "press",
      button: "1. Deny",
    });
  });

  it("says when a card has nothing left to press, because a card takes one answer", () => {
    expect(answerPlan({ text: "**Approve** · request A1", buttons: [], handle: "A1" }, "allow")).toEqual({
      kind: "none",
      why: "the card has no buttons left",
    });
  });
});
