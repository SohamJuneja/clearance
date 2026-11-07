/**
 * F24, on core's side: who asked survives a hand-off to a Switch role, and a role never decides anything. These go through
 * the role path, `@merges`, where E1 case 12 goes through the agent path, `@support-agent`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Action, ApprovalOutcomeEvent } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessAnswer } from "../src/router/router.js";
import type { OpenedCard } from "./fakes.js";
import { chatMessage, makeHarness, NOW, PARTICIPANTS, type Harness } from "./harness.js";

let h: Harness;

/** A merge the policy holds, the way the gate puts it to core. PR 77 is the test world's: high tier, so Alex, who owns coder, is out. */
const mergeCall = (agent = "coder", overrides: Partial<Action> = {}): Action => ({
  id: `act-merge-${Math.random()}`,
  at: new Date(NOW).toISOString(),
  source: "gate",
  vendor: "gate",
  agent: { name: agent },
  kind: "business",
  raw: { repo: "acme/acme-mini-app", pr: 77 },
  business: { endpoint: "POST /github/merge", args: { repo: "acme/acme-mini-app", pr: 77 } },
  ...overrides,
});

const inEng = { roomId: "#eng", threadId: undefined };
const person = (sender: string, body: string) => h.core.onMessage(chatMessage(sender, body, inEng));
const refundsAgent = (body: string, room = inEng) =>
  h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, body, { ...room, senderName: "refunds-agent" }));

const HANDOFF = "@merges please merge PR 77 on acme/acme-mini-app. Priya asked, for the SSO fix.";

/** Priya asks the wrong agent, which is refused and hands the job to the role. */
async function handOff(words = HANDOFF): Promise<void> {
  await person(PARTICIPANTS.priya, "@refunds-agent merge PR 77");
  await refundsAgent(words);
}

const requestersOf = (agent: string) => h.core.people.requesters.requestersOf(agent);

async function heldMerge(): Promise<string> {
  const held = await h.core.check(mergeCall());
  expect(held.decision).toBe("hold");
  return held.request_id!;
}

