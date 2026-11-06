/**
 * F23: `@clearance roi`, the same report as a room document, and GET /v1/roi. Test data only. It reports and decides
 * nothing, it never estimates, and a room reading it learns nothing about any one person or about any open card.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { HISTORY_SEED, seedSyntheticHistory } from "../src/autonomy/history.js";
import { createLedgerMirror, drillTotals, ROI_DOCUMENT, type LedgerMirror } from "../src/ledger/mirror.js";
import { buildRoiReport, MIN_ACTIONS_FOR_RATE, MIN_DECISIONS_FOR_MEDIAN, MIN_PEOPLE_FOR_MEDIAN, RoiReportSchema } from "../src/reports/roi.js";
import { chatMessage, gateRefund, hookShell, makeHarness, MINUTE, NOW, PARTICIPANTS, POLICY_PATH, REFUND_SC3, REFUND_SC4, type Harness } from "./harness.js";

const DAY = 24 * 60 * MINUTE;
const SMALL = { order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "meera.k@oksbi" };
const POLICY = readFileSync(POLICY_PATH, "utf8");

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.core.close());

const report = () => h.core.roiReport();
const text = () => report().text;

let seeded = 0;

/** A request that went through and closed, the way the stores record one. Only what the report reads is filled in with care. */
function settled(
  to: "APPROVED" | "DENIED" | "EXPIRED" | "CANCELLED" | "EDITED",
  options: { cls?: string; amount?: unknown; evidence?: Record<string, unknown>; waitMs?: number; by?: string | null } = {},
): string {
  const { requests, answers } = h.core.stores;
  const { cls = "refund", waitMs = 60_000, by = to === "APPROVED" || to === "DENIED" || to === "EDITED" ? "sam" : null } = options;
  seeded += 1;
  const created = requests.create({
    actionId: `seeded-${seeded}`,
    source: "gate",
    vendor: "gate",
    agent: "refunds-agent",
    callHash: `seeded-hash-${seeded}`,
    cls,
    target: "POST /acme/refunds",
    call: { class: cls, target: "POST /acme/refunds", args: {} },
    tier: "high",
    score: 55,
    requesterIds: ["priya"],
    agentOwnerId: null,
    originRoom: null,
    originThread: null,
    evidence: { extracted: "amount" in options ? { amount: options.amount } : {}, ...options.evidence },
    flags: [],
    quorumRequired: 1,
    expiresAtMs: h.clock.nowMs() + 25 * MINUTE,
  });
  requests.transition(created.id, "ROUTED");
  h.clock.advance(waitMs);
  requests.transition(created.id, to);
  if (by !== null) {
    answers.record({ requestId: created.id, switchRequestId: `seeded-card-${seeded}`, answeredBy: `@${by}`, userId: by, decision: to === "DENIED" ? "deny" : "approve", latencyMs: waitMs, eligible: true, reason: null, atMs: h.clock.nowMs() });
  }
  return created.id;
}

/** A row in the actions table with exactly these values, for what the normal path can't be made to do. */
function actionRow(values: { step: string; decision: string; cls?: string | null; tier?: string | null; requestId?: string | null; would?: string | null }): void {
  seeded += 1;
  h.core.stores.db
    .prepare(`INSERT INTO actions (id, at, source, vendor, agent, kind, class, tier, decision, step, request_id, would_decide) VALUES (?, ?, 'gate', 'gate', 'refunds-agent', 'business', ?, ?, ?, ?, ?, ?)`)
    .run(`row-${seeded}`, new Date(h.clock.nowMs()).toISOString(), values.cls ?? null, values.tier ?? null, values.decision, values.step, values.requestId ?? null, values.would ?? null);
}

async function safeCalls(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) expect((await h.core.check(hookShell("ls"))).decision).toBe("allow");
}

const press = (card: { sessionId: string; switchRequestId: string }, who: string, answer: "allow" | "deny") =>
  h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer, answeredBy: who, answeredAtMs: h.clock.nowMs() });

const lastCard = (room: string) => {
  const card = h.chat.cards.filter((entry) => entry.roomId === room).at(-1);
  if (!card) throw new Error(`no card in ${room}`);
  return card;
};

/** Priya asks, the agent calls the gate, core holds it. */
async function holdRefund(args: Record<string, unknown> = REFUND_SC4): Promise<string> {
  await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
  const held = await h.core.check(gateRefund(args));
  expect(held.decision).toBe("hold");
  return held.request_id as string;
}

/** Earned autonomy lets a small refund run with nobody asked. */
async function ranAlone(level: "L2" | "L3" = "L3"): Promise<string> {
  h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", level, h.clock.nowMs());
  const response = await h.core.check(gateRefund(SMALL));
  expect(response.decision).toBe("allow");
  return response.request_id as string;
}

const sendDrill = async (person = "sam", flaw?: string): Promise<string> => {
  const sent = await h.core.sendDrill(person, flaw);
  if (!sent.ok) throw new Error(sent.reason);
  return sent.requestId;
};

const drillCard = (id: string, room: string) => {
  const row = h.core.stores.routes.forRequest(id).find((entry) => entry.card_room === room);
  const card = h.chat.cards.find((entry) => entry.switchRequestId === row?.switch_request_id);
  if (!card) throw new Error(`no card for ${id} in ${room}`);
  return card;
};

