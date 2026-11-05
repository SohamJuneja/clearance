/** F9: a drill looks like a real request, never runs anything, and tells only the person who answered it. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/api/server.js";
import { drillRateFromEnv, loadFlaws, rollsDrill } from "../src/drills/library.js";
import type { OpenedCard } from "./fakes.js";
import {
  chatMessage,
  DRILLS_PATH,
  gateRefund,
  makeHarness,
  MINUTE,
  PARTICIPANTS,
  POLICY_PATH,
  REFUND_SC4,
  type Harness,
} from "./harness.js";

const TOKEN = "test-internal-token";
let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.core.close());

const press = (card: OpenedCard, who: string, answer = "allow") =>
  h.core.onApprovalOutcome({
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "approval",
    state: "answered",
    answer,
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  });

const send = async (person: string, flaw?: string) => {
  const result = await h.core.sendDrill(person, flaw);
  if (!result.ok) throw new Error(result.reason);
  return result.requestId;
};

const types = (id: string) => h.core.stores.ledger.list({ requestId: id }).map((entry) => entry.type);

function withPolicy(edit: (text: string) => string): string {
  const path = join(mkdtempSync(join(tmpdir(), "clearance-drill-policy-")), "policy.yaml");
  writeFileSync(path, edit(readFileSync(POLICY_PATH, "utf8")));
  return path;
}

describe("CLEARANCE_DRILL_RATE", () => {
  it("is the policy's rate when unset or blank", () => {
    expect(drillRateFromEnv(undefined)).toBeUndefined();
    expect(drillRateFromEnv("")).toBeUndefined();
    expect(drillRateFromEnv("  ")).toBeUndefined();
  });

  it("reads a rate from 0 to 1", () => {
    expect(drillRateFromEnv("0")).toBe(0);
    expect(drillRateFromEnv("0.25")).toBe(0.25);
    expect(drillRateFromEnv("1")).toBe(1);
  });

  it.each(["2", "-1", "lots", "5%"])("refuses %s, rather than guessing what a take should do", (value) => {
    expect(() => drillRateFromEnv(value)).toThrow(/CLEARANCE_DRILL_RATE/);
  });

  describe("in core", () => {
    let other: Harness;
    afterEach(() => other.core.close());

    /** Cancelled straight after, so a pile of open cards isn't what stops the drill. */
    const hold = async (index: number) => {
      const held = await other.core.check(gateRefund({ ...REFUND_SC4, amount: 40000 + index }));
      await other.core.cancel(held.request_id as string, null);
    };
    const drills = () => other.core.stores.drills.summary("sam").sent;

    it("0 means no natural drill, however many holds, where the policy's rate would have sent one", async () => {
      other = makeHarness({ rollDrills: true, drillRate: 0 });
      for (let index = 0; index < 60; index += 1) await hold(index);
      expect(drills()).toBe(0);
    }, 30_000);

    it("1 overrides the policy the other way", async () => {
      other = makeHarness({ rollDrills: true, drillRate: 1 });
      await hold(0);
      expect(drills()).toBe(1);
    });

    it("0 leaves POST /v1/drills/send working", async () => {
      other = makeHarness({ rollDrills: true, drillRate: 0 });
      expect(await other.core.sendDrill("sam")).toMatchObject({ ok: true });
    });

    it("unset, the policy's rate applies", async () => {
      other = makeHarness({ rollDrills: true });
      expect(other.core.policy().file.drills?.rate).toBe(0.05);
      for (let index = 0; index < 60; index += 1) await hold(index);
      expect(drills()).toBeGreaterThan(0);
    }, 30_000);
  });
});

describe("the flaw library", () => {
  const flaws = loadFlaws(DRILLS_PATH);

  it("covers every flaw PLAN F9 lists", () => {
    expect(flaws.map((flaw) => flaw.id).sort()).toEqual([
      "amount_10x",
      "bulk_export",
      "delete_no_backup",
      "failing_checks",
      "merge_disables_auth",
      "new_destination",
      "text_mismatch",
    ]);
  });

  it.each(flaws.map((flaw) => [flaw.id, flaw] as const))("%s holds, with the flag it claims", async (id, flaw) => {
    const person = { refund: "sam", deploy: "alex", customer_email: "priya", delete: "dev", merge: "dev" }[flaw.class] as string;
    const requestId = await send(person, id);
    const request = h.core.stores.requests.require(requestId);
    expect(request.cls).toBe(flaw.class);
    expect(request.flags.map((entry) => entry.code)).toContain(flaw.flag);
    expect(h.chat.cards).toHaveLength(1);
  });

  it("refuses a malformed library, naming the problem", () => {
    const path = join(mkdtempSync(join(tmpdir(), "clearance-drill-lib-")), "flaws.yaml");
    writeFileSync(path, "flaws:\n  - { id: x }\n");
    expect(() => loadFlaws(path)).toThrow(/class|flag/);
  });
});

