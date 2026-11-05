import { describe, expect, it } from "vitest";
import { parseHost, readHost } from "./host.ts";

const CPUINFO =
  "processor\t: 0\nmodel name\t: Test CPU @ 3GHz\n\nprocessor\t: 1\nmodel name\t: Test CPU @ 3GHz\n";
const MEMINFO =
  "MemTotal:       16777216 kB\nMemAvailable:    8388608 kB\nSwapTotal:       4194304 kB\nSwapFree:        3145728 kB\n";

describe("parseHost", () => {
  it("reads the machine from /proc's text", () => {
    expect(
      parseHost(CPUINFO, MEMINFO, "1.50 2.25 3.00 2/100 123\n", "Linux version 7.0.0 (x) more"),
    ).toEqual({
      cpu_model: "Test CPU @ 3GHz",
      logical_cpus: 2,
      mem_total_gb: 16,
      mem_available_gb: 8,
      swap_total_gb: 4,
      swap_used_gb: 1,
      load_average: [1.5, 2.25, 3],
      kernel: "Linux version 7.0.0",
    });
  });

  it("fails rather than reporting a made-up figure", () => {
    expect(() => parseHost(CPUINFO, "nothing", "1 2 3", "x")).toThrow(/MemTotal/);
    expect(() => parseHost(CPUINFO, MEMINFO, "nonsense", "x")).toThrow(/loadavg/);
  });
});

describe("readHost", () => {
  it("reads this machine", () => {
    const host = readHost();
    expect(host.logical_cpus).toBeGreaterThan(0);
    expect(host.mem_total_gb).toBeGreaterThan(0);
  });
});
