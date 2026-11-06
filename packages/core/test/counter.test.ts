/**
 * F20, approve with edits. An eligible approver offers a smaller amount with a command, confirms it on a question card,
 * and a new call runs through the gate. The original is closed as edited. No existing card changes, so all of this has
 * to be reachable without a new button.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { bucketStats, F11_CRITERIA, meetsPromotion } from "../src/autonomy/promotion.js";
import type { NewBucketEvent } from "../src/autonomy/history.js";
import { PROMPT_BUDGET, renderedCost } from "../src/cards/render.js";
import { loadPolicy, type CompiledPolicy } from "../src/policy/load.js";
import type { OpenedCard } from "./fakes.js";
import {
  chatMessage,
  gateRefund,
  hookShell,
  makeHarness,
  MINUTE,
  PARTICIPANTS,
  POLICY_PATH,
  REFUND_BOTH_FLAGS,
  REFUND_CRITICAL,
  REFUND_SC4,
  type Harness,
} from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.core.close());

const say = (who: string, body: string, roomId = "#finance") =>
  h.core.onMessage(chatMessage(who, body, { addressed: true, roomId, threadId: undefined as unknown as string }));
const counter = (who: string, reference: string, amount: string, roomId?: string) => say(who, `@clearance counter ${reference} ${amount}`, roomId);

const answer = (card: OpenedCard, who: string, entry: Record<string, unknown>) =>
  h.core.onApprovalOutcome({
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "questions",
    state: "answered",
    answer: null,
    answers: [{ question_id: card.questions[0]?.id ?? "x", ...entry }],
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  });
const typed = (card: OpenedCard, who: string, text: string) => answer(card, who, { custom_text: text, selected_option_ids: [] });
const declined = (card: OpenedCard, who: string) => answer(card, who, { custom_text: null, selected_option_ids: ["deny"] });
const press = (card: OpenedCard, who: string, choice = "allow") =>
  h.core.onApprovalOutcome({
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "approval",
    state: "answered",
    answer: choice,
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  });

const counterCards = () => h.chat.cards.filter((card) => card.title.includes("COUNTER"));
const lastCounterCard = () => counterCards().at(-1) as OpenedCard;
const plainCards = (roomId: string) => h.chat.cards.filter((card) => card.roomId === roomId && !card.title.includes("COUNTER"));
const replies = () => h.chat.messages.map((message) => message.body);
const lastReply = () => h.chat.messages.at(-1)?.body ?? "";
const toAgent = () => h.chat.targeted.filter((message) => message.targets.includes("refunds-agent")).map((message) => message.body);
const state = (id: string) => h.core.stores.requests.require(id).state;
const ledger = (id: string) => h.core.stores.ledger.list({ requestId: id });
const entry = (id: string, type: string) => ledger(id).find((row) => row.type === type);
const types = (id: string) => ledger(id).map((row) => row.type);
const allRequests = () => h.core.listRequests().map((row) => row.id as string);

/** Priya asked, so Sam and Neha can answer. */
async function held(args: Record<string, unknown> = REFUND_SC4): Promise<string> {
  await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
  return (await h.core.check(gateRefund(args))).request_id as string;
}

/** Holds ₹40,000, counters it to ₹4,000, and confirms. The destination is rohan.s@okhdfc. */
async function editedAndDone(): Promise<{ id: string; card: OpenedCard }> {
  const id = await held();
  await counter(PARTICIPANTS.sam, id, "4000");
  const card = lastCounterCard();
  await typed(card, PARTICIPANTS.sam, '"hdfc"');
  return { id, card };
}

describe("asking", () => {
  it("opens a question card to that person alone, and nothing has changed yet", async () => {
    const id = await held();
    const before = h.chat.cards.length;
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(h.chat.cards).toHaveLength(before + 1);
    const card = lastCounterCard();
    expect(card.roomId).toBe("dm-sam");
    expect(card.kind).toBe("questions");
    expect(card.title).toContain(id);
    expect(card.title).toContain("₹4,000");
    expect(card.title).toContain("₹40,000");
    expect(state(id)).toBe("ROUTED");
    expect(h.gate.calls).toEqual([]);
    expect(h.gate.edits).toEqual([]);
    expect(allRequests()).toEqual([id]);
  });

  it("follows the type-to-confirm conventions, and the question doesn't print its own answer", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    const question = lastCounterCard().questions[0];
    expect(question?.title).toBe("Confirm");
    expect(question?.allowCustomAnswer).toBe(true);
    expect(question?.options).toEqual([{ id: "deny", label: "No, deny" }]);
    const ask = (question?.prompt ?? "").split("\n\n")[0] as string;
    expect(ask).toContain("Approve ₹4,000 instead?");
    expect(ask).toContain("in quotes, after the request code");
    expect(ask).toContain("No, deny");
    expect(ask).not.toContain("hdfc");
    expect(ask).not.toContain("<");
    // The value is on the card, which is the point of asking for it.
    expect(question?.prompt).toContain("rohan.s@okhdfc");
  });

  it("shows the call it would really make, so its flags are about the edited amount", async () => {
    const id = await held(REFUND_BOTH_FLAGS);
    await counter(PARTICIPANTS.sam, id, "4000");
    const prompt = lastCounterCard().questions[0]?.prompt ?? "";
    expect(prompt).toContain("Refund ₹4,000");
    expect(prompt).not.toContain("Refund ₹40,000");
    expect(prompt).toContain("Destination added in the last 24 h");
    expect(prompt).not.toContain("x the order total");
  });

  it("stays inside what Switch can show, whatever the agent's values", async () => {
    const id = await held({ ...REFUND_SC4, order_id: `A-${"9".repeat(600)}` });
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(renderedCost(lastCounterCard().questions[0]?.prompt ?? "")).toBeLessThanOrEqual(PROMPT_BUDGET);
  });

  it("is on the record: who offered what", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(entry(id, "edit_proposed")?.payload).toMatchObject({ by: "sam", from: 40000, to: 4000 });
  });

  it.each(["₹4,000", "4,000", "4k"])("takes %s as the same amount", async (text) => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, text);
    expect(lastCounterCard().title).toContain("₹4,000");
  });

  it("asks for the CLR number when a destination can't be typed", async () => {
    const id = await held({ order_id: "A-2004", customer_id: "cus_2044", amount: 40000 });
    await counter(PARTICIPANTS.sam, id, "4000");
    const card = lastCounterCard();
    expect(card.questions[0]?.prompt.split("\n\n")[0]).toContain("the CLR number from the title");
    await typed(card, PARTICIPANTS.sam, `"${id}"`);
    expect(state(id)).toBe("EDITED");
  });

  it("won't let someone stack up a second offer of their own", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    await counter(PARTICIPANTS.sam, id, "3000");
    expect(counterCards()).toHaveLength(1);
    expect(lastReply()).toContain("₹4,000");
  });

  it("says so, and changes nothing, when the card can't be opened", async () => {
    const id = await held();
    h.chat.failOpenCard = true;
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(entry(id, "edit_proposed")).toBeUndefined();
    expect(state(id)).toBe("ROUTED");
    expect(lastReply()).toContain("Nothing changed");
  });
});

