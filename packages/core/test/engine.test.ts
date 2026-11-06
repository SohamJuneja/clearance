import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Action } from "@clearance/contracts";
import { callHash } from "../src/hash.js";
import { openDatabase } from "../src/db/index.js";
import { clampScore, evaluateAction, tierFor, type EngineDeps } from "../src/policy/engine.js";
import { parsePolicy } from "../src/policy/load.js";
import { AggregateStore } from "../src/risk/aggregates.js";
import { AutonomyStore } from "../src/autonomy/store.js";
import { FakeClock, FakeLookup, type World } from "./fakes.js";

const POLICY_DIR = new URL("../../../policy/", import.meta.url);
const policy = parsePolicy(readFileSync(new URL("clearance.policy.yaml", POLICY_DIR), "utf8"), "p.yaml");
const world = parse(readFileSync(new URL("tests/world.yaml", POLICY_DIR), "utf8")) as World;
const NOW = Date.parse("2026-11-04T14:00:00+05:30");

function deps(): EngineDeps & { aggregates: AggregateStore; lookup: FakeLookup; autonomy: AutonomyStore } {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "clearance-engine-")), "t.sqlite"));
  return {
    policy,
    lookup: new FakeLookup(world),
    clock: new FakeClock(NOW),
    aggregates: new AggregateStore(db),
    autonomy: new AutonomyStore(db),
  };
}

const refund = (args: Record<string, unknown>): Action => ({
  id: "a1",
  at: new Date(NOW).toISOString(),
  source: "gate",
  vendor: "gate",
  agent: { name: "refunds-agent" },
  kind: "business",
  raw: {},
  business: { endpoint: "POST /acme/refunds", args },
});
const big = { order_id: "A-1931", customer_id: "cus_8812", amount: 40000, destination: "meera.k@okaxis" };

describe("evaluateAction", () => {
  it("computes call_hash from class, target and args, with sorted keys", async () => {
    const d = deps();
    const one = await evaluateAction(refund(big), d);
    const reordered = await evaluateAction(
      refund({
        destination: big.destination,
        amount: big.amount,
        customer_id: big.customer_id,
        order_id: big.order_id,
      }),
      d,
    );
    expect(one.callHash).toBe(reordered.callHash);
    expect(one.callHash).toBe(callHash({ class: "refund", target: "POST /acme/refunds", args: big }));
  });

  it("changes call_hash when one argument changes", async () => {
    const d = deps();
    const one = await evaluateAction(refund(big), d);
    const other = await evaluateAction(refund({ ...big, amount: 45000 }), d);
    expect(one.callHash).not.toBe(other.callHash);
  });

  it("binds a hook call's hash to {command} per the contract", async () => {
    const d = deps();
    const action: Action = {
      id: "a2",
      at: new Date(NOW).toISOString(),
      source: "hook",
      vendor: "claude",
      agent: { name: "coder" },
      kind: "shell",
      raw: {},
      shell: { command: "git push --force origin main" },
    };
    const result = await evaluateAction(action, d);
    expect(result.callHash).toBe(
      callHash({ class: "merge", target: "shell", args: { command: "git push --force origin main" } }),
    );
  });

  it("hashes the risky sub-command in normalised form, not the raw bytes", async () => {
    const shell = (command: string): Action => ({
      id: "a4",
      at: new Date(NOW).toISOString(),
      source: "hook",
      vendor: "claude",
      agent: { name: "coder" },
      kind: "shell",
      raw: {},
      shell: { command },
    });
    const d = deps();
    const plain = await evaluateAction(shell("git push origin main"), d);
    const compound = await evaluateAction(shell(`git  push "origin" main 2>&1; echo "exit=$?"`), d);
    expect(compound.callHash).toBe(plain.callHash);
    expect(compound.call.args).toEqual({ command: "git push origin main" });
    const other = await evaluateAction(shell("git push origin master"), d);
    expect(other.callHash).not.toBe(plain.callHash);
  });

  it("says why it held in the reason text, in Appendix D wording", async () => {
    const result = await evaluateAction(refund(big), deps());
    expect(result.holdSummary).toBe("refunds over ₹10,000 need finance approval");
  });

  it("carries extracted fields and what systems of record said, for the card", async () => {
    const result = await evaluateAction(refund(big), deps());
    expect(result.extracted).toMatchObject({
      amount: 40000,
      customer: "cus_8812",
      destination: "meera.k@okaxis",
      order_total: 4000,
    });
    expect(result.lookups["orders:A-1931"]).toMatchObject({ total: 4000 });
  });

  it("writes flag text the card can show as is", async () => {
    const result = await evaluateAction(refund(big), deps());
    const text = Object.fromEntries(result.flags.map((flag) => [flag.code, flag.text]));
    expect(text.amount_vs_order).toBe("Amount is 10x the order total");
    expect(text.new_destination).toBe("Destination added in the last 24 h");
  });

  it("flags missing lookup data by name and keeps the hold even with L3 autonomy", async () => {
    const d = deps();
    d.autonomy.setLevel("refunds-agent", "refund", "small", "L3", NOW);
    const result = await evaluateAction(
      refund({ order_id: "A-404", customer_id: "cus_8812", amount: 100, destination: "meera.k@okaxis" }),
      d,
    );
    expect(result.decision).toBe("hold");
    const missing = result.flags.find((flag) => flag.code === "missing_data");
    expect(missing?.text).toContain("order_total");
  });

  it("names a rule by its flag, not its source, when a helper could not tell", async () => {
    const result = await evaluateAction(
      {
        id: "a9",
        at: new Date(NOW).toISOString(),
        source: "hook",
        vendor: "claude",
        agent: { name: "coder" },
        kind: "shell",
        raw: {},
        shell: { command: "git push origin main" },
      },
      deps(),
    );
    const missing = result.flags.find((flag) => flag.code === "missing_data");
    expect(missing?.text).toBe("Could not verify diff_lines, touches_auth from systems of record: treated as risky");
  });

  it("treats a lookup that throws the same as missing data: still held, never lower", async () => {
    const d = deps();
    const healthy = await evaluateAction(refund(big), d);
    d.lookup.failing = true;
    const down = await evaluateAction(refund(big), d);
    expect(down.decision).toBe("hold");
    expect(down.score).toBeGreaterThanOrEqual(healthy.score!);
    expect(down.flags.map((flag) => flag.code)).toContain("missing_data");
  });

  it("memoises a lookup within one evaluation", async () => {
    const d = deps();
    await evaluateAction(refund(big), d);
    const orderCalls = d.lookup.calls.filter((call) => call.kind === "orders");
    expect(orderCalls).toHaveLength(1);
  });

  it("does not hit systems of record for a safe call", async () => {
    const d = deps();
    const action: Action = {
      id: "a3",
      at: new Date(NOW).toISOString(),
      source: "gate",
      vendor: "gate",
      agent: { name: "refunds-agent" },
      kind: "business",
      raw: {},
      business: { endpoint: "GET /acme/orders/A-1931", args: {} },
    };
    expect((await evaluateAction(action, d)).decision).toBe("allow");
    expect(d.lookup.calls).toHaveLength(0);
  });

  it("consumes a grant before scoring, and only after deny and safe", async () => {
    const d = deps();
    const seen: string[] = [];
    const result = await evaluateAction(refund(big), {
      ...d,
      grants: {
        has: () => true,
        consumeAll: (hashes) => {
          seen.push(...hashes);
          return { requestIds: ["CLR-0001"] };
        },
      },
    });
    expect(seen).toHaveLength(1);
    expect(result.decision).toBe("allow");
    expect(result.step).toBe("grant");
    expect(result.grantRequestId).toBe("CLR-0001");
    expect(d.lookup.calls).toHaveLength(0);
  });
});

