/**
 * Switch's agent protocol: one SSE stream down, HTTP up.
 *
 * One connection carries everything. It is `scope=all&filter=all`, so it hears every room the agent is
 * in, and it declares protocol revision 9, without which Switch withholds `approval_outcome` frames.
 *
 * Room-scoped operations are the awkward part: on an all-scope connection Switch refuses them with
 * "this connection covers several rooms". The way through is what Switch's own watcher does: one
 * session per room placed on the connection, named by a header on each call. Claiming a room from a
 * second connection instead would take that room off this stream, and its events with it.
 */
import type { ApprovalOutcomeEvent, ChatMessageEvent } from "@clearance/contracts";
import { createParser } from "eventsource-parser";
import { randomUUID } from "node:crypto";
import {
  ApprovalOutcomeFrameSchema,
  ApprovalViewSchema,
  CommandFrameSchema,
  ConnectionStateSchema,
  EvictedFrameSchema,
  GapFrameSchema,
  MessageFrameSchema,
  PROTOCOL_REVISION,
  RoomJoinFrameSchema,
  RoomReleasedFrameSchema,
  SubscriptionChangedFrameSchema,
  toApprovalOutcomeEvent,
  toChatMessageEvent,
  type ApprovalView,
  type CommandFrame,
  type ConnectionState,
  type EvictedFrame,
  type GapFrame,
  type Position,
  type RoomJoinFrame,
} from "./wire.js";

export type Logger = {
  warn(message: string): void;
  error(message: string): void;
};

export type SwitchAgentConfig = {
  /** The bridge API, for example http://127.0.0.1:8000. Not the Gateway. */
  bridgeUrl: string;
  agentId: string;
  /** Never logged. */
  apiKey: string;
  /** Reused across reconnects. Two processes must never share one: each would evict the other. */
  connectionId?: string;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Delays between reopen attempts, in ms, doubling from the first to the second. */
  reconnectDelayMs?: { first: number; max: number };
  /** Reopen if nothing at all arrives for this long. Switch writes a keepalive every 15 s. */
  idleTimeoutMs?: number;
  /** Overrides the 2 s heartbeat. For tests. */
  heartbeatMs?: number;
  /** Overrides the backoff between retries of an unsettled outcome. For tests. */
  outcomeRetryMs?: number;
};

