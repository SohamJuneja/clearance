import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseResults, selectRow, showCell } from "../scripts/video/results.ts";
import { REPO_ROOT } from "./lib/paths.ts";
import {
  injectIntoReadme,
  loadInputs,
  negativeResults,
  renderResults,
  withoutBlankRows,
  renderTable,
  writeReport,
} from "./report.ts";

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
    it("shows E6 under the rule in force and says what the original rule gave, because the rule changed after a first result", () => {
      const table = renderTable({
        E6: {
          experiment: "E6",
          synthetic: true,
          human_decisions_per_100: { before: 100, after: 21.5 },
          original_rule: { human_decisions_per_100: { after: 79.2 } },
        },
      });
      const row = table.split("\n").find((line) => line.startsWith("| E6 "));
      expect(row).toContain("21.5 (after promotion)");
      expect(row).toContain("the anomaly rule was changed after seeing the first result");
      expect(row).toContain("79.2");
    });

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
      expect(selectRow(rows, "E1").data).toBe(
        "25 scripted cases; a managed agent in a private chat isn't covered by these 25 (synthetic)",
      );
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

  describe("what E1's count doesn't cover", () => {
    const authority = {
      experiment: "E1",
      fixture: true,
      b_auto: { prevented: 1, total: 25 },
      b_ask: { prevented: 2, total: 25 },
      clearance: { prevented: 25, total: 25 },
      cases: 25,
    };
    const live = (outcome: string) => ({
      "authority-live.json": {
        experiment: "E1-live",
        fixture: true,
        results: [
          { id: 1, outcome: "prevented", why: "her press was refused" },
          { id: "1-private-chat", outcome, why: "the agent heard it" },
        ],
      },
    });
    const e1Row = () => selectRow(parseResults(readFileSync(resultsPath, "utf8")), "E1");

    it("says so in the Data cell before --live has run, and leaves the count alone", () => {
      write({ "authority.json": authority });
      report();
      expect(e1Row().data).toContain("a managed agent in a private chat isn't covered by these 25");
      expect(e1Row().clearance).toBe("25");
      expect(e1Row().metric).toBe("Bad outcomes prevented (of 25)");
    });

    it("says so even with no E1 result at all, since the template is what the table starts from", () => {
      expect(selectRow(parseResults(renderTable({})), "E1").data).toContain(
        "isn't covered by these 25",
      );
    });

    it.each(["blocked", "not prevented"])(
      "still says so when the live check came back %s",
      (outcome) => {
        write({ "authority.json": authority, ...live(outcome) });
        report();
        expect(e1Row().data).toContain("isn't covered by these 25");
        expect(e1Row().clearance).toBe("25");
      },
    );

    it("says it was checked once the live check passes, and the count still doesn't move", () => {
      write({ "authority.json": authority, ...live("prevented") });
      report();
      expect(e1Row().data).toContain("private-chat path checked live");
      expect(e1Row().data).not.toContain("isn't covered");
      expect(e1Row().clearance).toBe("25");
    });

    it("doesn't take another live case passing for the private-chat check", () => {
      write({
        "authority.json": authority,
        "authority-live.json": {
          experiment: "E1-live",
          fixture: true,
          results: [{ id: 1, outcome: "prevented", why: "her press was refused" }],
        },
      });
      report();
      expect(e1Row().data).toContain("isn't covered by these 25");
    });

    it("puts a failed live check first among the negative results", () => {
      write({ "authority.json": authority, ...live("not prevented") });
      report();
      const written = readFileSync(resultsPath, "utf8");
      expect(selectRow(parseResults(written), "NEG").clearance).toContain(
        "live check of a managed agent in a private chat failed: the agent heard it",
      );
    });

    it("reads an older live file with only numbered cases", () => {
      write({
        "authority-live.json": {
          experiment: "E1-live",
          fixture: true,
          results: [{ id: 22, outcome: "blocked", why: "no key" }],
        },
      });
      expect(() => report()).not.toThrow();
    });
  });

  describe("the rows added for the audit, the baseline, behaviour and quiet share", () => {
    const authority = {
      experiment: "E1",
      fixture: true,
      b_auto: { prevented: 1, total: 25 },
      b_ask: { prevented: 2, total: 25 },
      clearance: { prevented: 3, total: 25 },
      cases: 25,
      audit: { passed: 4, total: 5, found_by: "a review", per_check: [] },
    };

    it("adds a second review to the audit's line, and to the negative results, without touching E1's count", () => {
      write({ "authority.json": { ...authority, audit: { passed: 5, total: 5 }, second_review: { passed: 28, total: 28 } } });
      report();
      const text = readFileSync(resultsPath, "utf8");
      const rows = parseResults(text);
      expect(selectRow(rows, "E1").clearance).toBe("3");
      expect(selectRow(rows, "AUDIT").clearance).toBe("Audit: 5 of 5; second review: 28 of 28");
      expect(text).toContain("reproduced 28 more breaks");
    });

    it("adds a fourth review the same way", () => {
      write({
        "authority.json": {
          ...authority,
          audit: { passed: 5, total: 5 },
          second_review: { passed: 28, total: 28 },
          third_review: { passed: 19, total: 19 },
          fourth_review: { passed: 23, total: 23 },
        },
      });
      report();
      const text = readFileSync(resultsPath, "utf8");
      expect(selectRow(parseResults(text), "AUDIT").clearance).toBe("Audit: 5 of 5; second review: 28 of 28; third review: 19 of 19; fourth review: 23 of 23");
      expect(text).toContain("A fourth independent review reproduced 23 more");
    });

    it("adds a third review the same way", () => {
      write({
        "authority.json": {
          ...authority,
          audit: { passed: 5, total: 5 },
          second_review: { passed: 28, total: 28 },
          third_review: { passed: 19, total: 19 },
        },
      });
      report();
      const text = readFileSync(resultsPath, "utf8");
      expect(selectRow(parseResults(text), "AUDIT").clearance).toBe("Audit: 5 of 5; second review: 28 of 28; third review: 19 of 19");
      expect(text).toContain("reproduced 19 more");
    });

    it("keeps the audit on its own line: it never changes E1's count", () => {
      write({ "authority.json": authority });
      report();
      const rows = parseResults(readFileSync(resultsPath, "utf8"));
      expect(selectRow(rows, "E1").clearance).toBe("3");
      expect(selectRow(rows, "E1").metric).toContain("of 25");
      expect(selectRow(rows, "AUDIT").clearance).toBe("Audit: 4 of 5");
      expect(selectRow(rows, "AUDIT").metric).toContain("independent review");
    });

    it("shows the quiet share as a percentage for both sides", () => {
      write({
        "e3.json": {
          experiment: "E3",
          fixture: true,
          no_card_share: { approval_required: 0.2, clearance: 0.955 },
        },
      });
      report();
      const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "E3/quiet");
      expect(row.baseline).toBe("approval-required: 20%");
      expect(row.clearance).toBe("95.5%");
      expect(row.data).toBe("same");
    });

    it("reports behaviour after a hold as an E2 metric, per vendor", () => {
      write({
        "behaviour.json": {
          experiment: "E2-behaviour",
          fixture: true,
          holds: 7,
          tried_another_route: 1,
          by_vendor: { claude: { holds: 4 }, opencode: { holds: 3 } },
        },
      });
      report();
      const rows = parseResults(readFileSync(resultsPath, "utf8"));
      const row = selectRow(rows, "E2/route");
      expect(row.clearance).toBe("1 of 7 holds");
      expect(row.data).toContain("Claude 4, OpenCode 3");
      expect(selectRow(rows, "E2/risky").clearance).toContain("Claude _");
    });

    const baseline = {
      experiment: "BL",
      fixture: true,
      recorded_runs: 11,
      models: ["claude-test-1"],
      summary: {
        full_refund: { auto: { paid: 2, runs: 5 }, ask: { paid: 1, runs: 2 } },
        classifier_refusals: 3,
        t77: { amount_asked: 40000, attempted: 1, runs: 8 },
      },
    };

    it("puts the real baseline runs in their row, with the model the transcripts name", () => {
      write({ "baseline.json": baseline });
      report();
      const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "BL");
      expect(row.baseline).toBe("auto mode: 2 of 5 / approvals on: 1 of 2");
      expect(row.data).toBe("11 recorded runs on claude-test-1, classifier refused 3");
      expect(row.script).toBe("`pnpm eval:baseline`");
    });

    it("says in the Data cell that the setup changed, and names what was left out and why", () => {
      write({
        "baseline.json": {
          ...baseline,
          setups: [
            { what: "outside the fence", runs: 8 },
            { what: "in the fence, on camera", runs: 3 },
          ],
          left_out: [{ scenario: "SC2", take: 1, reason: "the recorder failed: no websocket" }],
        },
      });
      report();
      const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "BL");
      expect(row.data).toBe(
        "11 recorded runs on claude-test-1, classifier refused 3; the setup changed: 8 outside the fence, 3 in the fence, on camera; left out: SC2 take 1 (the recorder failed: no websocket)",
      );
    });

    it("has nothing to say about setups when every run had the same one", () => {
      write({ "baseline.json": { ...baseline, setups: [{ what: "outside the fence", runs: 11 }] } });
      report();
      const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "BL");
      expect(row.data).toBe("11 recorded runs on claude-test-1, classifier refused 3");
    });

    it("leaves mutation output out of the table and says why", () => {
      write({ "authority-mutations.json": { experiment: "E1-mutations", results: [] } });
      const lines: string[] = [];
      writeReport({ outDir, resultsPath, readmePath, print: (line) => lines.push(line) });
      expect(lines.join("\n")).toContain("left out authority-mutations.json");
    });

    describe("the negative results", () => {
      const e6 = {
        experiment: "E6" as const,
        human_decisions_per_100: { before: 90, after: 20 },
        original_rule: { human_decisions_per_100: { after: 70 } },
      };
      const inputs = () =>
        loadInputsFrom({ "baseline.json": baseline, "authority.json": authority });
      const loadInputsFrom = (files: Record<string, unknown>) => {
        write(files);
        return loadInputs(outDir).inputs;
      };

      it("with no data, only says E5's expected negative is pending, and the NEG row stays empty", () => {
        const list = negativeResults({});
        expect(list.map((one) => one.id)).toEqual(["E5"]);
        expect(list[0]?.pending).toBe(true);
        expect(renderResults({})).toContain("**Pending.** Expected: Clearance cards take longer");
        expect(selectRow(parseResults(renderTable({})), "NEG").clearance).toBe("");
      });

      it("takes every number from the result files", () => {
        const list = negativeResults({ ...inputs(), E6: e6 });
        const text = (id: string) => list.find((one) => one.id === id)?.text ?? "";
        expect(text("headline-scenario")).toContain("₹40,000 in 1 of 8 runs");
        expect(text("classifier")).toContain("3 times in the baseline");
        expect(text("classifier")).toContain("2 of 5 runs");
        expect(text("autonomy-rule")).toContain("gave 70 human decisions");
        expect(text("autonomy-rule")).toContain("against 90");
        expect(text("autonomy-rule")).toContain("gives 20");
        expect(text("audit")).toContain("independent review found 5 real breaks");
        expect(text("audit")).toContain("not that the list is complete");
      });

      it("puts a case Clearance really fails first, and in the NEG row, for as long as it's true", () => {
        const failing = {
          ...authority,
          per_case: [
            {
              id: 1,
              title: "Requester approves",
              clearance: { outcome: "not prevented", why: "bad outcome: it ran" },
            },
            { id: 2, title: "Owner approves", clearance: { outcome: "prevented", why: "ok" } },
          ],
        };
        write({ "authority.json": failing, "baseline.json": baseline });
        report();
        const written = readFileSync(resultsPath, "utf8");
        expect(selectRow(parseResults(written), "NEG").clearance).toBe(
          "case 1 of E1 is not prevented: it ran",
        );
        expect(written).toContain('E1 case 1, "Requester approves", is not prevented: it ran.');
        expect(written).not.toContain("E1 case 2");
      });

      it("keeps E5's negative pending until both cards have data, then reports it either way", () => {
        const partial = negativeResults({
          E5: {
            experiment: "E5",
            median_seconds: { clearance_card: { legit: 9, flawed: 14 } },
          },
        });
        expect(partial.at(-1)?.pending).toBe(true);
        const measured = (legit: number) =>
          negativeResults({
            E5: {
              experiment: "E5",
              median_seconds: {
                switch_card: { legit: 5, flawed: 6 },
                clearance_card: { legit, flawed: 5 },
              },
            },
          }).at(-1);
        expect(measured(9)?.pending).toBeUndefined();
        expect(measured(9)?.short).toContain(
          "Clearance cards take longer to decide: 9 s against 5 s",
        );
        expect(measured(4)?.short).toContain("didn't show");
      });

      it("puts the first with data in the NEG row, where the video reads it", () => {
        write({ "baseline.json": baseline });
        report();
        const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "NEG");
        expect(row.clearance).toContain("the agent attempted T-77's ₹40,000 in 1 of 8 runs");
        expect(row.data).toBe("`pnpm eval:baseline`");
      });

      it("lets a result file name the negative, ahead of any computed one", () => {
        write({ "baseline.json": baseline, "neg.json": fixtures["neg.json"] });
        report();
        const written = readFileSync(resultsPath, "utf8");
        const row = selectRow(parseResults(written), "NEG");
        expect(row.clearance).toBe("Clearance cards take longer to decide");
        expect(written).toContain("## Negative results");
        expect(written).toContain("attempted T-77's ₹40,000");
      });

      it("doesn't let the list under the table break the table's parser", () => {
        write({ "baseline.json": baseline });
        report();
        const rows = parseResults(readFileSync(resultsPath, "utf8"));
        expect(rows.at(-1)?.id).toBe("NEG");
      });
    });
  });

  describe("the experiments' real output shapes", () => {
    it("says when E1's baselines were read from code", () => {
      write({
        "authority.json": {
          experiment: "E1",
          fixture: true,
          b_auto: { prevented: 1, total: 25 },
          b_ask: { prevented: 2, total: 25 },
          clearance: { prevented: 3, total: 25 },
          cases: 25,
          baseline_basis: "read from Switch's code",
        },
      });
      report();
      const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "E1");
      expect(row.data).toBe(
        "25 scripted cases; baselines read from code, not run; a managed agent in a private chat isn't covered by these 25",
      );
    });

    it("shows a blocked vendor as blocked, never as a zero, and names Claude's model", () => {
      write({
        "vendors.json": {
          experiment: "E2",
          fixture: true,
          risky_unapproved: {
            baseline: { claude: "not run", codex: "blocked" },
            clearance: { claude: 0, codex: "blocked", opencode: "5 of 12", cursor: "blocked" },
          },
          safe_interrupted: {
            baseline: { claude: "not run" },
            clearance: { claude: 1 },
          },
          runs: 0,
          claude_model: "haiku",
        },
      });
      report();
      const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "E2/risky");
      expect(row.clearance).toBe("Claude 0, Codex blocked, OpenCode 5 of 12, Cursor blocked");
      expect(row.baseline).toBe("Claude not run, Codex blocked, OpenCode _, Cursor _");
      expect(row.data).toBe("0 agent runs, Claude on haiku");
    });

    it("reports the Codex hook process apart from the routes", () => {
      write({
        "e4-latency.json": {
          experiment: "E4-latency",
          fixture: true,
          hook: { p50: 1, p95: 2, p99: 3 },
          gate: { p50: 4, p95: 5, p99: 6 },
          codex_cli: { direct_node: { p50: 70, p95: 80, p99: 90 }, calls: 100 },
          calls_each: 1000,
        },
      });
      report();
      const row = selectRow(parseResults(readFileSync(resultsPath, "utf8")), "E4/latency");
      expect(row.clearance).toBe("hook 1 / 2 / 3, gate 4 / 5 / 6, Codex hook process 70 / 80 / 90");
      expect(row.data).toBe("1,000 calls each; Codex hook 100 runs, each a new process");
    });

    describe("says how each number was measured", () => {
      const FAKE = "Synthetic driver on isolated processes with a fake ChatPort. No agent is involved.";
      const data = (select: string) =>
        selectRow(parseResults(readFileSync(resultsPath, "utf8")), select).data;

      it("says E1 ran on a fake chat port, and how much of the baselines' misses is no such control", () => {
        const outcome = (value: string) => ({ outcome: value });
        const shared = (id: number) => ({
          id,
          title: `case ${id}`,
          clearance: { outcome: "prevented", why: "ok" },
        });
        write({
          "e1.json": {
            experiment: "E1",
            clearance: { prevented: 25, total: 25 },
            b_auto: { prevented: 0, total: 25 },
            b_ask: { prevented: 9, total: 25 },
            cases: 25,
            baseline_basis: "read from Switch's code",
            mode: "isolated processes, fake ChatPort",
            per_case: [
              { ...shared(1), b_auto: outcome("no such control"), b_ask: outcome("no such control") },
              { ...shared(2), b_auto: outcome("no such control"), b_ask: outcome("prevented") },
              { ...shared(3), b_auto: outcome("not prevented"), b_ask: outcome("not prevented") },
            ],
          },
        });
        report();
        expect(data("E1")).toContain("25 scripted cases on a fake chat port;");
        expect(data("E1")).toContain(
          "a baseline with no such control counts as not prevented: B-auto 2, B-ask 1",
        );
      });

      it("says the soak has a synthetic driver and no agents", () => {
        write({
          "e4-soak.json": {
            experiment: "E4-soak",
            violations: 0,
            calls: 7200,
            hours: 2,
            restarts: 3,
            note: FAKE,
          },
        });
        report();
        expect(data("E4/soak")).toBe(
          "2 h, 7,200 calls, 3 restarts; synthetic driver on a fake chat port, no agents",
        );
      });

      it("says latency was measured on a fake chat port", () => {
        write({
          "e4-latency.json": {
            experiment: "E4-latency",
            hook: { p50: 1, p95: 2, p99: 3 },
            gate: { p50: 1, p95: 2, p99: 3 },
            calls_each: 1000,
            note: FAKE,
          },
        });
        report();
        expect(data("E4/latency")).toContain("on a fake chat port");
      });

      it("never prints a run count for an E2 that hasn't run", () => {
        report();
        expect(data("E2/risky")).toBe("not run yet");
      });

      it("says the agents in the behaviour row were told not to go around a hold", () => {
        write({
          "behaviour.json": {
            experiment: "E2-behaviour",
            holds: 14,
            tried_another_route: 0,
            by_vendor: {
              claude: { holds: 9, tried_another_route: 0 },
              opencode: { holds: 5, tried_another_route: 0 },
            },
          },
        });
        report();
        expect(data("E2/route")).toContain("which tells them not to");
      });
    });

    it("says Priya answers once, and publishes what happened when nobody did", () => {
      write({
        "vendors.json": { experiment: "E2", runs: 200, claude_model: "haiku", priya_answers_once: true },
        "e2-first-attempt.json": {
          experiment: "E2-first-attempt",
          per_run: [
            { condition: "B-auto", kind: "risky", observation: { effectHappened: false } },
            { condition: "B-auto", kind: "risky", observation: { effectHappened: false } },
            { condition: "B-auto", kind: "safe", observation: { effectHappened: true } },
            { condition: "G-shadow", kind: "risky", observation: { effectHappened: true } },
          ],
        },
      });
      report();
      const results = readFileSync(resultsPath, "utf8");
      expect(selectRow(parseResults(results), "E2/risky").data).toContain(
        "Priya answers once if the agent asks",
      );
      expect(results).toContain("moved nothing in 2 risky runs");
      expect(results).toContain("We changed that after seeing the result");
    });

    it("never takes E2's probe for E2", () => {
      write({ "vendors-probe.json": { experiment: "E2-probe", runs: 6, per_run: [] } });
      const lines: string[] = [];
      writeReport({ outDir, resultsPath, readmePath, print: (line) => lines.push(line) });
      expect(selectRow(parseResults(readFileSync(resultsPath, "utf8")), "E2/risky").data).toBe(
        "not run yet",
      );
      expect(lines.join("\n")).toContain("left out vendors-probe.json");
    });

    it("never takes a smoke test for the soak's result", () => {
      write({
        "e4-soak-smoke.json": {
          experiment: "E4-soak-smoke",
          smoke_test: true,
          violations: 0,
          calls: 300,
        },
      });
      const lines: string[] = [];
      writeReport({ outDir, resultsPath, readmePath, print: (line) => lines.push(line) });
      expect(selectRow(parseResults(readFileSync(resultsPath, "utf8")), "E4/soak").clearance).toBe(
        "_",
      );
      expect(lines.join("\n")).toContain("left out e4-soak-smoke.json");
    });

    it("refuses a soak result that says it's a smoke test", () => {
      write({ "e4-soak.json": { experiment: "E4-soak", smoke_test: true, violations: 0 } });
      expect(() => report()).toThrow(/wrong shape for E4-soak/);
    });

    it("reads the study's real output into E5, with A as Switch's card and B as Clearance's", () => {
      write({
        "study.json": {
          experiment: "E5 human study",
          synthetic: false,
          headline: {
            n: 3,
            catch_rate: { A: 0.5, B: 0.75 },
            false_deny_rate: { A: 0, B: 0 },
            median_s_legit: { A: 4, B: 9 },
            median_s_flawed: { A: 5, B: 12 },
          },
        },
      });
      report();
      const rows = parseResults(readFileSync(resultsPath, "utf8"));
      expect(selectRow(rows, "E5/catch").baseline).toBe("Switch card: 50%");
      expect(selectRow(rows, "E5/catch").clearance).toBe("Clearance card: 75%");
      expect(selectRow(rows, "E5/catch").data).toBe("n = 3 people, 4 flawed each");
      expect(selectRow(rows, "E5/median").clearance).toBe("9 / 12");
    });

    it("gives E5 no number from a study with no headline, which is what synthetic data has", () => {
      write({ "study.json": { experiment: "E5 human study", synthetic: true, headline: null } });
      report();
      const rows = parseResults(readFileSync(resultsPath, "utf8"));
      expect(selectRow(rows, "E5/catch").clearance).toBe("Clearance card: _");
      expect(selectRow(rows, "E5/median").baseline).toBe("_ / _");
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

    it("leaves out what has no number yet and says which, while RESULTS.md keeps the blanks", () => {
      writeFileSync(readmePath, "<!-- results:start -->\n<!-- results:end -->\n");
      write({
        "e4-soak.json": { experiment: "E4-soak", violations: 0, calls: 7200, hours: 2, restarts: 3 },
      });
      report();
      const readme = readFileSync(readmePath, "utf8");
      expect(readme).toContain("| E4 | Soak invariant violations |");
      expect(readme).not.toMatch(/(^|[\s|])_([\s,|]|$)/m);
      expect(readme).toContain("Not measured yet, so not shown:");
      for (const id of ["E2", "E3", "E5"]) expect(readme).toMatch(new RegExp(`shown:.*${id}`));
      expect(readFileSync(resultsPath, "utf8")).toContain("Claude _, Codex _, OpenCode _, Cursor _");
    });

    it("keeps a partly filled row, and says which part hasn't run", () => {
      const table = withoutBlankRows(
        [
          "| ID | Metric | Baseline | Clearance | Data | Script |",
          "|---|---|---|---|---|---|",
          "| E2 | Risky | Claude 0, Codex _ | Claude 0, Codex _ | 40 runs | `x` |",
          "| E5 | Catch | Switch card: _ | Clearance card: _ | n = _ | `y` |",
          "| BL | Real runs | auto mode: _ | n/a | none | `z` |",
        ].join("\n"),
      );
      expect(table).toContain("| E2 | Risky | Claude 0, Codex not run | Claude 0, Codex not run | 40 runs |");
      expect(table).not.toContain("| E5 |");
      expect(table).not.toContain("| BL |");
      expect(table).toContain("Not measured yet, so not shown: E5, BL.");
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
