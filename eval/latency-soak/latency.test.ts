import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/paths.ts";
import { CODEX_HOOK_COMMAND, measure, measureAdded, percentile, summarise, refundAmount, withRoomForRefunds } from "./latency.ts";

describe("the Codex hook measurement", () => {
  it("runs the command the agents are really configured with", () => {
    const hooks = readFileSync(join(REPO_ROOT, "acme-mini-app/.codex/hooks.json"), "utf8");
    expect(hooks).toContain(JSON.stringify(CODEX_HOOK_COMMAND).slice(1, -1));
  });
});

describe("percentile", () => {
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1);

  it("takes the nearest rank, which is always a real sample", () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  it("handles a tiny sample", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([1, 2], 50)).toBe(1);
  });

  it("refuses no samples at all, rather than reporting zero latency", () => {
    expect(() => percentile([], 50)).toThrow(/no samples/);
  });
});

describe("summarise", () => {
  it("sorts first and rounds to hundredths", () => {
    expect(summarise([3.14159, 1, 2])).toEqual({ p50: 2, p95: 3.14, p99: 3.14 });
  });
});

describe("measure", () => {
  it("takes one sample per call", async () => {
    let calls = 0;
    const samples = await measure(5, async () => {
      calls += 1;
    });
    expect(samples).toHaveLength(5);
    expect(calls).toBe(5);
    expect(samples.every((sample) => sample >= 0)).toBe(true);
  });

  it("stops at the first refusal, since a refused call isn't an allowed one", async () => {
    let calls = 0;
    await expect(
      measure(5, async () => {
        calls += 1;
        if (calls === 2) throw new Error("the Claude hook answered 403");
      }),
    ).rejects.toThrow(/403/);
    expect(calls).toBe(2);
  });
});

describe("measureAdded", () => {
  it("runs each pair, direct then through", async () => {
    const order: string[] = [];
    const samples = await measureAdded(
      2,
      async () => void order.push("direct"),
      async () => void order.push("through"),
    );
    expect(order).toEqual(["direct", "through", "direct", "through"]);
    expect(samples).toHaveLength(2);
  });

  it("never reports negative added time", async () => {
    const samples = await measureAdded(
      3,
      () => new Promise((done) => setTimeout(done, 5)),
      async () => undefined,
    );
    expect(samples.every((sample) => sample >= 0)).toBe(true);
  });
});

describe("room for a thousand different refunds", () => {
  const policy = readFileSync(join(REPO_ROOT, "policy/clearance.policy.yaml"), "utf8");

  it("raises the refund limits a thousand small refunds would hit, in that one world's copy", () => {
    const out = withRoomForRefunds(policy);
    expect(out).not.toContain("sum: amount, by: customer, window: 24h, over: 10000,");
    expect(out).not.toContain("sum: amount, by: destination, window: 24h, over: 10000,");
    expect(out).toContain("daily_cap: 100000000");
    expect(out).not.toMatch(/label: 'refunds up to ₹5,000', daily_cap: 25000/);
  });

  it("stops if the policy has changed, rather than quietly measuring held calls", () => {
    expect(() => withRoomForRefunds("classes: {}")).toThrow(/policy/);
  });

  it("gives every refund its own amount, or the second would be held as an identical call", () => {
    const amounts = Array.from({ length: 1050 }, (_, index) => refundAmount(index));
    expect(new Set(amounts).size).toBe(1050);
    expect(Math.max(...amounts)).toBeLessThanOrEqual(5000);
    expect(Math.min(...amounts)).toBeGreaterThan(0);
  });

  it("never climbs, or it soon reads as above the agent's normal range and is held", () => {
    const amounts = Array.from({ length: 1050 }, (_, index) => refundAmount(index));
    expect(amounts.every((amount, index) => index === 0 || amount < (amounts[index - 1] as number))).toBe(true);
  });
});
