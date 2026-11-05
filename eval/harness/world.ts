/**
 * An isolated world: real Acme, gate and core processes on their own ports, with their own databases
 * under `.tmp/`. The live stack is shared and other agents are using it, so nothing here may reach port
 * 7700, 7710 or 7800, `data/` or scripts/services.sh. `assertIsolated` makes that a hard failure.
 *
 * Tokens are generated per world and never written anywhere but the child's environment.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join, relative, resolve } from "node:path";
import { REPO_ROOT } from "../lib/paths.ts";
import {
  AGENT_CLASSES,
  agentCwd,
  IDENTITIES,
  PARTICIPANTS,
  type ParticipantName,
  ROOM,
} from "./identities.ts";

export const SHARED_PORTS = [7700, 7710, 7800] as const;
export const EVAL_PORTS = { core: 17700, gate: 17710, acme: 17800 } as const;

export interface WorldPorts {
  core: number;
  gate: number;
  acme: number;
}

/** Fails if a port or path would touch the shared stack. */
export function assertIsolated(ports: WorldPorts, directory: string): void {
  for (const port of Object.values(ports)) {
    if ((SHARED_PORTS as readonly number[]).includes(port)) {
      throw new Error(`port ${port} belongs to the shared stack. Evals run on their own ports.`);
    }
  }
  const inside = relative(join(REPO_ROOT, ".tmp"), resolve(directory));
  if (inside.startsWith("..") || inside === "") {
    throw new Error(`${directory} isn't under .tmp/. Eval databases stay there.`);
  }
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`waited ${timeoutMs / 1000} s for ${what}`);
    await new Promise((done) => setTimeout(done, 40));
  }
}

export interface HttpResult {
  status: number;
  json: Record<string, unknown>;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

export interface ChatRecord {
  kind: "card" | "close" | "message" | "targeted" | "document";
  at: number;
  roomId?: string;
  threadId?: string;
  title?: string;
  detail?: string;
  body?: string;
  targets?: string[];
  sessionId?: string;
  switchRequestId?: string;
  handle?: string;
}

export interface LedgerRow {
  seq: number;
  type: string;
  request_id: string | null;
  payload: Record<string, unknown>;
}

export interface WorldOptions {
  /** A name for this world's directory under `.tmp/eval/`. */
  name: string;
  ports?: WorldPorts;
  timeScale?: number;
  /** Extra gate classes per agent, for a case that needs a wider token than the demo's. */
  extraClasses?: Record<string, string[]>;
  keepFiles?: boolean;
}

type ServiceName = "acme" | "gate" | "core";

const ENTRY: Record<ServiceName, string> = {
  acme: "packages/acme/src/main.ts",
  gate: "packages/gate/src/main.ts",
  core: "eval/harness/core-main.ts",
};

export class IsolatedWorld {
  readonly ports: WorldPorts;
  readonly directory: string;
  private readonly adminKey = randomBytes(24).toString("hex");
  private readonly internalToken = randomBytes(24).toString("hex");
  readonly hookToken = randomBytes(24).toString("hex");
  private readonly gateTokens: Record<string, string> = {};
  private readonly processes = new Map<ServiceName, ChildProcess>();
  private readonly chatLog: string;
  private readonly timeScale: number;
  private messageCounter = 0;
  private readonly keepFiles: boolean;
  private readonly answeredCards = new Set<string>();

  private constructor(options: WorldOptions) {
    this.ports = options.ports ?? EVAL_PORTS;
    this.directory = join(REPO_ROOT, ".tmp", "eval", options.name);
    assertIsolated(this.ports, this.directory);
    rmSync(this.directory, { recursive: true, force: true });
    mkdirSync(this.directory, { recursive: true });
    this.chatLog = join(this.directory, "chat.jsonl");
    writeFileSync(this.chatLog, "");
    writeFileSync(join(this.directory, "identities.json"), JSON.stringify(IDENTITIES));
    this.timeScale = options.timeScale ?? 1;
    this.keepFiles = options.keepFiles ?? false;
    for (const agent of Object.keys(AGENT_CLASSES)) {
      this.gateTokens[agent] = randomBytes(18).toString("hex");
    }
    this.extraClasses = options.extraClasses ?? {};
  }

  private readonly extraClasses: Record<string, string[]>;

