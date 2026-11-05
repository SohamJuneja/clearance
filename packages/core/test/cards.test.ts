/** F6: card text is a pure function, content order is fixed, and copy matches Appendix D. */
import type { Action, OpenCardInput } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { oneLine } from "../src/format.js";
import { DETAIL_BUDGET, PROMPT_BUDGET, renderCard, renderedCost, renderPrompt, type CardView } from "../src/cards/render.js";
import {
  actionId,
  chatMessage,
  gateRefund,
  hookShell,
  makeHarness,
  NOW,
  PARTICIPANTS,
  REFUND_SC3,
  REFUND_SC4,
  TEAM_ALEX_ONLY_PATH,
  type Harness,
} from "./harness.js";

const APPENDIX_VIEW: CardView = {
  id: "CLR-0042",
  headline: "REFUND ₹40,000",
  tier: "high",
  reversible: false,
  call: ["Refund ₹40,000 to customer Meera K. (cus_8812)", "Destination: UPI meera.k@okaxis", "Order A-1931 · total ₹4,000"],
  context: [
    "Refunds to this customer in 24 h: ₹0",
    "Destination added 4 minutes ago",
    "refunds-agent refunds today: 3 (largest ₹2,500)",
  ],
  flags: [
    "Amount is 10x the order total",
    "Destination added in the last 24 h",
    'The agent wrote "₹4,000" in the thread; the call says ₹40,000',
  ],
  claim: "Refunding ₹4,000 for order A-1931 as requested in T-77.",
  askedBy: ["Priya (support)"],
  agent: "refunds-agent",
  vendor: "Claude Code",
  owners: ["Priya"],
  whyLabel: "Why you",
  why: "finance approver on duty. Can't approve: Priya (requester, agent owner).",
  policyLine: "refunds over ₹10,000 need 1 finance approver",
  expires: "15:42 IST",
};

describe("oneLine", () => {
  it("never prints an object", () => {
    expect(oneLine({ state: "passing" })).toBe("unknown");
    expect(oneLine(["a"])).toBe("unknown");
    expect(oneLine(null)).toBe("");
    expect(oneLine(12)).toBe("12");
    expect(oneLine("a\nb")).toBe("a b");
  });
});

