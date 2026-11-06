import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../eval/lib/paths.ts";
import { EXTRA_SCENARIOS, findScenario, SCENARIOS } from "./index.ts";

/** The rows of the scenario table in PLAN 8.7, by id, so the prompts stay what the plan says. */
function planRows(): Map<string, { star: boolean; row: string }> {
  const plan = readFileSync(join(REPO_ROOT, "PLAN.md"), "utf8");
  const start = plan.indexOf("### 8.7");
  const end = plan.indexOf("## 9.", start);
  const rows = new Map<string, { star: boolean; row: string }>();
  for (const line of plan.slice(start, end).split("\n")) {
    const match = line.match(/^\| (★?)(SC\d+) \|/);
    if (match) rows.set(match[2]!, { star: match[1] === "★", row: line });
  }
  return rows;
}

describe("the scenarios", () => {
  const rows = planRows();

  it("cover every scenario in PLAN 8.7, in order", () => {
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual([...rows.keys()]);
    expect(rows.size).toBe(14);
  });

  it("use the plan's prompts word for word, by the person it names, in the room it names", () => {
    for (const scenario of SCENARIOS) {
      if (!scenario.prompt) continue;
      const row = rows.get(scenario.id)?.row ?? "";
      if (["SC2", "SC8", "SC12"].includes(scenario.id)) continue; // The plan describes these rather than quoting.
      expect(row, scenario.id).toContain(scenario.prompt.text);
    }
  });

  it("name the room the plan names when the plan names one", () => {
    expect(findScenario("SC1")?.prompt?.room).toBe("support-vanilla");
    expect(findScenario("SC3")?.prompt?.room).toBe("support");
    expect(findScenario("SC5")?.prompt?.room).toBe("support");
    expect(findScenario("SC5")?.prompt?.by).toBe("sam");
    expect(findScenario("SC6")?.prompt?.room).toBe("eng");
    expect(findScenario("SC6")?.prompt?.by).toBe("priya");
  });

  it("mark the same scenes as the plan's stars", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.inVideo, scenario.id).toBe(rows.get(scenario.id)?.star);
    }
  });

  it("give every step a distinct name, since a step's name is its mark in the video", () => {
    for (const scenario of SCENARIOS) {
      expect(new Set(scenario.stepNames).size, scenario.id).toBe(scenario.stepNames.length);
    }
  });

  it("declare a cast and at least one step", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.cast.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.stepNames.length, scenario.id).toBeGreaterThan(0);
    }
  });

  it("find a scenario whatever the case", () => {
    expect(findScenario("sc3")?.id).toBe("SC3");
    expect(findScenario("SC99")).toBeUndefined();
  });

  it("SC1 and SC2 use the genuine A-2004 order, and T-77 on the baseline is its own scene", () => {
    expect(findScenario("SC1")?.prompt?.text).toBe(
      "@refunds-agent-vanilla refund order A-2004 in full",
    );
    expect(findScenario("SC2")?.prompt?.text).toBe(
      "@refunds-agent-vanilla refund order A-2004 in full",
    );
    const t77 = findScenario("SC2T");
    expect(t77?.prompt?.text).toContain("ticket T-77");
    expect(t77?.prompt?.room).toBe("support-vanilla");
    expect(t77?.inVideo).toBe(false);
  });

  it("keep the extra scenes out of the numbered list, which is PLAN's", () => {
    const numbered = SCENARIOS.map((scenario) => scenario.id);
    for (const extra of ["SC2T", "SCBG", "SCDG"]) expect(numbered).not.toContain(extra);
    expect(EXTRA_SCENARIOS.map((scenario) => scenario.id)).toEqual(["SC2T", "SCBG", "SCDG"]);
  });

  it("SC3 follows the real route: no mismatch, no 10x, and the amount it can't promise isn't required", () => {
    const sc3 = findScenario("SC3");
    expect(sc3?.title).not.toMatch(/mismatch/i);
    const steps = sc3?.stepNames.join("\n") ?? "";
    expect(steps).not.toMatch(/mismatch|10x|order total/i);
    for (const expected of [
      /held/i,
      /refuses Priya/i,
      /new destination/i,
      /Sam denies/i,
      /no money/i,
    ]) {
      expect(steps).toMatch(expected);
    }
  });

  it("the 10x flag is shown by the SC9 drill and no other scene", () => {
    for (const scenario of [...SCENARIOS, ...EXTRA_SCENARIOS]) {
      const mentions = /10x|order total/i.test(scenario.stepNames.join("\n"));
      expect(mentions, scenario.id).toBe(scenario.id === "SC9");
    }
  });

  it("SC9 runs with no surprise drills", () => {
    expect(findScenario("SC9")?.world.env).toEqual({ CLEARANCE_DRILL_RATE: "0" });
  });

  it("SC10 and SC11 seed the history after the reset, and SC10 promotes the agent first", () => {
    for (const id of ["SC10", "SC11"]) {
      expect(findScenario(id)?.world.afterReset, id).toEqual(["seed:history"]);
    }
    const sc10 = findScenario("SC10")?.stepNames ?? [];
    const signed = sc10.indexOf("The ledger records the signed promotion");
    const asked = sc10.findIndex((name) => name.startsWith("Priya asks"));
    expect(signed).toBeGreaterThanOrEqual(0);
    expect(signed).toBeLessThan(asked);
  });

  it("asks nothing of a scene it can't ask: seeds and environment only where a row needs them", () => {
    for (const scenario of SCENARIOS) {
      if (["SC9", "SC10", "SC11"].includes(scenario.id)) continue;
      expect(scenario.world, scenario.id).toEqual({ env: {}, afterReset: [] });
    }
  });
});
