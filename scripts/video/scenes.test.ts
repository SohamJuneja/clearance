import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../eval/lib/paths.ts";
import { renderResults, renderTable } from "../../eval/report.ts";
import { buildVideo } from "./build.ts";
import { cardHtml, numbersHtml, slateHtml } from "./cards.ts";
import { unsourcedNumbers } from "./numbers.ts";
import { parseResults, resolveTemplate, scriptedWords, slideRows } from "./results.ts";
import { loadStoryboard, parseStoryboard, recordingHint, resolvePoint } from "./scenes.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The PLAN 12 table: scene, seconds, and the voice-over word for word. */
function planTable(): { scene: string; seconds: number; voiceover: string }[] {
  const plan = readFileSync(join(REPO_ROOT, "PLAN.md"), "utf8");
  const start = plan.indexOf("## 12. Demo video script");
  const end = plan.indexOf("## 13.", start);
  const rows: { scene: string; seconds: number; voiceover: string }[] = [];
  for (const line of plan.slice(start, end).split("\n")) {
    const match = line.match(/^\| (\d):(\d\d)–(\d):(\d\d) \| ([^|]+) \| .* \| "(.*)" \|$/);
    if (!match) continue;
    const [, m1, s1, m2, s2, scene, voiceover] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    rows.push({
      scene: scene.trim(),
      seconds: Number(m2) * 60 + Number(s2) - (Number(m1) * 60 + Number(s1)),
      voiceover,
    });
  }
  return rows;
}