  /** Starts Acme, then gate, then core. Refuses if anything is already on these ports. */
  static async start(options: WorldOptions): Promise<IsolatedWorld> {
    const world = new IsolatedWorld(options);
    for (const [name, port] of Object.entries(world.ports)) {
      if (await portIsOpen(port)) {
        throw new Error(`port ${port} (${name}) is already in use. Is another eval still running?`);
      }
    }
    try {
      await world.startService("acme");
      await world.startService("gate");
      await world.startService("core");
    } catch (error) {
      await world.stop();
      throw error;
    }
    return world;
  }

  private env(service: ServiceName): NodeJS.ProcessEnv {
    const common = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: join(REPO_ROOT, ".tmp"),
      LOG_LEVEL: "warn",
    };
    const url = (port: number): string => `http://127.0.0.1:${port}`;
    if (service === "acme") {
      return {
        ...common,
        ACME_PORT: String(this.ports.acme),
        ACME_HOST: "127.0.0.1",
        ACME_DB_PATH: join(this.directory, "acme.sqlite"),
        ACME_ADMIN_KEY: this.adminKey,
      };
    }
    if (service === "gate") {
      const tokens = Object.fromEntries(
        Object.entries(AGENT_CLASSES).map(([agent, classes]) => [
          this.gateTokens[agent],
          { agent, classes: [...classes, ...(this.extraClasses[agent] ?? [])] },
        ]),
      );
      return {
        ...common,
        CLEARANCE_GATE_PORT: String(this.ports.gate),
        CLEARANCE_GATE_DB_PATH: join(this.directory, "gate.sqlite"),
        CLEARANCE_CORE_URL: url(this.ports.core),
        ACME_URL: url(this.ports.acme),
        ACME_ADMIN_KEY: this.adminKey,
        CLEARANCE_INTERNAL_TOKEN: this.internalToken,
        GATE_AGENT_TOKENS: JSON.stringify(tokens),
      };
    }
    return {
      ...common,
      CLEARANCE_CORE_PORT: String(this.ports.core),
      CLEARANCE_GATE_URL: url(this.ports.gate),
      CLEARANCE_DB_PATH: join(this.directory, "clearance.sqlite"),
      CLEARANCE_POLICY_PATH: join(REPO_ROOT, "policy/clearance.policy.yaml"),
      CLEARANCE_TEAM_PATH: join(REPO_ROOT, "policy/team.yaml"),
      CLEARANCE_IDENTITIES_PATH: join(this.directory, "identities.json"),
      CLEARANCE_DRILLS_PATH: join(REPO_ROOT, "drills/flaws.yaml"),
      CLEARANCE_INTERNAL_TOKEN: this.internalToken,
      CLEARANCE_HOOK_TOKEN: this.hookToken,
      CLEARANCE_TIME_SCALE: String(this.timeScale),
      EVAL_CHAT_LOG: this.chatLog,
    };
  }

  /**
   * Each service gets its own process group, so stopping one can't leave a child holding its port.
   * Runs the real node binary rather than a shim on PATH, which would add its own start-up time.
   */
  async startService(service: ServiceName): Promise<void> {
    const log = openSync(join(this.directory, `${service}.log`), "a");
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY[service]], {
      cwd: REPO_ROOT,
      env: this.env(service),
      detached: true,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    this.processes.set(service, child);
    let exited: number | null | undefined;
    child.once("exit", (code) => {
      exited = code;
    });
    await waitFor(
      `${service} to answer on port ${this.ports[service]}`,
      async () => exited !== undefined || portIsOpen(this.ports[service]),
    );
    if (exited !== undefined) {
      const tail = readFileSync(join(this.directory, `${service}.log`), "utf8").slice(-600);
      throw new Error(`${service} exited ${String(exited)}: ${tail}`);
    }
  }

