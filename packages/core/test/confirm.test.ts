/** F6 type-to-confirm: a critical card, or the next high card after a rubber-stamp flag, asks for a typed value. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmFieldsFor, askText, typedMatches, typedValue, readQuestionAnswer, type ConfirmField } from "../src/confirm/typed.js";
import { PROMPT_BUDGET, renderedCost } from "../src/cards/render.js";
import type { OpenedCard } from "./fakes.js";
import {
  chatMessage,
  gateRefund,
  makeHarness,
  MINUTE,
  PARTICIPANTS,
  REFUND_CRITICAL,
  REFUND_SC3,
  REFUND_SC4,
  type Harness,
} from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.core.close());

const typed = (card: OpenedCard, who: string, text: string) =>
  h.core.onApprovalOutcome({
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "questions",
    state: "answered",
    answer: null,
    answers: [{ question_id: card.questions[0]?.id ?? "x", custom_text: text, selected_option_ids: [] }],
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  });

const picked = (card: OpenedCard, who: string, option: string) =>
  h.core.onApprovalOutcome({
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "questions",
    state: "answered",
    answer: null,
    answers: [{ question_id: card.questions[0]?.id ?? "x", custom_text: null, selected_option_ids: [option] }],
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  });

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

const state = (id: string) => h.core.stores.requests.require(id).state;
const openIn = (room: string) => h.chat.cards.filter((card) => card.roomId === room && !card.closed);
const lastOpen = (room: string) => openIn(room).at(-1) as OpenedCard;

/** Over ₹1,00,000: critical, two people, typed on every card. */
async function heldCritical(args: Record<string, unknown> = REFUND_CRITICAL): Promise<string> {
  await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
  const held = await h.core.check(gateRefund(args));
  return held.request_id as string;
}

describe("the card", () => {
  it("is a questions card on the critical tier, taking a written answer", async () => {
    const id = await heldCritical();
    const card = h.chat.cardIn("dm-sam");
    expect(card.kind).toBe("questions");
    expect(card.options).toEqual([]);
    expect(card.detail).toBe("");
    expect(card.title).toBe(`${id} · REFUND ₹1,50,000 · CRITICAL · irreversible`);
    expect(card.questions).toHaveLength(1);
    expect(card.questions[0]).toMatchObject({ id: "amount", title: "Confirm", multiSelect: false, allowCustomAnswer: true });
    expect(card.questions[0]?.options).toEqual([{ id: "deny", label: "No, deny" }]);
  });

  it("carries the evidence in the prompt, opening with the Appendix D ask, inside the budget", async () => {
    const id = await heldCritical();
    const prompt = h.chat.cardIn("dm-sam").questions[0]?.prompt as string;
    expect(prompt.startsWith(`${id} is high risk. Type the refund amount in rupees to approve: <handle> "150000". Or choose No.`)).toBe(true);
    expect(prompt).toContain("Refund ₹1,50,000 to customer Rohan S. (cus_2044)");
    expect(prompt).toContain("Why you: finance approver on duty.");
    expect(prompt).toContain("expires 14:25 IST");
    expect(renderedCost(prompt)).toBeLessThanOrEqual(PROMPT_BUDGET);
  });

  it("stays a plain approval card below critical", async () => {
    await h.core.check(gateRefund(REFUND_SC4));
    expect(h.chat.cardIn("dm-sam").kind).toBe("approval");
  });

  it("asks on the origin copy too, since a critical answer there counts the same", async () => {
    await heldCritical();
    const copy = h.chat.cardIn("#support");
    expect(copy.kind).toBe("questions");
    expect(copy.questions[0]?.prompt).toContain("Why here:");
  });
});

