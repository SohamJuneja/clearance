/**
 * Builds the video from scripts/video/scenes.yaml.
 *
 *   pnpm video:build                    the real thing; fails if any footage is missing
 *   pnpm video:build --allow-missing    slates instead of missing footage, to check timing and voice
 *
 * Numbers come from RESULTS.md at build time, or from a source declared under `cited` in the storyboard, and the build
 * fails on any other number it finds, and on a voice-over that still reads "pending". A voice for a scene comes from
 * scripts/video/voice/<scene>.wav if that file exists, else from offline TTS, else the scene is silent
 * and the build says so.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, setting } from "../../eval/lib/paths.ts";
import { assDocument, captionChunks, timeCues } from "./captions.ts";
import { ensureSourcedNumbers } from "./numbers.ts";
import { type CardToRender, cardHtml, numbersHtml, renderCards, slateHtml } from "./cards.ts";
import { RAW_MEDIA } from "./capture.ts";
import {
  checkFinal,
  concatScenes,
  DEFAULT_MAX_SPEED,
  fitClip,
  fixedSpeed,
  type FootageInput,
  FRAME,
  type MediaInfo,
  normaliseLoudness,
  playbackLabel,
  probeMedia,
  renderScene,
  sceneDuration,
  VOICE_DELAY_S,
} from "./compose.ts";
import { hasPending, parseResults, resolveTemplate, type ResultRow } from "./results.ts";
import {
  loadStoryboard,
  readMarks,
  recordingHint,
  refusalOnScreenBy,
  refusalProblem,
  resolvePoint,
  type Scene,
  sceneOffset,
  seenInVideo,
  settleScenes,
  type SourceSpec,
  sourcesOf,
  timeCallouts,
} from "./scenes.ts";

const here = dirname(fileURLToPath(import.meta.url));

export interface VoiceClip {
  path: string;
  source: string;
}

/** Finds or makes the speech for a scene's text. Nothing to say, or no way to say it, is undefined. */
export type VoiceProvider = (sceneId: string, text: string) => Promise<VoiceClip | undefined>;

export interface BuildOptions {
  scenesPath: string;
  resultsPath: string;
  output: string;
  workDir: string;
  mediaRoot: string;
  allowMissing: boolean;
  voice: VoiceProvider;
  log: (line: string) => void;
}

export interface SceneReport {
  id: string;
  kind: Scene["kind"];
  plannedS: number;
  durationS: number;
  voice: string;
  voiceover?: string;
  speedUps: string[];
  slated: boolean;
}

export interface BuildReport {
  output: string;
  scenes: SceneReport[];
  plannedS: number;
  /** When Clearance's refusal is on screen by, from what the scenes really came to. */
  refusalByS?: number;
  /** When the recorder saw the refusal's text in the page, mapped into the video. */
  refusalSeenS?: number;
  info: MediaInfo;
  loudnessInputI: string;
  silent: boolean;
  problems: string[];
  warnings: string[];
}

const REPO_URL = /\{\{\s*repo_url\s*\}\}/;

/**
 * Fills `{{repo_url}}` and any RESULTS.md cell. `[[if repo_url]]...[[/if]]` is only said once a repo URL is set, so the
 * voice-over can't point at a link that isn't on screen.
 */
export function fillText(
  text: string,
  rows: ResultRow[],
  repoUrl: string | undefined = setting("CLEARANCE_REPO_URL"),
): string {
  const kept = text.replace(/\s*\[\[if repo_url\]\]([\s\S]*?)\[\[\/if\]\]/g, (_all, body: string) =>
    repoUrl ? ` ${body}` : "",
  );
  return resolveTemplate(kept, rows).replace(new RegExp(REPO_URL, "g"), repoUrl ?? "");
}

/** A card's lines, without any that exist only to show a repo URL nobody has set. */
export function fillLines(
  lines: string[],
  rows: ResultRow[],
  repoUrl: string | undefined = setting("CLEARANCE_REPO_URL"),
): string[] {
  return lines
    .filter((line) => repoUrl || !REPO_URL.test(line))
    .map((line) => fillText(line, rows, repoUrl));
}