describe("a drill looks like a real request", () => {
  /** Anything that is a value rather than the shape of the card. What remains must be identical. */
  const mask = (text: string) =>
    text
      .replace(/CLR-\d+/g, "CLR")
      .replace(/₹[\d,]+/g, "₹")
      .replace(/\bcus_\w+/g, "cus")
      .replace(/\bA-\d+/g, "ORDER")
      .replace(/[\w.]+@\w+/g, "UPI")
      .replace(/customer [^(\n]+\(/g, "customer (")
      .replace(/\d+ (minutes?|hours?|days?) ago/g, "AGO")
      .replace(/refunds today: .*/g, "refunds today: N");

  async function pair(): Promise<{ real: OpenedCard; drill: OpenedCard }> {
    // The same shape as the drill: an order paid in full, to a destination added minutes ago.
    h.lookup.world = {
      orders: { "A-9": { id: "A-9", total: 15000 } },
      customers: { cus_1: { id: "cus_1", name: "Real Customer" } },
      destinations: { "real@okaxis": { id: "real@okaxis", age_hours: 0.1 } },
    };
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    await h.core.check(gateRefund({ order_id: "A-9", customer_id: "cus_1", amount: 15000, destination: "real@okaxis" }));
    const real = h.chat.cardIn("dm-sam");
    await send("sam", "new_destination");
    const drill = h.chat.cards.filter((card) => card.roomId === "dm-sam")[1] as OpenedCard;
    return { real, drill };
  }

  it("uses the same card, line for line, apart from values", async () => {
    const { real, drill } = await pair();
    expect(mask(drill.detail).split("\n")).toEqual(mask(real.detail).split("\n"));
    expect(mask(drill.title)).toEqual(mask(real.title));
    expect(mask(drill.detail)).toMatchSnapshot();
  });

  it("uses the same form and the same lifetime", async () => {
    const { real, drill } = await pair();
    expect(drill.kind).toBe(real.kind);
    expect(drill.options).toEqual(real.options);
    expect(drill.questions).toEqual(real.questions);
    expect(drill.expiresAtMs).toBe(real.expiresAtMs);
  });

  it("is told to the approver the same way", async () => {
    await pair();
    const [real, drill] = h.chat.targeted.filter((message) => message.roomId === "dm-sam");
    expect(mask(drill?.body as string)).toEqual(mask(real?.body as string));
  });

  it("takes its id from the same counter, so the number gives nothing away", async () => {
    const real = await h.core.check(gateRefund(REFUND_SC4));
    const drill = await send("sam", "new_destination");
    expect(real.request_id).toBe("CLR-0001");
    expect(drill).toBe("CLR-0002");
  });

  it("does not say it is a drill while it is open, on any route an approver or the Desk reads", async () => {
    const id = await send("sam");
    expect(h.core.describeRequest(id)).not.toHaveProperty("is_drill");
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, `@clearance why ${id}`, { addressed: true, threadId: null }));
    expect(h.chat.messages.at(-1)?.body).not.toMatch(/drill|practice/i);
    const entry = h.core.stores.ledger.list({ requestId: id })[0];
    expect(entry?.type).toBe("drill_sent");
    expect(JSON.stringify(entry?.payload)).not.toContain("new_destination");
  });

  it("appears in the person's inbox like anything else", async () => {
    const id = await send("sam");
    expect(h.core.inbox("sam")?.items.map((item) => item.request_id)).toEqual([id]);
  });
});

