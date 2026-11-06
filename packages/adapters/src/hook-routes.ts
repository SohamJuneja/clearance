/**
 * The /v1/hooks/* routes, mounted by core. Every failure answers 200 with the vendor's own deny:
 * a vendor reads a non-2xx as "the hook broke", and some of them carry on when a hook breaks. A
 * token that fails, a directory no agent owns, a payload that cannot be read and a `check` that
 * throws, hangs or answers nonsense are all denies, never allows.
 *
 * Each agent has its own hook token, and the token alone says which agent is calling. What the request
 * claims (`agent_type`, `cwd`) can only make it a deny, by naming someone else: it is written by the
 * caller, so it can never make one agent into another and spend that agent's grants.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  CheckResponseSchema,
  canonicalJson,
  type Action,
  type CheckResponse,
} from "@clearance/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ulid } from "ulid";
import { PayloadError, asRecord, type HookOutcome, type VendorAdapter } from "./actions.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { opencodeAdapter } from "./opencode.js";

export type HookRouteOptions = {
  check: (action: Action) => Promise<CheckResponse>;
  /**
   * Cross-checks what the request claims against the team. With `agentType`: return that name if it
   * is registered, otherwise null, without falling back to `cwd`. Without it: return the agent that
   * owns `cwd`, or null. It never decides who is calling: that is the token.
   */
  resolveAgent: (cwd?: string, agentType?: string) => string | null;
  /** Hook token to agent name, from `data/hook-tokens.json`. See `loadHookTokens`. */
  hookTokens: Record<string, string>;
  /** Under the hook timeout in `.claude/settings.json`, so the deny arrives before the vendor gives up. */
  checkTimeoutMs?: number;
  now?: () => number;
};

const ADAPTERS: Record<string, VendorAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  opencode: opencodeAdapter,
};

