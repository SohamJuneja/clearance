/**
 * `pnpm eval:latency`, E4: what Clearance adds to a call it allows (PLAN 10.5). Runs on its own isolated Acme,
 * gate and core processes, never the shared stack. Writes eval/out/e4-latency.json with the hardware and load
 * from /proc, because this host also runs other work and a number means little without that.
 *
 *   hook          1,000 allowed Claude hook calls over HTTP. There's no version without Clearance, so the
 *                 whole round trip counts as added.
 *   gate          1,000 allowed small refunds through the gate, each paired with the same refund going straight
 *                 to Acme, so load on the host lands on both sides. This is the full path: the gate fills
 *                 customer and destination, core checks and looks things up, the gate calls Acme. Autonomy is
 *                 promoted through a control route, because at the default level a refund is held.
 *   gate_read     1,000 reads through the gate, paired the same way.
 *   codex_cli     the real `clearance-hook codex` as a new process per call, as Codex runs it. Measured
 *                 separately because each call pays a Node start-up: with the real node binary, through the Volta shim
 *                 that `node` on this host's PATH is, and as `.codex/hooks.json` really runs it, which adds
 *                 `timeout` and the `bin/clearance-hook` wrapper.
 *
 * The first calls of each are warm-up and not counted: they measure the JIT, not the route.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexPayload, runHookCli } from "../authority-suite/cases.ts";
import { IsolatedWorld } from "../harness/world.ts";
import { type HostFacts, readHost } from "../lib/host.ts";
import { REPO_ROOT } from "../lib/paths.ts";

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
}

/** Nearest-rank percentile: always a real sample, never an interpolation between two of them. */
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

/** The command in acme-mini-app/.codex/hooks.json, word for word. */
export const CODEX_HOOK_COMMAND =
  "timeout 2 ./bin/clearance-hook codex || { echo 'Clearance denied this call and nothing ran: the hook failed.' >&2; exit 2; }";