describe("an answer that beats the card's own opening (B13)", () => {
  const answerDuringOpen = (reply: (card: OpenedCard) => Promise<void>) => {
    const open = h.chat.openCard.bind(h.chat);
    let done = false;
    h.chat.openCard = async (input) => {
      const result = await open(input);
      if (input.title.includes("COUNTER") && !done) {
        done = true;
        await reply(h.chat.cards.at(-1) as OpenedCard);
      }
      return result;
    };
  };

  it("a yes still counts, and it runs once", async () => {
    const id = await held();
    answerDuringOpen((card) => typed(card, PARTICIPANTS.sam, '"hdfc"'));
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(state(id)).toBe("EDITED");
    expect(h.gate.calls).toHaveLength(1);
    expect(h.core.stores.routes.openForRequest(id)).toEqual([]);
  });

  it("a No still counts, and the original is left waiting", async () => {
    const id = await held();
    answerDuringOpen((card) => declined(card, PARTICIPANTS.sam));
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(state(id)).toBe("ROUTED");
    expect(entry(id, "edit_withdrawn")?.payload).toMatchObject({ reason: "declined" });
    expect(h.gate.calls).toEqual([]);
  });

  it("an offer that fails to open leaves no card on record, but a late answer to it still counts", async () => {
    const id = await held();
    const open = h.chat.openCard.bind(h.chat);
    let opened: OpenedCard | null = null;
    // Switch posted it, and the answer to that never reached us.
    h.chat.openCard = async (input) => {
      await open(input);
      opened = h.chat.cards.at(-1) as OpenedCard;
      throw new Error("timed out");
    };
    await counter(PARTICIPANTS.sam, id, "4000");
    h.chat.openCard = open;
    expect(lastReply()).toContain("Nothing changed");
    expect(h.core.stores.routes.openForRequest(id).filter((row) => row.step === "counter")).toEqual([]);
    expect(h.core.stores.routes.askedToType(id, "sam")).toBe(false);
    await typed(opened as unknown as OpenedCard, PARTICIPANTS.sam, '"hdfc"');
    expect(state(id)).toBe("EDITED");
    expect(h.gate.calls).toHaveLength(1);
  });
});

describe("ordinary cards", () => {
  it("are what they were: no new button, no new words", async () => {
    const id = await held();
    const card = plainCards("dm-sam")[0] as OpenedCard;
    expect(card.options.map((option) => option.label)).toEqual(["Approve", "Deny"]);
    expect(card.detail).not.toMatch(/counter/i);
    expect(card.title).not.toMatch(/counter/i);
    expect(state(id)).toBe("ROUTED");
  });

  it("stay open while an offer is open, and approving one runs the original", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    await press(plainCards("dm-sam")[0] as OpenedCard, PARTICIPANTS.sam);
    expect(state(id)).toBe("EXECUTED");
    expect(h.gate.calls.map((call) => call.requestId)).toEqual([id]);
    expect(h.gate.edits).toEqual([]);
  });
});

describe("who can counter", () => {
  it("not the requester, on the record", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@refunds-agent refund it"));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(counterCards()).toEqual([]);
    expect(lastReply()).toContain(`Sam can't counter ${id}`);
    expect(entry(id, "ineligible_answer")?.payload).toMatchObject({ user_id: "sam", counter: true, reasons: expect.arrayContaining(["requester"]) });
  });

  it("not the agent's owner", async () => {
    const id = await held();
    await counter(PARTICIPANTS.priya, id, "4000");
    expect(counterCards()).toEqual([]);
    expect(lastReply()).toContain(`Priya can't counter ${id}`);
    expect(entry(id, "ineligible_answer")?.payload.reasons).toEqual(expect.arrayContaining(["agent_owner"]));
  });

  it("not someone who isn't an approver", async () => {
    const id = await held();
    await counter(PARTICIPANTS.dev, id, "4000");
    expect(counterCards()).toEqual([]);
    expect(entry(id, "ineligible_answer")?.payload.reasons).toEqual(["not_approver"]);
  });

  it("not an agent, whatever it writes", async () => {
    const id = await held();
    const before = h.chat.messages.length;
    await counter(PARTICIPANTS.refundsAgent, id, "4000");
    await say(PARTICIPANTS.refundsAgent, `@clearance counter ${id} 4000 as sam`);
    expect(counterCards()).toEqual([]);
    expect(h.chat.messages).toHaveLength(before);
  });

  it("not someone whose approval already counted", async () => {
    const id = await held(REFUND_CRITICAL);
    const card = h.chat.cardIn("dm-sam");
    await typed(card, PARTICIPANTS.sam, '"150000"');
    await typed(card, PARTICIPANTS.sam, '"hdfc"');
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(counterCards()).toEqual([]);
    expect(lastReply()).toContain(`Sam can't counter ${id}`);
  });

  it("a person who stops being eligible before answering is refused then too", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    h.core.people.store.setAway("sam", h.clock.nowMs() + 60 * MINUTE, null);
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    expect(state(id)).toBe("ROUTED");
    expect(h.gate.edits).toEqual([]);
    expect(allRequests()).toEqual([id]);
  });

  it("someone else answering the card doesn't count", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounterCard(), PARTICIPANTS.neha, '"hdfc"');
    expect(state(id)).toBe("ROUTED");
    expect(allRequests()).toEqual([id]);
    expect(entry(id, "ineligible_answer")?.payload).toMatchObject({ user_id: "neha", counter: true });
  });

  it("a drill can't be found, and nothing happens", async () => {
    const drill = await h.core.sendDrill("sam");
    if (!drill.ok) throw new Error("no drill");
    await counter(PARTICIPANTS.sam, drill.requestId, "1");
    // The answer a real card gets when its card won't open, so a drill can't be told by asking.
    expect(lastReply()).toBe("I couldn't open the card for that just now. Nothing changed; try again.");
    expect(counterCards()).toEqual([]);
    expect(h.gate.edits).toEqual([]);
  });

  it("an unknown request can't be found", async () => {
    await counter(PARTICIPANTS.sam, "CLR-9999", "4000");
    expect(lastReply()).toBe("I can't find CLR-9999.");
  });
});

