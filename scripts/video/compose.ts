/**
 * Turns one planned scene into one mp4 with ffmpeg, then joins them, normalises loudness, and checks the
 * result. One ffmpeg at a time: this host has run out of memory before.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Where things go on a 1920x1080 frame. Footage sits above a caption band that nothing else uses, so a
 * caption can never cover the box a persona is typing in, nor the card they're reading.
 */
export const FRAME = {
  width: 1920,
  height: 1080,
  fps: 30,
  background: "0x0f1115",
  footage: { x: 160, y: 14, width: 1600, height: 900 },
  splitGap: 16,
} as const;

export const VOICE_DELAY_S = 0.25;
export const VOICE_TAIL_S = 0.45;
export const DEFAULT_MAX_SPEED = 6;

/** A scene lasts as long as the plan says, and longer if the voice-over needs it. */
export function sceneDuration(plannedS: number, voiceS: number): number {
  return voiceS > 0 ? Math.max(plannedS, VOICE_DELAY_S + voiceS + VOICE_TAIL_S) : plannedS;
}

export interface ClipFit {
  /** Playback speed to apply. Above 1 is a speed-up, and it gets labelled on screen. */
  speed: number;
  /** How long the last frame holds after the clip ends. */
  holdS: number;
}

/** Fits footage to a scene's length: speed up if too long, hold the last frame if too short. */
export function fitClip(clipS: number, durationS: number, maxSpeed: number, what: string): ClipFit {
  if (clipS <= durationS) return { speed: 1, holdS: durationS - clipS };
  const speed = clipS / durationS;
  if (speed > maxSpeed) {
    throw new Error(
      `${what} runs ${clipS.toFixed(1)} s but its scene is ${durationS.toFixed(1)} s, a ${speed.toFixed(1)}x speed-up. ` +
        `The limit is ${maxSpeed}x. Pick tighter segments in scenes.yaml.`,
    );
  }
  return { speed, holdS: 0 };
}

/** A speed a scene chooses, with the last frame held for whatever time is left. So the end of a clip can stay up to be read. */
export function fixedSpeed(
  clipS: number,
  durationS: number,
  speed: number,
  maxSpeed: number,
  what: string,
): ClipFit {
  if (speed > maxSpeed) throw new Error(`${what} asks for ${speed}x. The limit is ${maxSpeed}x.`);
  const playedS = clipS / speed;
  if (playedS > durationS) {
    throw new Error(
      `${what} runs ${playedS.toFixed(1)} s at ${speed}x but its scene is ${durationS.toFixed(1)} s. Pick tighter segments in scenes.yaml.`,
    );
  }
  return { speed, holdS: durationS - playedS };
}

/** The honest label for a speed-up, or none below a difference anyone would see. */
export function playbackLabel(speed: number): string | undefined {
  return speed >= 1.1 ? `playback ${speed.toFixed(1)}x` : undefined;
}

export interface FootageInput {
  path: string;
  /** Parts to keep, in order, in seconds. */
  segments: { fromS: number; toS: number }[];
  fit: ClipFit;
  box: { width: number; height: number };
  /** The part of the frame to keep, in the clip's own pixels. Cutting the sidebar is what makes a card readable. */
  crop?: { x: number; y: number; width: number; height: number };
}

