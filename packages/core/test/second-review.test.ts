/**
 * What the second review's own tests (red-team.test.ts) don't reach: each fix's other edge, what a fix must not change,
 * and the two things it only suspected, confirmed or ruled out here.
 */
import { homedir } from "node:os";
import { hookRoutes } from "@clearance/adapters";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { streamHandlers } from "../src/stream.js";
import type { OpenedCard } from "./fakes.js";
import { chatMessage, gateRefund, hookShell, makeHarness, MINUTE, PARTICIPANTS, REFUND_SC4, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  try {
    h.core.close();
  } catch {
    // A test that restarted closed it already.
  }
});

const support = { session: { switchRoomId: "#support", threadId: "t-1" } };
const noRoom = { session: undefined };
const SMALL = { order_id: "A-2004", customer_id: "cus_2044", amount: 3000, destination: "rohan.s@okhdfc" };
const says = (who: string, body: string, roomId = "#support", overrides: Parameters<typeof chatMessage>[2] = {}) =>
  h.core.onMessage(chatMessage(who, body, { roomId, threadId: null, addressed: true, ...overrides }));
const press = (card: { sessionId: string; switchRequestId: string }, who: string, answer = "allow") =>
  h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer, answeredBy: who, answeredAtMs: h.clock.nowMs() });
const state = (id: string | undefined) => h.core.stores.requests.get(id as string)?.state;
const request = (id: string | undefined) => h.core.stores.requests.require(id as string);
const flagCodes = (id: string | undefined) => request(id).flags.map((flag) => flag.code);
const cardIn = (room: string): OpenedCard => h.chat.cards.filter((card) => card.roomId === room).at(-1) as OpenedCard;
const told = () => [...h.chat.messages.map((m) => m.body), ...h.chat.targeted.map((m) => m.body)].join("\n");

describe("B5: truth about what ran", () => {
  async function approved(): Promise<string> {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    return held.request_id as string;
  }

  it("a refused connection on every attempt is known not to have run, and gets no last look", async () => {
    const id = await approved();
    h.gate.respond = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    h.clock.advance(5 * MINUTE + 1);
    await h.core.tick();
    expect(state(id)).toBe("VOIDED");
    expect(h.gate.looks).toEqual([]);
    expect(told()).toContain("did not run: fetch failed");
  });

  it("one that may have been sent, among refused ones, is enough not to know", async () => {
    const id = await approved();
    h.gate.respond = () => {
      throw new Error("socket hang up");
    };
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    h.gate.respond = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    h.clock.advance(5_000);
    await h.core.tick();
    h.clock.advance(5 * MINUTE);
    await h.core.tick();
    expect(state(id)).toBe("OUTCOME_UNKNOWN");
  });

  it("the last look starts nothing: an approval that's too old asks with lookOnly, and voids if nothing had started", async () => {
    const id = await approved();
    h.gate.respond = () => {
      throw new Error("socket hang up");
    };
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "nothing had started, and it won't now" });
    h.clock.advance(6 * MINUTE);
    await h.core.tick();
    expect(h.gate.looks).toEqual([id]);
    expect(state(id)).toBe("VOIDED");
    expect(told()).toContain("did not run: nothing had started, and it won't now");
  });

  it("the gate saying someone else is running it, at the last look, is not knowing", async () => {
    const id = await approved();
    h.gate.respond = () => {
      throw new Error("socket hang up");
    };
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "another gate process is executing this request" });
    h.clock.advance(6 * MINUTE);
    await h.core.tick();
    expect(state(id)).toBe("OUTCOME_UNKNOWN");
  });

  it("a gate that says nothing ran wipes the earlier doubt, so giving up later is known too", async () => {
    const id = await approved();
    h.gate.respond = () => {
      throw new Error("socket hang up");
    };
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(request(id).execAttempts).toBe(1);
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "acme was not reached; nothing ran and a retry is safe" });
    h.clock.advance(5_000);
    await h.core.tick();
    expect(request(id).execAttempts).toBe(0);
    h.clock.advance(5 * MINUTE);
    await h.core.tick();
    expect(state(id)).toBe("VOIDED");
    expect(h.gate.looks).toEqual([]);
  });

  it("nothing tries it again, it only looks, and a break-glass that ends this way says the same", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "outcome unknown: acme did not answer" });
    await says(PARTICIPANTS.alex, `@clearance breakglass ${held.request_id} checkout is down`);
    expect(state(held.request_id)).toBe("OUTCOME_UNKNOWN");
    expect(told()).toContain("nobody can say whether it ran");
    const runs = h.gate.calls.length - h.gate.looks.length;
    h.clock.advance(MINUTE);
    await h.core.tick();
    expect(h.gate.calls.length - h.gate.looks.length).toBe(runs);
  });

  it("is on the ledger, in the digest, and the chain still verifies", async () => {
    const id = await approved();
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "outcome unknown: acme did not answer" });
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    const entries = h.core.stores.ledger.list({ requestId: id });
    expect(entries.find((entry) => entry.type === "outcome_unknown")?.payload).toMatchObject({ error: "acme did not answer" });
    expect(entries.map((entry) => entry.type)).not.toContain("executed");
    expect(h.core.digest().requests).toMatchObject({ outcome_unknown: 1 });
    expect(h.core.digest().text).toContain("1 with an unknown outcome");
    expect(h.core.verifyLedger().ok).toBe(true);
  });
});