  /** Kills a service. SIGKILL by default, because that's what a crash looks like. */
  async killService(service: ServiceName, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    const child = this.processes.get(service);
    if (!child?.pid) return;
    const gone = new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) done();
      else child.once("exit", () => done());
    });
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
    await gone;
    this.processes.delete(service);
    await waitFor(
      `port ${this.ports[service]} to close`,
      async () => !(await portIsOpen(this.ports[service])),
    );
  }

  async stop(): Promise<void> {
    for (const service of ["core", "gate", "acme"] as const) {
      await this.killService(service, "SIGTERM").catch(() => undefined);
    }
    if (!this.keepFiles) rmSync(this.directory, { recursive: true, force: true });
  }

  /** Peak resident memory of the three services, in MB, for the record. */
  residentMb(): number {
    let total = 0;
    for (const child of this.processes.values()) {
      if (!child.pid) continue;
      try {
        const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
        total += Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) / 1024;
      } catch {
        // A process that has just gone has no memory to count.
      }
    }
    return Math.round(total);
  }

  // ── Talking to core, as the Switch agent would ─────────────────────────────

  private internalHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.internalToken}`, "content-type": "application/json" };
  }

  async corePost(path: string, body: unknown): Promise<HttpResult> {
    const res = await fetch(`http://127.0.0.1:${this.ports.core}${path}`, {
      method: "POST",
      headers: this.internalHeaders(),
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await readJson(res) };
  }

  async coreGet(path: string): Promise<HttpResult> {
    const res = await fetch(`http://127.0.0.1:${this.ports.core}${path}`, {
      headers: { authorization: `Bearer ${this.internalToken}` },
    });
    return { status: res.status, json: await readJson(res) };
  }

  /** A chat message arriving on the stream, in the shape packages/switch-agent/src/wire.ts produces. */
  async say(
    sender: ParticipantName,
    senderName: string,
    body: string,
    roomId: string = ROOM.support,
  ): Promise<void> {
    this.messageCounter += 1;
    const res = await this.corePost("/eval/message", {
      roomId,
      threadId: "thread-1",
      messageId: `sw_eval_${this.messageCounter}`,
      sender: PARTICIPANTS[sender],
      senderName,
      onBehalfOf: null,
      addressed: false,
      body,
      timestampMs: Date.now(),
    });
    if (res.status !== 200) throw new Error(`core refused a message: ${res.status}`);
  }

  /** Someone answers a card: the event the Switch agent delivers to core's onApprovalOutcome. */
  async answer(card: ChatRecord, who: ParticipantName, answer: "allow" | "deny"): Promise<void> {
    this.answeredCards.add(card.switchRequestId ?? "");
    const res = await this.corePost("/eval/answer", {
      sessionId: card.sessionId,
      switchRequestId: card.switchRequestId,
      kind: "approval",
      state: "answered",
      answer,
      answeredBy: PARTICIPANTS[who],
      answeredAtMs: Date.now(),
    });
    if (res.status !== 200) throw new Error(`core refused an answer: ${res.status}`);
  }

  /** Everything core has said or opened so far, oldest first. Survives a core restart. */
  chat(): ChatRecord[] {
    if (!existsSync(this.chatLog)) return [];
    return readFileSync(this.chatLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatRecord);
  }

  /**
   * The newest card for a request in a room that can still be answered, or undefined. A card takes one
   * answer, in Switch as here, so one already answered doesn't count even if nothing has closed it.
   */
  card(requestId: string, roomId: string): ChatRecord | undefined {
    const log = this.chat();
    const closed = new Set(
      log.filter((row) => row.kind === "close").map((row) => row.switchRequestId),
    );
    return log
      .filter(
        (row) =>
          row.kind === "card" &&
          row.roomId === roomId &&
          row.title?.includes(requestId) &&
          !closed.has(row.switchRequestId) &&
          !this.answeredCards.has(row.switchRequestId ?? ""),
      )
      .at(-1);
  }

  cards(requestId: string): ChatRecord[] {
    return this.chat().filter((row) => row.kind === "card" && row.title?.includes(requestId));
  }

  async request(id: string): Promise<Record<string, unknown>> {
    return (await this.coreGet(`/v1/requests/${id}`)).json;
  }

  async stateOf(id: string): Promise<string> {
    return String((await this.request(id)).state ?? "");
  }

  async waitState(id: string, wanted: string[], timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let state = "";
    for (;;) {
      state = await this.stateOf(id);
      if (wanted.includes(state) || Date.now() > deadline) return state;
      await new Promise((done) => setTimeout(done, 50));
    }
  }

  async ledger(requestId?: string): Promise<LedgerRow[]> {
    const query = requestId ? `?request_id=${encodeURIComponent(requestId)}` : "";
    const { json } = await this.coreGet(`/v1/ledger${query}`);
    return (json.entries ?? []) as LedgerRow[];
  }

  async ledgerVerifies(): Promise<boolean> {
    const { json } = await this.coreGet("/v1/ledger/verify");
    return json.ok === true;
  }

  async advanceClock(ms: number): Promise<void> {
    await this.corePost("/eval/clock/advance", { ms });
  }

  async setAutonomy(agent: string, cls: string, bucket: string, level: string): Promise<void> {
    const res = await this.corePost("/eval/autonomy", { agent, cls, bucket, level });
    if (res.status !== 200) throw new Error(`could not set autonomy: ${res.status}`);
  }

  // ── Agents' calls ──────────────────────────────────────────────────────────

  /** A call through the gate, with this agent's own token. */
  async gate(
    agent: string,
    method: string,
    path: string,
    body?: unknown,
    room: string = ROOM.support,
  ): Promise<HttpResult> {
    const token = this.gateTokens[agent];
    if (!token) throw new Error(`no gate token for ${agent}`);
    const res = await fetch(`http://127.0.0.1:${this.ports.gate}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-clearance-room": room,
        "x-clearance-thread": "thread-1",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await readJson(res) };
  }

  /** Core's call to the gate, as it makes it on an approval. */
  async gateExecute(requestId: string, callHash: string): Promise<HttpResult> {
    const res = await fetch(`http://127.0.0.1:${this.ports.gate}/internal/execute/${requestId}`, {
      method: "POST",
      headers: this.internalHeaders(),
      body: JSON.stringify({ call_hash: callHash }),
    });
    return { status: res.status, json: await readJson(res) };
  }

  /** A Claude Code PreToolUse hook call, over HTTP, as `.claude/settings.json` sends it. */
  async claudeHook(
    agent: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<{ allow: boolean; reason: string; status: number }> {
    const res = await fetch(`http://127.0.0.1:${this.ports.core}/v1/hooks/claude`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.hookToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        session_id: `eval-${agent}`,
        hook_event_name: "PreToolUse",
        cwd: agentCwd(agent),
        tool_name: tool,
        tool_input: input,
      }),
    });
    const json = await readJson(res);
    const output = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
    return {
      allow: output.permissionDecision === "allow",
      reason: String(output.permissionDecisionReason ?? ""),
      status: res.status,
    };
  }

  // ── Acme ───────────────────────────────────────────────────────────────────

  async acmeState(): Promise<AcmeSnapshot> {
    const res = await fetch(`http://127.0.0.1:${this.ports.acme}/state`, {
      headers: { "x-acme-admin-key": this.adminKey },
    });
    if (!res.ok) throw new Error(`Acme /state answered ${res.status}`);
    return (await res.json()) as AcmeSnapshot;
  }

  /** A call to Acme with no admin key, which is all an agent has. */
  async acmeWithoutKey(method: string, path: string, body: unknown): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${this.ports.acme}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await res.arrayBuffer();
    return res.status;
  }

  /** A write straight to Acme with the admin key, the baseline a gate write is measured against. */
  async acmeWrite(path: string, body: unknown): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${this.ports.acme}${path}`, {
      method: "POST",
      headers: { "x-acme-admin-key": this.adminKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await res.arrayBuffer();
    return res.status;
  }

  /** An allowed read straight to Acme with the admin key, the baseline a gate read is measured against. */
  async acmeRead(path: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${this.ports.acme}${path}`, {
      headers: { "x-acme-admin-key": this.adminKey },
    });
    await res.arrayBuffer();
    return res.status;
  }

  urls(): { core: string; gate: string; acme: string } {
    return {
      core: `http://127.0.0.1:${this.ports.core}`,
      gate: `http://127.0.0.1:${this.ports.gate}`,
      acme: `http://127.0.0.1:${this.ports.acme}`,
    };
  }
}

export interface AcmeSnapshot {
  money_out: number;
  refunds: { id: string; order_id: string; amount: number; destination: string }[];
  deploys: unknown[];
  outbox: unknown[];
  deleted_records: unknown[];
  merges: unknown[];
  destinations_added: unknown[];
}

/** What changed hands in Acme, so "nothing happened" compares everything, not just refunds. */
export function acmeEffects(state: AcmeSnapshot): number {
  return (
    state.refunds.length +
    state.deploys.length +
    state.outbox.length +
    state.deleted_records.length +
    state.merges.length +
    state.destinations_added.length
  );
}