/** Filters that take input `index` to a labelled stream of exactly `durationS`, fitted inside its box. */
export function footageFilter(
  index: number,
  input: FootageInput,
  durationS: number,
  out: string,
): string {
  const parts: string[] = [];
  input.segments.forEach((segment, i) => {
    parts.push(
      `[${index}:v]trim=start=${segment.fromS.toFixed(3)}:end=${segment.toS.toFixed(3)},setpts=PTS-STARTPTS[${out}s${i}]`,
    );
  });
  let stream: string;
  if (input.segments.length === 1) {
    stream = `[${out}s0]`;
  } else {
    const labels = input.segments.map((_, i) => `[${out}s${i}]`).join("");
    parts.push(`${labels}concat=n=${input.segments.length}:v=1:a=0[${out}joined]`);
    stream = `[${out}joined]`;
  }
  const { width, height } = input.box;
  const steps = [
    `setpts=(PTS-STARTPTS)/${input.fit.speed.toFixed(6)}`,
    `fps=${FRAME.fps}`,
    `tpad=stop_mode=clone:stop_duration=${input.fit.holdS.toFixed(3)}`,
    `trim=duration=${durationS.toFixed(3)}`,
    "setpts=PTS-STARTPTS",
    ...(input.crop ? [`crop=${input.crop.width}:${input.crop.height}:${input.crop.x}:${input.crop.y}`] : []),
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${FRAME.background}`,
    "setsar=1",
  ];
  parts.push(`${stream}${steps.join(",")}[${out}]`);
  return parts.join(";");
}

export interface SceneRender {
  durationS: number;
  output: string;
  /** Relative to `workDir`, because the ass filter's own path escaping is best not relied on. */
  assFile: string;
  workDir: string;
  footage?: FootageInput[];
  image?: string;
  voice?: string;
}

/** The ffmpeg command for one scene. Pure, so its shape can be tested without running it. */
export function sceneCommand(scene: SceneRender): string[] {
  const inputs: string[] = [];
  const filters: string[] = [];
  const duration = scene.durationS.toFixed(3);
  let inputCount = 0;
  let picture: string;

  filters.push(
    `color=c=${FRAME.background}:s=${FRAME.width}x${FRAME.height}:r=${FRAME.fps}:d=${duration}[canvas]`,
  );
  if (scene.image) {
    inputs.push("-loop", "1", "-framerate", String(FRAME.fps), "-t", duration, "-i", scene.image);
    inputCount += 1;
    filters.push(`[0:v]scale=${FRAME.width}:${FRAME.height},setsar=1,fps=${FRAME.fps}[card]`);
    filters.push("[canvas][card]overlay=0:0:shortest=1[picture]");
    picture = "[picture]";
  } else {
    const footage = scene.footage ?? [];
    const { x, y, width } = FRAME.footage;
    let under = "[canvas]";
    footage.forEach((input, index) => {
      inputs.push("-i", input.path);
      inputCount += 1;
      filters.push(footageFilter(index, input, scene.durationS, `f${index}`));
      const offset =
        footage.length === 1
          ? x + (width - input.box.width) / 2
          : x + index * (input.box.width + FRAME.splitGap);
      const over = `layer${index}`;
      filters.push(`${under}[f${index}]overlay=${offset}:${y}:shortest=1[${over}]`);
      under = `[${over}]`;
    });
    picture = under;
  }
  filters.push(
    `${picture}ass=filename=${scene.assFile},fade=t=in:st=0:d=0.2,format=yuv420p[video]`,
  );

  if (scene.voice) {
    const index = inputCount;
    inputs.push("-i", scene.voice);
    const delay = Math.round(VOICE_DELAY_S * 1000);
    filters.push(
      `[${index}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}:all=1,apad,atrim=0:${duration},asetpts=PTS-STARTPTS[audio]`,
    );
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${duration},asetpts=PTS-STARTPTS[audio]`);
  }

  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[video]",
    "-map",
    "[audio]",
    "-t",
    duration,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-r",
    String(FRAME.fps),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-threads",
    "8",
    scene.output,
  ];
}

export async function runFfmpeg(args: string[], cwd?: string): Promise<{ stderr: string }> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", args, {
      cwd,
      maxBuffer: MAX_OUTPUT,
      timeout: 1_800_000,
    });
    return { stderr };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`ffmpeg failed: ${stderr.trim().slice(-1500) || (error as Error).message}`);
  }
}

export async function renderScene(scene: SceneRender): Promise<void> {
  await runFfmpeg(sceneCommand(scene), scene.workDir);
}

export async function concatScenes(
  files: string[],
  output: string,
  workDir: string,
): Promise<void> {
  const list = join(workDir, "concat.txt");
  writeFileSync(list, files.map((file) => `file '${file}'`).join("\n") + "\n");
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c",
    "copy",
    output,
  ]);
}

