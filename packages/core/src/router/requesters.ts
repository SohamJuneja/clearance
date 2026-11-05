/**
 * Who asked for what, from the message stream (S4 fallback rule): every human who addressed an agent in
 * the last 10 minutes is a requester and is excluded from approving. An agent mentioning another agent
 * passes its requesters along, so a chain through agents cannot launder who asked (authority case 12).
 *
 * Nothing on the stream says who a message addressed, so addressing comes from `@name` in the text. Identity
 * comes only from the event's sender and on_behalf_of. Whether a sender is an agent is looked up in identities
 * and the team file, never read from sender_kind, which Switch leaves null for people and agents alike.
 */
import type { ChatMessageEvent, Clock } from "@clearance/contracts";
import type { Db } from "../db/index.js";
import type { Directory } from "../people/directory.js";

/** Real time on purpose: an agent's turn takes as long as it takes, whatever CLEARANCE_TIME_SCALE says. */
export const REQUESTER_WINDOW_MS = 10 * 60_000;

const MENTION = /(?<![\w.@-])@([A-Za-z0-9][\w-]*(?:\.[\w-]+)*)/g;

export function mentionedNames(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((match) => match[1] as string))];
}

export class RequesterTracker {
  constructor(
    private readonly db: Db,
    private readonly directory: Directory,
    private readonly clock: Clock,
  ) {}

  observe(evt: ChatMessageEvent): void {
    const senderAgent = this.directory.agentForSender(evt.sender, evt.senderName);
    if (senderAgent) this.recordAgentMessage(senderAgent, evt);
    const mentioned = mentionedNames(evt.body).filter((name) => this.directory.isAgent(name));
    if (mentioned.length === 0) return;
    const senderPerson = this.directory.personByParticipant(evt.sender);
    const onBehalfOf = this.identifyDisplayName(evt.onBehalfOf);
    for (const agent of mentioned) {
      if (agent === senderAgent) continue;
      if (senderAgent) {
        for (const userId of this.requestersOf(senderAgent)) this.record(agent, evt, userId, senderAgent);
        if (onBehalfOf) this.record(agent, evt, onBehalfOf, senderAgent);
      } else if (senderPerson) {
        this.record(agent, evt, senderPerson.id, onBehalfOf);
        if (onBehalfOf) this.record(agent, evt, onBehalfOf, null);
      } else if (onBehalfOf) {
        // Only platform messages carry on_behalf_of. The platform is a messenger; the person is the one asking.
        this.record(agent, evt, onBehalfOf, null);
      } else {
        // An unlinked human still asked. They can never approve, so this only ever narrows who can.
        this.record(agent, evt, evt.sender, null);
      }
    }
  }

  /** The person's id, or the name as given when it maps to nobody: that keeps them a requester and widens nothing. */
  private identifyDisplayName(name: string | null | undefined): string | null {
    if (!name?.trim()) return null;
    return this.directory.personByDisplayName(name)?.id ?? name;
  }

  private record(agent: string, evt: ChatMessageEvent, userId: string, onBehalfOf: string | null): void {
    this.db
      .prepare(`INSERT INTO requesters (agent, room, thread, user_id, on_behalf_of, at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(agent, evt.roomId, evt.threadId ?? null, userId, onBehalfOf, this.clock.nowMs());
  }

  private recordAgentMessage(agent: string, evt: ChatMessageEvent): void {
    this.db
      .prepare(`INSERT INTO agent_messages (agent, room, thread, body, at) VALUES (?, ?, ?, ?, ?)`)
      .run(agent, evt.roomId, evt.threadId ?? null, evt.body, this.clock.nowMs());
  }

  requestersOf(agent: string): string[] {
    const rows = this.db
      .prepare(`SELECT user_id, MIN(at) AS first FROM requesters WHERE agent = ? AND at > ? GROUP BY user_id ORDER BY first`)
      .all(agent, this.clock.nowMs() - REQUESTER_WINDOW_MS) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  /** Where the agent was last addressed. Hooks often know nothing else about the room. */
  lastOrigin(agent: string): { room: string; thread: string | null } | null {
    const row = this.db
      .prepare(`SELECT room, thread FROM requesters WHERE agent = ? AND at > ? ORDER BY at DESC, id DESC LIMIT 1`)
      .get(agent, this.clock.nowMs() - REQUESTER_WINDOW_MS) as { room: string; thread: string | null } | undefined;
    return row ?? null;
  }

  /**
   * What the agent just said where this call came from, newest first: in the thread if it spoke there, else in
   * the room. Older than the requester window says nothing about this call.
   */
  lastMessages(agent: string, room: string | null, thread: string | null, count: number): string[] {
    if (!room) return [];
    const since = this.clock.nowMs() - REQUESTER_WINDOW_MS;
    const read = (sql: string, ...params: unknown[]) =>
      (this.db.prepare(sql).all(...params) as { body: string }[]).map((row) => row.body);
    if (thread) {
      const inThread = read(
        `SELECT body FROM agent_messages WHERE agent = ? AND room = ? AND thread = ? AND at > ? ORDER BY at DESC, id DESC LIMIT ?`,
        agent,
        room,
        thread,
        since,
        count,
      );
      if (inThread.length > 0) return inThread;
    }
    return read(
      `SELECT body FROM agent_messages WHERE agent = ? AND room = ? AND at > ? ORDER BY at DESC, id DESC LIMIT ?`,
      agent,
      room,
      since,
      count,
    );
  }
}