describe("which field it asks for", () => {
  it("offers amount and destination for a refund, and rotates between them per person", async () => {
    await heldCritical();
    expect(h.chat.cardIn("dm-sam").questions[0]?.id).toBe("amount");
    await heldCritical({ ...REFUND_CRITICAL, amount: 150001 });
    const second = h.chat.cards.filter((card) => card.roomId === "dm-sam")[1] as OpenedCard;
    expect(second.questions[0]?.id).toBe("destination_last4");
    const lastFour = String(REFUND_CRITICAL.destination).slice(-4);
    expect(second.questions[0]?.prompt).toContain(`Type the last 4 characters of the destination to approve: <handle> "${lastFour}". Or choose No.`);
    await heldCritical({ ...REFUND_CRITICAL, amount: 150002 });
    const third = h.chat.cards.filter((card) => card.roomId === "dm-sam")[2] as OpenedCard;
    expect(third.questions[0]?.id).toBe("amount");
  });

  it("asks for the service on a deploy", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@ops-agent ship it", { roomId: "#eng", threadId: null }));
    await h.core.check({
      ...gateRefund(),
      agent: { name: "ops-agent" },
      session: { switchRoomId: "#eng" },
      business: { endpoint: "POST /acme/deploys", args: { service: "checkout", env: "prod", version: "v2.14.0" } },
    });
    const card = h.chat.cardIn("dm-alex");
    expect(card.questions[0]?.id).toBe("service");
    expect(card.questions[0]?.prompt).toContain('Type the service name to approve: <handle> "checkout". Or choose No.');
  });

  it("falls back to something every card has", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@support-agent send it"));
    await h.core.check({
      ...gateRefund(),
      agent: { name: "support-agent" },
      business: { endpoint: "POST /acme/emails", args: { to: "auditor.ravi@gmail.com", subject: "x", body: "y", attachments: ["customers.csv"] } },
    });
    expect(h.chat.cardIn("dm-priya").questions[0]?.id).toBe("domain");
  });

  it.each([
    [{ amount: 40000, destination: "meera.k@okaxis" }, ["amount", "destination_last4"]],
    [{ amount: "40000" }, ["amount"]],
    [{ amount: "lots" }, ["request_id"]],
    [{ destination: "abc" }, ["request_id"]],
    [{ service: "checkout", version: "v1" }, ["service"]],
    [{ domain: "gmail.com" }, ["domain"]],
    [{ pr: 42 }, ["pr"]],
    [{}, ["request_id"]],
  ])("from %j offers %j", (extracted, fields) => {
    expect(confirmFieldsFor(extracted)).toEqual(fields);
  });

  it("words each ask with the exact reply: a bare number is ignored by Switch, and a word is refused", () => {
    const ask = (field: ConfirmField, cls: string, extracted: Record<string, unknown>) => askText(field, "CLR-1", cls, "INR", extracted);
    expect(ask("amount", "refund", { amount: 38000 })).toBe('CLR-1 is high risk. Type the refund amount in rupees to approve: <handle> "38000". Or choose No.');
    expect(ask("amount", "payout_change", { amount: 38000 })).toBe('CLR-1 is high risk. Type the amount in rupees to approve: <handle> "38000". Or choose No.');
    expect(ask("pr", "merge", { pr: 412 })).toBe('CLR-1 is high risk. Type the pull request number to approve: <handle> "412". Or choose No.');
    expect(ask("request_id", "x", {})).toBe('CLR-1 is high risk. Type this request\'s id to approve: <handle> "CLR-1". Or choose No.');
  });

  it.each<[ConfirmField, Record<string, unknown>]>([
    ["amount", { amount: "38000" }],
    ["amount", { amount: 1500.5 }],
    ["destination_last4", { destination: "rohan.s@okhdfc" }],
    ["service", { service: "checkout" }],
    ["domain", { domain: "acme.example" }],
    ["pr", { pr: 412 }],
    ["request_id", {}],
  ])("the value the how-to shows for %s is one that is accepted", (field, extracted) => {
    expect(typedMatches(field, typedValue(field, extracted, "CLR-1"), extracted, "CLR-1")).toBe(true);
  });

  it("never asks for a value that can't be typed in quotes or would swamp the card, because an agent chose it", () => {
    expect(confirmFieldsFor({ service: 'check"out' })).toEqual(["request_id"]);
    expect(confirmFieldsFor({ service: "x".repeat(200) })).toEqual(["request_id"]);
    expect(confirmFieldsFor({ service: "a\nb" })).toEqual(["request_id"]);
    expect(confirmFieldsFor({ amount: 100, destination: 'ab"cd' })).toEqual(["amount"]);
  });
});

