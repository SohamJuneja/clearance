import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type EvalStep, runAll, stepsFor } from "./all.ts";
import { REPO_ROOT } from "./lib/paths.ts";

const names = (steps: EvalStep[]): string[] =>
  steps.map((step) => [step.script, ...step.args].join(" "));

const DEFAULT = [
  "eval:authority",
  "eval:mutations",
  "eval:baseline",
  "eval:behaviour",
  "eval:autonomy",
  "eval:latency",
  "eval:report",
];

describe("pnpm eval:all", () => {
  it("runs the isolated evals in order, then the report, and neither soak nor live", () => {
    expect(names(stepsFor([]))).toEqual(DEFAULT);
  });

  it("adds live and the soak only when asked, always ahead of the report", () => {
    const live = names(stepsFor(["--live"]));
    expect(live).toContain("eval:authority --live");
    expect(live.at(-1)).toBe("eval:report");
    expect(live).not.toContain("eval:soak");
    const soak = names(stepsFor(["--soak"]));
    expect(soak).toContain("eval:soak");
    expect(soak.at(-1)).toBe("eval:report");
    expect(soak).not.toContain("eval:authority --live");
  });

  it("refuses an option it doesn't know, rather than running two hours of the wrong thing", () => {
    expect(() => stepsFor(["--sok"])).toThrow(/unknown option --sok/);
  });

  it("names only scripts package.json has", () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(scripts["eval:all"]).toBe("tsx eval/all.ts");
    for (const step of stepsFor(["--live", "--soak"])) {
      expect(scripts[step.script], step.script).toBeDefined();
    }
  });

  const run = async (fails: string[] = []) => {
    const ran: string[] = [];
    const lines: string[] = [];
    const status = await runAll(
      stepsFor([]),
      async (step) => {
        ran.push(step.script);
        if (fails.includes(step.script)) return false;
        return true;
      },
      (line) => lines.push(line),
    );
    return { status, ran, output: lines.join("\n") };
  };

  it("runs one step at a time, in order, and exits 0 when all of them work", async () => {
    const { status, ran } = await run();
    expect(status).toBe(0);
    expect(ran).toEqual(DEFAULT);
  });

  it("after a failure runs the rest, so everything wrong shows at once, but not the report", async () => {
    const { status, ran, output } = await run(["eval:baseline"]);
    expect(status).toBe(1);
    expect(ran).toEqual(DEFAULT.filter((name) => name !== "eval:report"));
    expect(output).toContain("skipped eval:report: RESULTS.md was left as it was");
    expect(output).toContain("eval:all failed: eval:baseline");
  });

  it("counts a step that couldn't start as a failure", async () => {
    const status = await runAll(
      stepsFor([]).slice(0, 1),
      () => Promise.reject(new Error("no pnpm")),
      () => undefined,
    );
    expect(status).toBe(1);
  });

  it("fails if the report itself fails", async () => {
    const { status, output } = await run(["eval:report"]);
    expect(status).toBe(1);
    expect(output).toContain("eval:all failed: eval:report");
  });
});
