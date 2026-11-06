import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../eval/lib/paths.ts";
import { renderResults, renderTable } from "../../eval/report.ts";
import { buildVideo, fillLines, fillText } from "./build.ts";
import { cardHtml, numbersHtml, slateHtml } from "./cards.ts";
import { findScenario } from "../scenarios/index.ts";
import { unsourcedNumbers } from "./numbers.ts";
import { parseResults, resolveTemplate, scriptedWords, slideRows } from "./results.ts";
import {
  loadStoryboard,
  clipToScene,
  parseStoryboard,
  recordingHint,
  refusalOnScreenBy,
  refusalProblem,
  resolvePoint,
  sceneOffset,
  timeCallouts,
  seenInVideo,
  settleScenes,
  sourcesOf,
} from "./scenes.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The PLAN 12 table: scene, seconds, and the voice-over word for word. */
function planTable(): {
  scene: string;
  startS: number;
  endS: number;
  seconds: number;
  voiceover: string;
}[] {
  const plan = readFileSync(join(REPO_ROOT, "PLAN.md"), "utf8");
  const start = plan.indexOf("## 12. Demo video script");
  const end = plan.indexOf("## 13.", start);
  const rows: ReturnType<typeof planTable> = [];
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
      startS: Number(m1) * 60 + Number(s1),
      endS: Number(m2) * 60 + Number(s2),
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
    expect(total).toBe(163);
    expect(board.max_duration_s).toBe(180);
    expect(total).toBeLessThan(board.max_duration_s);
  });

  it("has PLAN's clock add up: each row starts where the last ended, at the storyboard's offsets", () => {
    plan.forEach((row, index) => {
      expect(row.startS, row.scene).toBe(index === 0 ? 0 : plan[index - 1]?.endS);
      expect(row.startS, row.scene).toBe(sceneOffset(board, board.scenes[index]?.id ?? ""));
    });
  });

  it("has Clearance's refusal of Priya on screen by 0:20, by the storyboard and by PLAN's clock", () => {
    expect(board.first_refusal).toEqual({
      scene: "sc3-refused",
      within_s: 20,
      seen: findScenario("SC3")?.capture.watch?.[0]?.label,
    });
    expect(sceneOffset(board, "sc3-refused")).toBeLessThanOrEqual(20);
    expect(refusalOnScreenBy(board)).toBeLessThanOrEqual(20);
    expect(refusalProblem(board)).toBeUndefined();
    const row = plan.find((one) => one.scene === "SC3, refused");
    expect(row?.endS).toBeLessThanOrEqual(20);
  });

  it("really ends that scene on the refusal: its footage runs past the step where Clearance refuses", () => {
    const scene = board.scenes.find((one) => one.id === "sc3-refused");
    const steps = findScenario("SC3")?.stepNames ?? [];
    const refuses = steps.indexOf("Clearance refuses Priya, says why, and says Sam has it");
    expect(refuses).toBeGreaterThan(0);
    for (const source of scene ? sourcesOf(scene) : []) {
      const end = source.segments?.at(-1)?.to as string;
      expect(steps.indexOf(end)).toBe(refuses + 1);
    }
    expect(sourcesOf(scene as NonNullable<typeof scene>).length).toBe(2);
  });

  it("counts what scenes really came to, so a long voice-over can't push the refusal late unnoticed", () => {
    const long = refusalProblem(board, (one) => (one.id === "sc2" ? 9 : one.planned_s));
    expect(long).toContain("on screen by 21.0 s, past the 20 s limit");
    expect(refusalProblem(board, (one) => (one.id === "sc2" ? 7 : one.planned_s))).toBeUndefined();
    const noLimit = parseStoryboard(
      "max_duration_s: 180\nscenes: [{ id: a, kind: card, planned_s: 40, headline: x }]",
    );
    expect(refusalOnScreenBy(noLimit)).toBeUndefined();
    expect(refusalProblem(noLimit)).toBeUndefined();
  });

  it("refuses a first_refusal naming a scene that doesn't exist", () => {
    const wrong = parseStoryboard(
      "max_duration_s: 180\nfirst_refusal: { scene: nope, within_s: 20 }\nscenes: [{ id: a, kind: card, planned_s: 1, headline: x }]",
    );
    expect(() => refusalOnScreenBy(wrong)).toThrow(/names nope/);
  });

  it("opens with no title card, and has SC14 set up the drill instead of opening the video", () => {
    const ids = board.scenes.map((scene) => scene.id);
    expect(ids.slice(0, 2)).toEqual(["sc2", "sc3-refused"]);
    expect(ids).not.toContain("title");
    expect(ids.indexOf("sc9")).toBe(ids.indexOf("sc14") + 1);
    const caption = board.scenes.find((scene) => scene.id === "sc3-refused")?.callouts?.join(" ");
    expect(caption).toContain("Clearance: the approval layer, built on Switch");
  });

  it("says the 93% once, on the scene with its source", () => {
    const with93 = board.scenes.filter((scene) => /93%/.test(scene.voiceover ?? ""));
    expect(with93.map((scene) => scene.id)).toEqual(["sc14"]);
    expect(with93[0]?.notices?.join(" ")).toContain("Anthropic");
  });

  it("names only real steps of the recorded scenario wherever a segment names one, split or alone", () => {
    for (const scene of [...board.scenes, ...settleScenes(board, () => false).scenes]) {
      for (const source of sourcesOf(scene)) {
        const id = /takes\/(SC\d+)\//.exec(source.clip)?.[1] ?? "";
        const steps = findScenario(id)?.stepNames ?? [];
        for (const segment of source.segments ?? []) {
          for (const point of [segment.from, segment.to]) {
            if (typeof point === "string") expect(steps, `${scene.id}: ${point}`).toContain(point);
          }
        }
      }
    }
  });

  it("reads the plan's voice-over as written, except the numbers line that pulls from RESULTS.md", () => {
    settleScenes(board, () => false).scenes.forEach((scene, index) => {
      if (scene.id === "numbers") return;
      const spoken = scene.voiceover?.replace(/\[\[\/?[^\]]*\]\]/g, "");
      expect(spoken, scene.id).toBe(plan[index]?.voiceover);
    });
  });

  it("keeps the split's voice-over in PLAN too, for when SC5 exists", () => {
    const split = board.scenes.find((scene) => scene.id === "sc5-sc6");
    expect(split?.kind).toBe("split");
    expect(readFileSync(join(REPO_ROOT, "PLAN.md"), "utf8")).toContain(`"${split?.voiceover}"`);
  });

  it("runs SC6 alone while SC5 is missing, saying OpenCode and not Codex, and goes back to the split once SC5 exists", () => {
    const missing = settleScenes(board, () => false).scenes.find((scene) => scene.id === "sc5-sc6");
    expect(missing?.kind).toBe("clip");
    expect(sourcesOf(missing!).map((source) => source.clip)).toEqual(["takes/SC6/latest/alex.mp4"]);
    expect(missing?.callouts?.join(" ")).toMatch(/OpenCode.*same policy/);
    const said = `${missing?.voiceover} ${missing?.callouts?.join(" ")}`;
    expect(said).not.toMatch(/codex/i);
    expect(said).not.toMatch(/every agent vendor/i);

    const present = settleScenes(board, () => true).scenes.find((scene) => scene.id === "sc5-sc6");
    expect(present?.kind).toBe("split");
    expect(sourcesOf(present!).map((source) => source.clip)).toEqual([
      "takes/SC5/latest/priya.mp4",
      "takes/SC6/latest/alex.mp4",
    ]);
  });

  it("records SC6 at full width to match, so it isn't a half window in a whole frame", () => {
    expect(findScenario("SC6")?.capture.layout).toBe("full");
  });

  it("holds SC2's last frame rather than filling the scene, and pins the take its seconds belong to", () => {
    const scene = board.scenes.find((one) => one.id === "sc2");
    const source = sourcesOf(scene!)[0];
    expect(source?.speed).toBe(6);
    expect(source?.clip).toBe("takes/SC2/6/priya.mp4");
    expect(scene?.planned_s).toBe(8);
  });

  it("ends the drill's label where the real card begins, and labels that card for the rest of the scene", () => {
    const scene = board.scenes.find((one) => one.id === "sc9");
    const [drill, real] = scene?.timed_callouts ?? [];
    expect(scene?.callouts).toBeUndefined();
    expect(drill?.text).toContain("drill");
    expect(drill?.to).toBe("Sam's next card asks for a typed detail");
    expect(real?.from).toBe(drill?.to);
    expect(real?.to).toBeUndefined();
    expect(real?.text).toBe("The next card is real: a ₹40,000 refund on a returned order");
  });

  it("says what the seeded order says about the real card", () => {
    const seed = readFileSync(join(REPO_ROOT, "packages/acme/src/seed.ts"), "utf8");
    expect(seed).toMatch(
      /id: "A-2004",\s+customer_id: ROHAN_ID,\s+total: 40000,\s+status: "returned"/,
    );
  });

  it("cuts only SC9's wait for the agent, and runs until the result is on screen", () => {
    const scene = board.scenes.find((one) => one.id === "sc9");
    const steps = findScenario("SC9")?.stepNames ?? [];
    const [drill, typed] = sourcesOf(scene!)[0]?.segments ?? [];
    expect(drill?.to).toBe("A real high-risk request arrives");
    expect(steps.indexOf(typed?.from as string)).toBe(
      steps.indexOf("A real high-risk request arrives") + 1,
    );
    expect(steps.indexOf("The room hears it was approved by Sam and ran")).toBeGreaterThan(
      steps.indexOf(typed?.from as string),
    );
    expect(typed?.to).toBe(steps.at(-1));
  });

  it("gives no count of cards on SC14's caption or voice-over, since a take may reach fewer than five", () => {
    const scene = board.scenes.find((one) => one.id === "sc14");
    expect(`${scene?.voiceover} ${scene?.callouts?.join(" ")}`).not.toMatch(/\bfive\b|\b5\b/i);
  });

  it("says the same rows it shows, with and without each result", () => {
    const numbers = board.scenes.find((scene) => scene.id === "numbers");
    if (numbers?.kind !== "numbers") throw new Error("no numbers scene");
    const lines: Record<string, RegExp> = {
      E1: /Bad outcomes prevented/,
      AUDIT: /Independent reviews/,
      E2: /Risky actions/,
      E3: /Tool calls with no card/,
      E6: /Human decisions/,
      NEG: /one place we lose/,
    };
    const check = (table: string) => {
      const rows = parseResults(table);
      const shown = slideRows(rows, numbers.rows).map((row) => row.id);
      const said = resolveTemplate(numbers.voiceover ?? "", rows);
      for (const [id, words] of Object.entries(lines)) {
        expect(words.test(said), `${id} in: ${said}`).toBe(shown.includes(id));
      }
      expect(said).not.toContain("pending");
      expect(numbersHtml(numbers.headline, rows, numbers.rows)).not.toContain("pending");
    };
    check(renderResults({}));
    check(readFileSync(join(REPO_ROOT, "RESULTS.md"), "utf8"));
    check(
      renderResults({
        E1: {
          experiment: "E1",
          clearance: { prevented: 24, total: 25 },
          audit: { passed: 5, total: 5 },
        },
        E2: {
          experiment: "E2",
          risky_unapproved: { baseline: { claude: 7 }, clearance: { claude: 0 } },
        },
        NEG: { experiment: "NEG", text: "we lose here" },
      }),
    );
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
    expect(text).toBe("Measured, not claimed. ");
    expect(numbersHtml(numbers.headline, rows, numbers.rows)).not.toContain("pending");
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
    expect(numbers.rows).toEqual(["E1", "AUDIT", "E2/risky", "E3/quiet", "E6", "NEG"]);
    const shown = (table: string) =>
      slideRows(parseResults(table), numbers.rows).map((row) => row.id);
    expect(shown(renderResults({}))).toEqual([]);
    const withE2 = renderResults({
      E2: {
        experiment: "E2",
        risky_unapproved: { baseline: { claude: 7 }, clearance: { claude: 0 } },
      },
    });
    expect(shown(withE2)).toEqual(["E2"]);
    expect(resolveTemplate(numbers.voiceover ?? "", parseResults(renderResults({})))).not.toContain(
      "Risky actions",
    );
    expect(resolveTemplate(numbers.voiceover ?? "", parseResults(withE2))).toContain(
      "Risky actions without an eligible human: Claude 0",
    );
  });

  it("reads E1's line, says the reviews in words apart from the 25, and leaves their numbers to the slide", () => {
    const numbers = board.scenes.find((scene) => scene.id === "numbers");
    if (numbers?.kind !== "numbers") throw new Error("no numbers scene");
    const results = parseResults(
      renderResults({
        E1: {
          experiment: "E1",
          clearance: { prevented: 24, total: 25 },
          audit: { passed: 5, total: 5 },
        },
      }),
    );
    const said = resolveTemplate(numbers.voiceover ?? "", results);
    expect(said).toContain("of 25: 24.");
    expect(said).toContain("Independent reviews found more");
    expect(said).not.toContain("Audit: 5 of 5");
    expect(numbers.rows).toContain("AUDIT");
    expect(slideRows(results, numbers.rows).find((row) => row.id === "AUDIT")?.clearance).toContain(
      "Audit: 5 of 5",
    );
  });

  it("says on screen in SC3 that the agent caught the amount, and credits it first", () => {
    const sc3 = board.scenes.find((scene) => scene.id === "sc3-refused");
    expect(sc3?.callouts?.join(" ")).toMatch(/agent caught the wrong amount/i);
    expect(sc3?.voiceover).toMatch(/^The agent caught the wrong amount/);
  });

  it("shows the 10x flag in the SC9 drill and nowhere else", () => {
    const mentions = (scene: (typeof board.scenes)[number]): boolean =>
      /10x|ten times/i.test(
        [
          scene.voiceover,
          ...(scene.callouts ?? []),
          ...(scene.timed_callouts ?? []).map((callout) => callout.text),
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
      // A number where a take is pinned, as this file's header says to do, because a segment's seconds are that take's.
      for (const clip of clips)
        expect(clip.clip).toMatch(/^takes\/SC\d+\/(latest|\d+)\/[a-z]+\.mp4$/);
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

describe("the refusal's record", () => {
  const footage = [
    { path: "/takes/SC3/latest/priya.mp4", segments: [{ fromS: 10, toS: 40 }], speed: 2.5 },
    { path: "/takes/SC3/latest/sam.mp4", segments: [{ fromS: 10, toS: 40 }], speed: 2.5 },
  ];
  const label = "Clearance's refusal of Priya";
  const record = (t: number, persona = "priya") => ({ label, persona, t });
  const check = (records: { label: string; persona: string; t: number }[], withinS = 20) =>
    seenInVideo({
      label,
      withinS,
      sceneStartS: 8,
      footage,
      readRecords: (path) => (path.endsWith("priya.mp4") ? records : []),
    });

  it("maps a moment through the scene's segments and speed", () => {
    expect(clipToScene(35, [{ fromS: 10, toS: 40 }], 2.5)).toBeCloseTo(10);
    expect(
      clipToScene(
        62,
        [
          { fromS: 0, toS: 5 },
          { fromS: 60, toS: 70 },
        ],
        2,
      ),
    ).toBeCloseTo(3.5);
  });

  it("says a moment the segments cut isn't in the scene", () => {
    expect(
      clipToScene(
        30,
        [
          { fromS: 0, toS: 5 },
          { fromS: 60, toS: 70 },
        ],
        2,
      ),
    ).toBeUndefined();
  });

  it("passes a refusal the recorder saw in time, and says when", () => {
    expect(check([record(35)])).toEqual({ atS: 18 });
  });

  it("fails a take with no record, whatever else it holds", () => {
    expect(check([]).problem).toMatch(/no record of "Clearance's refusal of Priya" being visible/);
    expect(check([{ label: "something else", persona: "priya", t: 35 }]).problem).toMatch(
      /no record/,
    );
    expect(check([record(35, "sam")]).problem).toMatch(/no record/);
  });

  it("fails a refusal that maps past the limit, even by a little", () => {
    const late = check([record(40)]);
    expect(late.atS).toBe(20);
    expect(late.problem).toBeUndefined();
    expect(check([record(40)], 19.9).problem).toMatch(
      /visible at 20\.00 s, past the 19\.9 s limit/,
    );
  });

  it("fails a refusal the scene's footage cut", () => {
    expect(check([record(41)]).problem).toMatch(/segments cut/);
  });
});

describe("the repo URL", () => {
  const rows = parseResults(renderResults({}));

  it("leaves its line off the card and its words out of the voice-over until it's set", () => {
    expect(fillLines(["a", "{{repo_url}}", "b"], rows, undefined)).toEqual(["a", "b"]);
    expect(fillText("Documents. [[if repo_url]]Link below.[[/if]]", rows, undefined)).toBe(
      "Documents.",
    );
  });

  it("shows both once it is", () => {
    expect(fillLines(["a", "{{repo_url}}"], rows, "https://example.com/r")).toEqual([
      "a",
      "https://example.com/r",
    ]);
    expect(
      fillText("Documents. [[if repo_url]]Link below.[[/if]]", rows, "https://example.com/r"),
    ).toBe("Documents. Link below.");
  });

  it("never reads pending on the close card, set or not", () => {
    const close = loadStoryboard(join(here, "scenes.yaml")).scenes.find(
      (scene) => scene.id === "close",
    );
    if (close?.kind !== "card") throw new Error("no close card");
    expect(fillLines(close.lines ?? [], rows, undefined).join(" ")).not.toContain("pending");
    expect(fillText(close.voiceover ?? "", rows, undefined)).not.toMatch(/pending|Link below/);
  });
});

describe("a callout for part of a scene", () => {
  const footage = {
    segments: [
      { fromS: 0.2, toS: 7.3 },
      { fromS: 122.4, toS: 144.7 },
    ],
    speed: 1,
    marks: [
      { label: "the drill", t: 0.2 },
      { label: "the real card", t: 122.4 },
      { label: "the wait", t: 50 },
    ],
    clip: "x.mp4",
  };

  it("runs between two steps, in the scene's own time, across a cut", () => {
    expect(timeCallouts([{ text: "a", to: "the real card" }], footage, 30)).toEqual([
      { text: "a", startS: 0, endS: expect.closeTo(7.1) as number },
    ]);
    expect(timeCallouts([{ text: "b", from: "the real card" }], footage, 30)).toEqual([
      { text: "b", startS: expect.closeTo(7.1) as number, endS: 30 },
    ]);
  });

  it("follows the scene's speed", () => {
    const [callout] = timeCallouts(
      [{ text: "a", to: "the real card" }],
      { ...footage, speed: 2 },
      30,
    );
    expect(callout?.endS).toBeCloseTo(3.55);
  });

  it("fails on a step the segments cut, or that doesn't exist, rather than guessing a time", () => {
    expect(() => timeCallouts([{ text: "a", to: "the wait" }], footage, 30)).toThrow(
      /segments cut/,
    );
    expect(() => timeCallouts([{ text: "a", to: "nope" }], footage, 30)).toThrow(/no mark "nope"/);
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
    "| ID | Metric | Baseline | Clearance | Data | Script |\n|---|---|---|---|---|---|\n| E1 | Bad outcomes prevented (of 25) | B-auto: 3 / B-ask: _ | 24 | 25 scripted cases | x |\n| NEG | **Negative result** | | we lose here | | |\n",
  );

  it("shows a value when there is one and nothing when there isn't, never another number", () => {
    const html = numbersHtml("Measured", rows, ["E1", "NEG"]);
    expect(html).toContain(">24<");
    expect(html).toContain("<td>B-auto: 3</td>");
    expect(html).toContain("Negative result");
    expect(html).not.toContain(">pending<");
    expect(html).not.toContain("B-ask");
  });

  it('follows a Data cell of "same" up to the row it refers to, since alone it means nothing', () => {
    const table = parseResults(
      "| ID | Metric | Baseline | Clearance | Data | Script |\n|---|---|---|---|---|---|\n| E3 | Recall | _ | _ | 300 labelled calls | x |\n| E3 | Cards | _ | 12 | same | same |\n",
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
