/**
 * Copies the ledger into room documents in #approvals, so the team can read it in Switch (F8).
 *
 * SQLite is the truth and this is a copy. Nothing that decides waits on it, and a failed copy loses
 * nothing: `ledger_mirror_seq` moves only after Switch has taken a document, and the next try rebuilds
 * from SQLite. Rebuilding gives the same documents every time, because which entries share a document
 * depends only on the entries, and they never change.
 *
 * Each create or update of a document posts a notice in the room, so this runs at most every 5 real
 * minutes (not scaled by CLEARANCE_TIME_SCALE), and only when something changed. `flush` is on demand.
 *
 * Approvers read this room, and a drill only works if it can't be told from a real request (PLAN F9). What
 * is left out can give it away as surely as what is put in: a gap in the entry numbers beside a card's
 * arrival, a card missing from the open list, or `clearance-state` changing with no ledger change. So:
 * - While any drill is open, the whole mirror stands still. Nothing is written, so nothing can differ. A
 *   document's "as of" time comes before that drill and before every later request alike.
 * - A drill's entries are never copied, even after it closes, because they say who answered what. That
 *   covers every entry on its request, not only `drill_*`.
 * - The team gets totals only, in groups, so that no total is one person's result.
 *
 * A person sees it as the notice in the room and on the room's page in the Gateway. `!list-documents`
 * crashes at Switch's pin (DECISIONS 03:20).
 */
import { type ChatPort, type Clock } from "@clearance/contracts";
import type { Clearance } from "../core.js";
import type { Db } from "../db/index.js";
import { OPEN_STATES } from "../requests/store.js";
import { formatClockWithZone } from "../time.js";
import { sha256Hex } from "../hash.js";
import type { Ledger, LedgerEntry } from "./ledger.js";

export const MIRROR_EVERY_MS = 5 * 60_000;
const RETRY_AFTER_MS = 60_000;
/** Switch refuses over 1,048,576 bytes. A margin, so a document never gets near it. */
export const MAX_DOCUMENT_BYTES = 1_000_000;
const DAY_MS = 24 * 60 * 60_000;
export const STATE_DOCUMENT = "clearance-state";
/** Totals move in steps of this, so that comparing two of them can't isolate one person's result. */
export const DRILL_RESULT_GROUP = 3;

const META_SEQ = "ledger_mirror_seq";
const META_AT = "ledger_mirror_at";
const META_STATE = "ledger_mirror_state";

const FENCE = "```";

export type MirrorDocument = { name: string; content: string; firstSeq: number; lastSeq: number };

export type MirrorReport = {
  ok: boolean;
  mirrored_seq: number;
  head_seq: number;
  documents: string[];
  state_updated: boolean;
  error: string | null;
};

export type MirrorStatus = {
  mirrored_seq: number;
  head_seq: number;
  last_mirrored_at: string | null;
  last_error: string | null;
};