describe("what can change", () => {
  it.each([
    ["an increase", "50000", "new request for the agent"],
    ["the same amount", "40000", "already"],
    ["zero", "0", "whole number above zero"],
    ["a negative", "-500", "whole number above zero"],
    ["a fraction", "4000.50", "whole number above zero"],
    ["text", "less", "whole number above zero"],
    ["a new destination", "4000 evil@okaxis", "Destination, customer and order"],
    ["a named destination", "4000 destination=evil@okaxis", "Destination, customer and order"],
    ["a new customer", "4000 customer=cus_evil", "Destination, customer and order"],
    ["a new order", "4000 order=A-1", "Destination, customer and order"],
  ])("refuses %s, with a reason, and opens nothing", async (_name, amount, reason) => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, amount);
    expect(counterCards()).toEqual([]);
    expect(lastReply()).toContain(reason);
    expect(state(id)).toBe("ROUTED");
    expect(entry(id, "edit_proposed")).toBeUndefined();
  });

  it("says what to write when the amount is missing", async () => {
    const id = await held();
    await say(PARTICIPANTS.sam, `@clearance counter ${id}`);
    expect(lastReply()).toContain("counter");
    await say(PARTICIPANTS.sam, "@clearance counter");
    expect(lastReply()).toContain("counter CLR-");
    expect(counterCards()).toEqual([]);
  });

  it("refuses a class with no amount", async () => {
    const response = await h.core.check({
      ...gateRefund(),
      raw: { customer_id: "cus_8812", upi: "new@oksbi" },
      business: { endpoint: "POST /acme/payouts/destinations", args: { customer_id: "cus_8812", upi: "new@oksbi" } },
    });
    await counter(PARTICIPANTS.sam, response.request_id as string, "4000");
    expect(counterCards()).toEqual([]);
    expect(lastReply()).toContain("no amount");
  });

  it("refuses a hook call: nothing can make an agent run a different command", async () => {
    const response = await h.core.check(hookShell("git push --force origin main", { session: { switchRoomId: "#eng" } }));
    await counter(PARTICIPANTS.dev, response.request_id as string, "1");
    expect(counterCards()).toEqual([]);
    expect(lastReply()).toContain("re-run");
    expect(entry(response.request_id as string, "edit_proposed")).toBeUndefined();
  });

  it("refuses to edit an edit that's still waiting: say no to it and ask for a new request", async () => {
    const id = await held(REFUND_CRITICAL);
    await counter(PARTICIPANTS.sam, id, "120000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    expect(state(next)).toBe("ROUTED");
    await counter(PARTICIPANTS.neha, next, "4000");
    expect(counterCards()).toHaveLength(1);
    expect(lastReply()).toContain("already an edit");
  });

  it("refuses a request that's already decided, or has run out of time", async () => {
    const id = await held();
    await press(plainCards("dm-sam")[0] as OpenedCard, PARTICIPANTS.sam, "deny");
    await counter(PARTICIPANTS.neha, id, "4000");
    expect(lastReply()).toContain("already decided (DENIED)");

    const late = await held({ ...REFUND_SC4, amount: 30000 });
    h.clock.advance(26 * MINUTE);
    await counter(PARTICIPANTS.neha, late, "4000");
    expect(lastReply()).toContain("already decided (EXPIRED)");
    expect(counterCards()).toEqual([]);
  });

  it("only the amount reaches the new call: everything else is as it was held", async () => {
    const { id } = await editedAndDone();
    const original = h.core.stores.requests.require(id);
    const next = h.core.stores.requests.require(allRequests().find((other) => other !== id) as string);
    expect(next.call.args).toEqual({ ...original.call.args, amount: 4000 });
    expect(next.target).toBe(original.target);
    expect(next.agent).toBe(original.agent);
    expect(next.originRoom).toBe(original.originRoom);
    expect(next.originThread).toBe(original.originThread);
    expect(next.requesterIds).toEqual(original.requesterIds);
    expect(next.callHash).not.toBe(original.callHash);
  });
});

