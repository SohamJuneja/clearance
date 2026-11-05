import type { Clock } from "@clearance/contracts";
import type { Db } from "../db/index.js";

/** primary: first choice. backup, group: from the ladder. fallback: nobody eligible. origin_copy: visibility only. */
export type RouteStep = "primary" | "reroute" | "backup" | "group" | "fallback" | "origin_copy";

export type RouteRow = {
  id: number;
  request_id: string;
  user_id: string | null;
  step: RouteStep;
  card_room: string;
  session_id: string;
  switch_request_id: string;
  handle: string | null;
  notified_at: number;
  closed_at: number | null;
};

/** Cards that exist in Switch for each request. An open card is one nobody has answered or closed. */
export class RouteStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  add(input: {
    requestId: string;
    userId: string | null;
    step: RouteStep;
    cardRoom: string;
    sessionId: string;
    switchRequestId: string;
    handle?: string | undefined;
  }): RouteRow {
    const now = this.clock.nowMs();
    const result = this.db
      .prepare(
        `INSERT INTO routes (request_id, user_id, step, card_room, session_id, switch_request_id, handle, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.requestId, input.userId, input.step, input.cardRoom, input.sessionId, input.switchRequestId, input.handle ?? null, now);
    return this.db.prepare(`SELECT * FROM routes WHERE id = ?`).get(result.lastInsertRowid) as RouteRow;
  }

  forRequest(requestId: string): RouteRow[] {
    return this.db.prepare(`SELECT * FROM routes WHERE request_id = ? ORDER BY id`).all(requestId) as RouteRow[];
  }

  openForRequest(requestId: string): RouteRow[] {
    return this.db
      .prepare(`SELECT * FROM routes WHERE request_id = ? AND closed_at IS NULL ORDER BY id`)
      .all(requestId) as RouteRow[];
  }

  bySwitchRequest(switchRequestId: string): RouteRow | null {
    const row = this.db.prepare(`SELECT * FROM routes WHERE switch_request_id = ?`).get(switchRequestId) as
      | RouteRow
      | undefined;
    return row ?? null;
  }

  byHandle(handle: string): RouteRow | null {
    const row = this.db.prepare(`SELECT * FROM routes WHERE handle = ? ORDER BY id DESC LIMIT 1`).get(handle) as
      | RouteRow
      | undefined;
    return row ?? null;
  }

  close(id: number): void {
    this.db.prepare(`UPDATE routes SET closed_at = ? WHERE id = ? AND closed_at IS NULL`).run(this.clock.nowMs(), id);
  }

  /** Open cards a person is holding on undecided requests. The card cap counts these. */
  openCount(userId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT r.request_id) AS count FROM routes r JOIN requests q ON q.id = r.request_id
         WHERE r.user_id = ? AND r.closed_at IS NULL AND q.state IN ('HELD', 'ROUTED')`,
      )
      .get(userId) as { count: number };
    return row.count;
  }

  openFor(userId: string): RouteRow[] {
    return this.db
      .prepare(
        `SELECT r.* FROM routes r JOIN requests q ON q.id = r.request_id
         WHERE r.user_id = ? AND r.closed_at IS NULL AND q.state IN ('HELD', 'ROUTED') ORDER BY r.notified_at DESC, r.id DESC`,
      )
      .all(userId) as RouteRow[];
  }
}
