/**
 * Priya names @refunds-agent in #support. Within the window Sam asks the same agent somewhere Clearance can't see.
 * Without these, Clearance records Priya, keeps quorum at 1, and Sam approves his own refund alone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { AgentReachCheck, REACH_CACHE_MS } from "../src/router/reach.js";
import type { OpenedCard } from "./fakes.js";
import { chatMessage, gateRefund, hookShell, IDENTITIES, makeHarness, MINUTE, PARTICIPANTS, REFUND_CRITICAL, REFUND_SC3, REFUND_SC4, type Harness, type HarnessOptions } from "./harness.js";

let h: Harness;
const start = (options: HarnessOptions = {}) => {
  h = makeHarness(options);
  return h;
};
afterEach(() => h.core.close());

const support = { session: { switchRoomId: "#support", threadId: "t-1" } };
const inRoom = (switchRoomId: string) => ({ session: { switchRoomId } });
const noRoom = { session: undefined };

const say = (who: string, body: string, roomId = "#support") => h.core.onMessage(chatMessage(who, body, { roomId, threadId: null, addressed: true }));
const priyaAsks = (roomId = "#support") => say(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full", roomId);

const press = (card: OpenedCard, who: string, answer = "allow") =>
  h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer, answeredBy: who, answeredAtMs: h.clock.nowMs() });

const request = (id: string | undefined) => h.core.describeRequest(id!) as { state: string; quorum_required: number; requester_ids: string[]; flags: { code: string; text: string }[] };
const codes = (id: string | undefined) => request(id).flags.map((flag) => flag.code);

describe("a call that says which room it came from", () => {
  it("takes its requesters from that room, in the normal flow", async () => {
    start();
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(request(held.request_id)).toMatchObject({ quorum_required: 1, requester_ids: ["priya"] });
    expect(codes(held.request_id)).not.toContain("requester_unknown");
  });

  it("the break: someone asked in another room, nobody here, so it is unknown and needs two", async () => {
    start();
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, inRoom("dm-sam-refunds-agent")));
    expect(request(held.request_id).requester_ids).toEqual([]);
    expect(request(held.request_id).quorum_required).toBe(2);
    expect(codes(held.request_id)).toContain("requester_unknown");

    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(h.gate.calls).toEqual([]);
    expect(request(held.request_id).state).toBe("ROUTED");
    await press(h.chat.cardIn("dm-neha"), PARTICIPANTS.neha);
    expect(request(held.request_id).state).toBe("EXECUTED");
    expect(h.gate.calls).toHaveLength(1);
  });

  it("doesn't name the wrong person on the card as having asked", async () => {
    start();
    await priyaAsks();
    await h.core.check(gateRefund(REFUND_SC4, inRoom("dm-sam-refunds-agent")));
    expect(h.chat.cardIn("dm-sam").detail).toContain("requester unknown");
    expect(h.chat.cardIn("dm-sam").detail).not.toContain("Asked by Priya");
  });

  it("counts someone who spoke in that room when the agent is known there", async () => {
    start();
    await say(PARTICIPANTS.refundsAgent, "Morning. I'm on refunds in this room.");
    await say(PARTICIPANTS.priya, "refundbot, refund order A-2004 in full please");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(request(held.request_id)).toMatchObject({ quorum_required: 1, requester_ids: ["priya"] });
  });

  it("doesn't count someone who spoke in another room", async () => {
    start();
    await say(PARTICIPANTS.refundsAgent, "Morning.");
    await say(PARTICIPANTS.priya, "refundbot, refund order A-2004 in full please");
    const held = await h.core.check(gateRefund(REFUND_SC4, inRoom("#finance")));
    expect(request(held.request_id).requester_ids).toEqual([]);
    expect(request(held.request_id).quorum_required).toBe(2);
  });

  it("still won't let someone who asked elsewhere approve: the room on a call is only the agent's word", async () => {
    start();
    await say(PARTICIPANTS.sam, "@refunds-agent refund order A-2004 in full", "#finance");
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(request(held.request_id)).toMatchObject({ quorum_required: 1, requester_ids: ["priya"] });

    // Sam isn't routed a card, and if he answers one anyway it is refused.
    expect(h.chat.cards.some((card) => card.roomId === "dm-sam")).toBe(false);
    await press(h.chat.cardIn("#support"), PARTICIPANTS.sam);
    expect(request(held.request_id).state).not.toBe("EXECUTED");
    expect(h.gate.calls).toEqual([]);
    expect(h.core.stores.ledger.list({ requestId: held.request_id! }).map((entry) => entry.type)).toContain("ineligible_answer");
    await press(h.chat.cardIn("dm-neha"), PARTICIPANTS.neha);
    expect(request(held.request_id).state).toBe("EXECUTED");
  });

  it("reads a room by the policy's name for it, since messages carry its id", async () => {
    start({ identities: { ...IDENTITIES, rooms: { "#support": "room-uuid-1" } } });
    await priyaAsks("room-uuid-1");
    const held = await h.core.check(gateRefund(REFUND_SC4, inRoom("#support")));
    expect(request(held.request_id)).toMatchObject({ quorum_required: 1, requester_ids: ["priya"] });
  });

  it("leaves a call with no room as it was: everyone in the window", async () => {
    start();
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(request(held.request_id)).toMatchObject({ quorum_required: 1, requester_ids: ["priya"] });
    const hook = start();
    await hook.core.onMessage(chatMessage(PARTICIPANTS.alex, "@coder force-push", { roomId: "#eng", threadId: "t-9", addressed: true }));
    const shell = await hook.core.check(hookShell("git push --force origin main"));
    expect(request(shell.request_id).requester_ids).toEqual(["alex"]);
  });
});

describe("an agent also in a room Clearance can't see", () => {
  const unseen = (count: number) => {
    const asked: string[] = [];
    h.chat.unseenRoomCount = async (agent) => {
      asked.push(agent);
      return count;
    };
    return asked;
  };

  it("stays at quorum 1 when it is only in rooms Clearance can see, or SC3 and SC4 would break", async () => {
    start();
    const asked = unseen(0);
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(asked).toEqual(["refunds-agent"]);
    expect(request(held.request_id)).toMatchObject({ quorum_required: 1, requester_ids: ["priya"] });
    expect(codes(held.request_id)).not.toContain("agent_elsewhere");
    expect(h.chat.cards.filter((card) => card.roomId.startsWith("dm-")).map((card) => card.roomId)).toEqual(["dm-sam"]);
  });

  it("the break, as it is under Switch, with no room on the call: needs two, and Sam can't finish it alone", async () => {
    start();
    unseen(1);
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(request(held.request_id)).toMatchObject({ quorum_required: 2, requester_ids: ["priya"] });

    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam);
    expect(h.gate.calls).toEqual([]);
    expect(request(held.request_id).state).toBe("ROUTED");
    await press(h.chat.cardIn("dm-neha"), PARTICIPANTS.samSecond);
    expect(h.gate.calls).toEqual([]);
  });

  it("is finished by a second person", async () => {
    start();
    unseen(1);
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam);
    await press(h.chat.cardIn("dm-neha"), PARTICIPANTS.neha);
    expect(request(held.request_id).state).toBe("EXECUTED");
    expect(h.gate.calls).toHaveLength(1);
  });

  it("says why in plain words, on the card", async () => {
    start();
    unseen(1);
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    const text = "This agent is also working somewhere Clearance can't see, so this needs two approvals from different people.";
    expect(request(held.request_id).flags.map((flag) => flag.text)).toContain(text);
    expect(h.chat.cardIn("dm-sam").detail).toContain(text);
  });

  it("applies even when the call names a room with someone on record, since the room is only the agent's word", async () => {
    start();
    unseen(1);
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(request(held.request_id)).toMatchObject({ quorum_required: 2, requester_ids: ["priya"] });
  });

  it("doesn't stack with an unknown requester: two is two", async () => {
    start();
    unseen(1);
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(request(held.request_id).quorum_required).toBe(2);
    expect(codes(held.request_id)).toEqual(expect.arrayContaining(["requester_unknown", "agent_elsewhere"]));
  });

  it("doesn't lower a class that already asks for more, and a critical refund stays as it was", async () => {
    start();
    unseen(1);
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_CRITICAL, noRoom));
    expect(request(held.request_id).quorum_required).toBe(2);
    const typed = h.chat.cards.find((card) => card.roomId === "dm-sam")!;
    expect(typed).toBeDefined();
  });
});

describe("when Switch can't say", () => {
  it("takes the cautious side if the lookup fails, and says so", async () => {
    start();
    h.chat.unseenRoomCount = async () => {
      throw new Error("switch unreachable");
    };
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(held.decision).toBe("hold");
    expect(request(held.request_id).quorum_required).toBe(2);
    expect(codes(held.request_id)).toContain("agent_reach_unknown");
    expect(h.chat.cardIn("dm-sam").detail).toContain("Clearance couldn't check where this agent is working");
  });

  it("takes the cautious side if the lookup never answers, and the hold still goes through", async () => {
    start();
    h.chat.unseenRoomCount = () => new Promise(() => {});
    await priyaAsks();
    const startedAt = Date.now();
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(request(held.request_id).quorum_required).toBe(2);
    expect(codes(held.request_id)).toContain("agent_reach_unknown");
  }, 10_000);

  it("changes nothing for a port with no way to ask", async () => {
    start();
    expect(h.chat.unseenRoomCount).toBeUndefined();
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(request(held.request_id)).toMatchObject({ quorum_required: 1 });
    expect(codes(held.request_id)).not.toContain("agent_reach_unknown");
  });
});

describe("asking", () => {
  it("doesn't ask for a repeat of a request that is already open", async () => {
    start();
    let asks = 0;
    h.chat.unseenRoomCount = async () => {
      asks += 1;
      return 0;
    };
    await priyaAsks();
    await h.core.check(gateRefund(REFUND_SC4, noRoom));
    h.clock.advance(REACH_CACHE_MS + 1);
    await h.core.check(gateRefund(REFUND_SC4, noRoom));
    expect(asks).toBe(1);
  });

  it("doesn't ask for a drill, which nobody asked for", async () => {
    start();
    let asks = 0;
    h.chat.unseenRoomCount = async () => {
      asks += 1;
      return 3;
    };
    const drill = await h.core.sendDrill("sam");
    expect(drill.ok).toBe(true);
    expect(asks).toBe(0);
    if (drill.ok) expect(request(drill.requestId).quorum_required).toBe(1);
  });

  it("asks at most once per agent within the cache, and again after it", async () => {
    const clock = { now: 1_000, nowMs() { return this.now; }, scaledMs: (ms: number) => ms };
    const asked: string[] = [];
    let answer = 0;
    const check = new AgentReachCheck({ unseenRoomCount: async (agent: string) => (asked.push(agent), answer) }, clock);
    expect(await check.of("a")).toBe("all_seen");
    answer = 1;
    expect(await check.of("a")).toBe("all_seen");
    expect(await check.of("b")).toBe("elsewhere");
    expect(asked).toEqual(["a", "b"]);
    clock.now += REACH_CACHE_MS;
    expect(await check.of("a")).toBe("elsewhere");
    expect(asked).toEqual(["a", "b", "a"]);
  });

  it("doesn't keep a failure, so the next hold gets a real answer", async () => {
    const clock = { nowMs: () => 1_000, scaledMs: (ms: number) => ms };
    let fail = true;
    const check = new AgentReachCheck(
      {
        unseenRoomCount: async () => {
          if (fail) throw new Error("down");
          return 0;
        },
      },
      clock,
    );
    expect(await check.of("a")).toBe("unknown");
    fail = false;
    expect(await check.of("a")).toBe("all_seen");
  });

  it("gives up in time", async () => {
    const clock = { nowMs: () => 1_000, scaledMs: (ms: number) => ms };
    const check = new AgentReachCheck({ unseenRoomCount: () => new Promise(() => {}) }, clock, 20);
    expect(await check.of("a")).toBe("unknown");
  });
});

// Not about the window itself, but it is what makes "someone else asked earlier" true.
describe("the window", () => {
  it("still ends: after 10 minutes the old request is gone and it is unknown again", async () => {
    start();
    await priyaAsks();
    h.clock.advance(11 * MINUTE);
    const held = await h.core.check(gateRefund(REFUND_SC3, noRoom));
    expect(request(held.request_id).requester_ids).toEqual([]);
    expect(request(held.request_id).quorum_required).toBe(2);
  });
});