describe("B6: an identical call", () => {
  beforeEach(() => says(PARTICIPANTS.priya, "@refunds-agent refund it"));

  it("is fine once the window has passed", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", h.clock.nowMs());
    await h.core.check(gateRefund(SMALL, support));
    h.clock.advance(24 * 60 * MINUTE + 1);
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    expect((await h.core.check(gateRefund(SMALL, support))).decision).toBe("allow");
  });

  it("isn't blocked outright: a person who sees the flag can still approve it", async () => {
    const first = await h.core.check(gateRefund(SMALL, support));
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    const second = await h.core.check(gateRefund(SMALL, support));
    expect(flagCodes(second.request_id)).toContain("ran_recently");
    expect(cardIn("dm-sam").detail).toContain(`An identical call ran as ${first.request_id} at 14:00 IST`);
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(state(second.request_id)).toBe("EXECUTED");
  });

  it("the hold at L2 says what it's a repeat of, and doesn't demote", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L2", h.clock.nowMs());
    const first = await h.core.check(gateRefund(SMALL, support));
    const second = await h.core.check(gateRefund(SMALL, support));
    expect(second.decision).toBe("hold");
    expect(second.flags?.[0]?.text).toContain(first.request_id);
    expect(h.core.stores.autonomy.levelFor("refunds-agent", "refund", "small")).toBe("L2");
  });

  it("the same action delivered twice is one call, not a repeat of itself", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", h.clock.nowMs());
    const action = gateRefund(SMALL, support);
    const first = await h.core.check(action);
    const again = await h.core.check(action);
    expect(again).toMatchObject({ decision: "allow", request_id: first.request_id });
  });

  it("another agent's identical call is its own", async () => {
    h.core.stores.autonomy.setLevel("support-agent", "refund", "small", "L3", h.clock.nowMs());
    await h.core.check(gateRefund(SMALL, support));
    const other = await h.core.check(gateRefund(SMALL, { ...support, agent: { name: "support-agent" } }));
    expect(flagCodes(other.request_id)).not.toContain("ran_recently");
  });

  it("a denied or expired call isn't a call that ran", async () => {
    const first = await h.core.check(gateRefund(SMALL, support));
    await press(cardIn("dm-sam"), PARTICIPANTS.sam, "deny");
    expect(state(first.request_id)).toBe("DENIED");
    const second = await h.core.check(gateRefund(SMALL, support));
    expect(flagCodes(second.request_id)).not.toContain("ran_recently");
  });

  it("a hook call that ran under its grant isn't flagged by its own retry", async () => {
    const held = await h.core.check(hookShell("git push origin main"));
    const id = held.request_id as string;
    await says(PARTICIPANTS.alex, `@clearance breakglass ${id} it cannot wait`);
    expect(state(id)).toBe("GRANTED");
    expect((await h.core.check(hookShell("git push origin main"))).decision).toBe("allow");
    expect(state(id)).toBe("CONSUMED");
    const next = await h.core.check(hookShell("git push origin main"));
    expect(next.decision).toBe("hold");
    expect(flagCodes(next.request_id)).toContain("ran_recently");
  });
});

