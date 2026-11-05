/**
 * `pnpm video:smoke` proves the video pipeline end to end on a real capture of the Mattermost login page
 * and writes docs/media/raw/smoke.mp4. It types a username and no password, into windows with no session.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, setting } from "../../eval/lib/paths.ts";
import { buildVideo, printReport } from "./build.ts";
import {
  type Layout,
  launchBrowser,
  MattermostWindow,
  nextTakeDirectory,
  pointLatest,
  RAW_MEDIA,
  Screencast,
} from "./capture.ts";
import { FRAME, measureLoudness, probeMedia, runFfmpeg } from "./compose.ts";
import { voiceProvider } from "./voice.ts";

const here = dirname(fileURLToPath(import.meta.url));
const log = (line: string): void => void process.stdout.write(`${line}\n`);

interface Shot {
  file: string;
  label: string;
  layout: Layout;
  typed: string;
}

const SHOTS: Shot[] = [
  { file: "priya.mp4", label: "Priya", layout: "full", typed: "priya" },
  { file: "half-a.mp4", label: "Sam", layout: "half", typed: "sam" },
  { file: "half-b.mp4", label: "Neha", layout: "half", typed: "neha" },
];

/** One capture at a time: each shot gets its browser and gives it back before the next begins. */
async function captureLoginPage(baseUrl: string, takeDir: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "capture-smoke-"));
  try {
    for (const shot of SHOTS) {
      const browser = await launchBrowser();
      let cast: Screencast;
      try {
        const window = await MattermostWindow.open({
          browser,
          baseUrl,
          label: shot.label,
          layout: shot.layout,
        });
        await window.goto("/login");
        const username = window.page.locator("#input_loginId");
        await username.waitFor({ state: "visible", timeout: 45_000 });
        cast = new Screencast(window.page, shot.layout, scratch, shot.label);
        await cast.start();
        await username.click();
        await username.pressSequentially(shot.typed, { delay: 180 });
        // Keeps the capture running on a static page for a while; there is nothing to wait for here.
        await window.page.waitForTimeout(2_000);
        await cast.stop();
      } finally {
        await browser.close();
      }
      log(`captured ${shot.file}: ${cast.frameCount} frames`);
      await cast.encode(join(takeDir, shot.file));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(takeDir, "marks.json"), "[]\n");
}

async function main(): Promise<number> {
  const baseUrl = setting("MATTERMOST_URL") ?? "http://127.0.0.1:8065";
  const takeDir = nextTakeDirectory("SMOKE");
  log(`capturing the login page at ${baseUrl}`);
  await captureLoginPage(baseUrl, takeDir);
  pointLatest(takeDir);

  const workDir = join(RAW_MEDIA, "smoke-build");
  const output = join(RAW_MEDIA, "smoke.mp4");
  const report = await buildVideo({
    scenesPath: join(here, "smoke.scenes.yaml"),
    resultsPath: join(REPO_ROOT, "RESULTS.md"),
    output,
    workDir,
    mediaRoot: RAW_MEDIA,
    allowMissing: false,
    voice: voiceProvider({ overrideDir: join(here, "voice"), cacheDir: join(workDir, "tts"), log }),
    log,
  });
  const status = printReport(report, log);

  // The duration must be the sum of its scenes: a stream that stopped early would not be.
  const expected = report.scenes.reduce((sum, scene) => sum + scene.durationS, 0);
  const off = Math.abs(report.info.durationS - expected);
  log(
    `  scenes add up to ${expected.toFixed(2)} s; the file is ${report.info.durationS.toFixed(2)} s`,
  );
  if (off > 0.5) {
    log(`  FAILED: the file is ${off.toFixed(2)} s away from the sum of its scenes`);
    return 1;
  }

  // The normalised file, measured again from scratch. A voiced smoke test must land on the target.
  const voiced = report.scenes.some((scene) => scene.voice !== "none");
  const loudness = await measureLoudness(output);
  log(
    `  loudness of the final file: ${loudness.input_i} LUFS, true peak ${loudness.input_tp} dBTP`,
  );
  if (voiced && Math.abs(Number(loudness.input_i) + 16) > 1.5) {
    log(`  FAILED: expected about -16 LUFS`);
    return 1;
  }

  // One frame from the middle of each scene, to look at.
  const frames = join(RAW_MEDIA, "smoke-frames");
  mkdirSync(frames, { recursive: true });
  let at = 0;
  for (const scene of report.scenes) {
    const frame = join(frames, `${scene.id}.png`);
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      (at + scene.durationS / 2).toFixed(2),
      "-i",
      output,
      "-frames:v",
      "1",
      frame,
    ]);
    const info = await probeMedia(frame);
    if (info.width !== FRAME.width || info.height !== FRAME.height) {
      log(`  FAILED: frame ${frame} is ${info.width}x${info.height}`);
      return 1;
    }
    at += scene.durationS;
  }
  log(`  frames: ${frames}`);
  return status;
}

main().then(
  (status) => process.exit(status),
  (error: unknown) => {
    process.stderr.write(`video smoke failed: ${(error as Error).message}\n`);
    process.exit(1);
  },
);
