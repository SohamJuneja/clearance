/**
 * The declarative storyboard: scripts/video/scenes.yaml, checked strictly so a typo fails the build
 * rather than quietly dropping a caption or a label.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const TimePoint = z.union([z.number().nonnegative(), z.string().min(1)]);

const SegmentSchema = z.object({ from: TimePoint, to: TimePoint }).strict();

const SourceSchema = z
  .object({
    /** Relative to docs/media/raw/, for example `takes/SC3/latest/priya.mp4`. */
    clip: z.string().min(1),
    /** Which parts to keep, in seconds or by the name of a scenario step (see marks.json). Default: all. */
    segments: z.array(SegmentSchema).optional(),
    /** Play at this speed and hold the last frame for the rest. Default: whatever speed fills the scene. */
    speed: z.number().positive().optional(),
    /** The part of the frame to keep, in the clip's own pixels. */
    crop: z
      .object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();
export type SourceSpec = z.infer<typeof SourceSchema>;

const Common = {
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Length in PLAN 12. The floor for this scene; it grows if the voice-over needs longer. */
  planned_s: z.number().positive(),
  /** Read as written. `{{E1.clearance}}` pulls a cell from RESULTS.md at build time. */
  voiceover: z.string().optional(),
  notices: z.array(z.string()).optional(),
  callouts: z.array(z.string()).optional(),
  /** A callout for part of a scene, between two steps of its first clip. No `from` is the scene's start, no `to` its end. */
  timed_callouts: z
    .array(
      z
        .object({ text: z.string().min(1), from: z.string().min(1).optional(), to: z.string().min(1).optional() })
        .strict(),
    )
    .optional(),
  clock10x: z.boolean().optional(),
};

const ClipScene = z
  .object({
    ...Common,
    kind: z.literal("clip"),
    source: SourceSchema,
    /** Past this speed-up the build fails and asks for tighter segments. */
    max_speed: z.number().positive().optional(),
  })
  .strict();