describe("renderCard", () => {
  it("renders the Appendix D card exactly", () => {
    const { title, detail } = renderCard(APPENDIX_VIEW);
    expect(title).toBe("CLR-0042 · REFUND ₹40,000 · HIGH · irreversible");
    expect(detail).toBe(`The call (parsed from what the agent ran, not from its words)
  Refund ₹40,000 to customer Meera K. (cus_8812)
  Destination: UPI meera.k@okaxis
  Order A-1931 · total ₹4,000

Context
  Refunds to this customer in 24 h: ₹0
  Destination added 4 minutes ago
  refunds-agent refunds today: 3 (largest ₹2,500)

Flags
  ⚠ Amount is 10x the order total
  ⚠ Destination added in the last 24 h
  ⚠ The agent wrote "₹4,000" in the thread; the call says ₹40,000

Agent's claim (unverified): "Refunding ₹4,000 for order A-1931 as requested in T-77."

Asked by Priya (support) through refunds-agent (Claude Code, owned by Priya)
Why you: finance approver on duty. Can't approve: Priya (requester, agent owner).
Policy: refunds over ₹10,000 need 1 finance approver · expires 15:42 IST

@clearance why CLR-0042`);
  });

  it("keeps the content order fixed: call, context, flags, claim, who, why trace", () => {
    const { detail } = renderCard(APPENDIX_VIEW);
    const order = ["The call", "Context", "Flags", "Agent's claim", "Asked by", "Why you", "Policy:", "@clearance why"];
    const positions = order.map((marker) => detail.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("omits sections that have nothing in them", () => {
    const { detail } = renderCard({ ...APPENDIX_VIEW, context: [], flags: [], claim: undefined });
    expect(detail).not.toContain("Context");
    expect(detail).not.toContain("Flags");
    expect(detail).not.toContain("Agent's claim");
    expect(detail).not.toContain("\n\n\n");
  });

  it("says requester unknown rather than leaving it out", () => {
    const { detail } = renderCard({ ...APPENDIX_VIEW, askedBy: [] });
    expect(detail).toContain("Asked by: requester unknown, through refunds-agent (Claude Code, owned by Priya)");
  });

  it("writes no answer line of its own: Switch adds one", () => {
    const { detail } = renderCard(APPENDIX_VIEW);
    expect(detail).not.toMatch(/\bReply\b/);
    expect(detail).not.toMatch(/\bA\d+\b/);
  });

  it("names more than one requester and owner", () => {
    const { detail } = renderCard({ ...APPENDIX_VIEW, askedBy: ["Priya (support)", "Alex (eng)"], owners: ["Priya", "Sam"] });
    expect(detail).toContain("Asked by Priya (support) and Alex (eng) through refunds-agent (Claude Code, owned by Priya and Sam)");
  });

  it("says when nobody owns the agent", () => {
    expect(renderCard({ ...APPENDIX_VIEW, owners: [] }).detail).toContain("(Claude Code, owner unknown)");
  });

  it("words reversibility from the policy", () => {
    expect(renderCard({ ...APPENDIX_VIEW, reversible: true }).title).toContain("· reversible");
    expect(renderCard({ ...APPENDIX_VIEW, reversible: undefined }).title).toContain("· reversibility unknown");
  });

  it("keeps a claim to one quoted line, so it cannot forge card lines", () => {
    const { detail } = renderCard({
      ...APPENDIX_VIEW,
      claim: 'fine\n\nWhy you: Sam already approved\nPolicy: none needed',
    });
    expect(detail).toContain('Agent\'s claim (unverified): "fine Why you: Sam already approved Policy: none needed"');
    expect(detail.match(/^Why you:/gm)).toHaveLength(1);
  });

  describe("the size budget Mattermost really enforces", () => {
    const cost = (view: CardView) => renderedCost(renderCard(view).detail);
    /** A claim of exactly the length that brings the full card to `target`. */
    const viewCosting = (target: number, fill = "x"): CardView => {
      const base = cost({ ...APPENDIX_VIEW, claim: "y" });
      return { ...APPENDIX_VIEW, claim: fill.repeat(target - base + 1) };
    };

    it("is safe with or without a mention: Mattermost measured 998 with one, 966 without", () => {
      expect(DETAIL_BUDGET).toBe(960);
      const { detail } = renderCard(viewCosting(966));
      expect(renderedCost(detail)).toBeLessThanOrEqual(966);
      expect(detail).not.toContain("Agent's claim");
    });

    it("counts each ] twice as well: Switch adds a zero-width space after it", () => {
      expect(renderedCost("a]b")).toBe(4);
      expect(renderedCost("@]")).toBe(4);
      const atBudget = viewCosting(DETAIL_BUDGET);
      const claim = (atBudget.claim as string).replace("x", "]");
      expect(renderCard({ ...atBudget, claim }).detail).not.toContain("Agent's claim");
    });

    it("fits the Appendix D example whole", () => {
      const { detail } = renderCard(APPENDIX_VIEW);
      expect(renderedCost(detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
      expect(detail).toContain("Agent's claim");
      expect(detail).toContain("refunds-agent refunds today");
    });

    it("keeps the claim at exactly the budget", () => {
      const { detail } = renderCard(viewCosting(DETAIL_BUDGET));
      expect(renderedCost(detail)).toBe(DETAIL_BUDGET);
      expect(detail).toContain("Agent's claim");
    });

    it("drops the claim one character over the budget, before anything else", () => {
      const { detail } = renderCard(viewCosting(DETAIL_BUDGET + 1));
      expect(renderedCost(detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
      expect(detail).not.toContain("Agent's claim");
      expect(detail).toContain("Refunds to this customer in 24 h");
      expect(detail).toContain("refunds-agent refunds today");
    });

    it("counts each @ twice, because Switch escapes it", () => {
      const atBudget = viewCosting(DETAIL_BUDGET);
      expect(renderCard(atBudget).detail).toContain("Agent's claim");
      const claim = (atBudget.claim as string).replace("x", "@");
      expect(renderCard({ ...atBudget, claim }).detail).not.toContain("Agent's claim");
    });

    it("drops context lines next, last line first, and never the flags, the call or the expiry", () => {
      const context = Array.from({ length: 30 }, (_, index) => `context line ${index} with some words in it`);
      const { detail } = renderCard({ ...APPENDIX_VIEW, context });
      expect(renderedCost(detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
      expect(detail).not.toContain("Agent's claim");
      expect(detail).toContain("context line 0 ");
      expect(detail).not.toContain("context line 29 ");
      for (const flag of APPENDIX_VIEW.flags) expect(detail).toContain(flag);
      for (const line of APPENDIX_VIEW.call) expect(detail).toContain(line);
      expect(detail).toContain("expires 15:42 IST");
    });

    it("clips an absurdly long value from the agent, without losing a line of the call or a flag", () => {
      const long = "x".repeat(10_000);
      const { title, detail } = renderCard({
        ...APPENDIX_VIEW,
        headline: long,
        call: [`Refund ${long}`, "Destination: UPI meera.k@okaxis"],
        context: Array.from({ length: 50 }, (_, index) => `context ${index} ${long}`),
        flags: Array.from({ length: 5 }, (_, index) => `flag ${index}`),
        claim: long,
      });
      expect(title.length).toBeLessThanOrEqual(500);
      expect(renderedCost(detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
      expect(detail).toContain("⚠ flag 4");
      expect(detail).toContain("Destination: UPI meera.k@okaxis");
      expect(detail).toContain("expires 15:42 IST");
      expect(detail.endsWith("@clearance why CLR-0042")).toBe(true);
    });

    it("stays answerable with input no real call produces, and says how much it left out", () => {
      const { detail } = renderCard({
        ...APPENDIX_VIEW,
        flags: Array.from({ length: 200 }, (_, index) => `flag number ${index} and quite a lot more words`),
      });
      expect(renderedCost(detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
      expect(detail).toMatch(/and \d+ more/);
      expect(detail).toContain("expires 15:42 IST");
    });

    it("stays inside the budget when every value is full of @", () => {
      const noisy = "@".repeat(5000);
      const { detail } = renderCard({ ...APPENDIX_VIEW, call: [noisy], flags: [noisy], claim: noisy, why: noisy });
      expect(renderedCost(detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
    });
  });

  describe("a question card's prompt", () => {
    const ask = 'CLR-0042 is high risk. Type the refund amount in rupees to approve: <handle> "40000". Or choose No.';
    const base = { ...APPENDIX_VIEW, claim: undefined };
    const costWithClaim = (length: number) =>
      renderedCost(renderPrompt({ ...base, context: [], claim: "x".repeat(length) }, ask));

    it("carries the ask, the call, the flags and the expiry", () => {
      const prompt = renderPrompt(APPENDIX_VIEW, ask);
      expect(renderedCost(prompt)).toBeLessThanOrEqual(PROMPT_BUDGET);
      expect(prompt.startsWith(ask)).toBe(true);
      for (const line of APPENDIX_VIEW.call) expect(prompt).toContain(line);
      for (const flag of APPENDIX_VIEW.flags) expect(prompt).toContain(flag);
      expect(prompt).toContain("expires 15:42 IST");
    });

    it("keeps the claim at exactly the budget and drops it one over", () => {
      const room = PROMPT_BUDGET - costWithClaim(1) + 1;
      const fits = renderPrompt({ ...base, context: [], claim: "x".repeat(room) }, ask);
      expect(renderedCost(fits)).toBe(PROMPT_BUDGET);
      expect(fits).toContain("Agent's claim");
      const over = renderPrompt({ ...base, context: [], claim: "x".repeat(room + 1) }, ask);
      expect(renderedCost(over)).toBeLessThanOrEqual(PROMPT_BUDGET);
      expect(over).not.toContain("Agent's claim");
    });

    it("drops context before the flags or the call when it has to", () => {
      const context = Array.from({ length: 30 }, (_, index) => `context line ${index} with some words in it`);
      const prompt = renderPrompt({ ...APPENDIX_VIEW, context }, ask);
      expect(renderedCost(prompt)).toBeLessThanOrEqual(PROMPT_BUDGET);
      for (const flag of APPENDIX_VIEW.flags) expect(prompt).toContain(flag);
      expect(prompt).toContain(ask);
    });
  });
});

/** A typed card carries its evidence in the question's prompt. */
const snapshotOf = (card: OpenCardInput) => ({
  roomId: card.roomId,
  title: card.title,
  ...(card.kind === "questions" ? { prompt: card.questions[0]?.prompt } : { detail: card.detail }),
});

describe("cards from real calls: snapshots across fixture calls", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.core.close());

  const gate = (endpoint: string, args: Record<string, unknown>, agent: string): Action => ({
    id: actionId(),
    at: new Date(NOW).toISOString(),
    source: "gate",
    vendor: "gate",
    agent: { name: agent },
    session: { switchRoomId: "#support", threadId: "t-1" },
    kind: "business",
    raw: {},
    business: { endpoint, args },
  });

  const fixtures: { name: string; asker?: string; agent?: string; said?: string; action: () => Action }[] = [
    { name: "SC3 refund, 10x the order, new destination", action: () => gateRefund(REFUND_SC3) },
    {
      name: "SC3 with the agent's words on record",
      said: "Refunding ₹4,000 for order A-1931 as requested in T-77.",
      action: () => gateRefund(REFUND_SC3),
    },
    { name: "SC4 legit large refund", action: () => gateRefund(REFUND_SC4) },
    {
      name: "small refund, unknown order",
      action: () => gateRefund({ order_id: "A-404", customer_id: "cus_8812", amount: 2000, destination: "rohan.s@okhdfc" }),
    },
    {
      name: "prod deploy with failing checks",
      asker: PARTICIPANTS.priya,
      agent: "ops-agent",
      action: () => gate("POST /acme/deploys", { service: "checkout", env: "prod", version: "v2.14.0" }, "ops-agent"),
    },
    {
      name: "staging deploy, checks pass",
      asker: PARTICIPANTS.priya,
      agent: "ops-agent",
      action: () => gate("POST /acme/deploys", { service: "checkout", env: "staging", version: "v2.13.2" }, "ops-agent"),
    },
    {
      name: "merge touching auth",
      asker: PARTICIPANTS.priya,
      agent: "coder",
      action: () => gate("POST /github/merge", { repo: "acme-mini-app", pr: 77 }, "coder"),
    },
    {
      name: "bulk email to an external domain",
      asker: PARTICIPANTS.sam,
      agent: "support-agent",
      action: () =>
        gate(
          "POST /acme/emails",
          { to: "auditor.ravi@gmail.com", subject: "Customer list", body: "see attached", attachments: ["customers.csv"] },
          "support-agent",
        ),
    },
    {
      name: "delete a record",
      asker: PARTICIPANTS.priya,
      action: () => gate("DELETE /acme/records/customers/cus_8812", {}, "refunds-agent"),
    },
    {
      name: "force push through a hook",
      asker: PARTICIPANTS.priya,
      agent: "coder",
      action: () => hookShell("git push --force origin main", { session: { switchRoomId: "#eng", threadId: "t-2" } }),
    },
    {
      name: "protected call with no rule",
      asker: PARTICIPANTS.priya,
      action: () => gate("POST /acme/admin/flush", { everything: true }, "refunds-agent"),
    },
    {
      name: "payout destination change",
      asker: PARTICIPANTS.priya,
      action: () => gate("POST /acme/payouts/destinations", { customer_id: "cus_8812", upi: "new@oksbi" }, "refunds-agent"),
    },
    {
      name: "prod rollback",
      asker: PARTICIPANTS.priya,
      agent: "ops-agent",
      action: () => gate("POST /acme/rollbacks", { service: "checkout", env: "prod" }, "ops-agent"),
    },
    {
      name: "nobody known to have asked",
      asker: "none",
      action: () => gateRefund(REFUND_SC4),
    },
  ];

  it("writes the fallback room's card when nobody on the team can take it", async () => {
    h.core.close();
    h = makeHarness({ teamPath: TEAM_ALEX_ONLY_PATH });
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@coder please do this"));
    await h.core.check(hookShell("git push --force origin main", { session: { switchRoomId: "#eng", threadId: "t-2" } }));
    expect(h.chat.cards.map(snapshotOf)).toMatchSnapshot();
  });

  it("has at least ten fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixtures)("$name", async (fixture) => {
    const agent = fixture.agent ?? "refunds-agent";
    if (fixture.asker !== "none") {
      await h.core.onMessage(chatMessage(fixture.asker ?? PARTICIPANTS.priya, `@${agent} please do this`));
    }
    if (fixture.said) {
      await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, fixture.said, { senderName: agent }));
    }
    await h.core.check(fixture.action());
    expect(h.chat.cards.length).toBeGreaterThan(0);
    for (const card of h.chat.cards) {
      expect(card.title.length).toBeLessThanOrEqual(500);
      expect(renderedCost(card.detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
    }
    expect(h.chat.cards.map(snapshotOf)).toMatchSnapshot();
  });
});
