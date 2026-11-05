/** F5: the ladder runs on timers stored in SQLite, driven by tick and Clock, and every step is in the ledger. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatMessage, gateRefund, hookShell, makeHarness, MINUTE, PARTICIPANTS, REFUND_SC4, type Harness } from "./harness.js";
import type { OpenedCard } from "./fakes.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.core.close());

/** Priya asks refunds-agent for SC4. High tier, quorum 1: Sam has the card, Neha is the backup. */
async function held(): Promise<string> {
  await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full"));
  const response = await h.core.check(gateRefund(REFUND_SC4));
  return response.request_id as string;
}

async function advance(ms: number): Promise<void> {
  h.clock.advance(ms);
  await h.core.tick();
}

const press = (card: OpenedCard, who: string, answer: string) =>
  h.core.onApprovalOutcome({
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "approval",
    state: "answered",
    answer,
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  });

const escalations = (id: string) => h.core.stores.ledger.list({ requestId: id }).filter((entry) => entry.type === "escalated");

describe("the refund ladder", () => {
  it("does nothing before the first step is due", async () => {
    const id = await held();
    await advance(3 * MINUTE - 1);
    expect(h.chat.cards.map((card) => card.roomId)).toEqual(["dm-sam", "#support"]);
    expect(escalations(id)).toEqual([]);
  });

  it("3 minutes: the backup approver gets a card, told in the Appendix D words", async () => {
    const id = await held();
    await advance(3 * MINUTE);
    const card = h.chat.cardIn("dm-neha");
    expect(card.detail).toContain("Why you: backup finance approver.");
    expect(h.chat.targeted.at(-1)).toEqual({
      roomId: "dm-neha",
      targets: ["neha"],
      body: `${id} has waited 3 minutes. Neha, you're the backup finance approver. The card is just above.`,
    });
    expect(escalations(id).map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ step: 0, kind: "add", added: "neha", after_ms: 3 * MINUTE }),
    ]);
  });

  it("leaves Sam's card open: either of them can decide", async () => {
    const id = await held();
    await advance(3 * MINUTE);
    expect(h.chat.cardIn("dm-sam").closed).toBe(false);
    await press(h.chat.cardIn("dm-neha"), PARTICIPANTS.neha, "allow");
    expect(h.core.stores.requests.require(id).state).toBe("EXECUTED");
    expect(h.gate.calls).toHaveLength(1);
    expect(h.chat.cardIn("dm-sam").closed).toBe(true);
  });

  it("8 minutes: a card in #approvals, and everyone eligible is told", async () => {
    const id = await held();
    await advance(3 * MINUTE);
    await advance(5 * MINUTE);
    expect(h.chat.cardIn("#approvals").title).toContain(id);
    expect(h.chat.targeted.at(-1)).toEqual({
      roomId: "#approvals",
      targets: ["sam", "neha"],
      body: `${id} has waited 8 minutes. @finance-approvers: the card is just above.`,
    });
    expect(escalations(id).at(-1)?.payload).toMatchObject({ step: 1, kind: "post", room: "#approvals" });
  });

  it("counts a card answered in #approvals like any other, and still refuses the requester there", async () => {
    const id = await held();
    await advance(8 * MINUTE);
    await press(h.chat.cardIn("#approvals"), PARTICIPANTS.priya, "allow");
    expect(h.gate.calls).toEqual([]);
    expect(h.core.stores.requests.require(id).state).toBe("ROUTED");
  });

  it("20 minutes: the requester hears it is still waiting and when it ends", async () => {
    const id = await held();
    await advance(20 * MINUTE);
    expect(h.chat.targeted.at(-1)).toEqual({
      roomId: "#support",
      threadId: "t-77",
      targets: ["priya"],
      body: `${id} has waited 20 minutes with no decision. Priya, it expires at 14:25 IST.`,
    });
    expect(escalations(id).at(-1)?.payload).toMatchObject({ step: 2, kind: "notify", notified: ["priya"] });
  });

  it("fires every step that is due on one tick, in order, each exactly once", async () => {
    const id = await held();
    await advance(20 * MINUTE);
    expect(escalations(id).map((entry) => entry.payload.step)).toEqual([0, 1, 2]);
    await h.core.tick();
    await advance(1000);
    expect(escalations(id)).toHaveLength(3);
    expect(h.chat.cards.filter((card) => card.roomId === "dm-neha")).toHaveLength(1);
  });

  it("does nothing once the request is decided", async () => {
    const id = await held();
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "deny");
    await advance(20 * MINUTE);
    expect(escalations(id)).toEqual([]);
    expect(h.chat.cards.some((card) => card.roomId === "dm-neha")).toBe(false);
  });

  it("does not add a backup when everyone already has a card, and says so in the ledger", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    const critical = await h.core.check(
      gateRefund({ order_id: "A-2004", customer_id: "cus_2044", amount: 150000, destination: "rohan.s@okhdfc" }),
    );
    const id = critical.request_id as string;
    await advance(3 * MINUTE);
    expect(h.chat.cards.filter((card) => card.roomId === "dm-neha")).toHaveLength(1);
    expect(escalations(id)[0]?.payload).toMatchObject({ step: 0, kind: "add", added: null });
  });

  it("does not pick someone excluded as the backup", async () => {
    h.core.people.store.setAway("neha", h.clock.nowMs() + 60 * MINUTE, null);
    const id = await held();
    await advance(3 * MINUTE);
    expect(h.chat.cards.some((card) => card.roomId === "dm-neha")).toBe(false);
    expect(escalations(id)[0]?.payload).toMatchObject({ added: null });
  });

  it("retries a step when Switch is down, rather than losing it", async () => {
    const id = await held();
    h.chat.failOpenCard = true;
    await advance(3 * MINUTE);
    expect(escalations(id)).toEqual([]);
    h.chat.failOpenCard = false;
    await advance(1000);
    expect(h.chat.cardIn("dm-neha").title).toContain(id);
    expect(escalations(id)).toHaveLength(1);
  });

  it("does not stop the ladder when one request's step throws", async () => {
    const first = await held();
    h.chat.ensureDirectRoom = async () => {
      throw new Error("switch hiccup");
    };
    await advance(3 * MINUTE);
    expect(escalations(first)).toEqual([]);
    await expect(h.core.tick()).resolves.toBeUndefined();
  });
});

