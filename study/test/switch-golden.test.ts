/**
 * The port of Switch's renderer against the real thing. switch-golden.json was produced by running
 * Switch's own MattermostAdapter._draw at the pinned commit (study/tools/regen-golden.sh), so a pass
 * here means the replica says byte for byte what the real card would say.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { drawInput } from "../lib/cards";
import { goldenCases } from "../tools/golden-inputs";

type GoldenCard = { text: string; answerable: boolean; buttons: string[] };
const golden = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/switch-golden.json"), "utf8")) as {
  switch_commit: string;
  cases: Record<string, GoldenCard>;
};

const cases = goldenCases();

describe("the port matches Switch's real renderer", () => {
  it("was generated from the pinned Switch commit", () => {
    // The same SHA as the justfile and DECISIONS.md.
    expect(golden.switch_commit).toBe("1fe56227b6e330452ac80d7b7b2ca0a66aaeaeab");
    expect(readFileSync(resolve(import.meta.dirname, "../../justfile"), "utf8")).toContain(golden.switch_commit);
  });

  it("the golden file covers exactly the current cases, so a changed card forces a regeneration", () => {
    expect(Object.keys(golden.cases).sort()).toEqual(cases.map((c) => c.name).sort());
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (name, c) => {
    expect(drawInput(c.input)).toEqual(golden.cases[name]);
  });
});

describe("what the real renderer does, pinned down", () => {
  const real = (name: string) => golden.cases[name]!;
  const detailShown = (card: GoldenCard, length: number) => card.text.includes(`curl ${"x".repeat(length - 5)}`);

  it("does not cut a command at 160 characters", () => {
    for (const length of [159, 160, 161, 200]) {
      const card = real(`command ${length} chars`);
      expect(detailShown(card, length), `${length}`).toBe(true);
      expect(card.answerable).toBe(true);
    }
  });

  it("stops a card being answerable just past about 1000 characters, instead of trimming it", () => {
    expect(real("detail 998 with mention").answerable).toBe(true);
    expect(real("detail 999 with mention").answerable).toBe(false);
    expect(real("detail 1000 without mention").answerable).toBe(true);
    expect(real("detail 1001 without mention").answerable).toBe(false);
    const over = real("detail 999 with mention");
    expect(over.text).toContain("cannot be answered from this message");
    expect(over.buttons).toEqual([]);
  });

  it("does the same for a questions prompt just past 800 characters", () => {
    expect(real("prompt 800").answerable).toBe(true);
    expect(real("prompt 801").answerable).toBe(false);
  });
});
