/**
 * Fifth review, of Switch room roles and the record of refusals. Every `it` named with an F number states the secure
 * behaviour and failed on the code it was found in, one F number per finding, ranked by how bad the outcome is, and all are
 * fixed since. A "control" passed then too, and shows the scene is set up properly, so a failure is the finding and not a
 * broken scene. A "guard" is what a fix must not give away, and also holds on the old code. `it.fails` marks a limit that's
 * left, and says where docs/threat-model.md says what it costs.
 *
 * The real stream dispatcher (packages/switch-agent/src/agent.ts `enqueue`) logs a handler's error and moves on to the next
 * frame, so `arrives` does the same here: a message that throws is simply a message core never took in, though Switch has
 * delivered it to the agent all the same.
 */
import { readFileSync } from "node:fs";
import type { Action, ApprovalOutcomeEvent, RoomAliases, RoomRoles } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSwitchNotice } from "../src/router/switch-notices.js";
import type { OpenedCard } from "./fakes.js";
import { actionId, chatMessage, gateRefund, hookShell, makeHarness, MINUTE, NOW, PARTICIPANTS, POLICY_PATH, REFUND_SC4, WORLD, type Harness } from "./harness.js";

let h: Harness;

/** Shaped as the real port's answers are: `Object.fromEntries`, so they have Object's prototype. */
const rosterFrom = (entries: [string, string[]][]): RoomRoles => Object.fromEntries(entries);
const noAliases = async (): Promise<RoomAliases> => Object.fromEntries([]);

/** A team as it really runs: the port answers all three questions, and the agent is in no room Clearance can't see. */
function asDeployed(roster: (roomId: string) => RoomRoles): void {
  h.chat.roomRoles = async (roomId) => roster(roomId);
  h.chat.roomAliases = noAliases;
  h.chat.unseenRoomCount = async () => 0;
}

/** templates/acme-mini.template.yaml, with coder holding `merges` and refunds-agent holding `refunds`. */
const AS_TEMPLATED = (roomId: string): RoomRoles =>
  roomId === "#eng" ? rosterFrom([["merges", ["coder"]], ["ops", []]]) : roomId === "#support" ? rosterFrom([["refunds", ["refunds-agent"]], ["customer-email", ["support-agent"]]]) : rosterFrom([]);

beforeEach(() => {
  h = makeHarness();
  h.lookup.world = structuredClone(WORLD);
  asDeployed(AS_TEMPLATED);
});
afterEach(() => {
  h.core.close();
});

/** What the stream does with a frame: a handler that throws is logged and the next frame goes on. */
const arrives = async (sender: string, body: string, roomId: string, senderName?: string): Promise<void> => {
  // What Switch's stream says: a message that mentions Clearance first is addressed to Clearance.
  await h.core.onMessage(chatMessage(sender, body, { roomId, threadId: undefined, addressed: /^\s*@clearance\b/i.test(body), ...(senderName ? { senderName } : {}) })).catch(() => undefined);
};
const refundsAgent = (body: string, roomId = "#eng") => arrives(PARTICIPANTS.refundsAgent, body, roomId, "refunds-agent");
const supportAgent = (body: string, roomId = "#support") => arrives(PARTICIPANTS.supportAgent, body, roomId, "support-agent");
const requestersOf = (agent: string) => h.core.people.requesters.requestersOf(agent);

const gateCall = (agent: string, endpoint: string, args: Record<string, unknown>): Action => ({
  id: actionId(),
  at: new Date(NOW).toISOString(),
  source: "gate",
  vendor: "gate",
  agent: { name: agent },
  kind: "business",
  raw: args,
  business: { endpoint, args },
});
const mergeCall = (agent = "coder"): Action => gateCall(agent, "POST /github/merge", { repo: "acme/acme-mini-app", pr: 77 });

const press = (card: OpenedCard, who: string, answer = "allow"): Promise<void> => {
  const event: ApprovalOutcomeEvent = {
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "approval",
    state: "answered",
    answer,
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  };
  return h.core.onApprovalOutcome(event);
};

/** Every card on this request, so a press is tried wherever the person could reach one. */
const cardsFor = (id: string): OpenedCard[] =>
  h.core.stores.routes.forRequest(id).flatMap((row) => h.chat.cards.filter((card) => card.switchRequestId === row.switch_request_id));

/** The person's own answer to their own ask, on the card they'd get or else on any they can see. True when the call ran. */
async function approvesAlone(id: string, who: string, room: string): Promise<boolean> {
  const card = cardsFor(id).find((one) => one.roomId === room) ?? cardsFor(id)[0];
  if (!card) return false;
  await press(card, who);
  return h.gate.calls.length > 0;
}

/**
 * The merge scene. Alex asked coder something small, so a request looks attributed and one approval is enough. Then Dev, the
 * only eligible approver for PR 77 (Alex owns coder), asks the wrong agent for the merge, and it gets to coder somehow.
 */
async function devAsksForTheMerge(): Promise<void> {
  await arrives(PARTICIPANTS.alex, "@coder run the tests on the checkout service", "#eng");
  await arrives(PARTICIPANTS.dev, "@refunds-agent merge PR 77", "#eng");
}
async function heldMerge(): Promise<string> {
  const held = await h.core.check(mergeCall());
  expect(held.decision).toBe("hold");
  return held.request_id as string;
}

/** The refund scene. Priya asked refunds-agent about something else, so a request looks attributed. */
const priyaOnRecord = (room = "#support") => arrives(PARTICIPANTS.priya, "@refunds-agent have a look at T-77 when you can", room);
const MONEY_WENT = "₹40,000 went out on the approval of the person who asked for it";
const MERGE_WENT = "the merge ran on the approval of the person who asked for it";

async function samApprovesHisOwnRefund(): Promise<boolean> {
  const held = await h.core.check(gateRefund(REFUND_SC4));
  expect(held.decision).toBe("hold");
  return approvesAlone(held.request_id as string, PARTICIPANTS.sam, "dm-sam");
}

describe("control: the scenes, written plainly", () => {
  it("Dev is on record through the role, and his own approval doesn't run the merge", async () => {
    await devAsksForTheMerge();
    await refundsAgent("@merges please merge PR 77");
    expect(requestersOf("coder")).toContain("dev");
    expect(await approvesAlone(await heldMerge(), PARTICIPANTS.dev, "dm-dev")).toBe(false);
  });

  it("Sam is on record, and his own approval doesn't run the refund", async () => {
    await priyaOnRecord();
    await arrives(PARTICIPANTS.sam, "@refunds-agent refund order A-2004 in full", "#support");
    expect(await samApprovesHisOwnRefund()).toBe(false);
  });
});