/** The date in the team's zone, which is the date the team would look for. */
export function dayOf(at: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

function headerFor(name: string, firstSeq: number, lastSeq: number): string {
  return [
    `# ${name}`,
    "",
    `Ledger entries ${firstSeq} to ${lastSeq}, one JSON object per line, in order. Each holds the hash of the entry before it.`,
    "Drills are left out, so the numbers can skip. `clearance-state` has their totals.",
    "This is a copy and can lag behind. The truth is Clearance's SQLite ledger: check it with `pnpm ledger:verify` or `GET /v1/ledger/verify`.",
    "",
    FENCE,
    "",
  ].join("\n");
}

/** An entry too big for any document keeps its place in the chain, and says where the rest is. */
function lineFor(entry: LedgerEntry, maxBytes: number): string {
  const whole = JSON.stringify(entry);
  if (Buffer.byteLength(whole) <= maxBytes) return whole;
  const { payload, ...rest } = entry;
  return JSON.stringify({
    ...rest,
    payload_omitted: `${Buffer.byteLength(JSON.stringify(payload))} bytes: read it with GET /v1/ledger?after=${entry.seq - 1}&limit=1`,
  });
}

/**
 * Entries in seq order into documents: one per day in the team's zone, and `-2`, `-3` when a day
 * overflows. A day never goes backwards, even if a clock does, so each document is an unbroken run of
 * entries and the mirror's position can be a single number.
 */
export function ledgerDocuments(entries: LedgerEntry[], options: { tz: string; maxBytes?: number }): MirrorDocument[] {
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_BYTES;
  // Room for the header and closing fence, whatever the seq numbers come to.
  const room = maxBytes - Buffer.byteLength(headerFor(`clearance-ledger-0000-00-00-000`, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) - 8;
  const documents: MirrorDocument[] = [];
  let day = "";
  let part = 1;
  let lines: string[] = [];
  let bytes = 0;
  let firstSeq = 0;
  let lastSeq = 0;
  const finish = () => {
    if (lines.length === 0) return;
    const name = part === 1 ? `clearance-ledger-${day}` : `clearance-ledger-${day}-${part}`;
    documents.push({ name, firstSeq, lastSeq, content: `${headerFor(name, firstSeq, lastSeq)}${lines.join("\n")}\n${FENCE}\n` });
    lines = [];
    bytes = 0;
  };
  for (const entry of entries) {
    const entryDay = dayOf(entry.at, options.tz);
    if (entryDay > day) {
      finish();
      day = entryDay;
      part = 1;
    }
    const line = lineFor(entry, room - 1);
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > room) {
      finish();
      part += 1;
    }
    if (lines.length === 0) firstSeq = entry.seq;
    lines.push(line);
    bytes += size;
    lastSeq = entry.seq;
  }
  finish();
  return documents;
}

export type LedgerMirrorDeps = {
  db: Db;
  ledger: Ledger;
  chat: Pick<ChatPort, "upsertDocument">;
  clock: Clock;
  /** The room, looked up each time: `@clearance install` can create it while this runs. */
  roomId: () => string;
  tz: () => string;
  /** The body of `clearance-state`, with nothing in it that changes on its own. */
  state: () => string;
  maxBytes?: number;
  log?: (message: string) => void;
};

export class LedgerMirror {
  private running: Promise<MirrorReport> | null = null;
  private retryAt = 0;
  private lastError: string | null = null;

  constructor(private readonly deps: LedgerMirrorDeps) {}

  /** Called often. Starts a copy if one is due and returns at once: nothing waits on the mirror. */
  tick(): void {
    if (this.running) return;
    const now = this.deps.clock.nowMs();
    if (now < this.retryAt || now < this.readNumber(META_AT) + MIRROR_EVERY_MS) return;
    void this.flush();
  }

  /** Copies whatever is new, now. Never throws; a failure is in the report and is tried again later. */
  flush(): Promise<MirrorReport> {
    this.running ??= this.copy().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  status(): MirrorStatus {
    const at = this.readNumber(META_AT);
    return {
      mirrored_seq: this.readNumber(META_SEQ),
      head_seq: this.headSeq(),
      last_mirrored_at: at > 0 ? new Date(at).toISOString() : null,
      last_error: this.lastError,
    };
  }

  private async copy(): Promise<MirrorReport> {
    const documents: string[] = [];
    let stateUpdated = false;
    let error: string | null = null;
    try {
      if (this.drillIsOpen()) return this.reportOf(documents, false, null);
      const roomId = this.deps.roomId();
      // Read in one go with the check above: nothing else runs until the first await.
      const through = this.headSeq();
      const pending = this.pendingDocuments();
      for (const document of pending) {
        await this.deps.chat.upsertDocument({ roomId, name: document.name, content: document.content });
        this.writeMeta(META_SEQ, String(document.lastSeq));
        documents.push(document.name);
      }
      // What is left beyond the last document can only be a drill's. There is nothing to copy for it.
      this.writeMeta(META_SEQ, String(through));
      // A drill may have opened during those awaits. Then a state change alone would point at it.
      const state = this.deps.state();
      const hash = sha256Hex(state);
      if (!this.drillIsOpen() && this.readText(META_STATE) !== hash) {
        await this.deps.chat.upsertDocument({ roomId, name: STATE_DOCUMENT, content: this.stateDocument(state) });
        this.writeMeta(META_STATE, hash);
        stateUpdated = true;
      }
      if (documents.length > 0 || stateUpdated) this.writeMeta(META_AT, String(this.deps.clock.nowMs()));
      this.retryAt = 0;
    } catch (caught) {
      error = (caught as Error).message;
      this.retryAt = this.deps.clock.nowMs() + RETRY_AFTER_MS;
      this.deps.log?.(`ledger mirror: ${error}. The entries are safe in SQLite and it will try again.`);
    }
    this.lastError = error;
    return this.reportOf(documents, stateUpdated, error);
  }

  private reportOf(documents: string[], stateUpdated: boolean, error: string | null): MirrorReport {
    return {
      ok: error === null,
      mirrored_seq: this.readNumber(META_SEQ),
      head_seq: this.headSeq(),
      documents,
      state_updated: stateUpdated,
      error,
    };
  }

  private drillIsOpen(): boolean {
    const row = this.deps.db
      .prepare(`SELECT 1 FROM requests WHERE is_drill = 1 AND state IN (${OPEN_STATES.map(() => "?").join(", ")}) LIMIT 1`)
      .get(...OPEN_STATES);
    return row !== undefined;
  }

  /** A drill's own entries, and anything else on its request, which can say who answered it and how. */
  private publishable(entries: LedgerEntry[]): LedgerEntry[] {
    const rows = this.deps.db.prepare(`SELECT id FROM requests WHERE is_drill = 1`).all() as { id: string }[];
    const drills = new Set(rows.map((row) => row.id));
    return entries.filter((entry) => !entry.type.startsWith("drill_") && !(entry.request_id !== null && drills.has(entry.request_id)));
  }

  /** Documents holding anything not yet copied. A day's document is rewritten whole, so the day is read whole. */
  private pendingDocuments(): MirrorDocument[] {
    const mirrored = this.readNumber(META_SEQ);
    const next = this.deps.ledger.list({ afterSeq: mirrored, limit: 1 })[0];
    if (!next) return [];
    // Back far enough to take in the start of the day that entry is in, whatever the zone.
    const from = new Date(Date.parse(next.at) - 2 * DAY_MS).toISOString();
    const row = this.deps.db.prepare(`SELECT MIN(seq) AS seq FROM ledger WHERE at >= ?`).get(from) as { seq: number | null };
    const start = Math.min(row.seq ?? next.seq, next.seq);
    const documents = ledgerDocuments(this.publishable(this.deps.ledger.list({ afterSeq: start - 1 })), {
      tz: this.deps.tz(),
      ...(this.deps.maxBytes !== undefined ? { maxBytes: this.deps.maxBytes } : {}),
    });
    return documents.filter((document) => document.lastSeq > mirrored);
  }

  private stateDocument(state: string): string {
    const asOf = formatClockWithZone(this.deps.clock.nowMs(), this.deps.tz());
    return `# Clearance state\n\nAs of ${dayOf(new Date(this.deps.clock.nowMs()).toISOString(), this.deps.tz())} ${asOf}. Written by Clearance; the SQLite ledger is the truth.\n\n${state}\n`;
  }

  private headSeq(): number {
    const row = this.deps.db.prepare(`SELECT MAX(seq) AS seq FROM ledger`).get() as { seq: number | null };
    return row.seq ?? 0;
  }

  private readText(key: string): string | null {
    const row = this.deps.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private readNumber(key: string): number {
    return Number(this.readText(key) ?? 0);
  }

  private writeMeta(key: string, value: string): void {
    this.deps.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
}

/** What `clearance-state` says. Times are absolute, so it only changes when the facts do. */
export function renderClearanceState(input: {
  policyHash: string;
  tz: string;
  open: { id: string; what: string; tier: string; state: string; agent: string; room: string | null; createdAtMs: number; expiresAtMs: number; approvals: number; quorum: number; holders: string[] }[];
  autonomy: { agent: string; class: string; bucket: string; level: string; since: number }[];
  /** Every finished drill's result, oldest first. */
  drillResults?: string[];
}): string {
  const clock = (ms: number) => formatClockWithZone(ms, input.tz);
  const open = input.open.map((request) => {
    const room = request.room ? ` · ${request.room}` : "";
    const holders = request.holders.length > 0 ? ` · with ${request.holders.join(", ")}` : "";
    return `- ${request.id} · ${request.what} · ${request.tier} · ${request.state} · ${request.agent}${room} · held ${clock(request.createdAtMs)} · expires ${clock(request.expiresAtMs)} · ${request.approvals} of ${request.quorum} approvals${holders}`;
  });
  const autonomy = input.autonomy.map((row) => `- ${row.agent} · ${row.class} · ${row.bucket} · ${row.level} since ${dayOf(new Date(row.since).toISOString(), input.tz)}`);
  return [
    `Policy: ${input.policyHash}`,
    "",
    `## Open requests (${open.length})`,
    ...(open.length > 0 ? open : ["None."]),
    "",
    `## Autonomy levels (${autonomy.length})`,
    ...(autonomy.length > 0 ? autonomy : ["None earned: every protected action asks a person."]),
    "",
    "## Drills",
    drillTotals(input.drillResults ?? []),
  ].join("\n");
}

/**
 * Whole groups only, so "1 finished, 0 caught" can never appear, and neither can two totals that differ by
 * one person. Always the same section, so that its being there says nothing. A drill nobody saw isn't one.
 */
export function drillTotals(results: string[]): string {
  const finished = results.filter((result) => result !== "not_sent");
  const counted = finished.slice(0, finished.length - (finished.length % DRILL_RESULT_GROUP));
  if (counted.length === 0) return `Totals appear once ${DRILL_RESULT_GROUP} have finished, so that nobody's own result can be worked out.`;
  const count = (result: string) => counted.filter((entry) => entry === result).length;
  return `${counted.length} finished: ${count("caught")} caught, ${count("missed")} missed, ${count("expired")} not answered. Totals move in steps of ${DRILL_RESULT_GROUP}, so that nobody's own result can be worked out.`;
}

function stateOf(core: Clearance): string {
  const { requests, routes, answers, autonomy } = core.stores;
  const { directory } = core.people;
  const open = requests.listInState(OPEN_STATES).map((request) => ({
    id: request.id,
    what: (request.evidence as unknown as { description: { headline: string } }).description.headline,
    tier: request.tier,
    state: request.state,
    agent: request.agent,
    room: request.originRoom ? directory.roomName(request.originRoom) : null,
    createdAtMs: request.createdAtMs,
    expiresAtMs: request.expiresAtMs,
    approvals: answers.countedApprovers(request.id).length,
    quorum: request.quorumRequired,
    holders: routes.openForRequest(request.id).flatMap((row) => (row.user_id ? [directory.person(row.user_id)?.name ?? row.user_id] : [])),
  }));
  const policy = core.policy();
  const results = core.stores.db.prepare(`SELECT payload FROM ledger WHERE type = 'drill_result' ORDER BY seq`).all() as { payload: string }[];
  return renderClearanceState({
    policyHash: policy.hash,
    tz: policy.defaults.business_hours.tz,
    open,
    autonomy: autonomy.all(),
    drillResults: results.map((row) => String((JSON.parse(row.payload) as { result?: unknown }).result)),
  });
}

/** A mirror over a running core, into the room the policy calls `policyRoom`. */
export function createLedgerMirror(
  core: Clearance,
  options: Pick<LedgerMirrorDeps, "chat" | "clock" | "maxBytes" | "log"> & { policyRoom: string },
): LedgerMirror {
  const { policyRoom, ...rest } = options;
  return new LedgerMirror({
    ...rest,
    db: core.stores.db,
    ledger: core.stores.ledger,
    roomId: () => core.people.directory.roomId(policyRoom),
    tz: () => core.policy().defaults.business_hours.tz,
    state: () => stateOf(core),
  });
}
