/**
 * F23: what the approval layer did for a team this week, in numbers the records can prove. `@clearance roi`, the daily
 * room document and the Desk's tile all read this one report. It decides nothing and nothing that decides reads it. It
 * writes nothing and calls no model. There is no figure for hours or money saved, because nothing on record could
 * prove one.
 *
 * A room reads this, so the rules are the ledger mirror's and the Desk's team view's (ledger/mirror.ts):
 * - Nothing about any one person: no names, ids or per-person counts. The schema is strict, so one can't slip in.
 * - No time of day, only dates, and a median to the nearest 10 s, and only when it can't be one person's timing.
 * - Drills only as a team total, in whole groups, standing still while one is open.
 *
 * It counts only what has closed, which is what keeps a drill safe here. An approver could otherwise ask for this with
 * a card in front of them and see whether the count moved: a real card would move it and a drill wouldn't. Leaving out
 * every open card means neither does, so the report answers byte for byte the same around a drill.
 *
 * Fails closed on display: null means it couldn't be computed or there's too little to go on, and the words say which.
 * A zero is only ever a real count over real traffic.
 */
import { z } from "zod";
import type { Db } from "../db/index.js";
import { formatMoney, toNumber } from "../format.js";
import { dayOf, DRILL_RESULT_GROUP, drillTotals, wholeDrillGroups } from "../ledger/mirror.js";
import { zonedParts } from "../time.js";
import { isDecision, medianDecisionMs, OPEN_STATES_SQL, readRequestFacts, tallyRequests, type RequestFacts } from "./tally.js";

export const ROI_WINDOW_DAYS = 7;
/** Under this, a rate is one or two calls talking. It's the same bar F11 sets for approvals before a promotion. */
export const MIN_ACTIONS_FOR_RATE = 20;
export const MIN_DECISIONS_FOR_MEDIAN = 5;
/** With fewer, a median is one person's timing, or can be worked out by someone who knows their own. */
export const MIN_PEOPLE_FOR_MEDIAN = DRILL_RESULT_GROUP;
const MEDIAN_STEP_S = 10;

const DAY_MS = 24 * 60 * 60_000;
const count = z.number().int().nonnegative();

const ClassMoneySchema = z
  .object({
    class: z.string(),
    /** False for a class whose calls carry no amount, like a deploy. That isn't zero rupees. */
    has_amount: z.boolean(),
    held_requests: count,
    /** What could be read. Null when none of it could. */
    held_amount: z.number().nonnegative().nullable(),
    held_unreadable: count,
    denied_requests: count,
    denied_amount: z.number().nonnegative().nullable(),
    denied_unreadable: count,
    /** Denied by a policy rule before any card, so no request and no amount on record. */
    rule_denied: count,
  })
  .strict();

export const RoiReportSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    days: count,
    currency: z.string(),
    /** False when the ledger's chain doesn't verify, and then every section below is null. */
    chain_ok: z.boolean(),
    money: z.object({ by_class: z.array(ClassMoneySchema), edited: count }).strict().nullable(),
    ran_alone: z
      .object({
        tool_calls: count,
        /** Null with no traffic: zero of nothing proves nothing. */
        risky_outside_autonomy: count.nullable(),
        shadow_would_hold: count,
        under_autonomy: count.nullable(),
        outcome_unknown: count,
      })
      .strict()
      .nullable(),
    load: z
      .object({
        agent_actions: count,
        human_decisions: count,
        per_100: z.number().nonnegative().nullable(),
        tool_calls: count,
        no_card: count,
        no_card_share: z.number().min(0).max(100).nullable(),
      })
      .strict()
      .nullable(),
    speed: z
      .object({
        closed: count,
        median_seconds: count.nullable(),
        escalated: count.nullable(),
        expired: count.nullable(),
      })
      .strict()
      .nullable(),
    drills: z.object({ finished: count, caught: count, missed: count, expired: count, catch_rate_percent: count.nullable(), group: count }).strict().nullable(),
    synthetic: z.object({ history_rows: count, runs_on_history: count }).strict().nullable(),
    needs: z.object({ actions_for_rate: count, decisions_for_median: count, people_for_median: count }).strict(),
    text: z.string(),
  })
  .strict();

