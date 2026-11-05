import type { Clock } from "@clearance/contracts";
import type { Db } from "../db/index.js";

/**
 * primary: first choice. backup, group: from the ladder. fallback: nobody eligible. origin_copy: visibility only.
 * review: after the fact, on something earned autonomy ran. proposal: a signature; its request_id is a proposal id.
 * glass_review: the mandatory look at a break-glass (F18).
 */
export type RouteStep = "primary" | "reroute" | "backup" | "group" | "fallback" | "origin_copy" | "review" | "proposal" | "glass_review";

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
  /** Set on a type-to-confirm card: which value it asked for. */
  confirm_field: string | null;
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
    confirmField?: string | undefined;
  }): RouteRow {
    const now = this.clock.nowMs();
    const result = this.db
      .prepare(
        `INSERT INTO routes (request_id, user_id, step, card_room, session_id, switch_request_id, handle, notified_at, confirm_field)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.requestId,
        input.userId,
        input.step,
        input.cardRoom,
        input.sessionId,
        input.switchRequestId,
        input.handle ?? null,
        now,
        input.confirmField ?? null,
      );
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

  /**
   * Switch counts handles per channel, so the same handle names different cards in different rooms. The
   * card in `roomId` comes first when there is one.
   */
  byHandle(handle: string, roomId?: string): RouteRow | null {
    const row = this.db
      .prepare(`SELECT * FROM routes WHERE handle = ? ORDER BY card_room = ? DESC, id DESC LIMIT 1`)
      .get(handle, roomId ?? null) as RouteRow | undefined;
    return row ?? null;
  }

  close(id: number): void {
    this.db.prepare(`UPDATE routes SET closed_at = ? WHERE id = ? AND closed_at IS NULL`).run(this.clock.nowMs(), id);
  }

  /** How many typed cards this person has been shown, so the field asked for can rotate. */
  confirmCount(userId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM routes WHERE user_id = ? AND confirm_field IS NOT NULL`)
      .get(userId) as { count: number };
    return row.count;
  }

  /** How many typed cards this request has shown to a room rather than a person. */
  roomConfirmCount(requestId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM routes WHERE request_id = ? AND user_id IS NULL AND confirm_field IS NOT NULL`)
      .get(requestId) as { count: number };
    return row.count;
  }

  /** Once a request has asked someone to type, it goes on asking them. */
  askedToType(requestId: string, userId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM routes WHERE request_id = ? AND user_id = ? AND confirm_field IS NOT NULL LIMIT 1`)
        .get(requestId, userId) !== undefined
    );
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

  /** Break-glass reviews still open past their due time. */
  overdueGlassReviews(notifiedBeforeMs: number): RouteRow[] {
    return this.db
      .prepare(`SELECT * FROM routes WHERE step = 'glass_review' AND closed_at IS NULL AND notified_at <= ?`)
      .all(notifiedBeforeMs) as RouteRow[];
  }

  /** Review cards on requests whose review window has closed. */
  staleReviews(nowMs: number): RouteRow[] {
    return this.db
      .prepare(
        `SELECT r.* FROM routes r JOIN requests q ON q.id = r.request_id
         WHERE r.step = 'review' AND r.closed_at IS NULL AND q.expires_at <= ?`,
      )
      .all(nowMs) as RouteRow[];
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
