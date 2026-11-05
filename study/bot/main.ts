/**
 * The in-Switch study (PLAN 11.5): `study-bot` runs PLAN 11.6 for everyone in data/study-accounts.json.
 *
 *   tsx study/bot/main.ts
 *
 *   CLEARANCE_DATA_DIR    where study-accounts.json is. Default ./data
 *   STUDY_RESULTS_DIR     where results go. Default study/results
 *   STUDY_DRY_RUN=1       marks every event synthetic. Refused for study/results
 *   STUDY_PARTICIPANTS    a comma list, to run only some. Default everyone provisioned
 *   SWITCH_BRIDGE_URL     default http://127.0.0.1:8000
 *
 * Stop it and start it whenever you like: it picks every session up where it was. It prints ids and
 * counts, and never a credential or anything a participant typed.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createChatPort } from "../../packages/switch-agent/src/chat-port";
import { createSwitchAgent } from "../../packages/switch-agent/src/agent";
import { loadSets } from "../app/server";
import { loadStudyAccounts } from "../lib/accounts";
import { DEFAULT_RESULTS_DIR } from "../lib/results";
import { createStudyBot } from "./bot";
import { preflight } from "./cards";
import { createStudyStore } from "./store";

const TICK_MS = 1000;
const REPO_ROOT = resolve(import.meta.dirname, "../..");

type Thread = { root: { sender_name?: string; body?: string }; replies: { sender_name?: string; body?: string }[] };

async function main(): Promise<void> {
  const dryRun = process.env.STUDY_DRY_RUN === "1";
  const resultsDir = resolve(process.env.STUDY_RESULTS_DIR ?? DEFAULT_RESULTS_DIR);
  const accountsFile = resolve(process.env.CLEARANCE_DATA_DIR ?? resolve(REPO_ROOT, "data"), "study-accounts.json");
  const bridgeUrl = process.env.SWITCH_BRIDGE_URL ?? "http://127.0.0.1:8000";
  const log = (line: string): void => {
    process.stdout.write(`study-bot: ${line}\n`);
  };

  const sets = loadSets();
  preflight(sets);

  const accounts = loadStudyAccounts(accountsFile);
  const only = process.env.STUDY_PARTICIPANTS?.split(",").map((id) => id.trim()).filter(Boolean);
  const participants = Object.fromEntries(Object.entries(accounts.participants).filter(([id]) => !only || only.includes(id)));

  const store = createStudyStore({ resultsDir, synthetic: dryRun });
  // A new results folder is a new run: its cards must not be confused with any earlier run's.
  const runId = createHash("sha256").update(resultsDir).digest("hex").slice(0, 8);

  const agent = createSwitchAgent({
    bridgeUrl,
    agentId: accounts.agent.switchAgentId,
    apiKey: accounts.agent.apiKey,
    initialPosition: store.readPosition(),
  });
  const chat = createChatPort(agent, { agentName: accounts.agent.name, warn: log });

  const recentBodies = async (roomId: string): Promise<string[]> => {
    const context = await agent.op<{ threads: Thread[] }>("read_context", { room_id: roomId, limit: 50 });
    return context.threads
      .flatMap((thread) => [thread.root, ...thread.replies])
      .filter((entry) => entry.sender_name === accounts.agent.name)
      .flatMap((entry) => (entry.body ? [entry.body] : []));
  };

  const bot = createStudyBot(participants, { chat, store, sets, now: () => new Date(), log, runId, recentBodies });

  const state = await agent.start({
    message: (event, meta) => bot.onMessage(event, meta),
    approvalOutcome: (event) => bot.onOutcome(event),
    takenOver: (reason) => {
      log(`another process took this connection, so this one is stopping: ${reason}`);
      process.exit(1);
    },
    gap: (frame) => log(`events were lost in Switch: ${frame.reason}`),
  });
  // Saved at once: a crash before anyone speaks must still resume from here rather than the newest message.
  store.mergePosition(state.position);

  log(`running ${bot.sessions.length} participants, run ${runId}, results in ${resultsDir}${dryRun ? " (DRY RUN: every event is marked synthetic)" : ""}`);
  await bot.resume();
  await bot.tick();

  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void bot.tick().finally(() => {
      ticking = false;
    });
  }, TICK_MS);

  const stop = () => {
    clearInterval(timer);
    void agent.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`study-bot failed: ${(error as Error).message}\n`);
  process.exit(1);
});