export type RoiReport = z.infer<typeof RoiReportSchema>;
type ClassMoney = z.infer<typeof ClassMoneySchema>;
type Figures = Omit<RoiReport, "text">;

export type RoiInput = {
  db: Db;
  nowMs: number;
  tz: string;
  currency: string;
  /** Classes the policy gives an amount, so one missing from a call is unreadable rather than not applicable. */
  amountClasses: ReadonlySet<string>;
  /** Core's own count of human load, over what has closed since then. */
  humanLoad: (closedSinceMs: number) => { agent_actions: number; human_decisions: number; per_100: number | null };
  chainOk: () => boolean;
  syntheticRows: () => number;
};

/** Never throws out of here: what fails is one section saying so. What went wrong goes in the log and not to the room. */
function attempt<T>(section: string, compute: () => T): T | null {
  try {
    return compute();
  } catch (error) {
    console.error(`roi report: ${section} could not be computed: ${(error as Error).message}`);
    return null;
  }
}

/** Midnight on the team's calendar, on the day this falls in. */
function startOfDay(ms: number, tz: string): number {
  return ms - (ms % 60_000) - zonedParts(ms, tz).minutes * 60_000;
}

/** Today and the six whole days before it, so a window starts somewhere a person would say and doesn't creep. */
function windowStart(nowMs: number, tz: string): number {
  // Midday, so a day that's an hour long or short still lands on the right date.
  return startOfDay(startOfDay(nowMs, tz) - (ROI_WINDOW_DAYS - 1) * DAY_MS + DAY_MS / 2, tz);
}

type ActionRow = { cls: string | null; step: string; decision: string; would_decide: string | null; request_id: string | null; request_state: string | null };

/** Tool calls since then, leaving out any on a card still open. A drill has no row here. */
function readActions(db: Db, sinceMs: number): ActionRow[] {
  return db
    .prepare(
      `SELECT a.class AS cls, a.step, a.decision, a.would_decide, a.request_id, r.state AS request_state
       FROM actions a LEFT JOIN requests r ON r.id = a.request_id
       WHERE julianday(a.at) >= julianday(?) AND (r.id IS NULL OR r.state NOT IN (${OPEN_STATES_SQL}))`,
    )
    .all(new Date(sinceMs).toISOString()) as ActionRow[];
}

/** An amount worth adding: a real number and not below zero. Anything else is unreadable, and is not added as nothing. */
function readableAmount(row: RequestFacts): number | null {
  const amount = toNumber(row.amount);
  return amount !== null && amount >= 0 ? amount : null;
}

const rupeePrecision = (sum: number) => Math.round(sum * 100) / 100;

function moneyFigures(closed: RequestFacts[], actions: ActionRow[], amountClasses: ReadonlySet<string>): NonNullable<Figures["money"]> {
  const held = closed.filter((row) => !row.ranAlone);
  const withAmount = new Set(amountClasses);
  for (const row of held) if (row.hasAmount) withAmount.add(row.cls);

  const rows = new Map<string, ClassMoney & { heldSum: number; heldRead: number; deniedSum: number; deniedRead: number }>();
  const rowFor = (cls: string) => {
    const existing = rows.get(cls);
    if (existing) return existing;
    const row = {
      class: cls,
      has_amount: withAmount.has(cls),
      held_requests: 0,
      held_amount: null,
      held_unreadable: 0,
      denied_requests: 0,
      denied_amount: null,
      denied_unreadable: 0,
      rule_denied: 0,
      heldSum: 0,
      heldRead: 0,
      deniedSum: 0,
      deniedRead: 0,
    };
    rows.set(cls, row);
    return row;
  };

  for (const request of held) {
    const row = rowFor(request.cls);
    const amount = readableAmount(request);
    // An edit's smaller request is the same money the first one held.
    if (!request.editOf) {
      row.held_requests += 1;
      if (amount !== null) {
        row.heldSum += amount;
        row.heldRead += 1;
      } else if (row.has_amount) row.held_unreadable += 1;
    }
    if (request.state === "DENIED") {
      row.denied_requests += 1;
      if (amount !== null) {
        row.deniedSum += amount;
        row.deniedRead += 1;
      } else if (row.has_amount) row.denied_unreadable += 1;
    }
  }
  for (const action of actions) if (action.decision === "deny" && action.cls !== null) rowFor(action.cls).rule_denied += 1;

  return {
    by_class: [...rows.values()]
      .sort((a, b) => a.class.localeCompare(b.class))
      .map(({ heldSum, heldRead, deniedSum, deniedRead, ...row }) => ({
        ...row,
        held_amount: row.has_amount && heldRead > 0 ? rupeePrecision(heldSum) : null,
        denied_amount: row.has_amount && deniedRead > 0 ? rupeePrecision(deniedSum) : null,
      })),
    edited: tallyRequests(held).edited,
  };
}

