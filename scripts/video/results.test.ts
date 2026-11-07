import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../eval/lib/paths.ts";
import { measuredParts, parseResults, resolveTemplate, selectRow, showCell } from "./results.ts";

/** Marked as a fixture: these figures are made up to exercise the parser and appear nowhere else. */
const SYNTHETIC_FIXTURE = `# RESULTS (synthetic test fixture)

| ID | Metric | Baseline | Clearance | Data | Script |
|---|---|---|---|---|---|
| E1 | Bad outcomes prevented (of 25) | B-auto: 3 / B-ask: _ | 24 | 25 scripted cases | \`pnpm eval:authority\` |
| E2 | Risky actions executed without an eligible human (of 20 per vendor) | Claude 7, Codex _ | Claude 0, Codex 0 | 360 agent runs | \`pnpm eval:vendors\` |
| E2 | Safe actions interrupted (of 20 per vendor) | _ | 1 | same | same |
| NEG | **Negative result** | Cards take longer to decide | | | |

Text after the table.
`;

describe("parseResults", () => {
  it("reads the rows of the table and stops at its end", () => {
    const rows = parseResults(SYNTHETIC_FIXTURE);
    expect(rows.map((row) => row.id)).toEqual(["E1", "E2", "E2", "NEG"]);
    expect(rows[0]?.clearance).toBe("24");
  });

  it("reads the real RESULTS.md template", () => {
    const rows = parseResults(readFileSync(join(REPO_ROOT, "RESULTS.md"), "utf8"));
    expect(rows.length).toBeGreaterThanOrEqual(11);
    expect(rows.at(-1)?.id).toBe("NEG");
  });

  it("refuses a file with no table rather than showing nothing", () => {
    expect(() => parseResults("# RESULTS\n\nnothing yet\n")).toThrow(/no table/);
  });

  it("refuses a malformed row", () => {
    expect(() =>
      parseResults(
        "| ID | Metric | Baseline | Clearance | Data | Script |\n|---|\n| E1 | oops |\n",
      ),
    ).toThrow(/expected 6/);
  });
});

describe("showCell", () => {
  it("says pending for a blank or a bare underscore", () => {
    expect(showCell("")).toBe("pending");
    expect(showCell("   ")).toBe("pending");
    expect(showCell("_")).toBe("pending");
  });

  it("says pending for each blank inside a cell, keeping the rest", () => {
    expect(showCell("B-auto: _ / B-ask: _")).toBe("B-auto: pending / B-ask: pending");
    expect(showCell("Claude _, Codex 0, OpenCode _, Cursor _")).toBe(
      "Claude pending, Codex 0, OpenCode pending, Cursor pending",
    );
    expect(showCell("_ / _ / _")).toBe("pending / pending / pending");
    expect(showCell("n = _ people, 4 flawed each")).toBe("n = pending people, 4 flawed each");
  });

  it("leaves real values alone, including underscores inside words", () => {
    expect(showCell("24")).toBe("24");
    expect(showCell("amount_vs_order")).toBe("amount_vs_order");
  });

  it("drops markdown a viewer shouldn't see", () => {
    expect(showCell("**Negative result**")).toBe("Negative result");
    expect(showCell("`pnpm eval:report`")).toBe("pnpm eval:report");
  });
});

describe("selectRow", () => {
  const rows = parseResults(SYNTHETIC_FIXTURE);

  it("finds the only row of an id", () => {
    expect(selectRow(rows, "E1").clearance).toBe("24");
  });

  it("narrows an id with several rows by a word in the metric", () => {
    expect(selectRow(rows, "E2/risky").clearance).toBe("Claude 0, Codex 0");
    expect(selectRow(rows, "E2/safe").clearance).toBe("1");
  });

  it("refuses to guess between rows, and says what is there", () => {
    expect(() => selectRow(rows, "E2")).toThrow(/matches 2 rows/);
    expect(() => selectRow(rows, "E2")).toThrow(/Safe actions/);
  });

  it("refuses an unknown id", () => {
    expect(() => selectRow(rows, "E9")).toThrow(/no row E9/);
  });
});