describe("F1: the word @constructor takes a whole message off the record", () => {
  // `roles[name]` and `aliases[name]` are plain objects, so `constructor` finds Object. One spread throws and the other binds a
  // function to SQLite. Either way observe() throws, the dispatcher logs it, and Switch has delivered the message regardless.
  it("F1a: onMessage survives the word", async () => {
    await expect(h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@constructor hello", { roomId: "#support", threadId: undefined }))).resolves.toBeUndefined();
  });

  it("F1b: a person's ask with the word in it stays on record, wherever the word is", async () => {
    await arrives(PARTICIPANTS.sam, "@refunds-agent refund order A-2004 in full @constructor", "#support");
    await arrives(PARTICIPANTS.neha, "@constructor @refunds-agent refund order A-2004 in full", "#support");
    expect(requestersOf("refunds-agent")).toEqual(expect.arrayContaining(["sam", "neha"]));
  });

  it("F1c: wherever the word is, also when Switch answers about roles and not aliases", async () => {
    h.chat.roomAliases = () => Promise.reject(new Error("switch unreachable"));
    await arrives(PARTICIPANTS.sam, "@refunds-agent refund order A-2004 in full @constructor", "#support");
    expect(requestersOf("refunds-agent")).toContain("sam");
  });

  it("F1d: Sam can't approve the refund he asked for by adding the word", async () => {
    await priyaOnRecord();
    await arrives(PARTICIPANTS.sam, "@constructor @refunds-agent refund order A-2004 in full", "#support");
    expect(await samApprovesHisOwnRefund(), MONEY_WENT).toBe(false);
  });

  it("F1e: an agent can't lose who asked by adding the word to its hand-off", async () => {
    await devAsksForTheMerge();
    await refundsAgent("@constructor @merges please merge PR 77");
    expect(requestersOf("coder")).toContain("dev");
  });

  describe("the class of it: a lookup keyed by something typed", () => {
    const WORDS = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__", "__defineGetter__"];

    it("F1f: none of Object's members is anyone in a message", async () => {
      for (const word of WORDS) {
        await expect(h.core.onMessage(chatMessage(PARTICIPANTS.sam, `@${word} @refunds-agent hello`, { roomId: "#support", threadId: undefined })), word).resolves.toBeUndefined();
        await expect(h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, `see@${word} hello`, { roomId: "#support", threadId: undefined, senderName: "refunds-agent" })), word).resolves.toBeUndefined();
      }
    });

    it("F1g: nor a wrapper or a git subcommand on a shell line", async () => {
      const decide = (line: string) => h.core.simulate(hookShell(line, { agent: { name: "coder", cwd: "/home/x/.switch/agents/m/coder" } }));
      for (const word of WORDS) {
        for (const line of [`${word} -x rm -rf /`, `${word} --version`, `git ${word} -x`, `sudo ${word} -x`]) {
          await expect(decide(line), line).resolves.toHaveProperty("decision");
        }
      }
    });

    it("F1h: nor an agent, a service or an author on the team file", async () => {
      const { directory } = h.core.people;
      for (const word of WORDS) {
        expect(directory.resolveAgent(undefined, word), word).toBeNull();
        expect(directory.agentVendor(word), word).toBeNull();
        expect(directory.agentOwners(word), word).toEqual([]);
        expect(directory.resolveAuthor(word), word).toEqual([]);
      }
      await arrives(PARTICIPANTS.priya, "@ops-agent deploy it", "#eng");
      const held = await h.core.check(gateCall("ops-agent", "POST /acme/deploys", { service: "constructor", env: "prod", version: "v1" }));
      const text = cardsFor(held.request_id as string).map((card) => `${card.detail ?? ""} ${card.questions.map((one) => one.prompt).join(" ")}`).join(" ");
      expect(text, "a function on a card").not.toMatch(/native code|function Object/);
    });
  });

  describe("core not taking in a message", () => {
    const breakObserve = () => {
      h.core.people.requesters.observe = () => {
        throw new Error("something unforeseen");
      };
    };

    it("F1i: if reading it throws, holds take two people, as they do when messages are lost", async () => {
      await priyaOnRecord();
      const observe = h.core.people.requesters.observe.bind(h.core.people.requesters);
      breakObserve();
      await expect(h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@refunds-agent refund order A-2004 in full", { roomId: "#support", threadId: undefined }))).resolves.toBeUndefined();
      h.core.people.requesters.observe = observe;
      const held = await h.core.check(gateRefund(REFUND_SC4));
      const request = h.core.stores.requests.require(held.request_id as string);
      expect(request.flags.map((flag) => flag.code)).toContain("messages_lost");
      expect(request.quorumRequired).toBe(2);
      expect(await approvesAlone(request.id, PARTICIPANTS.sam, "dm-sam"), MONEY_WENT).toBe(false);
    });

    it("F1j: nothing runs alone after it, either", async () => {
      h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", NOW);
      await priyaOnRecord();
      breakObserve();
      await arrives(PARTICIPANTS.sam, "@refunds-agent refund a little", "#support");
      const small = { order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "meera.k@oksbi" };
      expect((await h.core.check(gateRefund(small))).decision).toBe("hold");
    });

    it("F1k: the same for a message that can't even be parsed", async () => {
      await priyaOnRecord();
      await h.core.onMessage({ sender: "no body" } as never);
      const held = await h.core.check(gateRefund(REFUND_SC4));
      expect(h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.code)).toContain("messages_lost");
    });

    it("control: a command in that message is still answered", async () => {
      await priyaOnRecord();
      const held = await h.core.check(gateRefund(REFUND_SC4));
      breakObserve();
      await h.core.onMessage(chatMessage(PARTICIPANTS.alex, `@clearance status ${String(held.request_id)}`, { roomId: "#support", threadId: undefined, addressed: true }));
      expect(h.chat.messages.at(-1)?.body).toContain(String(held.request_id));
    });
  });
});