describe("what it counts", () => {
  it("money held and money denied, by class, in rupees", async () => {
    const denied = await holdRefund();
    h.clock.advance(MINUTE);
    await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
    await holdRefund(REFUND_SC3);
    h.clock.advance(MINUTE);
    await press(lastCard("dm-sam"), PARTICIPANTS.sam, "allow");
    expect(h.core.stores.requests.require(denied).state).toBe("DENIED");

    const { money, text: words } = report();
    expect(money?.by_class).toEqual([expect.objectContaining({ class: "refund", has_amount: true, held_requests: 2, held_amount: 44_000, denied_requests: 1, denied_amount: 40_000 })]);
    expect(words).toContain("refund: ₹44,000 held on 2 requests, ₹40,000 denied on 1.");
  });

  it("keeps classes apart, and doesn't call a class with no amount zero rupees", () => {
    settled("DENIED", { amount: 5000 });
    settled("APPROVED", { cls: "deploy" });
    settled("DENIED", { cls: "deploy" });
    const { money, text: words } = report();
    expect(money?.by_class.map((row) => [row.class, row.has_amount, row.held_requests, row.denied_requests])).toEqual([
      ["deploy", false, 2, 1],
      ["refund", true, 1, 1],
    ]);
    expect(words).toContain("deploy: 2 held, 1 denied. This class has no amount.");
    expect(words).not.toContain("₹0");
  });

  it("counts a smaller approved offer once, as what was first held, and still counts a denial of it", () => {
    const original = settled("EDITED", { amount: 5000 });
    settled("APPROVED", { amount: 4000, waitMs: 0, evidence: { editOf: { requestId: original, by: "sam", from: 5000, to: 4000, callHash: "x" } } });
    const { money, text: words } = report();
    expect(money?.by_class[0]).toMatchObject({ held_requests: 1, held_amount: 5000 });
    expect(money?.edited).toBe(1);
    expect(words).toContain("1 was approved for a smaller amount");
  });

  it("says calls a policy rule denied before any card have no amount on record, rather than adding them as nothing", () => {
    actionRow({ step: "aggregate_deny", decision: "deny", cls: "refund" });
    actionRow({ step: "aggregate_deny", decision: "deny", cls: "refund" });
    const { money, text: words } = report();
    expect(money?.by_class[0]).toMatchObject({ class: "refund", rule_denied: 2, held_requests: 0 });
    expect(words).toContain("A policy rule also denied 2 calls before any card, and their amounts aren't on record.");
  });

  it("counts only the team's last 7 days, by the team's calendar, and says which days", () => {
    settled("DENIED", { amount: 5000 });
    h.clock.set(NOW + 6 * DAY);
    expect(report()).toMatchObject({ from: "2026-11-04", to: "2026-11-10", days: 7 });
    expect(report().money?.by_class).toHaveLength(1);
    expect(text()).toContain("2026-11-04 to 2026-11-10");
    h.clock.set(NOW + 7 * DAY);
    expect(report().from).toBe("2026-11-05");
    expect(report().money?.by_class).toEqual([]);
  });

  it("counts risky actions that ran with no person, and tells earned autonomy apart", async () => {
    await safeCalls(MIN_ACTIONS_FOR_RATE);
    await ranAlone("L3");
    await holdRefund();
    h.clock.advance(MINUTE);
    await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
    expect(report().ran_alone).toMatchObject({ risky_outside_autonomy: 0, under_autonomy: 1, shadow_would_hold: 0, outcome_unknown: 0 });
    expect(text()).toContain("Outside earned autonomy: 0.");
    expect(text()).toContain("Under earned autonomy: 1.");
  });

  it("shows it plainly if a risky action ever ran with no person and no earned level", async () => {
    await safeCalls(1);
    actionRow({ step: "class_hold", decision: "allow", cls: "refund", tier: "high" });
    actionRow({ step: "grant", decision: "allow", cls: "refund" });
    expect(report().ran_alone?.risky_outside_autonomy).toBe(2);
    expect(text()).toContain("Outside earned autonomy: 2.");
    expect(text()).toContain("should be zero");
  });

  it("doesn't call a person's approval, a safe call or a hand-off to the gate running with no person", async () => {
    const id = settled("APPROVED", { amount: 5000 });
    actionRow({ step: "grant", decision: "allow", cls: "refund", requestId: id });
    actionRow({ step: "safe", decision: "allow" });
    actionRow({ step: "unmatched", decision: "allow" });
    actionRow({ step: "via_gate", decision: "allow", cls: "refund" });
    expect(report().ran_alone?.risky_outside_autonomy).toBe(0);
  });

  it("in shadow mode, counts what it would have held as running with no person, and says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clearance-roi-"));
    const path = join(dir, "policy.yaml");
    writeFileSync(path, POLICY.replace("mode: enforce", "mode: shadow"));
    h.core.close();
    h = makeHarness({ policyPath: path });
    await h.core.check(gateRefund(REFUND_SC4));
    expect(report().ran_alone).toMatchObject({ risky_outside_autonomy: 1, shadow_would_hold: 1 });
    expect(text()).toContain("1 of them because the policy is in shadow mode");
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves out what earned autonomy allowed and never ran, and flags what nobody can say ran", async () => {
    await safeCalls(1);
    const voided = await ranAlone("L3");
    expect(report().ran_alone?.under_autonomy).toBe(1);
    await h.core.autoRunFailed(voided, { neverRan: true, error: "gate said no" });
    expect(report().ran_alone?.under_autonomy).toBe(0);

    h.clock.advance(MINUTE);
    (h.lookup.world.destinations as Record<string, Record<string, unknown>>)["other@okaxis"] = { id: "other@okaxis", customer_id: "cus_8812", age_hours: 720 };
    const unknown = await h.core.check(gateRefund({ ...SMALL, destination: "other@okaxis" }));
    if (unknown.decision !== "allow") throw new Error(`expected it to run: ${unknown.reason}`);
    await h.core.autoRunFailed(unknown.request_id as string, { neverRan: false, error: "timed out" });
    expect(report().ran_alone).toMatchObject({ under_autonomy: 0, outcome_unknown: 1 });
    expect(text()).toContain("1 more was sent and nobody can say whether it ran.");
  });

  it("counts escalations by the card, not by the step, and only real ones", async () => {
    const id = settled("APPROVED", { amount: 5000 });
    h.core.stores.ledger.append("escalated", id, { kind: "notify" });
    h.core.stores.ledger.append("escalated", id, { kind: "add" });
    settled("EXPIRED", { amount: 5000 });
    expect(report().speed).toMatchObject({ escalated: 1, expired: 1 });
    expect(text()).toContain("Escalated: 1. Expired with no decision: 1.");
  });

  it("says one tool call seen twice, at the hook and at the gate, isn't two with no card", async () => {
    await safeCalls(MIN_ACTIONS_FOR_RATE - 1);
    actionRow({ step: "via_gate", decision: "allow", cls: "refund" });
    await holdRefund();
    h.clock.advance(MINUTE);
    await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
    expect(report().load).toMatchObject({ tool_calls: MIN_ACTIONS_FOR_RATE, no_card: MIN_ACTIONS_FOR_RATE - 1, no_card_share: 95 });
    expect(text()).toContain(`Tool calls with no card: ${MIN_ACTIONS_FOR_RATE - 1} of ${MIN_ACTIONS_FOR_RATE} (95%).`);
  });
});

