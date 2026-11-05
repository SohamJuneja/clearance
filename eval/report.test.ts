import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseResults, selectRow, showCell } from "../scripts/video/results.ts";
import { REPO_ROOT } from "./lib/paths.ts";
import { injectIntoReadme, loadInputs, renderResults, renderTable, writeReport } from "./report.ts";

/**
 * SYNTHETIC FIXTURES. These numbers are made up to exercise the report and exist only in this test's
 * temp directory. `fixture: true` makes the report refuse them for the real RESULTS.md.
 */
const fixtures = {
  "e1.json": {
    experiment: "E1",
    fixture: true,
    synthetic: true,
    b_auto: { prevented: 3, total: 25 },
    b_ask: { prevented: 9, total: 25 },
    clearance: { prevented: 24, total: 25 },
    cases: 25,
  },
  "e2.json": {
    experiment: "E2",
    fixture: true,
    synthetic: true,
    risky_unapproved: {
      baseline: { claude: 7, codex: 5, opencode: 20, cursor: 2 },
      clearance: { claude: 0, codex: 0, opencode: 0, cursor: 1 },
    },
    safe_interrupted: {
      baseline: { claude: 1, codex: 2, opencode: 0, cursor: 20 },
      clearance: { claude: 0, codex: 1, opencode: 0, cursor: 0 },
    },
    runs: 360,
  },
  "e4-latency.json": {
    experiment: "E4-latency",
    fixture: true,
    synthetic: true,
    hook: { p50: 2, p95: 5.5, p99: 9 },
    gate: { p50: 4, p95: 8, p99: 15 },
    calls_each: 1000,
  },
  "neg.json": {
    experiment: "NEG",
    fixture: true,
    synthetic: true,
    text: "Clearance cards take longer to decide",
    source: "E5",
  },
};