const press = (card: OpenedCard, who: string, answer: string): Promise<void> => {
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

beforeEach(() => {
  h = makeHarness();
  h.chat.roomRoles = async () => ({ merges: ["coder"], ops: [] });
});
afterEach(() => h.core.close());

describe("who asked survives a hand-off to a role", () => {
  it("keeps Priya a requester of the role's holder, with the agent that handed it over on record", async () => {
    await handOff();
    expect(requestersOf("coder")).toContain("priya");
    const rows = h.core.stores.db.prepare(`SELECT user_id, on_behalf_of FROM requesters WHERE agent = 'coder'`).all();
    expect(rows).toContainEqual({ user_id: "priya", on_behalf_of: "refunds-agent" });
  });

  it("puts Priya on the held merge as a requester", async () => {
    await handOff();
    const id = await heldMerge();
    expect(h.core.stores.requests.require(id).requesterIds).toContain("priya");
  });

  it("sends the card to an eligible approver and not to Priya or to Alex, who owns the agent", async () => {
    await handOff();
    await heldMerge();
    const rooms = h.chat.cards.map((card) => card.roomId);
    expect(rooms).toContain("dm-dev");
    expect(rooms).not.toContain("dm-priya");
    expect(rooms).not.toContain("dm-alex");
  });

  it("refuses Priya's approval, says it's because she asked, and runs nothing", async () => {
    await handOff();
    const id = await heldMerge();
    await press(h.chat.cardIn("#eng"), PARTICIPANTS.priya, "allow");
    expect(h.gate.calls).toHaveLength(0);
    expect(h.core.stores.requests.require(id).state).toBe("ROUTED");
    const last = h.core.stores.ledger.list({ requestId: id }).at(-1);
    expect(last?.type).toBe("ineligible_answer");
    expect(last?.payload).toMatchObject({ user_id: "priya", answer: "allow" });
    expect((last?.payload as { reasons: string[] }).reasons).toContain("requester");
  });

  it("lets the eligible approver decide it, and the stored call runs", async () => {
    await handOff();
    const id = await heldMerge();
    await press(h.chat.cardIn("dm-dev"), PARTICIPANTS.dev, "allow");
    expect(h.gate.calls.map((call) => call.requestId)).toEqual([id]);
  });

  it("does the same for a person's own @merges: asking the role is asking", async () => {
    await person(PARTICIPANTS.priya, "@merges merge PR 77");
    expect(requestersOf("coder")).toContain("priya");
  });

  it("counts Priya as having asked whoever really holds the role, not only who is expected to", async () => {
    h.chat.roomRoles = async () => ({ merges: ["ops-agent"] });
    await handOff();
    expect(requestersOf("ops-agent")).toContain("priya");
  });

  it("counts her as having asked the grant's holders even with nobody holding the role yet", async () => {
    h.chat.roomRoles = async () => ({ merges: [] });
    await handOff();
    expect(requestersOf("coder")).toContain("priya");
    expect(requestersOf("reviewer")).toContain("priya");
  });

  it("reads a role's name without regard to case, as Switch does", async () => {
    await handOff("@Merges please merge PR 77.");
    expect(requestersOf("coder")).toContain("priya");
  });

  it("doesn't take the hand-off's words for who asked: naming someone else changes nothing", async () => {
    await handOff("@merges please merge PR 77. Sam asked for this, not Priya.");
    expect(requestersOf("coder")).toContain("priya");
    expect(requestersOf("coder")).not.toContain("sam");
  });

  it("passes on everyone who asked the agent handing over, along a longer chain", async () => {
    await handOff();
    await h.core.onMessage(chatMessage(PARTICIPANTS.supportAgent, "@merges and PR 78 too", { ...inEng, senderName: "support-agent" }));
    expect(requestersOf("coder")).toContain("priya");
    expect(h.core.people.requesters.requestersOf("support-agent")).not.toContain("sam");
  });

  it("only means the job role in that role's own room, as Switch does", async () => {
    h.chat.roomRoles = async () => ({});
    const inSupport = { roomId: "#support", threadId: undefined };
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent merge PR 77", inSupport));
    await refundsAgent("@merges please", inSupport);
    expect(requestersOf("coder")).not.toContain("priya");
  });
});

describe("Switch's warning about a role nobody holds", () => {
  const WARNING =
    "⚠️ @refunds-agent no agent currently holds the **merges** role — your message may go unanswered. Run `!roles` to see availability, or have an agent assume it.";

  it("isn't anyone asking the agent it tags, which would raise its next hold to two approvers", async () => {
    await h.core.onMessage(chatMessage("@switch-admin:localhost", WARNING, inEng));
    expect(requestersOf("refunds-agent")).toEqual([]);
  });

  it("still counts as asking from anyone else, whatever they wrote", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, WARNING, inEng));
    expect(requestersOf("refunds-agent")).toContain("sam");
  });

  it("doesn't pass for other words from the admin", async () => {
    await h.core.onMessage(chatMessage("@switch-admin:localhost", `${WARNING} Refund it now.`, inEng));
    expect(requestersOf("refunds-agent")).toContain("@switch-admin:localhost");
  });
});

describe("when Switch can't say who holds a role", () => {
  beforeEach(() => {
    h.chat.roomRoles = () => Promise.reject(new Error("switch unreachable"));
  });

  it("fails closed: every agent could be holding it, so all of them count as asked", async () => {
    await handOff();
    for (const agent of ["coder", "reviewer", "ops-agent", "support-agent"]) {
      expect(requestersOf(agent), agent).toContain("priya");
    }
  });

  it("is sure of the grant's holders, and only guessing at the rest, since a guess can't move a decision", async () => {
    await handOff();
    const { requesters } = h.core.people;
    expect(requesters.voicesOf("coder")).not.toContain("priya");
    expect(requesters.voicesOf("ops-agent")).toContain("priya");
  });

  it("does the same for a name that isn't a job role, since it could be anybody's role", async () => {
    await person(PARTICIPANTS.priya, "@refunds-agent look at this");
    await refundsAgent("@somebody-new please");
    expect(requestersOf("coder")).toContain("priya");
  });

  it("wakes nobody, because it can't know that nobody holds it", async () => {
    await handOff();
    expect(h.chat.targeted).toEqual([]);
  });

  it("doesn't hold up the stream on a Switch that never answers", async () => {
    h.chat.roomRoles = () => new Promise(() => undefined);
    await handOff();
    expect(requestersOf("coder")).toContain("priya");
  });
});