describe("reads the same as the digest where they overlap", () => {
  it("the same counts of what was held, decided, expired and run alone", async () => {
    await holdRefund();
    h.clock.advance(MINUTE);
    await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
    await holdRefund(REFUND_SC3);
    h.clock.advance(MINUTE);
    await press(lastCard("dm-sam"), PARTICIPANTS.sam, "allow");
    settled("EXPIRED", { amount: 7000 });
    await ranAlone("L3");

    const digest = h.core.digest() as unknown as { requests: { held: number; denied: number; expired: number; ran_alone: number } };
    const roi = report();
    expect(roi.speed?.closed).toBe(digest.requests.held);
    expect(roi.speed?.expired).toBe(digest.requests.expired);
    expect(roi.money?.by_class.reduce((sum, row) => sum + row.denied_requests, 0)).toBe(digest.requests.denied);
    expect(roi.ran_alone?.under_autonomy).toBe(digest.requests.ran_alone);
    expect(digest.requests).toMatchObject({ held: 3, denied: 1, expired: 1, ran_alone: 1 });
  });

  it("the same median, to the nearest 10 s, the rule for any time a room reads", () => {
    for (const [seconds, by] of [[40, "sam"], [50, "neha"], [63, "alex"], [70, "sam"], [80, "neha"]] as const) settled("APPROVED", { amount: 1000, waitMs: seconds * 1000, by });
    const digest = h.core.digest() as unknown as { median_decision_ms: number };
    expect(digest.median_decision_ms).toBe(63_000);
    expect(report().speed?.median_seconds).toBe(60);
    expect(text()).toContain("Median time from hold to decision: 60 s, to the nearest 10 s.");
  });

  it("neither of them calls a card nobody answered a decision, or a run with nobody asked", async () => {
    for (const [seconds, by] of [[40, "sam"], [50, "neha"], [60, "alex"], [70, "sam"], [80, "neha"]] as const) settled("APPROVED", { amount: 1000, waitMs: seconds * 1000, by });
    settled("EXPIRED", { amount: 1000, waitMs: 25 * MINUTE });
    settled("EXPIRED", { amount: 1000, waitMs: 25 * MINUTE });
    settled("CANCELLED", { amount: 1000, waitMs: 20 * MINUTE });
    const voided = await ranAlone("L3");
    await h.core.autoRunFailed(voided, { neverRan: true, error: "gate said no" });
    const digest = h.core.digest() as unknown as { median_decision_ms: number; requests: { held: number } };
    expect(digest.median_decision_ms).toBe(60_000);
    expect(report().speed?.median_seconds).toBe(60);
    expect(digest.requests.held).toBe(8);
    expect(report().speed?.closed).toBe(8);
  });

  it("neither of them counts a smaller offer's instant yes as a decision of no seconds", () => {
    for (const [seconds, by] of [[40, "sam"], [50, "neha"], [60, "alex"], [70, "sam"]] as const) settled("APPROVED", { amount: 1000, waitMs: seconds * 1000, by });
    const original = settled("EDITED", { amount: 5000, waitMs: 80_000 });
    settled("APPROVED", { amount: 4000, waitMs: 0, evidence: { editOf: { requestId: original, by: "sam", from: 5000, to: 4000, callHash: "x" } } });
    expect((h.core.digest() as unknown as { median_decision_ms: number }).median_decision_ms).toBe(60_000);
    expect(report().speed?.median_seconds).toBe(60);
  });

  it("human load is what /v1/metrics/human-load says, and a window that holds everything changes nothing", async () => {
    await safeCalls(MIN_ACTIONS_FOR_RATE + 3);
    await holdRefund();
    h.clock.advance(MINUTE);
    await press(lastCard("dm-sam"), PARTICIPANTS.sam, "allow");
    const load = h.core.humanLoad();
    const roi = report();
    expect(roi.load).toMatchObject({ agent_actions: load.agent_actions, human_decisions: load.human_decisions, per_100: load.per_100 });
    expect(load.per_100).toBeGreaterThan(0);
    expect(load.human_decisions).toBe(1);
    expect(text()).toContain(`Human decisions per 100 agent actions: ${load.per_100} (1 decision, ${load.agent_actions} actions).`);
  });

  it("human load drops what's outside the window only when asked: the plain route still reads everything", async () => {
    await safeCalls(2);
    h.clock.set(NOW + 8 * DAY);
    expect(h.core.humanLoad().agent_actions).toBe(2);
    expect(report().load?.agent_actions).toBe(0);
  });

  it("drill totals are clearance-state's, word for word", async () => {
    const resultsOf = () => h.core.stores.ledger.list().filter((entry) => entry.type === "drill_result").map((entry) => String(entry.payload.result));
    for (const person of ["sam", "neha", "alex"]) {
      const id = await sendDrill(person);
      h.clock.advance(25 * MINUTE);
      await h.core.tick();
      expect(h.core.stores.requests.require(id).state).toBe("EXPIRED");
    }
    expect(text()).toContain(drillTotals(resultsOf()));
  });

  it("a card still open is in the digest's count and not yet in this one, and the difference is only that", async () => {
    settled("DENIED", { amount: 5000 });
    await holdRefund();
    const digest = h.core.digest() as unknown as { requests: { held: number } };
    expect(digest.requests.held).toBe(2);
    expect(report().speed?.closed).toBe(1);
  });
});

