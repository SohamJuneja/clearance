/**
 * Where core has read the Switch stream up to, kept in SQLite. Without it the stream opens at the head after a restart,
 * so a message sent while core was down is never seen, and the hold it led to reads as "nobody knows who asked".
 *
 * The position moves only after core has the message. A crash in between delivers that one again, and being told twice
 * who asked changes nothing.
 */
import type { ApprovalOutcomeEvent, ChatMessageEvent } from "@clearance/contracts";
import type { Db } from "./db/index.js";

type Position = Record<string, number>;

const KEY = "switch_stream_position";

export function readStreamPosition(db: Db): Position | undefined {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(KEY) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => Number.isInteger(entry[1]));
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  } catch {
    return undefined; // Starting from the head loses a little. Starting from nonsense loses the connection.
  }
}

/** Each source's sequence only goes up: frames can arrive out of order across sources. */
export function writeStreamPosition(db: Db, position: Position): void {
  const next = { ...readStreamPosition(db) };
  for (const [source, seq] of Object.entries(position)) {
    if (seq > (next[source] ?? -1)) next[source] = seq;
  }
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(KEY, JSON.stringify(next));
}

type StreamCore = {
  stores: { db: Db };
  onMessage(event: ChatMessageEvent): Promise<void>;
  onApprovalOutcome(event: ApprovalOutcomeEvent): Promise<void>;
};

/** What to pass `agent.start`. `afterMessage` is whatever else wants a message, once core has it. */
export function streamHandlers(core: StreamCore, options: { afterMessage?: (event: ChatMessageEvent) => void } = {}) {
  return {
    message: async (event: ChatMessageEvent, meta: { position?: Position }): Promise<void> => {
      await core.onMessage(event);
      options.afterMessage?.(event);
      if (meta.position) writeStreamPosition(core.stores.db, meta.position);
    },
    approvalOutcome: (event: ApprovalOutcomeEvent): Promise<void> => core.onApprovalOutcome(event),
  };
}