describe("a yes", () => {
  it("creates a new call and executes that, exactly once, and closes the original as edited", async () => {
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(state(id)).toBe("EDITED");
    expect(state(next)).toBe("EXECUTED");
    const original = h.core.stores.requests.require(id);
    const made = h.core.stores.requests.require(next);
    expect(h.gate.edits).toEqual([{ requestId: id, callHash: original.callHash, newRequestId: next, newCallHash: made.callHash, amount: 4000 }]);
    expect(h.gate.calls).toEqual([{ requestId: next, callHash: made.callHash }]);
  });

  it("closes every card on the original", async () => {
    const { id, card } = await editedAndDone();
    // The card that was answered is Switch's to close, and this fake doesn't.
    expect(h.chat.openCards().filter((open) => open.switchRequestId !== card.switchRequestId)).toEqual([]);
    expect(h.core.stores.routes.openForRequest(id)).toEqual([]);
  });

  it("counts the edit, not the original, in the 24 h window", async () => {
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(h.core.stores.requests.require(next).flags.map((flag) => flag.code)).not.toContain("aggregate_limit");
    expect(h.core.stores.aggregates.sum("refund", "customer", "cus_2044", 0)).toBe(4000);
  });

  it("doesn't pick up the agent's words about the old amount", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "Refunding ₹40,000 for A-2004"));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    await counter(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = h.core.stores.requests.require(allRequests().find((other) => other !== id) as string);
    expect(next.flags.map((flag) => flag.code)).not.toContain("mismatch");
    expect(next.evidence.agentClaim).toBeUndefined();
  });

  it("is once: a redelivered answer does nothing", async () => {
    const { card, id } = await editedAndDone();
    await typed(card, PARTICIPANTS.sam, '"hdfc"');
    expect(allRequests()).toHaveLength(2);
    expect(h.gate.calls).toHaveLength(1);
    expect(state(id)).toBe("EDITED");
  });

  it("is once: two deliveries at the same moment do nothing more", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    const card = lastCounterCard();
    await Promise.all([typed(card, PARTICIPANTS.sam, '"hdfc"'), typed(card, PARTICIPANTS.sam, '"hdfc"')]);
    expect(allRequests()).toHaveLength(2);
    expect(h.gate.edits).toHaveLength(1);
    expect(h.gate.calls).toHaveLength(1);
  });

  it("is once: the first of two people's offers wins", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    const sams = lastCounterCard();
    await counter(PARTICIPANTS.neha, id, "3000");
    const nehas = lastCounterCard();
    expect(nehas.roomId).toBe("dm-neha");
    await typed(sams, PARTICIPANTS.sam, '"hdfc"');
    await typed(nehas, PARTICIPANTS.neha, '"hdfc"');
    expect(allRequests()).toHaveLength(2);
    expect(h.gate.edits.map((edit) => edit.amount)).toEqual([4000]);
    expect(h.gate.calls).toHaveLength(1);
    expect(nehas.closed).toBe(true);
  });
});

