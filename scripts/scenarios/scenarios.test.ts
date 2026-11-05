import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../eval/lib/paths.ts";
import { findScenario, SCENARIOS } from "./index.ts";

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
});
