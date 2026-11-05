/**
 * The declarative storyboard: scripts/video/scenes.yaml, checked strictly so a typo fails the build
 * rather than quietly dropping a caption or a label.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  })
  .strict();

const CardScene = z
  .object({
    ...Common,
    kind: z.literal("card"),
    headline: z.string().min(1),
    lines: z.array(z.string()).optional(),
  })
  .strict();

const NumbersScene = z
  .object({
    ...Common,
    kind: z.literal("numbers"),
    headline: z.string().min(1),
    /** Row selectors into RESULTS.md: `E1`, `E2/risky`. */
    rows: z.array(z.string()).min(1),
  })
  .strict();

const SceneSchema = z.discriminatedUnion("kind", [ClipScene, SplitScene, CardScene, NumbersScene]);
export type Scene = z.infer<typeof SceneSchema>;

const StoryboardSchema = z
  .object({
    max_duration_s: z.number().positive(),
    default_notices: z.array(z.string()).default([]),
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

export function loadStoryboard(path: string): Storyboard {
  return parseStoryboard(readFileSync(path, "utf8"));
}

export interface Mark {
  label: string;
  t: number;
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
  const scenario = clip.match(/takes\/(SC\d+)\//)?.[1];
  return scenario ? `pnpm demo:run ${scenario} --record` : `provide ${clip}`;
}

export function sourcesOf(scene: Scene): SourceSpec[] {
  if (scene.kind === "clip") return [scene.source];
  if (scene.kind === "split") return scene.sources;
  return [];
}