/** What the policy lets through without a thought, a hook handing a call to the gate, and what a level was earned for. */
const NOT_RISKY_ALONE = new Set(["safe", "unmatched", "via_gate", "autonomy"]);
const RAN = new Set(["AUTO", "EXECUTED"]);

function ranAloneFigures(actions: ActionRow[]): NonNullable<Figures["ran_alone"]> {
  const toolCalls = actions.filter((row) => row.step !== "via_gate").length;
  const allowed = actions.filter((row) => row.decision === "allow");
  // Anything else allowed is the thing this report exists to catch: shadow mode, or a bug. A grant needs a request behind it.
  const outside = allowed.filter((row) => !NOT_RISKY_ALONE.has(row.step) && !(row.step === "grant" && row.request_id !== null));
  const earned = allowed.filter((row) => row.step === "autonomy");
  const anyTraffic = actions.length > 0;
  return {
    tool_calls: toolCalls,
    risky_outside_autonomy: anyTraffic ? outside.length : null,
    shadow_would_hold: actions.filter((row) => row.would_decide === "hold").length,
    // Shadow mode makes no request for it, and it did run.
    under_autonomy: anyTraffic ? earned.filter((row) => row.request_state === null || RAN.has(row.request_state)).length : null,
    outcome_unknown: earned.filter((row) => row.request_state === "OUTCOME_UNKNOWN").length,
  };
}

function loadFigures(input: RoiInput, sinceMs: number, actions: ActionRow[]): NonNullable<Figures["load"]> {
  const load = input.humanLoad(sinceMs);
  // One tool call the hook passes to the gate is seen twice, and its card, if it gets one, belongs to the gate's row.
  const { n: noCard } = input.db
    .prepare(
      `SELECT COUNT(*) AS n FROM actions a LEFT JOIN requests r ON r.id = a.request_id
       WHERE julianday(a.at) >= julianday(?) AND a.step != 'via_gate' AND (r.id IS NULL OR r.state NOT IN (${OPEN_STATES_SQL}))
         AND NOT EXISTS (SELECT 1 FROM routes ro WHERE ro.request_id = a.request_id AND ro.open_state IS NOT 'failed')`,
    )
    .get(new Date(sinceMs).toISOString()) as { n: number };
  const toolCalls = actions.filter((row) => row.step !== "via_gate").length;
  return {
    agent_actions: load.agent_actions,
    human_decisions: load.human_decisions,
    per_100: load.agent_actions >= MIN_ACTIONS_FOR_RATE ? load.per_100 : null,
    tool_calls: toolCalls,
    no_card: noCard,
    no_card_share: toolCalls >= MIN_ACTIONS_FOR_RATE ? Math.round((noCard / toolCalls) * 1000) / 10 : null,
  };
}

