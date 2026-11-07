import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  answerTokens,
  checkTokens,
  decideExamples,
  exampleRows,
  fill,
  pageTokens,
  POLICY_FILE,
  readmeTokens,
  readTable,
  recordRows,
  runCommands,
  runSentence,
  runVariants,
  switchRows,
  switchTable,
  tokens,
} from "./build.ts";
import { stampWord } from "./playground/engine.ts";

const TABLE = `intro
<!-- results:start -->
| ID | Metric | Baseline | Clearance | Data | Script |
|---|---|---|---|---|---|
| E1 | Bad outcomes prevented (of 25) | B-auto: 0 / B-ask: 9 | 25 | 25 scripted cases; more in RESULTS.md | \`pnpm eval:authority\` |
| E2 | Risky actions executed without an eligible human (of 20 per vendor) | Claude 5, OpenCode 13 of 18 | Claude 0, OpenCode 0 of 11 | 200 agent runs | \`pnpm eval:vendors\` |
| E4 | Soak invariant violations | n/a | 0 | 2 h, 7,200 calls, 3 restarts; synthetic driver | \`pnpm eval:soak\` |
| NEG | **Negative result** | | Clearance cost <harmless> work | \`pnpm eval:vendors:rescore\` | |

Not measured yet, so not shown: E3, E5.
<!-- results:end -->
`;

const README = `# Clearance

## Run it

\`\`\`bash
git clone https://example.test/repo && cd repo
cp .env.example .env     # add one key
just demo                # the whole stack, seeded
\`\`\`

Then open http://localhost:8065 and log in as \`priya\`. It needs Linux, Docker and \`just\`, and \`just demo --check\` says what's missing. Windows itself isn't supported. \`just demo --no-agents\` runs it with no key.

## How Clearance uses Switch

| Switch capability | How Clearance uses it | Code |
|---|---|---|
| Agent protocol: register, SSE stream | Clearance is a Switch agent | \`packages/switch-agent\` |
| Answer grammar (\`A12 yes\`) | The same grammar | \`packages/core/src/confirm\` |
| Managed agents | One <policy> over all of them | \`acme-mini-app/\`, \`scripts/setup-agents.ts\` |

Take Switch away and there's no card.

## Results

${TABLE}
## Limits
`;

const PACKAGE = JSON.stringify({ scripts: { "policy:test": "vitest", "eval:report": "tsx eval/report.ts" } });

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
      SOAK_HOURS: "2",
      SOAK_RESTARTS: "3",
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
    expect(() => tokens(TABLE.replace("3 restarts", "some restarts"), "u", "v")).toThrow(/killed core/);
  });

  it("escape what a cell says, keep its code, and mark the negative result", () => {
    const html = recordRows(readTable(TABLE).rows);
    expect(html).toContain("Clearance cost &lt;harmless&gt; work");
    expect(html).toContain("<code>pnpm eval:authority</code>");
    expect(html).toContain('<tr class="neg">');
    expect(html).not.toContain("**");
  });

  it("label every cell, so a phone can show each row as a block that says what each value is", () => {
    const html = recordRows(readTable(TABLE).rows);
    const rows = html.split("\n");
    for (const one of rows) {
      expect([...one.matchAll(/data-label="([^"]+)"/g)].map((match) => match[1])).toEqual(["ID", "Measure", "Without", "With Clearance", "How"]);
    }
    expect(rows[0]).toContain('<td class="id" data-label="ID">E1</td>');
  });

  it("refuse a page that names a token nobody fills", () => {
    expect(() => fill("{{NOT_A_NUMBER}}", {})).toThrow(/NOT_A_NUMBER/);
    expect(fill("{{A}} and {{A}}", { A: "1" })).toBe("1 and 1");
  });
});