describe("reading what was typed", () => {
  const extracted = { amount: 150000, destination: "rohan.s@okhdfc", service: "Checkout", domain: "gmail.com", pr: 42 };

  it.each([
    ["amount", "150000", true],
    ["amount", " 1,50,000 ", true],
    ["amount", "₹1,50,000", true],
    ["amount", "Rs. 150000", true],
    ["amount", "INR 150000", true],
    ["amount", "150000 rupees", true],
    ["amount", "1.5 lakh", true],
    ["amount", "150k", true],
    ["amount", "150000.00", true],
    ["amount", "15000", false],
    ["amount", "1500000", false],
    ["amount", "150,000 or so", false],
    ["amount", "", false],
    ["destination_last4", "khdf", false],
    ["destination_last4", "hdfc", true],
    ["destination_last4", "HDFC", true],
    ["destination_last4", "rohan.s@okhdfc", false],
    ["service", "checkout", true],
    ["service", " CHECKOUT ", true],
    ["service", "refunds-api", false],
    ["domain", "gmail.com", true],
    ["domain", "GMAIL.COM", true],
    ["domain", "yahoo.com", false],
    ["pr", "42", true],
    ["pr", "#42", true],
    ["pr", "43", false],
    ["request_id", "CLR-0001", true],
    ["request_id", "clr-0001", true],
    ["request_id", "CLR-0002", false],
  ] as const)("%s: %j -> %s", (field, text, ok) => {
    expect(typedMatches(field, text, extracted, "CLR-0001")).toBe(ok);
  });

  it.each([
    [[{ question_id: "amount", custom_text: "40000", selected_option_ids: [] }], { kind: "typed", text: "40000" }],
    [[{ question_id: "amount", custom_text: "no", selected_option_ids: [] }], { kind: "deny" }],
    [[{ question_id: "amount", custom_text: " No. ", selected_option_ids: [] }], { kind: "deny" }],
    [[{ question_id: "amount", custom_text: "DENY", selected_option_ids: [] }], { kind: "deny" }],
    [[{ question_id: "amount", custom_text: null, selected_option_ids: ["deny"] }], { kind: "deny" }],
    [[{ question_id: "amount", selected_option_ids: ["something-else"] }], { kind: "none" }],
    [[{ question_id: "other", custom_text: "40000", selected_option_ids: [] }], { kind: "none" }],
    [[{ question_id: "amount", custom_text: "", selected_option_ids: [] }], { kind: "none" }],
    [[], { kind: "none" }],
    [null, { kind: "none" }],
    [undefined, { kind: "none" }],
    [[{ question_id: "amount", custom_text: 40000 }], { kind: "none" }],
  ])("%j", (answers, expected) => {
    expect(readQuestionAnswer(answers as never, "amount")).toEqual(expected);
  });
});

describe("a right answer", () => {
  it("counts as that person's approval, typed in any way money is written", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "1,50,000");
    expect(h.core.stores.answers.countedApprovers(id)).toEqual(["sam"]);
    expect(state(id)).toBe("ROUTED");
    await typed(h.chat.cardIn("dm-neha"), PARTICIPANTS.neha, "₹150000");
    expect(state(id)).toBe("EXECUTED");
    expect(h.gate.calls).toHaveLength(1);
  });

  it("records that it was typed and which field, not the text itself", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "150000");
    const answered = h.core.stores.ledger.list({ requestId: id }).find((entry) => entry.type === "answered");
    expect(answered?.payload).toMatchObject({ user_id: "sam", decision: "approve", typed_field: "amount" });
    expect(JSON.stringify(answered?.payload)).not.toContain("150000");
  });

  it("is single quorum-counted per person even if typed on two cards", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "150000");
    await typed(h.chat.cardIn("#support"), PARTICIPANTS.sam, "150000");
    expect(state(id)).toBe("ROUTED");
    expect(h.gate.calls).toEqual([]);
  });
});