/** A refused call. `detail` is Switch's own words; nothing here carries a credential. */
export class SwitchApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly detail: unknown,
  ) {
    super(`Switch ${path} answered ${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    this.name = "SwitchApiError";
  }
}

export type ApprovalOption = {
  id: string;
  label: string;
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
};
export type ApprovalQuestion = {
  id: string;
  title: string;
  prompt: string;
  options: { id: string; label: string; description: string | null }[];
  multi_select: boolean;
  allow_custom_answer: boolean;
};
export type OpenApprovalBody = {
  session_id: string;
  request_id: string;
  turn_id: string;
  kind: "approval" | "questions";
  title: string;
  detail: string | null;
  options: ApprovalOption[];
  questions: ApprovalQuestion[];
  room_id: string | null;
  thread_id: string | null;
  expires_at: string | null;
};

export type SwitchAgentHandlers = {
  message?: (event: ChatMessageEvent) => void | Promise<void>;
  /** Acknowledged to Switch only once this resolves, so a throw means it is delivered again. */
  approvalOutcome?: (event: ApprovalOutcomeEvent) => void | Promise<void>;
  command?: (frame: CommandFrame) => void | Promise<void>;
  roomJoin?: (frame: RoomJoinFrame) => void | Promise<void>;
  /** Events were lost and will not come back. Re-read the room's history before acting on it. */
  gap?: (frame: GapFrame) => void | Promise<void>;
  /** Every raw frame, before parsing. For recording fixtures and for debugging. */
  frame?: (name: string, data: unknown) => void;
  /** Another process took this connection. The client has stopped and will not reopen. */
  takenOver?: (reason: string) => void;
};

export interface SwitchAgent {
  readonly connectionId: string;
  readonly agentId: string;
  /** Opens the stream. Resolves on the first `connection_state`, rejects if the stream was refused for good. */
  start(handlers?: SwitchAgentHandlers): Promise<ConnectionState>;
  stop(): Promise<void>;
  /** Run an operation. Give `roomId` for one that acts in a room. */
  op<T = unknown>(name: string, args?: Record<string, unknown>, opts?: { roomId?: string }): Promise<T>;
  /** `POST /agents/{id}/message`. Needs no connection, and cannot thread. */
  sendMessage(roomId: string, content: string): Promise<{ eventId?: string }>;
  openApproval(body: OpenApprovalBody): Promise<ApprovalView>;
  closeApproval(sessionId: string, requestId: string): Promise<ApprovalView>;
  markDelivered(sessionId: string, requestId: string): Promise<ApprovalView>;
  /** Answers and expiries not yet acknowledged, oldest first. The stream also redelivers these on open. */
  undeliveredOutcomes(): Promise<ApprovalView[]>;
}

const CLIENT_NAME = "clearance-switch-agent";
const CLIENT_VERSION = "0.1.0";
const STOPPED = Symbol("stopped");
/** PLAN B4 asks for 2 s. The pinned server states 10 s and allows 30 s of silence, so 2 s is always safe. */
const HEARTBEAT_MS = 2000;
const OUTCOME_RETRY_MS = [1000, 2000, 4000, 8000];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function detailOf(body: unknown): unknown {
  return body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : body;
}

function codeOf(detail: unknown): string | undefined {
  if (detail && typeof detail === "object" && "code" in detail) {
    const code = (detail as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** The session Clearance places in a room. Stable per room, so a retry names the same one. */
export function roomSessionId(roomId: string): string {
  return `clr-room-${roomId}`;
}

export function createSwitchAgent(config: SwitchAgentConfig): SwitchAgent {
  const baseUrl = config.bridgeUrl.replace(/\/$/, "");
  const doFetch = config.fetch ?? fetch;
  const log: Logger = config.logger ?? {
    warn: (message) => process.stderr.write(`[switch-agent] ${message}\n`),
    error: (message) => process.stderr.write(`[switch-agent] ${message}\n`),
  };
  const connectionId = config.connectionId ?? randomUUID();
  const delays = config.reconnectDelayMs ?? { first: 250, max: 5000 };
  const idleTimeoutMs = config.idleTimeoutMs ?? 40_000;

  let handlers: SwitchAgentHandlers = {};
  let running = false;
  let terminal: string | null = null;
  const stopController = new AbortController();
  let streamController: AbortController | null = null;
  let generation: number | null = null;
  let position: Position | null = null;
  let beatTimer: ReturnType<typeof setInterval> | null = null;
  let loop: Promise<void> | null = null;
  let dispatchQueue: Promise<unknown> = Promise.resolve();

  let firstState: { resolve: (state: ConnectionState) => void; reject: (error: Error) => void } | null = null;
  let connected: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | null = null;

  const placements = new Map<string, string>();
  let placing: Promise<unknown> = Promise.resolve();
  /** Outcomes settled in this process. A resync may offer one again before its ack lands. */
  const settled = new Set<string>();

  function resetConnected(): void {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    connected = { promise, resolve, reject };
  }

  async function request(method: string, path: string, opts: { json?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { authorization: `Bearer ${config.apiKey}`, ...opts.headers };
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: the text is the detail.
    }
    return { status: res.status, body };
  }

  async function expectOk(method: string, path: string, opts: { json?: unknown; headers?: Record<string, string> } = {}) {
    const res = await request(method, path, opts);
    if (res.status < 200 || res.status >= 300) throw new SwitchApiError(res.status, path, detailOf(res.body));
    return res.body;
  }

  function stopBeating(): void {
    if (beatTimer) clearInterval(beatTimer);
    beatTimer = null;
  }

  /** Reopen, the only answer to a refused beat other than `taken_over`: beating again keeps it dead. */
  function reopenNow(): void {
    stopBeating();
    streamController?.abort();
  }

  function becomeTerminal(reason: string): void {
    terminal = reason;
    stopBeating();
    streamController?.abort();
    connected?.reject(new Error(reason));
    firstState?.reject(new Error(reason));
    firstState = null;
    log.error(`stream ended for good: ${reason}`);
    handlers.takenOver?.(reason);
  }

  async function beat(): Promise<void> {
    if (generation === null) return;
    let res: { status: number; body: unknown };
    try {
      res = await request("POST", `/agents/${config.agentId}/connection/beat`, {
        json: { connection_id: connectionId, generation },
      });
    } catch (error) {
      log.warn(`heartbeat did not reach Switch: ${(error as Error).message}`);
      return;
    }
    if (res.status === 200) return;
    if (res.status === 404 || res.status === 409) {
      const code = codeOf(detailOf(res.body));
      if (code === "taken_over") return becomeTerminal("connection taken over by another client");
      log.warn(`heartbeat refused (${res.status}${code ? ` ${code}` : ""}); reopening the stream`);
      return reopenNow();
    }
    log.warn(`heartbeat answered ${res.status}`);
  }

  function streamUrl(): string {
    const params = new URLSearchParams({
      connection_id: connectionId,
      scope: "all",
      filter: "all",
      protocol: String(PROTOCOL_REVISION),
      protocol_accepts: String(PROTOCOL_REVISION),
      client: CLIENT_NAME,
      client_version: CLIENT_VERSION,
      start_at: position ? JSON.stringify(position) : "head",
    });
    if (generation !== null) params.set("expected_generation", String(generation));
    return `${baseUrl}/agents/${config.agentId}/events?${params.toString()}`;
  }

  function mergePosition(next: Position | undefined): void {
    if (!next) return;
    position = position ?? {};
    for (const [source, seq] of Object.entries(next)) {
      if (seq > (position[source] ?? -1)) position[source] = seq;
    }
  }

  /** In arrival order, one at a time: a requester must be tracked before the card that follows is read. */
  function enqueue(task: () => void | Promise<void>): void {
    dispatchQueue = dispatchQueue.then(task).catch((error: unknown) => {
      log.error(`event handler failed: ${(error as Error).message}`);
    });
  }

  function parseFrame<T>(name: string, schema: { safeParse(data: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, data: unknown): T | null {
    const parsed = schema.safeParse(data);
    if (parsed.success) return parsed.data;
    log.error(`dropped a malformed ${name} frame: ${parsed.error.message}`);
    return null;
  }

  /**
   * Handler first, acknowledgement after: an unacknowledged outcome is offered again whenever a stream
   * opens, so a crash in between costs a repeat, never a lost answer. A failure is retried here too,
   * because within one connection Switch does not offer it again by itself.
   */
  async function settleOutcome(frameData: unknown, attempt = 0): Promise<void> {
    const frame = parseFrame("approval_outcome", ApprovalOutcomeFrameSchema, frameData);
    if (!frame) return;
    const key = `${frame.session_id}\u0000${frame.request_id}`;
    try {
      if (!settled.has(key)) {
        await handlers.approvalOutcome?.(toApprovalOutcomeEvent(frame));
        settled.add(key);
      }
      await expectOk(
        "POST",
        `/agent-sessions/${encodeURIComponent(frame.session_id)}/approvals/${encodeURIComponent(frame.request_id)}/delivered`,
      );
    } catch (error) {
      const wait = OUTCOME_RETRY_MS[attempt];
      log.error(`outcome of ${frame.request_id} not settled: ${(error as Error).message}`);
      if (wait === undefined || stopController.signal.aborted) return;
      const timer = setTimeout(() => enqueue(() => settleOutcome(frameData, attempt + 1)), config.outcomeRetryMs ?? wait);
      timer.unref?.();
    }
  }

  function onConnectionState(state: ConnectionState): void {
    generation = state.generation;
    mergePosition(state.position);
    stopBeating();
    const interval = config.heartbeatMs ?? Math.min(HEARTBEAT_MS, state.heartbeat_interval_seconds * 1000);
    beatTimer = setInterval(() => void beat(), interval);
    void beat();
    // Placements live on the connection, and a restart of Switch forgets them.
    if (placements.size > 0) void pushPlacements().catch((error: Error) => log.warn(error.message));
    connected?.resolve();
    firstState?.resolve(state);
    firstState = null;
  }

  function onFrame(name: string, raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      log.error(`dropped an unparseable ${name} frame`);
      return;
    }
    handlers.frame?.(name, data);
    switch (name) {
      case "connection_state": {
        const state = parseFrame(name, ConnectionStateSchema, data);
        if (state) onConnectionState(state);
        return;
      }
      case "message": {
        const frame = parseFrame(name, MessageFrameSchema, data);
        if (!frame) return;
        mergePosition(frame.position);
        enqueue(() => handlers.message?.(toChatMessageEvent(frame)));
        return;
      }
      case "command": {
        const frame = parseFrame(name, CommandFrameSchema, data);
        if (!frame) return;
        mergePosition(frame.position);
        enqueue(() => handlers.command?.(frame));
        return;
      }
      case "room_join": {
        const frame = parseFrame(name, RoomJoinFrameSchema, data);
        if (!frame) return;
        mergePosition(frame.position);
        enqueue(() => handlers.roomJoin?.(frame));
        return;
      }
      case "approval_outcome":
        enqueue(() => settleOutcome(data));
        return;
      case "gap": {
        const frame = parseFrame(name, GapFrameSchema, data);
        if (!frame) return;
        const resumed = (data as { resumed_position?: Position }).resumed_position;
        if (resumed) position = { ...resumed };
        log.warn(`events were lost: ${frame.reason}`);
        enqueue(() => handlers.gap?.(frame));
        return;
      }
      case "evicted": {
        const frame: EvictedFrame | null = parseFrame(name, EvictedFrameSchema, data);
        if (frame?.code === "taken_over") return becomeTerminal(frame.reason);
        log.warn(`stream evicted (${frame?.code ?? "unknown"}): ${frame?.reason ?? ""}; reopening`);
        return reopenNow();
      }
      case "room_released": {
        const frame = parseFrame(name, RoomReleasedFrameSchema, data);
        if (frame) placements.delete(frame.room_id);
        return;
      }
      case "subscription_changed":
        parseFrame(name, SubscriptionChangedFrameSchema, data);
        return;
      default:
        // session_command, task frames: nothing Clearance acts on.
        return;
    }
  }

  async function openStream(): Promise<void> {
    streamController = new AbortController();
    const signal = AbortSignal.any([stopController.signal, streamController.signal]);
    const res = await doFetch(streamUrl(), {
      headers: { authorization: `Bearer ${config.apiKey}`, accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let detail: unknown = text;
      try {
        detail = detailOf(JSON.parse(text));
      } catch {
        // Keep the text.
      }
      if (res.status === 409 && codeOf(detail) === "taken_over") {
        becomeTerminal("connection taken over by another client");
        return;
      }
      if (res.status === 401 || res.status === 403 || (res.status === 409 && codeOf(detail) === undefined)) {
        const error = new SwitchApiError(res.status, "/events", detail);
        // A bad key or a protocol mismatch is not fixed by trying again.
        if (firstState) return becomeTerminal(error.message);
        throw error;
      }
      throw new SwitchApiError(res.status, "/events", detail);
    }

    const parser = createParser({ onEvent: (event) => onFrame(event.event ?? "message", event.data) });
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let idleTimer = setTimeout(reopenNow, idleTimeoutMs);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        clearTimeout(idleTimer);
        if (done) return;
        idleTimer = setTimeout(reopenNow, idleTimeoutMs);
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      clearTimeout(idleTimer);
    }
  }

  async function runLoop(): Promise<void> {
    let delay = delays.first;
    while (!stopController.signal.aborted && terminal === null) {
      resetConnected();
      const openedAt = Date.now();
      try {
        await openStream();
      } catch (error) {
        if (stopController.signal.aborted) break;
        if ((error as Error).name !== "AbortError") {
          log.warn(`stream dropped: ${(error as Error).message}`);
        }
      }
      stopBeating();
      if (stopController.signal.aborted || terminal !== null) break;
      // A stream that held for a while resets the backoff: this drop says nothing about the last one.
      if (Date.now() - openedAt > 10_000) delay = delays.first;
      await sleep(delay, stopController.signal);
      delay = Math.min(delay * 2, delays.max);
    }
    stopBeating();
  }

  async function whenConnected(): Promise<void> {
    if (terminal !== null) throw new Error(`switch-agent stopped: ${terminal}`);
    if (!running) throw new Error("switch-agent is not started");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connected?.promise ?? Promise.resolve(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out waiting for the Switch stream")), 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function pushPlacements(): Promise<unknown> {
    const send = async () => {
      const body = (await expectOk("POST", `/agents/${config.agentId}/connection/placements`, {
        json: { connection_id: connectionId, generation, placements: Object.fromEntries(placements) },
      })) as { refused?: { room_id: string; reason: string }[] };
      for (const refused of body.refused ?? []) {
        for (const [session, room] of placements) {
          if (room === refused.room_id) placements.delete(session);
        }
      }
      return body;
    };
    placing = placing.then(send, send);
    return placing;
  }

  async function sessionFor(roomId: string): Promise<string> {
    const session = roomSessionId(roomId);
    if (placements.get(session) !== roomId) {
      placements.set(session, roomId);
      const body = (await pushPlacements()) as { refused?: { room_id: string; reason: string }[] };
      const refused = body.refused?.find((entry) => entry.room_id === roomId);
      if (refused) throw new SwitchApiError(403, "/connection/placements", refused.reason);
    }
    return session;
  }

  async function op<T>(name: string, args: Record<string, unknown> = {}, opts: { roomId?: string } = {}): Promise<T> {
    await whenConnected();
    const path = `/agents/${config.agentId}/ops/${name}`;
    const attempt = async () => {
      const headers: Record<string, string> = { "x-switch-connection-id": connectionId };
      if (opts.roomId) headers["x-switch-session-id"] = await sessionFor(opts.roomId);
      return request("POST", path, { json: args, headers });
    };
    let res = await attempt();
    const detail = detailOf(res.body);
    const lostRoom = res.status === 400 && typeof detail === "string" && detail.includes("Not connected to a room");
    if (lostRoom && opts.roomId) {
      // Switch restarted and forgot the placement, or the connection moved. Say it again, once.
      placements.delete(roomSessionId(opts.roomId));
      res = await attempt();
    } else if (res.status === 409) {
      reopenNow();
      await new Promise((done) => setTimeout(done, delays.first));
      await whenConnected();
      res = await attempt();
    }
    if (res.status < 200 || res.status >= 300) throw new SwitchApiError(res.status, path, detailOf(res.body));
    return (res.body as { result: T }).result;
  }

  return {
    connectionId,
    agentId: config.agentId,

    start(startHandlers = {}) {
      if (running) throw new Error("switch-agent already started");
      running = true;
      handlers = startHandlers;
      resetConnected();
      const first = new Promise<ConnectionState>((resolve, reject) => {
        firstState = { resolve, reject };
      });
      loop = runLoop();
      return first;
    },

    async stop() {
      if (!running) return;
      running = false;
      stopController.abort(STOPPED);
      stopBeating();
      await loop?.catch(() => undefined);
      await dispatchQueue;
    },

    op,

    async sendMessage(roomId, content) {
      const body = (await expectOk("POST", `/agents/${config.agentId}/message`, {
        json: { room_id: roomId, content },
      })) as { event_id?: string };
      return { eventId: body.event_id };
    },

    async openApproval(body) {
      const { session_id: sessionId, ...rest } = body;
      const view = await expectOk("POST", `/agent-sessions/${encodeURIComponent(sessionId)}/approvals`, { json: rest });
      return ApprovalViewSchema.parse(view);
    },

    async closeApproval(sessionId, requestId) {
      const view = await expectOk(
        "POST",
        `/agent-sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(requestId)}/close`,
      );
      return ApprovalViewSchema.parse(view);
    },

    async markDelivered(sessionId, requestId) {
      const view = await expectOk(
        "POST",
        `/agent-sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(requestId)}/delivered`,
      );
      return ApprovalViewSchema.parse(view);
    },

    async undeliveredOutcomes() {
      const views = await expectOk("GET", "/agent-sessions/approvals/outcomes");
      return ApprovalViewSchema.array().parse(views);
    },
  };
}
