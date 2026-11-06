/**
 * Who asked for what, from the message stream (S4 fallback rule): every human who addressed an agent in
 * the last 10 minutes is a requester and is excluded from approving. An agent mentioning another agent
 * passes its requesters along, so a chain through agents cannot launder who asked (authority case 12).
 *
 * Nothing on the stream says who a message addressed for an agent other than Clearance, and Switch also addresses an
 * agent through a direct room, a room alias or a role mention, none of which has `@name` in the text. So there are two
 * ways to count as having asked: naming the agent, or saying anything in a room the agent is known to be in, in the
 * window, unless the message names some other agent. That over-excludes bystanders, and that is the safe direction.
 * When even this finds nobody, core asks for two people instead: see `unknown_requester_quorum`.
 *
 * Identity comes only from the event's sender and on_behalf_of. Whether a sender is an agent is looked up in identities
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

/** Answering a card in the room: `A12 yes`, `A12 1`, `A12 "40000"`, `A12 q1="40000"`. That is a decision, not a request. */
const CARD_ANSWER = /^\s*A\d+(\s+(yes|no|\d+|"[^"]*"|\w+="[^"]*"))?\s*$/i;

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
    const senderPerson = this.directory.personByParticipant(evt.sender);
    const onBehalfOf = this.identifyDisplayName(evt.onBehalfOf);
    if (mentioned.length === 0) {
      if (!senderAgent && !this.namesClearance(evt.body) && !CARD_ANSWER.test(evt.body)) {
        for (const userId of new Set([senderPerson?.id ?? (onBehalfOf ? null : evt.sender), onBehalfOf])) {
          if (userId) this.recordVoice(evt.roomId, userId);
        }
      }
      return;
    }
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

  private namesClearance(body: string): boolean {
    return mentionedNames(body).some((name) => name.toLowerCase() === "clearance");
  }

  /** Who spoke where, for the window and no longer. Only that: what they said isn't kept. */
  private recordVoice(room: string, userId: string): void {
    const now = this.clock.nowMs();
    this.db.prepare(`DELETE FROM room_voices WHERE at <= ?`).run(now - REQUESTER_WINDOW_MS);
    this.db.prepare(`INSERT INTO room_voices (room, user_id, at) VALUES (?, ?, ?)`).run(room, userId, now);
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
    const since = this.clock.nowMs() - REQUESTER_WINDOW_MS;
    // The rooms this agent is known to be in: it has spoken there, or someone has addressed it there.
    const rows = this.db
      .prepare(
        `SELECT user_id, MIN(at) AS first FROM (
           SELECT user_id, at FROM requesters WHERE agent = @agent AND at > @since
           UNION ALL
           SELECT user_id, at FROM room_voices WHERE at > @since AND room IN (
             SELECT room FROM agent_messages WHERE agent = @agent
             UNION
             SELECT room FROM requesters WHERE agent = @agent
           )
         ) GROUP BY user_id ORDER BY first`,
      )
      .all({ agent, since }) as { user_id: string }[];
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
