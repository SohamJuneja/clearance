import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { piperProblem, speakable, voiceProvider } from "./voice.ts";

describe("speakable", () => {
  it("says rupees in words, keeping the number exactly", () => {
    expect(speakable("a ₹40,000 refund")).toBe("a 40,000 rupee refund");
    expect(speakable("₹2,000 and ₹ 4,000")).toBe("2,000 rupees and 4,000 rupees");
  });

  it("doesn't touch a number or a percentage", () => {
    expect(speakable("people approve 93% of prompts, 25 of them")).toBe(
      "people approve 93% of prompts, 25 of them",
    );
  });

  it("reads a cell's slash as a pause, and drops code ticks", () => {
    expect(speakable("B-auto: pending / B-ask: pending")).toBe("B-auto: pending, B-ask: pending");
    expect(speakable("run `pnpm test`")).toBe("run pnpm test");
  });

  it("keeps pending as the word pending", () => {
    expect(speakable("Bad outcomes prevented: pending.")).toBe("Bad outcomes prevented: pending.");
  });
});

describe("voiceProvider", () => {
  let dir: string;
  let voiceDir: string;
  let cacheDir: string;
  let spoken: string[];
  const logs: string[] = [];

  const fakeEngine = {
    engine: "fake 1",
    engineProblem: () => undefined,
    speak: async (text: string, output: string): Promise<void> => {
      spoken.push(text);
      writeFileSync(output, "RIFF");
    },
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "voice-"));
    voiceDir = dir;
    cacheDir = join(dir, "cache");
    spoken = [];
    logs.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const provider = (extra = {}) =>
    voiceProvider({
      overrideDir: voiceDir,
      cacheDir,
      log: (line) => logs.push(line),
      ...fakeEngine,
      ...extra,
    });

  it("speaks a scene with the engine", async () => {
    const clip = await provider()("sc2", "a ₹40,000 refund");
    expect(clip?.source).toBe("fake 1");
    expect(spoken).toEqual(["a 40,000 rupee refund"]);
  });

  it("prefers a recording in the voice directory, without touching the engine", async () => {
    const recording = join(voiceDir, "sc2.wav");
    writeFileSync(recording, "RIFF");
    const clip = await provider()("sc2", "anything");
    expect(clip).toEqual({ path: recording, source: "recorded" });
    expect(spoken).toEqual([]);
  });

  it("uses a recording for one scene and the engine for the next", async () => {
    writeFileSync(join(voiceDir, "sc2.wav"), "RIFF");
    const voice = provider();
    expect((await voice("sc2", "one"))?.source).toBe("recorded");
    expect((await voice("sc3", "two"))?.source).toBe("fake 1");
  });

  it("speaks the same words once", async () => {
    const voice = provider();
    const first = await voice("sc2", "same words");
    const second = await voice("sc2", "same words");
    expect(second?.path).toBe(first?.path);
    expect(spoken).toHaveLength(1);
  });

  it("speaks again when the words change, as when a number lands in RESULTS.md", async () => {
    const voice = provider();
    const first = await voice("numbers", "prevented: pending");
    const second = await voice("numbers", "prevented: 24");
    expect(second?.path).not.toBe(first?.path);
    expect(spoken).toEqual(["prevented: pending", "prevented: 24"]);
  });

  it("speaks again when the engine changes", async () => {
    await provider()("sc2", "words");
    await provider({ engine: "fake 2" })("sc2", "words");
    expect(spoken).toHaveLength(2);
  });

  it("returns nothing and says why, once, when there's no engine", async () => {
    const voice = provider({ engineProblem: () => "no piper here" });
    expect(await voice("sc2", "one")).toBeUndefined();
    expect(await voice("sc3", "two")).toBeUndefined();
    expect(logs).toEqual(["no TTS: no piper here"]);
  });

  it("still takes a recording when there's no engine", async () => {
    writeFileSync(join(voiceDir, "sc2.wav"), "RIFF");
    const voice = provider({ engineProblem: () => "no piper here" });
    expect((await voice("sc2", "one"))?.source).toBe("recorded");
  });

  it("lets an engine failure stop the build rather than silently lose a line", async () => {
    const voice = provider({
      speak: async () => {
        throw new Error("piper exited 1");
      },
    });
    await expect(voice("sc2", "one")).rejects.toThrow(/piper exited 1/);
  });
});

describe("piperProblem", () => {
  it("says how to fix a missing engine or voice", () => {
    expect(
      piperProblem({
        bin: "/nope/piper",
        model: "/nope/m.onnx",
        lengthScale: 1,
        sentenceSilenceS: 0,
      }),
    ).toMatch(/uv tool install piper-tts/);
    const self = process.execPath;
    expect(
      piperProblem({ bin: self, model: "/nope/m.onnx", lengthScale: 1, sentenceSilenceS: 0 }),
    ).toMatch(/download_voices/);
    expect(
      piperProblem({ bin: self, model: self, lengthScale: 1, sentenceSilenceS: 0 }),
    ).toBeUndefined();
  });
});
