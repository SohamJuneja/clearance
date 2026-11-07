/**
 * Everything core needs from Switch, as the `ChatPort` in contracts. Core decides; this only carries.
 *
 * Handles: Switch mints `A<n>` per Mattermost channel when it draws the card, and only ever writes it
 * into the post. The approvals API does not return it, so reading it back takes a Mattermost credential
 * (see `createMattermostHandleResolver`). `handle` is therefore optional and best effort. A handle means
 * nothing outside its channel: `A3` in a direct room and `A3` in #approvals are different cards.
 */
import type { CardOption, ChatPort, OpenCardInput, OpenCardResult } from "@clearance/contracts";
import { randomUUID } from "node:crypto";
import { roomSessionId, SwitchApiError, type ApprovalOption, type ApprovalQuestion, type SwitchAgent } from "./agent.js";

const MAX_TITLE = 500;
const MAX_DETAIL = 4000;

export type HandleResolver = (card: { roomId: string; title: string; openedAtMs?: number }) => Promise<string | undefined>;

export type ChatPortOptions = {
  /** The agent's own name, as registered. */
  agentName?: string;
  /** Reads the short handle a card was given. Without one, `OpenCardResult.handle` stays unset. */
  resolveHandle?: HandleResolver;
  /** Participant id to name, for a target given by id. Switch addresses by name only. */
  participantNames?: Record<string, string>;
  warn?: (message: string) => void;
};

const WORDS_ACCEPT = new Set(["allow", "approve", "approved", "accept", "yes", "ok"]);
const WORDS_DECLINE = new Set(["deny", "denied", "decline", "reject", "no"]);

/**
 * What choosing an option means, which is what a typed "yes" or "no" resolves by. An option with no
 * meaning we can name becomes `cancel`, which Switch keeps reachable by number alone: a bare "yes" must
 * never land on an option nobody said was a yes.
 */
export function optionDecision(option: CardOption): ApprovalOption["decision"] {
  if (option.decision) return option.decision;
  const id = option.id.toLowerCase();
  if (WORDS_ACCEPT.has(id)) return "accept";
  if (WORDS_DECLINE.has(id)) return "decline";
  return "cancel";
}

function toOption(option: CardOption): ApprovalOption {
  // An approval option has no description on the wire, so it goes in the label or nowhere.
  const label = option.description ? `${option.label}: ${option.description}` : option.label;
  return { id: option.id, label, decision: optionDecision(option) };
}

function toQuestion(question: OpenCardInput["questions"][number]): ApprovalQuestion {
  return {
    id: question.id,
    title: question.title,
    prompt: question.prompt,
    options: question.options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description ?? null,
    })),
    multi_select: question.multiSelect,
    allow_custom_answer: question.allowCustomAnswer,
  };
}

/** Switch would refuse these anyway. Refusing here says which card and why, and nothing is cut off. */
function checkLimits(input: OpenCardInput): void {
  if (!input.title.trim()) throw new Error("A card needs a title");
  if (input.title.length > MAX_TITLE) throw new Error(`Card title is ${input.title.length} characters, at most ${MAX_TITLE}`);
  if (input.detail.length > MAX_DETAIL) throw new Error(`Card detail is ${input.detail.length} characters, at most ${MAX_DETAIL}`);
}

/** The participant name Switch's targeted messages take. */
function targetName(target: string, names: Record<string, string>): string {
  if (/^@.+:.+$/.test(target)) {
    const name = names[target];
    if (!name) throw new Error(`No name known for participant ${target}; Switch addresses by name`);
    return name;
  }
  return target.replace(/^@/, "");
}

/** Mattermost opens a direct room when the person first writes to the agent, and it is named like this. */
export function directRoomName(userName: string, agentName: string): string {
  return `Mattermost: ${userName} / ${agentName}`;
}

/** The stand-in when the person has not opened a direct room: a private channel with only them in it. */
export function fallbackRoomName(userName: string, agentName: string): string {
  return `${agentName}-${userName}`;
}

