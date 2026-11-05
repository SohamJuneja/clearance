/** What machine a measurement ran on, from /proc, so a latency number comes with its conditions. */
import { readFileSync } from "node:fs";

export interface HostFacts {
  cpu_model: string;
  logical_cpus: number;
  mem_total_gb: number;
  mem_available_gb: number;
  swap_total_gb: number;
  swap_used_gb: number;
  /** 1, 5 and 15 minute load averages. */
  load_average: [number, number, number];
  kernel: string;
}

const KB_PER_GB = 1024 * 1024;

export function parseHost(
  cpuinfo: string,
  meminfo: string,
  loadavg: string,
  version: string,
): HostFacts {
  const memory = (key: string): number => {
    const value = meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"))?.[1];
    if (value === undefined) throw new Error(`/proc/meminfo has no ${key}`);
    return Number(value);
  };
  const gb = (kb: number): number => Math.round((kb / KB_PER_GB) * 10) / 10;
  const load = loadavg.trim().split(/\s+/).slice(0, 3).map(Number);
  if (load.length !== 3 || load.some((value) => !Number.isFinite(value))) {
    throw new Error("/proc/loadavg can't be read");
  }
  return {
    cpu_model: cpuinfo.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() ?? "unknown",
    logical_cpus: (cpuinfo.match(/^processor\s*:/gm) ?? []).length,
    mem_total_gb: gb(memory("MemTotal")),
    mem_available_gb: gb(memory("MemAvailable")),
    swap_total_gb: gb(memory("SwapTotal")),
    swap_used_gb: gb(memory("SwapTotal") - memory("SwapFree")),
    load_average: load as [number, number, number],
    kernel: version.split(/\s+/).slice(0, 3).join(" "),
  };
}

export function readHost(): HostFacts {
  return parseHost(
    readFileSync("/proc/cpuinfo", "utf8"),
    readFileSync("/proc/meminfo", "utf8"),
    readFileSync("/proc/loadavg", "utf8"),
    readFileSync("/proc/version", "utf8"),
  );
}