function clipPath(mediaRoot: string, source: SourceSpec): string {
  return resolve(mediaRoot, source.clip);
}

function boxFor(scene: Scene): { width: number; height: number } {
  if (scene.kind === "split") {
    return {
      width: (FRAME.footage.width - FRAME.splitGap) / 2,
      height: FRAME.footage.height,
    };
  }
  return { width: FRAME.footage.width, height: FRAME.footage.height };
}

async function footageFor(
  scene: Scene,
  mediaRoot: string,
  durationS: number,
): Promise<{ inputs: FootageInput[]; labels: string[] }> {
  const box = boxFor(scene);
  const inputs: FootageInput[] = [];
  const labels: string[] = [];
  const maxSpeed =
    (scene.kind === "clip" || scene.kind === "split" ? scene.max_speed : undefined) ??
    DEFAULT_MAX_SPEED;
  for (const source of sourcesOf(scene)) {
    const path = clipPath(mediaRoot, source);
    const media = await probeMedia(path);
    const marks = readMarks(path);
    // A step that had nothing to do, such as a card that never came, leaves a segment with no length.
    const segments = (source.segments ?? [{ from: 0, to: media.durationS }])
      .map((segment) => ({
        fromS: resolvePoint(segment.from, marks, source.clip),
        toS: resolvePoint(segment.to, marks, source.clip),
      }))
      .filter((segment) => segment.toS - segment.fromS > 0.05);
    if (segments.length === 0) throw new Error(`${scene.id}: ${source.clip} has no footage in its segments`);
    const clipS = segments.reduce((sum, segment) => sum + (segment.toS - segment.fromS), 0);
    const what = `${scene.id}: ${source.clip}`;
    const fit =
      source.speed === undefined
        ? fitClip(clipS, durationS, maxSpeed, what)
        : fixedSpeed(clipS, durationS, source.speed, maxSpeed, what);
    const label = playbackLabel(fit.speed);
    if (label && !labels.includes(label)) labels.push(label);
    inputs.push({ path, segments, fit, box, ...(source.crop ? { crop: source.crop } : {}) });
  }
  return { inputs, labels };
}

