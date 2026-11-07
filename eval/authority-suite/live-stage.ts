/**
 * The real stack, for eval/authority-suite/live-cases.ts: real Mattermost presses as real personas, a real Switch agent
 * key for what an agent tries, and real core, gate and Acme on their usual ports. The agent's call is scripted with that
 * agent's real token. Tokens are read here and used here, and nothing prints them.
 *
 * This restarts core and the gate with the repo's own scripts, and only ever signals a process group those scripts
 * recorded for this repo. CLEARANCE_ROOT says which checkout's scripts those are, so a run from a worktree leaves the
 * stack running where it was.
 */
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { mentionedNames } from "../../packages/core/src/router/requesters.ts";
import { createSwitchAgent } from "../../packages/switch-agent/src/agent.ts";
import { greetClearance, personaTokens } from "../../scripts/demo/greet.ts";
import {
  agentIdOf,
  defaultWorkspacesDir,
  EMAIL_DOMAIN,
  type Machine,
  type ManagedAgent,
  ownerGateway,
  ROOT,
} from "../../scripts/gateway-owner.ts";
import { acmeEffects, type AcmeSnapshot } from "../harness/world.ts";
import { dataDir, secretsPath, setting } from "../lib/paths.ts";
import {
  buttonsOf,
  MattermostUnreachableError,
  type MattermostPost,
  Persona,
  postText,
} from "../lib/persona.ts";
import { codexPayload, runHookCli } from "./cases.ts";
import {
  answerPlan,
  type AnswerResult,
  type FreshOptions,
  type HookAnswer,
  type HttpAnswer,
  type LiveCard,
  LiveBlocked,
  type LiveLedgerRow,
  type LivePerson,
  type LiveStage,
  type LiveState,
  SAM_SECOND_ACCOUNT,
} from "./live-cases.ts";

const execFile = promisify(execFileCallback);

const CARD_MS = 30_000;
const SWITCH_BACK_MS = 45_000;
const POLL_MS = 300;
const SESSIONS_END_MS = 45_000;
const AGENT_OWNERS = ["priya", "alex"];

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// ── What's decided without a stack, and tested ───────────────────────────────

/** Anyone who isn't plainly stopped. A running agent named in a room starts a real session, on real money. */
export function runningAgents(agents: { name: string; desired_state?: string }[]): string[] {
  return agents.filter((agent) => agent.desired_state !== "stopped").map((agent) => agent.name);
}

/** The running agents a message names. Naming one starts a real session, so such a message never gets sent. */
export function wouldWake(message: string, running: string[]): string[] {
  const named = new Set(mentionedNames(message).map((name) => name.toLowerCase()));
  return running.filter((agent) => named.has(agent.toLowerCase()));
}

export interface AgentControl {
  /** Who is running right now, and so would act, or wake if named. */
  running(): Promise<string[]>;
  stop(names: string[]): Promise<void>;
  restore(names: string[]): Promise<void>;
}

/**
 * Someone else's run can leave agents running, and a session it set going can still be acting, which would move money in
 * the middle of a case. So they stop for the run, as E2's reset does, and exactly those go back, whatever happens. Starting
 * an agent starts no session: that takes someone naming it. Scenes restart their own agents at the start of a take.
 */
export async function withAgentsStopped<T>(control: AgentControl, work: () => Promise<T>): Promise<T> {
  const running = await control.running();
  try {
    if (running.length > 0) await control.stop(running);
    return await work();
  } finally {
    if (running.length > 0) await control.restore(running);
  }
}

/**
 * Clearance's addressing with one more account on the rule that lists people. Rule ids are external-user rows, one per chat
 * account, not Switch users. Anything else about the policy stays as it is, and what was given isn't touched.
 */
export function withAccountListed(policy: unknown, rowId: string): unknown {
  const rules = (policy as { rules?: { users?: unknown }[] } | null)?.rules;
  const rule = rules?.find((candidate) => Array.isArray(candidate.users));
  if (!rules || !rule) throw new Error("Clearance's addressing: no rule lists people, so there's nowhere to add an account");
  const users = rule.users as string[];
  if (users.includes(rowId)) return policy;
  return { ...(policy as object), rules: rules.map((one) => (one === rule ? { ...one, users: [...users, rowId] } : one)) };
}

