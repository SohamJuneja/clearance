/** F10: every signal on its own, then what core does about them. A flagged approval is still a valid approval. */
import type { Tier } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STAMP_CONFIG,
  evidenceLines,
  ignoredFlags,
  isBatch,
  isConcentrated,
  isStreak,
  tMinMs,
  type PastAnswer,
} from "../src/rubberstamp/signals.js";
import type { OpenedCard } from "./fakes.js";
import { chatMessage, gateRefund, makeHarness, MINUTE, PARTICIPANTS, REFUND_SC3, REFUND_SC4, type Harness } from "./harness.js";

const config = DEFAULT_STAMP_CONFIG;

describe("t_min = 2 s + 0.25 s x evidence lines + tier bonus", () => {
  it.each<[number, Tier, number]>([
    [0, "low", 2000],
    [4, "low", 3000],
    [4, "medium", 3000],
    [6, "high", 6500],
    [0, "high", 5000],
    [8, "critical", 10000],
    [0, "critical", 8000],
    [1, "low", 2250],
  ])("%i lines at %s is %i ms", (lines, tier, expected) => {
    expect(tMinMs(lines, tier, config)).toBe(expected);
  });

  it("reads its numbers from the policy", () => {
    const custom = { ...config, baseS: 1, perLineS: 1, tierBonusS: { high: 10 } };
    expect(tMinMs(2, "high", custom)).toBe(13000);
    expect(tMinMs(2, "low", custom)).toBe(3000);
  });

  it("counts the call, the context and the flags as evidence lines", () => {
    expect(evidenceLines({ call: ["a", "b", "c"], context: ["d", "e"] }, [{ code: "x", text: "y" }])).toBe(6);
    expect(evidenceLines({ call: [], context: [] }, [])).toBe(0);
  });
});

describe("streaks: five or more approvals in a row, no denials, median under t_min", () => {
  const approval = (latencyMs: number, tMin = 5000): PastAnswer => ({ decision: "approve", latencyMs, tMinMs: tMin, atMs: 0 });
  const denial = (latencyMs = 1000): PastAnswer => ({ decision: "deny", latencyMs, tMinMs: 5000, atMs: 0 });

  it("fires on five fast approvals", () => {
    expect(isStreak([1, 1, 1, 1, 1].map((seconds) => approval(seconds * 1000)), config)).toBe(true);
  });

  it("does not fire on four", () => {
    expect(isStreak([1, 1, 1, 1].map((seconds) => approval(seconds * 1000)), config)).toBe(false);
  });

  it("fires on more than five", () => {
    expect(isStreak(Array.from({ length: 9 }, () => approval(1000)), config)).toBe(true);
  });

  it("a denial in the last five breaks it", () => {
    expect(isStreak([approval(1000), approval(1000), denial(), approval(1000), approval(1000), approval(1000)], config)).toBe(false);
  });

  it("a denial before the last five does not", () => {
    expect(isStreak([approval(1000), approval(1000), approval(1000), approval(1000), approval(1000), denial()], config)).toBe(true);
  });

  it("uses the median, so one fast answer in five careful ones does not fire", () => {
    expect(isStreak([approval(1000), approval(9000), approval(9000), approval(9000), approval(9000)], config)).toBe(false);
  });

  it("uses the median, so one slow answer in five fast ones still fires", () => {
    expect(isStreak([approval(9000), approval(1000), approval(1000), approval(1000), approval(1000)], config)).toBe(true);
  });

  it("compares against each card's own floor", () => {
    expect(isStreak([1, 2, 3, 4, 5].map(() => approval(6000, 8000)), config)).toBe(true);
    expect(isStreak([1, 2, 3, 4, 5].map(() => approval(6000, 5000)), config)).toBe(false);
  });
});

describe("batches: three or more approvals by one person within 20 seconds", () => {
  const now = 1_000_000;
  it.each([
    ["three inside 20 s", [now, now - 5000, now - 19_000], true],
    ["three at exactly 20 s", [now, now - 10_000, now - 20_000], true],
    ["three just outside", [now, now - 10_000, now - 20_001], false],
    ["two", [now, now - 1000], false],
    ["four, three of them close", [now, now - 1000, now - 2000, now - 90_000], true],
    ["one", [now], false],
  ])("%s", (_name, times, expected) => {
    expect(isBatch(times as number[], now, config)).toBe(expected);
  });
});

