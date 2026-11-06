import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
export const HOOK_MAIN = join(REPO_ROOT, "packages", "hook-cli", "src", "main.ts");
export const ACME_APP = join(REPO_ROOT, "acme-mini-app");
export const ACME_BIN = join(ACME_APP, "bin", "acme");
export const HOOK_BIN = join(ACME_APP, "bin", "clearance-hook");

export type Spawned = { code: number | null; stdout: string; stderr: string; ms: number };

/**
 * A temp directory that goes when the test does, however the test ends. /tmp is RAM-backed on the demo
 * host, so cleanup at the end of a test body is not good enough: a failed assertion skips it.
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SPAWN_LIMIT_MS = 30_000;

/**
 * Runs a real process with a clean env, so the exit code and streams are what a vendor would see.
 * `node` on the demo host is a Volta shim, so killing the child alone can leave the real process
 * running. The child leads its own process group, and the whole group is killed when it finishes
 * or overruns.
 */
export function run(
  command: string,
  args: string[],
  opts: {
    stdin?: string;
    env?: Record<string, string>;
    cwd?: string;
    keepStdinOpen?: boolean;
  } = {},
): Promise<Spawned> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { PATH: process.env.PATH ?? "", ...opts.env },
      detached: true,
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone, which is the normal case.
      }
    };
    const limit = setTimeout(killGroup, SPAWN_LIMIT_MS);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(limit);
      killGroup();
      child.stdin.destroy();
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    if (!opts.keepStdinOpen) child.stdin.end();
  });
}

export const runHook = (
  vendor: string,
  stdin: unknown,
  env: Record<string, string> = {},
  keepStdinOpen = false,
  cwd?: string,
) =>
  run("node", ["--disable-warning=ExperimentalWarning", HOOK_MAIN, vendor], {
    stdin: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    env,
    keepStdinOpen,
    cwd,
  });

export type Hit = { method: string; url: string; headers: Record<string, unknown>; body: string };

export type FakeServer = {
  url: string;
  hits: Hit[];
  respond: (fn: (hit: Hit) => { status: number; body: string } | null) => void;
  close: () => Promise<void>;
};

/** A plain HTTP server. Returning null from the responder leaves the request hanging. */
export async function startServer(): Promise<FakeServer> {
  const hits: Hit[] = [];
  let responder: (hit: Hit) => { status: number; body: string } | null = () => ({
    status: 200,
    body: "{}",
  });
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const hit = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      hits.push(hit);
      const out = responder(hit);
      if (!out) return;
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    respond: (fn) => {
      responder = fn;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on. */
export async function deadUrl(): Promise<string> {
  const s = await startServer();
  await s.close();
  return s.url;
}