describe("approving a drill", () => {
  it("calls nothing on the gate, ever", async () => {
    const id = await send("sam");
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(h.gate.calls).toEqual([]);
    h.clock.advance(MINUTE);
    await h.core.tick();
    expect(h.gate.calls).toEqual([]);
    expect(h.core.stores.requests.require(id).state).toBe("VOIDED");
  });

  it("reads nothing from real systems of record", async () => {
    await send("sam");
    expect(h.lookup.calls).toEqual([]);
  });

  it("tells that person, privately, in the exact copy", async () => {
    await send("sam", "new_destination");
    h.clock.advance(1800);
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(h.chat.messages).toEqual([
      {
        roomId: "dm-sam",
        body: "That was a practice request; nothing ran. The flaw: the payout destination was added 3 minutes before the request. You decided in 1.8 s. Your next high-risk card will ask you to type a detail.",
      },
    ]);
    expect(h.chat.targeted.filter((message) => message.roomId !== "dm-sam")).toEqual([]);
  });

  it("makes their next high-risk card ask for a typed value", async () => {
    await send("sam");
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam);
    await h.core.check(gateRefund(REFUND_SC4));
    const next = h.chat.cards.filter((card) => card.roomId === "dm-sam").at(-1) as OpenedCard;
    expect(next.kind).toBe("questions");
    expect(next.questions[0]?.prompt).toMatch(/type the/i);
  });

  it("records drill_* in the ledger and nothing that reads as a real decision", async () => {
    const id = await send("sam", "new_destination");
    h.clock.advance(2000);
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(types(id)).toEqual(["drill_sent", "drill_result"]);
    expect(h.core.stores.ledger.list({ requestId: id }).at(-1)?.payload).toMatchObject({
      result: "missed",
      user_id: "sam",
      flaw: "new_destination",
      latency_ms: 2000,
    });
    expect(h.core.verifyLedger().ok).toBe(true);
  });

  it("works through a typed card too, when that is what they were owed", async () => {
    h.core.people.store.setFriction("sam", "fast_approval");
    const id = await send("sam", "new_destination");
    const card = h.chat.cardIn("dm-sam");
    expect(card.kind).toBe("questions");
    await h.core.onApprovalOutcome({
      sessionId: card.sessionId,
      switchRequestId: card.switchRequestId,
      kind: "questions",
      state: "answered",
      answer: null,
      answers: [{ question_id: card.questions[0]?.id, custom_text: "12500", selected_option_ids: [] }],
      answeredBy: PARTICIPANTS.sam,
      answeredAtMs: h.clock.nowMs(),
    });
    expect(h.gate.calls).toEqual([]);
    expect(h.core.stores.requests.require(id).state).toBe("VOIDED");
    expect(h.chat.messages.at(-1)?.body).toContain("practice request");
  });
});

describe("denying a drill", () => {
  it("says good catch, privately, in the exact copy, and adds no friction", async () => {
    const id = await send("sam", "new_destination");
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "deny");
    expect(h.chat.messages).toEqual([
      { roomId: "dm-sam", body: "Good catch. That was a practice request; the flaw was the new destination." },
    ]);
    expect(h.core.stores.requests.require(id).state).toBe("DENIED");
    expect(types(id)).toEqual(["drill_sent", "drill_result"]);
    expect(h.core.stores.ledger.list({ requestId: id }).at(-1)?.payload).toMatchObject({ result: "caught" });
    expect(h.core.people.store.friction("sam")).toBeNull();
  });
});

describe("what a drill leaves out", () => {
  it("tells no agent and no room", async () => {
    await send("sam");
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(h.chat.targeted.flatMap((message) => message.targets)).toEqual(["sam"]);
    expect(h.chat.cards.map((card) => card.roomId)).toEqual(["dm-sam"]);
  });

  it("does not escalate to anyone else, and when it expires tells nobody", async () => {
    const id = await send("sam");
    h.clock.advance(26 * MINUTE);
    await h.core.tick();
    expect(h.chat.cards.map((card) => card.roomId)).toEqual(["dm-sam"]);
    expect(h.core.stores.requests.require(id).state).toBe("EXPIRED");
    expect(h.chat.messages).toEqual([]);
    expect(h.chat.targeted.filter((message) => message.body.includes("expired"))).toEqual([]);
    expect(types(id)).toEqual(["drill_sent", "drill_result"]);
    expect(h.core.stores.ledger.list({ requestId: id }).at(-1)?.payload).toMatchObject({ result: "expired" });
  });

  it("does not count in real metrics: stats, 24 h sums, coverage or the open count", async () => {
    await send("sam");
    expect(h.core.health().open_requests).toBe(0);
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(h.core.personStats("sam")).toMatchObject({ answers: 0, approvals: 0, denials: 0 });
    expect(h.core.coverage().vendors).toEqual([]);
    expect(h.core.stores.aggregates.sum("refund", "customer", "cus_4410", 0)).toBe(0);
  });

  it("does not re-route when someone else's press uses up the card", async () => {
    await send("sam");
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.priya);
    expect(h.chat.cards.map((card) => card.roomId)).toEqual(["dm-sam"]);
  });
});