describe("no", () => {
  it.each(["no", "No", "NO.", "deny"])("typing %j is a denial", async (word) => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, word);
    expect(state(id)).toBe("DENIED");
    expect(h.gate.calls).toEqual([]);
  });

  it("pressing the No button is a denial", async () => {
    const id = await heldCritical();
    await picked(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "deny");
    expect(state(id)).toBe("DENIED");
  });

  it("an empty answer is neither", async () => {
    const id = await heldCritical();
    await h.core.onApprovalOutcome({
      sessionId: h.chat.cardIn("dm-sam").sessionId,
      switchRequestId: h.chat.cardIn("dm-sam").switchRequestId,
      kind: "questions",
      state: "answered",
      answer: null,
      answers: [],
      answeredBy: PARTICIPANTS.sam,
      answeredAtMs: h.clock.nowMs(),
    });
    expect(state(id)).toBe("ROUTED");
    expect(h.gate.calls).toEqual([]);
  });
});

describe("a wrong answer", () => {
  it("is rejected and re-asks once, with a different field when there is one", async () => {
    const id = await heldCritical();
    const first = h.chat.cardIn("dm-sam");
    await typed(first, PARTICIPANTS.sam, "15000");
    expect(state(id)).toBe("ROUTED");
    expect(h.core.stores.answers.countedApprovers(id)).toEqual([]);
    expect(h.gate.calls).toEqual([]);
    const again = lastOpen("dm-sam");
    expect(again.switchRequestId).not.toBe(first.switchRequestId);
    expect(again.questions[0]?.id).toBe("destination_last4");
    expect(h.core.stores.ledger.list({ requestId: id }).at(-2)?.payload).toMatchObject({ reasons: ["wrong_confirmation"], user_id: "sam" });
    expect(h.chat.targeted.at(-1)).toMatchObject({
      roomId: "dm-sam",
      targets: ["sam"],
      body: `That didn't match. ${id} asks once more; the card is just above.`,
    });
  });

  it("does not say what the right value was", async () => {
    await heldCritical();
    await typed(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "15000");
    const body = h.chat.targeted.at(-1)?.body as string;
    expect(body).not.toContain("150000");
    expect(body).not.toContain("1,50,000");
  });

  it("twice counts as not approved: no third ask, and they cannot approve it another way", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "1");
    await typed(lastOpen("dm-sam"), PARTICIPANTS.sam, "2");
    expect(h.core.stores.routes.openForRequest(id).filter((row) => row.user_id === "sam")).toEqual([]);
    expect(h.core.stores.answers.countedApprovers(id)).toEqual([]);
    expect(h.chat.messages.at(-1)).toEqual({
      roomId: "dm-sam",
      body: `That didn't match either, so your answer on ${id} doesn't count.`,
    });
    await typed(h.chat.cardIn("#support"), PARTICIPANTS.sam, "150000");
    expect(h.core.stores.answers.countedApprovers(id)).toEqual([]);
    expect(h.chat.messages.at(-1)?.body).toContain("Sam can't approve");
    expect(h.chat.messages.at(-1)?.body).toContain("failed type-to-confirm");
    expect(h.gate.calls).toEqual([]);
  });

  it("twice leaves the request to whoever else can take it, and then it expires", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "1");
    await typed(lastOpen("dm-sam"), PARTICIPANTS.sam, "2");
    await typed(h.chat.cardIn("dm-neha"), PARTICIPANTS.neha, "150000");
    expect(state(id)).toBe("ROUTED");
    h.clock.advance(25 * MINUTE);
    await h.core.tick();
    expect(state(id)).toBe("EXPIRED");
    expect(h.gate.calls).toEqual([]);
  });

  it("a wrong answer never runs anything, whatever the state of quorum", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("dm-neha"), PARTICIPANTS.neha, "150000");
    await typed(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "999");
    expect(state(id)).toBe("ROUTED");
    expect(h.gate.calls).toEqual([]);
  });

  it("no after one wrong answer is still a denial", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "1");
    await typed(lastOpen("dm-sam"), PARTICIPANTS.sam, "no");
    expect(state(id)).toBe("DENIED");
  });
});