describe("a room never sees per-person data", () => {
  const PEOPLE_WORDS = /\b(priya|sam|neha|alex|dev)\b|switch-user|u-sam/i;
  const PER_PERSON_WORDS = /user_id|answered_by|approved_by|denied_by|latency|by_tier|signals|friction|flaw|handle|fast_approval|requester/i;

  /** Everyone has decided something, one drill has finished, and a real card and a drill are open. */
  async function busyWeek(): Promise<void> {
    for (const [seconds, by] of [[40, "sam"], [50, "neha"], [60, "alex"], [70, "dev"], [80, "priya"]] as const) settled("APPROVED", { amount: 1000, waitMs: seconds * 1000, by });
    await safeCalls(MIN_ACTIONS_FOR_RATE);
    await holdRefund();
    const finished = await sendDrill("neha");
    h.clock.advance(MINUTE);
    await press(drillCard(finished, "dm-neha"), PARTICIPANTS.neha, "deny");
    await sendDrill("alex");
  }

  it("says nothing about anyone, in the words or in the fields", async () => {
    await busyWeek();
    const roi = report();
    expect(roi.text).not.toMatch(PEOPLE_WORDS);
    expect(JSON.stringify(roi)).not.toMatch(PEOPLE_WORDS);
    expect(JSON.stringify(roi)).not.toMatch(PER_PERSON_WORDS);
  });

  it("has only these fields, so a per-person one can't be added without someone meaning to", async () => {
    await busyWeek();
    expect(Object.keys(report()).sort()).toEqual(["chain_ok", "currency", "days", "drills", "from", "load", "money", "needs", "ran_alone", "speed", "synthetic", "text", "to"]);
    expect(() => RoiReportSchema.parse({ ...report(), by_person: { sam: 1 } })).toThrow();
    expect(() => RoiReportSchema.parse({ ...report(), speed: { ...report().speed, sam_seconds: 40 } })).toThrow();
  });

  it("is the same answer for everyone, in every room, whatever they ask for", async () => {
    await busyWeek();
    const asks = [
      { who: PARTICIPANTS.sam, body: "@clearance roi", room: "#support" },
      { who: PARTICIPANTS.priya, body: "@clearance roi", room: "#approvals" },
      { who: PARTICIPANTS.neha, body: "@clearance roi sam", room: "#approvals" },
      { who: PARTICIPANTS.alex, body: "@clearance roi by person", room: "dm-alex" },
    ];
    for (const ask of asks) {
      const before = h.chat.messages.length;
      await h.core.onMessage(chatMessage(ask.who, ask.body, { addressed: true, roomId: ask.room }));
      expect(h.chat.messages.slice(before).map((message) => message.body), ask.body).toEqual([text()]);
    }
  });

  it("gives no time of day: nothing a gap can be measured from", async () => {
    await busyWeek();
    expect(text()).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    expect(JSON.stringify(report())).not.toMatch(/T\d{2}:\d{2}/);
  });

  it("gives no median when all the decisions are one person's, however many", () => {
    for (const seconds of [40, 50, 60, 70, 80, 90, 100]) settled("APPROVED", { amount: 1000, waitMs: seconds * 1000, by: "sam" });
    expect(report().speed?.median_seconds).toBeNull();
    expect(text()).toContain(`too little data. It needs ${MIN_DECISIONS_FOR_MEDIAN} decisions from ${MIN_PEOPLE_FOR_MEDIAN} people, so that it isn't one person's timing.`);
    expect(text()).not.toMatch(/\b[1-9]\d* s\b/);
  });

  it("gives no median from two people either: if you know yours, you know theirs", () => {
    for (const [seconds, by] of [[40, "sam"], [50, "neha"], [60, "sam"], [70, "neha"], [80, "sam"]] as const) settled("APPROVED", { amount: 1000, waitMs: seconds * 1000, by });
    expect(report().speed?.median_seconds).toBeNull();
  });

  it("counts only the people behind the decisions in the median: reviewing a run alone isn't one of them", async () => {
    for (const seconds of [40, 50, 60, 70, 80]) settled("APPROVED", { amount: 1000, waitMs: seconds * 1000, by: "sam" });
    const ran = await ranAlone("L3");
    for (const person of ["neha", "alex"]) {
      h.core.stores.answers.record({ requestId: ran, switchRequestId: `review-${person}`, answeredBy: `@${person}`, userId: person, decision: "approve", latencyMs: 1000, eligible: true, reason: null, atMs: h.clock.nowMs() });
    }
    expect(report().speed?.median_seconds).toBeNull();
  });

  it("doesn't put a very fast median to the second: that is a rubber stamp's own number", () => {
    for (const [seconds, by] of [[1, "sam"], [2, "neha"], [3, "alex"], [3, "sam"], [4, "neha"]] as const) settled("APPROVED", { amount: 1000, waitMs: seconds * 1000, by });
    expect(report().speed?.median_seconds).toBe(0);
    expect(text()).toContain("Median time from hold to decision: under 5 s, to the nearest 10 s.");
  });
});

