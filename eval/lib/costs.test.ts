import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAP_SETTING,
  ensureWithinCap,
  readCosts,
  recordCost,
  SpendCapError,
  totalSpend,
} from "./costs.ts";

describe("costs", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "costs-"));
    path = join(dir, "costs.json");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when there's no file", () => {
    expect(readCosts(path)).toEqual([]);
    expect(totalSpend(readCosts(path))).toBe(0);
  });

  it("the real log parses", () => {
    expect(Array.isArray(readCosts())).toBe(true);
  });

  it("records entries and adds them up", () => {
    recordCost({ experiment: "E2", usd: 1.5, note: "run 1" }, { path, capUsd: 35 });
    recordCost({ experiment: "E2", usd: 2.25 }, { path, capUsd: 35 });
    const entries = readCosts(path);
    expect(entries.map((entry) => entry.usd)).toEqual([1.5, 2.25]);
    expect(entries[0]?.experiment).toBe("E2");
    expect(entries[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(totalSpend(entries)).toBe(3.75);
  });

  it("allows spend up to the cap", () => {
    recordCost({ experiment: "E2", usd: 30 }, { path, capUsd: 35 });
    expect(() => ensureWithinCap(5, { path, capUsd: 35 })).not.toThrow();
  });

  it("refuses spend that would pass the cap, saying where it stands and what to do", () => {
    recordCost({ experiment: "E2", usd: 30 }, { path, capUsd: 35 });
    expect(() => ensureWithinCap(5.01, { path, capUsd: 35 })).toThrow(SpendCapError);
    expect(() => ensureWithinCap(5.01, { path, capUsd: 35 })).toThrow(
      /\$30\.00 spent.*\$5\.01 more.*cap \$35\.00.*HUMAN\.md/,
    );
  });

  it("records an overrun and then refuses, because the money is already gone", () => {
    recordCost({ experiment: "E2", usd: 30 }, { path, capUsd: 35 });
    expect(() => recordCost({ experiment: "E2", usd: 10 }, { path, capUsd: 35 })).toThrow(
      SpendCapError,
    );
    expect(totalSpend(readCosts(path))).toBe(40);
    expect(() => ensureWithinCap(0, { path, capUsd: 35 })).toThrow(SpendCapError);
  });

  it("reads the cap from the environment", () => {
    vi.stubEnv(CAP_SETTING, "2");
    recordCost({ experiment: "E2", usd: 1 }, { path });
    expect(() => ensureWithinCap(5, { path })).toThrow(/cap \$2\.00/);
  });

  it("refuses to spend when the cap isn't a number", () => {
    vi.stubEnv(CAP_SETTING, "lots");
    expect(() => ensureWithinCap(0, { path })).toThrow(/not a number, so no spend is allowed/);
  });

  it("refuses to spend when it can't read the log, rather than assuming nothing was spent", () => {
    writeFileSync(path, JSON.stringify({ spent: "who knows" }));
    expect(() => ensureWithinCap(0, { path, capUsd: 35 })).toThrow(/can't be read/);
  });

  it("leaves valid JSON behind", () => {
    recordCost({ experiment: "E2", usd: 1 }, { path, capUsd: 35 });
    expect(JSON.parse(readFileSync(path, "utf8")).entries).toHaveLength(1);
  });

  it("refuses a negative cost", () => {
    expect(() => recordCost({ experiment: "E2", usd: -1 }, { path, capUsd: 35 })).toThrow();
  });
});
