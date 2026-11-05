import type { Clock } from "@clearance/contracts";
import type { Db } from "../db/index.js";
import type { RouteTrace } from "./router.js";

/** Every routing decision for a request, newest last. `why` reads these; it never routes again. */
export class TraceStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  add(requestId: string, trace: RouteTrace): void {
    this.db
      .prepare(`INSERT INTO route_traces (request_id, at, trace) VALUES (?, ?, ?)`)
      .run(requestId, this.clock.nowMs(), JSON.stringify(trace));
  }

  latest(requestId: string): RouteTrace | null {
    const row = this.db
      .prepare(`SELECT trace FROM route_traces WHERE request_id = ? ORDER BY id DESC LIMIT 1`)
      .get(requestId) as { trace: string } | undefined;
    return row ? (JSON.parse(row.trace) as RouteTrace) : null;
  }

  first(requestId: string): RouteTrace | null {
    const row = this.db
      .prepare(`SELECT trace FROM route_traces WHERE request_id = ? ORDER BY id LIMIT 1`)
      .get(requestId) as { trace: string } | undefined;
    return row ? (JSON.parse(row.trace) as RouteTrace) : null;
  }
}