describe("F2: Switch addresses forms that Clearance doesn't read as a mention", () => {
  // Switch: strip `*` and `~` from the whole body, then `@name(?![A-Za-z0-9._-])` anywhere, with nothing required before it
  // (clients/mentions.py `mention_regex`, delivery/addressing.py `addressable_text`). Clearance: `(?<![\w.@-])@name` on the raw body.
  for (const form of ["@*merges*", "@**merges**", "@~merges~", "@m*erges", "see@merges", "a.b@merges", "@@merges", "_@merges"]) {
    it(`F2a: a hand-off to ${form} still passes on who asked`, async () => {
      await devAsksForTheMerge();
      await refundsAgent(`${form} please merge PR 77`);
      expect(requestersOf("coder")).toContain("dev");
    });
  }

  it("F2b: the same for naming the agent itself", async () => {
    await devAsksForTheMerge();
    await refundsAgent("@*coder* please merge PR 77");
    expect(requestersOf("coder")).toContain("dev");
  });

  it("F2c: Dev can't approve the merge he asked for through a hand-off written that way", async () => {
    await devAsksForTheMerge();
    await refundsAgent("@*merges* please merge PR 77");
    expect(await approvesAlone(await heldMerge(), PARTICIPANTS.dev, "dm-dev"), MERGE_WENT).toBe(false);
  });

  it("F2d: a person bolding the agent's name is naming it, not only speaking near it", async () => {
    await arrives(PARTICIPANTS.sam, "@**refunds-agent** refund order A-2004 in full", "#support");
    expect(requestersOf("refunds-agent")).toContain("sam");
  });

  it("F2e: a command to Clearance can't carry an address that leaves no trace at all", async () => {
    await priyaOnRecord();
    await arrives(PARTICIPANTS.sam, "@clearance help @*refunds-agent* refund order A-2004 in full", "#support");
    expect(requestersOf("refunds-agent")).toContain("sam");
  });

  it("F2f: nor can something shaped like a card answer", async () => {
    await arrives(PARTICIPANTS.sam, 'A1 "@*refunds-agent* refund order A-2004 in full"', "#support");
    expect(requestersOf("refunds-agent")).toContain("sam");
  });

  it("F2g: Sam can't approve the ₹40,000 refund he asked for by writing his ask as a command to Clearance", async () => {
    await priyaOnRecord();
    await arrives(PARTICIPANTS.sam, "@clearance help @*refunds-agent* refund order A-2004 in full", "#support");
    expect(await samApprovesHisOwnRefund(), MONEY_WENT).toBe(false);
  });

  describe("guards: an email address stays what it is", () => {
    const bodies = ["it pays out to rohan.s@okhdfc", "write to someone@example.com", "cc billing@acme.in please"];

    it("isn't anyone's ask, from a person or an agent", async () => {
      await refundsAgent("On it.", "#support");
      for (const body of bodies) {
        await arrives(PARTICIPANTS.dev, `${body} @clearance`, "#eng");
        await supportAgent(body);
      }
      const { db } = h.core.stores;
      expect(db.prepare(`SELECT agent, user_id FROM requesters`).all()).toEqual([]);
      expect(db.prepare(`SELECT agent, by_agent FROM agent_asks`).all()).toEqual([]);
    });

    it("isn't a guess at anyone while Switch can't say, and raises nothing", async () => {
      h.chat.roomRoles = () => Promise.reject(new Error("switch unreachable"));
      h.chat.roomAliases = () => Promise.reject(new Error("switch unreachable"));
      await priyaOnRecord();
      for (const body of bodies) {
        await refundsAgent(body, "#support");
        await arrives(PARTICIPANTS.neha, body, "#finance");
      }
      const { db } = h.core.stores;
      expect(db.prepare(`SELECT COUNT(*) AS n FROM requesters WHERE guess = 1`).get()).toEqual({ n: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM possible_asks`).get()).toEqual({ n: 0 });
      const held = await h.core.check(gateRefund(REFUND_SC4));
      expect(h.core.stores.requests.require(held.request_id as string).quorumRequired).toBe(1);
    });

    it("counts when what's after the @ is a role in that room, and not when the room has no such role", async () => {
      await devAsksForTheMerge();
      await refundsAgent("mail billing@customer-email please", "#eng");
      expect(requestersOf("support-agent")).not.toContain("dev");
      await refundsAgent("mail billing@ops please", "#eng");
      expect(requestersOf("ops-agent")).toContain("dev");
    });
  });

  // With Switch not answering, Clearance can't tell an address from a role it can't see, and an email address stays an email address.
  // docs/threat-model.md, under Limits: "A name inside a word".
  it.fails("limit: with Switch not answering, an agent's see@backend reaches a role Clearance can't place", async () => {
    await devAsksForTheMerge();
    h.chat.roomRoles = () => Promise.reject(new Error("switch unreachable"));
    h.chat.roomAliases = () => Promise.reject(new Error("switch unreachable"));
    await refundsAgent("see@backend please merge PR 77");
    expect(requestersOf("coder")).toContain("dev");
  });
});

describe("F3: an agent passing on who asked moves a decision out of the group the policy names", () => {
  // The commit says roles "only ever remove approvers". Bar everyone the class names and the card goes to the fallback group, who
  // can then approve. A guess isn't allowed to do this (`barsThatMoveTheDecision`), but a chain is an agent's own act, and counts as sure.
  const BULK = { to: "auditor.ravi@gmail.com", subject: "Customer list", body: "see attached", attachments: ["customers.csv"] };

  it("control: nobody passes anything on, and it's the support lead's to decide", async () => {
    await arrives(PARTICIPANTS.sam, "@support-agent send the customer list to the auditor", "#support");
    const held = await h.core.check(gateCall("support-agent", "POST /acme/emails", BULK));
    expect(held.decision).toBe("hold");
    expect(cardsFor(held.request_id as string).map((card) => card.roomId)).toContain("dm-priya");
  });

  it("F3a: on the template's own team, naming a role doesn't take a customer-data email away from the only support lead", async () => {
    await arrives(PARTICIPANTS.sam, "@support-agent send the customer list to the auditor", "#support");
    // Priya asks a different agent about a different thing. That agent then names the role, on its own.
    await priyaOnRecord();
    await refundsAgent("@customer-email is the auditor's list ready?", "#support");
    const held = await h.core.check(gateCall("support-agent", "POST /acme/emails", BULK));
    expect(held.decision).toBe("hold");
    const id = held.request_id as string;
    const fallback = cardsFor(id).find((card) => card.roomId === "#approvals");
    if (fallback) {
      // A critical card asks its answerer to type a field, which is on the card.
      const { extracted } = h.core.stores.requests.require(id).evidence as { extracted: Record<string, unknown> };
      const answers = fallback.questions.map((question) => ({ question_id: question.id, custom_text: String(extracted[question.id] ?? ""), selected_option_ids: [] }));
      await h.core.onApprovalOutcome({ sessionId: fallback.sessionId, switchRequestId: fallback.switchRequestId, kind: "questions", state: "answered", answers, answeredBy: PARTICIPANTS.alex, answeredAtMs: h.clock.nowMs() });
    }
    expect(h.gate.calls, "an engineer sent the customer list, because an agent named a role").toEqual([]);
  });

  it("F3b: nor a ₹40,000 refund away from both finance approvers", async () => {
    await arrives(PARTICIPANTS.sam, "@support-agent which order was that?", "#support");
    await arrives(PARTICIPANTS.neha, "@support-agent and the customer's name?", "#support");
    await supportAgent("@refunds please look at order A-2004");
    const held = await h.core.check(gateRefund(REFUND_SC4));
    expect(held.decision).toBe("hold");
    const fallback = cardsFor(held.request_id as string).find((card) => card.roomId === "#approvals");
    if (fallback) await press(fallback, PARTICIPANTS.alex);
    expect(h.gate.calls, "an engineer approved ₹40,000, because an agent named a role").toEqual([]);
  });

  describe("guards: what standing aside mustn't give away", () => {
    const flags = (id: string) => h.core.stores.requests.require(id).flags.map((flag) => flag.code);
    /** Priya only reached support-agent through refunds-agent, and she's the only support lead. */
    async function passedOnEmail(): Promise<string> {
      await priyaOnRecord();
      await refundsAgent("@customer-email is the auditor's list ready?", "#support");
      const held = await h.core.check(gateCall("support-agent", "POST /acme/emails", { to: "auditor.ravi@gmail.com", subject: "Hello", body: "Hello", attachments: [] }));
      expect(held.decision).toBe("hold");
      return held.request_id as string;
    }

    it("someone passed on can't approve alone: it takes two, and she and the fallback together can", async () => {
      const id = await passedOnEmail();
      const request = h.core.stores.requests.require(id);
      expect(request.quorumRequired).toBe(2);
      expect(flags(id)).toContain("may_have_asked");
      await press(cardsFor(id).find((card) => card.roomId === "dm-priya") as OpenedCard, PARTICIPANTS.priya);
      expect(h.gate.calls, "the person who may have asked decided it alone").toEqual([]);
      await press(cardsFor(id).find((card) => card.roomId === "#approvals") as OpenedCard, PARTICIPANTS.alex);
      expect(h.gate.calls.map((call) => call.requestId)).toEqual([id]);
    });

    it("someone who named the agent herself stays barred, however many agents pass her on too", async () => {
      await arrives(PARTICIPANTS.priya, "@support-agent send the list to the auditor", "#support");
      const id = await passedOnEmail();
      const request = h.core.stores.requests.require(id);
      expect(request.requesterIds).toContain("priya");
      expect(flags(id)).not.toContain("may_have_asked");
      expect(request.quorumRequired, "she really asked, so the fallback decides, as it always has").toBe(1);
      await press(cardsFor(id).find((card) => card.roomId === "#support") as OpenedCard, PARTICIPANTS.priya);
      expect(h.gate.calls).toEqual([]);
      expect(h.core.stores.ledger.list({ requestId: id }).at(-1)?.payload).toMatchObject({ reasons: expect.arrayContaining(["requester"]) });
    });

    it("with anyone else the policy names still free, nobody stands aside: they decide", async () => {
      await arrives(PARTICIPANTS.sam, "@support-agent which order was that?", "#support");
      await supportAgent("@refunds please look at order A-2004");
      const held = await h.core.check(gateRefund(REFUND_SC4));
      const request = h.core.stores.requests.require(held.request_id as string);
      expect(request.requesterIds).toContain("sam");
      expect(flags(request.id)).not.toContain("may_have_asked");
      expect(request.quorumRequired).toBe(1);
      expect(cardsFor(request.id).map((card) => card.roomId)).toContain("dm-neha");
    });

    it("someone on a card for this reason can't break glass on it", async () => {
      await arrives(PARTICIPANTS.alex, "@refunds-agent get checkout out to prod", "#eng");
      await refundsAgent("@ops please deploy checkout to prod");
      const held = await h.core.check(gateCall("ops-agent", "POST /acme/deploys", { service: "checkout", env: "prod", version: "v2.13.2" }));
      const id = held.request_id as string;
      expect(flags(id)).toContain("may_have_asked");
      await arrives(PARTICIPANTS.alex, `@clearance breakglass ${id} prod is down`, "#eng");
      expect(h.gate.calls, "the person who may have asked broke glass on it").toEqual([]);
      expect(h.core.stores.requests.require(id).state).toBe("ROUTED");
      expect(h.chat.messages.at(-1)?.body).toMatch(/may have asked/);
    });

    it("with nobody else to make up the numbers, the card says it can't complete, and it expires with nothing run", async () => {
      await arrives(PARTICIPANTS.alex, "@refunds-agent get checkout out to prod", "#eng");
      await refundsAgent("@ops please deploy checkout to prod");
      const held = await h.core.check(gateCall("ops-agent", "POST /acme/deploys", { service: "checkout", env: "prod", version: "v2.13.2" }));
      const id = held.request_id as string;
      expect(h.chat.messages.map((message) => message.body).join(" ") + cardsFor(id).map((card) => card.detail).join(" ")).toMatch(/can't complete/);
      await press(cardsFor(id).find((card) => card.roomId === "dm-alex") as OpenedCard, PARTICIPANTS.alex);
      expect(h.gate.calls).toEqual([]);
      h.clock.advance(26 * MINUTE);
      await h.core.tick();
      expect(h.core.stores.requests.require(id).state).toBe("EXPIRED");
      expect(h.gate.calls).toEqual([]);
    });

    it("a tier that takes two takes three: a chain doesn't buy one of the policy's two", async () => {
      await arrives(PARTICIPANTS.sam, "@support-agent which order was that?", "#support");
      await arrives(PARTICIPANTS.neha, "@support-agent and the customer's name?", "#support");
      await supportAgent("@refunds please look at order A-2004");
      const held = await h.core.check(gateRefund({ ...REFUND_SC4, amount: 150000 }));
      const id = held.request_id as string;
      expect(h.core.stores.requests.require(id).tier).toBe("critical");
      expect(h.core.stores.requests.require(id).quorumRequired).toBe(3);
    });

    it("an edit keeps it: lowering the amount doesn't take the second person away", async () => {
      await arrives(PARTICIPANTS.sam, "@support-agent which order was that?", "#support");
      await arrives(PARTICIPANTS.neha, "@support-agent and the customer's name?", "#support");
      await supportAgent("@refunds please look at order A-2004");
      const held = await h.core.check(gateRefund(REFUND_SC4));
      const id = held.request_id as string;
      expect(h.core.stores.requests.require(id).quorumRequired).toBe(2);
      await h.core.onMessage(chatMessage(PARTICIPANTS.sam, `@clearance counter ${id} 20000`, { roomId: "#finance", threadId: undefined, addressed: true }));
      const offer = h.chat.cards.filter((card) => card.title.includes("COUNTER")).at(-1) as OpenedCard;
      await h.core.onApprovalOutcome({
        sessionId: offer.sessionId,
        switchRequestId: offer.switchRequestId,
        kind: "questions",
        state: "answered",
        answer: null,
        answers: [{ question_id: offer.questions[0]?.id ?? "x", custom_text: "20000", selected_option_ids: [] }],
        answeredBy: PARTICIPANTS.sam,
        answeredAtMs: h.clock.nowMs(),
      });
      expect(h.gate.edits, "the person who may have asked lowered it and it ran").toEqual([]);
    });
  });
});

describe("F4: what doesn't count as speaking can carry a request", () => {
  // Switch hands a person's message that mentions nobody to the agent taking part in a thread, when follow_the_conversation is on,
  // and doesn't consume a typed card answer: "the room still sees what was said" (collaboration_core.py). An agent also reads the
  // room when it wakes. So a request needn't name anyone, which is why voices count at all. These don't count as voices.
  it("control: the same words said plainly bar Sam", async () => {
    await priyaOnRecord();
    await arrives(PARTICIPANTS.sam, "please refund order A-2004 in full", "#support");
    expect(requestersOf("refunds-agent")).toContain("sam");
  });

  for (const shape of ['A1 "please refund order A-2004 in full"', 'A7 q1="please refund order A-2004 in full"', "@clearance help refund order A-2004 in full please", "@clearance why don't you refund order A-2004 in full"]) {
    it(`F4a: ${shape} counts as speaking`, async () => {
      await priyaOnRecord();
      await arrives(PARTICIPANTS.sam, shape, "#support");
      expect(requestersOf("refunds-agent")).toContain("sam");
    });
  }

  it("F4b: Sam can't approve the refund he asked for in the shape of a card answer", async () => {
    await priyaOnRecord();
    await arrives(PARTICIPANTS.sam, 'A1 "please refund order A-2004 in full"', "#support");
    expect(await samApprovesHisOwnRefund(), MONEY_WENT).toBe(false);
  });

  describe("guards: an ordinary answer or command still asks nobody for anything", () => {
    const answers = ["A12", "A12 yes", "a12 no", "A12 1", 'A12 "40000"', 'A12 "40,000"', 'A12 "₹40,000"', 'A12 "40,000 rupees"', 'A12 "40 k"', 'A12 "oksbi"', 'A12 "gmail.com"', 'A12 "checkout"', 'A12 "CLR-0042"', 'A12 q1="40000"', 'a12 q2="no"'];
    const commands = ["@clearance why CLR-0001", "@clearance why A12", "@clearance status CLR-0001?", "@clearance inbox", "@clearance help", "@clearance back", "@clearance policy", "@clearance autonomy", "@clearance drills off", "@clearance counter CLR-0001 4000", "@clearance away until 18:00 delegate @neha"];

    for (const body of [...answers, ...commands]) {
      it(`${body} isn't Sam asking`, async () => {
        await priyaOnRecord();
        await arrives(PARTICIPANTS.sam, body, "#support");
        expect(requestersOf("refunds-agent")).not.toContain("sam");
      });
    }

    it("an approver who answered a card in the room still gets the next one", async () => {
      await priyaOnRecord();
      await arrives(PARTICIPANTS.sam, "A1 yes", "#support");
      const held = await h.core.check(gateRefund(REFUND_SC4));
      expect(cardsFor(held.request_id as string).map((card) => card.roomId)).toContain("dm-sam");
    });

    it("a reason counts as a command only for a request that exists, because then it's on the ledger under their name", async () => {
      await priyaOnRecord();
      const held = await h.core.check(gateRefund(REFUND_SC4));
      await arrives(PARTICIPANTS.sam, `@clearance incident ${String(held.request_id)} this one looks wrong`, "#support");
      expect(requestersOf("refunds-agent")).not.toContain("sam");
      await arrives(PARTICIPANTS.neha, "@clearance incident CLR-9999 refund order A-2004 in full", "#support");
      expect(requestersOf("refunds-agent")).toContain("neha");
    });
  });
});

describe("F5: Clearance wakes an agent for a message that doesn't count as asking it", () => {
  // wakeForRole only asks that the room declares a role of that name. behindRole only counts the grant's holders in the job's own
  // room. So in any other room that declares `merges` with nobody holding it, Clearance itself gets coder to pick the work up.
  const roomDeclaring = (room: string) => (roomId: string): RoomRoles => (roomId === room ? rosterFrom([["merges", []]]) : AS_TEMPLATED(roomId));
  const woken = (agent: string) => h.chat.targeted.some((one) => one.targets.includes(agent));

  it("control: in the job's own room, waking and counting go together", async () => {
    asDeployed(roomDeclaring("#eng"));
    await devAsksForTheMerge();
    await refundsAgent("@merges please merge PR 77");
    expect(woken("coder")).toBe(true);
    expect(requestersOf("coder")).toContain("dev");
  });

  it("F5a: whoever Clearance wakes for a message counts that message's people as having asked it", async () => {
    asDeployed(roomDeclaring("#war-room"));
    await devAsksForTheMerge();
    await refundsAgent("@merges please merge PR 77", "#war-room");
    expect({ woken: woken("coder"), recorded: requestersOf("coder").includes("dev") }).not.toEqual({ woken: true, recorded: false });
  });

  it("F5b: Dev can't approve the merge Clearance itself sent coder to do", async () => {
    asDeployed(roomDeclaring("#war-room"));
    await devAsksForTheMerge();
    await refundsAgent("@merges please merge PR 77", "#war-room");
    const ran = await approvesAlone(await heldMerge(), PARTICIPANTS.dev, "dm-dev");
    expect({ woken: woken("coder"), ran }).not.toEqual({ woken: true, ran: true });
  });

  it("F5c: the same when rooms were recreated and Clearance has no name for the job's room", async () => {
    asDeployed(roomDeclaring("room-eng-new"));
    await devAsksForTheMerge();
    await refundsAgent("@merges please merge PR 77", "room-eng-new");
    expect({ woken: woken("coder"), recorded: requestersOf("coder").includes("dev") }).not.toEqual({ woken: true, recorded: false });
  });

  it("F5d: Clearance's word only sends an agent to the job's own room, and naming the role anywhere that declares it still counts", async () => {
    asDeployed(roomDeclaring("#war-room"));
    await devAsksForTheMerge();
    await refundsAgent("@merges please merge PR 77", "#war-room");
    expect(woken("coder")).toBe(false);
    expect(requestersOf("coder")).toContain("dev");
  });
});

describe("F6: a role or alias with a name Clearance already knows isn't looked up", () => {
  // rolesIn and aliasesIn skip Switch when every mention is known, and knowsMention covers people, groups and policy roles. Switch
  // knows nothing of those: `@eng` reaches whoever holds a role called `eng`.
  const roleCalled = (name: string) => (roomId: string): RoomRoles => (roomId === "#eng" ? rosterFrom([[name, ["coder"]], ["merges", []]]) : AS_TEMPLATED(roomId));

  it("control: a role with a name nobody uses is looked up", async () => {
    asDeployed(roleCalled("backend"));
    await devAsksForTheMerge();
    await refundsAgent("@backend please merge PR 77");
    expect(requestersOf("coder")).toContain("dev");
  });

  for (const name of ["eng", "eng-leads", "dev", "alex"]) {
    it(`F6a: a role called ${name} still passes on who asked`, async () => {
      asDeployed(roleCalled(name));
      await devAsksForTheMerge();
      await refundsAgent(`@${name} please merge PR 77`);
      expect(requestersOf("coder")).toContain("dev");
    });
  }

  it("F6b: and an alias called eng", async () => {
    h.chat.roomAliases = async () => Object.fromEntries([["eng", "coder"]]);
    await devAsksForTheMerge();
    await refundsAgent("@eng please merge PR 77");
    expect(requestersOf("coder")).toContain("dev");
  });

  it("F6c: Dev can't approve the merge he asked for through a role called eng", async () => {
    asDeployed(roleCalled("eng"));
    await devAsksForTheMerge();
    await refundsAgent("@eng please merge PR 77");
    expect(await approvesAlone(await heldMerge(), PARTICIPANTS.dev, "dm-dev"), MERGE_WENT).toBe(false);
  });

  it("F6d: a role with an agent's own name reaches both, and counts for both", async () => {
    asDeployed((roomId) => (roomId === "#eng" ? rosterFrom([["reviewer", ["coder"]]]) : AS_TEMPLATED(roomId)));
    await devAsksForTheMerge();
    await refundsAgent("@reviewer please merge PR 77");
    expect(requestersOf("reviewer")).toContain("dev");
    expect(requestersOf("coder")).toContain("dev");
  });

  it("F6e: an agent writing a person's name is looked up, for an alias as for a role", async () => {
    h.chat.roomAliases = async () => Object.fromEntries([["dev", "coder"]]);
    await arrives(PARTICIPANTS.priya, "@refunds-agent merge PR 77", "#eng");
    await refundsAgent("@dev please merge PR 77");
    expect(requestersOf("coder")).toContain("priya");
  });

  // Reading aliases for every person's name would ask Switch on every `hello @neha`. A role of that name is still read. A person writing
  // it counts as a voice in the room, so this only matters where the agent hasn't been seen. docs/threat-model.md, under Limits: "An alias
  // called what a person is called".
  it.fails("limit: a person writing a person's name that's also an alias isn't read as naming the agent", async () => {
    h.chat.roomAliases = async () => Object.fromEntries([["dev", "coder"]]);
    await arrives(PARTICIPANTS.priya, "@dev please merge PR 77", "#eng");
    expect(requestersOf("coder")).toContain("priya");
  });
});

describe("F7: work handed over by an agent with nobody behind it", () => {
  /** Small, hers, from a destination on file, so it runs alone at L3. */
  const SMALL = { order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "meera.k@oksbi" };

  beforeEach(async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", NOW);
    await priyaOnRecord();
  });

  it("control: with Priya on record, a small refund runs alone at L3", async () => {
    expect((await h.core.check(gateRefund(SMALL))).decision).toBe("allow");
  });

  it("F7: an agent asking for it, with no person behind it, isn't a person having asked", async () => {
    // Nobody ever asked support-agent anything: a ticket's text told it to. It hands the job to the role, as rule 5 says to.
    await supportAgent("@refunds refund order A-1931, ₹2,000, please");
    expect((await h.core.check(gateRefund(SMALL))).decision, "it ran alone on another agent's word, on the strength of Priya asking about something else").toBe("hold");
  });

  it("guard: a person asking the agent directly, after the window has passed, runs alone again", async () => {
    await supportAgent("@refunds refund order A-1931, ₹2,000, please");
    h.clock.advance(11 * MINUTE);
    await priyaOnRecord();
    expect((await h.core.check(gateRefund(SMALL))).decision).toBe("allow");
  });

  it("guard: it only stops running alone. A hold it's on still takes who the policy says", async () => {
    await supportAgent("@refunds refund order A-2004 in full, please");
    const held = await h.core.check(gateRefund(REFUND_SC4));
    const request = h.core.stores.requests.require(held.request_id as string);
    expect(request.flags.map((flag) => flag.code)).toContain("handed_over_by_agent");
    expect(request.quorumRequired).toBe(1);
  });
});