/** data/hook-tokens.json has tokens for keys, so the key is the secret. An error names the agent and nothing else. */
export function hookTokenFor(file: Record<string, string>, agent: string): string {
  for (const [token, name] of Object.entries(file)) if (name === agent) return token;
  throw new Error(`no hook token for ${agent} in data/hook-tokens.json`);
}

/** Whether a line was written after `offset`. A log shorter than that was cut, so all of it is new. */
export function lastLineSince(log: string, offset: number, pattern: RegExp): boolean {
  return pattern.test(log.length >= offset ? log.slice(offset) : log);
}

/** Whether a process group's leader, from /proc/<pid>/cmdline, is this service of ours. */
export function serviceOwnsGroup(cmdline: string, service: string): boolean {
  const entry = `packages/${service}/src/main.ts`;
  return cmdline.split("\0").some((arg) => arg === entry || arg.endsWith(`/${entry}`));
}

// ── The stack ────────────────────────────────────────────────────────────────

const PEOPLE: LivePerson[] = ["priya", "sam", "neha", "alex", "dev", "guest"];

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

function need(key: string): string {
  const value = setting(key);
  if (!value) throw new Error(`${key} is not set`);
  return value;
}

const readData = <T>(name: string): T => JSON.parse(readFileSync(join(dataDir(), name), "utf8")) as T;

/** A key for an agent that isn't Clearance, from secrets.json. Agents Switch manages don't hand one out. */
function otherAgent(): { name: string; id: string; key: string } | undefined {
  const secretsFile = secretsPath();
  if (!existsSync(secretsFile) || !existsSync(join(dataDir(), "identities.json"))) return undefined;
  const keys = readData<{ switchAgentKeys?: Record<string, string> }>("secrets.json").switchAgentKeys ?? {};
  const agents =
    readData<{ agents?: Record<string, { switchAgentId?: string }> }>("identities.json").agents ?? {};
  for (const [name, key] of Object.entries(keys)) {
    const id = agents[name]?.switchAgentId;
    if (name !== "clearance" && id) return { name, id, key };
  }
  return undefined;
}

export class RealStage implements LiveStage {
  readonly gateUrl = "http://127.0.0.1:7710";
  readonly coreUrl = "http://127.0.0.1:7700";
  readonly acmeUrl = "http://127.0.0.1:7800";
  readonly bridgeUrl = setting("SWITCH_BRIDGE_URL") ?? "http://127.0.0.1:8000";
  readonly mattermostUrl = setting("MATTERMOST_URL") ?? "http://127.0.0.1:8065";
  readonly people: Record<LivePerson, Persona>;
  private readonly internalToken = need("CLEARANCE_INTERNAL_TOKEN");
  private readonly adminKey = need("ACME_ADMIN_KEY");
  private readonly gateTokens = readData<Record<string, string>>("gate-tokens.json");
  private readonly hookTokens = readData<Record<string, string>>("hook-tokens.json");
  private readonly other = otherAgent();
  /** Ids restart after a reset, so older cards can carry the same CLR id and may still have buttons. Only this world's count. */
  private worldStartedMs = Date.now();
  /** Read at each fresh world. Until then nothing is known to be stopped, so nothing can be named. */
  private running: string[] | null = null;

  constructor() {
    const person = (name: string): Persona =>
      Persona.fromSecrets(name, { baseUrl: this.mattermostUrl, secretsPath: secretsPath() });
    this.people = {
      ...Object.fromEntries(PEOPLE.map((name) => [name, person(name)])),
      samSecond: person(SAM_SECOND_ACCOUNT),
    } as Record<LivePerson, Persona>;
  }

  /** In both files, as the spike leaves them. Core reads the identities file at its start, which each fresh world is. */
  hasSecondAccount(): boolean {
    const { mattermostTokens } = readData<{ mattermostTokens?: Record<string, string> }>("secrets.json");
    const { people } = readData<{ people?: { sam?: { participantIds?: string[] } } }>("identities.json");
    return (
      Boolean(mattermostTokens?.[SAM_SECOND_ACCOUNT]) &&
      (people?.sam?.participantIds ?? []).some((id) => id.endsWith(`-${SAM_SECOND_ACCOUNT}:localhost`))
    );
  }