/** Runs that command the way Codex does: a shell in the agent's directory, stdin holding the payload. */
function runConfiguredCodexHook(
  payload: unknown,
  coreUrl: string,
  hookToken: string,
): Promise<{ stdout: string; exitCode: number; elapsedMs: number }> {
  return new Promise((done, reject) => {
    const started = performance.now();
    const child = spawn("sh", ["-c", CODEX_HOOK_COMMAND], {
      cwd: join(REPO_ROOT, "acme-mini-app"),
      env: {
        PATH: `${join(homedir(), ".volta/bin")}:/usr/bin:/bin`,
        HOME: process.env.HOME,
        CLEARANCE_CORE_URL: coreUrl,
        CLEARANCE_HOOK_TOKEN: hookToken,
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) =>
      done({ stdout, exitCode: code ?? 1, elapsedMs: performance.now() - started }),
    );
    child.stdin.end(JSON.stringify(payload));
  });
}

const WARM_UP = 50;
const SMALL_REFUND = 1;

export interface LatencyOutput {
  experiment: "E4-latency";
  hook: Percentiles;
  gate: Percentiles;
  gate_read: Percentiles;
  codex_cli: {
    direct_node: Percentiles;
    volta_shim?: Percentiles;
    as_configured: Percentiles;
    calls: number;
  };
  calls_each: number;
  warm_up_calls: number;
  host_before: HostFacts;
  host_after: HostFacts;
  note: string;
  measured_at: string;
}

async function run(
  calls: number,
  cliCalls: number,
  print: (line: string) => void,
): Promise<LatencyOutput> {
  const hostBefore = readHost();
  const world = await IsolatedWorld.start({ name: "latency" });
  try {
    const hookCall = async (): Promise<void> => {
      const result = await world.claudeHook("coder", "Read", { file_path: "src/index.ts" });
      if (!result.allow) throw new Error(`the hook refused an allowed call: ${result.reason}`);
    };
    await measure(WARM_UP, hookCall);
    print(`measuring ${calls} hook calls`);
    const hook = summarise(await measure(calls, hookCall));

    // A small refund the policy allows once promoted, far under the 24 h limit even at this count.
    await world.setAutonomy("refunds-agent", "refund", "small", "L3");
    const refund = { order_id: "A-1931", amount: SMALL_REFUND };
    const gateRefund = async (): Promise<void> => {
      const res = await world.gate("refunds-agent", "POST", "/acme/refunds", refund);
      if (res.status !== 201)
        throw new Error(`the gate answered ${res.status}, so it isn't an allowed call`);
    };
    const directRefund = async (): Promise<void> => {
      const status = await world.acmeWrite("/refunds", {
        order_id: "A-1931",
        customer_id: "cus_8812",
        amount: SMALL_REFUND,
        destination: "meera.k@oksbi",
      });
      if (status !== 201) throw new Error(`Acme answered ${status}`);
    };
    await measureAdded(WARM_UP, directRefund, gateRefund);
    print(`measuring ${calls} refunds through the gate, each paired with one straight to Acme`);
    const gate = summarise(await measureAdded(calls, directRefund, gateRefund));

    const gateRead = async (): Promise<void> => {
      const res = await world.gate("refunds-agent", "GET", "/acme/orders/A-1931");
      if (res.status !== 200) throw new Error(`the gate answered ${res.status} to a read`);
    };
    const directRead = async (): Promise<void> => {
      const status = await world.acmeRead("/orders/A-1931");
      if (status !== 200) throw new Error(`Acme answered ${status} to a read`);
    };
    await measureAdded(WARM_UP, directRead, gateRead);
    print(`measuring ${calls} reads through the gate, paired the same way`);
    const gateReadResult = summarise(await measureAdded(calls, directRead, gateRead));

    const payload = codexPayload("support-agent", "ls");
    const cli = async (nodeCommand: string): Promise<number[]> => {
      const samples: number[] = [];
      for (let i = 0; i < cliCalls; i++) {
        const result = await runHookCli(
          "codex",
          payload,
          world.urls().core,
          world.hookTokenOf("support-agent"),
          nodeCommand,
        );
        if (result.exitCode !== 0 || result.stdout.includes('"deny"')) {
          throw new Error(
            `the hook CLI didn't allow it: exit ${result.exitCode} ${result.stdout.slice(0, 200)}`,
          );
        }
        samples.push(result.elapsedMs);
      }
      return samples;
    };
    print(`measuring ${cliCalls} runs of the Codex hook CLI with the real node binary`);
    const directNode = summarise(await cli(process.execPath));
    // pnpm puts the real node first on PATH, so the shim has to be named to be measured.
    const shim = join(homedir(), ".volta/bin/node");
    let voltaShim: Percentiles | undefined;
    if (existsSync(shim)) {
      print(`measuring ${cliCalls} runs of the Codex hook CLI through the Volta shim`);
      voltaShim = summarise(await cli(shim));
    }
    print(`measuring ${cliCalls} runs of the Codex hook as .codex/hooks.json runs it`);
    const configured: number[] = [];
    for (let i = 0; i < cliCalls; i++) {
      const result = await runConfiguredCodexHook(
        payload,
        world.urls().core,
        world.hookTokenOf("support-agent"),
      );
      if (result.exitCode !== 0 || result.stdout.includes('"deny"')) {
        throw new Error(
          `the configured hook didn't allow it: exit ${result.exitCode} ${result.stdout.slice(0, 200)}`,
        );
      }
      configured.push(result.elapsedMs);
    }

    return {
      experiment: "E4-latency",
      hook,
      gate,
      gate_read: gateReadResult,
      codex_cli: {
        direct_node: directNode,
        ...(voltaShim ? { volta_shim: voltaShim } : {}),
        as_configured: summarise(configured),
        calls: cliCalls,
      },
      calls_each: calls,
      warm_up_calls: WARM_UP,
      host_before: hostBefore,
      host_after: readHost(),
      note: "Isolated processes with a fake ChatPort, on a shared host with other work running, so see the load average. Allowed calls only. Includes the client's own fetch time on the hook; the gate figures are differences against the same call straight to Acme.",
      measured_at: new Date().toISOString(),
    };
  } finally {
    await world.stop();
  }
}

async function main(): Promise<number> {
  const print = (line: string): void => void process.stdout.write(`${line}\n`);
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  const calls = Number(argv[0] ?? 1000);
  const cliCalls = Number(argv[1] ?? 100);
  const output = await run(calls, cliCalls, print);
  const directory = join(REPO_ROOT, "eval/out");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "e4-latency.json"), `${JSON.stringify(output, null, 2)}\n`);
  print(`added ms, p50 / p95 / p99, ${calls} calls each`);
  const line = (name: string, value: Percentiles): void =>
    print(`  ${name.padEnd(24)} ${value.p50} / ${value.p95} / ${value.p99}`);
  line("Claude hook route", output.hook);
  line("gate, allowed refund", output.gate);
  line("gate, read", output.gate_read);
  print(`whole process, ${cliCalls} runs each`);
  line("Codex hook, real node", output.codex_cli.direct_node);
  if (output.codex_cli.volta_shim) line("Codex hook, Volta shim", output.codex_cli.volta_shim);
  line("Codex hook, as configured", output.codex_cli.as_configured);
  print(
    `host: ${output.host_before.cpu_model}, ${output.host_before.logical_cpus} logical CPUs, ${output.host_before.mem_total_gb} GB RAM`,
  );
  print(
    `load average before ${output.host_before.load_average.join(" ")}, after ${output.host_after.load_average.join(" ")}`,
  );
  print("wrote eval/out/e4-latency.json");
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