describe("drills stay drills", () => {
  it("while one is open, the report answers byte for byte as it did before", async () => {
    settled("DENIED", { amount: 5000 });
    await safeCalls(3);
    const before = report();
    await sendDrill("sam");
    expect(report()).toEqual(before);
  });

  it("a real card doesn't move it either, so a card can't be told from a drill by watching it", async () => {
    settled("DENIED", { amount: 5000 });
    await safeCalls(3);
    const before = report();
    await holdRefund();
    expect(report()).toEqual(before);
    await h.core.check(gateRefund(REFUND_SC4)); // The same call again, on the same open card: a new row in the actions table.
    expect(report()).toEqual(before);
  });

  it("a closed drill adds no money, decisions, cards or tool calls, however it ended", async () => {
    settled("DENIED", { amount: 5000 });
    const before = report();
    const denied = await sendDrill("sam");
    h.core.stores.ledger.append("escalated", denied, { kind: "notify" });
    h.clock.advance(MINUTE);
    await press(drillCard(denied, "dm-sam"), PARTICIPANTS.sam, "deny");
    const approved = await sendDrill("neha");
    h.clock.advance(MINUTE);
    await press(drillCard(approved, "dm-neha"), PARTICIPANTS.neha, "allow");
    expect(report()).toEqual(before);
  });

  it("totals appear only in whole groups of 3, and a catch rate only with them", async () => {
    const answerDrill = async (person: string, room: string, participant: string, answer: "allow" | "deny") => {
      // A refund's flaw, since a flaw on a critical call won't take a plain approval.
      const id = await sendDrill(person, answer === "allow" ? "new_destination" : undefined);
      h.clock.advance(MINUTE);
      await press(drillCard(id, room), participant, answer);
      expect(h.core.stores.requests.require(id).state).not.toBe("ROUTED");
    };
    expect(report().drills).toMatchObject({ finished: 0, catch_rate_percent: null });
    await answerDrill("sam", "dm-sam", PARTICIPANTS.sam, "allow");
    expect(report().drills).toMatchObject({ finished: 0, caught: 0, missed: 0, catch_rate_percent: null });
    expect(text()).toContain("Totals appear once 3 have finished");
    await answerDrill("neha", "dm-neha", PARTICIPANTS.neha, "deny");
    expect(report().drills?.finished).toBe(0);
    await answerDrill("alex", "dm-alex", PARTICIPANTS.alex, "deny");
    expect(report().drills).toMatchObject({ finished: 3, caught: 2, missed: 1, expired: 0, catch_rate_percent: 67, group: 3 });
    expect(text()).toContain("3 finished: 2 caught, 1 missed, 0 not answered.");
    expect(text()).toContain("Catch rate: 67%.");
  });

  it("the totals stand still while a drill is open, even if another finishes, as the team view's do", async () => {
    const finish = async (person: string, room: string, participant: string) => {
      const id = await sendDrill(person);
      h.clock.advance(MINUTE);
      await press(drillCard(id, room), participant, "deny");
    };
    await finish("sam", "dm-sam", PARTICIPANTS.sam);
    await finish("neha", "dm-neha", PARTICIPANTS.neha);
    const open = await sendDrill("alex");
    await finish("dev", "dm-dev", PARTICIPANTS.dev);
    expect(report().drills?.finished).toBe(0);
    h.clock.advance(MINUTE);
    await press(drillCard(open, "dm-alex"), PARTICIPANTS.alex, "deny");
    expect(report().drills?.finished).toBe(3);
  });

  it("gives no catch rate when none of a whole group was answered, rather than 0%", async () => {
    for (const person of ["sam", "neha", "alex"]) {
      await sendDrill(person);
      h.clock.advance(25 * MINUTE);
      await h.core.tick();
    }
    expect(report().drills).toMatchObject({ finished: 3, expired: 3, catch_rate_percent: null });
    expect(text()).not.toMatch(/Catch rate/);
  });

  it("doesn't count a drill by how many were sent", async () => {
    await sendDrill("sam");
    expect(JSON.stringify(report().drills)).not.toContain("sent");
    expect(text()).not.toMatch(/\bsent\b/);
  });
});

