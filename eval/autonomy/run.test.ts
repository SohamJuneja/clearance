import { beforeAll, describe, expect, it } from "vitest";
import { runAutonomyEval } from "./run.ts";

describe("pnpm eval:autonomy", () => {
  let result: Awaited<ReturnType<typeof runAutonomyEval>>;
  beforeAll(async () => {
    result = await runAutonomyEval();
  }, 60_000);

  it("writes what eval/report.ts reads, labelled synthetic", () => {
    expect(result.experiment).toBe("E6");
    expect(result.synthetic).toBe(true);
    expect(typeof result.human_decisions_per_100.before).toBe("number");
    expect(typeof result.human_decisions_per_100.after).toBe("number");
  });

  it("the seeded history yields exactly one proposal, and two signatures promote", () => {
    expect(result.proposals_from_seeded_history).toBe(1);
    expect(result.level_after_signing).toBe("L2");
  });

  it("the replay has no wrong auto-approvals, and leaves fast approvals out of the evidence", () => {
    expect(result.replay.wrong_auto_approvals).toBe(0);
    expect(result.replay.fast_approvals_excluded).toBeGreaterThan(0);
    expect(result.replay.counted).toBeGreaterThanOrEqual(20);
    expect(result.replay.denied).toBe(0);
  });

  it("human decisions fall once promoted, under the rule in force, with the amounts above range held for a person", () => {
    expect(result.human_decisions_per_100.after).toBeLessThan(result.human_decisions_per_100.before);
    expect(result.second_week.demoted_at_action).toBeNull();
    expect(result.second_week.held_above_normal_range).toBeGreaterThan(0);
    expect(result.second_week.human_decisions).toBeGreaterThanOrEqual(result.second_week.held_above_normal_range);
  });

  it("publishes the original rule beside it, as computed, and says the rule changed after seeing the first result", () => {
    const original = result.original_rule;
    expect(original.human_decisions_per_100.before).toBe(result.human_decisions_per_100.before);
    expect(original.human_decisions_per_100.after).toBeGreaterThan(result.human_decisions_per_100.after);
    expect(original.second_week.demoted_at_action).not.toBeNull();
    expect(original.second_week.demoted_because).toBe("above the 95th percentile");
    expect(original.second_week.actions).toBe(result.second_week.actions);
    expect(result.rule_change).toMatch(/changed after seeing the first result/);
    expect(result.rule_change).toMatch(/synthetic/);
  });

  it("one incident demotes, and the next refund in the bucket is held", () => {
    expect(result.incident).toMatchObject({ ran_before_incident: true, level_after: "L0", next_refund: "hold" });
  });

  it("gives the same numbers every run: nothing here depends on the machine except the one latency", async () => {
    const again = await runAutonomyEval();
    const stable = (value: typeof result) => ({ ...value, incident: { ...value.incident, incident_to_demotion_ms: 0 } });
    expect(stable(again)).toEqual(stable(result));
  }, 60_000);

  it("keeps the ledger verifiable through it all", () => {
    expect(result.ledger_verifies).toBe(true);
  });
});
