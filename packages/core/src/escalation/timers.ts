/** The escalation ladder's timers live in SQLite, so a restart loses nothing: the next tick finds what is due. */
import type { Db } from "../db/index.js";
import type { CompiledEscalateStep } from "../policy/load.js";

export type TimerRow = {
  id: number;
  request_id: string;
  step_index: number;
  fire_at: number;
  /** The step as it stood when the request was held: a policy change does not rewrite a running ladder. */
  step: CompiledEscalateStep;
};

type StoredTimer = Omit<TimerRow, "step"> & { step: string };

export class TimerStore {
  constructor(private readonly db: Db) {}

  add(requestId: string, stepIndex: number, step: CompiledEscalateStep, fireAtMs: number): void {
    const kind = step.add ? "add" : step.post ? "post" : "notify";
    this.db
      .prepare(`INSERT INTO timers (request_id, kind, step_index, step, fire_at) VALUES (?, ?, ?, ?, ?)`)
      .run(requestId, kind, stepIndex, JSON.stringify(step), fireAtMs);
  }

  due(nowMs: number): TimerRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, request_id, step_index, step, fire_at FROM timers
         WHERE fired_at IS NULL AND fire_at <= ? ORDER BY fire_at, id`,
      )
      .all(nowMs) as StoredTimer[];
    return rows.map((row) => ({ ...row, step: JSON.parse(row.step) as CompiledEscalateStep }));
  }

  markFired(id: number, nowMs: number): void {
    this.db.prepare(`UPDATE timers SET fired_at = ? WHERE id = ?`).run(nowMs, id);
  }
}
