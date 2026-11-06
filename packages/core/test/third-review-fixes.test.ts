/**
 * What third-review.test.ts doesn't reach: the other edge of each fix, what a fix must not change, and the words a person
 * reads when a card can't complete. The review's own tests stay in that file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withoutRequestFragments } from "../src/router/requesters.js";
import { isSwitchNotice } from "../src/router/switch-notices.js";
import type { OpenedCard } from "./fakes.js";
import { actionId, chatMessage, gateRefund, makeHarness, MINUTE, NOW, PARTICIPANTS, REFUND_SC4, WORLD, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
  h.lookup.world = structuredClone(WORLD);
});
afterEach(() => {
  try {
    h.core.close();
  } catch {
    // A test that restarted closed it already.
  }
});

const support = { session: { switchRoomId: "#support", threadId: "t-1" } };
const SMALL = { order_id: "A-2004", customer_id: "cus_2044", amount: 3000, destination: "rohan.s@okhdfc" };
const says = (who: string, body: string, roomId = "#support", overrides: Parameters<typeof chatMessage>[2] = {}) =>
  h.core.onMessage(chatMessage(who, body, { roomId, threadId: null, addressed: true, ...overrides }));
const press = (card: { sessionId: string; switchRequestId: string }, who: string, answer = "allow") =>
  h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer, answeredBy: who, answeredAtMs: h.clock.nowMs() });
const request = (id: string | undefined) => h.core.stores.requests.require(id as string);
const state = (id: string | undefined) => request(id).state;
const flagCodes = (id: string | undefined) => request(id).flags.map((flag) => flag.code);
const cardIn = (room: string): OpenedCard => h.chat.cards.filter((card) => card.roomId === room).at(-1) as OpenedCard;
const rooms = (id: string | undefined) => h.core.stores.routes.forRequest(id as string).map((row) => row.card_room);
const told = () => [...h.chat.messages.map((m) => m.body), ...h.chat.targeted.map((m) => m.body)].join("\n");
const elsewhere = (id: string | undefined) => (request(id).evidence as { askedElsewhereIds?: string[] }).askedElsewhereIds ?? [];
const deployCall = (agent = "ops-agent") => {
  const args = { service: "checkout", env: "prod", version: "v2.13.2" };
  return { id: actionId(), at: new Date(NOW).toISOString(), source: "gate" as const, vendor: "gate" as const, agent: { name: agent }, session: { switchRoomId: "#support", threadId: "t-1" }, kind: "business" as const, raw: args, business: { endpoint: "POST /acme/deploys", args } };
};

describe("T1: which names can raise a quorum", () => {
  const { directory } = { directory: () => h.core.people.directory };

  it.each([
    ["refunds-agent", "refunds"],
    ["refunds-agent", "Refunds"],
    ["refunds-agent", "refund"],
    ["refunds-agent", "refunds-bot"],
    ["refunds-agent", "refundsbot"],
    ["refunds-agent", "refunds_agent"],
    ["ops-agent", "ops"],
    ["coder", "coderbot"],
  ])("%s could be called @%s", (agent, name) => {
    expect(directory().couldBeNameOf(agent, name)).toBe(true);
  });

  it.each([
    ["ops-agent", "2pm"],
    ["ops-agent", "types"],
    ["support-agent", "vendor-support"],
    ["refunds-agent", "ref"],
    ["refunds-agent", "refunds-team"],
    ["refunds-agent", "sam"],
    ["refunds-agent", "Priya"],
    ["refunds-agent", "finance"],
    ["refunds-agent", "here"],
    ["refunds-agent", "support-agent"],
  ])("%s isn't @%s", (agent, name) => {
    expect(directory().couldBeNameOf(agent, name)).toBe(false);
  });

  it("a person's name, an npm scope or a time, from anyone in any room, changes nothing", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    for (const body of ["ask @sam", "ping @Neha", "add @types/node", "meet @2pm", "cc @vendor-support", "@here anyone?"]) {
      await says(PARTICIPANTS.guest, body, "#random", { addressed: false });
    }
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(request(held.request_id).quorumRequired).toBe(1);
    expect(flagCodes(held.request_id)).not.toContain("possible_alias");
  });

  it("a name that could be this agent still raises it, for this agent and no other", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await says(PARTICIPANTS.priya, "@ops-agent look at checkout");
    await says(PARTICIPANTS.sam, "@refunds refund order A-2004", "#finance", { addressed: false });
    const refund = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(request(refund.request_id).quorumRequired).toBe(2);
    expect(flagCodes(refund.request_id)).toContain("possible_alias");
    const deploy = await h.core.check(deployCall());
    expect(flagCodes(deploy.request_id)).not.toContain("possible_alias");
    expect(request(deploy.request_id).quorumRequired).toBe(1);
  });

  describe("when Switch can say what a room's aliases are", () => {
    const aliases = (map: Record<string, string>) => {
      h.chat.roomAliases = async () => map;
    };

    it("an alias nobody could guess is the agent, so whoever used it asked, and can't approve", async () => {
      aliases({ tf: "refunds-agent" });
      await says(PARTICIPANTS.priya, "@refunds-agent refund it");
      await says(PARTICIPANTS.sam, "@tf refund order A-2004", "#finance", { addressed: false });
      const held = await h.core.check(gateRefund(REFUND_SC4, support));
      expect(elsewhere(held.request_id)).toContain("sam");
      expect(rooms(held.request_id)).not.toContain("dm-sam");
      expect(request(held.request_id).quorumRequired).toBe(1);
      expect(flagCodes(held.request_id)).not.toContain("possible_alias");
    });

    it("a name that looks like the agent, but isn't its alias there, is nothing", async () => {
      aliases({ tf: "refunds-agent" });
      await says(PARTICIPANTS.priya, "@refunds-agent refund it");
      await says(PARTICIPANTS.sam, "@refunds is a nice channel name", "#finance", { addressed: false });
      const held = await h.core.check(gateRefund(REFUND_SC4, support));
      expect(request(held.request_id).quorumRequired).toBe(1);
      expect(flagCodes(held.request_id)).not.toContain("possible_alias");
    });

    it("only asks when a message names something it can't place, and remembers for a while", async () => {
      let asked = 0;
      h.chat.roomAliases = async () => {
        asked += 1;
        return {};
      };
      await says(PARTICIPANTS.priya, "@refunds-agent refund it");
      await says(PARTICIPANTS.sam, "hello @neha", "#finance", { addressed: false });
      expect(asked).toBe(0);
      await says(PARTICIPANTS.sam, "ping @someone", "#finance", { addressed: false });
      await says(PARTICIPANTS.sam, "ping @someone-else", "#finance", { addressed: false });
      expect(asked).toBe(1);
      h.clock.advance(MINUTE + 1);
      await says(PARTICIPANTS.sam, "ping @someone", "#finance", { addressed: false });
      expect(asked).toBe(2);
    });

    it("Switch not answering falls back on the agent's own name forms, and doesn't hold up the stream", async () => {
      h.chat.roomAliases = () => Promise.reject(new Error("switch unreachable"));
      await says(PARTICIPANTS.priya, "@refunds-agent refund it");
      await says(PARTICIPANTS.sam, "@refunds refund order A-2004", "#finance", { addressed: false });
      await says(PARTICIPANTS.sam, "@tf refund order A-2004", "#finance", { addressed: false });
      const held = await h.core.check(gateRefund(REFUND_SC4, support));
      expect(flagCodes(held.request_id)).toContain("possible_alias");
    });
  });

  describe("a card that can't complete says so", () => {
    const stuck = async () => {
      await says(PARTICIPANTS.priya, "@ops-agent look at checkout");
      await says(PARTICIPANTS.dev, "@ops refresh it", "#random", { addressed: false });
      return h.core.check(deployCall());
    };

    it("in words, on the person's card and the group's, with what to do", async () => {
      const held = await stuck();
      expect(request(held.request_id).quorumRequired).toBe(2);
      for (const room of ["dm-alex", "#approvals"]) {
        const { detail } = cardIn(room);
        expect(detail).toContain("It takes two people to approve this, and only Alex can, so it can't complete.");
        expect(detail).toContain("add an approver");
        expect(detail).toContain("ask eng-leads");
        expect(detail).toContain(`have Alex run \`@clearance breakglass ${held.request_id} why\``);
      }
    });

    it("the room is told too, once", async () => {
      const held = await stuck();
      const line = `${held.request_id}: It takes two people`;
      expect(h.chat.messages.filter((m) => m.body.startsWith(line))).toHaveLength(1);
      h.clock.advance(5_000);
      await h.core.tick();
      await h.core.tick();
      expect(h.chat.messages.filter((m) => m.body.startsWith(line))).toHaveLength(1);
    });

    it("fits a question card's limit, so the command is never the part cut off", async () => {
      const held = await stuck();
      const flag = cardIn("dm-alex").detail.split("\n").find((text) => text.includes("can't complete")) as string;
      expect(flag.trim().length).toBeLessThanOrEqual(200);
      expect(flag).toContain(`@clearance breakglass ${held.request_id} why`);
    });

    it("and stays fail closed: Alex's approval doesn't finish it, and break-glass does, as it says", async () => {
      const held = await stuck();
      await press(cardIn("dm-alex"), PARTICIPANTS.alex);
      expect(h.gate.calls).toEqual([]);
      expect(state(held.request_id)).toBe("ROUTED");
      await says(PARTICIPANTS.alex, `@clearance breakglass ${held.request_id} checkout is down`, "#eng");
      expect(h.gate.calls).toHaveLength(1);
    });

    it("nothing is added when enough people can answer", async () => {
      await says(PARTICIPANTS.priya, "@refunds-agent refund it");
      await says(PARTICIPANTS.sam, "@refunds refund it", "#finance", { addressed: false });
      await h.core.check(gateRefund(REFUND_SC4, support));
      expect(cardIn("dm-sam").detail).not.toContain("can't complete");
      expect(told()).not.toContain("can't complete");
    });

    it("a request one person could decide, with nobody eligible, keeps its old words", async () => {
      await says(PARTICIPANTS.sam, "@refunds-agent refund it");
      await says(PARTICIPANTS.neha, "@refunds-agent refund it");
      const held = await h.core.check(gateRefund(REFUND_SC4, support));
      expect(h.core.traces.latest(held.request_id as string)?.shortOfPeople).toBeUndefined();
      expect(told()).toContain(`Nobody eligible for ${held.request_id}`);
    });
  });
});

describe("T2: guessing who asked can't move a decision", () => {
  it("a room the agent hasn't been in for an hour is just a room", async () => {
    await says(PARTICIPANTS.refundsAgent, "Morning all.", "#finance");
    h.clock.advance(61 * MINUTE);
    await says(PARTICIPANTS.sam, "anyone free?", "#finance", { addressed: false });
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(elsewhere(held.request_id)).toEqual([]);
    expect(request(held.request_id).quorumRequired).toBe(1);
    expect(rooms(held.request_id)).toContain("dm-sam");
  });

  it("when it would move the decision, those people stay, two must agree, and the card says why", async () => {
    await says(PARTICIPANTS.refundsAgent, "Morning all.", "#finance");
    await says(PARTICIPANTS.sam, "anyone free?", "#finance", { addressed: false });
    await says(PARTICIPANTS.neha, "after lunch", "#finance", { addressed: false });
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(request(held.request_id).quorumRequired).toBe(2);
    expect(flagCodes(held.request_id)).toContain("may_have_asked");
    expect(rooms(held.request_id)).toEqual(expect.arrayContaining(["dm-sam", "dm-neha"]));
    expect(rooms(held.request_id)).not.toContain("#approvals");
    expect(cardIn("dm-sam").detail).toContain("Sam and Neha spoke where this agent was");
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(h.gate.calls).toEqual([]);
    await press(cardIn("dm-neha"), PARTICIPANTS.neha);
    expect(state(held.request_id)).toBe("EXECUTED");
  });

  it("when someone else can decide, a guess still bars: one person who spoke, and another free", async () => {
    await says(PARTICIPANTS.refundsAgent, "Morning all.", "#finance");
    await says(PARTICIPANTS.sam, "refund order A-2004 please", "#finance", { addressed: false });
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(elsewhere(held.request_id)).toEqual(["sam"]);
    expect(request(held.request_id).quorumRequired).toBe(1);
    expect(rooms(held.request_id)).toContain("dm-neha");
    expect(flagCodes(held.request_id)).not.toContain("may_have_asked");
  });

  it("naming the agent isn't a guess: if everyone who could decide did, it goes to the fallback, as it did", async () => {
    await says(PARTICIPANTS.sam, "@refunds-agent refund it");
    await says(PARTICIPANTS.neha, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(rooms(held.request_id)).toContain("#approvals");
    expect(rooms(held.request_id)).not.toContain("dm-sam");
    expect(flagCodes(held.request_id)).not.toContain("may_have_asked");
  });

  it("an edit of it keeps both the people and the second approval", async () => {
    await says(PARTICIPANTS.refundsAgent, "Morning all.", "#finance");
    await says(PARTICIPANTS.sam, "anyone free?", "#finance", { addressed: false });
    await says(PARTICIPANTS.neha, "after lunch", "#finance", { addressed: false });
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    await says(PARTICIPANTS.sam, `@clearance counter ${held.request_id} 4000`, "#finance");
    const offer = h.chat.cards.filter((card) => card.title.includes("COUNTER")).at(-1) as OpenedCard;
    await h.core.onApprovalOutcome({ sessionId: offer.sessionId, switchRequestId: offer.switchRequestId, kind: "questions", state: "answered", answer: null, answers: [{ question_id: offer.questions[0]?.id ?? "x", custom_text: '"hdfc"', selected_option_ids: [] }], answeredBy: PARTICIPANTS.sam, answeredAtMs: h.clock.nowMs() });
    const next = h.core.listRequests().map((row) => row.id as string).find((id) => id !== held.request_id) as string;
    expect(request(next).quorumRequired).toBe(2);
    expect(flagCodes(next)).toContain("may_have_asked");
    expect(h.gate.calls).toEqual([]);
  });
});

describe("T9: what a broken gate means", () => {
  it("doesn't wipe the doubt from an earlier attempt, so giving up later still says nobody knows", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    h.gate.respond = () => {
      throw new Error("socket hang up");
    };
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, status: 503, error: "gate answered 503" });
    h.clock.advance(6_000);
    await h.core.tick();
    expect(request(held.request_id).execAttempts).toBeGreaterThan(0);
    h.clock.advance(5 * MINUTE);
    await h.core.tick();
    expect(state(held.request_id)).toBe("OUTCOME_UNKNOWN");
    expect(told()).not.toContain("did not run");
  });
});

describe("T10: finding out, and saying", () => {
  async function unknown(): Promise<string> {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "outcome unknown: acme did not answer" });
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(state(held.request_id)).toBe("OUTCOME_UNKNOWN");
    return held.request_id as string;
  }

  describe("the tick looks again", () => {
    it("only ever looks, so it can't start anything", async () => {
      const id = await unknown();
      const runs = h.gate.calls.length - h.gate.looks.length;
      for (let i = 0; i < 3; i += 1) {
        h.clock.advance(MINUTE);
        await h.core.tick();
      }
      expect(h.gate.looks.filter((one) => one === id)).toHaveLength(3);
      expect(h.gate.calls.length - h.gate.looks.length).toBe(runs);
      expect(state(id)).toBe("OUTCOME_UNKNOWN");
    });

    it("the gate saying nothing started settles it the other way, and only then may it say did not run", async () => {
      const id = await unknown();
      expect(told()).not.toContain("did not run");
      h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "nothing had started, and it won't now" });
      h.clock.advance(MINUTE);
      await h.core.tick();
      expect(state(id)).toBe("VOIDED");
      expect(told()).toContain("did not run: nothing had started");
    });

    it("the gate not knowing, or not answering, leaves it as it is", async () => {
      const id = await unknown();
      h.clock.advance(MINUTE);
      await h.core.tick();
      expect(state(id)).toBe("OUTCOME_UNKNOWN");
      h.gate.respond = () => {
        throw new Error("gate down");
      };
      h.clock.advance(MINUTE);
      await h.core.tick();
      expect(state(id)).toBe("OUTCOME_UNKNOWN");
    });

    it("stops after a day, and comes back after a restart", async () => {
      const id = await unknown();
      h = h.restart();
      const looks = h.gate.looks.length;
      await h.core.tick();
      expect(h.gate.looks.length).toBe(looks + 1);
      h.clock.advance(24 * 60 * MINUTE + MINUTE);
      const after = h.gate.looks.length;
      await h.core.tick();
      expect(h.gate.looks.length).toBe(after);
      expect(state(id)).toBe("OUTCOME_UNKNOWN");
    });
  });

  describe("@clearance resolve", () => {
    it("records what a person found, on the ledger, and asks the gate for nothing", async () => {
      const id = await unknown();
      const calls = h.gate.calls.length;
      await says(PARTICIPANTS.sam, `@clearance resolve ${id} ran re_7731 is in Acme`, "#finance");
      expect(state(id)).toBe("EXECUTED");
      expect(h.gate.calls).toHaveLength(calls);
      expect(h.chat.messages.at(-1)?.body).toBe(`${id} recorded: it ran. Nothing else changed.`);
      const entry = h.core.stores.ledger.list({ requestId: id }).find((row) => row.type === "outcome_resolved");
      expect(entry?.payload).toMatchObject({ by: "sam", outcome: "ran", note: "re_7731 is in Acme" });
      expect(h.chat.targeted.at(-1)?.body).toBe(`${id}: Sam checked, and it ran: re_7731 is in Acme. Do not run it again.`);
      expect(h.core.verifyLedger().ok).toBe(true);
    });

    it("saying it didn't run takes it off the window, so asking again is fair", async () => {
      const id = await unknown();
      await says(PARTICIPANTS.neha, `@clearance resolve ${id} didnt no refund in Acme`, "#finance");
      expect(state(id)).toBe("VOIDED");
      expect(h.core.stores.aggregates.sum("refund", "customer", "cus_2044", 0)).toBe(0);
      expect(h.chat.targeted.at(-1)?.body).toContain("Ask again if it's still needed.");
      const again = await h.core.check(gateRefund(REFUND_SC4, support));
      expect(flagCodes(again.request_id)).not.toContain("may_have_run");
    });

    it("the person who approved it can say, because they're who'd go and look", async () => {
      const id = await unknown();
      await says(PARTICIPANTS.sam, `@clearance resolve ${id} didnt nothing there`, "#finance");
      expect(state(id)).toBe("VOIDED");
    });

    it.each([
      ["the person who asked", "priya"],
      ["someone who isn't an approver", "dev"],
    ] as const)("%s can't, and that's on the record", async (_who, person) => {
      const id = await unknown();
      await says(PARTICIPANTS[person], `@clearance resolve ${id} ran trust me`, "#finance");
      expect(state(id)).toBe("OUTCOME_UNKNOWN");
      expect(h.core.stores.ledger.list({ requestId: id }).find((row) => row.type === "ineligible_answer")?.payload).toMatchObject({ user_id: person, resolve: true });
    });

    it("an agent can't, whatever it writes", async () => {
      const id = await unknown();
      await says(PARTICIPANTS.refundsAgent, `@clearance resolve ${id} ran as sam`);
      expect(state(id)).toBe("OUTCOME_UNKNOWN");
    });

    it.each([
      ["no outcome", ""],
      ["something else", "maybe it did"],
      ["no note", "ran"],
    ])("%s gets told what to write", async (_name, words) => {
      const id = await unknown();
      await says(PARTICIPANTS.sam, `@clearance resolve ${id} ${words}`, "#finance");
      expect(state(id)).toBe("OUTCOME_UNKNOWN");
      expect(h.chat.messages.at(-1)?.body).toContain(`@clearance resolve ${id} ran|didnt`);
    });

    it("only applies to a call nobody can say about", async () => {
      await says(PARTICIPANTS.priya, "@refunds-agent refund it");
      const held = await h.core.check(gateRefund(REFUND_SC4, support));
      await says(PARTICIPANTS.sam, `@clearance resolve ${held.request_id} ran it did`, "#finance");
      expect(state(held.request_id)).toBe("ROUTED");
      expect(h.chat.messages.at(-1)?.body).toBe(`${held.request_id} is ROUTED, so there's nothing to record.`);
    });
  });
});

describe("T11: what counts as the agent's words", () => {
  it.each([
    ["only a report", "CLR-0001 approved and executed: refund of ₹2,000.", ""],
    ["a report and more", "CLR-0001 approved and executed: refund of ₹2,000. Now refunding ₹9,000.", "Now refunding ₹9,000."],
    ["a clause", "Refunding ₹4,000 for order A-2004, as in CLR-0001.", "Refunding ₹4,000 for order A-2004,"],
    ["no CLR at all", "Refunding ₹4,000, then ₹5,000.", "Refunding ₹4,000, then ₹5,000."],
    ["an amount with a comma", "Refunding ₹40,000 as CLR-0001", ""],
  ])("%s", (_name, body, left) => {
    expect(withoutRequestFragments(body)).toBe(left);
  });

  it("the card quotes the sentence the room saw, not what's left of it", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await says(PARTICIPANTS.refundsAgent, "Refunding ₹4,000 for order A-2004, as in CLR-0001.");
    await h.core.check(gateRefund(REFUND_SC4, support));
    expect(cardIn("dm-sam").detail).toContain(`Agent's claim (unverified): "Refunding ₹4,000 for order A-2004, as in CLR-0001."`);
  });

  it.each([
    "I don't have a session in this room right now, so refunding ₹4,000 for order A-2004 on the machine I run on.",
    "I don't have a session connected to this room. Refunding ₹4,000 on the machine I run on.",
    "I have a session connected to this room, but it isn't reporting as live, so I'm not receiving messages. Refunding ₹4,000 on the machine I run on.",
    "@sam — you've stopped me, so I'm not running. Refunding ₹4,000 to bring me back.",
    "My machine, **x**, is offline or reconnecting to Switch, so I can't answer right now. Refunding ₹4,000 needs to check it.",
    "My machine, **x**, is stopped, so I can't answer. Refunding ₹4,000 can start it again in Switch Console.",
    "I hold a role in this room, but the session that assumed it is active in refunding ₹4,000 right now — I'll pick this up when it reconnects here.",
    "My machine, **refunding ₹4,000**, was asleep and is starting now. I'll pick this up as soon as it's back, usually within a few minutes.",
  ])("the shape of a notice with the agent's words in it isn't a notice: %s", (body) => {
    expect(isSwitchNotice(body)).toBe(false);
  });
});

describe("T12: what the agent said, when nobody's looking", () => {
  const atLevel = (level: "L2" | "L3") => h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", level, h.clock.nowMs());

  it("the same call, with the agent saying the right amount or nothing, still runs alone", async () => {
    atLevel("L3");
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    expect((await h.core.check(gateRefund(SMALL, support))).decision).toBe("allow");
    await says(PARTICIPANTS.refundsAgent, "Refunding ₹3,100 for order A-2004.");
    expect((await h.core.check(gateRefund({ ...SMALL, amount: 3100 }, support))).decision).toBe("allow");
  });

  it("a mismatch at L2 holds too, and shows the card", async () => {
    atLevel("L2");
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await says(PARTICIPANTS.refundsAgent, "Refunding ₹2,400 for order A-2004.");
    const held = await h.core.check(gateRefund(SMALL, support));
    expect(held.decision).toBe("hold");
    expect(flagCodes(held.request_id)).toContain("mismatch");
  });

  it("doesn't demote: it's one call, held for a look", async () => {
    atLevel("L3");
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await says(PARTICIPANTS.refundsAgent, "Refunding ₹2,400 for order A-2004.");
    await h.core.check(gateRefund(SMALL, support));
    expect(h.core.stores.autonomy.levelFor("refunds-agent", "refund", "small")).toBe("L3");
  });

  it("an agent's report on an earlier request doesn't stop the next one", async () => {
    atLevel("L3");
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await says(PARTICIPANTS.refundsAgent, "CLR-0001 approved and executed: refund of ₹2,000.");
    expect((await h.core.check(gateRefund(SMALL, support))).decision).toBe("allow");
  });
});

describe("T8, T14: telling people a call may already have gone", () => {
  it("the card says it's still being tried, and when it was approved", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const first = await h.core.check(gateRefund(REFUND_SC4, support));
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "acme was not reached; nothing ran and a retry is safe" });
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    await h.core.check(gateRefund(REFUND_SC4, support));
    const card = cardIn("dm-sam");
    // Sam's quick first answer makes this a typed card, which carries its evidence in the question.
    expect(card.detail || card.questions[0]?.prompt).toContain(`An identical call, ${first.request_id}, was approved at 14:00 IST and is still being tried, so both could run`);
  });

  it("at L3 a call still being tried isn't run again alone", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const first = await h.core.check(gateRefund(SMALL, support));
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "acme was not reached; nothing ran and a retry is safe" });
    await press(cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(state(first.request_id)).toBe("APPROVED");
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", h.clock.nowMs());
    expect((await h.core.check(gateRefund(SMALL, support))).decision).toBe("hold");
  });

  it("an edit of a call that just ran carries the warning too", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    const critical = { ...REFUND_SC4, amount: 150000 };
    const first = await h.core.check(gateRefund(critical, support));
    const done = async (id: string, card: OpenedCard, who: string) => {
      await h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "questions", state: "answered", answer: null, answers: [{ question_id: card.questions[0]?.id ?? "x", custom_text: card.questions[0]?.id === "amount" ? '"150000"' : '"hdfc"', selected_option_ids: [] }], answeredBy: who, answeredAtMs: h.clock.nowMs() });
      return id;
    };
    await done(first.request_id as string, cardIn("dm-sam"), PARTICIPANTS.sam);
    await done(first.request_id as string, cardIn("dm-neha"), PARTICIPANTS.neha);
    expect(state(first.request_id)).toBe("EXECUTED");
    const again = await h.core.check(gateRefund(critical, support));
    expect(flagCodes(again.request_id)).toContain("ran_recently");
    await says(PARTICIPANTS.sam, `@clearance counter ${again.request_id} 140000`, "#finance");
    const offer = h.chat.cards.filter((card) => card.title.includes("COUNTER")).at(-1) as OpenedCard;
    expect(offer.questions[0]?.prompt).toContain(`An identical call ran as ${first.request_id}`);
  });
});

describe("T16: the tick covers a request with nobody on it", () => {
  it("doesn't reopen a card on a request someone still holds", async () => {
    await says(PARTICIPANTS.priya, "@refunds-agent refund it");
    await h.core.check(gateRefund(REFUND_SC4, support));
    const cards = h.chat.cards.length;
    h.clock.advance(5_000);
    await h.core.tick();
    await h.core.tick();
    expect(h.chat.cards).toHaveLength(cards);
  });

  it("doesn't go on opening cards while the fallback already has one", async () => {
    await says(PARTICIPANTS.sam, "@refunds-agent refund it");
    await says(PARTICIPANTS.neha, "@refunds-agent refund it");
    await h.core.check(gateRefund(REFUND_SC4, support));
    const cards = h.chat.cards.length;
    h.clock.advance(5_000);
    await h.core.tick();
    expect(h.chat.cards).toHaveLength(cards);
  });

  it("doesn't route a drill to anyone else", async () => {
    const sent = await h.core.sendDrill("neha", "new_destination");
    expect(sent.ok).toBe(true);
    h.core.people.store.setAway("neha", h.clock.nowMs() + 60 * MINUTE, null);
    h.clock.advance(5_000);
    await h.core.tick();
    expect(h.chat.cards.map((card) => card.roomId)).toEqual(["dm-neha"]);
  });
});
