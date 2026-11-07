import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fill, readTable, recordRows, tokens } from "./build.ts";

const TABLE = `intro
<!-- results:start -->
| ID | Metric | Baseline | Clearance | Data | Script |
|---|---|---|---|---|---|
| E1 | Bad outcomes prevented (of 25) | B-auto: 0 / B-ask: 9 | 25 | 25 scripted cases; more in RESULTS.md | \`pnpm eval:authority\` |
| E2 | Risky actions executed without an eligible human (of 20 per vendor) | Claude 5, OpenCode 13 of 18 | Claude 0, OpenCode 0 of 11 | 200 agent runs | \`pnpm eval:vendors\` |
| E4 | Soak invariant violations | n/a | 0 | 2 h, 7,200 calls | \`pnpm eval:soak\` |
| NEG | **Negative result** | | Clearance cost <harmless> work | \`pnpm eval:vendors:rescore\` | |

Not measured yet, so not shown: E3, E5.
<!-- results:end -->
`;

describe("the site's numbers", () => {
  it("come from the generated table, each one read where it stands", () => {
    const values = tokens(TABLE, "https://example.test/repo", "<video></video>");
    expect(values).toMatchObject({
      CLAUDE_RISKY_BEFORE: "5",
      CLAUDE_RISKY_AFTER: "0",
      RISKY_OF: "20",
      E1_PREVENTED: "25",
      E1_OF: "25",
      SOAK: "0",
      E1_DATA: "25 scripted cases",
      RECORD_NOTE: "Not measured yet, so not shown: E3, E5.",
    });
  });

  it("stop the build when a row is missing, rather than show nothing or something old", () => {
    expect(() => tokens(TABLE.replace(/\| E4 .*\n/, ""), "u", "v")).toThrow(/no E4 row/);
    expect(() => tokens("no table here", "u", "v")).toThrow(/no results table/);
  });

  it("stop the build when a cell no longer reads as a number", () => {
    expect(() => tokens(TABLE.replace("| 25 | 25 scripted", "| all | 25 scripted"), "u", "v")).toThrow(/E1's prevented count/);
  });

  it("escape what a cell says, keep its code, and mark the negative result", () => {
    const html = recordRows(readTable(TABLE).rows);
    expect(html).toContain("Clearance cost &lt;harmless&gt; work");
    expect(html).toContain("<code>pnpm eval:authority</code>");
    expect(html).toContain('<tr class="neg">');
    expect(html).not.toContain("**");
  });

  it("refuse a page that names a token nobody fills", () => {
    expect(() => fill("{{NOT_A_NUMBER}}", {})).toThrow(/NOT_A_NUMBER/);
    expect(fill("{{A}} and {{A}}", { A: "1" })).toBe("1 and 1");
  });

  it("leave no token in the page that the build doesn't know", () => {
    const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");
    const named = [...page.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1]);
    const known = Object.keys(tokens(TABLE, "u", "v"));
    expect(named.filter((name) => !known.includes(name as string))).toEqual([]);
  });
});
