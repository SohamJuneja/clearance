import type { Clock } from "@clearance/contracts";
import type { Db } from "../db/index.js";

/**
 * primary: first choice. backup, group: from the ladder. fallback: nobody eligible. origin_copy: visibility only.
 * review: after the fact, on something earned autonomy ran. proposal: a signature; its request_id is a proposal id.
 * glass_review: the mandatory look at a break-glass (F18). counter: someone confirming their own offer of a smaller
 * amount (F20), which isn't how the request gets decided, so it's left out of what counts as coverage and of the inbox.
 */
export type RouteStep = "primary" | "reroute" | "backup" | "group" | "fallback" | "origin_copy" | "review" | "proposal" | "glass_review" | "counter";

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
  /** Set on a counter card: the amount on offer, and how many wrong values came before this card. */
  counter_amount: number | null;
  counter_try: number | null;
  /** "opening" until Switch has answered, "failed" if it never did. Null is an open card, or an answered one. */
  open_state: string | null;
};

/** On every query about cards that exist: one that failed to open is on record only so a late answer to it still counts. */
const NOT_FAILED = `open_state IS NOT 'failed'`;

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
    counter?: { amount: number; tries: number } | undefined;
  }): RouteRow {
    const now = this.clock.nowMs();
    const result = this.db
      .prepare(
        `INSERT INTO routes (request_id, user_id, step, card_room, session_id, switch_request_id, handle, notified_at, confirm_field, counter_amount, counter_try)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.counter?.amount ?? null,
        input.counter?.tries ?? null,
      );
    return this.db.prepare(`SELECT * FROM routes WHERE id = ?`).get(result.lastInsertRowid) as RouteRow;
  }

  /**
   * The row for a card about to be opened, under an id we chose. Switch can deliver an answer as soon as the card is live,
   * which is before it tells us anything, and an answer to a card with no row would be lost for good. It's on record
   * here before anything can wait, so anything looking for who already holds a card sees this one too.
   */
  begin(input: {
    requestId: string;
    userId: string | null;
    step: RouteStep;
    switchRequestId: string;
    confirmField?: string | undefined;
    counter?: { amount: number; tries: number } | undefined;
  }): RouteRow {
    const row = this.add({ ...input, cardRoom: "", sessionId: "" });
    this.db.prepare(`UPDATE routes SET open_state = 'opening' WHERE id = ?`).run(row.id);
    return { ...row, open_state: "opening" };
  }

  /** Where it's going, once a direct room has been found or made. */
  placeAt(id: number, roomId: string): void {
    this.db.prepare(`UPDATE routes SET card_room = ? WHERE id = ?`).run(roomId, id);
  }

  /** Live, and people have been able to see it from now. An answer that beat this keeps the time it was measured from. */
  opened(id: number, result: { sessionId: string; switchRequestId: string; handle?: string | undefined }): RouteRow {
    this.db
      .prepare(`UPDATE routes SET session_id = ?, switch_request_id = ?, handle = ?, open_state = NULL, notified_at = CASE WHEN closed_at IS NULL THEN ? ELSE notified_at END WHERE id = ?`)
      .run(result.sessionId, result.switchRequestId, result.handle ?? null, this.clock.nowMs(), id);
    return this.db.prepare(`SELECT * FROM routes WHERE id = ?`).get(id) as RouteRow;
  }

  /** Switch said no, or never answered. It may be live anyway, so the row stays for an answer to find. */
  failed(id: number): void {
    this.db.prepare(`UPDATE routes SET open_state = 'failed', closed_at = COALESCE(closed_at, ?) WHERE id = ?`).run(this.clock.nowMs(), id);
  }

  /** At startup: whatever was opening when the last process stopped won't finish, and its request needs routing again. */
  abandonOpening(): void {
    this.db.prepare(`UPDATE routes SET open_state = 'failed', closed_at = COALESCE(closed_at, ?) WHERE open_state = 'opening'`).run(this.clock.nowMs());
  }

  forRequest(requestId: string): RouteRow[] {
    return this.db.prepare(`SELECT * FROM routes WHERE request_id = ? AND ${NOT_FAILED} ORDER BY id`).all(requestId) as RouteRow[];
  }

  /** Whether a fallback card was ever tried, even one Switch never confirmed: it may be live, and its answer still counts. */
  fallbackTried(requestId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM routes WHERE request_id = ? AND step = 'fallback' LIMIT 1`).get(requestId) !== undefined;
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
   * Switch counts handles per channel, so the same handle names different cards in different rooms. So a handle means the
   * card of that name in the room it was used in, and nothing at all if that room has none.
   */
  byHandle(handle: string, roomId: string): RouteRow | null {
    const row = this.db.prepare(`SELECT * FROM routes WHERE handle = ? AND card_room = ? ORDER BY id DESC LIMIT 1`).get(handle, roomId) as RouteRow | undefined;
    return row ?? null;
  }

  /** The requests with a card of this name in any room, for a question that changes nothing. */
  requestsWithHandle(handle: string): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT request_id FROM routes WHERE handle = ?`).all(handle) as { request_id: string }[];
    return rows.map((row) => row.request_id);
  }

  close(id: number): void {
    this.db.prepare(`UPDATE routes SET closed_at = ? WHERE id = ? AND closed_at IS NULL`).run(this.clock.nowMs(), id);
  }

  /** How many typed cards this person has been shown, so the field asked for can rotate. */
  confirmCount(userId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM routes WHERE user_id = ? AND confirm_field IS NOT NULL AND step != 'counter' AND ${NOT_FAILED}`)
      .get(userId) as { count: number };
    return row.count;
  }

  /** How many typed cards this request has shown to a room rather than a person. */
  roomConfirmCount(requestId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM routes WHERE request_id = ? AND user_id IS NULL AND confirm_field IS NOT NULL AND ${NOT_FAILED}`)
      .get(requestId) as { count: number };
    return row.count;
  }

  /** Once a request has asked someone to type, it goes on asking them. */
  askedToType(requestId: string, userId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM routes WHERE request_id = ? AND user_id = ? AND confirm_field IS NOT NULL AND step != 'counter' AND ${NOT_FAILED} LIMIT 1`)
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
         WHERE r.user_id = ? AND r.closed_at IS NULL AND r.open_state IS NULL AND r.step != 'counter' AND q.state IN ('HELD', 'ROUTED') ORDER BY r.notified_at DESC, r.id DESC`,
      )
      .all(userId) as RouteRow[];
  }
}