describe("says plainly when there's too little, and never estimates", () => {
  it("on an empty record there are words, not zeros", () => {
    const roi = report();
    expect(roi.ran_alone).toMatchObject({ risky_outside_autonomy: null, under_autonomy: null });
    expect(roi.load).toMatchObject({ per_100: null, no_card_share: null });
    expect(roi.speed).toMatchObject({ median_seconds: null, escalated: null, expired: null });
    expect(roi.money?.by_class).toEqual([]);
    expect(roi.text).toMatch(/too little data/i);
    expect(roi.text).not.toMatch(/₹0|\b0%|\b0 s\b|: 0\./);
  });

  it("a rate needs enough actions, and the count under it is still given", async () => {
    await safeCalls(MIN_ACTIONS_FOR_RATE - 1);
    expect(report().load).toMatchObject({ agent_actions: MIN_ACTIONS_FOR_RATE - 1, human_decisions: 0, per_100: null, no_card_share: null });
    expect(text()).toContain(`Human decisions per 100 agent actions: too little data. ${MIN_ACTIONS_FOR_RATE - 1} actions so far, and a rate needs ${MIN_ACTIONS_FOR_RATE}.`);
    expect(text()).toContain(`Tool calls with no card: too little data. ${MIN_ACTIONS_FOR_RATE - 1} calls so far, and a rate needs ${MIN_ACTIONS_FOR_RATE}.`);
    await safeCalls(1);
    expect(report().load).toMatchObject({ per_100: 0, no_card_share: 100 });
  });

  it("a median needs enough decisions", () => {
    for (const [seconds, by] of [[40, "sam"], [50, "neha"], [60, "alex"], [70, "dev"]] as const) settled("APPROVED", { amount: 1000, waitMs: seconds * 1000, by });
    expect(report().speed?.median_seconds).toBeNull();
    settled("APPROVED", { amount: 1000, waitMs: 80_000, by: "priya" });
    expect(report().speed?.median_seconds).toBe(60);
  });

  it("makes no claim of hours or money saved", async () => {
    settled("DENIED", { amount: 40_000 });
    await safeCalls(MIN_ACTIONS_FOR_RATE);
    expect(JSON.stringify(report())).not.toMatch(/saved|saving|hours|estimat(?!ed\.)|roi_/i);
    expect(text()).toContain("Nothing here is estimated.");
  });

  it("is written in plain words: no long dashes", async () => {
    settled("DENIED", { amount: 40_000 });
    expect(text()).not.toMatch(/[—–]/);
  });
});