describe("the deploy ladder", () => {
  it("posts to #eng at 10 minutes with no mention text", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@ops-agent ship it", { roomId: "#ops", threadId: null }));
    const response = await h.core.check({
      ...gateRefund(REFUND_SC4),
      agent: { name: "ops-agent" },
      session: { switchRoomId: "#ops" },
      business: { endpoint: "POST /acme/deploys", args: { service: "checkout", env: "prod", version: "v2.13.2" } },
    });
    const id = response.request_id as string;
    await advance(10 * MINUTE);
    expect(h.chat.cardIn("#eng").title).toContain(id);
    expect(h.chat.targeted.at(-1)).toMatchObject({ roomId: "#eng", body: `${id} has waited 10 minutes. The card is just above.` });
  });

  it("does not open a second card in a room that already has one", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@ops-agent ship it", { roomId: "#eng", threadId: null }));
    await h.core.check({
      ...gateRefund(REFUND_SC4),
      agent: { name: "ops-agent" },
      session: { switchRoomId: "#eng" },
      business: { endpoint: "POST /acme/deploys", args: { service: "checkout", env: "prod", version: "v2.13.2" } },
    });
    await advance(10 * MINUTE);
    expect(h.chat.cards.filter((card) => card.roomId === "#eng")).toHaveLength(1);
  });
});