function speedFigures(db: Db, sinceMs: number, closed: RequestFacts[]): NonNullable<Figures["speed"]> {
  const tally = tallyRequests(closed);
  if (tally.held === 0) return { closed: 0, median_seconds: null, escalated: null, expired: null };
  // Only the people behind the decisions the median reads. Someone who reviewed a run alone doesn't blur anyone's timing.
  const decided = new Set(closed.filter(isDecision).map((row) => row.id));
  const answers = db
    .prepare(
      `SELECT a.request_id, a.user_id FROM answers a JOIN requests r ON r.id = a.request_id
       WHERE a.eligible = 1 AND a.decision IS NOT NULL AND a.user_id IS NOT NULL AND r.is_drill = 0 AND r.created_at >= ?`,
    )
    .all(sinceMs) as { request_id: string; user_id: string }[];
  const people = new Set(answers.filter((answer) => decided.has(answer.request_id)).map((answer) => answer.user_id)).size;
  const { escalated } = db
    .prepare(
      `SELECT COUNT(DISTINCT l.request_id) AS escalated FROM ledger l JOIN requests r ON r.id = l.request_id
       WHERE l.type = 'escalated' AND r.is_drill = 0 AND r.created_at >= ? AND r.state NOT IN (${OPEN_STATES_SQL})`,
    )
    .get(sinceMs) as { escalated: number };
  const median = medianDecisionMs(closed);
  const enough = median !== null && decided.size >= MIN_DECISIONS_FOR_MEDIAN && people >= MIN_PEOPLE_FOR_MEDIAN;
  return {
    closed: tally.held,
    median_seconds: enough ? Math.round(median / 1000 / MEDIAN_STEP_S) * MEDIAN_STEP_S : null,
    escalated,
    expired: tally.expired,
  };
}

/** The team view's rule (Desk's team-view.ts): up to the first drill still open, and all time, as whole groups can't slide. */
function drillResults(db: Db): string[] {
  const { first } = db
    .prepare(
      `SELECT MIN(l.seq) AS first FROM ledger l JOIN requests r ON r.id = l.request_id
       WHERE l.type = 'drill_sent' AND r.is_drill = 1 AND r.state IN (${OPEN_STATES_SQL})`,
    )
    .get() as { first: number | null };
  const rows = db.prepare(`SELECT payload FROM ledger WHERE type = 'drill_result' AND seq < ? ORDER BY seq`).all(first ?? Number.MAX_SAFE_INTEGER) as { payload: string }[];
  return rows.map((row) => String((JSON.parse(row.payload) as { result?: unknown }).result));
}

function drillFigures(results: string[]): NonNullable<Figures["drills"]> {
  const groups = wholeDrillGroups(results);
  const answered = groups.caught + groups.missed;
  return { ...groups, catch_rate_percent: answered > 0 ? Math.round((groups.caught / answered) * 100) : null, group: DRILL_RESULT_GROUP };
}

function syntheticFigures(input: RoiInput, sinceMs: number): NonNullable<Figures["synthetic"]> {
  const { n } = input.db
    .prepare(
      `SELECT COUNT(*) AS n FROM actions a JOIN requests r ON r.id = a.request_id
       WHERE a.step = 'autonomy' AND r.created_at >= ? AND r.state IN ('AUTO', 'EXECUTED')
         AND EXISTS (SELECT 1 FROM bucket_events b WHERE b.synthetic = 1 AND b.agent = r.agent AND b.class = r.class
                     AND b.bucket = CASE WHEN json_valid(r.evidence) THEN json_extract(r.evidence, '$.bucket') END)`,
    )
    .get(sinceMs) as { n: number };
  return { history_rows: input.syntheticRows(), runs_on_history: n };
}

// ── In words ─────────────────────────────────────────────────────────────────