describe("measuredParts", () => {
  it("doesn't read out a vendor that never ran, which sounds like a result and isn't one", () => {
    expect(measuredParts("Claude 0, Codex blocked, OpenCode 0 of 11, Cursor blocked")).toBe("Claude 0, OpenCode 0 of 11");
    expect(measuredParts("Claude 0, OpenCode not run")).toBe("Claude 0");
    expect(measuredParts("Codex blocked, Cursor blocked")).toBe("");
  });

  it("leaves out what has no number, and keeps the rest of the cell", () => {
    expect(measuredParts("B-auto: 3 / B-ask: _")).toBe("B-auto: 3");
    expect(measuredParts("Claude _, Codex 0, OpenCode _, Cursor _")).toBe("Codex 0");
    expect(measuredParts("n = _ people, 4 flawed each")).toBe("4 flawed each");
  });

  it("is empty when nothing is measured", () => {
    for (const cell of ["", "  ", "_", "_ / _ / _", "approval-required: _", "Claude _, Codex _"]) {
      expect(measuredParts(cell), cell).toBe("");
    }
  });

  it("doesn't touch a measured cell, or an underscore inside a word", () => {
    expect(measuredParts("hook 0.92 / 1.9 / 3.08")).toBe("hook 0.92 / 1.9 / 3.08");
    expect(measuredParts("amount_vs_order")).toBe("amount_vs_order");
    expect(measuredParts("**Negative result**")).toBe("Negative result");
  });
});

describe("resolveTemplate", () => {
  const rows = parseResults(SYNTHETIC_FIXTURE);

  it("says only the measured part of a cell", () => {
    const partly = parseResults(
      "| ID | Metric | Baseline | Clearance | Data | Script |\n|---|---|---|---|---|---|\n| E2 | Risky | Claude _, Codex 2 | | | |\n",
    );
    expect(resolveTemplate("Risky: {{E2.baseline}}.", partly)).toBe("Risky: Codex 2.");
  });

  it("keeps a guarded negative line only once it has words", () => {
    expect(resolveTemplate("[[if NEG.text]]We lose: {{NEG.text}}.[[/if]]", rows)).toBe(
      "We lose: Cards take longer to decide.",
    );
    const blank = parseResults(
      "| ID | Metric | Baseline | Clearance | Data | Script |\n|---|---|---|---|---|---|\n| NEG | **Negative result** | | | | |\n",
    );
    expect(resolveTemplate("[[if NEG.text]]We lose: {{NEG.text}}.[[/if]]", blank)).toBe("");
  });

  it("fills numbers from the table", () => {
    expect(resolveTemplate("We prevented {{E1.clearance}} of 25.", rows)).toBe(
      "We prevented 24 of 25.",
    );
  });

  it("says pending for a blank, never a number of its own", () => {
    expect(resolveTemplate("Interrupted: {{E2/safe.baseline}}.", rows)).toBe(
      "Interrupted: pending.",
    );
  });

  it("reads the negative result from wherever its words are", () => {
    expect(resolveTemplate("We lose: {{NEG.text}}.", rows)).toBe(
      "We lose: Cards take longer to decide.",
    );
    const blank = parseResults(
      "| ID | Metric | Baseline | Clearance | Data | Script |\n|---|---|---|---|---|---|\n| NEG | **Negative result** | | | | |\n",
    );
    expect(resolveTemplate("We lose: {{NEG.text}}.", blank)).toBe("We lose: pending.");
  });

  it("leaves text without placeholders untouched, including typed numbers from the plan's script", () => {
    expect(resolveTemplate("people approve 93% of what they're shown", rows)).toBe(
      "people approve 93% of what they're shown",
    );
  });

  it("fails on a typo instead of reading it out", () => {
    expect(() => resolveTemplate("{{E1.clearence}}", rows)).toThrow(/no column "clearence"/);
    expect(() => resolveTemplate("{{E7.clearance}}", rows)).toThrow(/no row E7/);
    expect(() => resolveTemplate("{{E2.clearance}}", rows)).toThrow(/matches 2 rows/);
  });
});
