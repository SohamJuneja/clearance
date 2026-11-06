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
import type { ChatMessageEvent, Clock, RoomAliases } from "@clearance/contracts";
import type { Db } from "../db/index.js";
import { isCommandToClearance } from "../commands/parse.js";
import type { Directory } from "../people/directory.js";
import { isSwitchNotice } from "./switch-notices.js";

const NAMES_A_REQUEST = /\bCLR-\d+\b/;

/** Fewer words than this left over from a report on a request ("Done.") says nothing about this call. */
const OWN_WORDS = 3;

/**
 * What's left once the parts about an earlier request are gone. "CLR-0001 approved: refund of ₹2,000." isn't what the agent
 * claims about this call, and its amount isn't this call's. But naming a CLR mustn't hide a whole sentence, or an agent could
 * leave its words out of the evidence by adding one: "Refunding ₹4,000, as in CLR-0001." still says ₹4,000. A comma inside
 * an amount isn't followed by a space, so it doesn't split one.
 */
export function withoutRequestFragments(body: string): string {
  if (!NAMES_A_REQUEST.test(body)) return body;
  return body
    .split(/(?<=[.,;!?])\s+|\n+/)
    .filter((part) => !NAMES_A_REQUEST.test(part))
    .join(" ")
    .trim();
}

function isOnlyAReport(body: string): boolean {
  if (!NAMES_A_REQUEST.test(body)) return false;
  return withoutRequestFragments(body).split(/\s+/).filter(Boolean).length < OWN_WORDS;
}

/** More than Switch would post between two things an agent says. */
const NOTICES_TO_READ_PAST = 20;

/** Real time on purpose: an agent's turn takes as long as it takes, whatever CLEARANCE_TIME_SCALE says. */
export const REQUESTER_WINDOW_MS = 10 * 60_000;

/**
 * Someone who asked and has had no reply from the agent is still waiting on its turn, however long that takes, so they
 * can't approve what comes out of it. All core can see of a turn is the agent's messages, so its next message in that room
 * is what ends one: an agent that posts progress as it goes ends this early, and one that never answers lasts until this.
 */
const TURN_MAX_MS = 60 * 60_000;

/**
 * How recently the agent has to have been in a room for what people say there to count as asking it. Without a limit, one
 * thing it said once would make a room's chat count for ever. Spoken or addressed: it needn't have answered yet.
 */
const IN_ROOM_MS = 60 * 60_000;

/** A voice is kept this long, past the window, so one delivered late can still bar its sender while a request is open. */
const VOICE_KEEP_MS = 40 * 60_000;

const MENTION = /(?<![\w.@-])@([A-Za-z0-9][\w-]*(?:\.[\w-]+)*)/g;

export function mentionedNames(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((match) => match[1] as string))];
}

/** Answering a card in the room: `A12 yes`, `A12 1`, `A12 "40000"`, `A12 q1="40000"`. That is a decision, not a request. */
const CARD_ANSWER = /^\s*A\d+(\s+(yes|no|\d+|"[^"]*"|\w+="[^"]*"))?\s*$/i;

/** When it was sent, as far as anyone says. Switch gives 0 when it doesn't know, and arrival time then stands in. */
const sentAt = (evt: ChatMessageEvent): number | null => (evt.timestampMs > 0 ? evt.timestampMs : null);

export class RequesterTracker {
  constructor(
    private readonly db: Db,
    private readonly directory: Directory,
    private readonly clock: Clock,
  ) {}

