/**
 * What the team may read of the ledger. The Desk has no login, so anyone who opens it counts as the team, and an
 * approver who could spot a live drill here would make the drill worthless (PLAN F9).
 *
 * The rule is the ledger mirror's (packages/core/src/ledger/mirror.ts), because the same people read both:
 * - A drill's entries are never shown, even once it has closed. That covers every entry on its request, not only
 *   the `drill_*` ones: a refused answer on it says who tried.
 * - While any drill is open the list stands still at the entry before that drill. Filtering alone would not do: a
 *   hole in the numbers, or a count that moves with no new row, points at the card that just arrived.
 * - The team gets drill totals only in whole groups, so that no total is one person's result.
 *
 * All of this runs on the Desk's server, so nothing it holds back ever reaches a browser.
 */
import type { LedgerEntry, TeamDrills } from "../shared/api";

/** Totals move in steps of this, so that comparing two of them can't isolate one person's result. */
const DRILL_RESULT_GROUP = 3;

export type TeamLedger = {
  entries: LedgerEntry[];
  /** True while a drill is open and later entries are held back. Stays on the server: the page must not know. */
  holdingBack: boolean;
  /** Every finished drill's result that has come through, oldest first. */
  drillResults: string[];
};

const isDrillEntry = (entry: LedgerEntry) => entry.type.startsWith("drill_");

/** Drills with no result yet. Core has the last word on these: see `readTeamLedger`. */
export function drillsWithoutResult(entries: LedgerEntry[]): string[] {
  const finished = new Set(entries.filter((entry) => entry.type === "drill_result").map((entry) => entry.request_id));
  return entries.flatMap((entry) => (entry.type === "drill_sent" && entry.request_id !== null && !finished.has(entry.request_id) ? [entry.request_id] : []));
}

export function teamLedger(entries: LedgerEntry[], openDrills: ReadonlySet<string>): TeamLedger {
  const drills = new Set(entries.filter(isDrillEntry).map((entry) => entry.request_id));
  const first = entries.find((entry) => entry.type === "drill_sent" && entry.request_id !== null && openDrills.has(entry.request_id));
  const before = first ? entries.filter((entry) => entry.seq < first.seq) : entries;
  return {
    entries: before.filter((entry) => !isDrillEntry(entry) && !(entry.request_id !== null && drills.has(entry.request_id))),
    holdingBack: first !== undefined,
    drillResults: before.filter((entry) => entry.type === "drill_result").map((entry) => String(entry.payload.result)),
  };
}

/** Whole groups only, so "1 finished, 0 caught" can never appear. A drill nobody saw isn't one. */
export function teamDrillTotals(results: string[]): TeamDrills {
  const finished = results.filter((result) => result !== "not_sent");
  const counted = finished.slice(0, finished.length - (finished.length % DRILL_RESULT_GROUP));
  const count = (result: string) => counted.filter((entry) => entry === result).length;
  return { finished: counted.length, caught: count("caught"), missed: count("missed"), expired: count("expired"), group: DRILL_RESULT_GROUP };
}

const CSV_FIELDS = ["seq", "at", "type", "request_id", "payload", "prev_hash", "entry_hash"] as const;

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The same file as core's /v1/export.csv?kind=ledger, of the entries the team may read. The Export link is on a page
 * anyone can open, so it can't be more complete than the page. The admin's whole file is core's route, with the token.
 */
export function ledgerCsv(entries: LedgerEntry[]): string {
  const rows = entries.map((entry) => CSV_FIELDS.map((field) => csvField(entry[field])).join(","));
  return [CSV_FIELDS.join(","), ...rows].join("\n") + "\n";
}
