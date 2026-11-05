/**
 * Keeps the "Needs your response (N)" post in each approver's direct room (F7).
 *
 * What a person sees, which is the point. A card there is long and carries the evidence and buttons; this
 * is the short list across rooms. There is one live copy, at the bottom, and it stands in for the "the
 * card is just above" line, so a request adds a card and changes the list rather than adding three posts.
 * When the list changes the old post goes and a new one follows. An empty list is no post at all.
 *
 * Switch has no way for an agent to edit or delete a message, so removing the old post takes `erase`,
 * which Mattermost's own API can do with a token for Clearance's bot (spikes/s-inbox-posts.ts). Without
 * one the old posts stay and the newest is the true one, and a list that empties says so, since a stale
 * "(1)" left at the bottom would be a lie.
 *
 * Nothing waits on this and nothing here can fail a decision: it reads what the stores already say, and
 * whatever it could not post it tries again.
 */
import type { ChatPort, Clock } from "@clearance/contracts";
import type { Clearance } from "../core.js";
import type { Db } from "../db/index.js";
import type { Person } from "../people/directory.js";
import { formatClockWithZone } from "../time.js";
import { inboxMessage, type InboxItem } from "./inbox.js";

export const INBOX_SYNC_EVERY_MS = 500;
const RETRY_AFTER_MS = 5_000;
/** A post on its way when the list emptied can land after the sweep that removed the others. */
const SWEEP_AGAIN_AFTER_MS = 3_000;
const META_PREFIX = "inbox:";

export type InboxKeeperDeps = {
  db: Db;
  chat: Pick<ChatPort, "ensureDirectRoom" | "postMessage" | "sendTargeted">;
  clock: Clock;
  people: () => Person[];
  items: (userId: string) => InboxItem[];
  tz: () => string;
  /** Removes every earlier inbox post of ours in the room. Throws if it can't. */
  erase?: (roomId: string) => Promise<void>;
  log?: (message: string) => void;
};

type Shown = { ids: string[]; signature: string };

/** What decides whether the list changed. Ages change every second and are not worth a post. */
const signatureOf = (items: InboxItem[]) => items.map((item) => `${item.request_id}:${item.handle ?? ""}:${item.card_room}`).join("|");

export class InboxKeeper {
  private running = false;
  private readonly retryAt = new Map<string, number>();
  private readonly sweepAt = new Map<string, { roomId: string; atMs: number }>();

  constructor(private readonly deps: InboxKeeperDeps) {}

  /** Brings every post up to date. Never throws, and a call during a run is dropped: the next one catches up. */
  async sync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const person of this.deps.people()) await this.syncPerson(person);
    } catch (error) {
      this.deps.log?.(`inbox: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async syncPerson(person: Person): Promise<void> {
    const now = this.deps.clock.nowMs();
    await this.sweepIfDue(person.id, now);
    const items = this.deps.items(person.id);
    const signature = signatureOf(items);
    const shown = this.readShown(person.id);
    if (shown ? shown.signature === signature : items.length === 0) return;
    if (now < (this.retryAt.get(person.id) ?? 0)) return;
    try {
      const { roomId } = await this.deps.chat.ensureDirectRoom({ userName: person.userName });
      if (items.length === 0) await this.clear(person.id, roomId, now);
      else await this.repost(person, roomId, items, shown, now);
      this.writeShown(person.id, { ids: items.map((item) => item.request_id), signature });
      this.retryAt.delete(person.id);
    } catch (error) {
      this.retryAt.set(person.id, now + RETRY_AFTER_MS);
      this.deps.log?.(`inbox for ${person.id}: ${(error as Error).message}`);
    }
  }

  /** The old post goes first, so a slow post can't be mistaken for the old one and removed. */
  private async repost(person: Person, roomId: string, items: InboxItem[], shown: Shown | null, now: number): Promise<void> {
    await this.tryErase(roomId, person.id);
    this.sweepAt.delete(person.id);
    const asOf = formatClockWithZone(now, this.deps.tz());
    const body = inboxMessage(items, { roomId, asOf });
    // New work is worth a mention. A shrinking list isn't; it is only keeping the list true.
    const grew = items.some((item) => !shown?.ids.includes(item.request_id));
    if (grew) await this.deps.chat.sendTargeted({ roomId, body, targets: [person.userName] });
    else await this.deps.chat.postMessage({ roomId, body });
  }

  private async clear(personId: string, roomId: string, now: number): Promise<void> {
    if (await this.tryErase(roomId, personId)) {
      this.sweepAt.set(personId, { roomId, atMs: now + SWEEP_AGAIN_AFTER_MS });
      return;
    }
    await this.deps.chat.postMessage({ roomId, body: inboxMessage([], { roomId }) });
  }

  private async sweepIfDue(personId: string, now: number): Promise<void> {
    const sweep = this.sweepAt.get(personId);
    if (!sweep || now < sweep.atMs) return;
    this.sweepAt.delete(personId);
    await this.tryErase(sweep.roomId, personId);
  }

  private async tryErase(roomId: string, personId: string): Promise<boolean> {
    if (!this.deps.erase) return false;
    try {
      await this.deps.erase(roomId);
      return true;
    } catch (error) {
      this.deps.log?.(`inbox for ${personId}: could not remove the old post: ${(error as Error).message}`);
      return false;
    }
  }

  private readShown(personId: string): Shown | null {
    const row = this.deps.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`${META_PREFIX}${personId}`) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Shown) : null;
  }

  private writeShown(personId: string, shown: Shown): void {
    this.deps.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(`${META_PREFIX}${personId}`, JSON.stringify(shown));
  }
}

/** A keeper over a running core. */
export function createInboxKeeper(
  core: Clearance,
  options: Pick<InboxKeeperDeps, "chat" | "clock" | "erase" | "log">,
): InboxKeeper {
  return new InboxKeeper({
    ...options,
    db: core.stores.db,
    people: () => core.people.directory.all(),
    items: (userId) => core.inboxItems(userId),
    tz: () => core.policy().defaults.business_hours.tz,
  });
}