describe("the policy still decides", () => {
  it("a critical edit that's still critical needs its second person, so an edit can't skip a quorum", async () => {
    const id = await held(REFUND_CRITICAL);
    await counter(PARTICIPANTS.sam, id, "120000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    const made = h.core.stores.requests.require(next);
    expect(state(id)).toBe("EDITED");
    expect(made.tier).toBe("critical");
    expect(made.quorumRequired).toBe(2);
    expect(state(next)).toBe("ROUTED");
    expect(h.gate.calls).toEqual([]);
    expect(h.gate.edits).toEqual([]);

    // Neha is asked in the usual way, on the usual typed card, and that's what runs it.
    const nehas = h.chat.cards.filter((card) => card.roomId === "dm-neha" && card.title.includes(next)).at(-1) as OpenedCard;
    expect(nehas.kind).toBe("questions");
    expect(nehas.questions[0]?.prompt).toContain("Edited by Sam from ₹1,50,000 to ₹1,20,000");
    const field = nehas.questions[0]?.id;
    await typed(nehas, PARTICIPANTS.neha, field === "amount" ? '"120000"' : '"hdfc"');
    expect(state(next)).toBe("EXECUTED");
    expect(h.core.stores.answers.countedApprovers(next)).toEqual(["sam", "neha"]);
    expect(h.gate.edits).toHaveLength(1);
    expect(h.gate.calls).toHaveLength(1);
  });

  it("a critical edit that's now high runs on the one yes", async () => {
    const id = await held(REFUND_CRITICAL);
    await counter(PARTICIPANTS.sam, id, "50000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    expect(h.core.stores.requests.require(next).tier).toBe("high");
    expect(state(next)).toBe("EXECUTED");
    expect(h.gate.calls).toHaveLength(1);
  });

  it("an approval of the original doesn't carry over: it was for a different call", async () => {
    const id = await held(REFUND_CRITICAL);
    const nehasFirst = h.chat.cards.filter((card) => card.roomId === "dm-neha").at(0) as OpenedCard;
    const field = nehasFirst.questions[0]?.id;
    await typed(nehasFirst, PARTICIPANTS.neha, field === "amount" ? '"150000"' : '"hdfc"');
    expect(h.core.stores.answers.countedApprovers(id)).toEqual(["neha"]);
    await counter(PARTICIPANTS.sam, id, "120000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    expect(state(next)).toBe("ROUTED");
    expect(h.core.stores.answers.countedApprovers(next)).toEqual(["sam"]);
    expect(h.gate.calls).toEqual([]);
  });

  it("nobody knows who asked, so two people still decide, whatever the tier", async () => {
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    expect(h.core.stores.requests.require(id).quorumRequired).toBe(2);
    await counter(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    const made = h.core.stores.requests.require(next);
    expect(made.tier).toBe("low");
    expect(made.quorumRequired).toBe(2);
    expect(state(next)).toBe("ROUTED");
    expect(h.gate.calls).toEqual([]);
  });

  it("an agent that can't be seen everywhere keeps its second person too", async () => {
    h.chat.unseenRoomCount = async () => 1;
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    expect(h.core.stores.requests.require(id).quorumRequired).toBe(2);
    h.chat.unseenRoomCount = async () => 0;
    h.clock.advance(10 * MINUTE);
    await counter(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    expect(h.core.stores.requests.require(next).quorumRequired).toBe(2);
    expect(h.gate.calls).toEqual([]);
  });

  it("the requester's still barred from the edit", async () => {
    const id = await held(REFUND_CRITICAL);
    await counter(PARTICIPANTS.sam, id, "120000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    expect(h.core.stores.requests.require(next).requesterIds).toEqual(["priya"]);
    await say(PARTICIPANTS.priya, `@clearance status ${next}`);
    expect(h.chat.cards.filter((card) => card.roomId === "dm-priya")).toEqual([]);
  });

  it("other refunds in the window still count: a real total over the limit is flagged on the edit", async () => {
    const first = await held({ ...REFUND_SC4, amount: 8000, order_id: "A-1931" });
    await press(plainCards("dm-sam")[0] as OpenedCard, PARTICIPANTS.sam);
    expect(state(first)).toBe("EXECUTED");
    const id = await held();
    await counter(PARTICIPANTS.neha, id, "4000");
    await typed(lastCounterCard(), PARTICIPANTS.neha, '"hdfc"');
    const next = allRequests().find((other) => ![first, id].includes(other)) as string;
    expect(h.core.stores.requests.require(next).flags.map((flag) => flag.code)).toContain("aggregate_limit");
    expect(h.core.stores.aggregates.sum("refund", "customer", "cus_2044", 0)).toBe(12000);
  });

  describe("when the policy would refuse the edited call", () => {
    function denySmallTotals(): void {
      const path = join(h.dir, "strict.policy.yaml");
      const text = readFileSync(POLICY_PATH, "utf8");
      const strict = text.replace(
        "{ sum: amount, by: customer, window: 24h, over: 10000, then: hold,",
        "{ sum: amount, by: customer, window: 24h, over: 1000, then: deny,",
      );
      expect(strict).not.toBe(text);
      writeFileSync(path, strict);
      (h.core as unknown as { currentPolicy: CompiledPolicy }).currentPolicy = loadPolicy(path);
    }

    it("the command says so, and the original is left alone", async () => {
      const id = await held();
      denySmallTotals();
      await counter(PARTICIPANTS.sam, id, "4000");
      expect(counterCards()).toEqual([]);
      expect(lastReply()).toContain("DENIED by policy");
      expect(state(id)).toBe("ROUTED");
    });

    it("a yes that comes after the policy changed runs nothing, and the original is left alone", async () => {
      const id = await held();
      await counter(PARTICIPANTS.sam, id, "4000");
      denySmallTotals();
      await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
      expect(state(id)).toBe("ROUTED");
      expect(allRequests()).toEqual([id]);
      expect(h.gate.edits).toEqual([]);
      expect(entry(id, "edit_withdrawn")?.payload).toMatchObject({ by: "sam", reason: "policy" });
    });
  });

  it("fails closed when the stored call is gone", async () => {
    const id = await held();
    h.core.stores.db.prepare(`UPDATE actions SET action_json = NULL WHERE request_id = ?`).run(id);
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(counterCards()).toEqual([]);
    expect(state(id)).toBe("ROUTED");
  });

  it("fails closed when an answer finds the stored call gone", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    h.core.stores.db.prepare(`UPDATE actions SET action_json = NULL WHERE request_id = ?`).run(id);
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    expect(state(id)).toBe("ROUTED");
    expect(allRequests()).toEqual([id]);
    expect(h.gate.edits).toEqual([]);
  });

  it("won't make a twin of a call that's already waiting", async () => {
    const id = await held();
    const twin = await held({ ...REFUND_SC4, amount: 4000 });
    await counter(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    expect(state(id)).toBe("ROUTED");
    expect(allRequests().sort()).toEqual([id, twin].sort());
    expect(entry(id, "edit_withdrawn")?.payload).toMatchObject({ reason: "already_waiting" });
    expect(lastReply()).toContain(twin);
  });
});

describe("the gate", () => {
  const down = () => {
    throw new Error("connect ECONNREFUSED");
  };

  it("not answering leaves it retrying, and it runs once when the gate is back", async () => {
    h.gate.respondEdit = down;
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(state(id)).toBe("EDITED");
    expect(state(next)).toBe("APPROVED");
    expect(h.gate.calls).toEqual([]);

    h.clock.advance(6_000);
    await h.core.tick();
    expect(state(next)).toBe("APPROVED");

    h.gate.respondEdit = () => ({ ok: true });
    h.clock.advance(6_000);
    await h.core.tick();
    expect(state(next)).toBe("EXECUTED");
    expect(h.gate.calls).toHaveLength(1);
    h.clock.advance(6_000);
    await h.core.tick();
    expect(h.gate.calls).toHaveLength(1);
  });

  it("dropping between the edit and the run is safe to try again", async () => {
    h.gate.respond = down;
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(h.gate.edits).toHaveLength(1);
    expect(state(next)).toBe("APPROVED");

    h.gate.respond = () => ({ ok: true, alreadyExecuted: false, status: 200, result: { id: "re_1" } });
    h.clock.advance(6_000);
    await h.core.tick();
    expect(state(next)).toBe("EXECUTED");
    expect(h.gate.edits).toHaveLength(2);
    expect(h.gate.edits[0]).toEqual(h.gate.edits[1]);
  });

  it("not answering for five minutes voids it, under the same rule as any approved call, and says so", async () => {
    h.gate.respondEdit = down;
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    h.clock.advance(5 * MINUTE + 1_000);
    await h.core.tick();
    expect(state(next)).toBe("VOIDED");
    expect(state(id)).toBe("EDITED");
    expect(h.gate.calls).toEqual([]);
    expect(toAgent().at(-1)).toBe(`${next}, ₹4,000 instead of the ₹40,000 in ${id}, did not run: connect ECONNREFUSED. ${id} did not run either. Tell Priya and stop.`);
  });

  it("refusing the edit voids it at once, and the run is never asked for", async () => {
    h.gate.respondEdit = () => ({ ok: false, error: "this call has already run or started" });
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(state(next)).toBe("VOIDED");
    expect(h.gate.calls).toEqual([]);
    expect(toAgent().at(-1)).toContain("this call has already run or started");
  });

  it("survives a restart: the edit carries on from the record", async () => {
    h.gate.respondEdit = down;
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    h = h.restart();
    h.gate.respondEdit = () => ({ ok: true });
    h.clock.advance(6_000);
    await h.core.tick();
    expect(state(next)).toBe("EXECUTED");
    expect(h.gate.calls).toHaveLength(1);
    expect(h.gate.calls[0]?.requestId).toBe(next);
  });

  it("a refused run says so in words that don't read as the original being approved", async () => {
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, status: 409, error: "acme refused" });
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(state(next)).toBe("VOIDED");
    expect(toAgent().at(-1)).toBe(`${next}, ₹4,000 instead of the ₹40,000 in ${id}, did not run: acme refused. ${id} did not run either. Tell Priya and stop.`);
  });
});

describe("while the offer is open", () => {
  it("the original being decided makes a late yes change nothing", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    const card = lastCounterCard();
    await press(plainCards("dm-sam")[0] as OpenedCard, PARTICIPANTS.sam, "deny");
    expect(card.closed).toBe(true);
    await typed(card, PARTICIPANTS.sam, '"hdfc"');
    expect(state(id)).toBe("DENIED");
    expect(allRequests()).toEqual([id]);
    expect(h.gate.edits).toEqual([]);
    expect(lastReply()).toContain("already decided (DENIED)");
  });

  it("the original expiring makes a late yes change nothing", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    const card = lastCounterCard();
    h.clock.advance(26 * MINUTE);
    await typed(card, PARTICIPANTS.sam, '"hdfc"');
    expect(state(id)).toBe("EXPIRED");
    expect(allRequests()).toEqual([id]);
    expect(h.gate.edits).toEqual([]);
  });

  it("No, deny drops the offer and leaves the original waiting, and it says so", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    await declined(lastCounterCard(), PARTICIPANTS.sam);
    expect(state(id)).toBe("ROUTED");
    expect(entry(id, "edit_withdrawn")?.payload).toMatchObject({ by: "sam", from: 40000, to: 4000, reason: "declined" });
    expect(allRequests()).toEqual([id]);
    expect(lastReply()).toContain(`${id} is still waiting`);
    expect(toAgent()).toEqual([]);
    // Which doesn't count against them, or as a denial.
    expect(h.core.stores.answers.countedApprovers(id)).toEqual([]);
    await press(plainCards("dm-sam")[0] as OpenedCard, PARTICIPANTS.sam);
    expect(state(id)).toBe("EXECUTED");
  });

  it("a wrong value asks once more, then drops the offer", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    const first = lastCounterCard();
    await typed(first, PARTICIPANTS.sam, '"nope"');
    const second = lastCounterCard();
    expect(second.switchRequestId).not.toBe(first.switchRequestId);
    expect(lastReply()).toContain("didn't match");
    expect(state(id)).toBe("ROUTED");

    await typed(second, PARTICIPANTS.sam, '"nope"');
    expect(counterCards()).toHaveLength(2);
    expect(entry(id, "edit_withdrawn")?.payload).toMatchObject({ by: "sam", reason: "wrong_value" });
    expect(allRequests()).toEqual([id]);
  });

  it("a wrong value on an offer is no mark against them on the original", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"nope"');
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"nope"');
    expect(h.core.stores.answers.failedConfirmations(id, 2)).toEqual([]);
    expect(h.core.stores.routes.askedToType(id, "sam")).toBe(false);
    await press(plainCards("dm-sam")[0] as OpenedCard, PARTICIPANTS.sam);
    expect(state(id)).toBe("EXECUTED");
  });

  it("a fresh offer gets its own tries", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"nope"');
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"nope"');
    await counter(PARTICIPANTS.sam, id, "3000");
    const card = lastCounterCard();
    await typed(card, PARTICIPANTS.sam, '"nope"');
    expect(lastCounterCard().switchRequestId).not.toBe(card.switchRequestId);
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    expect(state(id)).toBe("EDITED");
  });

  it("isn't coverage: the request still routes to someone who'd decide it", async () => {
    const id = await held();
    await counter(PARTICIPANTS.neha, id, "4000");
    const row = h.core.stores.routes.openForRequest(id).find((route) => route.step === "counter");
    expect(row?.user_id).toBe("neha");
    expect(h.core.inboxItems("neha").map((item) => item.request_id)).toEqual([]);
    expect(h.core.inboxItems("sam").map((item) => item.request_id)).toEqual([id]);
  });

  it("a counter card doesn't move the rotation of what ordinary cards ask for", async () => {
    const id = await held();
    const before = h.core.stores.routes.confirmCount("sam");
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(h.core.stores.routes.confirmCount("sam")).toBe(before);
  });
});