  /** Any managed agent that would wake if someone names it. */
  async agentsRunning(): Promise<string[]> {
    const all: ManagedAgent[] = [];
    for (const owner of AGENT_OWNERS) {
      const gateway = await ownerGateway(owner);
      all.push(...(await gateway.must<ManagedAgent[]>("GET", "/management/agents")));
    }
    return runningAgents(all);
  }

  private async setDesiredState(names: string[], desired: "stopped" | "running"): Promise<void> {
    for (const owner of AGENT_OWNERS) {
      const gateway = await ownerGateway(owner);
      for (const agent of await gateway.must<ManagedAgent[]>("GET", "/management/agents")) {
        if (!names.includes(agent.name)) continue;
        await gateway.must("PATCH", `/management/agents/${agentIdOf(agent)}`, { desired_state: desired });
      }
    }
  }

  /** How many sessions the machines say are going. A session outlives what started it, so a stop has to wait for this. */
  private async sessionsRunning(): Promise<number> {
    let total = 0;
    for (const owner of AGENT_OWNERS) {
      const gateway = await ownerGateway(owner);
      for (const machine of await gateway.must<Machine[]>("GET", "/management/controllers")) {
        if (!machine.revoked_at) total += machine.status?.machine?.sessions_running ?? 0;
      }
    }
    return total;
  }

  agentControl(): AgentControl {
    return {
      running: async () => {
        const all: ManagedAgent[] = [];
        for (const owner of AGENT_OWNERS) {
          const gateway = await ownerGateway(owner);
          all.push(...(await gateway.must<ManagedAgent[]>("GET", "/management/agents")));
        }
        return all.filter((agent) => agent.desired_state === "running").map((agent) => agent.name);
      },
      stop: async (names) => {
        await this.setDesiredState(names, "stopped");
        const deadline = Date.now() + SESSIONS_END_MS;
        let sessions = await this.sessionsRunning();
        while (sessions > 0 && Date.now() < deadline) {
          await delay(1_000);
          sessions = await this.sessionsRunning();
        }
        if (sessions > 0) {
          throw new Error(`${sessions} agent sessions were still going ${SESSIONS_END_MS / 1000} s after stopping ${names.join(", ")}`);
        }
      },
      restore: (names) => this.setDesiredState(names, "running"),
    };
  }

  // ── A fresh world ──────────────────────────────────────────────────────────

  private runDir(): string {
    return process.env.CLEARANCE_RUN_DIR ?? join(dataDir(), "run");
  }