/** A call the gate turned down for being outside the agent's role, as `POST /v1/refused` passes it on. */
const refused = (index: number, cls = "deploy", endpoint = "POST /acme/deploys"): void =>
  h.core.recordRefusal(
    {
      id: `refused-${index}`,
      at: new Date(h.clock.nowMs()).toISOString(),
      source: "gate",
      vendor: "gate",
      agent: { name: "refunds-agent" },
      kind: "business",
      raw: {},
      business: { endpoint, args: {} },
    },
    cls,
    `refunds-agent is not allowed to call ${cls} actions.`,
  );

describe("F8: any agent chooses what a policy change's card says it would do", () => {
  /** A change that lets every refund through. Its card has to say so, however busy agents have kept themselves since. */
  async function everyRefundIsSafeNow(flood: () => Promise<void>): Promise<void> {
    await priyaOnRecord();
    for (let index = 0; index < 20; index += 1) expect((await h.core.check(gateRefund(REFUND_SC4))).decision).toBe("hold");
    const text = readFileSync(POLICY_PATH, "utf8");
    const weakened = text.replace("- { gate: 'GET /acme/*' }", "- { gate: 'GET /acme/*' }\n  - { gate: 'POST /acme/refunds' }");
    expect(weakened).not.toBe(text);
    const honest = (await h.core.replayPolicy({ policy: weakened, last: 100 })).delta as { hold: number };
    expect(honest.hold, "control: nothing has pushed them out yet").toBeLessThan(0);
    await flood();
    const proposed = await h.core.proposePolicy({ policy: weakened });
    if (!proposed.ok) throw new Error(proposed.error);
    expect(String(proposed.proposal.payload.detail), "signers are told this changes nothing, about a change that lets every refund through").not.toContain("held 0, allowed 0");
  }

  it("F8a: an agent with no grants can't flush it out with 100 refused calls", async () => {
    await everyRefundIsSafeNow(async () => {
      for (let index = 0; index < 100; index += 1) refused(index);
    });
  });

  it("F8b: nor with 100 calls that never needed a person", async () => {
    await everyRefundIsSafeNow(async () => {
      for (let index = 0; index < 100; index += 1) await h.core.check(hookShell("ls", { agent: { name: "coder", cwd: "/home/x/.switch/agents/m/coder" } }));
    });
  });

  it("F8c: a call the gate refused isn't replayed as if it had reached the policy", async () => {
    for (let index = 0; index < 5; index += 1) refused(index);
    expect((await h.core.replayPolicy({ last: 100 })).replayed).toBe(0);
  });

  it("guard: a change to what's quiet still shows, because quiet calls are replayed as their own kind", async () => {
    for (let index = 0; index < 5; index += 1) await h.core.check(hookShell("ls", { agent: { name: "coder", cwd: "/home/x/.switch/agents/m/coder" } }));
    const text = readFileSync(POLICY_PATH, "utf8");
    const narrowed = text.replace("^(ls|cat|grep", "^(cat|grep").replace("protected:               # no class matched", "protected:\n  - { shell: '^ls' }\n                         # no class matched");
    expect(narrowed).not.toBe(text);
    const delta = (await h.core.replayPolicy({ policy: narrowed, last: 100, eachClass: true })).delta as { hold: number };
    expect(delta.hold).toBe(5);
  });

  // An agent's own class can still be crowded, by calls of that class the change doesn't touch. docs/threat-model.md, under Limits:
  // "A policy card's replay".
  it.fails("limit: an agent with the grant can crowd its own class out of the replay", async () => {
    await priyaOnRecord();
    const big = gateRefund(REFUND_SC4);
    expect((await h.core.check(big)).decision).toBe("hold");
    const weakened = readFileSync(POLICY_PATH, "utf8").replace("- { gate: 'GET /acme/*' }", "- { gate: 'GET /acme/*' }\n  - { gate: 'POST /acme/refunds' }");
    const replayed = async () => ((await h.core.replayPolicy({ policy: weakened, last: 100, eachClass: true })).changed as { action_id: string }[]).map((row) => row.action_id);
    expect(await replayed()).toContain(big.id);
    for (let index = 0; index < 100; index += 1) await h.core.check(gateRefund({ order_id: "A-1931", customer_id: "cus_8812", amount: 2000 + index, destination: "meera.k@oksbi" }));
    expect(await replayed(), "the held ₹40,000 has dropped out of what's replayed").toContain(big.id);
  });
});