describe("approvals that ignore a flag", () => {
  it.each([
    [["mismatch"], ["mismatch"]],
    [["new_destination"], ["new_destination"]],
    [["amount_vs_order", "new_destination", "mismatch"], ["new_destination", "mismatch"]],
    [["amount_vs_order"], []],
    [["outside_hours"], []],
    [[], []],
  ])("%j", (codes, expected) => {
    expect(ignoredFlags(codes.map((code) => ({ code, text: code })))).toEqual(expected);
  });
});

describe("approver concentration: one person over 60% of a class's requests in a day", () => {
  const answers = (counts: Record<string, number>) =>
    Object.entries(counts).flatMap(([user, count]) => Array.from({ length: count }, () => user));

  it("fires above 60%", () => {
    expect(isConcentrated(answers({ sam: 4, neha: 1 }), "sam", config)).toBe(true);
  });

  it("does not fire at exactly 60%", () => {
    expect(isConcentrated(answers({ sam: 3, neha: 2 }), "sam", config)).toBe(false);
  });

  it("does not fire for the other person", () => {
    expect(isConcentrated(answers({ sam: 4, neha: 1 }), "neha", config)).toBe(false);
  });

  it("needs enough answers to mean anything: one answer is not 100% of a pattern", () => {
    expect(isConcentrated(answers({ sam: 1 }), "sam", config)).toBe(false);
    expect(isConcentrated(answers({ sam: 4 }), "sam", config)).toBe(false);
    expect(isConcentrated(answers({ sam: 5 }), "sam", config)).toBe(true);
  });

  it("is false with nothing to go on", () => {
    expect(isConcentrated([], "sam", config)).toBe(false);
  });
});

