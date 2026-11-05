/**
 * Every test makes its own SQLite file. /tmp on the demo host is a small tmpfs shared with other projects, and
 * five thousand leftover directories filled the quota once, so a run gets one directory and removes it at the end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "clearance-core-run-"));
  process.env.TMPDIR = root;
  return () => rmSync(root, { recursive: true, force: true });
}
