import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../eval/lib/paths.ts";
import { renderResults } from "../../eval/report.ts";
import { cardHtml, numbersHtml, slateHtml } from "./cards.ts";
import { parseResults, resolveTemplate } from "./results.ts";
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
    const stripped = (numbers?.voiceover ?? "").replace(/\{\{[^}]+\}\}/g, "");
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