const NOT_COMPUTED = "- Couldn't be computed just now.";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function moneyLine(row: ClassMoney, currency: string): string {
  const notes: string[] = [];
  if (row.held_amount !== null && row.held_unreadable > 0) notes.push(`${row.held_unreadable} held ${row.held_unreadable === 1 ? "has" : "have"} no readable amount, so the total leaves ${row.held_unreadable === 1 ? "it" : "them"} out.`);
  if (row.denied_amount !== null && row.denied_unreadable > 0) notes.push(`${row.denied_unreadable} denied ${row.denied_unreadable === 1 ? "has" : "have"} no readable amount, so the total leaves ${row.denied_unreadable === 1 ? "it" : "them"} out.`);
  const byRule = `${plural(row.rule_denied, "call")} before any card`;
  const anything = row.held_requests > 0 || row.denied_requests > 0;
  let main: string;
  if (!row.has_amount) {
    if (!anything) return `- ${row.class}: a policy rule denied ${byRule}.`;
    main = `${row.held_requests} held, ${row.denied_requests} denied. This class has no amount.`;
  } else if (anything && row.held_amount === null && row.denied_amount === null) {
    main = `${row.held_requests} held and ${row.denied_requests} denied, and no amount could be read.`;
  } else {
    const held = row.held_requests === 0 ? "nothing held" : row.held_amount === null ? `${row.held_requests} held with no readable amount` : `${formatMoney(row.held_amount, currency)} held on ${plural(row.held_requests, "request")}`;
    const denied = row.denied_requests === 0 ? "none denied" : row.denied_amount === null ? `${row.denied_requests} denied with no readable amount` : `${formatMoney(row.denied_amount, currency)} denied on ${row.denied_requests}`;
    main = `${held}, ${denied}.`;
  }
  if (row.rule_denied > 0) notes.push(`A policy rule also denied ${byRule}, and their amounts aren't on record.`);
  return [`- ${row.class}: ${main}`, ...notes].join(" ");
}

function moneyLines({ money, currency }: Figures): string[] {
  if (!money) return [NOT_COMPUTED];
  if (money.by_class.length === 0) return ["- Too little data: no held request has closed in these days."];
  const smaller = money.edited === 0 ? [] : [`- ${money.edited === 1 ? "1 was" : `${money.edited} were`} approved for a smaller amount, as a new request that isn't counted as held again.`];
  return [...money.by_class.map((row) => moneyLine(row, currency)), ...smaller];
}

function ranAloneLines({ ran_alone: ran }: Figures): string[] {
  if (!ran) return [NOT_COMPUTED];
  if (ran.risky_outside_autonomy === null || ran.under_autonomy === null) return ["- Too little data: no tool calls are on record in these days."];
  const shadow = ran.shadow_would_hold > 0 ? ` ${ran.shadow_would_hold} of them because the policy is in shadow mode, which holds nothing.` : "";
  const outside = ran.risky_outside_autonomy === 0 ? "- Outside earned autonomy: 0." : `- Outside earned autonomy: ${ran.risky_outside_autonomy}. This should be zero, so it's worth a look.${shadow}`;
  const unknown = ran.outcome_unknown > 0 ? ` ${ran.outcome_unknown === 1 ? "1 more was" : `${ran.outcome_unknown} more were`} sent and nobody can say whether ${ran.outcome_unknown === 1 ? "it" : "they"} ran.` : "";
  return [outside, `- Under earned autonomy: ${ran.under_autonomy}.${unknown}`];
}

function loadLines({ load }: Figures): string[] {
  if (!load) return [NOT_COMPUTED];
  const decisions =
    load.per_100 !== null
      ? `${load.per_100} (${plural(load.human_decisions, "decision")}, ${plural(load.agent_actions, "action")})`
      : `too little data. ${plural(load.agent_actions, "action")} so far, and a rate needs ${MIN_ACTIONS_FOR_RATE}`;
  const noCard = load.no_card_share !== null ? `${load.no_card} of ${load.tool_calls} (${load.no_card_share}%)` : `too little data. ${plural(load.tool_calls, "call")} so far, and a rate needs ${MIN_ACTIONS_FOR_RATE}`;
  return [`- Human decisions per 100 agent actions: ${decisions}.`, `- Tool calls with no card: ${noCard}.`];
}

function speedLines({ speed }: Figures): string[] {
  if (!speed) return [NOT_COMPUTED];
  if (speed.closed === 0) return ["- Too little data: no held request has closed in these days."];
  const median =
    speed.median_seconds === null
      ? `too little data. It needs ${MIN_DECISIONS_FOR_MEDIAN} decisions from ${MIN_PEOPLE_FOR_MEDIAN} people, so that it isn't one person's timing`
      : `${speed.median_seconds === 0 ? `under ${MEDIAN_STEP_S / 2} s` : `${speed.median_seconds} s`}, to the nearest ${MEDIAN_STEP_S} s`;
  return [`- Median time from hold to decision: ${median}.`, `- Escalated: ${speed.escalated}. Expired with no decision: ${speed.expired}.`];
}