describe("a number with no source", () => {
  const scene = (extra: string) => `
max_duration_s: 180
cited:
  - { value: "93%", source: "Anthropic" }
  - { value: "10x", source: "a planted flaw", only_in: [sc9] }
scenes:
  - { id: sc1, kind: card, planned_s: 3, headline: "Title", ${extra} }
`;

  it("is clean when nothing numeric is typed, or it's all cited or pulled from RESULTS.md", () => {
    expect(
      unsourcedNumbers(parseStoryboard(scene(`voiceover: "One inbox, 93%: {{E1.clearance}}."`))),
    ).toEqual([]);
    expect(
      unsourcedNumbers(parseStoryboard(scene(`voiceover: "[[if E2/risky.clearance]]a[[/if]]"`))),
    ).toEqual([]);
  });

  it.each([
    ["a digit in the voice-over", `voiceover: "We prevented 24 of them."`, "24"],
    ["a number word", `voiceover: "Twenty people approved."`, "Twenty"],
    ["a percentage nobody cited", `voiceover: "People approve 94%."`, "94%"],
    ["a callout", `callouts: ["caught 87.5%"]`, "87.5%"],
    ["a notice", `notices: ["n = 12"]`, "12"],
    ["a card's line", `lines: ["25.8 per 100"]`, "25.8"],
    ["a cited number outside the scenes it's for", `voiceover: "It was 10x."`, "10x."],
  ])("is caught in %s", (_name, extra, number) => {
    const problems = unsourcedNumbers(parseStoryboard(scene(extra)));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain(number);
    expect(problems.join(" ")).toContain("sc1");
  });

  it("is what the real boards are free of", () => {
    expect(unsourcedNumbers(loadStoryboard(join(here, "scenes.yaml")))).toEqual([]);
    expect(unsourcedNumbers(loadStoryboard(join(here, "smoke.scenes.yaml")))).toEqual([]);
  });

  it("wants a source for every citation, so a bare value can't pass for one", () => {
    expect(() =>
      parseStoryboard(
        `max_duration_s: 180\ncited: [{ value: "93%" }]\nscenes: [{ id: a, kind: card, planned_s: 1, headline: x }]`,
      ),
    ).toThrow(/cited/);
  });

  it("leaves the negative row's empty baseline empty, since nothing is pending there", () => {
    const html = numbersHtml(
      "x",
      parseResults(renderTable({ NEG: { experiment: "NEG", text: "we lose here" } })),
      ["NEG"],
    );
    expect(html).toContain("we lose here");
    expect(html).not.toContain(">pending<");
  });

  it("puts a still on a card when it's given one, and fails the build when the file isn't there", async () => {
    expect(cardHtml("x", [], "data:image/png;base64,AAAA")).toContain(
      'src="data:image/png;base64,AAAA"',
    );
    expect(cardHtml("x")).not.toContain("<img");
    const dir = mkdtempSync(join(tmpdir(), "still-"));
    try {
      const scenesPath = join(dir, "scenes.yaml");
      writeFileSync(
        scenesPath,
        "max_duration_s: 180\nscenes:\n  - { id: end, kind: card, planned_s: 1, headline: x, image: desk/live-ledger.png }\n",
      );
      const resultsPath = join(dir, "RESULTS.md");
      writeFileSync(resultsPath, renderResults({}));
      await expect(
        buildVideo({
          scenesPath,
          resultsPath,
          output: join(dir, "out.mp4"),
          workDir: join(dir, "work"),
          mediaRoot: dir,
          allowMissing: false,
          voice: async () => undefined,
          log: () => undefined,
        }),
      ).rejects.toThrow(/end: desk\/live-ledger\.png {2}\(pnpm video:desk\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the build before anything is rendered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "numbers-"));
    try {
      const scenesPath = join(dir, "scenes.yaml");
      writeFileSync(scenesPath, scene(`voiceover: "We prevented 24 of them."`));
      const resultsPath = join(dir, "RESULTS.md");
      writeFileSync(resultsPath, renderResults({}));
      await expect(
        buildVideo({
          scenesPath,
          resultsPath,
          output: join(dir, "out.mp4"),
          workDir: join(dir, "work"),
          mediaRoot: dir,
          allowMissing: true,
          voice: async () => undefined,
          log: () => undefined,
        }),
      ).rejects.toThrow(/these numbers have no source[\s\S]*sc1: "24"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scenes.yaml", () => {
  const board = loadStoryboard(join(here, "scenes.yaml"));
  const plan = planTable();

  it("has one scene per row of the PLAN 12 table, in order, with the planned lengths", () => {
    expect(plan.length).toBe(10);
    expect(board.scenes.length).toBe(plan.length);
    board.scenes.forEach((scene, index) => {
      expect(scene.planned_s, scene.id).toBe(plan[index]?.seconds);
    });
  });

  it("plans under the three-minute limit", () => {
    const total = board.scenes.reduce((sum, scene) => sum + scene.planned_s, 0);
    expect(total).toBe(170);
    expect(board.max_duration_s).toBe(180);
  });

  it("reads the plan's voice-over as written, except the numbers line that pulls from RESULTS.md", () => {
    board.scenes.forEach((scene, index) => {
      if (scene.id === "numbers") return;
      expect(scene.voiceover, scene.id).toBe(plan[index]?.voiceover);
    });
  });

  it("says persona actions are scripted on all footage", () => {
    expect(board.default_notices.join(" ")).toContain("persona actions are scripted");
  });

  it("labels SC14 staged, SC8 with the clock, and SC11's history as synthetic", () => {
    const byId = new Map(board.scenes.map((scene) => [scene.id, scene]));
    expect(byId.get("sc14")?.callouts).toContain("staged illustration, real clicks");
    expect(byId.get("sc8")?.clock10x).toBe(true);
    expect(byId.get("sc11")?.callouts?.join(" ")).toContain("synthetic");
  });

  it("types no result in the numbers line: everything comes from placeholders", () => {
    const numbers = board.scenes.find((scene) => scene.id === "numbers");
    const stripped = scriptedWords(numbers?.voiceover ?? "");
    expect(stripped.match(/\d+/g)).toEqual(["25"]); // "of 25" is the size of the suite, per PLAN 10.8.
  });

  it("every placeholder and row selector resolves against the table eval:report writes", () => {
    const rows = parseResults(renderResults({}));
    const numbers = board.scenes.find((scene) => scene.id === "numbers");
    if (numbers?.kind !== "numbers") throw new Error("no numbers scene");
    const text = resolveTemplate(numbers.voiceover ?? "", rows);
    expect(text).toContain("pending");
    expect(text).not.toContain("{{");
    expect(text).not.toContain("_");
    const html = numbersHtml(numbers.headline, rows, numbers.rows);
    expect(html).toContain("pending");
  });

  it("every placeholder and row selector resolves against the current RESULTS.md too", () => {
    const rows = parseResults(readFileSync(join(REPO_ROOT, "RESULTS.md"), "utf8"));
    const numbers = board.scenes.find((scene) => scene.id === "numbers");
    if (numbers?.kind !== "numbers") throw new Error("no numbers scene");
    expect(() => resolveTemplate(numbers.voiceover ?? "", rows)).not.toThrow();
    expect(() => numbersHtml(numbers.headline, rows, numbers.rows)).not.toThrow();
  });

  it("puts on the slide what the numbers row asks for, with E2 only once it exists", () => {
    const numbers = board.scenes.find((scene) => scene.id === "numbers");
    if (numbers?.kind !== "numbers") throw new Error("no numbers scene");
    expect(numbers.rows).toEqual(["E1", "AUDIT", "E2/risky?", "E3/quiet", "E6", "NEG"]);
    const shown = (table: string) =>
      slideRows(parseResults(table), numbers.rows).map((row) => row.id);
    expect(shown(renderResults({}))).toEqual(["E1", "AUDIT", "E3", "E6", "NEG"]);
    const withE2 = renderResults({
      E2: {
        experiment: "E2",
        risky_unapproved: { baseline: { claude: 7 }, clearance: { claude: 0 } },
      },
    });
    expect(shown(withE2)).toEqual(["E1", "AUDIT", "E2", "E3", "E6", "NEG"]);
    expect(resolveTemplate(numbers.voiceover ?? "", parseResults(renderResults({})))).not.toContain(
      "Risky actions",
    );
    expect(resolveTemplate(numbers.voiceover ?? "", parseResults(withE2))).toContain(
      "Risky actions without an eligible human: Claude 0",
    );
  });

  it("reads both E1 lines, and keeps the audit's apart from the 25", () => {
    const numbers = board.scenes.find((scene) => scene.id === "numbers");
    const said = resolveTemplate(
      numbers?.voiceover ?? "",
      parseResults(
        renderResults({
          E1: {
            experiment: "E1",
            clearance: { prevented: 24, total: 25 },
            audit: { passed: 5, total: 5 },
          },
        }),
      ),
    );
    expect(said).toContain("of 25: 24.");
    expect(said).toContain("Audit: 5 of 5.");
  });

  it("says on screen in SC3 that the agent caught the amount, and credits it first", () => {
    const sc3 = board.scenes.find((scene) => scene.id === "sc3");
    expect(sc3?.callouts?.join(" ")).toMatch(/agent caught the wrong amount/i);
    expect(sc3?.voiceover).toMatch(/^The agent caught the wrong amount/);
  });

  it("shows the 10x flag in the SC9 drill and nowhere else", () => {
    const mentions = (scene: (typeof board.scenes)[number]): boolean =>
      /10x|ten times/i.test(
        [
          scene.voiceover,
          ...(scene.callouts ?? []),
          ...(scene.notices ?? []),
          scene.kind === "card" || scene.kind === "numbers" ? scene.headline : "",
        ].join(" "),
      );
    expect(board.scenes.filter(mentions).map((scene) => scene.id)).toEqual(["sc9"]);
  });

  it("names a clip recorded by a known scenario for every footage scene", () => {
    for (const scene of board.scenes) {
      const clips =
        scene.kind === "clip" ? [scene.source] : scene.kind === "split" ? scene.sources : [];
      for (const clip of clips) expect(clip.clip).toMatch(/^takes\/SC\d+\/latest\/[a-z]+\.mp4$/);
    }
  });
});

describe("the storyboard parser", () => {
  const base = "max_duration_s: 180\nscenes:\n";

  it("refuses an unknown field, so a typo can't silently drop a label", () => {
    const yaml = `${base}  - { id: a, kind: card, planned_s: 3, headline: x, calouts: [y] }\n`;
    expect(() => parseStoryboard(yaml)).toThrow(/invalid/);
  });

  it("refuses a repeated id", () => {
    const scene = "{ id: a, kind: card, planned_s: 3, headline: x }";
    expect(() => parseStoryboard(`${base}  - ${scene}\n  - ${scene}\n`)).toThrow(
      /repeats scene ids: a/,
    );
  });

  it("refuses a split with one source", () => {
    const yaml = `${base}  - { id: a, kind: split, planned_s: 3, sources: [{ clip: a.mp4 }] }\n`;
    expect(() => parseStoryboard(yaml)).toThrow(/invalid/);
  });
});

describe("marks", () => {
  const marks = [{ label: "Sam denies", t: 41.2 }];

  it("takes seconds as given", () => {
    expect(resolvePoint(12, marks, "x.mp4")).toBe(12);
  });

  it("turns a step's name into its time in the take", () => {
    expect(resolvePoint("Sam denies", marks, "x.mp4")).toBe(41.2);
  });

  it("fails on a mark the take doesn't have, listing those it does", () => {
    expect(() => resolvePoint("Neha denies", marks, "x.mp4")).toThrow(
      /no mark "Neha denies".*"Sam denies"/,
    );
  });
});

describe("recordingHint", () => {
  it("says which command makes a missing clip", () => {
    expect(recordingHint("takes/SC3/latest/priya.mp4")).toBe("pnpm demo:run SC3 --record");
  });
});

describe("cards", () => {
  /** Synthetic fixture: exercises the slide only. */
  const rows = parseResults(
    "| ID | Metric | Baseline | Clearance | Data | Script |\n|---|---|---|---|---|---|\n| E1 | Bad outcomes prevented (of 25) | B-auto: 3 / B-ask: _ | 24 | 25 scripted cases | x |\n| NEG | **Negative result** | | | | |\n",
  );

  it("shows a value when there is one and pending when there isn't, never another number", () => {
    const html = numbersHtml("Measured", rows, ["E1", "NEG"]);
    expect(html).toContain(">24<");
    expect(html).toContain('B-auto: 3 / B-ask: <span class="pending">pending</span>');
    expect(html).toContain("Negative result");
    expect(html.match(/class="pending"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('follows a Data cell of "same" up to the row it refers to, since alone it means nothing', () => {
    const table = parseResults(
      "| ID | Metric | Baseline | Clearance | Data | Script |\n|---|---|---|---|---|---|\n| E3 | Recall | _ | _ | 300 labelled calls | x |\n| E3 | Cards | _ | _ | same | same |\n",
    );
    const html = numbersHtml("x", table, ["E3/cards"]);
    expect(html).toContain("300 labelled calls");
    expect(html).not.toContain(">same<");
  });

  it("escapes text so a cell can't break the page", () => {
    const html = cardHtml("a < b & c");
    expect(html).toContain("a &lt; b &amp; c");
  });

  it("sets backticked paths in code type", () => {
    expect(cardHtml("x", ["`templates/clearance.template.yaml`"])).toContain(
      "<code>templates/clearance.template.yaml</code>",
    );
  });

  it("fails on a row selector with no row, rather than leaving it off the slide", () => {
    expect(() => numbersHtml("x", rows, ["E9"])).toThrow(/no row E9/);
  });

  it("makes a slate that says what to run", () => {
    expect(slateHtml("sc3", "pnpm demo:run SC3 --record")).toContain("pnpm demo:run SC3 --record");
  });
});
