/**
 * Where a scene's speech comes from. A recording at scripts/video/voice/<scene>.wav always wins, so the
 * human can replace any or all of the voice-over by dropping files in and rebuilding. Otherwise Piper, an
 * offline TTS engine, speaks it, and the result is cached by what was said and how.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setting } from "../../eval/lib/paths.ts";
import type { VoiceProvider } from "./build.ts";

export const PIPER_VOICE = "en_US-lessac-high";

export interface PiperConfig {
  bin: string;
  model: string;
  /** Above 1 is slower. */
  lengthScale: number;
  sentenceSilenceS: number;
}

export function piperConfig(): PiperConfig {
  const tools = join(homedir(), ".local/share/clearance-tools/piper");
  return {
    bin: setting("CLEARANCE_PIPER_BIN") ?? join(homedir(), ".local/bin/piper"),
    model: setting("CLEARANCE_PIPER_MODEL") ?? join(tools, `${PIPER_VOICE}.onnx`),
    lengthScale: 1,
    sentenceSilenceS: 0.3,
  };
}

/** Why Piper can't run here, in words a person can act on, or undefined if it can. */
export function piperProblem(config: PiperConfig): string | undefined {
  if (!existsSync(config.bin)) {
    return `no piper at ${config.bin}. Install it with: uv tool install piper-tts`;
  }
  if (!existsSync(config.model)) {
    return `no voice at ${config.model}. Fetch it with piper.download_voices ${PIPER_VOICE}`;
  }
  return undefined;
}

export function speakWithPiper(config: PiperConfig, text: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.bin,
      [
        "--model",
        config.model,
        "--output-file",
        output,
        "--length-scale",
        String(config.lengthScale),
        "--sentence-silence",
        String(config.sentenceSilenceS),
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-800);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`piper exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(`${text}\n`);
  });
}

/**
 * What the voice should say for what the caption shows. The caption keeps "₹40,000"; an English voice
 * doesn't know that sign, so it gets the words. Numbers are never changed, only how they're read.
 */
export function speakable(text: string): string {
  return text
    .replace(/\b([Aa]) ₹\s?([\d,]+(?:\.\d+)?)/g, "$1 $2 rupee")
    .replace(/₹\s?([\d,]+(?:\.\d+)?)/g, "$1 rupees")
    .replace(/`/g, "")
    .replace(/\s+\/\s+/g, ", ")
    .replace(/\bOpenCode\b/g, "Open Code")
    .replace(/\s+/g, " ")
    .trim();
}

export interface VoiceOptions {
  /** Where recordings that beat TTS live: `<overrideDir>/<scene>.wav`. */
  overrideDir: string;
  cacheDir: string;
  log: (line: string) => void;
  /** How to speak. Default: Piper. */
  speak?: (text: string, output: string) => Promise<void>;
  /** A short name for the engine, part of the cache key and shown in the build report. */
  engine?: string;
  /** Why the engine can't run, if it can't. Default: checks for Piper. */
  engineProblem?: () => string | undefined;
}

export function voiceProvider(options: VoiceOptions): VoiceProvider {
  const config = piperConfig();
  const speak = options.speak ?? ((text, output) => speakWithPiper(config, text, output));
  const engine = options.engine ?? `piper ${PIPER_VOICE}`;
  const problem = options.engineProblem ?? (() => piperProblem(config));
  let warned = false;

  return async (sceneId, text) => {
    const recorded = join(options.overrideDir, `${sceneId}.wav`);
    if (existsSync(recorded)) return { path: recorded, source: "recorded" };

    const why = problem();
    if (why) {
      if (!warned) options.log(`no TTS: ${why}`);
      warned = true;
      return undefined;
    }

    const spoken = speakable(text);
    const key = createHash("sha256").update(`${engine}\n${spoken}`).digest("hex").slice(0, 12);
    const cached = join(options.cacheDir, `${sceneId}-${key}.wav`);
    if (!existsSync(cached)) {
      mkdirSync(options.cacheDir, { recursive: true });
      // Written aside and moved in place, so a killed build can't leave half a line in the cache.
      const partial = `${cached}.partial.wav`;
      await speak(spoken, partial);
      renameSync(partial, cached);
    }
    return { path: cached, source: engine };
  };
}