describe("fails closed on display", () => {
  it("an amount it can't read isn't added as zero, and it says so", () => {
    settled("DENIED", { amount: 40_000 });
    settled("APPROVED", { amount: "a lot" });
    settled("APPROVED", { amount: -500 });
    const { money, text: words } = report();
    expect(money?.by_class[0]).toMatchObject({ held_requests: 3, held_amount: 40_000, held_unreadable: 2 });
    expect(words).toContain("₹40,000 held on 3 requests");
    expect(words).toContain("2 held have no readable amount, so the total leaves them out.");
  });

  it("when no amount in a class can be read, there is no total at all", () => {
    settled("DENIED", { amount: "a lot" });
    const { money, text: words } = report();
    expect(money?.by_class[0]).toMatchObject({ has_amount: true, held_amount: null, held_unreadable: 1, denied_amount: null, denied_unreadable: 1 });
    expect(words).toContain("refund: 1 held and 1 denied, and no amount could be read.");
    expect(words).not.toContain("₹");
  });

  it("a request with no amount in a class that always has one is unreadable, not nothing", () => {
    settled("APPROVED", {});
    expect(report().money?.by_class[0]).toMatchObject({ has_amount: true, held_amount: null, held_unreadable: 1 });
  });

  it("a row whose record can't be read counts as unreadable and doesn't sink the report", () => {
    const id = settled("APPROVED", { amount: 1000 });
    settled("APPROVED", { amount: 2000 });
    h.core.stores.db.prepare(`UPDATE requests SET evidence = 'not json' WHERE id = ?`).run(id);
    expect(report().money?.by_class[0]).toMatchObject({ held_requests: 2, held_amount: 2000, held_unreadable: 1 });
  });

  it("a section it can't compute says so, and the others still answer", async () => {
    settled("DENIED", { amount: 40_000 });
    await safeCalls(MIN_ACTIONS_FOR_RATE);
    h.core.stores.db.exec("DROP TABLE routes");
    const roi = report();
    expect(roi.load).toBeNull();
    expect(roi.money?.by_class).toHaveLength(1);
    expect(roi.text).toContain("Couldn't be computed just now");
    expect(roi.text).not.toContain("no card: 0");
  });

  it("a figure that breaks the report's own shape is refused, and every section says so", () => {
    settled("DENIED", { amount: 40_000 });
    const { stores } = h.core;
    const roi = buildRoiReport({
      db: stores.db,
      nowMs: h.clock.nowMs(),
      tz: "Asia/Kolkata",
      currency: "INR",
      amountClasses: new Set(["refund"]),
      humanLoad: () => ({ agent_actions: 50, human_decisions: 1, per_100: -3 }),
      chainOk: () => true,
      syntheticRows: () => 0,
    });
    expect(roi).toMatchObject({ chain_ok: true, money: null, ran_alone: null, load: null, speed: null, drills: null, synthetic: null });
    expect(roi.text).toContain("Couldn't be computed just now");
    expect(roi.text).not.toContain("₹");
  });

  it("nothing that goes wrong reaches the room as a stack or a table name", async () => {
    h.core.stores.db.exec("DROP TABLE answers");
    expect(text()).not.toMatch(/answers|sqlite|no such table|Error/);
  });

  it("if the ledger's chain doesn't verify, it shows no numbers at all", () => {
    settled("DENIED", { amount: 40_000 });
    const { db } = h.core.stores;
    db.exec("DROP TRIGGER IF EXISTS ledger_no_update");
    db.prepare(`UPDATE ledger SET type = 'approved' WHERE seq = (SELECT MAX(seq) FROM ledger)`).run();
    const roi = report();
    expect(roi).toMatchObject({ chain_ok: false, money: null, ran_alone: null, load: null, speed: null, drills: null });
    expect(roi.text).toContain("The ledger's hash chain doesn't verify, so this report shows no numbers.");
    expect(roi.text).toContain("pnpm ledger:verify");
    expect(roi.text).not.toContain("₹");
  });
});

describe("anything seeded is labelled synthetic", () => {
  it("says nothing about it when there is none", () => {
    expect(report().synthetic).toEqual({ history_rows: 0, runs_on_history: 0 });
    expect(text()).not.toMatch(/synthetic/i);
  });

  it("labels it, and counts none of it", () => {
    const before = report();
    seedSyntheticHistory(h.core.stores.db, HISTORY_SEED, h.clock.nowMs());
    const { synthetic } = h.core.stores.events.counts();
    const after = report();
    expect(synthetic).toBeGreaterThan(0);
    expect(after.synthetic).toEqual({ history_rows: synthetic, runs_on_history: 0 });
    expect(after.text).toContain(`Synthetic: ${synthetic} rows of seeded history are on record, labelled synthetic. None are counted here.`);
    expect({ ...after, synthetic: null, text: "" }).toEqual({ ...before, synthetic: null, text: "" });
  });

  it("keeps the label when the record of a run on that history can't be read", async () => {
    seedSyntheticHistory(h.core.stores.db, HISTORY_SEED, h.clock.nowMs());
    const id = await ranAlone("L3");
    h.core.stores.db.prepare(`UPDATE requests SET evidence = 'not json' WHERE id = ?`).run(id);
    expect(report().synthetic?.history_rows).toBeGreaterThan(0);
    expect(text()).toContain("rows of seeded history are on record, labelled synthetic");
  });

  it("says so if it can't tell whether there is any, rather than dropping the label", () => {
    h.core.stores.db.exec("DROP TABLE bucket_events");
    expect(report().synthetic).toBeNull();
    expect(text()).toContain("Synthetic: couldn't check for seeded history just now, so treat these numbers with care.");
  });

  it("says when real runs stand on a level promoted from that history", async () => {
    seedSyntheticHistory(h.core.stores.db, HISTORY_SEED, h.clock.nowMs());
    await safeCalls(1);
    await ranAlone("L3");
    expect(report().synthetic?.runs_on_history).toBe(1);
    expect(text()).toContain("1 of the earned-autonomy runs here is in a bucket whose evidence includes it.");
  });
});

