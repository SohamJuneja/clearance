/**
 * What happened in each autonomy bucket: the evidence promotion reads and replay runs over. One row per decided
 * request of a class that has a ladder. `fields` are the call's extracted values, so a rule can be replayed later.
 * Synthetic rows are labelled, stay out of the ledger, and are only ever written by the seed.
 */
import type { Db } from "../db/index.js";
import { toNumber } from "../format.js";

export type EventOutcome = "approved" | "denied" | "auto";

export type NewBucketEvent = {
  agent: string;
  cls: string;
  /** Null when the call fell outside every bucket: replay still sees it. */
  bucket: string | null;
  requestId: string | null;
  atMs: number;
  fields: Record<string, unknown>;
  outcome: EventOutcome;
  approvers: string[];
  fast: boolean;
  edited: boolean;
  incident: boolean;
  /** Whether autonomy could have run it: no forced hold, no missing data, not critical. */
  autoEligible: boolean;
  synthetic: boolean;
};

export type BucketEvent = NewBucketEvent & { id: number };

type Row = {
  id: number;
  agent: string;
  class: string;
  bucket: string | null;
  request_id: string | null;
  at: number;
  fields: string;
  outcome: EventOutcome;
  approvers: string;
  fast: number;
  edited: number;
  incident: number;
  auto_eligible: number;
  synthetic: number;
};

function fromRow(row: Row): BucketEvent {
  return {
    id: row.id,
    agent: row.agent,
    cls: row.class,
    bucket: row.bucket,
    requestId: row.request_id,
    atMs: row.at,
    fields: JSON.parse(row.fields) as Record<string, unknown>,
    outcome: row.outcome,
    approvers: JSON.parse(row.approvers) as string[],
    fast: row.fast === 1,
    edited: row.edited === 1,
    incident: row.incident === 1,
    autoEligible: row.auto_eligible === 1,
    synthetic: row.synthetic === 1,
  };
}

export class BucketEventStore {
  constructor(private readonly db: Db) {}

  /** Something allowed to run alone turned out not to have run, so it was never evidence or spend. */
  forgetAuto(requestId: string): void {
    this.db.prepare(`DELETE FROM bucket_events WHERE request_id = ? AND outcome = 'auto'`).run(requestId);
  }

  add(event: NewBucketEvent): void {
    this.db
      .prepare(
        `INSERT INTO bucket_events (agent, class, bucket, request_id, at, fields, amount, outcome, approvers, fast, edited, incident, auto_eligible, synthetic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.agent,
        event.cls,
        event.bucket,
        event.requestId,
        event.atMs,
        JSON.stringify(event.fields),
        toNumber(event.fields.amount),
        event.outcome,
        JSON.stringify(event.approvers),
        event.fast ? 1 : 0,
        event.edited ? 1 : 0,
        event.incident ? 1 : 0,
        event.autoEligible ? 1 : 0,
        event.synthetic ? 1 : 0,
      );
  }

  /** Oldest first, this class and agent, from `sinceMs` on. */
  forClass(cls: string, agent: string, sinceMs: number): BucketEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM bucket_events WHERE class = ? AND agent = ? AND at >= ? ORDER BY at, id`)
      .all(cls, agent, sinceMs) as Row[];
    return rows.map(fromRow);
  }