describe("eligibility comes first", () => {
  it("refuses the requester typing the right value on the origin copy, and gives them no second try", async () => {
    const id = await heldCritical();
    const cardsBefore = h.chat.cards.length;
    await typed(h.chat.cardIn("#support"), PARTICIPANTS.priya, "150000");
    expect(h.core.stores.answers.countedApprovers(id)).toEqual([]);
    expect(h.gate.calls).toEqual([]);
    expect(h.chat.messages.at(-1)?.body).toBe(
      `Priya can't approve ${id} (requester, agent owner). Sent to Sam (finance, on duty) and Neha (finance, backup).`,
    );
    expect(h.chat.cards).toHaveLength(cardsBefore);
    expect(h.core.stores.ledger.list({ requestId: id }).at(-1)?.payload).toMatchObject({ reasons: ["requester", "agent_owner"] });
  });

  it("refuses the requester typing a wrong value the same way, not as a wrong value", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("#support"), PARTICIPANTS.priya, "1");
    expect(h.core.stores.ledger.list({ requestId: id }).at(-1)?.payload).toMatchObject({ reasons: ["requester", "agent_owner"] });
  });

  it("refuses an unlinked account and an agent before reading what they typed", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("#support"), PARTICIPANTS.guest, "150000");
    expect(h.chat.messages.at(-1)?.body).toContain("That account can't approve");
    expect(state(id)).toBe("ROUTED");
  });

  it("counts an eligible approver answering on the origin copy", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("#support"), PARTICIPANTS.sam, "150000");
    expect(h.core.stores.answers.countedApprovers(id)).toEqual(["sam"]);
  });

  it("a denial from someone ineligible is refused too", async () => {
    const id = await heldCritical();
    await typed(h.chat.cardIn("#support"), PARTICIPANTS.priya, "no");
    expect(state(id)).toBe("ROUTED");
  });
});

describe("after a rubber-stamp flag", () => {
  it("the next high-tier card for that person asks for a typed value, and the one after doesn't", async () => {
    h.core.people.store.setFriction("sam", "fast_approval");
    await h.core.check(gateRefund(REFUND_SC4));
    const first = h.chat.cardIn("dm-sam");
    expect(first.kind).toBe("questions");
    expect(first.questions[0]?.prompt).toContain("Type the refund amount");
    expect(h.core.people.store.friction("sam")).toBeNull();
    h.clock.advance(MINUTE);
    await typed(first, PARTICIPANTS.sam, "40000");
    await h.core.check(gateRefund({ ...REFUND_SC4, amount: 40001 }));
    expect(openIn("dm-sam").at(-1)?.kind).toBe("approval");
  });

  it("a right value typed under the floor is still fast, so the next card asks again", async () => {
    h.core.people.store.setFriction("sam", "fast_approval");
    await h.core.check(gateRefund(REFUND_SC4));
    await typed(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "40000");
    expect(h.core.people.store.friction("sam")).toBe("fast");
    await h.core.check(gateRefund({ ...REFUND_SC4, amount: 40001 }));
    expect(openIn("dm-sam").at(-1)?.kind).toBe("questions");
  });

  it("does not spend the flag on a low or medium card", async () => {
    h.core.people.store.setFriction("sam", "fast_approval");
    await h.core.check(gateRefund({ order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "rohan.s@okhdfc" }));
    expect(h.chat.cardIn("dm-sam").kind).toBe("approval");
    expect(h.core.people.store.friction("sam")).toBe("fast_approval");
  });

  it("does not make anyone else's card typed", async () => {
    h.core.people.store.setFriction("neha", "fast_approval");
    await h.core.check(gateRefund(REFUND_SC4));
    expect(h.chat.cardIn("dm-sam").kind).toBe("approval");
  });

  it("does not let a plain press on the origin copy dodge it: it asks in the direct room instead", async () => {
    h.core.people.store.setFriction("sam", "fast_approval");
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    const held = await h.core.check(gateRefund(REFUND_SC4));
    const id = held.request_id as string;
    expect(h.chat.cardIn("#support").kind).toBe("approval");
    await press(h.chat.cardIn("#support"), PARTICIPANTS.sam);
    expect(h.core.stores.answers.countedApprovers(id)).toEqual([]);
    expect(state(id)).toBe("ROUTED");
    expect(h.gate.calls).toEqual([]);
    expect(lastOpen("dm-sam").kind).toBe("questions");
  });

  it("asks when the flag arrives after the plain card went out", async () => {
    const held = await h.core.check(gateRefund(REFUND_SC4));
    const card = h.chat.cardIn("dm-sam");
    h.core.people.store.setFriction("sam", "fast_approval");
    await press(card, PARTICIPANTS.sam);
    expect(state(held.request_id as string)).toBe("ROUTED");
    expect(lastOpen("dm-sam").kind).toBe("questions");
    expect(h.gate.calls).toEqual([]);
  });

  it("still takes a plain denial", async () => {
    h.core.people.store.setFriction("sam", "fast_approval");
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    const held = await h.core.check(gateRefund(REFUND_SC4));
    await press(h.chat.cardIn("#support"), PARTICIPANTS.sam, "deny");
    expect(state(held.request_id as string)).toBe("DENIED");
  });
});