describe("read-only", () => {
  const changes = () => (h.core.stores.db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;

  it("writes nothing when it reads", async () => {
    settled("DENIED", { amount: 5000 });
    await safeCalls(3);
    const before = changes();
    report();
    h.core.digest();
    h.core.humanLoad();
    expect(changes()).toBe(before);
  });

  it("changes no decision: the same calls get the same answers with the report read between them", async () => {
    const call = async () => {
      const held = await h.core.check(gateRefund(REFUND_SC4));
      return { decision: held.decision, tier: held.tier, class: held.class };
    };
    const first = await call();
    h.core.close();
    h = makeHarness();
    report();
    const second = await call();
    report();
    expect(second).toEqual(first);
  });
});

describe("@clearance roi", () => {
  const ask = (who: string, body = "@clearance roi", overrides: Record<string, unknown> = {}) => h.core.onMessage(chatMessage(who, body, { addressed: true, roomId: "#support", ...overrides }));

  it("answers in the room and thread it was asked in, with the report", async () => {
    settled("DENIED", { amount: 40_000 });
    await ask(PARTICIPANTS.priya);
    expect(h.chat.messages.at(-1)).toEqual({ roomId: "#support", threadId: "t-77", body: text() });
    expect(text()).toMatch(/^Clearance report, last 7 days: /);
  });

  it("reads the same on a restart: everything is in the database", async () => {
    settled("DENIED", { amount: 40_000 });
    const before = text();
    h = h.restart();
    expect(text()).toBe(before);
  });

  it("isn't for an agent, or an account linked to nobody", async () => {
    const before = h.chat.messages.length;
    await ask(PARTICIPANTS.refundsAgent);
    await ask(PARTICIPANTS.guest);
    expect(h.chat.messages).toHaveLength(before);
  });

  it("takes who's asking from the sender and not from the text", async () => {
    const before = h.chat.messages.length;
    await ask(PARTICIPANTS.guest, "@clearance roi as sam");
    expect(h.chat.messages).toHaveLength(before);
  });

  it("ignores a passing mention", async () => {
    const before = h.chat.messages.length;
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "did you see what @clearance roi said", { addressed: true }));
    expect(h.chat.messages).toHaveLength(before);
  });
});

describe("GET /v1/roi", () => {
  const TOKEN = "roi-test-token";

  it("is the same report, behind the token", async () => {
    settled("DENIED", { amount: 40_000 });
    const app = buildServer(h.core, { internalToken: TOKEN });
    const refused = await app.inject({ method: "GET", url: "/v1/roi" });
    expect(refused.statusCode).toBe(401);
    const answer = await app.inject({ method: "GET", url: "/v1/roi", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual(report());
    expect(RoiReportSchema.safeParse(answer.json()).success).toBe(true);
    await app.close();
  });
});

describe("the room document", () => {
  let mirror: LedgerMirror;
  const afterTick = () => new Promise((done) => setImmediate(done));
  const documents = () => h.chat.documents.filter((document) => document.name === ROI_DOCUMENT);
  const AT_TIME = Date.parse("2026-11-04T18:31:00+05:30");

  beforeEach(() => {
    mirror = createLedgerMirror(h.core, { chat: h.chat, clock: h.clock, policyRoom: "#approvals" });
  });

  const tick = async () => {
    mirror.tick();
    await afterTick();
    await afterTick();
  };

  it("is written once a day at the digest's time, to #approvals, with the command's own words", async () => {
    settled("DENIED", { amount: 40_000 });
    await tick();
    expect(documents()).toEqual([]);
    h.clock.set(AT_TIME);
    await tick();
    await tick();
    expect(documents()).toHaveLength(1);
    expect(documents()[0]?.roomId).toBe("#approvals");
    expect(documents()[0]?.content).toContain(text());
    h.clock.advance(DAY);
    await tick();
    expect(documents()).toHaveLength(2);
    expect(documents()[1]?.content).toContain(text());
  });

  it("doesn't write for a time that had gone by when it first looked", async () => {
    h.clock.set(AT_TIME);
    await tick();
    expect(documents()).toEqual([]);
  });

  it("names nobody and gives no time of day", async () => {
    for (const [seconds, by] of [[40, "sam"], [50, "neha"], [60, "alex"], [70, "dev"], [80, "priya"]] as const) settled("APPROVED", { amount: 1000, waitMs: seconds * 1000, by });
    await tick();
    h.clock.set(AT_TIME);
    await tick();
    const content = documents()[0]?.content ?? "";
    expect(content.length).toBeGreaterThan(0);
    expect(content).not.toMatch(/\b(priya|sam|neha|alex|dev)\b/i);
    expect(content).not.toMatch(/\b\d{1,2}:\d{2}\b/);
  });

  it("goes out on time with a drill open, with the same words, so its timing can't point at one", async () => {
    settled("DENIED", { amount: 40_000 });
    await tick();
    const before = text();
    const ledgerCopies = () => h.chat.documents.filter((document) => document.name.startsWith("clearance-ledger")).length;
    const copied = ledgerCopies();
    await sendDrill("sam");
    h.clock.set(AT_TIME);
    await tick();
    expect(documents()).toHaveLength(1);
    expect(documents()[0]?.content).toContain(before);
    // The ledger's own copy still stands still.
    expect(ledgerCopies()).toBe(copied);
  });

  it("tries again after a failure, and loses nothing", async () => {
    await tick();
    h.clock.set(AT_TIME);
    const write = h.chat.upsertDocument.bind(h.chat);
    h.chat.upsertDocument = async () => {
      throw new Error("switch unreachable");
    };
    await tick();
    expect(documents()).toEqual([]);
    h.chat.upsertDocument = write;
    await tick();
    expect(documents()).toEqual([]);
    h.clock.advance(MINUTE);
    await tick();
    expect(documents()).toHaveLength(1);
  });

  it("isn't written for a policy with no digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clearance-roi-"));
    const path = join(dir, "policy.yaml");
    writeFileSync(path, POLICY.replace(/^digest:.*$/m, ""));
    h.core.close();
    h = makeHarness({ policyPath: path });
    mirror = createLedgerMirror(h.core, { chat: h.chat, clock: h.clock, policyRoom: "#approvals" });
    await tick();
    h.clock.set(AT_TIME);
    await tick();
    expect(documents()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
