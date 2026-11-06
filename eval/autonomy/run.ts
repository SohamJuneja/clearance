/**
 * `pnpm eval:autonomy` (E6): earned autonomy on a seeded, clearly labelled synthetic history.
 *
 * Runs the real core in-process, with fake chat, gate and lookups and a temp database. Every number comes from what
 * core did: the seeded week earns a proposal, two people sign it, and a second synthetic week goes through
 * `core.check`. People are simulated: they answer each held card carefully, and deny the flawed ones.
 *
 * The anomaly rule changed after the first result here. Core runs the new rule. The old one is applied from this
 * file onto the same week, the seed is the same, and both are published. Nothing else is tuned against this week.
 *
 * Nothing here is typed by hand. Writes eval/out/autonomy.json in the format eval/report.ts reads.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action, ChatPort, Clock, ExecuteResult, GatePort, LookupPort, OpenCardInput, OpenCardResult } from "../../packages/contracts/src/index.ts";
import { drawRefund, generateSyntheticHistory, HISTORY_SEED, seededRandom, seedSyntheticHistory } from "../../packages/core/src/autonomy/history.ts";
import { createClearanceCore, type Clearance } from "../../packages/core/src/core.ts";
import { REPO_ROOT } from "../lib/paths.ts";

const NOW = Date.parse("2026-11-04T14:00:00+05:30");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A careful reader: well past t_min on every card here. */
const CAREFUL_MS = 60_000;

const RULE_IN_FORCE = "An amount above the bucket's 95th percentile holds that one call for a person and does not demote.";
const ORIGINAL_RULE = "An amount above the bucket's 95th percentile demotes the bucket to L0 at once (F11 as first written).";
const RULE_CHANGE =
  "The anomaly rule was changed after seeing the first result on this synthetic data: the original rule fires on about 5% of normal traffic by definition. Both are published, from the same fixed seed, and nothing else was tuned against this week.";

const PEOPLE = {
  priya: "@e6-priya:localhost",
  sam: "@e6-sam:localhost",
  neha: "@e6-neha:localhost",
  alex: "@e6-alex:localhost",
  dev: "@e6-dev:localhost",
} as const;
type PersonId = keyof typeof PEOPLE;

const IDENTITIES = {
  people: Object.fromEntries(
    Object.entries(PEOPLE).map(([id, participant]) => [id, { switchUserId: `u-${id}`, participantIds: [participant], mattermostUser: id }]),
  ),
  agents: {
    clearance: { switchAgentId: "ag-clearance", participantId: "@e6-clearance:localhost" },
    "refunds-agent": { switchAgentId: "ag-refunds", participantId: "@e6-refunds:localhost" },
  },
};

class Chat implements ChatPort {
  private next = 1;
  readonly opened: { switchRequestId: string; sessionId: string; roomId: string }[] = [];
  async openCard(input: OpenCardInput): Promise<OpenCardResult> {
    const number = this.next++;
    const result = { sessionId: `session-${number}`, switchRequestId: `sw-${number}` };
    this.opened.push({ ...result, roomId: input.roomId });
    return result;
  }
  async closeCard(): Promise<void> {}
  async postMessage(): Promise<{ messageId?: string }> {
    return {};
  }
  async sendTargeted(): Promise<void> {}
  async ensureDirectRoom(person: { userName: string }): Promise<{ roomId: string }> {
    return { roomId: `dm-${person.userName}` };
  }
  async upsertDocument(): Promise<void> {}
}

const gate: GatePort = {
  edit: async () => ({ ok: true }),
  execute: async (): Promise<ExecuteResult> => ({ ok: true, alreadyExecuted: false, status: 200, result: { id: "synthetic" } }),
};

/** Every order and customer exists and every destination is old, so the only thing varying is the amount. */
const lookup: LookupPort = {
  lookup: async (kind, id) => {
    if (kind === "customers") return { id, name: "Synthetic customer" };
    if (kind === "orders") return { id, total: 1_000_000 };
    if (kind === "destinations") return { id, age_hours: 720 };
    return null;
  },
};

type Draw = { amount: number; small: boolean; flawed: boolean; atMs: number };

/** A week of refunds from the same generator as the seed, in time order. */
export function drawWeek(seed: number, startMs: number): Draw[] {
  const random = seededRandom(seed);
  const week = Array.from({ length: 120 }, () => ({ ...drawRefund(random), atMs: startMs + Math.floor(random() * (7 * DAY - HOUR)) }));
  return week.sort((a, b) => a.atMs - b.atMs);
}

