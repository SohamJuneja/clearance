import { describe, expect, it } from "vitest";
import {
  checkFinal,
  DEFAULT_MAX_SPEED,
  fitClip,
  fixedSpeed,
  footageFilter,
  FRAME,
  isSilent,
  parseLoudnorm,
  parseProbe,
  playbackLabel,
  sceneCommand,
  sceneDuration,
  VOICE_DELAY_S,
  VOICE_TAIL_S,
} from "./compose.ts";

describe("sceneDuration", () => {
  it("keeps the planned length when the voice fits inside it", () => {
    expect(sceneDuration(34, 18)).toBe(34);
  });

  it("grows to fit a voice that runs longer than the plan", () => {
    expect(sceneDuration(8, 12)).toBeCloseTo(12 + VOICE_DELAY_S + VOICE_TAIL_S);
  });

  it("keeps the planned length with no voice", () => {
    expect(sceneDuration(9, 0)).toBe(9);
  });
});

describe("fixedSpeed", () => {
  it("plays at the speed asked for and holds the last frame for the rest", () => {
    expect(fixedSpeed(30, 8, 6, DEFAULT_MAX_SPEED, "x")).toEqual({ speed: 6, holdS: 3 });
  });

  it("refuses a speed over the limit, and footage that still won't fit", () => {
    expect(() => fixedSpeed(30, 8, 7, DEFAULT_MAX_SPEED, "x")).toThrow(/asks for 7x/);
    expect(() => fixedSpeed(60, 8, 6, DEFAULT_MAX_SPEED, "x")).toThrow(/runs 10\.0 s at 6x/);
  });
});

describe("fitClip", () => {
  it("holds the last frame when footage is shorter than the scene", () => {
    expect(fitClip(5, 8, DEFAULT_MAX_SPEED, "x")).toEqual({ speed: 1, holdS: 3 });
  });

  it("speeds up footage longer than the scene, exactly to fit", () => {
    const fit = fitClip(16, 8, DEFAULT_MAX_SPEED, "x");
    expect(fit.speed).toBe(2);
    expect(fit.holdS).toBe(0);
  });

  it("refuses a speed-up nobody could follow, and says what to do", () => {
    expect(() => fitClip(120, 8, DEFAULT_MAX_SPEED, "sc2: priya.mp4")).toThrow(
      /sc2: priya\.mp4.*15\.0x.*segments/,
    );
  });
});

describe("playbackLabel", () => {
  it("labels a visible speed-up, honestly", () => {
    expect(playbackLabel(2.34)).toBe("playback 2.3x");
  });

  it("stays quiet at normal speed", () => {
    expect(playbackLabel(1)).toBeUndefined();
    expect(playbackLabel(1.05)).toBeUndefined();
  });
});

describe("footageFilter", () => {
  const input = {
    path: "/raw/a.mp4",
    segments: [{ fromS: 1, toS: 4 }],
    fit: { speed: 1, holdS: 2 },
    box: { width: 1600, height: 900 },
  };

  it("trims, holds, cuts to length and fits the box", () => {
    const filter = footageFilter(0, input, 5, "f0");
    expect(filter).toContain("trim=start=1.000:end=4.000");
    expect(filter).toContain("tpad=stop_mode=clone:stop_duration=2.000");
    expect(filter).toContain("trim=duration=5.000");
    expect(filter).toContain("scale=1600:900:force_original_aspect_ratio=decrease");
    expect(filter).toContain("pad=1600:900");
    expect(filter.endsWith("[f0]")).toBe(true);
  });

  it("joins several segments in order", () => {
    const filter = footageFilter(
      1,
      {
        ...input,
        segments: [
          { fromS: 0, toS: 1 },
          { fromS: 9, toS: 10 },
        ],
      },
      5,
      "f1",
    );
    expect(filter).toContain("[1:v]trim=start=9.000");
    expect(filter).toContain("[f1s0][f1s1]concat=n=2:v=1:a=0[f1joined]");
  });
});

describe("the frame", () => {
  it("leaves a caption band below the footage, so captions can't cover the message box", () => {
    const bottom = FRAME.footage.y + FRAME.footage.height;
    expect(FRAME.height - bottom).toBeGreaterThanOrEqual(150);
  });
});

