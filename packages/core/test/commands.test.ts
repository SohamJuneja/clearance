/** 6.8: chat commands. Parsed only from messages addressing Clearance; identity is the sender, never the text. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommand, parseAway } from "../src/commands/parse.js";
import { chatMessage, gateRefund, hookShell, makeHarness, MINUTE, NOW, PARTICIPANTS, REFUND_SC4, type Harness } from "./harness.js";

describe("what counts as a command", () => {
  const event = (body: string, addressed = true, channelType: string | null = "channel") => ({ body, addressed, channelType });

  it("is a message addressing Clearance that starts with the mention", () => {
    expect(parseCommand(event("@clearance why CLR-0001"))).toEqual({ verb: "why", args: "CLR-0001", words: ["CLR-0001"] });
  });

  it("ignores case and a trailing colon, and keeps the rest of the words", () => {
    expect(parseCommand(event("@Clearance: INCIDENT CLR-0001 customer disputes it"))).toEqual({
      verb: "incident",
      args: "CLR-0001 customer disputes it",
      words: ["CLR-0001", "customer", "disputes", "it"],
    });
  });

  it("reads a mention Switch has escaped with a zero-width space", () => {
    expect(parseCommand(event("@​clearance status CLR-0001"))?.verb).toBe("status");
  });

  it("is not a message that merely mentions Clearance halfway", () => {
    expect(parseCommand(event("hey @clearance why CLR-0001"))).toBeNull();
    expect(parseCommand(event("I asked @clearance incident CLR-0001 yesterday"))).toBeNull();
  });

  it("is not a message that doesn't address Clearance, whatever it says", () => {
    expect(parseCommand(event("@clearance why CLR-0001", false))).toBeNull();
  });

  it("is not a bare word in a room, but is one in a direct room", () => {
    expect(parseCommand(event("why CLR-0001"))).toBeNull();
    expect(parseCommand(event("why CLR-0001", true, "direct"))?.verb).toBe("why");
    expect(parseCommand(event("why CLR-0001", false, "direct"))).toBeNull();
  });

  it("is not an empty mention", () => {
    expect(parseCommand(event("@clearance"))).toBeNull();
  });
});

describe("reading an away", () => {
  const TZ = "Asia/Kolkata";
  it("is the next time that clock comes round, today if it's still ahead", () => {
    expect(parseAway("until 18:00", NOW, TZ)).toEqual({ untilMs: NOW + 4 * 60 * MINUTE, delegate: null });
  });

  it("is tomorrow if it has passed", () => {
    expect(parseAway("until 09:30", NOW, TZ)).toEqual({ untilMs: NOW + (24 * 60 - 4 * 60 - 30) * MINUTE, delegate: null });
  });

  it("reads the delegate with or without the @", () => {
    expect(parseAway("until 18:00 delegate @neha", NOW, TZ)?.delegate).toBe("neha");
    expect(parseAway("until 18:00 delegate Neha", NOW, TZ)?.delegate).toBe("Neha");
  });

  it.each(["", "tomorrow", "until", "until 25:00", "until 18:99", "until 18:00 delegate", "until 18:00 maybe @neha"])("refuses %j", (text) => {
    expect(parseAway(text, NOW, TZ)).toBeNull();
  });
});

describe("in core", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.core.close());

  const say = (who: string, body: string, overrides: Record<string, unknown> = {}) =>
    h.core.onMessage(chatMessage(who, body, { roomId: "#approvals", threadId: null, addressed: true, ...overrides }));
  const lastPost = () => h.chat.messages.at(-1)?.body as string;
  const counts = () => ["requests", "grants", "routes", "aggregates", "actions"].map((table) => (h.core.stores.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

  describe("@clearance policy", () => {
    it("says what's in force, and what it takes to change it", async () => {
      await say(PARTICIPANTS.priya, "@clearance policy");
      expect(lastPost()).toContain(h.core.policy().hash.slice(0, 12));
      expect(lastPost()).toContain("enforce");
      expect(lastPost()).toContain("refund");
      expect(lastPost()).toContain("2 policy owners");
    });
  });

  describe("@clearance policy test", () => {
    it("classifies a gate call and changes nothing", async () => {
      const before = counts();
      const ledger = h.core.stores.ledger.list().length;
      await say(PARTICIPANTS.priya, "@clearance policy test POST /acme/refunds order_id=A-2004 customer_id=cus_2044 amount=40000 destination=rohan.s@okhdfc");
      expect(lastPost()).toContain("would be held");
      expect(lastPost()).toContain("refund");
      expect(lastPost()).toContain("high");
      expect(lastPost()).toContain("refunds over ₹10,000 need finance approval");
      expect(counts()).toEqual(before);
      expect(h.core.stores.ledger.list()).toHaveLength(ledger);
      expect(h.chat.cards).toEqual([]);
    });

    it("classifies a shell line", async () => {
      await say(PARTICIPANTS.alex, "@clearance policy test git push --force origin main");
      expect(lastPost()).toContain("would be held");
      expect(lastPost()).toContain("merge");
    });

    it("says allowed for safe work, and denied for what is never allowed", async () => {
      await say(PARTICIPANTS.alex, "@clearance policy test ls -la");
      expect(lastPost()).toContain("would be allowed");
      await say(PARTICIPANTS.alex, "@clearance policy test cat .env");
      expect(lastPost()).toContain("would be denied");
    });

    it("asks for something to test", async () => {
      await say(PARTICIPANTS.alex, "@clearance policy test");
      expect(lastPost()).toContain("policy test");
    });

    it("never spends a grant", async () => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@coder force push it"));
      const held = await h.core.check(hookShell("git push --force origin main"));
      const card = h.chat.cards.find((candidate) => candidate.roomId === "dm-dev");
      await h.core.onApprovalOutcome({
        sessionId: card?.sessionId as string,
        switchRequestId: card?.switchRequestId as string,
        kind: "approval",
        state: "answered",
        answer: "allow",
        answeredBy: PARTICIPANTS.dev,
        answeredAtMs: h.clock.nowMs(),
      });
      expect(h.core.stores.grants.has(held.call_hash as string, "coder")).toBe(true);
      await say(PARTICIPANTS.alex, "@clearance policy test git push --force origin main");
      expect(h.core.stores.grants.has(held.call_hash as string, "coder")).toBe(true);
    });
  });

  describe("@clearance away and back", () => {
    it("takes a person out of routing until then, and brings in the delegate", async () => {
      await say(PARTICIPANTS.sam, "@clearance away until 18:00 delegate @neha");
      expect(h.core.people.store.away("sam")).toEqual({ untilMs: NOW + 4 * 60 * MINUTE, delegateTo: "neha" });
      expect(lastPost()).toBe("Sam is away until 18:00 IST. Neha has Sam's approvals until then.");
      await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
      const held = await h.core.check(gateRefund(REFUND_SC4));
      expect(h.core.traces.latest(held.request_id as string)?.chosen).toEqual(["neha"]);
    });

    it("works without a delegate", async () => {
      await say(PARTICIPANTS.sam, "@clearance away until 18:00");
      expect(h.core.people.store.away("sam")).toEqual({ untilMs: NOW + 4 * 60 * MINUTE, delegateTo: null });
      expect(lastPost()).toBe("Sam is away until 18:00 IST.");
    });

    it("sends on what the person was already holding", async () => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
      await h.core.check(gateRefund(REFUND_SC4));
      expect(h.chat.cards.filter((card) => card.roomId === "dm-neha")).toEqual([]);
      await say(PARTICIPANTS.sam, "@clearance away until 18:00");
      expect(h.chat.cards.filter((card) => card.roomId === "dm-neha")).toHaveLength(1);
    });

    it("refuses to delegate to yourself", async () => {
      await say(PARTICIPANTS.sam, "@clearance away until 18:00 delegate @sam");
      expect(h.core.people.store.away("sam")).toBeNull();
      expect(lastPost()).toContain("can't delegate to yourself");
    });

    it("refuses a delegate it doesn't know", async () => {
      await say(PARTICIPANTS.sam, "@clearance away until 18:00 delegate @nobody");
      expect(h.core.people.store.away("sam")).toBeNull();
      expect(lastPost()).toContain("nobody");
    });

    it("refuses an agent as delegate", async () => {
      await say(PARTICIPANTS.sam, "@clearance away until 18:00 delegate @refunds-agent");
      expect(h.core.people.store.away("sam")).toBeNull();
    });

    it("explains itself when it can't read the time", async () => {
      await say(PARTICIPANTS.sam, "@clearance away tomorrow");
      expect(h.core.people.store.away("sam")).toBeNull();
      expect(lastPost()).toContain("away until 18:00");
    });

    it("takes the person from the sender: nobody can send someone else away", async () => {
      await say(PARTICIPANTS.priya, "@clearance away until 18:00 for Sam");
      expect(h.core.people.store.away("sam")).toBeNull();
    });

    it("ignores an agent", async () => {
      await say(PARTICIPANTS.refundsAgent, "@clearance away until 18:00 delegate @neha");
      expect(h.core.people.store.away("sam")).toBeNull();
      expect(h.chat.messages).toEqual([]);
    });

    it("back ends it", async () => {
      await say(PARTICIPANTS.sam, "@clearance away until 18:00 delegate @neha");
      await say(PARTICIPANTS.sam, "@clearance back");
      expect(h.core.people.store.away("sam")).toBeNull();
      expect(lastPost()).toBe("Sam is back.");
      await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
      const held = await h.core.check(gateRefund(REFUND_SC4));
      expect(h.core.traces.latest(held.request_id as string)?.chosen).toEqual(["sam"]);
    });
  });

  describe("@clearance drills", () => {
    it("turns drills off and on, for a team admin", async () => {
      await say(PARTICIPANTS.alex, "@clearance drills off");
      expect(lastPost()).toContain("off");
      expect(await h.core.sendDrill("sam")).toMatchObject({ ok: false });
      await say(PARTICIPANTS.alex, "@clearance drills on");
      expect(await h.core.sendDrill("sam")).toMatchObject({ ok: true });
    });

    it("refuses anyone else", async () => {
      await say(PARTICIPANTS.sam, "@clearance drills off");
      expect(lastPost()).toContain("team admin");
      expect(await h.core.sendDrill("sam")).toMatchObject({ ok: true });
    });

    it("ignores an agent", async () => {
      await say(PARTICIPANTS.refundsAgent, "@clearance drills off");
      expect(h.chat.messages).toEqual([]);
      expect(await h.core.sendDrill("sam")).toMatchObject({ ok: true });
    });

    it("explains itself on anything but on or off", async () => {
      await say(PARTICIPANTS.alex, "@clearance drills maybe");
      expect(lastPost()).toContain("drills on");
    });
  });

  describe("commands only from messages addressing Clearance", () => {
    it("does nothing with an incident mentioned in passing", async () => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
      const held = await h.core.check(gateRefund(REFUND_SC4));
      await say(PARTICIPANTS.sam, `yesterday I ran @clearance incident ${held.request_id} something`);
      await say(PARTICIPANTS.sam, `@clearance incident ${held.request_id} something`, { addressed: false });
      expect(h.core.stores.incidents.all()).toEqual([]);
    });

    it("answers in the thread it was asked in", async () => {
      await say(PARTICIPANTS.sam, "@clearance policy", { roomId: "#support", threadId: "t-9" });
      expect(h.chat.messages.at(-1)).toMatchObject({ roomId: "#support", threadId: "t-9" });
    });

    it("stays quiet on a verb it doesn't know", async () => {
      await say(PARTICIPANTS.sam, "@clearance frobnicate");
      expect(h.chat.messages).toEqual([]);
    });

    it("works in a direct room with no mention", async () => {
      const held = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
      await say(PARTICIPANTS.sam, `status ${held}`, { roomId: "dm-sam", channelType: "direct" });
      expect(h.chat.messages.at(-1)?.body).toContain(held);
    });
  });
});