  agents(cls: string, sinceMs: number): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT agent FROM bucket_events WHERE class = ? AND at >= ? ORDER BY agent`)
      .all(cls, sinceMs) as { agent: string }[];
    return rows.map((row) => row.agent);
  }

  markIncident(requestId: string): void {
    this.db.prepare(`UPDATE bucket_events SET incident = 1 WHERE request_id = ?`).run(requestId);
  }

  /** A person has now looked at something that ran by itself. Their review is what counts from here. */
  markReviewed(requestId: string, outcome: EventOutcome, approvers: string[], fast: boolean): void {
    this.db
      .prepare(`UPDATE bucket_events SET outcome = ?, approvers = ?, fast = ? WHERE request_id = ?`)
      .run(outcome, JSON.stringify(approvers), fast ? 1 : 0, requestId);
  }

  counts(): { synthetic: number; real: number } {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(synthetic = 1), 0) AS synthetic, COALESCE(SUM(synthetic = 0), 0) AS real FROM bucket_events`)
      .get() as { synthetic: number; real: number };
    return { synthetic: row.synthetic, real: row.real };
  }

  /** What ran by itself since then, for the digest. */
  autoRuns(sinceMs: number): BucketEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM bucket_events WHERE at >= ? AND synthetic = 0 AND request_id IN (SELECT id FROM requests WHERE state = 'AUTO') ORDER BY at, id`)
      .all(sinceMs) as Row[];
    return rows.map(fromRow);
  }

  clearSynthetic(): void {
    this.db.prepare(`DELETE FROM bucket_events WHERE synthetic = 1`).run();
  }
}

// ── The seeded week (E6). Synthetic, and labelled so everywhere it shows. ──────

export const HISTORY_SEED = 20261107;

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

/** mulberry32: small, and the same on every machine. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const roundTo = (value: number, step: number): number => Math.round(value / step) * step;

export type RefundDraw = { amount: number; small: boolean; flawed: boolean };

/** One refund's amount: about 85% at or below ₹5,000, and the larger ones are where the flawed ones are. */
export function drawRefund(random: () => number): RefundDraw {
  const small = random() < 0.85;
  if (small) return { amount: roundTo(200 + 4700 * random() ** 1.3, 50), small, flawed: false };
  const amount = roundTo(5500 + 34500 * random() ** 2, 100);
  return { amount, small, flawed: random() < 0.35 };
}

export function seededRandom(seed: number): () => number {
  return prng(seed);
}

/**
 * 120 refunds by refunds-agent over seven days, which earn one proposal. The two other ladders are there to show
 * the criteria saying no: ops-agent's staging deploys have a denial, support-agent's plain replies one approver.
 */
export function generateSyntheticHistory(seed: number, nowMs: number): NewBucketEvent[] {
  const random = prng(seed);
  const when = () => nowMs - HOUR - Math.floor(random() * (WEEK - 2 * HOUR));
  const events: NewBucketEvent[] = [];
  const base = { requestId: null, edited: false, incident: false, synthetic: true };
  for (let index = 0; index < 120; index += 1) {
    const { amount, small, flawed } = drawRefund(random);
    const fields = {
      amount,
      customer: `cus_syn_${String(index).padStart(4, "0")}`,
      order: `A-${3000 + index}`,
      destination: `synthetic${index}@okhdfc`,
    };
    const approver = random() < 0.6 ? "sam" : "neha";
    events.push({
      ...base,
      agent: "refunds-agent",
      cls: "refund",
      bucket: small ? "small" : null,
      atMs: when(),
      fields,
      outcome: flawed ? "denied" : "approved",
      approvers: [approver],
      fast: !flawed && random() < 0.08,
      autoEligible: small && random() > 0.05,
    });
  }
  for (let index = 0; index < 25; index += 1) {
    events.push({
      ...base,
      agent: "ops-agent",
      cls: "deploy",
      bucket: "staging",
      atMs: when(),
      fields: { env: "staging", service: "checkout", version: `v2.${index}.0` },
      outcome: index === 24 ? "denied" : "approved",
      approvers: [index % 2 === 0 ? "alex" : "dev"],
      fast: false,
      autoEligible: true,
    });
  }
  for (let index = 0; index < 30; index += 1) {
    events.push({
      ...base,
      agent: "support-agent",
      cls: "customer_email",
      bucket: "plain_reply",
      atMs: when(),
      fields: { attachments: 0, domain: "gmail.com" },
      outcome: "approved",
      approvers: ["priya"],
      fast: false,
      autoEligible: true,
    });
  }
  return events.sort((a, b) => a.atMs - b.atMs);
}

/** Replaces any earlier synthetic rows, in one transaction. Real rows and the ledger are left alone. */
export function seedSyntheticHistory(db: Db, seed: number, nowMs: number): { events: number; refunds: number; seed: number } {
  const store = new BucketEventStore(db);
  const events = generateSyntheticHistory(seed, nowMs);
  const write = db.transaction(() => {
    store.clearSynthetic();
    for (const event of events) store.add(event);
  });
  write.immediate();
  return { events: events.length, refunds: events.filter((event) => event.cls === "refund").length, seed };
}
