/**
 * Durable custody of held calls.
 *
 * Exactly-once, as far as one host can promise it: a call moves from `held` to `executing` inside
 * a SQLite transaction, and only the caller that made that move sends it. A crash between the move
 * and the recorded result leaves the outcome unknown, so on boot such rows become `unknown` and
 * are never re-sent: a duplicate refund is worse than one a person has to check.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type HeldState = "held" | "executing" | "done" | "unknown";

export type HeldCall = {
  request_id: string;
  call_hash: string;
  agent: string;
  operation: string;
  method: string;
  path: string;
  body: string | null;
  state: HeldState;
  ok: number | null;
  result_status: number | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export type NewHeldCall = Pick<
  HeldCall,
  "request_id" | "call_hash" | "agent" | "operation" | "method" | "path" | "body"
>;

export type Claim =
  | { kind: "unknown_request" }
  | { kind: "hash_mismatch" }
  | { kind: "claimed"; row: HeldCall }
  | { kind: "existing"; row: HeldCall };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS held_calls (
  request_id    TEXT PRIMARY KEY,
  call_hash     TEXT NOT NULL,
  agent         TEXT NOT NULL,
  operation     TEXT NOT NULL,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  body          TEXT,
  state         TEXT NOT NULL CHECK (state IN ('held', 'executing', 'done', 'unknown')),
  ok            INTEGER,
  result_status INTEGER,
  result_json   TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
`;

export type EditOutcome = { kind: "edited" } | { kind: "unknown_request" } | { kind: "hash_mismatch" } | { kind: "refused"; error: string };

/** What an edited call's row says instead of a result. Its presence is also what makes asking again safe. */
const EDIT_MARKER_START = "edited: this call was closed in favour of ";
const editMarker = (newRequestId: string): string => `${EDIT_MARKER_START}${newRequestId}`;

export class GateStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    // No process survives a restart, so anything still `executing` has an unknown outcome.
    this.db
      .prepare(
        `UPDATE held_calls SET state = 'unknown', error = ?, finished_at = ? WHERE state = 'executing'`,
      )
      .run(
        "outcome unknown: the gate stopped during execution, so it will not run this again",
        now(),
      );
  }

  /** Returns false when the id already holds a different call. */
  hold(call: NewHeldCall): boolean {
    const insert = this.db.transaction((row: NewHeldCall): boolean => {
      const existing = this.get(row.request_id);
      if (existing) return existing.call_hash === row.call_hash;
      this.db
        .prepare(
          `INSERT INTO held_calls (request_id, call_hash, agent, operation, method, path, body, state, created_at)
           VALUES (@request_id, @call_hash, @agent, @operation, @method, @path, @body, 'held', @created_at)`,
        )
        .run({ ...row, created_at: now() });
      return true;
    });
    return insert.immediate(call);
  }

  get(requestId: string): HeldCall | undefined {
    return this.db.prepare(`SELECT * FROM held_calls WHERE request_id = ?`).get(requestId) as
      HeldCall | undefined;
  }

  /**
   * F20: closes a held call and holds its edited copy, in one step, so there is never a moment when both could run.
   * `build` makes the copy's row from the original, or says why it can't. Asking again for the same edit is a success.
   */
  edit(input: {
    requestId: string;
    callHash: string;
    newRequestId: string;
    newCallHash: string;
    build: (row: HeldCall) => { path: string; body: string } | { refused: string };
  }): EditOutcome {
    const run = this.db.transaction((): EditOutcome => {
      const row = this.get(input.requestId);
      if (!row) return { kind: "unknown_request" };
      if (row.call_hash !== input.callHash) return { kind: "hash_mismatch" };
      const copy = this.get(input.newRequestId);
      const marker = editMarker(input.newRequestId);
      const built = input.build(row);
      if (row.error === marker) {
        const same = copy?.call_hash === input.newCallHash && !("refused" in built) && copy.body === built.body;
        return same ? { kind: "edited" } : { kind: "refused", error: "this call has already been edited differently" };
      }
      if (row.error?.startsWith(EDIT_MARKER_START)) return { kind: "refused", error: "this call has already been edited differently" };
      if (row.state !== "held") return { kind: "refused", error: "this call has already run or started" };
      if ("refused" in built) return { kind: "refused", error: built.refused };
      if (copy) {
        // The agent sent the edited call itself while the edit waited, and core gave it the same id. That's this call.
        const same = copy.state === "held" && copy.call_hash === input.newCallHash && copy.agent === row.agent && copy.body === built.body;
        if (!same) return { kind: "refused", error: "that new request id is already in use" };
      } else {
        this.db
          .prepare(
            `INSERT INTO held_calls (request_id, call_hash, agent, operation, method, path, body, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)`,
          )
          .run(input.newRequestId, input.newCallHash, row.agent, row.operation, row.method, built.path, built.body, now());
      }
      this.db
        .prepare(`UPDATE held_calls SET state = 'done', ok = 0, error = ?, finished_at = ? WHERE request_id = ?`)
        .run(marker, now(), input.requestId);
      return { kind: "edited" };
    });
    return run.immediate();
  }

  /** The single place a call can become ours to send. */
  claim(requestId: string, callHash: string): Claim {
    const run = this.db.transaction((id: string, hash: string): Claim => {
      const row = this.get(id);
      if (!row) return { kind: "unknown_request" };
      if (row.call_hash !== hash) return { kind: "hash_mismatch" };
      if (row.state !== "held") return { kind: "existing", row };
      this.db.prepare(`UPDATE held_calls SET state = 'executing' WHERE request_id = ?`).run(id);
      return { kind: "claimed", row: { ...row, state: "executing" } };
    });
    return run.immediate(requestId, callHash);
  }

  finish(
    requestId: string,
    outcome: { ok: boolean; status: number; result: unknown; error?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE held_calls
         SET state = 'done', ok = ?, result_status = ?, result_json = ?, error = ?, finished_at = ?
         WHERE request_id = ? AND state IN ('executing', 'unknown')`,
      )
      .run(
        outcome.ok ? 1 : 0,
        outcome.status,
        JSON.stringify(outcome.result ?? null),
        outcome.error ?? null,
        now(),
        requestId,
      );
  }

  /** The call definitely never reached Acme, so a later execute may send it. */
  release(requestId: string): void {
    this.db
      .prepare(`UPDATE held_calls SET state = 'held' WHERE request_id = ? AND state = 'executing'`)
      .run(requestId);
  }

  /** It may have reached Acme and we cannot tell. It will not be sent again. */
  markUnknown(requestId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE held_calls SET state = 'unknown', error = ?, finished_at = ? WHERE request_id = ? AND state = 'executing'`,
      )
      .run(error, now(), requestId);
  }

  close(): void {
    this.db.close();
  }
}

function now(): string {
  return new Date().toISOString();
}
