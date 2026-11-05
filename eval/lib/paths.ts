/**
 * Where things live. A git worktree has no `data/`, `.env` or `vendor/` of its own, so anything that is
 * gitignored at the repo root is found by walking up from here, which reaches the main checkout.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The first existing `relative` in this directory or any parent, or undefined. */
export function findUpwards(relative: string, from: string = REPO_ROOT): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `CLEARANCE_DATA_DIR` if set, else the nearest `data/secrets.json`'s directory, else `<repo>/data`. */
export function dataDir(): string {
  const configured = process.env.CLEARANCE_DATA_DIR;
  if (configured) return resolve(configured);
  const secrets = findUpwards("data/secrets.json");
  return secrets ? dirname(secrets) : join(REPO_ROOT, "data");
}

export function secretsPath(): string {
  return join(dataDir(), "secrets.json");
}

export function identitiesPath(): string {
  return join(dataDir(), "identities.json");
}

/** Just enough of a dotenv reader for `.env` files. Values stay in this process. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/** A setting from the process environment, then the nearest `.env`. Blank counts as unset. */
export function setting(key: string): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;
  const file = findUpwards(".env");
  if (!file) return undefined;
  return parseDotenv(readFileSync(file, "utf8"))[key] || undefined;
}
