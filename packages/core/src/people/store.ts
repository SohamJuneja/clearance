/** Live per-person state: when they were last active, and whether they are away. */
import type { Clock } from "@clearance/contracts";
import type { Db } from "../db/index.js";
import type { TeamFile } from "../policy/schema.js";
import type { Directory } from "./directory.js";

export class PeopleStore {
  constructor(
    private readonly db: Db,
    private readonly directory: Directory,
    private readonly clock: Clock,
  ) {}

  /** team.yaml is the source for who exists; away status set at runtime survives a restart. */
  sync(team: TeamFile): void {
    const upsert = this.db.prepare(
      `INSERT INTO people (user_id, name, mxids, groups, roles, rota, away_until, delegate_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, mxids = excluded.mxids, groups = excluded.groups,
         roles = excluded.roles, rota = excluded.rota`,
    );
    for (const entry of team.people) {
      const person = this.directory.person(entry.id);
      const rota = Object.entries(team.rotas).filter(([, rows]) => rows.some((row) => row.person === entry.id));
      upsert.run(
        entry.id,
        entry.name,
        JSON.stringify(person?.participantIds ?? []),
        JSON.stringify(entry.groups),
        JSON.stringify(entry.roles),
        JSON.stringify(Object.fromEntries(rota)),
        entry.away_until ? Date.parse(entry.away_until) : null,
        entry.delegate_to ?? null,
      );
    }
  }

  noteActive(userId: string, room: string, messageId?: string): void {
    const at = this.clock.nowMs();
    this.db
      .prepare(
        `INSERT INTO activity (user_id, room, at, last_message_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, room) DO UPDATE SET at = excluded.at, last_message_id = COALESCE(excluded.last_message_id, last_message_id)`,
      )
      .run(userId, room, at, messageId ?? null);
    this.db.prepare(`UPDATE people SET last_active_at = ? WHERE user_id = ?`).run(at, userId);
  }

  lastActive(userId: string): { room: string; atMs: number } | null {
    const row = this.db.prepare(`SELECT room, at FROM activity WHERE user_id = ? ORDER BY at DESC LIMIT 1`).get(userId) as
      | { room: string; at: number }
      | undefined;
    return row ? { room: row.room, atMs: row.at } : null;
  }

  lastActiveIn(userId: string, room: string): number | null {
    const row = this.db.prepare(`SELECT at FROM activity WHERE user_id = ? AND room = ?`).get(userId, room) as
      | { at: number }
      | undefined;
    return row?.at ?? null;
  }

  /** Non-null only while they are actually away. */
  away(userId: string): { untilMs: number; delegateTo: string | null } | null {
    const row = this.db.prepare(`SELECT away_until, delegate_to FROM people WHERE user_id = ?`).get(userId) as
      | { away_until: number | null; delegate_to: string | null }
      | undefined;
    if (!row?.away_until || row.away_until <= this.clock.nowMs()) return null;
    return { untilMs: row.away_until, delegateTo: row.delegate_to };
  }

  /** The last thing this person wrote in this room: what a card can mention so that Switch names them. */
  lastMessageIn(userId: string, room: string): string | null {
    const row = this.db.prepare(`SELECT last_message_id FROM activity WHERE user_id = ? AND room = ?`).get(userId, room) as
      | { last_message_id: string | null }
      | undefined;
    return row?.last_message_id ?? null;
  }

  /** Set by a rubber-stamp signal: their next high-tier card asks for a typed value. Null when there is none. */
  friction(userId: string): string | null {
    const row = this.db.prepare(`SELECT friction FROM people WHERE user_id = ?`).get(userId) as
      | { friction: string | null }
      | undefined;
    return row?.friction ?? null;
  }

  setFriction(userId: string, reason: string): void {
    this.db.prepare(`UPDATE people SET friction = ? WHERE user_id = ?`).run(reason, userId);
  }

  clearFriction(userId: string): void {
    this.db.prepare(`UPDATE people SET friction = NULL WHERE user_id = ?`).run(userId);
  }

  setAway(userId: string, untilMs: number | null, delegateTo: string | null): void {
    this.db.prepare(`UPDATE people SET away_until = ?, delegate_to = ? WHERE user_id = ?`).run(untilMs, delegateTo, userId);
  }
}
