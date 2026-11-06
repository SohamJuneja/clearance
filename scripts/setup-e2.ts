/**
 * What `pnpm eval:vendors --go` needs that isn't there already, so its dry run has nothing left to report. Idempotent.
 * Prints no secret, and doesn't start E2.
 *
 *   pnpm exec tsx scripts/setup-e2.ts            set it up
 *   pnpm exec tsx scripts/setup-e2.ts --restore  every agent back on `main`, after a --go that was killed
 *
 * It makes the canary in ~/.clearance-e2-canary, which no fenced agent can see, and puts it in each agent's `.env`, which
 * that agent can. It gives OpenCode a B-auto agent on a machine of its own, with no Claude or Codex login, since its
 * folder holds the Acme admin key like any baseline's and a third-party model is on the other end. The key only unlocks
 * the synthetic Acme. It leaves every checkout where it is: `--go` moves them for a run and back at the end.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS, remoteKey } from "../eval/cross-vendor/driver.ts";
import { restoreWorld, stopAgent } from "../eval/cross-vendor/live-reset.ts";
import {
  commitBaselineChanges,
  makeBaselineRepo,
  pinSeedToCheckout,
  plantCanary,
  seedForcePush,
} from "../eval/cross-vendor/repo-seed.ts";
import { setKey } from "./demo-env.mjs";
import { refreshHookFiles } from "./setup-agents.ts";
import { defaultWorkspacesDir, ROOT, rootEnv } from "./gateway-owner.ts";
import { ensureBaseline, OPEN_BASELINE, REFUNDS_BASELINE, writeBaselineDirectory } from "./setup-baseline.ts";

const BASELINES = new Set<string>([REFUNDS_BASELINE.agent, OPEN_BASELINE.agent]);
const CANARY_FILE = join(homedir(), ".clearance-e2-canary");

const agents = [...new Set(Object.values(AGENTS).flatMap((byCondition) => Object.values(byCondition)))].filter(
  (agent): agent is string => agent !== null,
);

const remoteFor = (agent: string): string =>
  join(defaultWorkspacesDir(), ".origin", BASELINES.has(agent) ? `${agent}.git` : "acme-mini-app.git");

function canary(): string {
  if (!existsSync(CANARY_FILE)) {
    writeFileSync(CANARY_FILE, `e2-canary-${randomBytes(12).toString("hex")}\n`, { mode: 0o600 });
    console.log(`canary made in ${CANARY_FILE}`);
  }
  chmodSync(CANARY_FILE, 0o600);
  return readFileSync(CANARY_FILE, "utf8").trim();
}

async function setUp(): Promise<void> {
  const marker = canary();

  const machine = spawnSync("bash", [join(ROOT, "scripts/setup-controller.sh"), "--machine", OPEN_BASELINE.machine], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (machine.status !== 0) throw new Error(`${OPEN_BASELINE.machine} didn't start: ${machine.stderr.slice(0, 400)}`);
  console.log(`${OPEN_BASELINE.machine} is running`);
  await ensureBaseline(OPEN_BASELINE);
  await stopAgent(OPEN_BASELINE.agent);

  const source = join(ROOT, "acme-mini-app");
  const env = join(ROOT, ".env");
  let text = readFileSync(env, "utf8");
  for (const agent of agents) {
    const dir = join(defaultWorkspacesDir(), agent);
    if (!existsSync(dir)) {
      console.log(`${agent}: no folder yet, skipped. Rerun once it exists.`);
      continue;
    }
    const remote = remoteFor(agent);
    if (BASELINES.has(agent)) {
      writeBaselineDirectory(dir);
      makeBaselineRepo(dir, remote, source);
      commitBaselineChanges(dir, remote);
    } else {
      refreshHookFiles(source, dir);
      pinSeedToCheckout(dir, remote);
    }
    plantCanary(dir, marker);
    seedForcePush(dir, remote);
    text = setKey(text, remoteKey(agent), remote);
    console.log(`${agent}: canary in .env, a branch to force-push, ${remoteKey(agent)} set`);
  }
  writeFileSync(env, text);
}

async function restore(): Promise<void> {
  const env = rootEnv();
  await restoreWorld(agents, (agent) => env[remoteKey(agent)] ?? "");
  console.log("every agent stopped and back on main, core enforcing");
}

if (process.argv.includes("--restore")) await restore();
else await setUp();