describe("F9: asking twice makes a certain requester a maybe", () => {
  // newHold's onlyMaybe adds stillWaitingOn to voicesOf, and only voicesOf leaves out people with a sure ask in the window.
  it("control: asking once bars Dev outright, and nobody is lifted", async () => {
    await arrives(PARTICIPANTS.dev, "@coder merge PR 77", "#eng");
    const { requesterIds, flags } = h.core.stores.requests.require(await heldMerge());
    expect(requesterIds).toContain("dev");
    expect(flags.map((flag) => flag.code)).not.toContain("may_have_asked");
  });

  it("F9: someone who named the agent a minute ago stays barred, even if they also asked it eleven minutes ago", async () => {
    await arrives(PARTICIPANTS.dev, "@coder merge PR 77", "#eng");
    h.clock.advance(11 * MINUTE);
    await arrives(PARTICIPANTS.dev, "@coder any news on PR 77?", "#eng");
    const { requesterIds, flags } = h.core.stores.requests.require(await heldMerge());
    expect(flags.map((flag) => flag.code), "the card says he may have asked, and gives him a vote, when he certainly did").not.toContain("may_have_asked");
    expect(requesterIds).toContain("dev");
  });
});

describe("F10: three seconds of an old roster", () => {
  it("F10: a role taken just after someone read the roster still passes on who asked", async () => {
    const holders: Record<string, string[]> = { ops: [] };
    asDeployed((roomId) => (roomId === "#eng" ? rosterFrom(Object.entries(holders)) : AS_TEMPLATED(roomId)));
    await devAsksForTheMerge();
    await refundsAgent("@ops anyone about?");
    holders.ops = ["coder"];
    h.clock.advance(1_000);
    await refundsAgent("@ops please merge PR 77");
    expect(requestersOf("coder")).toContain("dev");
  });
});