describe("scores stay inside the tier table", () => {
  it("lands an over-limit score in the top tier rather than erroring", () => {
    expect(tierFor(100, policy)).toBe("critical");
    expect(tierFor(5000, policy)).toBe("critical");
    expect(clampScore(5000, policy)).toBe(100);
  });

  it("lands a negative score in the bottom tier", () => {
    expect(tierFor(-5, policy)).toBe("low");
    expect(clampScore(-5, policy)).toBe(0);
  });

  it("follows the table, not a hard-coded 100", () => {
    const narrow = parsePolicy(
      readFileSync(new URL("clearance.policy.yaml", POLICY_DIR), "utf8").replace("critical: [80, 101]", "critical: [80, 90]"),
      "p.yaml",
    );
    expect(clampScore(500, narrow)).toBe(89);
    expect(tierFor(500, narrow)).toBe("critical");
  });

  it("clamps a call whose rules add up past the top of the table", async () => {
    const result = await evaluateAction(
      refund({ order_id: "A-1931", customer_id: "cus_8812", amount: 150000, destination: "meera.k@okaxis" }),
      deps(),
    );
    expect(result.score).toBe(100);
    expect(result.tier).toBe("critical");
    expect(result.decision).toBe("hold");
  });

  it("keeps the flags whatever points they carried", async () => {
    const result = await evaluateAction(refund(big), deps());
    expect(result.tier).toBe("critical");
    expect(result.flags.map((flag) => flag.code).sort()).toEqual(["amount_vs_order", "new_destination"]);
  });
});

describe("aggregate windows", () => {
  const seed = (d: ReturnType<typeof deps>, value: number, requestId: string | null, key = "cus_1") =>
    d.aggregates.record({
      cls: "refund",
      byField: "customer",
      key,
      value,
      agent: "a",
      actionId: "x",
      requestId,
      atMs: NOW,
    });
  const args = { order_id: "A-1931", customer_id: "cus_1", amount: 4000, destination: "rohan.s@okhdfc" };

  it("is a sliding window: an amount leaves the sum once it is older than the window", async () => {
    const d = deps();
    const clock = d.clock as FakeClock;
    seed(d, 8000, null);
    const within = await evaluateAction(refund(args), d);
    expect(within.flags.map((flag) => flag.code)).toContain("aggregate_limit");
    clock.advance(24 * 3_600_000 + 1);
    const after = await evaluateAction(refund(args), d);
    expect(after.flags.map((flag) => flag.code)).not.toContain("aggregate_limit");
  });

  it("uses scaled policy durations for the window", async () => {
    const d = deps();
    const clock = new FakeClock(NOW, 10);
    seed(d, 8000, null);
    clock.advance(2.4 * 3_600_000 + 1);
    const after = await evaluateAction(refund(args), { ...d, clock });
    expect(after.flags.map((flag) => flag.code)).not.toContain("aggregate_limit");
  });

  it("forgets voided rows, so a denied refund does not count against the next one", () => {
    const d = deps();
    seed(d, 8000, "CLR-0001");
    d.aggregates.voidRequest("CLR-0001");
    expect(d.aggregates.sum("refund", "customer", "cus_1", NOW - 3_600_000)).toBe(0);
  });

  it("is keyed by customer: another customer's refunds do not count", () => {
    const d = deps();
    seed(d, 9000, null, "cus_other");
    expect(d.aggregates.sum("refund", "customer", "cus_1", NOW - 3_600_000)).toBe(0);
  });
});
