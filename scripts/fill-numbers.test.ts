import { describe, expect, it } from "vitest";
import { fill, valuesFrom, type NumberSources } from "./fill-numbers.ts";

const sources = (): NumberSources => ({
  authority: { clearance: { prevented: 25, total: 25 }, audit: { passed: 5, total: 5 } },
  autonomy: {
    synthetic: true,
    human_decisions_per_100: { before: 100, after: 25.8 },
    original_rule: {
      human_decisions_per_100: { after: 79.2 },
      second_week: { actions: 120, demoted_at_action: 34 },
    },
  },
  baseline: { summary: { t77: { attempted: 0, runs: 9 } } },
  repoUrl: "https://github.com/example/clearance",
});

describe("valuesFrom", () => {
  it("takes every number from the result files", () => {
    expect(valuesFrom(sources())).toEqual({
      E1: "25 of 25",
      AUDIT_BREAKS: "5",
      E6_BEFORE: "100",
      E6_AFTER: "25.8",
      E6_ORIGINAL: "79.2",
      E6_ORIGINAL_DEMOTION: "at action 34 of 120",
      T77_RUNS: "9",
      REPO_URL: "https://github.com/example/clearance",
    });
  });

  it("refuses to say the agent never attempted it once it has", () => {
    const changed = sources();
    changed.baseline.summary.t77.attempted = 1;
    expect(() => valuesFrom(changed)).toThrow(/attempted T-77/);
  });

  it("refuses to quote E1 as passing when a review break is still open", () => {
    const changed = sources();
    changed.authority.audit.passed = 4;
    expect(() => valuesFrom(changed)).toThrow(/audit/i);
  });

  it("refuses a week that isn't labelled synthetic", () => {
    const changed = sources();
    changed.autonomy.synthetic = false;
    expect(() => valuesFrom(changed)).toThrow(/synthetic/);
  });

  it("refuses when the original rule never demoted, since the blog says it did", () => {
    const changed = sources();
    changed.autonomy.original_rule.second_week.demoted_at_action = null;
    expect(() => valuesFrom(changed)).toThrow(/demot/);
  });

  it("refuses without a repo link", () => {
    const changed = sources();
    changed.repoUrl = "";
    expect(() => valuesFrom(changed)).toThrow(/repo/i);
  });
});

describe("fill", () => {
  it("replaces every token and drops notes to the author", () => {
    expect(fill("<!-- note -->\nWe scored {{E1}} of it.\n", { E1: "25 of 25" })).toBe("We scored 25 of 25 of it.\n");
  });

  it("refuses a token it has no value for, instead of publishing the braces", () => {
    expect(() => fill("{{E1}} and {{E5}}", { E1: "25 of 25" })).toThrow(/E5/);
  });
});
