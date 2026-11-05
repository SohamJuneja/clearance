/**
 * The no-Clearance baseline for SC1, SC2 and SC14: refunds-agent-vanilla, owned by Priya, on her machine,
 * in room support-vanilla, from templates/acme-vanilla.template.yaml. Idempotent. Never prints a secret.
 *
 *   pnpm exec tsx scripts/setup-baseline.ts
 *
 * The working directory is pre-made because a session drops any variable not on Switch's allowlist, so
 * the admin key has to come from a file. The key only unlocks the synthetic Acme. The folder keeps the
 * claude.ai connector containment: this baseline has no approval layer, not access to anyone's mail.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultWorkspacesDir,
  ownerGateway,
  ownerMachine,
  rootEnv,
  type ManagedAgent,
  type OwnerGateway,
} from "./gateway-owner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
export const OWNER = "priya";
export const AGENT = "refunds-agent-vanilla";
export const ROOM = "support-vanilla";

export function writeBaselineDirectory(dir: string): void {
  const env = rootEnv();
  const key = env.ACME_ADMIN_KEY;
  if (!key) throw new Error("ACME_ADMIN_KEY is empty in the root .env");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  copyFileSync(join(REPO, "spikes/baseline-agent/README.md"), join(dir, "README.md"));
  copyFileSync(join(REPO, "spikes/baseline-agent/acme"), join(dir, "acme"));
  chmodSync(join(dir, "acme"), 0o755);
  copyFileSync(join(REPO, "spikes/configs/claude-baseline-settings.json"), join(dir, ".claude/settings.json"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, `ACME_URL=${env.ACME_URL ?? "http://127.0.0.1:7800"}\nACME_ADMIN_KEY=${key}\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);
}

export async function findAgent(gateway: OwnerGateway): Promise<ManagedAgent | undefined> {
  const agents = await gateway.must<ManagedAgent[]>("GET", "/management/agents");
  return agents.find((a) => a.name === AGENT);
}

type TemplateRun = {
  created_agents?: { name: string; machine?: unknown; listening?: boolean }[];
  room?: { id?: string; name?: string } | null;
  rooms?: { id?: string; name?: string }[];
};

async function main(): Promise<void> {
  const gateway = await ownerGateway(OWNER);
  const machine = await ownerMachine(gateway, "clearance-priya");
  const workspaces = machine.status?.machine?.workspaces_dir ?? defaultWorkspacesDir();
  const dir = join(workspaces, AGENT);
  writeBaselineDirectory(dir);
  console.log(`working directory ready: ${dir}`);

  const existing = await findAgent(gateway);
  if (existing) {
    console.log(`${AGENT} already defined, revision ${String(existing.revision)}, model ${String(existing.definition.model)}`);
    return;
  }
  const template = readFileSync(join(REPO, "templates/acme-vanilla.template.yaml"), "utf8");
  const run = await gateway.must<TemplateRun>("POST", "/rooms/from-template-document", {
    template,
    inputs: { auto_mode: true },
    template_name: "acme-vanilla",
  });
  console.log(`template ran: agents ${JSON.stringify((run.created_agents ?? []).map((a) => ({ name: a.name, machine: a.machine, listening: a.listening })))}`);
  const rooms = run.rooms ?? (run.room ? [run.room] : []);
  console.log(`rooms: ${JSON.stringify(rooms.map((r) => ({ name: r.name, id: r.id })))}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
