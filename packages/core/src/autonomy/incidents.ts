import type { Db } from "../db/index.js";

/** Real time: an incident is open for a day after it is reported, whatever the demo clock says. */
export const INCIDENT_OPEN_MS = 24 * 3_600_000;

export type IncidentRow = { id: number; request_id: string; reported_by: string; note: string; at: number };

/** `@clearance incident CLR-0042 <note>`. An open incident stops drills; every incident demotes. */
export class IncidentStore {
  constructor(private readonly db: Db) {}

  add(input: { requestId: string; reportedBy: string; note: string; atMs: number }): void {
    this.db
      .prepare(`INSERT INTO incidents (request_id, reported_by, note, at) VALUES (?, ?, ?, ?)`)
      .run(input.requestId, input.reportedBy, input.note, input.atMs);
  }

  anyOpen(nowMs: number): boolean {
    return this.db.prepare(`SELECT 1 FROM incidents WHERE at > ? LIMIT 1`).get(nowMs - INCIDENT_OPEN_MS) !== undefined;
  }

  all(): IncidentRow[] {
    return this.db.prepare(`SELECT * FROM incidents ORDER BY at, id`).all() as IncidentRow[];
  }
}
