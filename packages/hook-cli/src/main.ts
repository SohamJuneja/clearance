#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { hookTimeoutMs, runHook, stdinTimedOut } from "./hook.ts";

/** A stdin that never closes must not stall the hook past the vendor's timeout, which fails open. */
function readStdin(limitMs: number): Promise<{ text: string; complete: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (complete: boolean) => {
      clearTimeout(timer);
      resolve({ text: Buffer.concat(chunks).toString("utf8"), complete });
    };
    const timer = setTimeout(() => finish(false), limitMs);
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => finish(true));
    process.stdin.on("error", () => finish(false));
  });
}

const vendor = process.argv[2];
const stdin = await readStdin(hookTimeoutMs(process.env));
const result = stdin.complete
  ? await runHook(vendor, stdin.text, process.env)
  : stdinTimedOut(vendor, stdin.text);
process.stdout.write(result.stdout, () => {
  process.stderr.write(result.stderr, () => process.exit(result.exitCode));
});