describe("L1, the fast lane", () => {
  it("needs one approver and no typing", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L1", h.clock.nowMs());
    const small = { order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "fresh@oksbi" };
    const held = await h.core.check(gateRefund(small));
    const id = held.request_id as string;
    expect(h.core.stores.requests.require(id).quorumRequired).toBe(1);
    const card = h.chat.cardIn("dm-sam");
    expect(card.kind).toBe("approval");
    await press(card, PARTICIPANTS.sam);
    expect(state(id)).toBe("EXECUTED");
  });
});

describe("no session on the action", () => {
  it("finds the origin from the last person who addressed the agent, and refuses there", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it", { roomId: "#support", threadId: "t-9" }));
    const held = await h.core.check(gateRefund(REFUND_SC4, { session: undefined }));
    const id = held.request_id as string;
    expect(h.chat.cards.map((card) => card.roomId)).toEqual(["dm-sam", "#support"]);
    expect(h.chat.cardIn("#support").threadId).toBe("t-9");
    await press(h.chat.cardIn("#support"), PARTICIPANTS.priya);
    expect(h.chat.messages.at(-1)).toEqual({
      roomId: "#support",
      threadId: "t-9",
      body: `Priya can't approve ${id} (requester, agent owner). Sent to Sam (finance, on duty).`,
    });
  });

  it("uses the most recent person who addressed the agent", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent one", { roomId: "#support", threadId: "t-1" }));
    h.clock.advance(MINUTE);
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@refunds-agent two", { roomId: "#eng", threadId: "t-2" }));
    const held = await h.core.check(gateRefund(REFUND_SC4, { session: undefined }));
    const request = h.core.stores.requests.require(held.request_id as string);
    expect(request.originRoom).toBe("#eng");
    expect(request.originThread).toBe("t-2");
  });

  it("with a session that names no room, does the same", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it", { roomId: "#support", threadId: "t-9" }));
    const held = await h.core.check(gateRefund(REFUND_SC4, { session: { vendorSessionId: "v-1" } }));
    expect(h.core.stores.requests.require(held.request_id as string).originRoom).toBe("#support");
  });

  it("with nothing known, skips the copy and tells #approvals", async () => {
    const held = await h.core.check(gateRefund(REFUND_SC4, { session: undefined }));
    const id = held.request_id as string;
    expect(h.chat.cards.map((card) => card.roomId)).toEqual(["dm-sam"]);
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.priya);
    expect(h.chat.messages.at(-1)).toEqual({
      roomId: "#approvals",
      body: `Priya can't approve ${id} (agent owner). Sent to Sam (finance, on duty).`,
    });
    await press(lastOpen("dm-sam"), PARTICIPANTS.sam, "deny");
    expect(h.chat.targeted.at(-1)).toMatchObject({ roomId: "#approvals", targets: ["refunds-agent"] });
  });
});

describe("the call as the gate held it", () => {
  it("compares the agent's words with the fuller args the gate filled in, without a false flag", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "Refunding ₹2,000 for order A-1931."));
    const held = await h.core.check(
      gateRefund({ order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "meera.k@okaxis" }),
    );
    const flags = h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.code);
    expect(flags).not.toContain("mismatch");
  });

  it("still flags a difference in what the gate filled in", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "Refunding ₹2,000 to cus_1111."));
    const held = await h.core.check(
      gateRefund({ order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "meera.k@okaxis" }),
    );
    const texts = h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.text);
    expect(texts).toContain('The agent wrote "cus_1111" in the thread; the call says cus_8812');
  });
});

describe("SC3 stays a plain card", () => {
  it("is high tier, so Priya can still press the copy and Sam can still say no", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    await h.core.check(gateRefund(REFUND_SC3));
    expect(h.chat.cardIn("#support").kind).toBe("approval");
  });
});