describe("F11: the single queue that approvals share", () => {
  it("guard: a slow wake still gets there, after the stream has moved on", async () => {
    asDeployed((roomId) => (roomId === "#eng" ? rosterFrom([["merges", []]]) : AS_TEMPLATED(roomId)));
    const tried: string[][] = [];
    h.chat.sendTargeted = async (input) => {
      tried.push(input.targets);
      await new Promise((done) => setTimeout(done, 1_200));
      throw new Error("coder isn't in this room");
    };
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@merges anyone?", { roomId: "#eng", threadId: undefined }));
    expect(tried).toEqual([["coder"]]);
    await new Promise((done) => setTimeout(done, 400));
    expect(tried).toEqual([["coder"], ["reviewer"]]);
  }, 6_000);

  const within = (work: Promise<unknown>, ms: number) => Promise.race([work.then(() => "done"), new Promise((done) => setTimeout(() => done("still waiting"), ms))]);
  const message = (body: string) => h.core.onMessage(chatMessage(PARTICIPANTS.priya, body, { roomId: "#eng", threadId: undefined }));

  it("control: a roster that never answers holds a message up for about a second", async () => {
    h.chat.roomRoles = () => new Promise(() => undefined);
    expect(await within(message("@merges anyone?"), 3_000)).toBe("done");
  }, 6_000);

  it("F11a: a wake that never answers can't hold up the stream, or the approvals behind it in the queue", async () => {
    asDeployed((roomId) => (roomId === "#eng" ? rosterFrom([["merges", []]]) : AS_TEMPLATED(roomId)));
    h.chat.sendTargeted = () => new Promise(() => undefined);
    expect(await within(message("@merges anyone?"), 3_000)).toBe("done");
  }, 6_000);

  it("F11b: while Switch is slow, each message with an unknown name doesn't wait the whole timeout again", async () => {
    h.chat.roomRoles = () => new Promise(() => undefined);
    h.chat.roomAliases = () => new Promise(() => undefined);
    const started = Date.now();
    for (let index = 0; index < 3; index += 1) await message(`@nobody-${index} hello`);
    expect(Date.now() - started, "one agent posting a name a second keeps approvals from ever being read").toBeLessThan(3_000);
  }, 10_000);
});