describe("B7: late messages", () => {
  it("a message sent after the hold isn't one that led to it", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    h.clock.advance(MINUTE);
    await says(PARTICIPANTS.sam, "@refunds-agent how's it going?", "#finance", { timestampMs: h.clock.nowMs() });
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(state(held.request_id)).toBe("EXECUTED");
  });

  it("a message from before the window isn't either", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    await says(PARTICIPANTS.sam, "@refunds-agent yesterday's thing", "#finance", { timestampMs: h.clock.nowMs() - 11 * MINUTE });
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(state(held.request_id)).toBe("EXECUTED");
  });

  it("the refusal puts it to someone else, so the request isn't stuck", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    await says(PARTICIPANTS.sam, "@refunds-agent refund it", "#finance", { timestampMs: h.clock.nowMs() - MINUTE });
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(state(held.request_id)).toBe("ROUTED");
    await press(cardIn("dm-neha"), PARTICIPANTS.neha);
    expect(state(held.request_id)).toBe("EXECUTED");
  });

  it("a late voice in a room the agent is in bars them too, and survives the window closing", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    await says(PARTICIPANTS.sam, "please do that refund", "#support", { timestampMs: h.clock.nowMs() - MINUTE });
    h.clock.advance(11 * MINUTE);
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(state(held.request_id)).toBe("ROUTED");
  });
});

describe("B9: delegates", () => {
  it("someone away who didn't ask can still hand over", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await says(PARTICIPANTS.neha, "@clearance away until 18:00 delegate @dev", "dm-neha", { channelType: "direct" });
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(h.core.describeRequest(held.request_id as string)?.state).toBe("ROUTED");
    h.core.stores.routes.close(0);
    await press(cardIn("#support"), PARTICIPANTS.dev);
    expect(state(held.request_id)).toBe("EXECUTED");
  });

  it("someone whose approval already counted has nothing left to hand on", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund({ ...REFUND_SC4, amount: 150000 }, support));
    const nehas = cardIn("dm-neha");
    await h.core.onApprovalOutcome({ sessionId: nehas.sessionId, switchRequestId: nehas.switchRequestId, kind: "questions", state: "answered", answer: null, answers: [{ question_id: nehas.questions[0]?.id ?? "x", custom_text: '"150000"', selected_option_ids: [] }], answeredBy: PARTICIPANTS.neha, answeredAtMs: h.clock.nowMs() });
    expect(h.core.stores.answers.countedApprovers(held.request_id as string)).toEqual(["neha"]);
    await says(PARTICIPANTS.neha, "@clearance away until 18:00 delegate @dev", "dm-neha", { channelType: "direct" });
    await press(cardIn("#support"), PARTICIPANTS.dev);
    expect(h.core.stores.answers.countedApprovers(held.request_id as string)).toEqual(["neha"]);
    expect(h.gate.calls).toEqual([]);
  });
});

describe("B10: break-glass", () => {
  it("someone whose ask came late can't break glass on what it led to", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    await says(PARTICIPANTS.alex, "@refunds-agent refund it", "#eng", { timestampMs: h.clock.nowMs() - MINUTE });
    await says(PARTICIPANTS.alex, `@clearance breakglass ${held.request_id} it cannot wait`);
    expect(h.gate.calls).toEqual([]);
    expect(state(held.request_id)).toBe("ROUTED");
  });

  it("nor review a break-glass they asked for", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await says(PARTICIPANTS.sam, "@refunds-agent refund it", "#finance");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    await says(PARTICIPANTS.alex, `@clearance breakglass ${held.request_id} it cannot wait`);
    expect(h.core.stores.routes.forRequest(held.request_id as string).filter((row) => row.step === "glass_review").map((row) => row.user_id)).not.toContain("sam");
  });
});

describe("B11: what counts as an ask", () => {
  it("a mention of someone or something known isn't a possible alias", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    for (const mention of ["@sam", "@Neha", "@here", "@channel", "@finance", "@finance-approvers"]) {
      await says(PARTICIPANTS.sam, `${mention} have a look`, "#finance");
    }
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(request(held.request_id).quorumRequired).toBe(1);
  });

  it("a name nobody knows only counts for the window", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await says(PARTICIPANTS.sam, "@refunds refund order A-2004", "#finance");
    h.clock.advance(11 * MINUTE);
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(flagCodes(held.request_id)).not.toContain("possible_alias");
  });

  it("the card says why it takes two", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await says(PARTICIPANTS.sam, "@refunds refund order A-2004", "#finance");
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(flagCodes(held.request_id)).toContain("possible_alias");
    expect(cardIn("dm-neha").detail).toContain("could be this agent under an alias");
  });
});

