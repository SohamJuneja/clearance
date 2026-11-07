/**
 * The ledger as the team may read it, for the read-only connector. Approvers can run the connector, and a drill only works if
 * it can't be told from a real request (PLAN F9), so this is the rule the ledger mirror and the Desk keep:
 * - A drill's entries are never shown, even once it has closed. That covers every entry on its request, not only `drill_*`.
 * - While any drill is open the list stands still at the entry before that drill's first, so no hole in the numbers or new
 *   row points at the card that just arrived.
 * - Per-person timing goes, as in the mirror's copy (`redactedEntry`): how fast someone answered is theirs and the admin's.
 * SQLite keeps everything, and `GET /v1/ledger/verify` still checks the whole chain.
 */
import type { LedgerEntry } from "./ledger.js";
import { redactedEntry } from "./mirror.js";

export function teamEntries(entries: LedgerEntry[], drills: ReadonlySet<string>, openDrills: ReadonlySet<string>): LedgerEntry[] {
  const onDrill = (entry: LedgerEntry) => entry.request_id !== null && drills.has(entry.request_id);
  const firstOpen = entries.find((entry) => entry.request_id !== null && openDrills.has(entry.request_id));
  const before = firstOpen ? entries.filter((entry) => entry.seq < firstOpen.seq) : entries;
  return before.filter((entry) => !entry.type.startsWith("drill_") && !onDrill(entry)).map(redactedEntry);
}