function drillLines({ drills }: Figures, results: string[] | null): string[] {
  if (!drills || !results) return [NOT_COMPUTED];
  return [`- ${drillTotals(results)}${drills.catch_rate_percent === null ? "" : ` Catch rate: ${drills.catch_rate_percent}%.`}`];
}

function syntheticLines({ synthetic }: Figures): string[] {
  // Not knowing whether there's seeded history is not the same as there being none.
  if (!synthetic) return ["Synthetic: couldn't check for seeded history just now, so treat these numbers with care.", ""];
  if (synthetic.history_rows === 0) return [];
  const runs = synthetic.runs_on_history;
  const standing = runs === 0 ? "" : runs === 1 ? " 1 of the earned-autonomy runs here is in a bucket whose evidence includes it." : ` ${runs} of the earned-autonomy runs here are in buckets whose evidence includes it.`;
  return [`Synthetic: ${synthetic.history_rows} rows of seeded history are on record, labelled synthetic. None are counted here.${standing}`, ""];
}

/** The one place the report turns into words. The command and the room document both say exactly this. */
export function renderRoi(figures: Figures, results: string[] | null): string {
  const head = `Clearance report, last ${figures.days} days: ${figures.from} to ${figures.to}. It counts what has closed: a card still open joins once it closes. Nothing here is estimated.`;
  if (!figures.chain_ok) return `${head}\n\nThe ledger's hash chain doesn't verify, so this report shows no numbers. Check it with \`pnpm ledger:verify\`.`;
  return [
    head,
    "",
    ...syntheticLines(figures),
    "Money held and denied, by class:",
    ...moneyLines(figures),
    "",
    "Risky actions that ran without a person:",
    ...ranAloneLines(figures),
    "",
    "People's time:",
    ...loadLines(figures),
    ...speedLines(figures),
    "",
    "Drills, team total, all time:",
    ...drillLines(figures, results),
  ].join("\n");
}

export function buildRoiReport(input: RoiInput): RoiReport {
  const { db, nowMs, tz, currency } = input;
  const sinceMs = windowStart(nowMs, tz);
  const base = {
    from: dayOf(new Date(sinceMs).toISOString(), tz),
    to: dayOf(new Date(nowMs).toISOString(), tz),
    days: ROI_WINDOW_DAYS,
    currency,
    needs: { actions_for_rate: MIN_ACTIONS_FOR_RATE, decisions_for_median: MIN_DECISIONS_FOR_MEDIAN, people_for_median: MIN_PEOPLE_FOR_MEDIAN },
  };
  const chainOk = attempt("the ledger check", input.chainOk) === true;
  const nothing: Figures = { ...base, chain_ok: chainOk, money: null, ran_alone: null, load: null, speed: null, drills: null, synthetic: null };
  let figures = nothing;
  let results: string[] | null = null;
  if (chainOk) {
    const requests = attempt("requests", () => readRequestFacts(db, sinceMs - 1));
    const closed = requests?.filter((row) => row.state !== "HELD" && row.state !== "ROUTED") ?? null;
    const actions = attempt("tool calls", () => readActions(db, sinceMs));
    results = attempt("drills", () => drillResults(db));
    figures = {
      ...figures,
      money: closed && actions ? attempt("money", () => moneyFigures(closed, actions, input.amountClasses)) : null,
      ran_alone: actions ? attempt("what ran alone", () => ranAloneFigures(actions)) : null,
      load: actions ? attempt("human load", () => loadFigures(input, sinceMs, actions)) : null,
      speed: closed ? attempt("speed", () => speedFigures(db, sinceMs, closed)) : null,
      drills: results ? attempt("drill totals", () => drillFigures(results as string[])) : null,
      synthetic: attempt("synthetic history", () => syntheticFigures(input, sinceMs)),
    };
  }
  // A figure that doesn't fit the report's own shape isn't one to show, and neither is anything computed beside it.
  const report = RoiReportSchema.safeParse({ ...figures, text: renderRoi(figures, results) });
  if (report.success) return report.data;
  console.error(`roi report: refused its own figures at ${report.error.issues[0]?.path.join(".")}`);
  return { ...nothing, text: renderRoi(nothing, null) };
}