export async function buildVideo(options: BuildOptions): Promise<BuildReport> {
  const { log } = options;
  const written = loadStoryboard(options.scenesPath);
  ensureSourcedNumbers(written);
  const board = settleScenes(written, (clip) => existsSync(resolve(options.mediaRoot, clip)));
  const rows = parseResults(readFileSync(options.resultsPath, "utf8"));
  mkdirSync(options.workDir, { recursive: true });
  mkdirSync(dirname(options.output), { recursive: true });
  const warnings: string[] = [];
  const problems: string[] = [];
  for (const scene of written.scenes) {
    if (scene.kind === "split" && scene.alone && !existsSync(resolve(options.mediaRoot, scene.alone.missing))) {
      warnings.push(`${scene.id}: no ${scene.alone.missing} yet, so ${scene.alone.source.clip} runs alone`);
    }
  }

  // Find anything missing before the slow part, and name all of it at once.
  const missing = board.scenes.flatMap((scene) =>
    sourcesOf(scene)
      .filter((source) => !existsSync(clipPath(options.mediaRoot, source)))
      .map((source) => ({ scene, source })),
  );
  const missingStills = board.scenes.flatMap((scene) =>
    scene.kind === "card" && scene.image && !existsSync(resolve(options.mediaRoot, scene.image))
      ? [{ scene, image: scene.image }]
      : [],
  );
  if ((missing.length > 0 || missingStills.length > 0) && !options.allowMissing) {
    const lines = [
      ...missing.map(
        ({ scene, source }) => `  ${scene.id}: ${source.clip}  (${recordingHint(source.clip)})`,
      ),
      ...missingStills.map(({ scene, image }) => `  ${scene.id}: ${image}  (pnpm video:desk)`),
    ];
    throw new Error(`missing footage:\n${lines.join("\n")}`);
  }
  const slated = new Set(missing.map(({ scene }) => scene.id));

  // Cards first, in one short-lived browser.
  const cards: CardToRender[] = [];
  for (const scene of board.scenes) {
    if (scene.kind === "card") {
      const image = scene.image ? resolve(options.mediaRoot, scene.image) : undefined;
      const stillThere = image !== undefined && existsSync(image);
      if (image && !stillThere) warnings.push(`${scene.id}: no ${scene.image} yet, so no still`);
      cards.push({
        id: scene.id,
        html: cardHtml(
          fillText(scene.headline, rows),
          fillLines(scene.lines ?? [], rows),
          stillThere
            ? `data:image/png;base64,${readFileSync(image).toString("base64")}`
            : undefined,
        ),
      });
    } else if (scene.kind === "numbers") {
      cards.push({
        id: scene.id,
        html: numbersHtml(fillText(scene.headline, rows), rows, scene.rows),
      });
    } else if (slated.has(scene.id)) {
      const clip = missing.find((entry) => entry.scene.id === scene.id)?.source.clip ?? "";
      cards.push({ id: scene.id, html: slateHtml(scene.id, recordingHint(clip)) });
      warnings.push(`${scene.id}: footage missing, using a slate`);
    }
  }
  const images = await renderCards(cards, options.workDir);

  const reports: SceneReport[] = [];
  const files: string[] = [];
  const footages = new Map<string, FootageInput[]>();
  for (const scene of board.scenes) {
    const text = scene.voiceover ? fillText(scene.voiceover, rows) : undefined;
    if (text && hasPending(text)) {
      problems.push(`${scene.id}: the voice-over reads "pending". Guard it with [[if ...]]: ${text}`);
    }
    const voice = text ? await options.voice(scene.id, text) : undefined;
    if (text && !voice) warnings.push(`${scene.id}: no voice available, this scene is silent`);
    const voiceS = voice ? (await probeMedia(voice.path)).durationS : 0;
    const durationS = sceneDuration(scene.planned_s, voiceS);

    const isSlate = slated.has(scene.id);
    const footage =
      !isSlate && (scene.kind === "clip" || scene.kind === "split")
        ? await footageFor(scene, options.mediaRoot, durationS)
        : undefined;

    if (footage) footages.set(scene.id, footage.inputs);

    const first = footage?.inputs[0];
    const timedCallouts =
      first && scene.timed_callouts
        ? timeCallouts(
            scene.timed_callouts,
            {
              segments: first.segments,
              speed: first.fit.speed,
              marks: readMarks(first.path),
              clip: sourcesOf(scene)[0]?.clip ?? first.path,
            },
            durationS,
          )
        : [];

    const speechS = voiceS > 0 ? voiceS : Math.max(0, durationS - VOICE_DELAY_S);
    const defaults = scene.kind === "clip" || scene.kind === "split" ? board.default_notices : [];
    const assFile = `${scene.id}.ass`;
    writeFileSync(
      join(options.workDir, assFile),
      assDocument({
        durationS,
        cues: text ? timeCues(captionChunks(text), VOICE_DELAY_S, speechS) : [],
        notices: [...defaults, ...(scene.notices ?? [])],
        callouts: scene.callouts ?? [],
        timedCallouts,
        corner: [...(scene.clock10x ? ["clock 10x"] : []), ...(footage?.labels ?? [])],
      }),
    );

    const output = join(options.workDir, `${scene.id}.mp4`);
    log(
      `scene ${scene.id}: ${durationS.toFixed(1)} s, voice ${voice?.source ?? "none"}${isSlate ? ", slate" : ""}`,
    );
    await renderScene({
      durationS,
      output,
      assFile,
      workDir: options.workDir,
      footage: footage?.inputs,
      image: images.get(scene.id),
      voice: voice?.path,
    });
    files.push(output);
    reports.push({
      id: scene.id,
      kind: scene.kind,
      plannedS: scene.planned_s,
      durationS,
      voice: voice?.source ?? "none",
      voiceover: text,
      speedUps: footage?.labels ?? [],
      slated: isSlate,
    });
  }

  const joined = join(options.workDir, "joined.mp4");
  await concatScenes(files, joined, options.workDir);
  const { measured, silent } = await normaliseLoudness(joined, options.output);
  if (silent) warnings.push("the audio track is silent, so it could not be loudness-normalised");

  const info = await probeMedia(options.output);
  problems.push(
    ...checkFinal(info, {
      maxDurationS: board.max_duration_s,
      width: FRAME.width,
      height: FRAME.height,
      fps: FRAME.fps,
    }),
  );
  const realDuration = (scene: Scene): number =>
    reports.find((one) => one.id === scene.id)?.durationS ?? scene.planned_s;
  const tooLate = refusalProblem(board, realDuration);
  if (tooLate) problems.push(tooLate);
  const refusalByS = refusalOnScreenBy(board, realDuration);
  const refusal = board.first_refusal;
  let refusalSeenS: number | undefined;
  if (refusal?.seen) {
    const footage = footages.get(refusal.scene);
    if (footage) {
      const seen = seenInVideo({
        label: refusal.seen,
        withinS: refusal.within_s,
        sceneStartS: sceneOffset(board, refusal.scene, realDuration),
        footage: footage.map((input) => ({ path: input.path, segments: input.segments, speed: input.fit.speed })),
      });
      refusalSeenS = seen.atS;
      if (seen.problem) problems.push(seen.problem);
    } else {
      warnings.push(`${refusal.scene}: no footage, so the refusal's visibility wasn't checked`);
    }
  }
  const report: BuildReport = {
    output: options.output,
    scenes: reports,
    plannedS: board.scenes.reduce((sum, scene) => sum + scene.planned_s, 0),
    ...(refusalByS === undefined ? {} : { refusalByS }),
    ...(refusalSeenS === undefined ? {} : { refusalSeenS }),
    info,
    loudnessInputI: measured.input_i,
    silent,
    problems,
    warnings,
  };
  writeFileSync(join(options.workDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** Prints the build's result, loudly if it failed. Returns the exit status. */
export function printReport(report: BuildReport, log: (line: string) => void): number {
  log("");
  for (const scene of report.scenes) {
    const pad = scene.durationS.toFixed(1).padStart(6);
    log(`  ${scene.id.padEnd(14)}${pad} s  (plan ${scene.plannedS} s)  voice: ${scene.voice}`);
  }
  log(
    `  total ${report.info.durationS.toFixed(1)} s (plan ${report.plannedS} s), ${report.info.width}x${report.info.height} at ${report.info.fps} fps, audio: ${
      report.info.hasAudio ? `${report.info.audioSampleRate} Hz` : "NONE"
    }`,
  );
  if (report.refusalByS !== undefined) {
    log(`  Clearance's refusal on screen by ${report.refusalByS.toFixed(1)} s, from where its scene ends`);
  }
  if (report.refusalSeenS !== undefined) {
    log(`  Clearance's refusal visible at ${report.refusalSeenS.toFixed(2)} s, from the recorder's record`);
  }
  for (const warning of report.warnings) log(`  warning: ${warning}`);
  if (report.problems.length > 0) {
    log("");
    log("  ******************************************************");
    log("  * THE VIDEO FAILED ITS CHECKS. DO NOT SUBMIT THIS FILE.");
    for (const problem of report.problems) log(`  * ${problem}`);
    log("  ******************************************************");
    return 1;
  }
  log(`  OK: ${report.output}`);
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const known = new Set(["--allow-missing"]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    process.stderr.write(
      `unknown option ${unknown.join(" ")}\nusage: pnpm video:build [--allow-missing]\n`,
    );
    return 2;
  }
  const { voiceProvider } = await import("./voice.ts");
  const workDir = join(RAW_MEDIA, "build");
  const report = await buildVideo({
    scenesPath: join(here, "scenes.yaml"),
    resultsPath: join(REPO_ROOT, "RESULTS.md"),
    output: join(RAW_MEDIA, "clearance-demo.mp4"),
    workDir,
    mediaRoot: RAW_MEDIA,
    allowMissing: args.includes("--allow-missing"),
    voice: voiceProvider({
      overrideDir: join(here, "voice"),
      cacheDir: join(workDir, "tts"),
      log: (line) => process.stdout.write(`${line}\n`),
    }),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const status = printReport(report, (line) => process.stdout.write(`${line}\n`));
  process.stdout.write(`  report: ${relative(REPO_ROOT, join(workDir, "report.json"))}\n`);
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`video build failed: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
