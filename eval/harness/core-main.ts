/**
 * clearance-core for the evals: the real core, API, hook routes and gate client from
 * packages/core/src/main.ts, with one thing swapped. Chat is a recording fake rather than the Switch agent,
 * because the shared Switch stack is not ours to touch and most authority cases aren't about chat.
 *
 * It adds control routes under /eval/*, behind the same internal token as every other route, so a test can
 * deliver a chat message or a card's answer the way the Switch agent would: through onMessage and
 * onApprovalOutcome. Nothing in packages/ knows these routes exist.
 *
 * Refuses to start with no explicit port or database, so it can never pick up a default and land on the
 * shared stack.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { hookRoutes } from "../../packages/adapters/src/index.ts";
import type {
  ChatPort,
  Clock,
  OpenCardInput,
  OpenCardResult,
} from "../../packages/contracts/src/index.ts";
import { buildServer, createClearanceCore, systemClock } from "../../packages/core/src/index.ts";
import { createGateClient } from "../../packages/gate/src/index.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is required: the eval core has no defaults, on purpose\n`);
    process.exit(1);
  }
  return value;
}

const internalToken = required("CLEARANCE_INTERNAL_TOKEN");
const hookToken = required("CLEARANCE_HOOK_TOKEN");
const port = Number(required("CLEARANCE_CORE_PORT"));
const chatLog = required("EVAL_CHAT_LOG");

/** What a card or a message looked like when core sent it, one JSON object per line. */
function record(kind: string, data: Record<string, unknown>): void {
  // Last, because a card's input has a `kind` of its own.
  appendFileSync(chatLog, `${JSON.stringify({ ...data, kind, at: Date.now() })}\n`);
}

let cardCounter = 0;
const chat: ChatPort = {
  async openCard(input: OpenCardInput): Promise<OpenCardResult> {
    cardCounter += 1;
    // The pid keeps ids unique across a restart of this process, as Switch's are.
    const result: OpenCardResult = {
      sessionId: "eval-session",
      switchRequestId: `sr-${process.pid}-${cardCounter}`,
      handle: `A${process.pid % 1000}${cardCounter}`,
    };
    record("card", { ...input, ...result });
    return result;
  },
  async closeCard(sessionId, switchRequestId) {
    record("close", { sessionId, switchRequestId });
  },
  async postMessage(input) {
    record("message", input);
    return {};
  },
  async sendTargeted(input) {
    record("targeted", input);
  },
  async ensureDirectRoom(person) {
    return { roomId: `dm-${person.userName}` };
  },
  async upsertDocument(input) {
    record("document", { roomId: input.roomId, name: input.name });
  },
};

const base = systemClock(Number(process.env.CLEARANCE_TIME_SCALE ?? 1));
let offsetMs = 0;
/** The real clock, plus however far a case has jumped it. A case says so when it does. */
const clock: Clock = {
  nowMs: () => Date.now() + offsetMs,
  scaledMs: (policyMs) => base.scaledMs(policyMs),
};

const gateClient = createGateClient({ baseUrl: required("CLEARANCE_GATE_URL"), internalToken });

// A plain variable so options the core doesn't take yet pass through untouched. Random drills stay off:
// a drill rolled in the middle of a case or a soak would make runs differ.
const deps = {
  dbPath: resolve(required("CLEARANCE_DB_PATH")),
  policyPath: resolve(required("CLEARANCE_POLICY_PATH")),
  teamPath: resolve(required("CLEARANCE_TEAM_PATH")),
  identitiesPath: resolve(required("CLEARANCE_IDENTITIES_PATH")),
  drillsPath: resolve(required("CLEARANCE_DRILLS_PATH")),
  rollDrills: false,
  chat,
  gate: gateClient,
  lookup: gateClient,
  clock,
};
const core = createClearanceCore(deps);

const app = buildServer(core, { internalToken });
await app.register(async (scope) => {
  hookRoutes(scope, {
    check: (action) => core.check(action),
    resolveAgent: (cwd, agentType) => core.resolveAgent(cwd, agentType),
    hookToken,
  });
});

await app.register(async (scope) => {
  scope.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${internalToken}`) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
  scope.post("/eval/message", async (request) => {
    await core.onMessage(request.body as Parameters<typeof core.onMessage>[0]);
    return { ok: true };
  });
  scope.post("/eval/answer", async (request) => {
    await core.onApprovalOutcome(request.body as Parameters<typeof core.onApprovalOutcome>[0]);
    return { ok: true };
  });
  scope.post("/eval/clock/advance", async (request) => {
    offsetMs += (request.body as { ms: number }).ms;
    return { ok: true, offsetMs };
  });
  scope.post("/eval/autonomy", async (request) => {
    const { agent, cls, bucket, level } = request.body as Record<string, string>;
    core.stores.autonomy.setLevel(
      agent as string,
      cls as string,
      bucket as string,
      level as Parameters<typeof core.stores.autonomy.setLevel>[3],
      clock.nowMs(),
    );
    return { ok: true };
  });
  scope.post("/eval/tick", async () => {
    await core.tick();
    return { ok: true };
  });
});

const tick = setInterval(() => {
  core.tick().catch((error: unknown) => process.stderr.write(`tick failed: ${String(error)}\n`));
}, 1000);

const stop = async (): Promise<void> => {
  clearInterval(tick);
  await app.close();
  core.close();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

await app.listen({ port, host: "127.0.0.1" });
process.stdout.write(`eval core listening on 127.0.0.1:${port}\n`);
