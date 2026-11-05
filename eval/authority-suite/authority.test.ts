import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findUpwards, REPO_ROOT } from "../lib/paths.ts";
import { BASELINE_BASIS, BASELINES, verifyBaselines } from "./baselines.ts";
import { CASES } from "./cases.ts";
import { LIVE_CASES, liveAllowed, runLive } from "./live.ts";
import { countPrevented, Findings, StopCase, verdictOf } from "./scene.ts";

/** The rows of PLAN 10.2's table. */
function planCases(): { id: number; title: string; bad: string }[] {
  const plan = readFileSync(join(REPO_ROOT, "PLAN.md"), "utf8");
  const section = plan.slice(plan.indexOf("### 10.2"), plan.indexOf("### 10.3"));
  return section
    .split("\n")
    .map((line) => line.match(/^\| (\d+) \| (.+) \| (.+) \|$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ id: Number(match[1]), title: match[2] as string, bad: match[3] as string }));
}

describe("the case list", () => {
  it("has all 25 cases from PLAN 10.2, none dropped", () => {
    expect(planCases().map((row) => row.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(CASES.map((one) => one.id)).toEqual(planCases().map((row) => row.id));
  });

  it("checks the bad outcome the plan names", () => {
    for (const row of planCases()) {
      const found = CASES.find((one) => one.id === row.id);
      if (row.id === 22) expect(found?.badOutcome).toContain("non-approver's answer");
      else expect(found?.badOutcome, `case ${row.id}`).toBe(row.bad);
    }
  });

  it("says what the fake chat means for every case", () => {
    for (const one of CASES) expect(one.chat.length, `case ${one.id}`).toBeGreaterThan(10);
  });

  it("offers --live for the cases where chat is the point", () => {
    for (const id of [1, 4, 5, 22]) {
      expect(CASES.find((one) => one.id === id)?.chat, `case ${id}`).toContain("--live");
    }
  });
});

describe("the verdict", () => {
  it("is prevented only when nothing bad happened and the legitimate path worked", () => {
    const findings = new Findings();
    findings.bad("the refund ran", false);
    findings.control("Sam's approval executes it", true);
    expect(verdictOf(findings).outcome).toBe("prevented");
  });

  it("is not prevented when the bad outcome happened, whatever else passed", () => {
    const findings = new Findings();
    findings.bad("the refund ran", true);
    findings.control("the ledger recorded it", true);
    expect(verdictOf(findings)).toEqual({
      outcome: "not prevented",
      why: "bad outcome: the refund ran",
    });
  });

  it("won't claim prevention when a control failed, because a broken core prevents everything", () => {
    const findings = new Findings();
    findings.bad("the refund ran", false);
    findings.control("Sam's approval executes it", false);
    const verdict = verdictOf(findings);
    expect(verdict.outcome).toBe("not prevented");
    expect(verdict.why).toContain("a control failed: Sam's approval executes it");
  });

  it("says no such control when the feature isn't built, so an unbuilt case can't pass by doing nothing", () => {
    const findings = new Findings();
    findings.bad("break-glass worked for Sam", false);
    findings.feature("break-glass", false);
    const verdict = verdictOf(findings);
    expect(verdict.outcome).toBe("no such control");
    expect(verdict.why).toContain("not built: break-glass");
  });

  it("puts a bad outcome ahead of a missing feature", () => {
    const findings = new Findings();
    findings.feature("break-glass", false);
    findings.bad("it executed", true);
    expect(verdictOf(findings).outcome).toBe("not prevented");
  });

  it("counts a case that couldn't finish as not prevented", () => {
    const verdict = verdictOf(new Findings(), "core exited");
    expect(verdict.outcome).toBe("not prevented");
    expect(verdict.why).toContain("core exited");
  });

  it("stops a case on a failed requirement and keeps what it found", () => {
    const findings = new Findings();
    expect(() => findings.require("the refund is held", false)).toThrow(StopCase);
    expect(findings.failedControls).toEqual(["the refund is held"]);
  });

  it("counts only prevented in the headline, per PLAN 10.2", () => {
    expect(countPrevented(["prevented", "not prevented", "no such control", "prevented"])).toBe(2);
  });
});

describe("--live", () => {
  it("won't touch the shared stack until someone says it's quiet", async () => {
    expect(liveAllowed({})).toBe(false);
    expect(liveAllowed({ CLEARANCE_EVAL_LIVE_OK: "0" })).toBe(false);
    expect(liveAllowed({ CLEARANCE_EVAL_LIVE_OK: "1" })).toBe(true);
  });

  it("refuses to run without that, and says why", async () => {
    vi.stubEnv("CLEARANCE_EVAL_LIVE_OK", "");
    const lines: string[] = [];
    expect(await runLive((line) => lines.push(line))).toBe(1);
    expect(lines.join("\n")).toContain("shared stack");
    vi.unstubAllEnvs();
  });

  it("covers the cases where chat is the point", () => {
    expect(LIVE_CASES).toEqual([1, 4, 5, 22]);
  });
});

describe("the baselines", () => {
  it("cover every case for both baselines, and each cites something", () => {
    expect(BASELINES.map((one) => one.id)).toEqual(CASES.map((one) => one.id));
    for (const baseline of BASELINES) {
      for (const entry of [baseline.bAuto, baseline.bAsk]) {
        expect(entry.cites.length, `case ${baseline.id}`).toBeGreaterThan(0);
        expect(entry.why.length, `case ${baseline.id}`).toBeGreaterThan(10);
      }
    }
  });

  it("say plainly they are from reading code", () => {
    expect(BASELINE_BASIS).toMatch(/reading Switch's code/);
    expect(BASELINE_BASIS).toMatch(/not measured/);
  });

  it("don't claim the refund ran in a baseline run, because it never did", () => {
    for (const baseline of BASELINES) {
      for (const entry of [baseline.bAuto, baseline.bAsk]) {
        if (!entry.ran?.includes("RESULTS-baseline")) continue;
        expect(entry.ran, `case ${baseline.id}`).toMatch(/never attempted/);
      }
    }
  });

  const switchRoot = findUpwards("vendor/switch/core/switch_core");
  it.runIf(switchRoot !== undefined)("quote the pinned checkout accurately, line for line", () => {
    const root = (switchRoot as string).replace(/\/core\/switch_core$/, "");
    expect(verifyBaselines(root, REPO_ROOT)).toEqual([]);
  });
});