const LOUDNORM = { I: -16, TP: -1.5, LRA: 11 };

const LoudnessSchema = z.object({
  input_i: z.string(),
  input_tp: z.string(),
  input_lra: z.string(),
  input_thresh: z.string(),
  target_offset: z.string(),
});
export type Loudness = z.infer<typeof LoudnessSchema>;

/** Reads the JSON block loudnorm prints at the end of its run. */
export function parseLoudnorm(stderr: string): Loudness {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm printed no measurement");
  return LoudnessSchema.parse(JSON.parse(stderr.slice(start, end + 1)));
}

export function isSilent(loudness: Loudness): boolean {
  const value = Number(loudness.input_i);
  return !Number.isFinite(value) || value <= -70;
}

export async function measureLoudness(file: string): Promise<Loudness> {
  const { stderr } = await runFfmpeg([
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-af",
    `loudnorm=I=${LOUDNORM.I}:TP=${LOUDNORM.TP}:LRA=${LOUDNORM.LRA}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  return parseLoudnorm(stderr);
}

/**
 * Two-pass EBU R128 normalisation of the audio; the video is copied untouched. A silent track can't be
 * normalised, and the caller is told, because a video with no voice shouldn't look finished.
 */
export async function normaliseLoudness(
  input: string,
  output: string,
): Promise<{ measured: Loudness; silent: boolean }> {
  const measured = await measureLoudness(input);
  const silent = isSilent(measured);
  const audio = silent
    ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    : [
        "-af",
        `loudnorm=I=${LOUDNORM.I}:TP=${LOUDNORM.TP}:LRA=${LOUDNORM.LRA}` +
          `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}` +
          `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true,aresample=48000`,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
      ];
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-c:v",
    "copy",
    ...audio,
    "-movflags",
    "+faststart",
    output,
  ]);
  return { measured, silent };
}

const ProbeSchema = z.object({
  format: z.object({ duration: z.string().optional() }),
  streams: z.array(
    z
      .object({
        codec_type: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        r_frame_rate: z.string().optional(),
        sample_rate: z.string().optional(),
        duration: z.string().optional(),
      })
      .passthrough(),
  ),
});

export interface MediaInfo {
  durationS: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  audioSampleRate?: number;
}

function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [top, bottom] = rate.split("/").map(Number);
  return top && bottom ? top / bottom : undefined;
}

export function parseProbe(json: string): MediaInfo {
  const parsed = ProbeSchema.parse(JSON.parse(json));
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams.find((stream) => stream.codec_type === "audio");
  return {
    durationS: Number(parsed.format.duration ?? video?.duration ?? audio?.duration ?? 0),
    width: video?.width,
    height: video?.height,
    fps: parseRate(video?.r_frame_rate),
    hasAudio: Boolean(audio),
    audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
  };
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { maxBuffer: MAX_OUTPUT },
  );
  return parseProbe(stdout);
}

export interface FinalLimits {
  maxDurationS: number;
  width: number;
  height: number;
  fps: number;
}

/** Everything wrong with the finished file. An empty list is the only passing answer. */
export function checkFinal(info: MediaInfo, limits: FinalLimits): string[] {
  const problems: string[] = [];
  if (info.durationS >= limits.maxDurationS) {
    problems.push(
      `DURATION ${info.durationS.toFixed(1)} s is over the ${limits.maxDurationS} s limit by ${(
        info.durationS - limits.maxDurationS
      ).toFixed(1)} s`,
    );
  }
  if (info.durationS <= 0) problems.push("the file has no duration");
  if (info.width !== limits.width || info.height !== limits.height) {
    problems.push(
      `resolution is ${info.width}x${info.height}, expected ${limits.width}x${limits.height}`,
    );
  }
  if (info.fps === undefined || Math.abs(info.fps - limits.fps) > 0.01) {
    problems.push(`frame rate is ${info.fps}, expected ${limits.fps}`);
  }
  if (!info.hasAudio) problems.push("the file has no audio stream");
  return problems;
}
