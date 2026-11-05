/**
 * `pnpm eval:latency`, E4: what Clearance adds to a call that it allows. Per PLAN 10.5, 1,000 allowed
 * calls through the Claude hook endpoint and 1,000 through the gate, with p50, p95 and p99 in added
 * milliseconds. Writes eval/out/e4-latency.json, with the hardware it ran on.
 *
 * The hook has no version without Clearance, so all its time is added. The gate is measured against the
 * same read going straight to Acme, a pair at a time, so load on the host lands on both sides.
 *
 * Needs a running core, gate and Acme. Until they exist it says so and writes nothing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, setting } from "../lib/paths.ts";
import { defaultUrls, probe } from "../lib/world.ts";

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
}

/** Nearest-rank percentile. A sample of the actual run, never an interpolation between two of them. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error("no samples");
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] as number;
}

export function summarise(samples: number[]): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value: number): number => Math.round(value * 100) / 100;
  return {
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
  };
}

export async function timeOnce(call: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await call();
  return performance.now() - started;
}

/** Times a call `count` times, one at a time. The first refusal stops the run: it isn't an allowed call. */
export async function measure(count: number, call: () => Promise<void>): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) samples.push(await timeOnce(call));
  return samples;
}

/** Pairs each call with its direct baseline and keeps the difference, floored at zero per sample. */
export async function measureAdded(
  count: number,
  direct: () => Promise<void>,
  through: () => Promise<void>,
): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const baseline = await timeOnce(direct);
    const total = await timeOnce(through);
    samples.push(Math.max(0, total - baseline));
  }
  return samples;
}

async function expectOk(res: Response, what: string): Promise<void> {
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`${what} answered ${res.status}, so it isn't an allowed call`);
}

export function requireSetting(key: string): string {
  const value = setting(key);
  if (!value) throw new Error(`${key} is not set. See .env.example`);
  return value;
}

async function main(): Promise<number> {
  const count = Number(process.argv[2] ?? 1000);
  const urls = defaultUrls();
  const problems = (
    await Promise.all([
      probe("core", urls.core),
      probe("gate", urls.gate),
      probe("acme", urls.acme),
    ])
  )
    .filter((result) => !result.reachable)
    .map((result) => result.message);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\nNothing was measured and nothing was written.\n`);
    return 1;
  }

  const hookToken = requireSetting("CLEARANCE_HOOK_TOKEN");
  const gateToken = requireSetting("CLEARANCE_E4_GATE_TOKEN");
  const adminKey = requireSetting("ACME_ADMIN_KEY");
  const agentCwd = requireSetting("CLEARANCE_E4_AGENT_CWD");

  const hookBody = JSON.stringify({
    session_id: "e4-latency",
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
    cwd: agentCwd,
  });
  const hookCall = async (): Promise<void> => {
    const res = await fetch(`${urls.core}/v1/hooks/claude`, {
      method: "POST",
      headers: { authorization: `Bearer ${hookToken}`, "content-type": "application/json" },
      body: hookBody,
    });
    await expectOk(res, "the Claude hook");
  };
  const directRead = async (): Promise<void> => {
    const res = await fetch(`${urls.acme}/orders/A-1931`, {
      headers: { "x-acme-admin-key": adminKey },
    });
    await expectOk(res, "Acme");
  };
  const gateRead = async (): Promise<void> => {
    const res = await fetch(`${urls.gate}/acme/orders/A-1931`, {
      headers: { authorization: `Bearer ${gateToken}` },
    });
    await expectOk(res, "the gate");
  };

  process.stdout.write(`measuring ${count} hook calls and ${count} gate calls\n`);
  const hook = summarise(await measure(count, hookCall));
  const gate = summarise(await measureAdded(count, directRead, gateRead));

  const cpu = cpus();
  const result = {
    experiment: "E4-latency",
    hook,
    gate,
    calls_each: count,
    host: {
      cpu: cpu[0]?.model ?? "unknown",
      cores: cpu.length,
      memory_gb: Math.round(totalmem() / 1024 ** 3),
    },
    measured_at: new Date().toISOString(),
  };
  const directory = join(REPO_ROOT, "eval/out");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "e4-latency.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `hook ${JSON.stringify(hook)}\ngate ${JSON.stringify(gate)}\nwrote eval/out/e4-latency.json\n`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`eval:latency failed: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