describe("catch rate", () => {
  it("goes in the person's stats, and only theirs", async () => {
    await send("sam", "new_destination");
    await press(h.chat.cards[0] as OpenedCard, PARTICIPANTS.sam, "deny");
    h.clock.advance(25 * 3_600_000);
    await send("sam", "amount_10x");
    await press(h.chat.cards[1] as OpenedCard, PARTICIPANTS.sam);
    expect(h.core.personStats("sam")?.drills).toEqual({ sent: 2, caught: 1, missed: 1, expired: 0, catch_rate: 0.5 });
    expect(h.core.personStats("neha")?.drills).toEqual({ sent: 0, caught: 0, missed: 0, expired: 0, catch_rate: null });
  });
});

describe("when a drill may be sent", () => {
  it("needs the team's opt-in", async () => {
    h.core.close();
    h = makeHarness({ policyPath: withPolicy((text) => text.replace("drills:\n  enabled: true", "drills:\n  enabled: false")) });
    expect(await h.core.sendDrill("sam")).toEqual({ ok: false, reason: "drills are off for this team" });
    expect(h.chat.cards).toEqual([]);
  });

  it("sends at most one per person per day", async () => {
    await send("sam");
    expect(await h.core.sendDrill("sam")).toEqual({ ok: false, reason: "sam already had a drill today" });
    expect(await h.core.sendDrill("neha")).toMatchObject({ ok: true });
    h.clock.advance(24 * 3_600_000 + 1);
    expect(await h.core.sendDrill("sam")).toMatchObject({ ok: true });
  });

  it("never sends during an open incident", async () => {
    h.core.stores.incidents.add({ requestId: "CLR-0001", reportedBy: "sam", note: "x", atMs: h.clock.nowMs() });
    expect(await h.core.sendDrill("sam")).toEqual({ ok: false, reason: "there is an open incident" });
    h.clock.advance(24 * 3_600_000 + 1);
    expect(await h.core.sendDrill("sam")).toMatchObject({ ok: true });
  });

  it("never sends to someone with more than 3 open cards", async () => {
    for (let index = 0; index < 4; index += 1) {
      await h.core.check(gateRefund({ ...REFUND_SC4, amount: 40000 + index }));
    }
    expect(await h.core.sendDrill("sam")).toEqual({ ok: false, reason: "sam has more than 3 open cards" });
  });

  it("sends with exactly 3 open cards", async () => {
    for (let index = 0; index < 3; index += 1) {
      await h.core.check(gateRefund({ ...REFUND_SC4, amount: 40000 + index }));
    }
    expect(await h.core.sendDrill("sam")).toMatchObject({ ok: true });
  });

  it("picks a flaw that person can answer, and refuses when there is none", async () => {
    const id = await send("priya");
    expect(h.core.stores.requests.require(id).cls).toBe("customer_email");
    expect(await h.core.sendDrill("sam", "failing_checks")).toEqual({ ok: false, reason: "failing_checks is not something sam can approve" });
    expect(await h.core.sendDrill("sam", "no_such_flaw")).toEqual({ ok: false, reason: "no flaw named no_such_flaw" });
    expect(await h.core.sendDrill("nobody")).toEqual({ ok: false, reason: "no person nobody" });
  });

  it("rotates through the flaws a person can answer", async () => {
    for (let index = 0; index < 3; index += 1) {
      await send("sam");
      h.clock.advance(24 * 3_600_000 + 1);
    }
    const flaws = h.core.stores.drills.forPerson("sam").map((row) => row.flaw_id);
    expect(new Set(flaws).size).toBe(3);
  });

  it("never asks the person who gets it to be the one who asked", async () => {
    const id = await send("priya");
    expect(h.core.stores.requests.require(id).requesterIds).not.toContain("priya");
  });

  it("cleans up when Switch is down, rather than leaving a request nobody will ever see", async () => {
    h.chat.failOpenCard = true;
    const result = await h.core.sendDrill("sam");
    expect(result).toMatchObject({ ok: false });
    expect(h.core.stores.requests.listInState(["HELD", "ROUTED"])).toEqual([]);
    h.chat.failOpenCard = false;
    await h.core.tick();
    expect(h.chat.cards).toEqual([]);
  });
});