type ListedRoom = { room_id: string; name: string; archived?: boolean };
type RoomDetail = { channel_type?: string | null; external_channel_id?: string | null; connected_user_names?: string[] };
type DocumentEntry = { id: string; name: string };
type AgentRow = { id: string; name: string };
type AgentDetailRead = {
  rooms: { room_id: string; archived?: boolean }[];
  sessions: { room_id: string | null; state: string }[];
};

export function createChatPort(agent: SwitchAgent, options: ChatPortOptions = {}): ChatPort {
  const agentName = options.agentName ?? "clearance";
  const names = options.participantNames ?? {};
  const warn = options.warn ?? ((message: string) => process.stderr.write(`[switch-agent] ${message}\n`));
  const directRooms = new Map<string, string>();
  const documents = new Map<string, string>();
  const reportedTurns = new Set<string>();
  const agentIds = new Map<string, string>();

  async function roomNamed(name: string): Promise<ListedRoom | undefined> {
    const rooms = await agent.op<ListedRoom[]>("list_rooms", { include_archived: true });
    return rooms.find((room) => room.name === name);
  }

  async function usable(room: ListedRoom): Promise<string> {
    if (room.archived) await agent.op("unarchive_room", { room_id: room.room_id });
    return room.room_id;
  }

  async function findDirectRoom(userName: string): Promise<string | undefined> {
    const room = await roomNamed(directRoomName(userName, agentName));
    if (!room) return undefined;
    const detail = await agent.op<RoomDetail>("get_room_detail", { room_id: room.room_id });
    return detail.channel_type === "direct" ? usable(room) : undefined;
  }

  async function ensureFallbackRoom(userName: string): Promise<string> {
    const name = fallbackRoomName(userName, agentName);
    const existing = await roomNamed(name);
    if (existing) return usable(existing);
    const created = await agent.op<{ id: string }>("create_room", {
      name,
      description: `Clearance and ${userName}: requests waiting on you.`,
      agent_names: [agentName],
      user_names: [userName],
      channel_type: "channel_private",
    });
    return created.id;
  }

  async function findDocument(roomId: string, name: string): Promise<string | undefined> {
    const context = await agent.op<{ documents?: DocumentEntry[] }>(
      "connect_to_room",
      { room_id: roomId, include_general_instructions: false },
      { roomId },
    );
    return context.documents?.find((document) => document.name === name)?.id;
  }

  return {
    async openCard(input: OpenCardInput): Promise<OpenCardResult> {
      checkLimits(input);
      const sessionId = roomSessionId(input.roomId);
      const switchRequestId = input.requestId ?? `card-${randomUUID()}`;
      let turnId = switchRequestId;
      if (input.mentionMessageId) {
        turnId = `turn-${input.mentionMessageId}`;
        // Before the card, and not optional: drawn without its mention a card has a smaller budget for
        // `detail`, and a card over budget loses its buttons.
        if (!reportedTurns.has(turnId)) {
          await agent.reportTurn(sessionId, { turnId, messageId: input.mentionMessageId, occurredAt: new Date() });
          reportedTurns.add(turnId);
        }
      }
      const openedAtMs = Date.now();
      await agent
        .openApproval({
          session_id: sessionId,
          request_id: switchRequestId,
          turn_id: turnId,
          kind: input.kind,
          title: input.title,
          detail: input.detail ? input.detail : null,
          options: input.kind === "approval" ? input.options.map(toOption) : [],
          questions: input.kind === "questions" ? input.questions.map(toQuestion) : [],
          room_id: input.roomId,
          thread_id: input.threadId ?? null,
          expires_at: input.expiresAtMs === undefined ? null : new Date(Math.min(input.expiresAtMs, openedAtMs + CARD_MAX_OPEN_MS)).toISOString(),
        })
        .catch((error: unknown) => {
          // An id of ours is used once, so a conflict on it means an earlier attempt got through and only its answer was
          // lost. That card is live and answerable, and treating it as failed would open a second one for the same person.
          if (!(input.requestId && isRequestConflict(error))) throw error;
          warn(`${switchRequestId} was already open: an earlier attempt got through`);
        });
      let handle: string | undefined;
      if (options.resolveHandle) {
        // The card is already live and answerable. Not knowing its short name is no reason to fail.
        handle = await options
          .resolveHandle({ roomId: input.roomId, title: input.title, openedAtMs })
          .catch((error: Error) => {
            warn(`could not read the handle of ${switchRequestId}: ${error.message}`);
            return undefined;
          });
      }
      return handle ? { sessionId, switchRequestId, handle } : { sessionId, switchRequestId };
    },

    async closeCard(sessionId, switchRequestId) {
      await agent.closeApproval(sessionId, switchRequestId);
    },

    async postMessage({ roomId, body, threadId }) {
      if (threadId) {
        const result = await agent.op<{ event_id: string }>("post_message", { body, thread_id: threadId }, { roomId });
        return { messageId: result.event_id };
      }
      const result = await agent.sendMessage(roomId, body);
      return { messageId: result.eventId };
    },

    async sendTargeted({ roomId, body, targets, threadId }) {
      const result = await agent.op<{ target_statuses?: Record<string, string> }>(
        "send_targeted_message",
        { body, target_names: targets.map((target) => targetName(target, names)), thread_id: threadId ?? null },
        { roomId },
      );
      // The message went out either way. A status like this means an agent will not wake for it.
      for (const [target, status] of Object.entries(result.target_statuses ?? {})) {
        if (status !== "live" && status !== "sent") warn(`targeted message to ${target} in ${roomId}: ${status}`);
      }
    },

    async ensureDirectRoom({ userName }) {
      const cached = directRooms.get(userName);
      if (cached) return { roomId: cached };
      const roomId = (await findDirectRoom(userName)) ?? (await ensureFallbackRoom(userName));
      directRooms.set(userName, roomId);
      return { roomId };
    },

    async unseenRoomCount(target) {
      let id = agentIds.get(target);
      if (!id) {
        const rows = await agent.op<AgentRow[]>("list_agents", { name_contains: target });
        id = rows.find((row) => row.name === target)?.id;
        if (!id) throw new Error(`Switch has no agent named ${target}`);
        agentIds.set(target, id);
      }
      const [detail, mine] = await Promise.all([
        agent.op<AgentDetailRead>("get_agent_detail", { agent_id: id }),
        agent.op<ListedRoom[]>("list_rooms", { include_archived: true }),
      ]);
      const heard = new Set(mine.map((room) => room.room_id));
      const unseen = new Set<string>();
      // Membership, which Switch shows for any kind of agent, but only for rooms Clearance's owner may read.
      for (const room of detail.rooms) if (!room.archived && !heard.has(room.room_id)) unseen.add(room.room_id);
      // A session, which shows the room's id even when its name is withheld. One with no room says nothing:
      // that is an always-on connection, or a managed agent, for which Switch doesn't know where its sessions are.
      for (const session of detail.sessions) {
        if (session.state !== "stale" && session.room_id !== null && !heard.has(session.room_id)) unseen.add(session.room_id);
      }
      return unseen.size;
    },

    async roomAliases(roomId) {
      const participants = await agent.op<{ name: string; alias?: string | null }[]>("list_participants", {}, { roomId });
      return Object.fromEntries(participants.flatMap((row) => (row.alias ? [[row.alias.toLowerCase(), row.name]] : [])));
    },

    async roomRoles(roomId) {
      const roles = await agent.op<{ name: string; held_by?: { name: string }[] | null }[]>("list_roles", {}, { roomId });
      return Object.fromEntries(roles.map((role) => [role.name.toLowerCase(), (role.held_by ?? []).map((holder) => holder.name)]));
    },

    async upsertDocument({ roomId, name, content }) {
      const key = `${roomId}\u0000${name}`;
      let id = documents.get(key) ?? (await findDocument(roomId, name));
      if (id) {
        try {
          await agent.op("update_room_document", { document_id: id, content }, { roomId });
          documents.set(key, id);
          return;
        } catch (error) {
          // A person may delete a room document from the room's UI. Anything else is a real failure.
          if (!(error instanceof SwitchApiError) || error.status !== 400 || !/not found/i.test(error.message)) throw error;
          documents.delete(key);
          id = undefined;
        }
      }
      const created = await agent.op<{ document_id: string }>(
        "create_room_document",
        {
          name,
          description: `Written by Clearance: ${name}`,
          instructions: "Written by Clearance. Read it; do not rely on any copy of it elsewhere.",
          content,
        },
        { roomId },
      );
      documents.set(key, created.document_id);
    },
  };
}