describe("what the page copies from the README", () => {
  it("takes the Run it commands as they are, each with its comment", () => {
    expect(runCommands(README)).toEqual([
      { command: "git clone https://example.test/repo && cd repo", comment: "" },
      { command: "cp .env.example .env", comment: "add one key" },
      { command: "just demo", comment: "the whole stack, seeded" },
    ]);
    expect(runVariants(README)).toEqual(["just demo --check", "just demo --no-agents"]);
    expect(runSentence(README, "Then open")).toBe("Then open http://localhost:8065 and log in as `priya`.");
    expect(runSentence(README, "It needs")).toBe("It needs Linux, Docker and `just`, and `just demo --check` says what's missing.");
  });

  it("stops the build when the README no longer says what the page offers", () => {
    expect(() => readmeTokens(README.replace("`just demo --no-agents` runs", "Scripted calls run"), "u")).toThrow(/just demo --no-agents/);
    expect(() => runCommands(README.replace(/```bash[\s\S]*?```/, ""))).toThrow(/no bash block/);
    expect(() => runSentence(README, "Then close")).toThrow(/Then close/);
    expect(() => switchTable(README.replace("Take Switch away", "Without it"))).toThrow(/taking Switch away/);
  });

  it("lists every Switch capability in the README's table, with its code linked into the repo", () => {
    const { uses, without } = switchTable(README);
    expect(uses.map((use) => use.capability)).toEqual(["Agent protocol: register, SSE stream", "Answer grammar (`A12 yes`)", "Managed agents"]);
    expect(without).toBe("Take Switch away and there's no card.");
    const html = switchRows(uses, "https://example.test/repo");
    expect(html).toContain('<span class="cap">Agent protocol<span class="cap-terms">register, SSE stream</span></span>');
    expect(html).toContain('<span class="cap-terms">(<code>A12 yes</code>)</span>');
    expect(html).toContain('href="https://example.test/repo/tree/master/packages/switch-agent"');
    expect(html).toContain('href="https://example.test/repo/blob/master/scripts/setup-agents.ts"');
    expect(html).toContain('href="https://example.test/repo/tree/master/acme-mini-app"');
    expect(html).toContain("One &lt;policy&gt; over all of them");
    expect(html.match(/<li>/g)).toHaveLength(3);
  });

  it("still reads the real README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const values = readmeTokens(readme, "https://example.test/repo");
    expect(values.RUN_ROWS).toContain("just demo");
    expect(values.SWITCH_ROWS).toContain("approval_outcome");
    expect(values.SWITCH_ROWS).toContain("answered_by");
    expect(() => tokens(readme, "u", "v")).not.toThrow();
  });

  it("only offers checks that are scripts in package.json", () => {
    expect(checkTokens(PACKAGE).CHECK_ROWS).toContain("pnpm policy:test");
    expect(() => checkTokens(JSON.stringify({ scripts: { "policy:test": "x" } }))).toThrow(/eval:report/);
    expect(() => checkTokens(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).not.toThrow();
  });
});

describe("Try it, as the build fills it", () => {
  const policyText = readFileSync(POLICY_FILE, "utf8");

  it("names each answer the way its stamp does", () => {
    expect(stampWord({ decision: "allow", step: "safe" })).toBe("ALLOWED");
    expect(stampWord({ decision: "allow", step: "via_gate" })).toBe("TO THE GATE");
    expect(stampWord({ decision: "hold", step: "class_hold" })).toBe("HELD");
    expect(stampWord({ decision: "deny", step: "deny_class" })).toBe("DENIED");
  });

  it("writes core's answers into the examples, each a button that carries its command, escaped", async () => {
    const decided = await decideExamples(policyText);
    const html = exampleRows(decided);
    expect(html).toContain('data-command="echo \'{}\' &gt; .mcp.json"');
    expect(html).toContain('<span class="verdict verdict--deny">DENIED</span>');
    expect(html).toContain('<span class="verdict verdict--gate">TO THE GATE</span>');
    expect(html.match(/<tr>/g)).toHaveLength(decided.length);
  });

  it("fills the first answer from core, so the page reads right before the engine loads, or without it", async () => {
    const [first] = await decideExamples(policyText);
    const values = answerTokens(first as NonNullable<typeof first>);
    expect(values).toMatchObject({ ANSWER_COMMAND: "git push --force origin main", ANSWER_KIND: "hold", ANSWER_WORD: "HELD", ANSWER_CLASS: "merge" });
    expect(values.ANSWER_REASON).toBe("HELD: merges to main need eng approval");
    expect(values.ANSWER_FLAGS).toContain('<li class="flag">');
    expect(values.ANSWER_CARD).toContain("Never the person who asked");
  });

  it("leaves no token in the page that the build doesn't know", async () => {
    const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");
    const named = [...page.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1] as string);
    const values = await pageTokens(README, policyText, PACKAGE, "u", "v");
    expect(named.filter((name) => !Object.hasOwn(values, name))).toEqual([]);
    expect(fill(page, values)).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  it("points the page at the engine it ships, which the shared copy swaps for an inline one", () => {
    const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");
    const build = readFileSync(new URL("./build.ts", import.meta.url), "utf8");
    expect(page).toContain('data-engine="./playground.js"');
    expect(build).toContain(`page.replace('data-engine="./playground.js"'`);
  });
});