describe("B12: a long turn", () => {
  it("ends when the agent answers in that room", async () => {
    await says(PARTICIPANTS.sam, "@refunds-agent refund order A-2004 in full");
    h.clock.advance(MINUTE);
    await says(PARTICIPANTS.refundsAgent, "Done with that.");
    h.clock.advance(8 * MINUTE);
    await says(PARTICIPANTS.priya, "@refunds-agent how is the other ticket going?");
    h.clock.advance(2 * MINUTE);
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect((request(held.request_id).evidence as { askedElsewhereIds?: string[] }).askedElsewhereIds).toBeUndefined();
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(state(held.request_id)).toBe("EXECUTED");
  });

  it("isn't ended by what Switch posts in the agent's name, which is not the agent answering", async () => {
    await says(PARTICIPANTS.sam, "@refunds-agent refund order A-2004 in full");
    h.clock.advance(MINUTE);
    await says(PARTICIPANTS.refundsAgent, "My machine, **acme-host**, was asleep and is starting now. I'll pick this up as soon as it's back, usually within a few minutes.");
    h.clock.advance(8 * MINUTE);
    await says(PARTICIPANTS.priya, "@refunds-agent how is the other ticket going?");
    h.clock.advance(2 * MINUTE);
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect((request(held.request_id).evidence as { askedElsewhereIds?: string[] }).askedElsewhereIds).toEqual(["sam"]);
    expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toEqual([]);
  });

  it("gives up after an hour: an agent that never answers can't bar someone for ever", async () => {
    await says(PARTICIPANTS.sam, "@refunds-agent refund order A-2004 in full");
    h.clock.advance(61 * MINUTE);
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(state(held.request_id)).toBe("EXECUTED");
  });
});

describe("B13: a card that failed to open", () => {
  it("isn't a card anyone holds, so the tick opens another", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    h.chat.failOpenCard = true;
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(h.core.stores.routes.forRequest(held.request_id as string)).toEqual([]);
    h.chat.failOpenCard = false;
    await h.core.tick();
    expect(h.core.stores.routes.openForRequest(held.request_id as string).map((row) => row.card_room)).toContain("dm-sam");
  });

  it("left opening by a process that stopped doesn't stop the request routing again", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const open = h.chat.openCard.bind(h.chat);
    h.chat.openCard = () => new Promise(() => undefined);
    void h.core.check(gateRefund(REFUND_SC4, support));
    await new Promise((done) => setImmediate(done));
    const id = h.core.stores.requests.listInState(["HELD"])[0]?.id as string;
    h.chat.openCard = open;
    h = h.restart();
    expect(h.core.stores.routes.openForRequest(id)).toEqual([]);
    await h.core.tick();
    expect(h.core.stores.routes.openForRequest(id).map((row) => row.card_room)).toContain("dm-sam");
  });
});

describe("B14: lost events", () => {
  it("are wired to the stream's gap frame, last the window, and survive a restart", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await streamHandlers(h.core).gap();
    h = h.restart();
    const during = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(flagCodes(during.request_id)).toContain("messages_lost");
    h.clock.advance(11 * MINUTE);
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const after = await h.core.check(gateRefund({ ...REFUND_SC4, amount: 30000 }, support));
    expect(flagCodes(after.request_id)).not.toContain("messages_lost");
    expect(request(after.request_id).quorumRequired).toBe(1);
  });
});

describe("B15: an author nobody can find", () => {
  it("a shell git push has no author to find, and goes to one person, unchanged: SC7", async () => {
    await says(PARTICIPANTS.alex, "@coder push it", "#eng");
    h.lookup.failing = true;
    const held = await h.core.check(hookShell("git push origin main"));
    expect(flagCodes(held.request_id)).toContain("author_unknown");
    expect(request(held.request_id).quorumRequired).toBe(1);
    expect(request(held.request_id).flags.find((flag) => flag.code === "author_unknown")?.text).toBe("Could not tell who the author is, so nobody was excluded for it");
  });
});