  /**
   * `aliases` are this room's, when Switch can say: then an alias is the agent, exactly as its name is. Null when it can't,
   * and a name we can't place is noted for what it might be. It counts whatever else the message names.
   */
  observe(evt: ChatMessageEvent, aliases: RoomAliases | null = null): void {
    const senderAgent = this.directory.agentForSender(evt.sender, evt.senderName);
    // Before this message counts as its answer: an agent passing a request on hasn't answered the person who gave it.
    const stillWaiting = senderAgent ? this.stillWaitingOn(senderAgent) : [];
    if (senderAgent) this.recordAgentMessage(senderAgent, evt);
    const named = mentionedNames(evt.body);
    const mentioned = [
      ...new Set(named.flatMap((name) => this.directory.agentNamed(name) ?? aliases?.[name.toLowerCase()] ?? [])),
    ];
    const senderPerson = this.directory.personByParticipant(evt.sender);
    const onBehalfOf = this.identifyDisplayName(evt.onBehalfOf);
    const speaking = !senderAgent && !CARD_ANSWER.test(evt.body);
    const voices = [...new Set([senderPerson?.id ?? (onBehalfOf ? null : evt.sender), onBehalfOf])].filter((id): id is string => id !== null);
    if (speaking && !aliases) {
      for (const name of named.filter((one) => !this.directory.knowsMention(one))) {
        for (const userId of voices) this.recordPossibleAsk(evt, userId, name);
      }
    }
    if (mentioned.length === 0) {
      if (speaking && !this.onlySpeaksToClearance(evt, named)) {
        for (const userId of voices) this.recordVoice(evt, userId);
      }
      return;
    }
    for (const agent of mentioned) {
      if (agent === senderAgent) continue;
      if (senderAgent) {
        // Those it only guesses at stay guesses, whichever agent they've reached, or chat could move a decision through a chain.
        const guesses = new Set([...this.voicesOf(senderAgent), ...stillWaiting]);
        for (const userId of new Set([...this.requestersOf(senderAgent), ...stillWaiting])) this.record(agent, evt, userId, senderAgent, guesses.has(userId));
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

  /**
   * A command to Clearance isn't asking anyone else for anything. A request with Clearance's name beside it is still a
   * request, and so is a command with a name in it that could be how an agent is addressed, like a role.
   */
  private onlySpeaksToClearance(evt: ChatMessageEvent, named: string[]): boolean {
    if (!isCommandToClearance(evt)) return false;
    return named.every((name) => name.toLowerCase() === "clearance" || this.directory.knowsMention(name));
  }

  /** Who spoke where, for as long as that can matter and no longer. Only that: what they said isn't kept. */
  private recordVoice(evt: ChatMessageEvent, userId: string): void {
    const now = this.clock.nowMs();
    this.db.prepare(`DELETE FROM room_voices WHERE at <= ?`).run(now - VOICE_KEEP_MS);
    this.db
      .prepare(`INSERT INTO room_voices (room, user_id, at, sent_at) VALUES (?, ?, ?, ?)`)
      .run(evt.roomId, userId, now, sentAt(evt));
  }

  private recordPossibleAsk(evt: ChatMessageEvent, userId: string, name: string): void {
    const now = this.clock.nowMs();
    this.db.prepare(`DELETE FROM possible_asks WHERE at <= ?`).run(now - REQUESTER_WINDOW_MS);
    this.db.prepare(`INSERT INTO possible_asks (room, user_id, name, at) VALUES (?, ?, ?, ?)`).run(evt.roomId, userId, name, now);
  }

  /** The person's id, or the name as given when it maps to nobody: that keeps them a requester and widens nothing. */
  private identifyDisplayName(name: string | null | undefined): string | null {
    if (!name?.trim()) return null;
    return this.directory.personByDisplayName(name)?.id ?? name;
  }

  private record(agent: string, evt: ChatMessageEvent, userId: string, onBehalfOf: string | null, guess = false): void {
    this.db
      .prepare(`INSERT INTO requesters (agent, room, thread, user_id, on_behalf_of, at, sent_at, guess) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(agent, evt.roomId, evt.threadId ?? null, userId, onBehalfOf, this.clock.nowMs(), sentAt(evt), guess ? 1 : 0);
  }

  private recordAgentMessage(agent: string, evt: ChatMessageEvent): void {
    this.db
      .prepare(`INSERT INTO agent_messages (agent, room, thread, body, at) VALUES (?, ?, ?, ?, ?)`)
      .run(agent, evt.roomId, evt.threadId ?? null, evt.body, this.clock.nowMs());
  }

  /** Everyone who asked this agent in the window, or only those in `room` when the call says where it came from. */
  requestersOf(agent: string, room?: string): string[] {
    const since = this.clock.nowMs() - REQUESTER_WINDOW_MS;
    // The rooms this agent is known to be in: it has spoken there, or someone has addressed it there.
    const rows = this.db
      .prepare(
        `SELECT user_id, MIN(at) AS first FROM (
           SELECT user_id, at FROM requesters WHERE agent = @agent AND at > @since AND (@room IS NULL OR room = @room)
           UNION ALL
           SELECT user_id, at FROM room_voices WHERE at > @since AND (@room IS NULL OR room = @room) AND room IN (
             SELECT room FROM agent_messages WHERE agent = @agent AND at > @recent
             UNION
             SELECT room FROM requesters WHERE agent = @agent AND at > @recent
           )
         ) GROUP BY user_id ORDER BY first`,
      )
      .all({ agent, since, room: room ?? null, recent: this.clock.nowMs() - IN_ROOM_MS }) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  /** Those of `requestersOf` who only spoke in a room the agent is in, or reached it through a guess, and never named it. */
  voicesOf(agent: string): string[] {
    const now = this.clock.nowMs();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT user_id FROM (
           SELECT user_id FROM room_voices WHERE at > @since AND room IN (
             SELECT room FROM agent_messages WHERE agent = @agent AND at > @recent
             UNION
             SELECT room FROM requesters WHERE agent = @agent AND at > @recent
           )
           UNION ALL
           SELECT user_id FROM requesters WHERE agent = @agent AND at > @since AND guess = 1
         ) WHERE user_id NOT IN (SELECT user_id FROM requesters WHERE agent = @agent AND at > @since AND guess = 0)`,
      )
      .all({ agent, since: now - REQUESTER_WINDOW_MS, recent: now - IN_ROOM_MS }) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  /**
   * People who, in the window, wrote a name that could be this agent under an alias, when Switch couldn't say whether it
   * is. They may have asked, and can't be counted as having asked.
   */
  possibleAskers(agent: string): string[] {
    const rows = this.db
      .prepare(`SELECT user_id, name FROM possible_asks WHERE at > ?`)
      .all(this.clock.nowMs() - REQUESTER_WINDOW_MS) as { user_id: string; name: string }[];
    return [...new Set(rows.filter((row) => this.directory.couldBeNameOf(agent, row.name)).map((row) => row.user_id))];
  }

  /** People past the window who are still waiting on what they asked this agent for: see TURN_MAX_MS. */
  stillWaitingOn(agent: string): string[] {
    const now = this.clock.nowMs();
    const asked = this.db
      .prepare(`SELECT user_id, room, at FROM requesters WHERE agent = @agent AND at > @longest AND at <= @window`)
      .all({ agent, longest: now - TURN_MAX_MS, window: now - REQUESTER_WINDOW_MS }) as { user_id: string; room: string; at: number }[];
    // What Switch posts in the agent's name isn't the agent answering. "I'll pick this up when I'm back" means it's still to come.
    const replied = (ask: { room: string; at: number }) =>
      (this.db.prepare(`SELECT body FROM agent_messages WHERE agent = ? AND room = ? AND at >= ?`).all(agent, ask.room, ask.at) as { body: string }[]).some(
        (row) => !isSwitchNotice(row.body),
      );
    return [...new Set(asked.filter((ask) => !replied(ask)).map((ask) => ask.user_id))];
  }

  /**
   * People whose message was sent in the window before `atMs` and only reached us after it. Who asked is fixed when a call
   * is held, but the stream is read one frame at a time and only opens after core starts serving, so an ask can be
   * overtaken by the call it led to. Asked at answer time, so it bars them however late it came.
   */
  askedBeforeArriving(agent: string, atMs: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT user_id FROM (
           SELECT user_id, at, sent_at FROM requesters WHERE agent = @agent
           UNION ALL
           SELECT user_id, at, sent_at FROM room_voices WHERE room IN (
             SELECT room FROM agent_messages WHERE agent = @agent AND at > @recent
             UNION
             SELECT room FROM requesters WHERE agent = @agent AND at > @recent
           )
         ) WHERE at >= @atMs AND sent_at <= @atMs AND sent_at > @since`,
      )
      .all({ agent, atMs, since: atMs - REQUESTER_WINDOW_MS, recent: atMs - IN_ROOM_MS }) as { user_id: string }[];
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
   * What the agent just said where this call came from, newest first: in the thread, and in the room as well. A call's
   * thread is only the agent's word for it, so naming a quiet one can't take what it said in the room out of the evidence.
   * Older than the requester window says nothing about this call.
   */
  lastMessages(agent: string, room: string | null, thread: string | null, count: number): string[] {
    if (!room) return [];
    const since = this.clock.nowMs() - REQUESTER_WINDOW_MS;
    // Switch's own notices are kept for who was where, and left out of what the agent said. They can't push a real
    // message out of the window, because the query reads past them.
    const read = (sql: string, ...params: unknown[]) =>
      (this.db.prepare(sql).all(...params) as { body: string }[])
        .map((row) => row.body)
        .filter((body) => !isSwitchNotice(body) && !isOnlyAReport(body))
        .slice(0, count);
    const limit = count + NOTICES_TO_READ_PAST;
    const inThread = thread
      ? read(
          `SELECT body FROM agent_messages WHERE agent = ? AND room = ? AND thread = ? AND at > ? ORDER BY at DESC, id DESC LIMIT ?`,
          agent,
          room,
          thread,
          since,
          limit,
        )
      : [];
    // Everything else in the room, so a few quiet words in the thread can't push the rest out of what's read.
    const inRoom = read(
      `SELECT body FROM agent_messages WHERE agent = ? AND room = ? AND (? IS NULL OR thread IS NOT ?) AND at > ? ORDER BY at DESC, id DESC LIMIT ?`,
      agent,
      room,
      thread,
      thread,
      since,
      limit,
    );
    return [...new Set([...inThread, ...inRoom])];
  }
}