function world(dir: string, name: string): { core: Clearance; chat: Chat; clock: Clock & { set(ms: number): void } } {
  const identitiesPath = join(dir, `${name}.identities.json`);
  writeFileSync(identitiesPath, JSON.stringify(IDENTITIES));
  let now = NOW;
  const clock = { nowMs: () => now, scaledMs: (ms: number) => ms, set: (ms: number) => void (now = ms) };
  const chat = new Chat();
  const core = createClearanceCore({
    dbPath: join(dir, `${name}.sqlite`),
    policyPath: join(REPO_ROOT, "policy/clearance.policy.yaml"),
    teamPath: join(REPO_ROOT, "policy/team.yaml"),
    identitiesPath,
    drillsPath: join(REPO_ROOT, "drills/flaws.yaml"),
    rollDrills: false,
    chat,
    gate,
    lookup,
    clock,
  });
  return { core, chat, clock };
}

const SEND = (sender: string, body: string, roomId: string) => ({
  roomId,
  threadId: null,
  messageId: `m-${Math.random()}`,
  sender,
  addressed: true,
  body,
  timestampMs: 0,
});

async function answer(core: Clearance, chat: Chat, requestId: string, clock: Clock, who: PersonId, value: string): Promise<boolean> {
  const row = core.stores.routes.openForRequest(requestId).find((candidate) => candidate.user_id === who);
  const card = chat.opened.find((candidate) => candidate.switchRequestId === row?.switch_request_id);
  if (!row || !card) return false;
  await core.onApprovalOutcome({
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "approval",
    state: "answered",
    answer: value,
    answeredBy: PEOPLE[who],
    answeredAtMs: clock.nowMs(),
  });
  return true;
}

/** Seed the labelled history, ask, and have both owners sign. Returns the proposal count and the replay it rested on. */
async function promote(core: Clearance, chat: Chat, clock: Clock) {
  seedSyntheticHistory(core.stores.db, HISTORY_SEED, clock.nowMs());
  const [replay] = await core.autonomyReplay({ agent: "refunds-agent", class: "refund", bucket: "small" });
  if (!replay) throw new Error("the seeded history has no refund bucket to replay");
  await core.onMessage(SEND(PEOPLE.sam, "@clearance autonomy refunds-agent", "#approvals"));
  const proposals = core.autonomyReport().proposals;
  const id = String(proposals[0]?.id);
  for (const who of ["sam", "alex"] as const) await answer(core, chat, id, clock, who, "allow");
  return { replay, proposals: proposals.length, level: core.stores.autonomy.levelFor("refunds-agent", "refund", "small") };
}

function refundAction(draw: Draw, index: number, clock: Clock): Action {
  // Each its own destination, as in the seeded week: one shared one would be the fan-out the policy holds.
  const args = { order_id: `A-${5000 + index}`, customer_id: `cus_wk2_${index}`, amount: draw.amount, destination: `synthetic-wk2-${index}@okhdfc` };
  return {
    id: `e6-${index}-${draw.atMs}`,
    at: new Date(clock.nowMs()).toISOString(),
    source: "gate",
    vendor: "gate",
    agent: { name: "refunds-agent" },
    session: { switchRoomId: "#support", threadId: `t-${index}` },
    kind: "business",
    raw: args,
    business: { endpoint: "POST /acme/refunds", args },
  };
}

export type WeekResult = {
  actions: number;
  human_decisions: number;
  ran_alone: number;
  denied: number;
  review_cards: number;
  held_above_normal_range: number;
  demoted_at_action: number | null;
  demoted_because: string | null;
  human_decisions_per_100_until_demotion: number | null;
};

/**
 * The second week through `core.check`. Anyone holding a card answers it; nobody answers a review card. With
 * `demoteAboveRange`, this file does what the original rule did in core: demote the moment the flag appears.
 */