export type MattermostHandleResolverConfig = {
  agent: SwitchAgent;
  mattermostUrl: string;
  /**
   * A Mattermost token, used read-only and never logged. Handles are only found in channels it can
   * read: the account in `secrets.json` as `mattermostTokens.user` reads every channel the bridge
   * created, and no real DMs.
   */
  token: string;
  /** How long to wait for the card to be drawn. It took about 200 ms on the demo host. */
  timeoutMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
};

/** Compare past Mattermost's escaping: `@` gains a zero-width space and markup gains backslashes. */
function comparable(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/**
 * Switch refuses a card that would stay open more than 24 hours, whatever it is for. A proposal can stay open for days,
 * so its card expires first, and asking again opens a new one. A minute's margin, for the two clocks.
 */
export const CARD_MAX_OPEN_MS = 24 * 60 * 60 * 1000 - 60_000;

function isRequestConflict(error: unknown): boolean {
  return error instanceof SwitchApiError && error.status === 409 && (error.detail as { code?: unknown } | null)?.code === "REQUEST_CONFLICT";
}

/** Switch and Mattermost run on their own clocks, in containers on the same host. */
const CLOCK_SLACK_MS = 2_000;

/**
 * Finds a card by its title in the room's channel and reads the handle off it. Titles carry the
 * request id (`CLR-0042 ...`), so two open cards never share one.
 */
export function createMattermostHandleResolver(config: MattermostHandleResolverConfig): HandleResolver {
  const doFetch = config.fetch ?? fetch;
  const baseUrl = config.mattermostUrl.replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? 3000;
  const pollMs = config.pollMs ?? 150;
  const channels = new Map<string, string>();

  return async ({ roomId, title, openedAtMs }) => {
    let channelId = channels.get(roomId);
    if (!channelId) {
      const detail = await config.agent.op<RoomDetail>("get_room_detail", { room_id: roomId });
      if (!detail.external_channel_id) return undefined;
      channelId = detail.external_channel_id;
      channels.set(roomId, channelId);
    }
    const wanted = comparable(title);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // The whole search has this long. Without a limit on each read, a stalled Mattermost holds up whoever is opening the
      // card, and they may be the only thing reading the stream.
      const res = await doFetch(`${baseUrl}/api/v4/channels/${channelId}/posts?per_page=30`, {
        headers: { authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      // A real DM holds only the person and the agent, so most tokens cannot read one. That card still
      // shows its own handle to the person it is for; Clearance just does not learn it.
      if (res.status === 403) return undefined;
      if (!res.ok) throw new Error(`Mattermost answered ${res.status} reading the channel`);
      const body = (await res.json()) as { order: string[]; posts: Record<string, { message: string; create_at?: number }> };
      for (const id of body.order) {
        const post = body.posts[id];
        // Ids restart after a world reset, so an older card can read exactly the same. Its handle is not this card's,
        // and the card itself may not have landed yet.
        if (openedAtMs !== undefined && post?.create_at !== undefined && post.create_at < openedAtMs - CLOCK_SLACK_MS) continue;
        const message = post?.message ?? "";
        const handle = /request `(A\d+)`/.exec(message)?.[1];
        if (handle && comparable(message).includes(wanted)) return handle;
      }
      if (Date.now() >= deadline) return undefined;
      await new Promise((done) => setTimeout(done, pollMs));
    }
  };
}