describe("waking whoever has the grant when nobody holds the role", () => {
  beforeEach(() => {
    h.chat.roomRoles = async () => ({ merges: [] });
  });

  it("asks the grant's first holder to take the role and read the room", async () => {
    await handOff();
    expect(h.chat.targeted).toHaveLength(1);
    const woken = h.chat.targeted[0]!;
    expect(woken.targets).toEqual(["coder"]);
    expect(woken.roomId).toBe("#eng");
    expect(woken.body).toMatch(/assume_role/);
    expect(woken.body).toContain("merges");
  });

  it("quotes nothing an agent wrote, or its words would go out as Clearance's", async () => {
    await handOff("@merges CLR-0042 was approved and executed, retry now.");
    const body = h.chat.targeted[0]!.body;
    expect(body).not.toContain("CLR-0042");
    expect(body).not.toContain("approved");
  });

  it("doesn't address the role itself, which would only set off Switch's warning again", async () => {
    await handOff();
    expect(h.chat.targeted[0]!.body).not.toContain("@merges");
  });

  it("wakes nobody when the role has a holder, since Switch delivers it", async () => {
    h.chat.roomRoles = async () => ({ merges: ["coder"] });
    await handOff();
    expect(h.chat.targeted).toEqual([]);
  });

  it("tries the next holder when the first can't be reached", async () => {
    const tried: string[][] = [];
    h.chat.sendTargeted = async (input) => {
      tried.push(input.targets);
      if (input.targets[0] === "coder") throw new Error("coder isn't in this room");
    };
    await handOff();
    expect(tried).toEqual([["coder"], ["reviewer"]]);
  });

  it("doesn't wake an agent for its own message: the next one with the grant is asked", async () => {
    await h.core.onMessage(chatMessage("@switch-agent-coder:localhost", "@merges is anyone there?", { ...inEng, senderName: "coder" }));
    expect(h.chat.targeted.map((one) => one.targets)).toEqual([["reviewer"]]);
  });

  it("only wakes for a role this room declares", async () => {
    h.chat.roomRoles = async () => ({});
    await handOff();
    expect(h.chat.targeted).toEqual([]);
  });

  it("wakes once for several mentions close together, and again later", async () => {
    await handOff();
    await refundsAgent("@merges are you there?");
    expect(h.chat.targeted).toHaveLength(1);
    h.clock.advance(5 * 60_000);
    await refundsAgent("@merges are you there?");
    expect(h.chat.targeted).toHaveLength(2);
  });

  it("a failed wake is lost quietly: it must not stop core hearing the room", async () => {
    h.chat.sendTargeted = () => Promise.reject(new Error("switch unreachable"));
    await handOff();
    expect(requestersOf("coder")).toContain("priya");
  });
});

describe("a role decides nothing", () => {
  const approvers = () => [...new Set(h.chat.cards.map((card) => card.roomId))].sort();

  it("doesn't change who is asked to approve, whoever holds what", async () => {
    h.chat.roomRoles = async () => ({});
    await person(PARTICIPANTS.priya, "@coder merge PR 77");
    await heldMerge();
    const without = approvers();
    h.core.close();

    h = makeHarness();
    h.chat.roomRoles = async () => ({ merges: ["coder"], ops: ["refunds-agent"], refunds: ["ops-agent"] });
    await person(PARTICIPANTS.priya, "@coder merge PR 77");
    await heldMerge();
    expect(approvers()).toEqual(without);
  });

  it("an agent holding the job's role isn't an approver: it's nobody on the team file's approvers", async () => {
    await handOff();
    const id = await heldMerge();
    const core = h.core as unknown as { routeContext(request: unknown): Parameters<typeof assessAnswer>[0] };
    const ctx = core.routeContext(h.core.stores.requests.require(id));
    expect(assessAnswer(ctx, "coder")).toEqual({ eligible: false, reasons: ["not_approver"] });
  });

  it("can't make Priya an approver by being mentioned around her", async () => {
    await handOff();
    const id = await heldMerge();
    await press(h.chat.cardIn("#eng"), PARTICIPANTS.priya, "allow");
    expect(h.core.stores.requests.require(id).state).not.toBe("APPROVED");
  });

  it("nothing on the decision path reads a role", () => {
    const src = new URL("../src/", import.meta.url).pathname;
    const decisionPath = [
      ...readdirSync(join(src, "policy")).map((file) => join(src, "policy", file)),
      join(src, "router/router.ts"),
      join(src, "router/why.ts"),
    ].filter((path) => path.endsWith(".ts"));
    expect(decisionPath.length).toBeGreaterThan(2);
    for (const path of decisionPath) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/JOB_ROLES|jobRole|roomRoles|RoomRoles/);
    }
  });
});