describe("B18: who owns what", () => {
  it("a system of record that doesn't say holds at L3, with no words on the card to explain", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", h.clock.nowMs());
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    // A copy: the fake's world is shared between tests.
    h.lookup.world = structuredClone(h.lookup.world);
    const world = h.lookup.world as Record<string, Record<string, Record<string, unknown>>>;
    const { customer_id: _gone, ...noOwner } = world.destinations?.["rohan.s@okhdfc"] as Record<string, unknown>;
    (world.destinations as Record<string, unknown>)["rohan.s@okhdfc"] = noOwner;
    const held = await h.core.check(gateRefund(SMALL, support));
    expect(held.decision).toBe("hold");
    expect(flagCodes(held.request_id)).toEqual([]);
  });

  it("at L0, not knowing changes nothing on the card", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    // A copy: the fake's world is shared between tests.
    h.lookup.world = structuredClone(h.lookup.world);
    const world = h.lookup.world as Record<string, Record<string, Record<string, unknown>>>;
    const { customer_id: _gone, ...noOwner } = world.destinations?.["rohan.s@okhdfc"] as Record<string, unknown>;
    (world.destinations as Record<string, unknown>)["rohan.s@okhdfc"] = noOwner;
    await h.core.check(gateRefund(SMALL, support));
    expect(cardIn("dm-sam").detail).not.toMatch(/belongs to|Could not verify/);
  });

  it("the card names both customers", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await h.core.check(gateRefund({ order_id: "A-1931", customer_id: "cus_8812", amount: 4000, destination: "rohan.s@okhdfc" }, support));
    expect(cardIn("dm-sam").detail).toContain("The destination belongs to cus_2044, not cus_8812");
    await h.core.check(gateRefund({ order_id: "A-1931", customer_id: "cus_2044", amount: 4001, destination: "rohan.s@okhdfc" }, support));
    expect(cardIn("dm-sam").detail).toContain("The order belongs to cus_8812, not cus_2044");
  });
});

describe("B23: over the limit", () => {
  it("the card and the trace both say so, and only when it fires", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const first = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(cardIn("dm-sam").detail).not.toContain("over the limit");
    for (let i = 0; i < 12; i += 1) await h.core.check(gateRefund({ ...REFUND_SC4, amount: 11000 + i }, support));
    expect(first.request_id).toBeDefined();
    const busy = await h.core.check(gateRefund({ ...REFUND_SC4, amount: 99999 }, support));
    expect(h.core.traces.latest(busy.request_id as string)?.capped.map((entry) => entry.id).sort()).toEqual(["neha", "sam"]);
    const [row] = h.core.stores.routes.forRequest(busy.request_id as string).filter((one) => one.user_id);
    const card = h.chat.cards.find((one) => one.switchRequestId === row?.switch_request_id) as OpenedCard;
    expect(card.detail).toContain("open cards, over the limit, but nobody else eligible is free");
  });

  it("someone free still goes first", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    for (let i = 0; i < 6; i += 1) await h.core.check(gateRefund({ ...REFUND_SC4, amount: 11000 + i }, support));
    expect(h.core.stores.routes.openCount("sam")).toBe(6);
    const next = await h.core.check(gateRefund({ ...REFUND_SC4, amount: 20000 }, support));
    expect(h.core.stores.routes.forRequest(next.request_id as string).map((row) => row.card_room)).toContain("dm-neha");
    expect(h.core.stores.routes.forRequest(next.request_id as string).map((row) => row.card_room)).not.toContain("dm-sam");
  });

  it("nobody eligible at all still goes to the fallback, as it did", async () => {
    await says(PARTICIPANTS.sam, "@refunds-agent refund it");
    await says(PARTICIPANTS.neha, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(h.core.stores.routes.forRequest(held.request_id as string).map((row) => row.card_room)).toContain("#approvals");
  });
});