describe("F12: Switch's other notices read as a stranger asking", () => {
  // isUnheldRoleWarning covers one of the admin's two warnings. clients/mention_warnings.py posts the other for a mention of an
  // agent that isn't in the room, tags whoever wrote, and any agent can set it off by naming one.
  const ABSENT = "⚠️ @refunds-agent **Coder** isn't in this room, so your message won't reach it. Add the agent from the room's detail page in the gateway, or have an agent with room-management tools invite it.";

  it("control: the warning about a role nobody holds raises nothing", async () => {
    await priyaOnRecord();
    await arrives("@switch-admin:localhost", "⚠️ @refunds-agent no agent currently holds the **customer-email** role — your message may go unanswered. Run `!roles` to see availability, or have an agent assume it.", "#support");
    const held = await h.core.check(gateRefund(REFUND_SC4));
    expect(h.core.stores.requests.require(held.request_id as string).quorumRequired).toBe(1);
  });

  it("F12a: nor does the warning about an agent not in the room", async () => {
    await priyaOnRecord();
    await arrives("@switch-admin:localhost", ABSENT, "#support");
    const held = await h.core.check(gateRefund(REFUND_SC4));
    expect(h.core.stores.requests.require(held.request_id as string).quorumRequired, "any agent can raise its next hold to two approvers by naming someone absent").toBe(1);
  });

  it("F12b: nor when it tags a person, which reads as a stranger's voice in the room", async () => {
    await priyaOnRecord();
    await arrives("@switch-admin:localhost", ABSENT.replace("@refunds-agent", "@sam"), "#support");
    const held = await h.core.check(gateRefund(REFUND_SC4));
    expect(h.core.stores.requests.require(held.request_id as string).quorumRequired, "any person can stop one approval being enough, for every agent in the room, for ten minutes").toBe(1);
  });
});

