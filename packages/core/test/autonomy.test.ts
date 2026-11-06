/** F11 earned autonomy: the ladder, replay, promotion by two people, and instant demotion. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BucketEventStore,
  generateSyntheticHistory,
  HISTORY_SEED,
  seedSyntheticHistory,
  type NewBucketEvent,
} from "../src/autonomy/history.js";
import { bucketStats, F11_CRITERIA, meetsPromotion, percentile95, proposedLevel, type BucketStats } from "../src/autonomy/promotion.js";
import { openDatabase } from "../src/db/index.js";
import type { OpenedCard } from "./fakes.js";
import { chatMessage, gateRefund, makeHarness, MINUTE, NOW, PARTICIPANTS, POLICY_PATH, REFUND_SC4, type Harness } from "./harness.js";

const DAY = 24 * 60 * MINUTE;

function event(overrides: Partial<NewBucketEvent> = {}): NewBucketEvent {
  return {
    agent: "refunds-agent",
    cls: "refund",
    bucket: "small",
    requestId: null,
    atMs: NOW - DAY,
    fields: { amount: 2000 },
    outcome: "approved",
    approvers: ["sam"],
    fast: false,
    edited: false,
    incident: false,
    autoEligible: true,
    synthetic: false,
    ...overrides,
  };
}

const many = (count: number, overrides: Partial<NewBucketEvent> = {}): NewBucketEvent[] =>
  Array.from({ length: count }, (_, index) => event({ approvers: [index % 2 === 0 ? "sam" : "neha"], ...overrides }));

describe("promotion criteria, exactly as F11 says", () => {
  const stats = (events: NewBucketEvent[]): BucketStats => bucketStats(events);

  it("are 20 approvals over 7 days from at least 2 people", () => {
    expect(F11_CRITERIA).toEqual({ approvals: 20, days: 7, minDistinctApprovers: 2 });
  });

  it("pass at exactly 20 approvals from 2 people", () => {
    expect(meetsPromotion(stats(many(20)), F11_CRITERIA)).toBe(true);
  });

  it("fail at 19", () => {
    expect(meetsPromotion(stats(many(19)), F11_CRITERIA)).toBe(false);
  });

  it("fail on one denial", () => {
    expect(meetsPromotion(stats([...many(30), event({ outcome: "denied" })]), F11_CRITERIA)).toBe(false);
  });

  it("fail on one incident", () => {
    expect(meetsPromotion(stats([...many(30), event({ incident: true })]), F11_CRITERIA)).toBe(false);
  });

  it("fail on one approved-with-edits", () => {
    expect(meetsPromotion(stats([...many(30), event({ edited: true })]), F11_CRITERIA)).toBe(false);
  });

  it("fail with one approver, however many approvals", () => {
    expect(meetsPromotion(stats(many(40, { approvers: ["sam"] })), F11_CRITERIA)).toBe(false);
  });

  it("do not count fast approvals: 19 careful and 10 fast is not enough", () => {
    const events = [...many(19), ...many(10, { fast: true })];
    const counted = stats(events);
    expect(counted).toMatchObject({ requests: 29, counted: 19, fastExcluded: 10 });
    expect(meetsPromotion(counted, F11_CRITERIA)).toBe(false);
  });

  it("do not let fast approvers count as different people", () => {
    const events = [...many(25, { approvers: ["sam"] }), event({ approvers: ["neha"], fast: true })];
    expect(stats(events).approvers).toEqual(["sam"]);
    expect(meetsPromotion(stats(events), F11_CRITERIA)).toBe(false);
  });

  it("do not treat something that ran by itself as a person's approval", () => {
    const events = [...many(10), ...many(30, { outcome: "auto", approvers: [] })];
    expect(stats(events).counted).toBe(10);
    expect(meetsPromotion(stats(events), F11_CRITERIA)).toBe(false);
  });

  it("the replay counts what would have run by itself, and what it would have got wrong", () => {
    const result = stats([...many(20), event({ autoEligible: false }), event({ outcome: "denied" })]);
    expect(result).toMatchObject({ wouldAuto: 21, wouldAutoApproved: 20, wouldAutoDenied: 1, denied: 1 });
  });
});

describe("which level a promotion proposes", () => {
  it.each([
    ["L0", "L3", "L2"],
    ["L1", "L3", "L2"],
    ["L2", "L3", "L3"],
    ["L0", "L2", "L2"],
    ["L0", "L1", "L1"],
    ["L1", "L1", null],
    ["L3", "L3", null],
    ["L0", "L0", null],
  ] as const)("from %s with a cap of %s: %s", (current, max, expected) => {
    expect(proposedLevel(current, max)).toBe(expected);
  });
});

describe("the bucket's 95th percentile", () => {
  it("is nearest-rank", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile95(values)).toBe(95);
  });

  it("needs 20 samples to mean anything", () => {
    expect(percentile95(Array.from({ length: 19 }, () => 100))).toBeNull();
    expect(percentile95(Array.from({ length: 20 }, () => 100))).toBe(100);
  });
});

describe("the seeded history", () => {
  const history = generateSyntheticHistory(HISTORY_SEED, NOW);
  const refunds = history.filter((row) => row.cls === "refund");
  const small = refunds.filter((row) => row.bucket === "small");

  it("is the same every time from the same seed", () => {
    expect(generateSyntheticHistory(HISTORY_SEED, NOW)).toEqual(history);
    expect(generateSyntheticHistory(HISTORY_SEED + 1, NOW)).not.toEqual(history);
  });

  it("is labelled synthetic, every row", () => {
    expect(history.every((row) => row.synthetic)).toBe(true);
  });

  it("is 120 refunds over 7 days, about 85% at or below ₹5,000", () => {
    expect(refunds).toHaveLength(120);
    expect(small.length / refunds.length).toBeGreaterThan(0.8);
    expect(small.length / refunds.length).toBeLessThan(0.9);
    expect(refunds.every((row) => row.atMs <= NOW && row.atMs > NOW - 7 * DAY)).toBe(true);
    for (const row of refunds) expect(Number(row.fields.amount) <= 5000).toBe(row.bucket === "small");
  });

  it("has a handful of flawed refunds that people denied, none of them small", () => {
    const denied = refunds.filter((row) => row.outcome === "denied");
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied.every((row) => row.bucket === null)).toBe(true);
  });

  it("has some fast approvals", () => {
    expect(small.filter((row) => row.fast).length).toBeGreaterThan(0);
  });

  it("leaves room above the 95th percentile inside the bucket, so an anomaly is possible", () => {
    const ceiling = percentile95(small.map((row) => Number(row.fields.amount))) as number;
    expect(ceiling).toBeLessThan(5000);
  });
});

describe("the event store", () => {
  it("replaces earlier synthetic rows when seeded twice and leaves real ones alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "clearance-history-"));
    const db = openDatabase(join(dir, "history.sqlite"));
    try {
      const store = new BucketEventStore(db);
      store.add(event({ requestId: "CLR-0001" }));
      const first = seedSyntheticHistory(db, HISTORY_SEED, NOW);
      const second = seedSyntheticHistory(db, HISTORY_SEED, NOW);
      expect(second).toEqual(first);
      expect(store.counts()).toEqual({ synthetic: first.events, real: 1 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("in core", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.core.close());

  const SMALL = { order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "rohan.s@okhdfc" };

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
  const say = (who: string, body: string, roomId = "#approvals") =>
    h.core.onMessage(chatMessage(who, body, { roomId, threadId: null, addressed: true }));
  const ledger = (type: string) => h.core.stores.ledger.list().filter((entry) => entry.type === type);
  const level = (agent = "refunds-agent", cls = "refund", bucket = "small") => h.core.stores.autonomy.levelFor(agent, cls, bucket);
  const setLevel = (value: "L0" | "L1" | "L2" | "L3") =>
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", value, h.clock.nowMs());
  const posted = (room = "#approvals") => h.chat.messages.filter((message) => message.roomId === room).map((message) => message.body);
  const seed = () => seedSyntheticHistory(h.core.stores.db, HISTORY_SEED, h.clock.nowMs());
  const report = () => h.core.autonomyReport();

  async function smallRefund(args: Record<string, unknown> = SMALL) {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    return h.core.check(gateRefund(args));
  }

  async function signed(): Promise<void> {
    seed();
    await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
    await press(lastCard("dm-sam"), PARTICIPANTS.sam);
    await press(lastCard("dm-alex"), PARTICIPANTS.alex);
  }

  describe("the proposal from seeded history", () => {
    it("yields exactly one, for the one bucket that earned it", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      await say(PARTICIPANTS.alex, "@clearance autonomy");
      const { proposals } = report();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        kind: "promotion",
        state: "open",
        agent: "refunds-agent",
        class: "refund",
        bucket: "small",
        level: "L2",
        quorum: 2,
      });
      expect(proposals[0]?.id).toMatch(/^PROP-\d{4}$/);
      expect(ledger("promotion_proposed")).toHaveLength(1);
      expect(level()).toBe("L0");
    });

    it("gives one review card when the next tick comes while it is still opening", async () => {
      setLevel("L2");
      let release!: () => void;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realOpen = h.chat.openCard.bind(h.chat);
      vi.spyOn(h.chat, "openCard").mockImplementation(async (input) => {
        await slow;
        return realOpen(input);
      });
      const ran = smallRefund();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const ticked = h.core.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await Promise.all([ran, ticked]);
      expect(h.chat.cards).toHaveLength(1);
    });

    it("gives a signer one card when the next tick comes while that card is still opening", async () => {
      seed();
      let release!: () => void;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realOpen = h.chat.openCard.bind(h.chat);
      vi.spyOn(h.chat, "openCard").mockImplementation(async (input) => {
        if (input.roomId === "dm-alex") await slow;
        return realOpen(input);
      });
      const asked = say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await h.core.tick();
      release();
      await asked;
      expect(h.chat.cards.filter((card) => card.roomId === "dm-alex")).toHaveLength(1);
    });

    it("gives a signer one card when another signer answers while that card is still opening", async () => {
      seed();
      let release!: () => void;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realOpen = h.chat.openCard.bind(h.chat);
      vi.spyOn(h.chat, "openCard").mockImplementation(async (input) => {
        if (input.roomId === "dm-alex") await slow;
        return realOpen(input);
      });
      const asked = say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const pressed = press(lastCard("dm-sam"), PARTICIPANTS.sam);
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await Promise.all([asked, pressed]);
      expect(h.chat.cards.filter((card) => card.roomId === "dm-alex")).toHaveLength(1);
      expect(report().proposals[0]).toMatchObject({ state: "open", signed_by: ["sam"] });
    });

    it("says why the others did not earn one", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy");
      const buckets = await h.core.autonomyReplay();
      const deploy = buckets.find((row) => row.class === "deploy");
      const email = buckets.find((row) => row.class === "customer_email");
      expect(deploy).toMatchObject({ meets_criteria: false, denied: 1 });
      expect(email).toMatchObject({ meets_criteria: false, approvers: ["priya"] });
    });

    it("goes to one owner per policy_owners entry, with the replay and a synthetic label", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      const replay = (await h.core.autonomyReplay({ agent: "refunds-agent", class: "refund", bucket: "small" }))[0];
      for (const room of ["dm-sam", "dm-alex"]) {
        const card = lastCard(room);
        expect(card.kind).toBe("approval");
        expect(card.detail).toContain("Proposal: refunds-agent may auto-approve refunds up to ₹5,000 (level L2, with a review card).");
        expect(card.detail).toContain(
          `Last 7 days in this range (synthetic history): ${replay?.requests} requests, ${replay?.counted} approved by 2 different people, 0 denied, 0 incidents, 0 fast approvals counted (${replay?.fast_excluded} left out).`,
        );
        expect(card.detail).toContain(
          `Replay: this rule would have auto-approved ${replay?.would_auto}, all of which people approved; 0 would have auto-approved a denied request.`,
        );
        expect(card.detail).toContain("Two approvals needed.");
      }
      expect(h.chat.cards.filter((card) => card.roomId === "dm-neha")).toEqual([]);
    });

    it("one person's signature changes nothing", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(level()).toBe("L0");
      expect(ledger("promotion_signed")).toEqual([]);
      expect(report().proposals[0]).toMatchObject({ state: "open", signed_by: ["sam"] });
    });

    it("two people's signatures promote, and the ledger shows who", async () => {
      await signed();
      expect(level()).toBe("L2");
      expect(ledger("promotion_signed")).toHaveLength(1);
      expect(ledger("promotion_signed")[0]?.payload).toMatchObject({
        agent: "refunds-agent",
        class: "refund",
        bucket: "small",
        level: "L2",
        signed_by: ["sam", "alex"],
      });
      expect(report().proposals[0]).toMatchObject({ state: "signed" });
      expect(posted().at(-1)).toContain("refunds-agent may now auto-approve refunds up to ₹5,000");
    });

    it("the same person answering from a second account counts once, and the other owner is asked again", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      const before = h.chat.cards.filter((card) => card.roomId === "dm-alex").length;
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      await press(lastCard("dm-alex"), PARTICIPANTS.samSecond);
      expect(level()).toBe("L0");
      expect(h.chat.cards.filter((card) => card.roomId === "dm-alex").length).toBe(before + 1);
      await press(lastCard("dm-alex"), PARTICIPANTS.alex);
      expect(level()).toBe("L2");
    });

    it("someone who is not a policy owner cannot sign", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      await press(lastCard("dm-sam"), PARTICIPANTS.priya);
      expect(report().proposals[0]).toMatchObject({ state: "open", signed_by: [] });
      expect(ledger("ineligible_answer").at(-1)?.payload).toMatchObject({ user_id: "priya" });
    });

    it("an agent cannot sign", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      await press(lastCard("dm-sam"), PARTICIPANTS.refundsAgent);
      expect(report().proposals[0]).toMatchObject({ state: "open", signed_by: [] });
    });

    it("the agent's owner cannot sign their own agent's promotion", async () => {
      const store = new BucketEventStore(h.core.stores.db);
      for (const row of many(25, { agent: "ops-agent", cls: "deploy", bucket: "staging", fields: { env: "staging" } })) store.add(row);
      await say(PARTICIPANTS.sam, "@clearance autonomy ops-agent");
      expect(report().proposals).toHaveLength(1);
      expect(h.chat.cards.filter((card) => card.roomId === "dm-alex")).toEqual([]);
      expect(h.chat.cards.map((card) => card.roomId).sort()).toEqual(["dm-neha", "dm-sam"]);
      await press(lastCard("dm-sam"), PARTICIPANTS.alex);
      expect(report().proposals[0]).toMatchObject({ signed_by: [] });
    });

    it("does not open one that nobody could sign", async () => {
      const store = new BucketEventStore(h.core.stores.db);
      for (const row of many(25, { agent: "ops-agent", cls: "deploy", bucket: "staging", fields: { env: "staging" } })) store.add(row);
      h.core.people.store.setAway("neha", h.clock.nowMs() + DAY, null);
      await say(PARTICIPANTS.sam, "@clearance autonomy ops-agent");
      expect(report().proposals).toEqual([]);
      expect(posted().at(-1)).toContain("two policy owners");
    });

    it("one no rejects it, closes the other card, and it isn't proposed again that week", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
      expect(report().proposals[0]).toMatchObject({ state: "rejected" });
      expect(lastCard("dm-alex").closed).toBe(true);
      expect(ledger("promotion_rejected")).toHaveLength(1);
      expect(level()).toBe("L0");
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      expect(report().proposals).toHaveLength(1);
    });

    it("is not signed if the evidence has gone by the time the second person answers", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      new BucketEventStore(h.core.stores.db).add(event({ outcome: "denied", atMs: h.clock.nowMs() }));
      await press(lastCard("dm-alex"), PARTICIPANTS.alex);
      expect(level()).toBe("L0");
      expect(ledger("promotion_signed")).toEqual([]);
      expect(ledger("promotion_rejected").at(-1)?.payload).toMatchObject({ reason: "evidence_changed" });
    });

    it("opens its cards when Switch comes back, if it was down when it was proposed", async () => {
      seed();
      h.chat.failOpenCard = true;
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      expect(report().proposals).toHaveLength(1);
      h.chat.failOpenCard = false;
      await h.core.tick();
      await h.core.tick();
      expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);
      expect(h.chat.cards.filter((card) => card.roomId === "dm-alex")).toHaveLength(1);
    });

    it("expires, closing its cards", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      h.clock.advance(4 * DAY);
      await h.core.tick();
      expect(report().proposals[0]).toMatchObject({ state: "expired" });
      expect(lastCard("dm-sam").closed).toBe(true);
    });
  });

  describe("promotion from real traffic", () => {
    async function realApprovals(count: number, latency: number): Promise<void> {
      const world = h.lookup.world as Record<string, Record<string, Record<string, unknown>>>;
      for (let index = 0; index < count; index += 1) {
        const customer = `cus_real_${index}`;
        (world.customers as Record<string, Record<string, unknown>>)[customer] = { id: customer, name: "Someone" };
        const held = await smallRefund({ ...SMALL, customer_id: customer });
        h.clock.advance(latency);
        const open = h.core.stores.routes.openForRequest(held.request_id as string).find((row) => row.user_id);
        const card = h.chat.cards.find((candidate) => candidate.switchRequestId === open?.switch_request_id) as OpenedCard;
        const who = open?.user_id === "sam" ? PARTICIPANTS.sam : PARTICIPANTS.neha;
        await press(card, who);
        h.clock.advance(MINUTE);
        h.core.people.store.clearFriction("sam");
        h.core.people.store.clearFriction("neha");
      }
    }

    it("opens by itself on the twentieth careful approval", async () => {
      await realApprovals(19, MINUTE);
      expect(report().proposals).toEqual([]);
      await realApprovals(1, MINUTE);
      expect(report().proposals).toHaveLength(1);
      expect(report().history).toEqual({ synthetic: 0, real: 20 });
    }, 30_000);

    it("does not open on fast approvals, and they are not evidence", async () => {
      await realApprovals(25, 500);
      expect(report().proposals).toEqual([]);
      const replay = (await h.core.autonomyReplay({ agent: "refunds-agent", class: "refund", bucket: "small" }))[0];
      expect(replay).toMatchObject({ requests: 25, counted: 0, fast_excluded: 25, meets_criteria: false });
    }, 30_000);

    it("does not count what is too old", async () => {
      await realApprovals(20, MINUTE);
      const first = report().proposals[0];
      expect(first).toBeDefined();
      h.clock.advance(8 * DAY);
      expect(await h.core.autonomyReplay({ agent: "refunds-agent", class: "refund", bucket: "small" })).toEqual([]);
    }, 30_000);

    it("L2 earns L3 from reviews people kept, and not from what merely ran", async () => {
      setLevel("L2");
      h.clock.advance(MINUTE);
      const world = h.lookup.world as Record<string, Record<string, Record<string, unknown>>>;
      const run = async (index: number) => {
        const customer = `cus_real_${index}`;
        const destination = `upi${index}@okaxis`;
        (world.customers as Record<string, Record<string, unknown>>)[customer] = { id: customer, name: "Someone" };
        (world.destinations as Record<string, Record<string, unknown>>)[destination] = { id: destination, age_hours: 720 };
        const response = await smallRefund({ ...SMALL, customer_id: customer, destination });
        h.clock.advance(MINUTE);
        return response.request_id as string;
      };
      for (let index = 0; index < 25; index += 1) await run(index);
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      expect(report().proposals).toEqual([]);
      for (let index = 25; index < 50; index += 1) {
        const id = await run(index);
        const row = h.core.stores.routes.openForRequest(id)[0];
        const card = h.chat.cards.find((candidate) => candidate.switchRequestId === row?.switch_request_id) as OpenedCard;
        await press(card, row?.user_id === "sam" ? PARTICIPANTS.sam : PARTICIPANTS.neha, "keep");
        h.clock.advance(MINUTE);
      }
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      expect(report().proposals[0]).toMatchObject({ level: "L3", from: "L2" });
    }, 30_000);

    it("starts counting again after a demotion", async () => {
      await realApprovals(20, MINUTE);
      setLevel("L2");
      const refund = await smallRefund();
      await say(PARTICIPANTS.sam, `@clearance incident ${refund.request_id} wrong customer`);
      h.clock.advance(MINUTE);
      const replay = (await h.core.autonomyReplay({ agent: "refunds-agent", class: "refund", bucket: "small" }))[0];
      expect(replay).toMatchObject({ requests: 0, meets_criteria: false });
    }, 30_000);
  });

  describe("L2: executes, then a review card", () => {
    beforeEach(() => setLevel("L2"));

    it("allows it, with an id to refer to, and core does not run it: the gate does on allow", async () => {
      const response = await smallRefund();
      expect(response).toMatchObject({ decision: "allow", tier: "low" });
      expect(response.request_id).toMatch(/^CLR-\d{4}$/);
      expect(h.gate.calls).toEqual([]);
      const request = h.core.stores.requests.require(response.request_id as string);
      expect(request.state).toBe("AUTO");
      const entries = h.core.stores.ledger.list({ requestId: request.id });
      expect(entries.map((entry) => entry.type)).not.toContain("held");
      expect(entries[0]?.type).toBe("approved");
      expect(entries[0]?.payload).toMatchObject({ approved_by: ["autonomy:L2"], level: "L2", bucket: "small", call_hash: request.callHash });
    });

    it("sends a review card to the class's approver, never the requester", async () => {
      const response = await smallRefund();
      const card = lastCard("dm-sam");
      expect(card.title).toContain(response.request_id as string);
      expect(card.title).toContain("REVIEW");
      expect(card.detail).toContain("refunds-agent ran this on its own at L2");
      expect(card.detail).toContain("Refund ₹2,000");
      expect(card.options.map((option) => [option.id, option.decision])).toEqual([
        ["keep", "accept"],
        ["demote", "decline"],
        ["reverse", "cancel"],
      ]);
      expect(h.chat.cards.filter((candidate) => candidate.roomId === "dm-priya")).toEqual([]);
      expect(h.chat.targeted.at(-1)?.targets).toEqual(["sam"]);
    });

    it("keep: stays at L2, and the review is a person's evidence", async () => {
      const response = await smallRefund();
      h.clock.advance(MINUTE);
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "keep");
      expect(level()).toBe("L2");
      const [row] = new BucketEventStore(h.core.stores.db).forClass("refund", "refunds-agent", 0);
      expect(row).toMatchObject({ outcome: "approved", approvers: ["sam"], fast: false, requestId: response.request_id });
      const answered = h.core.stores.ledger.list({ requestId: response.request_id as string }).find((entry) => entry.type === "answered");
      expect(answered?.payload).toMatchObject({ review: "keep", user_id: "sam" });
    });

    it("demote: back to L0 straight away, and the next one is held", async () => {
      const response = await smallRefund();
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "demote");
      expect(level()).toBe("L0");
      expect(posted().at(-1)).toBe(`refunds-agent is back to 'always ask' for refunds up to ₹5,000 because Sam demoted it on review of ${response.request_id}.`);
      expect(ledger("demoted")[0]?.payload).toMatchObject({ reason: "review", from: "L2", to: "L0", by: "sam" });
      expect((await smallRefund()).decision).toBe("hold");
    });

    it("reverse: demotes, records an incident, and says plainly that a person has to undo it", async () => {
      const response = await smallRefund();
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "reverse");
      expect(level()).toBe("L0");
      expect(h.core.stores.incidents.all()).toEqual([expect.objectContaining({ request_id: response.request_id, reported_by: "sam" })]);
      expect(posted().join("\n")).toContain("has no automatic undo");
      expect(ledger("demoted")[0]?.payload).toMatchObject({ reason: "reversed" });
    });

    it("the requester can't use the review to keep their own refund, and the card goes back to someone who can", async () => {
      await smallRefund();
      const before = h.chat.cards.filter((card) => card.roomId === "dm-sam").length;
      await press(lastCard("dm-sam"), PARTICIPANTS.priya, "keep");
      expect(ledger("ineligible_answer").at(-1)?.payload).toMatchObject({ user_id: "priya" });
      expect(h.chat.cards.filter((card) => card.roomId === "dm-sam").length).toBe(before + 1);
      const [row] = new BucketEventStore(h.core.stores.db).forClass("refund", "refunds-agent", 0);
      expect(row?.outcome).toBe("auto");
    });

    it("closes after 24 h, and a late answer changes nothing", async () => {
      await smallRefund();
      const card = lastCard("dm-sam");
      h.clock.advance(DAY + MINUTE);
      await h.core.tick();
      expect(card.closed).toBe(true);
      await press(card, PARTICIPANTS.sam, "demote");
      expect(level()).toBe("L2");
      expect(ledger("ineligible_answer").at(-1)?.payload).toMatchObject({ reasons: ["review_closed"] });
    });

    it("a retry of the same action runs once and is reviewed once", async () => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
      const action = gateRefund(SMALL);
      const first = await h.core.check(action);
      const again = await h.core.check(action);
      expect(again).toMatchObject({ decision: "allow", request_id: first.request_id });
      expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);
      expect(new BucketEventStore(h.core.stores.db).forClass("refund", "refunds-agent", 0)).toHaveLength(1);
    });

    it("opens the review when Switch comes back, if it was down when the call ran", async () => {
      h.chat.failOpenCard = true;
      const response = await smallRefund();
      expect(response.decision).toBe("allow");
      expect(h.chat.cards).toEqual([]);
      h.chat.failOpenCard = false;
      await h.core.tick();
      await h.core.tick();
      expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);
    });

    it("a forced hold still holds: the 24 h rule is not skipped", async () => {
      const held = await smallRefund({ ...SMALL, amount: 4000 });
      expect(held.decision).toBe("allow");
      const second = await smallRefund({ ...SMALL, amount: 4000, order_id: "A-2004" });
      expect(second.decision).toBe("allow");
      const third = await smallRefund({ ...SMALL, amount: 4000, order_id: "A-1931" });
      expect(third.decision).toBe("hold");
    });

    it("the critical tier never runs on its own", async () => {
      h.core.stores.autonomy.setLevel("refunds-agent", "refund", "default", "L3", h.clock.nowMs());
      const response = await h.core.check(gateRefund({ ...REFUND_SC4, amount: 150000 }));
      expect(response.decision).toBe("hold");
    });
  });

  describe("L3: silent up to a daily cap", () => {
    beforeEach(() => setLevel("L3"));

    const another = (index: number, amount = 4000) => ({ ...SMALL, amount, customer_id: `cus_l3_${index}`, destination: `upi${index}@okaxis` });

    function knownCustomers(count: number): void {
      const world = h.lookup.world as Record<string, Record<string, Record<string, unknown>>>;
      for (let index = 0; index < count; index += 1) {
        (world.customers as Record<string, Record<string, unknown>>)[`cus_l3_${index}`] = { id: `cus_l3_${index}`, name: "Someone" };
        (world.destinations as Record<string, Record<string, unknown>>)[`upi${index}@okaxis`] = { id: `upi${index}@okaxis`, age_hours: 720 };
      }
    }

    it("runs with no card at all, and the ledger says so", async () => {
      const response = await smallRefund();
      expect(response.decision).toBe("allow");
      expect(h.chat.cards).toEqual([]);
      expect(h.core.stores.ledger.list({ requestId: response.request_id as string })[0]?.payload).toMatchObject({ approved_by: ["autonomy:L3"] });
    });

    it("holds past the cap, says why, and stays at L3", async () => {
      knownCustomers(8);
      const decisions: string[] = [];
      let last = await smallRefund(another(0));
      decisions.push(last.decision);
      for (let index = 1; index < 7; index += 1) {
        last = await smallRefund(another(index));
        decisions.push(last.decision);
      }
      // The policy's cap is ₹25,000 a day: six of ₹4,000 fit and the seventh doesn't.
      expect(decisions).toEqual(["allow", "allow", "allow", "allow", "allow", "allow", "hold"]);
      expect(last.flags?.map((flag) => flag.code)).toContain("over_daily_cap");
      expect(level()).toBe("L3");
    });

    it("gets its budget back a day later", async () => {
      knownCustomers(8);
      for (let index = 0; index < 6; index += 1) await smallRefund(another(index));
      h.clock.advance(DAY + MINUTE);
      expect((await smallRefund(another(6))).decision).toBe("allow");
    });

    it("with no cap in the policy, can't run silently: it asks for a review, as L2 does", async () => {
      const dir = mkdtempSync(join(tmpdir(), "clearance-policy-"));
      try {
        const path = join(dir, "policy.yaml");
        const text = readFileSync(POLICY_PATH, "utf8").replace(/, daily_cap: \d+/, "");
        expect(text).not.toContain("daily_cap: 25000");
        writeFileSync(path, text);
        const other = makeHarness({ policyPath: path });
        try {
          other.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", other.clock.nowMs());
          await other.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
          const response = await other.core.check(gateRefund(SMALL));
          expect(response.decision).toBe("allow");
          expect(other.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);
        } finally {
          other.core.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("demotion", () => {
    it("on an incident: instant, in the Appendix's words, and the next refund is held", async () => {
      setLevel("L2");
      const refund = await smallRefund();
      await say(PARTICIPANTS.sam, `@clearance incident ${refund.request_id} customer disputes this refund`);
      expect(level()).toBe("L0");
      expect(posted().at(-1)).toBe(`refunds-agent is back to 'always ask' for refunds up to ₹5,000 because of incident ${refund.request_id} reported by Sam.`);
      expect(h.core.stores.incidents.all()[0]).toMatchObject({ reported_by: "sam", note: "customer disputes this refund" });
      expect(ledger("incident")[0]?.payload).toMatchObject({ reported_by: "sam", note: "customer disputes this refund" });
      expect(ledger("demoted")[0]?.payload).toMatchObject({ reason: "incident", from: "L2", to: "L0", by: "sam" });
      expect((await smallRefund()).decision).toBe("hold");
    });

    it("takes the reporter from the sender, whatever the text says", async () => {
      setLevel("L2");
      const refund = await smallRefund();
      await say(PARTICIPANTS.neha, `@clearance incident ${refund.request_id} reported by Sam`);
      expect(h.core.stores.incidents.all()[0]).toMatchObject({ reported_by: "neha" });
    });

    it("an agent can't report one, and can't demote or promote anything", async () => {
      setLevel("L2");
      const refund = await smallRefund();
      await say(PARTICIPANTS.refundsAgent, `@clearance incident ${refund.request_id} nothing to see`);
      expect(h.core.stores.incidents.all()).toEqual([]);
      expect(level()).toBe("L2");
    });

    it("an incident with no ladder to fall from is still recorded, and nothing else is claimed", async () => {
      const held = await smallRefund();
      await say(PARTICIPANTS.sam, `@clearance incident ${held.request_id} looks wrong`);
      expect(h.core.stores.incidents.all()).toHaveLength(1);
      expect(ledger("demoted")).toEqual([]);
      expect(posted().at(-1)).toContain(`Incident recorded on ${held.request_id}.`);
    });

    it("says so when it can't find the request", async () => {
      await say(PARTICIPANTS.sam, "@clearance incident CLR-9999 what");
      expect(posted().at(-1)).toContain("I can't find CLR-9999");
    });

    it("needs a note", async () => {
      setLevel("L2");
      const refund = await smallRefund();
      await say(PARTICIPANTS.sam, `@clearance incident ${refund.request_id}`);
      expect(posted().at(-1)).toContain("what went wrong");
      expect(level()).toBe("L2");
    });

    it("on a denial inside the bucket", async () => {
      setLevel("L1");
      const held = await smallRefund();
      expect(held.decision).toBe("hold");
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
      expect(level()).toBe("L0");
      expect(posted().at(-1)).toBe(`refunds-agent is back to 'always ask' for refunds up to ₹5,000 because Sam denied ${held.request_id}.`);
      expect(ledger("demoted")[0]?.payload).toMatchObject({ reason: "denial", from: "L1", by: "sam" });
    });

    it("not on a denial outside the bucket", async () => {
      setLevel("L2");
      await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
      await h.core.check(gateRefund(REFUND_SC4));
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
      expect(level()).toBe("L2");
    });

  });

  describe("an amount above the bucket's normal range", () => {
    const ceiling = () =>
      percentile95(
        generateSyntheticHistory(HISTORY_SEED, h.clock.nowMs())
          .filter((row) => row.cls === "refund" && row.bucket === "small")
          .map((row) => Number(row.fields.amount)),
      ) as number;
    const above = () => ({ ...SMALL, amount: ceiling() + 50 });

    beforeEach(() => {
      seed();
      setLevel("L2");
    });

    it("holds that one call for a person, with a flag on the card, and does not demote", async () => {
      const held = await smallRefund(above());
      expect(held.decision).toBe("hold");
      expect(held.flags?.map((flag) => flag.code)).toContain("above_normal_range");
      expect(lastCard("dm-sam").detail).toContain("above this agent's normal range for this bucket");
      expect(level()).toBe("L2");
      expect(ledger("demoted")).toEqual([]);
      expect(h.gate.calls).toEqual([]);
    });

    it("approved: it runs, the level stays, and the next normal one runs alone", async () => {
      const held = await smallRefund(above());
      h.clock.advance(MINUTE);
      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(h.gate.calls).toEqual([expect.objectContaining({ requestId: held.request_id })]);
      expect(level()).toBe("L2");
      expect(ledger("demoted")).toEqual([]);
      expect((await smallRefund({ ...SMALL, amount: 1000, order_id: "A-2004" })).decision).toBe("allow");
    });

    it("denied: the denial rule demotes at once", async () => {
      const held = await smallRefund(above());
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
      expect(level()).toBe("L0");
      expect(ledger("demoted")[0]?.payload).toMatchObject({ reason: "denial", from: "L2", by: "sam" });
      expect(posted().at(-1)).toContain(`because Sam denied ${held.request_id}`);
      expect((await smallRefund({ ...SMALL, amount: 1000, order_id: "A-2004" })).decision).toBe("hold");
    });

    it("an incident still demotes at once", async () => {
      const ran = await smallRefund({ ...SMALL, amount: 1000 });
      await say(PARTICIPANTS.sam, `@clearance incident ${ran.request_id} wrong customer`);
      expect(level()).toBe("L0");
    });

    it("missing data still blocks autonomy, and that doesn't demote either", async () => {
      const held = await smallRefund({ ...SMALL, amount: 1000, order_id: "A-NOBODY-KNOWS" });
      expect(held.decision).toBe("hold");
      expect(held.flags?.map((flag) => flag.code)).toContain("missing_data");
      expect(level()).toBe("L2");
    });

    it("at exactly the 95th percentile runs alone", async () => {
      expect((await smallRefund({ ...SMALL, amount: ceiling() })).decision).toBe("allow");
      expect(level()).toBe("L2");
    });

    it("loses L1's fast lane for that call, and only that call", async () => {
      setLevel("L1");
      const held = await smallRefund(above());
      expect(held.flags?.map((flag) => flag.code)).toContain("above_normal_range");
      expect(level()).toBe("L1");
      expect((h.core.stores.requests.require(held.request_id as string).evidence as { level?: string }).level).toBe("L0");
    });
  });

  it("with too little history to know what's normal, a large small refund runs alone", async () => {
    setLevel("L2");
    expect((await smallRefund({ ...SMALL, amount: 4900 })).decision).toBe("allow");
    expect(level()).toBe("L2");
  });

  describe("what can never run on its own", () => {
    it("a class whose cap is L0 stays held whatever the table says", async () => {
      h.core.stores.autonomy.setLevel("ops-agent", "delete", "default", "L3", h.clock.nowMs());
      const response = await h.core.check({
        ...gateRefund(),
        agent: { name: "ops-agent" },
        business: { endpoint: "DELETE /acme/records/orders/1", args: { table: "orders", id: "1" } },
      });
      expect(response.decision).toBe("hold");
    });
  });

  describe("@clearance autonomy", () => {
    it("reports the ladder and where a proposal stands", async () => {
      seed();
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      const reply = posted().at(-1) as string;
      expect(reply).toContain("refunds-agent: refunds up to ₹5,000 at L0.");
      expect(reply).toMatch(/PROP-\d{4} is open, 0 of 2 signed/);
    });

    it("says how far off a bucket is", async () => {
      const store = new BucketEventStore(h.core.stores.db);
      for (const row of many(12)) store.add(row);
      await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
      expect(posted().at(-1)).toContain("12 of 20 approvals, 2 of 2 people, 0 denied, 0 incidents");
    });

    it("says when there is nothing to report", async () => {
      await say(PARTICIPANTS.sam, "@clearance autonomy coder");
      expect(posted().at(-1)).toContain("coder has no autonomy history yet");
    });
  });

  it("SC11: promoted by two people, runs alone, demoted by one incident, held again", async () => {
    seed();
    await say(PARTICIPANTS.sam, "@clearance autonomy refunds-agent");
    const samProposal = lastCard("dm-sam");
    const alexProposal = lastCard("dm-alex");
    expect(samProposal.detail).toMatch(/Proposal/);
    expect(samProposal.detail).toMatch(/Replay/i);
    expect(alexProposal.detail).toMatch(/Proposal/);
    await press(samProposal, PARTICIPANTS.sam);
    await press(alexProposal, PARTICIPANTS.alex);
    expect(ledger("promotion_signed")).toHaveLength(1);

    const refund = await smallRefund();
    expect(refund.decision).toBe("allow");
    const review = lastCard("dm-sam");
    expect(review.title).toMatch(/CLR-\d+/);
    expect(`${review.title}\n${review.detail}`).toMatch(/review/i);
    const clr = /CLR-\d+/.exec(review.title)?.[0] as string;

    await say(PARTICIPANTS.sam, `@clearance incident ${clr} customer disputes this refund`);
    const demotion = posted().at(-1) as string;
    expect(demotion).toMatch(/back to .always ask./i);
    expect(demotion).toContain("refunds-agent");

    const again = await smallRefund();
    expect(again.decision).toBe("hold");
    expect(h.gate.calls).toEqual([]);
    expect(h.core.verifyLedger().ok).toBe(true);
  });
});
