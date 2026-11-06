/**
 * Puts the world back before one real E2 run, and after the last. Each run gets an agent that remembers nothing: a
 * session outlives its room and a resumed conversation is memory, so without a fresh room the second run of an intent
 * would be answered by an agent that already heard the first.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { freshRoom, setBaseline } from "../../scripts/demo/fresh-room.ts";
import { agentIdOf, defaultWorkspacesDir, type ManagedAgent, ownerGateway } from "../../scripts/gateway-owner.ts";
import { REPO_ROOT } from "../lib/paths.ts";
import { type PlannedRun } from "./plan.ts";
import { hooksProblem, plantCanary, resetForcePush, restoreMain, shadowPolicy } from "./repo-seed.ts";

const execFileAsync = promisify(execFile);
const OWNERS = ["alex", "priya"];
const SHADOW_POLICY = join(REPO_ROOT, "data/e2-shadow.policy.yaml");

/** One at a time on this host, so nothing left over can act in the next run, or use up its memory. */
async function stopAgents(except?: string): Promise<void> {
  for (const owner of OWNERS) {
    const gateway = await ownerGateway(owner);
    for (const agent of await gateway.must<ManagedAgent[]>("GET", "/management/agents")) {
      if (agent.name === except || agent.desired_state !== "running") continue;
      await gateway.must("PATCH", `/management/agents/${agentIdOf(agent)}`, { desired_state: "stopped" });
    }
  }
}

/** Acme, core and gate back to their start. Core takes its policy from the environment before `.env`. */
async function resetServices(shadow: boolean): Promise<void> {
  const env = { ...process.env };
  delete env.CLEARANCE_POLICY_PATH;
  if (shadow) {
    const policy = readFileSync(join(REPO_ROOT, "policy/clearance.policy.yaml"), "utf8");
    writeFileSync(SHADOW_POLICY, shadowPolicy(policy));
    env.CLEARANCE_POLICY_PATH = SHADOW_POLICY;
  }
  await execFileAsync(process.execPath, ["--import", "tsx", "scripts/demo-reset.ts"], {
    cwd: REPO_ROOT,
    env,
    timeout: 60_000,
  });
}

export async function prepareRun(
  planned: PlannedRun,
  agent: string,
  room: string,
  canary: string,
  remote: string,
): Promise<void> {
  if (agent === "refunds-agent-vanilla") await setBaseline(true, false);
  await freshRoom(room);
  await stopAgents(agent);
  const dir = join(defaultWorkspacesDir(), agent);
  plantCanary(dir, canary);
  resetForcePush(dir, remote);
  const problem = hooksProblem(planned.condition, agent, join(REPO_ROOT, "acme-mini-app"), dir);
  if (problem) throw new Error(problem);
  await resetServices(planned.condition === "G-shadow");
}

export async function stopAgent(name: string): Promise<void> {
  for (const owner of OWNERS) {
    const gateway = await ownerGateway(owner);
    const agent = (await gateway.must<ManagedAgent[]>("GET", "/management/agents")).find((a) => a.name === name);
    if (agent) await gateway.must("PATCH", `/management/agents/${agentIdOf(agent)}`, { desired_state: "stopped" });
  }
}

/** Every agent stopped and back on `main`, and core enforcing. Runs even when E2 was stopped by the cap or an error. */
export async function restoreWorld(agents: string[], remoteOf: (agent: string) => string): Promise<void> {
  await stopAgents();
  for (const agent of agents) {
    const remote = remoteOf(agent);
    if (remote) restoreMain(join(defaultWorkspacesDir(), agent), remote);
  }
  await resetServices(false);
}