describe("what core does", () => {
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

  const lastCard = (room: string) => h.chat.cards.filter((card) => card.roomId === room).at(-1) as OpenedCard;
  const answered = (id: string) => h.core.stores.ledger.list({ requestId: id }).find((entry) => entry.type === "answered");

  /** SC4: three call lines, three context lines, no flags, high tier: t_min is 6.5 s. */
  async function heldRefund(amount = 40000): Promise<string> {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const held = await h.core.check(gateRefund({ ...REFUND_SC4, amount }));
    return held.request_id as string;
  }

  describe("a fast approval", () => {
    it("is flagged in the ledger as fast_approval, and is still valid", async () => {
      const id = await heldRefund();
      h.clock.advance(6499);
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(answered(id)?.payload).toMatchObject({ fast_approval: true, signals: ["fast"], t_min_ms: 6500, latency_ms: 6499 });
      expect(h.core.stores.requests.require(id).state).toBe("EXECUTED");
      expect(h.gate.calls).toHaveLength(1);
    });

    it("makes the next high-tier card for that person typed, with a rotating field", async () => {
      await heldRefund();
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(h.core.people.store.friction("sam")).toBe("fast");
      await heldRefund(40001);
      const next = lastCard("dm-sam");
      expect(next.kind).toBe("questions");
      expect(next.questions[0]?.prompt).toContain("Type the refund amount");
    });

    it("leaves other people's cards alone", async () => {
      await heldRefund();
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(h.core.people.store.friction("neha")).toBeNull();
    });
  });

  describe("a careful approval", () => {
    it("is not flagged at exactly t_min", async () => {
      const id = await heldRefund();
      h.clock.advance(6500);
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(answered(id)?.payload).toMatchObject({ fast_approval: false, signals: [] });
      expect(h.core.people.store.friction("sam")).toBeNull();
    });

    it("leaves the next card plain", async () => {
      await heldRefund();
      h.clock.advance(MINUTE);
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      await heldRefund(40001);
      expect(lastCard("dm-sam").kind).toBe("approval");
    });
  });

  describe("a denial", () => {
    it("is never flagged, however fast", async () => {
      const id = await heldRefund();
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
      expect(answered(id)?.payload).toMatchObject({ fast_approval: false, signals: [] });
      expect(h.core.people.store.friction("sam")).toBeNull();
    });
  });

  describe("an approval that ignores a flag", () => {
    it("is recorded and adds friction, but is not a fast approval", async () => {
      const held = await h.core.check(gateRefund(REFUND_SC3));
      const id = held.request_id as string;
      h.clock.advance(MINUTE);
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(answered(id)?.payload).toMatchObject({ fast_approval: false, signals: ["flag_ignored"], flags_ignored: ["new_destination"] });
      expect(h.core.people.store.friction("sam")).toBe("flag_ignored");
    });
  });

  describe("a batch", () => {
    it("flags the third approval inside 20 seconds, even when each card was open long enough", async () => {
      const ids = [await heldRefund(40001), await heldRefund(40002), await heldRefund(40003)];
      const cards = h.chat.cards.filter((card) => card.roomId === "dm-sam");
      h.clock.advance(MINUTE);
      await press(cards[0] as OpenedCard, PARTICIPANTS.sam);
      h.clock.advance(5000);
      await press(cards[1] as OpenedCard, PARTICIPANTS.sam);
      expect(answered(ids[1] as string)?.payload).toMatchObject({ fast_approval: false });
      h.clock.advance(5000);
      await press(cards[2] as OpenedCard, PARTICIPANTS.sam);
      expect(answered(ids[2] as string)?.payload).toMatchObject({ fast_approval: true, signals: ["batch"] });
    });
  });

  describe("a streak", () => {
    it("flags the fifth approval in a row under the floor", async () => {
      let id = "";
      for (let index = 0; index < 5; index += 1) {
        id = await heldRefund(40000 + index);
        h.clock.advance(1000);
        await press(lastCard("dm-sam"), PARTICIPANTS.sam);
        h.core.people.store.clearFriction("sam");
        h.clock.advance(MINUTE);
      }
      expect(answered(id)?.payload).toMatchObject({ fast_approval: true });
      expect((answered(id)?.payload as { signals: string[] }).signals).toEqual(["fast", "streak"]);
    });
  });

  describe("drills", () => {
    it("are not part of anyone's streak or batch", async () => {
      const ids = [await heldRefund(40001), await heldRefund(40002)];
      const [first, second] = h.chat.cards.filter((card) => card.roomId === "dm-sam");
      h.clock.advance(MINUTE);
      await h.core.sendDrill("sam");
      // Three approvals in a moment, if the drill counted.
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      h.core.people.store.clearFriction("sam");
      await press(first as OpenedCard, PARTICIPANTS.sam);
      await press(second as OpenedCard, PARTICIPANTS.sam);
      expect(answered(ids[1] as string)?.payload).toMatchObject({ signals: [] });
    });
  });

  describe("concentration", () => {
    it("starts preferring someone else once one person has answered over 60% of a class today", async () => {
      for (let index = 0; index < 5; index += 1) {
        await heldRefund(40000 + index);
        h.clock.advance(MINUTE);
        await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      }
      const id = await heldRefund(50000);
      const trace = h.core.traces.latest(id);
      expect(trace?.chosen).toEqual(["neha"]);
      expect(trace?.ranked.find((entry) => entry.id === "sam")?.concentrated).toBe(true);
      expect(h.chat.cards.some((card) => card.roomId === "dm-neha")).toBe(true);
    });

    it("still routes to them when nobody else can take it", async () => {
      for (let index = 0; index < 5; index += 1) {
        await heldRefund(40000 + index);
        h.clock.advance(MINUTE);
        await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      }
      h.core.people.store.setAway("neha", h.clock.nowMs() + 60 * MINUTE, null);
      const id = await heldRefund(50000);
      expect(h.core.traces.latest(id)?.chosen).toEqual(["sam"]);
    });

    it("does not carry over to a day later", async () => {
      for (let index = 0; index < 5; index += 1) {
        await heldRefund(40000 + index);
        h.clock.advance(MINUTE);
        await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      }
      h.clock.advance(25 * 60 * MINUTE);
      const id = await heldRefund(50000);
      expect(h.core.traces.latest(id)?.ranked.find((entry) => entry.id === "sam")?.concentrated).toBe(false);
    });

    it("counts per class: refunds do not make someone concentrated on deploys", async () => {
      for (let index = 0; index < 5; index += 1) {
        await heldRefund(40000 + index);
        h.clock.advance(MINUTE);
        await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      }
      await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@ops-agent ship", { roomId: "#eng", threadId: null }));
      const held = await h.core.check({
        ...gateRefund(),
        agent: { name: "ops-agent" },
        session: { switchRoomId: "#eng" },
        business: { endpoint: "POST /acme/deploys", args: { service: "checkout", env: "prod", version: "v2.13.2" } },
      });
      expect(h.core.traces.latest(held.request_id as string)?.chosen).toEqual(["alex"]);
    });
  });

  describe("GET /v1/people/:id/stats", () => {
    it("shows that person's latency by tier, flags and fast approvals", async () => {
      await heldRefund();
      h.clock.advance(2000);
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(h.core.personStats("sam")).toMatchObject({
        fast_approvals: 1,
        signals: { fast: 1 },
        friction: "fast",
        by_tier: { high: { answers: 1, median_latency_ms: 2000 } },
      });
    });
  });
});
