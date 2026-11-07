/**
 * `pnpm video:social` cuts the #HowISwitch clips from the same takes, with the same labels, through the same build. So a
 * clip can't lose "persona actions are scripted" or a scene's own caption, and its numbers pass the same check. Writes
 * docs/media/social/. docs/build/social-draft.md says which clip goes with which post.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { REPO_ROOT } from "../../eval/lib/paths.ts";
import { buildVideo, printReport } from "./build.ts";
import { RAW_MEDIA } from "./capture.ts";
import { loadStoryboard, type Storyboard } from "./scenes.ts";
import { voiceProvider } from "./voice.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The posts' limit, which the build holds each clip to. */
export const CLIP_LIMIT_S = 45;

export const CLIPS = [
  { name: "post-1", scenes: ["sc2", "sc3-refused", "sc3-sam"] },
  { name: "post-2", scenes: ["sc9"] },
] as const;

/** The storyboard for one clip: these scenes as they are in the video, under the posts' limit. */
export function clipBoard(board: Storyboard, ids: readonly string[]): Storyboard {
  const scenes = ids.map((id) => {
    const scene = board.scenes.find((one) => one.id === id);
    if (!scene) throw new Error(`the storyboard has no scene ${id}`);
    return scene;
  });
  const refusal = board.first_refusal;
  return {
    ...board,
    max_duration_s: CLIP_LIMIT_S,
    scenes,
    first_refusal: refusal && ids.includes(refusal.scene) ? refusal : undefined,
  };
}

async function main(): Promise<number> {
  const log = (line: string): void => void process.stdout.write(`${line}\n`);
  const board = loadStoryboard(join(here, "scenes.yaml"));
  const outputDir = join(REPO_ROOT, "docs/media/social");
  mkdirSync(outputDir, { recursive: true });
  let status = 0;
  for (const clip of CLIPS) {
    const workDir = join(RAW_MEDIA, "build-social", clip.name);
    mkdirSync(workDir, { recursive: true });
    const scenesPath = join(workDir, "scenes.yaml");
    const { first_refusal: refusal, ...rest } = clipBoard(board, clip.scenes);
    writeFileSync(scenesPath, stringify(refusal ? { ...rest, first_refusal: refusal } : rest));
    log(`\n${clip.name}: ${clip.scenes.join(", ")}`);
    const report = await buildVideo({
      scenesPath,
      resultsPath: join(REPO_ROOT, "RESULTS.md"),
      output: join(outputDir, `${clip.name}.mp4`),
      workDir,
      mediaRoot: RAW_MEDIA,
      allowMissing: false,
      voice: voiceProvider({ overrideDir: join(here, "voice"), cacheDir: join(workDir, "tts"), log }),
      log,
    });
    status = Math.max(status, printReport(report, log));
  }
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`video:social failed: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
