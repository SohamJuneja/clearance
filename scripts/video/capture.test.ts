import { existsSync, mkdtempSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browserUrl,
  frameDurations,
  nextTakeDirectory,
  OUTPUT,
  pointLatest,
  VISIBLE_TEXT_PROBE,
} from "./capture.ts";

describe("whether text is really on screen", () => {
  const VIEW = { width: 960, height: 1080 };
  const PATTERN = "Priya can't approve CLR-\\d+ \\(requester\\)";
  type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
  const at = (top: number, height = 20): Box => ({ left: 100, top, right: 700, bottom: top + height, width: 600, height });
  const probe = runInNewContext(`(${VISIBLE_TEXT_PROBE})`) as (
    doc: unknown,
    view: { width: number; height: number },
    pattern: string,
  ) => boolean;

  /** SYNTHETIC: just enough of a page. `covered` is whatever a real page would hit-test on top of the text. */
  function page(text: string, box: Box, covered = false) {
    const block = {
      innerText: text,
      getBoundingClientRect: () => box,
      contains: (other: unknown) => other === block,
    };
    return {
      querySelectorAll: () => [block],
      elementFromPoint: () => (covered ? {} : block),
    };
  }
  const REFUSAL = "Priya can't approve CLR-0001 (requester). Sent to Sam (finance, on duty).";

  it("sees the refusal inside the window with nothing over it", () => {
    expect(probe(page(REFUSAL, at(780)), VIEW, PATTERN)).toBe(true);
  });

  it("doesn't count it below the fold, where it once sat all through a take", () => {
    expect(probe(page(REFUSAL, at(1200)), VIEW, PATTERN)).toBe(false);
    expect(probe(page(REFUSAL, at(1070)), VIEW, PATTERN)).toBe(false);
  });

  it("doesn't count it scrolled off the top", () => {
    expect(probe(page(REFUSAL, at(-30)), VIEW, PATTERN)).toBe(false);
  });

  it("doesn't count it with something over it, such as the message box", () => {
    expect(probe(page(REFUSAL, at(780), true), VIEW, PATTERN)).toBe(false);
  });

  it("doesn't take the card's own line, which also says who can't approve", () => {
    const card = "Why here: copy for this room; Sam (finance, on duty) decides. Can't approve: Priya (requester).";
    expect(probe(page(card, at(780)), VIEW, PATTERN)).toBe(false);
  });

  it("doesn't count text with no size", () => {
    expect(probe(page(REFUSAL, { ...at(780), width: 0 }), VIEW, PATTERN)).toBe(false);
  });
});

describe("browserUrl", () => {
  it("points a browser at Mattermost's site URL, or it never hears a new post", () => {
    expect(browserUrl("http://127.0.0.1:8065")).toBe("http://localhost:8065");
    expect(browserUrl("http://localhost:8065")).toBe("http://localhost:8065");
    expect(browserUrl("https://chat.example.com")).toBe("https://chat.example.com");
  });
});

describe("frameDurations", () => {
  const frames = [
    { file: "a", at: 100.5 },
    { file: "b", at: 101 },
    { file: "c", at: 104 },
  ];

  it("shows each frame until the next one arrives", () => {
    const shown = frameDurations(frames, 100, 106);
    expect(shown.map((item) => item.file)).toEqual(["a", "b", "c"]);
    expect(shown[1]?.durationS).toBeCloseTo(3);
  });

  it("covers the wait before the first frame", () => {
    expect(frameDurations(frames, 100, 106)[0]?.durationS).toBeCloseTo(1);
  });

  it("holds the last frame until recording stopped, for a page that went quiet", () => {
    expect(frameDurations(frames, 100, 106)[2]?.durationS).toBeCloseTo(2);
  });

  it("adds up to the wall-clock length, however rarely the page changed", () => {
    const shown = frameDurations(frames, 100, 106);
    expect(shown.reduce((sum, item) => sum + item.durationS, 0)).toBeCloseTo(6);
  });

  it("gives a lone frame the whole recording", () => {
    const shown = frameDurations([{ file: "a", at: 100.2 }], 100, 110);
    expect(shown).toEqual([{ file: "a", durationS: 10 }]);
  });

  it("never gives the last frame less than one output frame", () => {
    const shown = frameDurations([{ file: "a", at: 100 }], 100, 100);
    expect(shown[0]?.durationS).toBeCloseTo(1 / OUTPUT.fps);
  });

  it("drops a frame with no time on screen, and clamps timestamps that run backwards", () => {
    const shown = frameDurations(
      [
        { file: "a", at: 100 },
        { file: "b", at: 99 },
        { file: "c", at: 101 },
      ],
      100,
      102,
    );
    expect(shown.map((item) => item.file)).toEqual(["b", "c"]);
    expect(shown.every((item) => item.durationS >= 0)).toBe(true);
  });
});

describe("takes", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "takes-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("numbers takes from 1 upward", () => {
    expect(nextTakeDirectory("SC3", root)).toBe(join(root, "SC3", "1"));
    expect(nextTakeDirectory("SC3", root)).toBe(join(root, "SC3", "2"));
    expect(nextTakeDirectory("SC4", root)).toBe(join(root, "SC4", "1"));
  });

  it("doesn't point latest at a take just for starting", () => {
    nextTakeDirectory("SC3", root);
    expect(existsSync(join(root, "SC3", "latest"))).toBe(false);
  });

  it("points latest at a take on request, and moves it to a better one", () => {
    const first = nextTakeDirectory("SC3", root);
    pointLatest(first);
    expect(readlinkSync(join(root, "SC3", "latest"))).toBe("1");
    const second = nextTakeDirectory("SC3", root);
    pointLatest(second);
    expect(readlinkSync(join(root, "SC3", "latest"))).toBe("2");
    expect(statSync(join(root, "SC3", "latest")).isDirectory()).toBe(true);
  });

  it("counts past latest when numbering", () => {
    pointLatest(nextTakeDirectory("SC3", root));
    expect(nextTakeDirectory("SC3", root)).toBe(join(root, "SC3", "2"));
  });
});