  private coreLog(): string {
    const path = join(this.runDir(), "core.log");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  /** Core opens its port before it's on Switch, and until then the rooms are deaf to it. Its log says when. */
  private async waitForSwitch(offset: number): Promise<void> {
    const deadline = Date.now() + SWITCH_BACK_MS;
    while (Date.now() < deadline) {
      if (lastLineSince(this.coreLog(), offset, /Switch agent connected/)) return;
      await delay(POLL_MS);
    }
    throw new Error(`core didn't say it was on Switch within ${SWITCH_BACK_MS / 1000} s`);
  }

  private env(timeScale?: number): NodeJS.ProcessEnv {
    // A value already in the services' environment wins over .env, so these have to be cleared or set on purpose.
    const env = { ...process.env };
    delete env.CLEARANCE_POLICY_PATH;
    delete env.CLEARANCE_TIME_SCALE;
    if (timeScale) env.CLEARANCE_TIME_SCALE = String(timeScale);
    return env;
  }

  /** So old cards don't sit in people's sidebars with live buttons. Best effort: core may be down. */
  private async closeOpen(): Promise<void> {
    const open = await this.coreGet("/v1/requests?state=open").catch(() => null);
    const rows = (open?.json.requests ?? []) as { id?: string }[];
    for (const row of rows) {
      if (row.id) await this.corePost(`/v1/requests/${row.id}/cancel`, { by: "e1-live" }).catch(() => null);
    }
  }

  /** What every take starts from: Acme, core and gate back to their start, and each person's hello to Clearance. */
  async fresh(options: FreshOptions = {}): Promise<void> {
    // A stack that won't reset can't say anything about the case, which isn't the same as the case failing.
    await this.reset(options).catch((error: unknown) => {
      throw new LiveBlocked(`the stack couldn't be put back to its start: ${(error as Error).message}`);
    });
  }

  private async reset(options: FreshOptions): Promise<void> {
    await this.closeOpen();
    const offset = this.coreLog().length;
    const env = this.env(options.timeScale);
    const reset = await execFile(process.execPath, ["--import", "tsx", "scripts/demo-reset.ts"], {
      cwd: ROOT,
      env,
      timeout: 90_000,
    }).catch((error: { stdout?: string; message: string }) => {
      // It exits 1 for taking over its 10 s budget even when it did the reset. On a busy host that isn't a failure here.
      if (/Clearance state reset/.test(error.stdout ?? "")) return { stdout: error.stdout ?? "" };
      throw new Error(`demo-reset failed: ${error.message}`);
    });
    if (!/Clearance state reset/.test(reset.stdout)) throw new Error("demo-reset didn't reset Clearance");
    await this.waitForSwitch(offset);
    if (options.seedHistory) {
      await execFile(process.execPath, ["--import", "tsx", "scripts/seed-history.ts"], {
        cwd: ROOT,
        env,
        timeout: 60_000,
      });
    }
    await greetClearance({ mattermostUrl: this.mattermostUrl, tokens: personaTokens(ROOT) });
    await delay(1_000);
    this.running = await this.agentsRunning();
    this.worldStartedMs = Date.now();
  }

  /** Before anything is posted. A case that can't say what it needs to comes back blocked, never a pass. */
  private refuseToWake(message: string): void {
    if (this.running === null) throw new LiveBlocked("nothing has checked which agents are running");
    const woken = wouldWake(message, this.running);
    if (woken.length > 0) {
      throw new LiveBlocked(
        `${woken.join(", ")} is running, and naming it in a room would start a real session, so this case wasn't run`,
      );
    }
  }

  settle(ms: number): Promise<void> {
    return delay(ms);
  }

  // ── People ─────────────────────────────────────────────────────────────────

  async say(person: LivePerson, room: string, text: string): Promise<void> {
    this.refuseToWake(text);
    await this.people[person].post(room, text);
  }

  private toCard(post: MattermostPost): LiveCard {
    const text = postText(post);
    const handle = /\bA\d+\b/.exec(text)?.[0];
    return { postId: post.id, channelId: post.channel_id, text, ...(handle ? { handle } : {}) };
  }

  private isThisWorldsCard(post: MattermostPost, patterns: RegExp[]): boolean {
    if (post.create_at < this.worldStartedMs || buttonsOf(post).length === 0) return false;
    const text = postText(post);
    return patterns.every((pattern) => pattern.test(text));
  }

  private idPattern(id: string): RegExp {
    return new RegExp(`\\b${id}\\b`);
  }

  async roomCard(person: LivePerson, room: string, id: string): Promise<LiveCard> {
    const post = await this.people[person].waitForPost(
      room,
      (candidate) => this.isThisWorldsCard(candidate, [this.idPattern(id)]),
      { sinceMs: this.worldStartedMs - 1, timeoutMs: CARD_MS, description: `the ${id} card in #${room}` },
    );
    return this.toCard(post);
  }

  dmCard(person: LivePerson, id: string): Promise<LiveCard> {
    return this.dmCardMatching(person, [this.idPattern(id)]);
  }

  async dmCardMatching(person: LivePerson, patterns: RegExp[]): Promise<LiveCard> {
    const post = await this.people[person].waitForDm(
      (candidate) => this.isThisWorldsCard(candidate, patterns),
      {
        sinceMs: this.worldStartedMs - 1,
        timeoutMs: CARD_MS,
        description: `a card matching ${patterns.join(" and ")}`,
      },
    );
    return this.toCard(post);
  }

  /** Reads the card as it is now, because a card changes as it's answered. Says what became of the attempt. */
  async answer(person: LivePerson, card: LiveCard, decision: "allow" | "deny"): Promise<AnswerResult> {
    const persona = this.people[person];
    try {
      const live = await persona.getPost(card.postId);
      const plan = answerPlan(
        { text: postText(live), buttons: buttonsOf(live).map((button) => button.name), ...(card.handle ? { handle: card.handle } : {}) },
        decision,
      );
      if (plan.kind === "none") return { reached: false, detail: plan.why };
      if (plan.kind === "press") {
        await persona.pressButton(live, plan.button);
        return { reached: true, detail: `pressed "${plan.button}"` };
      }
      await persona.post(await persona.channelById(card.channelId), plan.message);
      return { reached: true, detail: `typed ${plan.message}` };
    } catch (error) {
      if (error instanceof MattermostUnreachableError) throw error;
      return { reached: false, detail: (error as Error).message };
    }
  }

  async buttonsLeft(person: LivePerson, card: LiveCard): Promise<number> {
    return buttonsOf(await this.people[person].getPost(card.postId)).length;
  }

  /** Clearance's owner, who alone sets its addressing. */
  private async clearanceOwner(): Promise<{ cookie: string; agentId: string }> {
    const { clearanceAdminPassword } = readData<{ clearanceAdminPassword?: string }>("secrets.json");
    const { agents } = readData<{ agents: Record<string, { switchAgentId?: string }> }>("identities.json");
    const agentId = agents.clearance?.switchAgentId;
    if (!clearanceAdminPassword || !agentId) throw new LiveBlocked("no way to act as Clearance's owner in data/");
    const login = await fetch(`${this.bridgeUrl}/gateway/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `clearance-admin@${EMAIL_DOMAIN}`, password: clearanceAdminPassword }),
    });
    if (!login.ok) throw new LiveBlocked(`Clearance's owner couldn't sign in: HTTP ${login.status}`);
    return {
      cookie: login.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; "),
      agentId,
    };
  }

  async withSecondAccountListed<T>(work: () => Promise<T>): Promise<T> {
    const { cookie, agentId } = await this.clearanceOwner();
    const url = `${this.bridgeUrl}/gateway/agents/${agentId}`;
    const readPolicy = async (): Promise<unknown> => {
      const res = await fetch(url, { headers: { cookie } });
      if (!res.ok) throw new Error(`reading Clearance's addressing answered HTTP ${res.status}`);
      return ((await res.json()) as { addressing_policy?: unknown }).addressing_policy ?? null;
    };
    const writePolicy = async (policy: unknown): Promise<void> => {
      const res = await fetch(`${url}/addressing-policy`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ policy }),
      });
      if (!res.ok) throw new Error(`setting Clearance's addressing answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    };
    const original = await readPolicy();
    const me = await this.people.samSecond.me();
    const sam = await ownerGateway("sam");
    const identities = await sam.must<{ id: string; external_user_id: string }[]>("GET", "/auth/me/identities");
    const row = identities.find((identity) => identity.external_user_id === me.id);
    if (!row) throw new LiveBlocked("Sam's second account isn't linked to him");
    await writePolicy(withAccountListed(original, row.id));
    try {
      return await work();
    } finally {
      await writePolicy(original);
      const restored = await readPolicy();
      if (JSON.stringify(restored) !== JSON.stringify(original)) {
        throw new Error("Clearance's addressing didn't go back as it was. Check it by hand");
      }
    }
  }

  async typeBeside(person: LivePerson, card: LiveCard, message: string): Promise<void> {
    const persona = this.people[person];
    await persona.post(await persona.channelById(card.channelId), message);
  }

  async seen(person: LivePerson, room: string, pattern: RegExp, timeoutMs: number): Promise<boolean> {
    return this.people[person]
      .waitForPost(room, (post) => post.create_at >= this.worldStartedMs && pattern.test(postText(post)), {
        sinceMs: this.worldStartedMs - 1,
        timeoutMs,
        description: `a post matching ${pattern}`,
      })
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof MattermostUnreachableError) throw error;
        return false;
      });
  }

  // ── Agents ─────────────────────────────────────────────────────────────────

  otherAgentName(): string | undefined {
    return this.other?.name;
  }

  /** A connected Switch agent for the length of one call. The stream has to be open before any op works. */
  private async asOther<T>(work: (agent: ReturnType<typeof createSwitchAgent>) => Promise<T>): Promise<T> {
    if (!this.other) throw new LiveBlocked("no other agent: no Switch API key for an agent other than Clearance in data/secrets.json");
    const agent = createSwitchAgent({
      bridgeUrl: this.bridgeUrl,
      agentId: this.other.id,
      apiKey: this.other.key,
    });
    await agent.start({});
    try {
      return await work(agent);
    } finally {
      await agent.stop();
    }
  }

  async agentSays(room: string, text: string): Promise<void> {
    this.refuseToWake(text);
    await this.asOther(async (agent) => {
      const rooms = await agent.op<{ room_id: string; name: string }[]>("list_rooms", {});
      const found = rooms.find((candidate) => candidate.name === room);
      if (!found) throw new Error(`${this.other?.name} isn't in a room named ${room}`);
      await agent.op("connect_to_room", { room_id: found.room_id });
      await agent.op("post_message", { body: text });
    });
  }

  private async clearanceAddressing(): Promise<string> {
    const { agents } = readData<{ agents: Record<string, { switchAgentId?: string }> }>("identities.json");
    const { switchAgentKeys } = readData<{ switchAgentKeys?: Record<string, string> }>("secrets.json");
    const id = agents.clearance?.switchAgentId;
    const key = switchAgentKeys?.clearance;
    if (!id || !key) throw new LiveBlocked("no Clearance agent key to read its addressing with");
    const res = await fetch(`${this.bridgeUrl}/agents/${id}/ops/get_agent_detail`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ agent_id: id }),
    });
    if (!res.ok) throw new Error(`reading Clearance's addressing answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: { addressing?: unknown } };
    return JSON.stringify(body.result?.addressing ?? null);
  }

  async changeClearanceAddressing(): Promise<{
    as: string;
    accepted: boolean;
    refusal: string | null;
    changed: boolean;
  }> {
    const { agents } = readData<{ agents: Record<string, { switchAgentId?: string }> }>("identities.json");
    const clearanceId = agents.clearance?.switchAgentId;
    if (!clearanceId) throw new LiveBlocked("no Clearance agent in data/identities.json");
    const before = await this.clearanceAddressing();
    const refusal = await this.asOther((agent) =>
      agent
        .op("update_agent_detail", { agent_id: clearanceId, addressing: "anyone" })
        .then(() => null)
        .catch((error: unknown) => (error as Error).message),
    );
    const after = await this.clearanceAddressing();
    return {
      as: this.other?.name ?? "",
      accepted: refusal === null,
      refusal,
      changed: after !== before,
    };
  }

  async gate(agent: string, method: string, path: string, body?: unknown): Promise<HttpAnswer> {
    const token = this.gateTokens[agent];
    if (!token) throw new LiveBlocked(`no gate token for ${agent} in data/gate-tokens.json`);
    const res = await fetch(`${this.gateUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await readJson(res) };
  }

  /** Core's call to the gate, as it makes it on an approval. */
  async gateExecute(id: string, callHash: string): Promise<HttpAnswer> {
    const res = await fetch(`${this.gateUrl}/internal/execute/${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.internalToken}`, "content-type": "application/json" },
      body: JSON.stringify({ call_hash: callHash }),
    });
    return { status: res.status, json: await readJson(res) };
  }

  async hook(agent: string, tool: string, input: Record<string, unknown>): Promise<HookAnswer> {
    const res = await fetch(`${this.coreUrl}/v1/hooks/claude`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${hookTokenFor(this.hookTokens, agent)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: `e1-live-${agent}`,
        hook_event_name: "PreToolUse",
        cwd: join(defaultWorkspacesDir(), agent),
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

  async hookCli(agent: string, command: string): Promise<string> {
    const { stdout } = await runHookCli(
      "codex",
      { ...codexPayload(agent, command), cwd: join(defaultWorkspacesDir(), agent) },
      this.coreUrl,
      hookTokenFor(this.hookTokens, agent),
    );
    return stdout;
  }

  // ── Core and Acme ──────────────────────────────────────────────────────────

  async coreGet(path: string): Promise<HttpAnswer> {
    const res = await fetch(`${this.coreUrl}${path}`, {
      headers: { authorization: `Bearer ${this.internalToken}` },
    });
    return { status: res.status, json: await readJson(res) };
  }

  async corePost(path: string, body: unknown): Promise<HttpAnswer> {
    const res = await fetch(`${this.coreUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.internalToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await readJson(res) };
  }

  async request(id: string): Promise<LiveState> {
    return (await this.coreGet(`/v1/requests/${id}`)).json as unknown as LiveState;
  }

  async stateOf(id: string): Promise<string> {
    return String((await this.request(id)).state ?? "");
  }

  async waitState(id: string, wanted: string[], timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let state = "";
    for (;;) {
      state = await this.stateOf(id);
      if (wanted.includes(state) || Date.now() > deadline) return state;
      await delay(POLL_MS);
    }
  }

  async ledger(id?: string): Promise<LiveLedgerRow[]> {
    const query = id ? `?request_id=${encodeURIComponent(id)}` : "";
    return ((await this.coreGet(`/v1/ledger${query}`)).json.entries ?? []) as LiveLedgerRow[];
  }

  async waitLedger(
    id: string | undefined,
    matches: (row: LiveLedgerRow) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.ledger(id)).some(matches)) return true;
      if (Date.now() > deadline) return false;
      await delay(POLL_MS);
    }
  }

  async ledgerVerifies(): Promise<boolean> {
    return (await this.coreGet("/v1/ledger/verify")).json.ok === true;
  }

  private async acme(): Promise<AcmeSnapshot> {
    const res = await fetch(`${this.acmeUrl}/state`, { headers: { "x-acme-admin-key": this.adminKey } });
    if (!res.ok) throw new Error(`Acme /state answered ${res.status}`);
    return (await res.json()) as AcmeSnapshot;
  }

  async acmeEffects(): Promise<number> {
    return acmeEffects(await this.acme());
  }

  async refundAmounts(): Promise<number[]> {
    return (await this.acme()).refunds.map((refund) => refund.amount);
  }

  async merged(): Promise<number> {
    return (await this.acme()).merges.length;
  }

  /** A call to Acme with no admin key, which is all an agent has. */
  async acmeWithoutKey(method: string, path: string, body: unknown): Promise<number> {
    const res = await fetch(`${this.acmeUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await res.arrayBuffer();
    return res.status;
  }

  // ── Crashes ────────────────────────────────────────────────────────────────

  /** SIGKILL, because that's what a crash looks like. Only the group scripts/services.sh recorded, once it's sure it's ours. */
  async crash(service: "core" | "gate"): Promise<void> {
    const path = join(this.runDir(), `${service}.pgid`);
    const pgid = Number(existsSync(path) ? readFileSync(path, "utf8").trim() : "");
    if (!Number.isInteger(pgid) || pgid <= 1) {
      throw new LiveBlocked(`scripts/services.sh has no record of ${service}, so it can't be crashed safely`);
    }
    const cmdline = existsSync(`/proc/${pgid}/cmdline`) ? readFileSync(`/proc/${pgid}/cmdline`, "utf8") : "";
    if (!serviceOwnsGroup(cmdline, service)) {
      throw new LiveBlocked(`process group ${pgid} isn't clearly our ${service}, so it was left alone`);
    }
    process.kill(-pgid, "SIGKILL");
    const url = service === "core" ? this.coreUrl : this.gateUrl;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const open = await fetch(url, { signal: AbortSignal.timeout(1_000) }).then(
        () => true,
        () => false,
      );
      if (!open) return;
      await delay(200);
    }
    throw new Error(`${service} was still answering 15 s after SIGKILL`);
  }

  async start(service: "core" | "gate"): Promise<void> {
    const offset = this.coreLog().length;
    await execFile("bash", [join(ROOT, "scripts/services.sh"), "up", service], {
      cwd: ROOT,
      env: this.env(),
      timeout: 60_000,
    });
    if (service === "core") await this.waitForSwitch(offset);
  }
}
