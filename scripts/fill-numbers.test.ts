import { describe, expect, it } from "vitest";
import { fill, valuesFrom, type NumberSources } from "./fill-numbers.ts";

const sources = (): NumberSources => ({
  authority: { clearance: { prevented: 25, total: 25 }, audit: { passed: 5, total: 5 }, second_review: { passed: 28, total: 28 }, third_review: { passed: 19, total: 19 }, fourth_review: { passed: 23, total: 23 } },
  autonomy: {
    synthetic: true,
    human_decisions_per_100: { before: 100, after: 25.8 },
    original_rule: {
      human_decisions_per_100: { after: 79.2 },
      second_week: { actions: 120, demoted_at_action: 34 },
    },
  },
  baseline: {
    summary: {
      t77: { attempted: 0, runs: 9 },
      full_refund: {
        auto: { paid: 6, runs: 8 },
        ask: { paid: 6, runs: 8, cards: 29, pressed_by: { priya: 29 } },
      },
    },
  },
  e2: "We measured something.",
  e1Live: "25 of 25 also ran on real Switch and Mattermost, 25 prevented there, 5 adapted to what the stack has",
  repoUrl: "https://github.com/example/clearance",
});

describe("valuesFrom", () => {
  it("takes every number from the result files", () => {
    expect(valuesFrom(sources())).toEqual({
      E1: "25 of 25",
      AUDIT_BREAKS: "5",
      SECOND_REVIEW_BREAKS: "28",
      THIRD_REVIEW_BREAKS: "19",
      FOURTH_REVIEW_BREAKS: "23",
      E6_BEFORE: "100",
      E6_AFTER: "25.8",
      E6_ORIGINAL: "79.2",
      E6_ORIGINAL_DEMOTION: "at action 34 of 120",
      T77_RUNS: "9",
      BL_AUTO: "6 of 8",
      BL_ASK: "6 of 8",
      BL_ASK_CARDS: "29",
      E2_MEASURED: "We measured something.",
      E1_LIVE: "25 of 25 also ran on real Switch and Mattermost, 25 prevented there, 5 adapted to what the stack has",
      REPO_URL: "https://github.com/example/clearance",
    });
  });

  it("refuses to fill drafts that quote E1's live run when there isn't one", () => {
    const changed = sources();
    changed.e1Live = undefined;
    expect(() => valuesFrom(changed)).toThrow(/live/);
  });

  it("refuses to fill drafts that quote E2 before E2 has both sides", () => {
    const changed = sources();
    changed.e2 = undefined;
    expect(() => valuesFrom(changed)).toThrow(/E2/);
  });

  it("refuses to say the agent never attempted it once it has", () => {
    const changed = sources();
    changed.baseline.summary.t77.attempted = 1;
    expect(() => valuesFrom(changed)).toThrow(/attempted T-77/);
  });

  it("refuses to say Priya pressed every card once someone else has", () => {
    const changed = sources();
    changed.baseline.summary.full_refund.ask.pressed_by = { priya: 28, sam: 1 };
    expect(() => valuesFrom(changed)).toThrow(/pressed/);
  });

  it("refuses to quote E1 as passing when a review break is still open", () => {
    const changed = sources();
    changed.authority.audit.passed = 4;
    expect(() => valuesFrom(changed)).toThrow(/audit/i);
  });

  it("refuses to say the second review's breaks are fixed while one is open", () => {
    const changed = sources();
    changed.authority.second_review.passed = 27;
    expect(() => valuesFrom(changed)).toThrow(/second review/);
  });

  it("refuses to say the third review's breaks are fixed while one is open", () => {
    const changed = sources();
    changed.authority.third_review.passed = 18;
    expect(() => valuesFrom(changed)).toThrow(/third review/);
  });

  it("refuses to say the fourth review's breaks are fixed while one is open", () => {
    const changed = sources();
    changed.authority.fourth_review.passed = 22;
    expect(() => valuesFrom(changed)).toThrow(/fourth review/);
  });

  it("takes the fifth review's number from the result file, and a draft naming it won't fill without one", () => {
    const changed = sources();
    expect(() => fill("{{FIFTH_REVIEW_BREAKS}}", valuesFrom(changed))).toThrow(/FIFTH_REVIEW_BREAKS/);
    changed.authority.fifth_review = { passed: 25, total: 25, breaks: 21 };
    expect(fill("{{FIFTH_REVIEW_BREAKS}}", valuesFrom(changed)), "a check that guards a fix isn't a break anyone found").toBe("21");
  });

  it("refuses to say the fifth review's breaks are fixed while one is open", () => {
    const changed = sources();
    changed.authority.fifth_review = { passed: 24, total: 25 };
    expect(() => valuesFrom(changed)).toThrow(/fifth review/);
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