describe("suspected: an autonomous run that didn't go through", () => {
  const TOKEN = "t".repeat(32);
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildServer(h.core, { internalToken: TOKEN });
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L2", h.clock.nowMs());
    return says(PARTICIPANTS.priya, "@refunds-agent refund it");
  });
  afterEach(() => app.close());
  const report = (id: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/v1/requests/${id}/run-failed`, payload: payload as object, headers: { authorization: `Bearer ${TOKEN}` } });

  it("confirmed, and now fixed: known not to have run, it comes off the record and the budget, and the review closes", async () => {
    const allowed = await h.core.check(gateRefund(SMALL, support));
    const id = allowed.request_id as string;
    expect(state(id)).toBe("AUTO");
    expect((await report(id, { never_ran: true, error: "acme was not reached" })).json()).toMatchObject({ ok: true });
    expect(state(id)).toBe("VOIDED");
    expect(h.core.stores.routes.openForRequest(id)).toEqual([]);
    expect(h.core.stores.aggregates.sum("refund", "customer", "cus_2044", 0)).toBe(0);
    expect(h.core.stores.autonomy.spentToday("refunds-agent", "refund", "small", h.clock.nowMs())).toBe(0);
    expect(told()).toContain(`${id} was allowed to run on its own, and it did not: acme was not reached.`);
    // So the same call isn't a repeat of something that never happened.
    const again = await h.core.check(gateRefund(SMALL, support));
    expect(again.decision).toBe("allow");
  });

  it("not known either way: unknown, it stays on the budget, and it says not to retry", async () => {
    const allowed = await h.core.check(gateRefund(SMALL, support));
    const id = allowed.request_id as string;
    await report(id, { never_ran: false, error: "outcome unknown: acme did not answer" });
    expect(state(id)).toBe("OUTCOME_UNKNOWN");
    expect(h.core.stores.aggregates.sum("refund", "customer", "cus_2044", 0)).toBe(3000);
    expect(h.chat.targeted.at(-1)?.body).toContain(`Nobody can say whether ${id} ran: acme did not answer. Do not retry it.`);
    const again = await h.core.check(gateRefund(SMALL, support));
    expect(again.decision).toBe("hold");
    expect(flagCodes(again.request_id)).toContain("may_have_run");
  });

  it("only applies to what ran alone, needs the token, and takes only its own shape", async () => {
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect((await report(held.request_id as string, { never_ran: true, error: "x" })).json()).toMatchObject({ ok: false, answer: "not_auto" });
    expect(state(held.request_id)).toBe("ROUTED");
    expect((await report("CLR-9999", { never_ran: true, error: "x" })).statusCode).toBe(404);
    expect((await report(held.request_id as string, { never_ran: "yes" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/v1/requests/${held.request_id}/run-failed`, payload: { never_ran: true, error: "x" } })).statusCode).toBe(401);
  });
});

describe("suspected: a patch touching two protected files", () => {
  const TOKEN = "hook-token-for-coder-000000000000";
  const patch = "*** Begin Patch\n*** Update File: .github/workflows/a.yml\n@@\n-x\n+y\n*** Update File: .github/workflows/b.yml\n@@\n-x\n+y\n*** End Patch";
  let app: FastifyInstance;
  beforeEach(async () => {
    app = Fastify();
    await app.register(async (scope) => {
      hookRoutes(scope, {
        check: (action) => h.core.check(action),
        resolveAgent: (cwd, agentType) => h.core.resolveAgent(cwd, agentType),
        hookTokens: { [TOKEN]: "coder" },
      });
    });
  });
  afterEach(() => app.close());
  const send = () =>
    app.inject({
      method: "POST",
      url: "/v1/hooks/codex",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      // A directory that belongs to the agent. Any other is refused before the patch is read, with no request at all.
      payload: JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", cwd: `${homedir()}/.switch/agents/demo-host/coder`, tool_name: "apply_patch", tool_input: { command: patch } }),
    });

  /** `checkAll` used to spend the first file's grant, then refuse on the second, so nothing ran and the approval was gone. */
  it("a refused patch must not spend the grant on its first file", async () => {
    await send();
    const first = h.core.stores.requests.listInState(["HELD", "ROUTED"])[0]?.id as string;
    const { callHash, agent } = request(first);
    if (state(first) === "HELD") h.core.stores.requests.transition(first, "ROUTED");
    h.core.stores.requests.transition(first, "APPROVED");
    h.core.stores.grants.mint(first, callHash, agent, 10 * MINUTE);
    h.core.stores.requests.transition(first, "GRANTED");
    await send();
    expect(state(first)).toBe("GRANTED");
  });
});