describe("expiry fails closed", () => {
  it("at 25 minutes: denied, cards closed, the requester told in the Appendix D words", async () => {
    const id = await held();
    await advance(25 * MINUTE);
    expect(h.core.stores.requests.require(id).state).toBe("EXPIRED");
    expect(h.chat.openCards()).toEqual([]);
    expect(h.chat.targeted.at(-1)).toEqual({
      roomId: "#support",
      threadId: "t-77",
      targets: ["refunds-agent", "priya"],
      body: `${id} expired after 25 minutes with no eligible answer. Nothing was executed. Priya, ask again if it's still needed.`,
    });
    expect(h.core.stores.ledger.list({ requestId: id }).at(-1)?.type).toBe("expired");
  });

  it("never executes an expired request: the gate is not called, even if an approval arrives later", async () => {
    const id = await held();
    const card = h.chat.cardIn("dm-sam");
    await advance(25 * MINUTE);
    await press(card, PARTICIPANTS.sam, "allow");
    expect(h.gate.calls).toEqual([]);
    expect(h.core.stores.requests.require(id).state).toBe("EXPIRED");
    expect(h.chat.messages.at(-1)?.body).toBe(`${id} is already decided (EXPIRED). That answer changed nothing.`);
  });

  it("tells the agent when nobody is known to have asked", async () => {
    const response = await h.core.check(gateRefund(REFUND_SC4));
    const id = response.request_id as string;
    await advance(25 * MINUTE);
    expect(h.chat.targeted.at(-1)).toMatchObject({
      targets: ["refunds-agent"],
      body: `${id} expired after 25 minutes with no eligible answer. Nothing was executed. Ask again if it's still needed.`,
    });
  });

  it("expires a request nobody could ever approve", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@coder push", { roomId: "#eng", threadId: "t-1" }));
    const response = await h.core.check(hookShell("git push --force origin main"));
    await advance(25 * MINUTE);
    expect(h.core.stores.requests.require(response.request_id as string).state).toBe("EXPIRED");
  });

  it("says the policy's minutes under a scaled clock, while using scaled time", async () => {
    h.core.close();
    h = makeHarness({ scale: 10 });
    const id = await held();
    await advance(2.5 * MINUTE);
    expect(h.core.stores.requests.require(id).state).toBe("EXPIRED");
    expect(h.chat.targeted.at(-1)?.body).toContain("expired after 25 minutes");
  });
});

describe("timers survive a restart", () => {
  it("fires a step that came due while core was down", async () => {
    const id = await held();
    h = h.restart();
    h.clock.advance(3 * MINUTE);
    await h.core.tick();
    expect(h.chat.cardIn("dm-neha").title).toContain(id);
    expect(escalations(id)).toHaveLength(1);
  });

  it("does not repeat a step that already fired before the restart", async () => {
    const id = await held();
    await advance(3 * MINUTE);
    h = h.restart();
    await advance(1000);
    expect(escalations(id)).toHaveLength(1);
    expect(h.chat.cards.filter((card) => card.roomId === "dm-neha")).toHaveLength(1);
  });

  it("expires after a restart, and an old card's answer is still refused", async () => {
    const id = await held();
    const card = h.chat.cardIn("dm-sam");
    h = h.restart();
    h.clock.advance(30 * MINUTE);
    await h.core.tick();
    expect(h.core.stores.requests.require(id).state).toBe("EXPIRED");
    await press(card, PARTICIPANTS.sam, "allow");
    expect(h.gate.calls).toEqual([]);
  });

  it("keeps the ladder a request started with, whatever the policy says later", async () => {
    const id = await held();
    const row = h.core.stores.db.prepare(`SELECT COUNT(*) AS n FROM timers WHERE request_id = ?`).get(id) as { n: number };
    expect(row.n).toBe(3);
  });

  it("scales the ladder with the clock, and says the policy's minutes", async () => {
    h.core.close();
    h = makeHarness({ scale: 10 });
    const id = await held();
    await advance(18_000);
    expect(h.chat.targeted.at(-1)?.body).toBe(`${id} has waited 3 minutes. Neha, you're the backup finance approver. The card is just above.`);
  });
});

describe("tick", () => {
  it("does not run two at once, since main calls it every second", async () => {
    await held();
    h.clock.advance(3 * MINUTE);
    await Promise.all([h.core.tick(), h.core.tick()]);
    expect(h.chat.cards.filter((card) => card.roomId === "dm-neha")).toHaveLength(1);
  });

  it("keeps the ledger verifiable through the whole ladder", async () => {
    await held();
    await advance(26 * MINUTE);
    expect(h.core.verifyLedger().ok).toBe(true);
  });
});
