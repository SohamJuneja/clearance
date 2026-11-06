import { describe, expect, it } from "vitest";
import {
  assDocument,
  assTime,
  captionChunks,
  MAX_CHARS_PER_LINE,
  MAX_LINES_PER_CUE,
  timeCues,
  wrapText,
} from "./captions.ts";

const VOICE =
  "Clearance holds the refund, refuses Priya's own approval, and sends it to Sam in finance. Sam sees the real call, not the agent's story: ten times the order total, to a payment ID added four minutes ago. He denies it.";

describe("wrapText", () => {
  it("keeps every line within the limit and loses no words", () => {
    const lines = wrapText(VOICE, 40);
    expect(lines.every((line) => line.length <= 40)).toBe(true);
    expect(lines.join(" ")).toBe(VOICE);
  });

  it("gives a word too long for a line a line of its own", () => {
    expect(wrapText("short averyveryverylongtoken end", 10)).toEqual([
      "short",
      "averyveryverylongtoken",
      "end",
    ]);
  });

  it("gives nothing for blank text", () => {
    expect(wrapText("   ")).toEqual([]);
  });
});

describe("captionChunks", () => {
  it("never puts more than two lines on screen, nor a line over the limit", () => {
    const chunks = captionChunks(VOICE);
    expect(chunks.every((lines) => lines.length <= MAX_LINES_PER_CUE)).toBe(true);
    expect(chunks.flat().every((line) => line.length <= MAX_CHARS_PER_LINE)).toBe(true);
    expect(chunks.flat().join(" ")).toBe(VOICE);
  });

  it("starts a new caption at a new sentence", () => {
    const chunks = captionChunks("One short sentence. Another short sentence.");
    expect(chunks).toEqual([["One short sentence."], ["Another short sentence."]]);
  });

  it("leaves a rupee amount with a comma in one piece", () => {
    expect(captionChunks("A ₹40,000 refund.")).toEqual([["A ₹40,000 refund."]]);
  });
});

describe("timeCues", () => {
  it("covers exactly the time given, in order, with no gaps", () => {
    const cues = timeCues(captionChunks(VOICE), 0.2, 12);
    expect(cues[0]?.startS).toBeCloseTo(0.2);
    expect(cues.at(-1)?.endS).toBeCloseTo(12.2);
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]?.startS).toBeCloseTo(cues[i - 1]?.endS as number);
    }
  });

  it("gives a longer caption more time", () => {
    const cues = timeCues([["short"], ["a much much longer caption than that"]], 0, 10);
    const [first, second] = cues;
    expect((second?.endS as number) - (second?.startS as number)).toBeGreaterThan(
      (first?.endS as number) - (first?.startS as number),
    );
  });

  it("is empty when there's nothing to say", () => {
    expect(timeCues([], 0, 10)).toEqual([]);
  });
});

describe("assTime", () => {
  it("formats hours, minutes, seconds and centiseconds", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(62.5)).toBe("0:01:02.50");
    expect(assTime(3661.25)).toBe("1:01:01.25");
  });

  it("clamps below zero", () => {
    expect(assTime(-3)).toBe("0:00:00.00");
  });
});

describe("assDocument", () => {
  const scene = {
    durationS: 12,
    cues: [{ startS: 0, endS: 3, lines: ["first line", "second line"] }],
    notices: ["persona actions are scripted", "agents' words are not"],
    callouts: ["staged illustration, real clicks"],
    corner: ["clock 10x"],
  };

  it("breaks caption lines with an explicit line break", () => {
    expect(assDocument(scene)).toContain("first line\\Nsecond line");
  });

  it("burns the labels in for the whole scene", () => {
    const text = assDocument(scene);
    expect(text).toMatch(
      /Dialogue: 2,0:00:00\.00,0:00:12\.00,Callout,.*staged illustration, real clicks/,
    );
    expect(text).toMatch(/Dialogue: 2,0:00:00\.00,0:00:12\.00,Corner,.*clock 10x/);
    expect(text).toMatch(/Notice,.*persona actions are scripted/);
  });

  it("escapes braces so voice-over text can't become an override", () => {
    const text = assDocument({
      ...scene,
      notices: [],
      callouts: [],
      corner: [],
      cues: [{ startS: 0, endS: 1, lines: ["{\\b1}oops"] }],
    });
    expect(text).toContain("\\{\\\\b1\\}oops");
  });

  it("omits what isn't asked for", () => {
    const timed = assDocument({
      durationS: 30,
      cues: [],
      notices: [],
      callouts: [],
      timedCallouts: [
        { text: "first", startS: 0, endS: 7.1 },
        { text: "then", startS: 7.1, endS: 30 },
      ],
      corner: [],
    });
    expect(timed).toContain("Dialogue: 2,0:00:00.00,0:00:07.10,Callout,,0,0,24,,first");
    expect(timed).toContain("Dialogue: 2,0:00:07.10,0:00:30.00,Callout,,0,0,24,,then");
    const noCallout = assDocument({ durationS: 3, cues: [], notices: [], callouts: [], corner: [] });
    expect(noCallout).not.toMatch(/^Dialogue: .*,Callout,/m);
    const two = assDocument({
      durationS: 3,
      cues: [],
      notices: [],
      callouts: ["The agent caught the wrong amount in this ticket", "Clearance: the approval layer, built on Switch"],
      corner: [],
    });
    // One row, on Mattermost's header bar. A second row used to sit on the agent's sentence the first was about.
    const rows = two.split("\n").filter((line) => /^Dialogue: .*,Callout,/.test(line));
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain(",Callout,,0,0,24,,{\\fs30}The agent caught");
    expect(rows[0]).toContain("in this ticket  ·  Clearance: the approval layer");
    const text = assDocument({ durationS: 3, cues: [], notices: [], callouts: [], corner: [] });
    expect(text).not.toContain("Dialogue:");
  });
});
