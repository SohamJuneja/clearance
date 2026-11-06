import type { Db } from "../db/index.js";

/** Real time: an incident is open for a day after it is reported, whatever the demo clock says. */
export const INCIDENT_OPEN_MS = 24 * 3_600_000;

export type IncidentRow = { id: number; request_id: string; reported_by: string; note: string; at: number };

/**
 * `@clearance incident CLR-0042 <note>`. An open incident stops drills, and every incident demotes. Only something that ran,
 * or may have, within a day of the report is a fire, so anything else stays on the record and practice carries on. Otherwise
 * anyone could turn drills off, without an admin, by reporting something that never happened.
 */
export class IncidentStore {
  constructor(private readonly db: Db) {}

  add(input: { requestId: string; reportedBy: string; note: string; atMs: number }): void {
    this.db
      .prepare(`INSERT INTO incidents (request_id, reported_by, note, at) VALUES (?, ?, ?, ?)`)
      .run(input.requestId, input.reportedBy, input.note, input.atMs);
  }

  anyOpen(nowMs: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM incidents i LEFT JOIN requests r ON r.id = i.request_id
         WHERE i.at > @since AND (
           r.id IS NULL
           OR (r.is_drill = 0 AND r.state IN ('EXECUTED', 'CONSUMED', 'AUTO', 'OUTCOME_UNKNOWN', 'APPROVED', 'BREAK_GLASS', 'GRANTED')
               AND COALESCE(r.decided_at, r.created_at) > i.at - @open)
         ) LIMIT 1`,
      )
      .get({ since: nowMs - INCIDENT_OPEN_MS, open: INCIDENT_OPEN_MS });
    return row !== undefined;
  }

  all(): IncidentRow[] {
    return this.db.prepare(`SELECT * FROM incidents ORDER BY at, id`).all() as IncidentRow[];
  }
}