describe("sceneCommand", () => {
  const base = { durationS: 6, output: "/out/s.mp4", assFile: "s.ass", workDir: "/work" };
  const footage = {
    path: "/raw/a.mp4",
    segments: [{ fromS: 0, toS: 5 }],
    fit: { speed: 1, holdS: 1 },
    box: { width: 1600, height: 900 },
  };
  const graph = (args: string[]): string => args[args.indexOf("-filter_complex") + 1] ?? "";

  it("makes silence when there's no voice, so every scene has audio to join", () => {
    const args = sceneCommand({ ...base, footage: [footage] });
    expect(graph(args)).toContain("anullsrc=r=48000:cl=stereo");
  });

  it("delays the voice and pads it to the scene's length", () => {
    const args = sceneCommand({ ...base, footage: [footage], voice: "/voice/s.wav" });
    expect(args).toContain("/voice/s.wav");
    expect(graph(args)).toContain("[1:a]aresample=48000");
    expect(graph(args)).toContain(`adelay=${VOICE_DELAY_S * 1000}:all=1`);
    expect(graph(args)).toContain("atrim=0:6.000");
  });

  it("places split footage side by side inside the footage area", () => {
    const half = { ...footage, box: { width: 792, height: 900 } };
    const args = sceneCommand({ ...base, footage: [half, half], voice: "/voice/s.wav" });
    expect(graph(args)).toContain("overlay=160:14");
    expect(graph(args)).toContain("overlay=968:14");
    expect(graph(args)).toContain("[2:a]aresample");
  });

  it("uses a card as a full frame", () => {
    const args = sceneCommand({ ...base, image: "/work/title.png" });
    expect(args).toContain("-loop");
    expect(graph(args)).toContain("overlay=0:0");
  });

  it("burns the scene's captions in", () => {
    expect(graph(sceneCommand({ ...base, footage: [footage] }))).toContain("ass=filename=s.ass");
  });

  it("encodes at the output frame rate with yuv420p and AAC at 48 kHz", () => {
    const args = sceneCommand({ ...base, footage: [footage] });
    expect(args).toEqual(
      expect.arrayContaining(["-r", "30", "-pix_fmt", "yuv420p", "-ar", "48000"]),
    );
  });
});

describe("checkFinal", () => {
  const limits = { maxDurationS: 180, width: 1920, height: 1080, fps: 30 };
  const good = { durationS: 170, width: 1920, height: 1080, fps: 30, hasAudio: true };

  it("passes a good file", () => {
    expect(checkFinal(good, limits)).toEqual([]);
  });

  it("fails loudly at or over the limit, saying by how much", () => {
    expect(checkFinal({ ...good, durationS: 180 }, limits)[0]).toMatch(/DURATION 180\.0 s is over/);
    expect(checkFinal({ ...good, durationS: 183.5 }, limits)[0]).toMatch(/by 3\.5 s/);
  });

  it("fails on wrong resolution, frame rate or no audio", () => {
    expect(checkFinal({ ...good, width: 1280, height: 720 }, limits)[0]).toMatch(/1280x720/);
    expect(checkFinal({ ...good, fps: 25 }, limits)[0]).toMatch(/frame rate/);
    expect(checkFinal({ ...good, hasAudio: false }, limits)[0]).toMatch(/no audio/);
  });
});

describe("parseProbe", () => {
  it("reads what the final check needs from ffprobe's JSON", () => {
    const info = parseProbe(
      JSON.stringify({
        format: { duration: "170.5" },
        streams: [
          { codec_type: "video", width: 1920, height: 1080, r_frame_rate: "30/1" },
          { codec_type: "audio", sample_rate: "48000" },
        ],
      }),
    );
    expect(info).toEqual({
      durationS: 170.5,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      audioSampleRate: 48000,
    });
  });

  it("notices a file with no audio", () => {
    const info = parseProbe(
      JSON.stringify({ format: { duration: "1" }, streams: [{ codec_type: "video" }] }),
    );
    expect(info.hasAudio).toBe(false);
  });
});

describe("loudnorm output", () => {
  const stderr = `[Parsed_loudnorm_0 @ 0x1]
{
  "input_i" : "-23.54",
  "input_tp" : "-7.88",
  "input_lra" : "1.20",
  "input_thresh" : "-33.86",
  "output_i" : "-16.08",
  "target_offset" : "0.08"
}
`;

  it("is parsed from the end of ffmpeg's stderr", () => {
    expect(parseLoudnorm(stderr).input_i).toBe("-23.54");
  });

  it("fails when there is no measurement", () => {
    expect(() => parseLoudnorm("nothing here")).toThrow(/no measurement/);
  });

  it("knows a silent track", () => {
    expect(isSilent({ ...parseLoudnorm(stderr), input_i: "-inf" })).toBe(true);
    expect(isSilent({ ...parseLoudnorm(stderr), input_i: "-70.00" })).toBe(true);
    expect(isSilent(parseLoudnorm(stderr))).toBe(false);
  });
});