describe("the rate", () => {
  it("is deterministic: the same request and policy always roll the same", () => {
    expect(rollsDrill("CLR-0042", "hash", 0.5)).toBe(rollsDrill("CLR-0042", "hash", 0.5));
  });

  it("comes out near the rate over many requests, with no randomness involved", () => {
    const ids = Array.from({ length: 4000 }, (_, index) => `CLR-${index}`);
    const hits = ids.filter((id) => rollsDrill(id, "hash", 0.05)).length;
    expect(hits).toBeGreaterThan(4000 * 0.03);
    expect(hits).toBeLessThan(4000 * 0.07);
  });

  it("never fires at rate 0 and always at rate 1", () => {
    expect(rollsDrill("CLR-1", "hash", 0)).toBe(false);
    expect(rollsDrill("CLR-1", "hash", 1)).toBe(true);
  });

  describe("on a real hold", () => {
    const always = () => withPolicy((text) => text.replace("rate: 0.05", "rate: 1"));

    it("sends the person routed to a drill alongside it", async () => {
      h.core.close();
      h = makeHarness({ policyPath: always(), rollDrills: true });
      await h.core.check(gateRefund(REFUND_SC4));
      expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(2);
      expect(h.core.stores.drills.forPerson("sam")).toHaveLength(1);
    });

    it("respects the per-person limit", async () => {
      h.core.close();
      h = makeHarness({ policyPath: always(), rollDrills: true });
      await h.core.check(gateRefund(REFUND_SC4));
      await h.core.check(gateRefund({ ...REFUND_SC4, amount: 40001 }));
      expect(h.core.stores.drills.forPerson("sam")).toHaveLength(1);
    });

    it("skips classes the policy does not drill", async () => {
      h.core.close();
      h = makeHarness({ policyPath: always(), rollDrills: true });
      await h.core.check({
        ...gateRefund(),
        business: { endpoint: "POST /acme/payouts/destinations", args: { customer_id: "cus_1", upi: "a@b" } },
      });
      expect(h.core.stores.drills.forPerson("sam")).toEqual([]);
    });

    it("sends none at rate 0", async () => {
      h.core.close();
      h = makeHarness({ policyPath: withPolicy((text) => text.replace("rate: 0.05", "rate: 0")), rollDrills: true });
      await h.core.check(gateRefund(REFUND_SC4));
      expect(h.core.stores.drills.forPerson("sam")).toEqual([]);
    });
  });
});

describe("POST /v1/drills/send", () => {
  let app: FastifyInstance;
  const post = (payload: unknown, token = TOKEN) =>
    app.inject({ method: "POST", url: "/v1/drills/send", headers: { authorization: `Bearer ${token}` }, payload: payload as object });

  beforeEach(async () => {
    app = buildServer(h.core, { internalToken: TOKEN });
    await app.ready();
  });
  afterEach(() => app.close());

  it("sends one and says which", async () => {
    const response = await post({ person: "sam", flaw: "new_destination" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ request_id: "CLR-0001" });
    expect(h.chat.cardIn("dm-sam").detail).toContain("Ananya R.");
  });

  it("takes approver too, which the demo client sends", async () => {
    expect((await post({ approver: "sam" })).statusCode).toBe(200);
  });

  it("needs the internal token", async () => {
    expect((await post({ person: "sam" }, "nope")).statusCode).toBe(401);
  });

  it("answers 400 with no person, 404 for an unknown one, and 409 with the reason when it may not send", async () => {
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ person: "nobody" })).statusCode).toBe(404);
    await post({ person: "sam" });
    const again = await post({ person: "sam" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("sam already had a drill today");
  });

  it("puts catch rate in GET /v1/people/:id/stats", async () => {
    await post({ person: "sam" });
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "deny");
    const stats = await app.inject({ method: "GET", url: "/v1/people/sam/stats", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(stats.json().drills).toMatchObject({ caught: 1, catch_rate: 1 });
  });
});

describe("SC9 end to end", () => {
  it("Sam approves fast, nothing runs, and the next real card asks for a typed value", async () => {
    await send("sam", "new_destination");
    h.clock.advance(1800);
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(h.chat.messages.at(-1)?.body).toMatch(/practice request/i);
    expect(h.gate.calls).toEqual([]);
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full"));
    await h.core.check(gateRefund(REFUND_SC4));
    const card = h.chat.cards.filter((entry) => entry.roomId === "dm-sam").at(-1) as OpenedCard;
    expect(card.questions[0]?.prompt).toMatch(/type the/i);
  });
});