describe("eval:report", () => {
  let dir: string;
  let outDir: string;
  let resultsPath: string;
  let readmePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "report-"));
    outDir = join(dir, "out");
    mkdirSync(outDir);
    resultsPath = join(dir, "RESULTS.md");
    readmePath = join(dir, "README.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (files: Record<string, unknown>): void => {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(outDir, name), JSON.stringify(content));
    }
  };
  const report = () => writeReport({ outDir, resultsPath, readmePath });

  describe("with no results", () => {
    it("reproduces the template in PLAN 10.8 exactly", () => {
      const plan = readFileSync(join(REPO_ROOT, "PLAN.md"), "utf8");
      const section = plan.slice(
        plan.indexOf("### 10.8"),
        plan.indexOf("**Negative result to look for"),
      );
      const table = section.split("\n").filter((line) => line.startsWith("|"));
      expect(renderTable({}).split("\n")).toEqual(table);
    });

    it("keeps the preamble RESULTS.md opens with", () => {
      expect(renderResults({}).split("\n")[0]).toBe("# RESULTS");
      expect(renderResults({})).toContain("Never edit numbers by hand");
    });

    it("writes the template when eval/out doesn't exist yet", () => {
      rmSync(outDir, { recursive: true });
      report();
      expect(readFileSync(resultsPath, "utf8")).toBe(renderResults({}));
    });
  });

  describe("with results", () => {
    it("fills what exists and leaves _ for the rest", () => {
      write({ "e1.json": fixtures["e1.json"] });
      report();
      const rows = parseResults(readFileSync(resultsPath, "utf8"));
      expect(selectRow(rows, "E1").baseline).toBe("B-auto: 3 / B-ask: 9");
      expect(selectRow(rows, "E1").clearance).toBe("24");
      expect(selectRow(rows, "E2/risky").clearance).toBe("Claude _, Codex _, OpenCode _, Cursor _");
      expect(selectRow(rows, "E5/catch").clearance).toBe("Clearance card: _");
    });

    it("labels synthetic data in its Data cell", () => {
      write({ "e1.json": fixtures["e1.json"] });
      report();
      const rows = parseResults(readFileSync(resultsPath, "utf8"));
      expect(selectRow(rows, "E1").data).toBe("25 scripted cases (synthetic)");
    });

    it("fills per-vendor numbers, and blanks a vendor that has none", () => {
      write({
        "e2.json": {
          experiment: "E2",
          fixture: true,
          risky_unapproved: { baseline: { claude: 7 }, clearance: { claude: 0, cursor: 1 } },
        },
      });
      report();
      const rows = parseResults(readFileSync(resultsPath, "utf8"));
      expect(selectRow(rows, "E2/risky").baseline).toBe("Claude 7, Codex _, OpenCode _, Cursor _");
      expect(selectRow(rows, "E2/risky").clearance).toBe("Claude 0, Codex _, OpenCode _, Cursor 1");
    });

    it("shows hook and gate latency separately, and the real call count", () => {
      write({ "e4-latency.json": fixtures["e4-latency.json"] });
      report();
      const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "E4/latency");
      expect(row.clearance).toBe("hook 2 / 5.5 / 9, gate 4 / 8 / 15");
      expect(row.data).toBe("1,000 calls each (synthetic)");
    });

    it("keeps a zero as a zero, because no violations is a real result and not a blank", () => {
      write({
        "soak.json": {
          experiment: "E4-soak",
          fixture: true,
          violations: 0,
          calls: 5000,
          hours: 2,
          restarts: 3,
        },
      });
      report();
      const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "E4/soak");
      expect(row.clearance).toBe("0");
      expect(showCell(row.clearance)).toBe("0");
      expect(row.data).toBe("2 h, 5,000 calls, 3 restarts");
    });

    it("writes rates as percentages", () => {
      write({
        "e5.json": {
          experiment: "E5",
          fixture: true,
          catch_rate: { switch_card: 0.5, clearance_card: 0.875 },
          median_seconds: { clearance_card: { legit: 9.2, flawed: 14 } },
          people: 12,
        },
      });
      report();
      const rows = parseResults(readFileSync(resultsPath, "utf8"));
      expect(selectRow(rows, "E5/catch").baseline).toBe("Switch card: 50%");
      expect(selectRow(rows, "E5/catch").clearance).toBe("Clearance card: 87.5%");
      expect(selectRow(rows, "E5/catch").data).toBe("n = 12 people, 4 flawed each");
      expect(selectRow(rows, "E5/median").baseline).toBe("_ / _");
      expect(selectRow(rows, "E5/median").clearance).toBe("9.2 / 14");
    });

    it("carries the negative result's words to where the video reads them", () => {
      write({ "neg.json": fixtures["neg.json"] });
      report();
      const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "NEG");
      expect(row.clearance).toBe("Clearance cards take longer to decide");
    });

    it("keeps the table parseable with a pipe in the negative result", () => {
      const rows = parseResults(renderTable({ NEG: { experiment: "NEG", text: "a | b" } }));
      expect(selectRow(rows, "NEG").clearance).toBe("a | b");
    });

    it("produces every row the template has, whatever is filled in", () => {
      write(fixtures);
      report();
      const filled = parseResults(readFileSync(resultsPath, "utf8"));
      const template = parseResults(renderResults({}));
      expect(filled.map((row) => row.id)).toEqual(template.map((row) => row.id));
    });
  });

  describe("bad inputs", () => {
    it("stops on a known experiment with the wrong shape, naming the file, and writes nothing", () => {
      write({ "e1.json": { experiment: "E1", clearance: { prevented: "most", total: 25 } } });
      expect(() => report()).toThrow(/e1\.json has the wrong shape for E1: clearance\.prevented/);
      expect(() => readFileSync(resultsPath)).toThrow();
    });

    it("stops on a file that isn't JSON", () => {
      writeFileSync(join(outDir, "broken.json"), "{ not json");
      expect(() => report()).toThrow(/broken\.json is not JSON/);
    });

    it("stops on two files for one experiment rather than picking one", () => {
      write({
        "a.json": { experiment: "NEG", text: "one" },
        "b.json": { experiment: "NEG", text: "two" },
      });
      expect(() => report()).toThrow(/two result files for NEG/);
    });

    it("names a file it can't place instead of dropping it silently", () => {
      write({ "mystery.json": { foo: 1 } });
      const lines: string[] = [];
      writeReport({ outDir, resultsPath, readmePath, print: (line) => lines.push(line) });
      expect(lines.join("\n")).toContain("ignored mystery.json");
    });

    it("doesn't read subdirectories, which hold the demo runner's and the scan's output", () => {
      mkdirSync(join(outDir, "demo"));
      writeFileSync(join(outDir, "demo", "SC3.json"), "{ not json");
      expect(() => report()).not.toThrow();
      expect(loadInputs(outDir).files).toEqual([]);
    });
  });

  describe("the real RESULTS.md", () => {
    it("refuses fixture data for it, and leaves it untouched", () => {
      write({ "e1.json": fixtures["e1.json"] });
      const realPath = join(REPO_ROOT, "RESULTS.md");
      const before = readFileSync(realPath, "utf8");
      expect(() => writeReport({ outDir, resultsPath: realPath, readmePath })).toThrow(
        /holds fixture data/,
      );
      expect(readFileSync(realPath, "utf8")).toBe(before);
    });
  });

  describe("the README table", () => {
    const readme = "intro\n\n<!-- results:start -->\nold table\n<!-- results:end -->\n\noutro\n";

    it("replaces only what's between the markers", () => {
      writeFileSync(readmePath, readme);
      write({ "e1.json": fixtures["e1.json"] });
      expect(report().readmeUpdated).toBe(true);
      const after = readFileSync(readmePath, "utf8");
      expect(after.startsWith("intro\n\n<!-- results:start -->\n| ID | Metric |")).toBe(true);
      expect(after.endsWith("<!-- results:end -->\n\noutro\n")).toBe(true);
      expect(after).not.toContain("old table");
      expect(after).toContain("B-auto: 3 / B-ask: 9");
    });

    it("gives the same result if run twice", () => {
      writeFileSync(readmePath, readme);
      report();
      const once = readFileSync(readmePath, "utf8");
      report();
      expect(readFileSync(readmePath, "utf8")).toBe(once);
    });

    it("leaves a README with no markers alone", () => {
      writeFileSync(readmePath, "no markers here\n");
      expect(report().readmeUpdated).toBe(false);
      expect(readFileSync(readmePath, "utf8")).toBe("no markers here\n");
    });

    it("is fine with no README at all", () => {
      expect(report().readmeUpdated).toBe(false);
    });

    it("refuses a broken block rather than guessing", () => {
      expect(() => injectIntoReadme("<!-- results:end --> x <!-- results:start -->", "t")).toThrow(
        /broken/,
      );
      expect(() => injectIntoReadme("<!-- results:start --> only", "t")).toThrow(/broken/);
    });
  });
});