async function runWeek(core: Clearance, chat: Chat, clock: Clock & { set(ms: number): void }, draws: Draw[], demoteAboveRange: boolean): Promise<WeekResult> {
  const { autonomy } = core.stores;
  let humanDecisions = 0;
  let ranAlone = 0;
  let denied = 0;
  let heldAbove = 0;
  let demotedAt: number | null = null;
  let demotedBecause: string | null = null;
  let decisionsAtDemotion = 0;
  for (const [index, draw] of draws.entries()) {
    clock.set(draw.atMs);
    await core.onMessage(SEND(PEOPLE.priya, "@refunds-agent refund it", "#support"));
    const response = await core.check(refundAction(draw, index, clock));
    if (response.decision === "allow") ranAlone += 1;
    if (response.flags?.some((flag) => flag.code === "above_normal_range")) {
      heldAbove += 1;
      if (demoteAboveRange) {
        autonomy.setLevel("refunds-agent", "refund", "small", "L0", clock.nowMs());
        demotedBecause ??= "above the 95th percentile";
      }
    }
    if (response.decision === "hold") {
      const id = response.request_id as string;
      clock.set(draw.atMs + CAREFUL_MS);
      const holder = core.stores.routes.openForRequest(id).find((row) => row.user_id)?.user_id as PersonId | undefined;
      if (holder && (await answer(core, chat, id, clock, holder, draw.flawed ? "deny" : "allow"))) humanDecisions += 1;
      if (draw.flawed) denied += 1;
    }
    if (demotedAt === null && autonomy.levelFor("refunds-agent", "refund", "small") === "L0") {
      demotedAt = index + 1;
      decisionsAtDemotion = humanDecisions;
    }
  }
  const demotion = core.stores.ledger.list().find((entry) => entry.type === "demoted");
  const reviews = core.stores.db.prepare(`SELECT COUNT(*) AS count FROM routes WHERE step = 'review'`).get() as { count: number };
  return {
    actions: draws.length,
    human_decisions: humanDecisions,
    ran_alone: ranAlone,
    denied,
    review_cards: reviews.count,
    held_above_normal_range: heldAbove,
    demoted_at_action: demotedAt,
    demoted_because: demotedBecause ?? (demotion ? String((demotion.payload as { reason?: unknown }).reason) : null),
    human_decisions_per_100_until_demotion: demotedAt === null ? null : per100(decisionsAtDemotion, demotedAt),
  };
}

function per100(decisions: number, actions: number): number {
  return Math.round((decisions / actions) * 1000) / 10;
}

async function incidentDrill(dir: string) {
  const { core, chat, clock } = world(dir, "incident");
  try {
    await promote(core, chat, clock);
    const action = (index: number): Action => refundAction({ amount: 2000, small: true, flawed: false, atMs: clock.nowMs() }, 900 + index, clock);
    const ran = await core.check(action(0));
    const started = performance.now();
    await core.onMessage(SEND(PEOPLE.sam, `@clearance incident ${ran.request_id} customer disputes this refund`, "#approvals"));
    const elapsed = performance.now() - started;
    const next = await core.check(action(1));
    return {
      ran_before_incident: ran.decision === "allow",
      incident_to_demotion_ms: Math.round(elapsed * 100) / 100,
      level_after: core.stores.autonomy.levelFor("refunds-agent", "refund", "small"),
      next_refund: next.decision,
    };
  } finally {
    core.close();
  }
}

export async function runAutonomyEval() {
  const dir = mkdtempSync(join(tmpdir(), "clearance-e6-"));
  try {
    // The seeded week, as people decided it.
    const seeded = generateSyntheticHistory(HISTORY_SEED, NOW).filter((row) => row.cls === "refund");
    const decisionsBefore = seeded.reduce((sum, row) => sum + row.approvers.length, 0);
    const before = per100(decisionsBefore, seeded.length);
    const secondWeek = () => drawWeek(HISTORY_SEED + 1, NOW + HOUR);

    // Promoted, then a second week from the same generator, under the rule in force.
    const live = world(dir, "live");
    const promoted = await promote(live.core, live.chat, live.clock);
    const week = await runWeek(live.core, live.chat, live.clock, secondWeek(), false);
    const ledgerOk = live.core.verifyLedger().ok;
    live.core.close();

    // The same seed and the same week, under the rule as first written.
    const original = world(dir, "original");
    await promote(original.core, original.chat, original.clock);
    const originalWeek = await runWeek(original.core, original.chat, original.clock, secondWeek(), true);
    original.core.close();

    const { replay } = promoted;
    return {
      experiment: "E6" as const,
      synthetic: true,
      seed: HISTORY_SEED,
      rule: RULE_IN_FORCE,
      rule_change: RULE_CHANGE,
      human_decisions_per_100: { before, after: per100(week.human_decisions, week.actions) },
      proposals_from_seeded_history: promoted.proposals,
      level_after_signing: promoted.level,
      replay: {
        requests: replay.requests,
        counted: replay.counted,
        fast_approvals_excluded: replay.fast_excluded,
        approvers: replay.approvers.length,
        denied: replay.denied,
        would_auto_approve: replay.would_auto,
        would_auto_approve_people_approved: replay.would_auto_approved,
        wrong_auto_approvals: replay.would_auto_denied,
      },
      second_week: week,
      original_rule: {
        rule: ORIGINAL_RULE,
        human_decisions_per_100: { before, after: per100(originalWeek.human_decisions, originalWeek.actions) },
        second_week: originalWeek,
      },
      incident: await incidentDrill(dir),
      ledger_verifies: ledgerOk,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await runAutonomyEval();
  const out = join(REPO_ROOT, "eval/out");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "autonomy.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n${RULE_CHANGE}`);
  console.log(`Synthetic data, labelled. Wrote ${join(out, "autonomy.json")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