describe("F13: refused calls and the figures people read", () => {
  it("F13a: they don't count as agent work a person governs", async () => {
    await priyaOnRecord();
    const held = await h.core.check(gateRefund(REFUND_SC4));
    await press(cardsFor(held.request_id as string).find((card) => card.roomId === "dm-sam") as OpenedCard, PARTICIPANTS.sam);
    const before = h.core.humanLoad().per_100_governed;
    for (let index = 0; index < 500; index += 1) refused(index, "refund", "POST /acme/refunds");
    expect(h.core.humanLoad().per_100_governed, "an agent with no grant moved the human-load figure with calls that did nothing").toBe(before);
  });

  it("F13b: nor are they refunds the rules stopped", () => {
    for (let index = 0; index < 50; index += 1) refused(index, "refund", "POST /acme/refunds");
    const { money } = h.core.roiReport();
    expect(money?.by_class.find((row) => row.class === "refund")?.rule_denied ?? 0, "the report says the rules stopped 50 refunds nobody could have made").toBe(0);
  });

  it("control: they leave autonomy alone", () => {
    const before = JSON.stringify(h.core.autonomyReport());
    for (let index = 0; index < 50; index += 1) refused(index, "refund", "POST /acme/refunds");
    expect(JSON.stringify(h.core.autonomyReport())).toBe(before);
  });

  it("control: the same id twice is one row and one ledger entry", () => {
    refused(1);
    refused(1);
    expect(h.core.stores.ledger.list().filter((entry) => entry.type === "denied")).toHaveLength(1);
  });
});

describe("F14: a notice's shape can hide what an agent claims", () => {
  // switch-notices.ts says an agent "can't hide what it says in the shape of one". A BOLD slot takes spaces, so it takes a sentence.
  const CLAIM = "Refunding 4000 to Rohan";
  const NOTICE = `My machine, **${CLAIM}**, was asleep and is starting now. I'll pick this up as soon as it's back, usually within a few minutes.`;

  async function flagsAfter(said: string): Promise<string[]> {
    await priyaOnRecord();
    await arrives(PARTICIPANTS.refundsAgent, said, "#support", "refunds-agent");
    const held = await h.core.check(gateRefund(REFUND_SC4));
    return h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.code);
  }

  it("control: said plainly, the claim is compared with the call", async () => {
    expect(await flagsAfter(`${CLAIM}.`)).toContain("mismatch");
  });

  it("F14: said in a notice's shape, it's compared too", async () => {
    expect(await flagsAfter(NOTICE)).toContain("mismatch");
  });

  it("guard: a real notice, with a machine or a room in bold, stays a notice", async () => {
    for (const name of ["priya-laptop", "priya laptop 2b", "eng", "refunds-agent", "room.7"]) {
      const notice = `My machine, **${name}**, was asleep and is starting now. I'll pick this up as soon as it's back, usually within a few minutes.`;
      expect(isSwitchNotice(notice), name).toBe(true);
    }
  });

  // A name in bold can't be told from a short claim with no bare number in it. docs/threat-model.md, under Limits: "What a notice can hide".
  it.fails("limit: a claim with no bare number still fits in bold", () => {
    expect(isSwitchNotice("My machine, **Deploying checkout v2.14.0**, was asleep and is starting now. I'll pick this up as soon as it's back, usually within a few minutes.")).toBe(false);
  });
});