describe("what's told, and what's kept", () => {
  it("tells the agent the real outcome, in words it can't read as approval of the original", async () => {
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    const told = toAgent().at(-1) as string;
    expect(told).toBe(`${id} did not run and will not. Sam approved ₹4,000 instead, as ${next}, and that ran: refund re_7731 for ₹4,000. Tell Priya it was ₹4,000, not ₹40,000.`);
    expect(told).not.toContain(`${id} approved`);
    expect(told).not.toContain("Continue");
  });

  it("tells the agent to wait when the edit still needs someone", async () => {
    const id = await held(REFUND_CRITICAL);
    await counter(PARTICIPANTS.sam, id, "120000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    expect(toAgent().at(-1)).toBe(`${id} did not run and will not. Sam offered ₹1,20,000 instead, as ${next}, which still needs another approver. Wait to be told about ${next}.`);
  });

  it("tells the room what really happened", async () => {
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(replies()).toContain(`${id} edited by Sam: ₹4,000 instead of ₹40,000, as ${next}.`);
  });

  it("keeps the original, the edit and who made it on the ledger, and never an approval of the original", async () => {
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    const original = h.core.stores.requests.require(id);
    const made = h.core.stores.requests.require(next);
    expect(entry(id, "edited")?.payload).toMatchObject({
      by: "sam",
      answered_by: PARTICIPANTS.sam,
      from: 40000,
      to: 4000,
      edited_to: next,
      call_hash: original.callHash,
      new_call_hash: made.callHash,
    });
    expect(types(id)).not.toContain("approved");
    expect(types(id)).not.toContain("executed");
    expect(entry(next, "edited")?.payload).toMatchObject({ by: "sam", from: 40000, to: 4000, edit_of: id });
    expect(entry(next, "approved")?.payload).toMatchObject({ approved_by: ["sam"], call_hash: made.callHash, edit_of: id });
    expect(types(next)).toContain("executed");
    expect(h.core.verifyLedger().ok).toBe(true);
  });

  it("describes the edit where anyone looks: the request, status, the audit export, the digest", async () => {
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(h.core.describeRequest(id)).toMatchObject({ state: "EDITED", edited_to: next, approvals: [] });
    expect(h.core.describeRequest(next)?.edited_to).toBeUndefined();

    await say(PARTICIPANTS.sam, `@clearance status ${id}`);
    expect(lastReply()).toContain(`${id}: EDITED`);
    expect(lastReply()).toContain(next);

    const rows = Object.fromEntries(h.core.auditRows().map((row) => [row.request_id, row]));
    expect(rows[id]).toMatchObject({ state: "EDITED", approved_by: "", edited_by: "sam", edited_to: next, edit_of: "" });
    expect(rows[next]).toMatchObject({ state: "EXECUTED", approved_by: "sam", edited_by: "sam", edited_to: "", edit_of: id });

    const digest = h.core.digest();
    expect(digest.requests).toMatchObject({ edited: 1, approved: 1 });
    expect(digest.text).toContain("1 edited");
  });

  it("explains itself when asked why, even though it never went to anyone", async () => {
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    await say(PARTICIPANTS.sam, `@clearance why ${next}`);
    expect(lastReply()).toContain(`${next} is ${id} with its amount lowered from ₹40,000 to ₹4,000 by Sam`);
  });

  it("tells the person offering when the edit didn't run", async () => {
    h.gate.respondEdit = () => ({ ok: false, error: "no" });
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(lastReply()).toBe(`${next} did not run, and neither did ${id}. refunds-agent has been told.`);
  });

  it("the export has the columns, for someone reading the file", async () => {
    const { id } = await editedAndDone();
    const app = buildServer(h.core, { internalToken: "t".repeat(32) });
    const csv = await app.inject({ method: "GET", url: "/v1/export.csv", headers: { authorization: `Bearer ${"t".repeat(32)}` } });
    expect(csv.body.split("\n")[0]).toContain("edited_by");
    expect(csv.body).toContain(id);
    await app.close();
  });
});

describe("the second review's breaks, on the counter path", () => {
  it("B5: an edit nobody can confirm says so, and says the original truly didn't run", async () => {
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "outcome unknown: acme did not answer, so the gate will not run this again" });
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(state(next)).toBe("OUTCOME_UNKNOWN");
    expect(toAgent().at(-1)).toBe(`${id} did not run and will not, but nobody can say whether ${next}, ₹4,000 instead of ₹40,000, ran: acme did not answer, so the gate will not run this again. Do not retry it. A person has to check. Tell Priya and stop.`);
    expect(replies().join("\n")).toContain(`Nobody can say whether ${next} ran. ${id} did not.`);
    expect(replies().join("\n")).not.toContain(`${next} did not run`);
  });

  it("B5: an edit sent and not answered ends unknown, not voided, and an edit never sent ends voided", async () => {
    h.gate.respond = () => {
      throw new Error("socket hang up");
    };
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    h.clock.advance(5 * MINUTE + 1_000);
    await h.core.tick();
    expect(state(next)).toBe("OUTCOME_UNKNOWN");
    expect(h.gate.looks).toEqual([next]);
  });

  it("B6: an offer of a call that just ran says so on its card, and on the request", async () => {
    const done = await held({ ...REFUND_SC4, amount: 4000 });
    await press(plainCards("dm-sam")[0] as OpenedCard, PARTICIPANTS.sam);
    expect(state(done)).toBe("EXECUTED");
    const id = await held();
    await counter(PARTICIPANTS.neha, id, "4000");
    expect(lastCounterCard().questions[0]?.prompt).toContain(`An identical call ran as ${done}`);
    await typed(lastCounterCard(), PARTICIPANTS.neha, '"hdfc"');
    const next = allRequests().find((other) => ![done, id].includes(other)) as string;
    expect(h.core.stores.requests.require(next).flags.map((flag) => flag.code)).toContain("ran_recently");
  });

  it("B7: someone whose ask arrived after the hold can't counter it", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@refunds-agent refund it", { roomId: "#finance", timestampMs: h.clock.nowMs() - MINUTE }));
    await counter(PARTICIPANTS.sam, id, "4000");
    expect(counterCards()).toEqual([]);
    expect(lastReply()).toContain(`Sam can't counter ${id}`);
  });

  it("B7: and someone whose ask arrived while the offer was open can't confirm it", async () => {
    const id = await held();
    await counter(PARTICIPANTS.sam, id, "4000");
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@refunds-agent refund it", { roomId: "#finance", timestampMs: h.clock.nowMs() - MINUTE }));
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    expect(state(id)).toBe("ROUTED");
    expect(allRequests()).toEqual([id]);
  });

  it("B8: a requester linked to nobody keeps the edit at two people", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.guest, "@refunds-agent refund it"));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    await counter(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    expect(h.core.stores.requests.require(next).quorumRequired).toBe(2);
    expect(h.core.stores.requests.require(next).flags.map((flag) => flag.code)).toContain("requester_unlinked");
    expect(h.gate.calls).toEqual([]);
  });

  it("B9: the delegate of the person who asked can't counter", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.neha, "@refunds-agent refund it"));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    h.core.people.store.setAway("neha", h.clock.nowMs() + 60 * MINUTE, "dev");
    await counter(PARTICIPANTS.dev, id, "4000");
    expect(counterCards()).toEqual([]);
  });

  it("B10, B12: someone who asked elsewhere, or is still waiting on the agent, stays barred from the edit too", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.neha, "@refunds-agent refund it", { roomId: "#finance" }));
    const id = await held(REFUND_CRITICAL);
    await counter(PARTICIPANTS.neha, id, "120000");
    expect(counterCards()).toEqual([]);
    await counter(PARTICIPANTS.sam, id, "120000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    // Critical, so it needs a second person, and Neha can't be that person. It goes where the policy sends it.
    expect(h.chat.cards.filter((card) => card.roomId === "dm-neha" && card.title.includes(next))).toEqual([]);
    expect(state(next)).toBe("ROUTED");
  });

  it("B11, B14: doubts about who asked carry over to the edit", async () => {
    h.core.onStreamGap();
    const gapped = await held();
    expect(h.core.stores.requests.require(gapped).quorumRequired).toBe(2);
    h.clock.advance(11 * MINUTE); // Past the gap, but it was true when this was held.
    await counter(PARTICIPANTS.sam, gapped, "4000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== gapped) as string;
    expect(h.core.stores.requests.require(next).quorumRequired).toBe(2);
    expect(h.core.stores.requests.require(next).flags.map((flag) => flag.code)).toContain("messages_lost");
  });

  it("B18: a lower amount doesn't make someone else's destination all right", async () => {
    const id = await held({ order_id: "A-1931", customer_id: "cus_8812", amount: 3000, destination: "rohan.s@okhdfc" });
    await counter(PARTICIPANTS.sam, id, "2000");
    expect(lastCounterCard().questions[0]?.prompt).toContain("The destination belongs to cus_2044, not cus_8812");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    expect(h.core.stores.requests.require(next).flags.map((flag) => flag.code)).toContain("destination_other_customer");
  });

  it("B19: a drill answers like a real request, to someone who can't counter", async () => {
    const real = await held();
    const drill = await h.core.sendDrill("neha");
    if (!drill.ok) throw new Error("no drill");
    const answer = async (id: string) => {
      await counter(PARTICIPANTS.dev, id, "1");
      return lastReply().replace(id, "ID");
    };
    expect(await answer(drill.requestId)).toMatch(/^Dev can't counter ID \(/);
    expect((await answer(real)).split(".")[0]).toBe((await answer(drill.requestId)).split(".")[0]);
  });

  it("B22: a gate that doesn't have the original yet gets asked again, rather than voiding the edit", async () => {
    h.gate.respondEdit = () => ({ ok: false, error: "unknown request" });
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    expect(state(next)).toBe("APPROVED");
    h.gate.respondEdit = () => ({ ok: true });
    h.clock.advance(6_000);
    await h.core.tick();
    expect(state(next)).toBe("EXECUTED");
    expect(h.gate.calls).toHaveLength(1);
  });

  it("B23: an edit that needs a second person goes to someone eligible, however busy", async () => {
    const id = await held(REFUND_CRITICAL);
    await counter(PARTICIPANTS.sam, id, "120000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    expect(h.core.stores.routes.forRequest(next).map((row) => row.card_room)).not.toContain("#approvals");
  });
});

describe("promotion (F11)", () => {
  const event = (overrides: Partial<NewBucketEvent> = {}): NewBucketEvent => ({
    agent: "refunds-agent",
    cls: "refund",
    bucket: "small",
    requestId: null,
    atMs: 0,
    fields: {},
    outcome: "approved",
    approvers: ["sam"],
    fast: false,
    edited: false,
    incident: false,
    autoEligible: true,
    synthetic: false,
    ...overrides,
  });

  it("an edited approval isn't evidence, and blocks promotion", () => {
    const stats = bucketStats([event({ edited: true })]);
    expect(stats.edited).toBe(1);
    expect(stats.counted).toBe(0);
    expect(stats.approvers).toEqual([]);
    expect(stats.wouldAutoApproved).toBe(0);
    const many = Array.from({ length: 30 }, (_, index) => event({ approvers: [index % 2 ? "sam" : "neha"] }));
    expect(meetsPromotion(bucketStats(many), F11_CRITERIA)).toBe(true);
    expect(meetsPromotion(bucketStats([...many, event({ edited: true })]), F11_CRITERIA)).toBe(false);
  });

  it("counting from the real thing: both sides of an edit are recorded as edited", async () => {
    const { id } = await editedAndDone();
    const next = allRequests().find((other) => other !== id) as string;
    const rows = h.core.stores.db.prepare(`SELECT request_id, outcome, edited FROM bucket_events ORDER BY id`).all() as { request_id: string; outcome: string; edited: number }[];
    expect(rows).toEqual([
      { request_id: id, outcome: "approved", edited: 1 },
      { request_id: next, outcome: "approved", edited: 1 },
    ]);
  });

  it("a second person approving an edit is still an edit", async () => {
    const id = await held(REFUND_CRITICAL);
    await counter(PARTICIPANTS.sam, id, "120000");
    await typed(lastCounterCard(), PARTICIPANTS.sam, '"hdfc"');
    const next = allRequests().find((other) => other !== id) as string;
    const nehas = h.chat.cards.filter((card) => card.roomId === "dm-neha" && card.title.includes(next)).at(-1) as OpenedCard;
    await typed(nehas, PARTICIPANTS.neha, nehas.questions[0]?.id === "amount" ? '"120000"' : '"hdfc"');
    const row = h.core.stores.db.prepare(`SELECT edited FROM bucket_events WHERE request_id = ?`).get(next) as { edited: number };
    expect(row.edited).toBe(1);
  });
});