const SplitScene = z
  .object({
    ...Common,
    kind: z.literal("split"),
    sources: z.tuple([SourceSchema, SourceSchema]),
    max_speed: z.number().positive().optional(),
    /**
     * What this scene is while `missing` has no footage: one clip at full width, with its own caption and voice-over, so
     * neither says what wasn't recorded. The split comes back by itself once the footage exists.
     */
    alone: z
      .object({
        missing: z.string().min(1),
        source: SourceSchema,
        callouts: z.array(z.string()).optional(),
        voiceover: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const CardScene = z
  .object({
    ...Common,
    kind: z.literal("card"),
    headline: z.string().min(1),
    lines: z.array(z.string()).optional(),
    /** A still under the lines, relative to docs/media/raw/. `pnpm video:desk` takes the Desk's. */
    image: z.string().min(1).optional(),
  })
  .strict();

const NumbersScene = z
  .object({
    ...Common,
    kind: z.literal("numbers"),
    headline: z.string().min(1),
    /** Row selectors into RESULTS.md: `E1`, `E2/risky`. `E2/risky?` shows only once that row has a result. */
    rows: z.array(z.string()).min(1),
  })
  .strict();

const SceneSchema = z.discriminatedUnion("kind", [ClipScene, SplitScene, CardScene, NumbersScene]);
export type Scene = z.infer<typeof SceneSchema>;

/** A number that doesn't come from RESULTS.md, and where it does come from. Anything else fails the build. */
const CitedSchema = z
  .object({
    value: z.string().min(1),
    source: z.string().min(1),
    /** Scenes it may appear in. Without this, any. */
    only_in: z.array(z.string()).optional(),
  })
  .strict();

const StoryboardSchema = z
  .object({
    max_duration_s: z.number().positive(),
    default_notices: z.array(z.string()).default([]),
    cited: z.array(CitedSchema).default([]),
    /**
     * The scene that ends on Clearance's refusal, and how early that has to be. `seen` is the label the recorder writes
     * when the refusal's text is really visible in the page: see `watch` in scripts/demo/runner.ts.
     */
    first_refusal: z
      .object({ scene: z.string(), within_s: z.number().positive(), seen: z.string().min(1).optional() })
      .strict()
      .optional(),
    scenes: z.array(SceneSchema).min(1),
  })
  .strict();
export type Storyboard = z.infer<typeof StoryboardSchema>;

export function parseStoryboard(yamlText: string): Storyboard {
  const parsed = StoryboardSchema.safeParse(parse(yamlText));
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`the storyboard is invalid:\n${problems}`);
  }
  const ids = parsed.data.scenes.map((scene) => scene.id);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeated.length > 0)
    throw new Error(`the storyboard repeats scene ids: ${repeated.join(", ")}`);
  return parsed.data;
}

/** The board as it can be built today: a split with an `alone` and no footage for one side becomes that clip. */
export function settleScenes(board: Storyboard, hasFootage: (clip: string) => boolean): Storyboard {
  return {
    ...board,
    scenes: board.scenes.map((scene) => {
      if (scene.kind !== "split" || !scene.alone || hasFootage(scene.alone.missing)) return scene;
      const { id, planned_s, notices, clock10x, max_speed, alone } = scene;
      return {
        id,
        kind: "clip",
        planned_s,
        notices,
        clock10x,
        max_speed,
        source: alone.source,
        callouts: alone.callouts,
        voiceover: alone.voiceover,
      };
    }),
  };
}

/** Seconds into the video a scene starts. Planned lengths unless told what each scene really came to. */
export function sceneOffset(
  board: Storyboard,
  sceneId: string,
  durationOf: (scene: Scene) => number = (scene) => scene.planned_s,
): number {
  const index = board.scenes.findIndex((scene) => scene.id === sceneId);
  if (index < 0) throw new Error(`the storyboard has no scene ${sceneId}`);
  return board.scenes.slice(0, index).reduce((sum, scene) => sum + durationOf(scene), 0);
}

/**
 * How far into the video the refusal is on screen at the latest: where its scene ends, since that scene ends on it. Its
 * real moment is a little earlier, but this is the number that can be promised before there's footage.
 */
export function refusalOnScreenBy(
  board: Storyboard,
  durationOf: (scene: Scene) => number = (scene) => scene.planned_s,
): number | undefined {
  const wanted = board.first_refusal;
  if (!wanted) return undefined;
  const scene = board.scenes.find((one) => one.id === wanted.scene);
  if (!scene) throw new Error(`first_refusal names ${wanted.scene}, which isn't a scene`);
  return sceneOffset(board, wanted.scene, durationOf) + durationOf(scene);
}

/** What's wrong with when the refusal appears, or undefined if nothing is. */
export function refusalProblem(
  board: Storyboard,
  durationOf?: (scene: Scene) => number,
): string | undefined {
  const by = refusalOnScreenBy(board, durationOf);
  const limit = board.first_refusal?.within_s;
  if (by === undefined || limit === undefined || by <= limit) return undefined;
  return `Clearance's refusal is on screen by ${by.toFixed(1)} s, past the ${limit} s limit. Tighten the voice-over before it`;
}

export function loadStoryboard(path: string): Storyboard {
  return parseStoryboard(readFileSync(path, "utf8"));
}

export interface Mark {
  label: string;
  t: number;
}

/** The recorder's own record that some text was visible in a persona's page, in seconds into that persona's clip. */
export const SeenRecord = z.object({ label: z.string(), persona: z.string(), t: z.number() });
export type SeenRecord = z.infer<typeof SeenRecord>;

export function readSeen(clipPath: string): SeenRecord[] {
  const file = join(dirname(clipPath), "seen.json");
  if (!existsSync(file)) return [];
  return z.array(SeenRecord).parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Where a moment of a clip lands in its scene, or undefined if the scene's segments cut it. */
export function clipToScene(
  t: number,
  segments: { fromS: number; toS: number }[],
  speed: number,
): number | undefined {
  let kept = 0;
  for (const segment of segments) {
    if (t >= segment.fromS && t <= segment.toS) return (kept + t - segment.fromS) / speed;
    kept += segment.toS - segment.fromS;
  }
  return undefined;
}

export interface TimedCallout {
  text: string;
  startS: number;
  endS: number;
}

/** When each timed callout shows in its scene. A step the scene's segments cut is an error, not a callout at the wrong time. */
export function timeCallouts(
  callouts: { text: string; from?: string; to?: string }[],
  footage: { segments: { fromS: number; toS: number }[]; speed: number; marks: Mark[]; clip: string },
  durationS: number,
): TimedCallout[] {
  const inScene = (step: string): number => {
    const at = clipToScene(resolvePoint(step, footage.marks, footage.clip), footage.segments, footage.speed);
    if (at === undefined) throw new Error(`a callout names "${step}", which this scene's segments cut`);
    return at;
  };
  return callouts.map(({ text, from, to }) => ({
    text,
    startS: from === undefined ? 0 : inScene(from),
    endS: to === undefined ? durationS : inScene(to),
  }));
}

export interface SeenFootage {
  path: string;
  segments: { fromS: number; toS: number }[];
  speed: number;
}

/**
 * When the video really shows the refusal, from the recorder's record of it, and what's wrong with that if anything. A
 * take with no record fails: without one this is only a guess from where the scene ends, and that guess has been wrong.
 */
export function seenInVideo(options: {
  label: string;
  withinS: number;
  sceneStartS: number;
  footage: SeenFootage[];
  readRecords?: (path: string) => SeenRecord[];
}): { atS?: number; problem?: string } {
  const read = options.readRecords ?? readSeen;
  const records = options.footage.flatMap((source) =>
    read(source.path)
      .filter((record) => record.label === options.label && `${record.persona}.mp4` === basename(source.path))
      .map((record) => ({ record, source })),
  );
  const where = options.footage.map((source) => dirname(source.path)).join(", ");
  if (records.length === 0) {
    return { problem: `${where} has no record of "${options.label}" being visible. Re-record that take.` };
  }
  const mapped = records.flatMap(({ record, source }) => {
    const inScene = clipToScene(record.t, source.segments, source.speed);
    return inScene === undefined ? [] : [options.sceneStartS + inScene];
  });
  if (mapped.length === 0) {
    const at = records[0]?.record.t.toFixed(1);
    return { problem: `"${options.label}" was visible ${at} s into its clip, which this scene's segments cut.` };
  }
  const atS = Math.min(...mapped);
  return atS > options.withinS
    ? { atS, problem: `"${options.label}" is visible at ${atS.toFixed(2)} s, past the ${options.withinS} s limit.` }
    : { atS };
}

/** A point in a clip: seconds as given, or the moment a scenario step began, from the take's marks. */
export function resolvePoint(point: number | string, marks: Mark[], clip: string): number {
  if (typeof point === "number") return point;
  const mark = marks.find((candidate) => candidate.label === point);
  if (!mark) {
    const known = marks.map((candidate) => `"${candidate.label}"`).join(", ") || "none";
    throw new Error(`${clip} has no mark "${point}". Its marks: ${known}`);
  }
  return mark.t;
}

export function readMarks(clipPath: string): Mark[] {
  const file = join(dirname(clipPath), "marks.json");
  if (!existsSync(file)) return [];
  return z
    .array(z.object({ label: z.string(), t: z.number() }))
    .parse(JSON.parse(readFileSync(file, "utf8")));
}

/** The command that would produce a missing clip, read off its path. */
export function recordingHint(clip: string): string {
  const scenario = clip.match(/takes\/(SC[A-Z0-9]+)\//)?.[1];
  return scenario ? `pnpm demo:run ${scenario} --record` : `provide ${clip}`;
}

export function sourcesOf(scene: Scene): SourceSpec[] {
  if (scene.kind === "clip") return [scene.source];
  if (scene.kind === "split") return scene.sources;
  return [];
}