/** Tool payloads can carry whole files, and a Write should not be refused for being large. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_CHECK_TIMEOUT_MS = 15_000;
const PAIRED_ALLOW_TTL_MS = 120_000;

const DENIED = "Clearance denied this call and nothing ran:";
const BAD_TOKEN = `${DENIED} the hook token was not accepted.`;
const UNREADABLE = `${DENIED} it could not read the hook payload.`;
const UNKNOWN_DIRECTORY = `${DENIED} this working directory does not belong to a registered agent.`;
const UNKNOWN_AGENT = `${DENIED} this agent is not registered with Clearance.`;
const UNAVAILABLE = `${DENIED} the approval service could not answer. Do not try another way.`;

const wrongAgent = (holder: string, claimed: string) =>
  `${DENIED} this hook token belongs to ${holder}, but the call says it comes from ${claimed}.`;

const deny = (reason: string): HookOutcome => ({ decision: "deny", reason });

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Walks up, so a session that has `cd`-ed into `src/` is still the agent that owns the directory. */
function resolveFrom(resolveAgent: HookRouteOptions["resolveAgent"], cwd?: string): string | null {
  if (!cwd) return resolveAgent(undefined);
  let dir = posix.normalize(cwd).replace(/\/+$/, "") || "/";
  for (;;) {
    const agent = resolveAgent(dir);
    if (agent) return agent;
    const parent = posix.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("check timed out")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Identifies what a call does, leaving out vendor fields that differ between its two events. */
function callSubject(actions: Action[]): string {
  return canonicalJson(
    actions.map((a) => ({ kind: a.kind, shell: a.shell, file: a.file, http: a.http, mcp: a.mcp })),
  );
}

export async function hookRoutes(app: FastifyInstance, options: HookRouteOptions): Promise<void> {
  // Keyed by digest so a lookup does not compare a guess against a token byte by byte.
  const agentsByDigest = new Map(
    Object.entries(options.hookTokens ?? {}).map(([token, agent]) => [
      digest(token).toString("hex"),
      agent,
    ]),
  );
  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const pairedAllows = new Map<string, { event: string; expiresAt: number }>();

  const agentOfToken = (req: FastifyRequest): string | undefined => {
    const header = req.headers.authorization;
    const match = header ? /^bearer\s+(\S+)$/i.exec(header) : null;
    return match?.[1] ? agentsByDigest.get(digest(match[1]).toString("hex")) : undefined;
  };

  /** A reason to refuse, when the request's own claims don't fit the agent its token proves. */
  const claimsRefused = (
    adapter: VendorAdapter,
    payload: unknown,
    agent: string,
  ): string | null => {
    const cwd = adapter.cwd(payload);
    const agentType = adapter.agentType?.(payload);
    if (agentType !== undefined) {
      if (agentType !== agent) return wrongAgent(agent, agentType);
      if (options.resolveAgent(cwd, agentType) !== agent) return UNKNOWN_AGENT;
    }
    const owner = resolveFrom(options.resolveAgent, cwd);
    if (owner !== null && owner !== agent) return wrongAgent(agent, owner);
    // A named agent may wander. With no name, a directory nobody owns is all there is, and it's a deny.
    if (owner === null && agentType === undefined) return UNKNOWN_DIRECTORY;
    return null;
  };

  const takePairedAllow = (key: string, event: string): boolean => {
    const entry = pairedAllows.get(key);
    if (!entry || entry.expiresAt <= now() || entry.event === event) return false;
    pairedAllows.delete(key);
    return true;
  };

  const rememberAllow = (key: string, event: string): void => {
    if (pairedAllows.size > 1000) {
      for (const [k, v] of pairedAllows) if (v.expiresAt <= now()) pairedAllows.delete(k);
    }
    pairedAllows.set(key, { event, expiresAt: now() + PAIRED_ALLOW_TTL_MS });
  };

  const checkAll = async (actions: Action[]): Promise<HookOutcome> => {
    let last: CheckResponse | undefined;
    for (const action of actions) {
      const parsed = CheckResponseSchema.safeParse(
        await withTimeout(options.check(action), checkTimeoutMs),
      );
      if (!parsed.success) return deny(UNAVAILABLE);
      last = parsed.data;
      if (last.decision !== "allow") return deny(last.reason);
    }
    return last ? { decision: "allow", reason: last.reason } : deny(UNREADABLE);
  };

  const decide = async (
    adapter: VendorAdapter,
    payload: unknown,
    agent: string,
  ): Promise<HookOutcome> => {
    if (!asRecord(payload)) return deny(UNREADABLE);
    const refused = claimsRefused(adapter, payload, agent);
    if (refused) return deny(refused);
    const actions = adapter.toActions(payload, {
      agent,
      id: ulid(),
      at: new Date(now()).toISOString(),
    });
    const paired = adapter.pairedEvent?.(payload);
    const key = paired ? `${agent}|${paired.scope}|${callSubject(actions)}` : undefined;
    if (paired && key && takePairedAllow(key, paired.event)) {
      return { decision: "allow", reason: "allowed by the check for this same call" };
    }
    const outcome = await checkAll(actions);
    if (paired && key && outcome.decision === "allow") rememberAllow(key, paired.event);
    return outcome;
  };

  const handle = async (adapter: VendorAdapter, req: FastifyRequest, reply: FastifyReply) => {
    let payload: unknown;
    let outcome: HookOutcome;
    try {
      payload = JSON.parse(typeof req.body === "string" ? req.body : "");
    } catch {
      payload = undefined;
    }
    const agent = agentOfToken(req);
    if (!agent) {
      outcome = deny(BAD_TOKEN);
    } else {
      try {
        outcome = await decide(adapter, payload, agent);
      } catch (err) {
        if (err instanceof PayloadError) {
          outcome = deny(UNREADABLE);
        } else {
          req.log.error({ vendor: adapter.vendor }, "hook check failed");
          outcome = deny(UNAVAILABLE);
        }
      }
    }
    return reply.status(200).send(adapter.respond(outcome, payload));
  };

  app.register(async (scope) => {
    // The raw body is parsed in `handle`, so bad JSON gets the vendor's deny and not a framework 400.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

    for (const [name, adapter] of Object.entries(ADAPTERS)) {
      scope.post(
        `/v1/hooks/${name}`,
        {
          bodyLimit: MAX_BODY_BYTES,
          errorHandler: (_err, _req, reply) =>
            reply.status(200).send(adapter.respond(deny(UNREADABLE), undefined)),
        },
        (req, reply) => handle(adapter, req, reply),
      );
    }
  });
}
