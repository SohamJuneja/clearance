#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Prepares one agent's directory. Run it once per agent, after the clone and before the first session.
 *
 *   CLEARANCE_HOOK_TOKEN=... ACME_GATE_TOKEN=<this agent's gate token> \
 *     node packages/hook-cli/src/setup-agent.ts <agent-dir> [--codex-home <dir>]
 *
 * `--codex-home` also seeds Codex's trust in that home's config.toml. It edits that file, so it is
 * opt-in, and it needs `codex` on PATH. Tokens come from the env and are never printed.
 */
import { realpathSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { seedCodexTrust, writeAgentSecrets } from "./setup.ts";

function fail(message: string): never {
  console.error(`setup-agent: ${message}`);
  process.exit(1);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const { values, positionals } = parseArgs({
  options: { "codex-home": { type: "string" } },
  allowPositionals: true,
});
const target = positionals[0];
if (!target) fail("usage: setup-agent <agent-dir> [--codex-home <dir>]");
if (!isDirectory(target)) fail(`${target} is not a directory`);

const hookToken = process.env.CLEARANCE_HOOK_TOKEN;
const gateToken = process.env.ACME_GATE_TOKEN;
if (!hookToken) fail("CLEARANCE_HOOK_TOKEN is not set");
if (!gateToken) fail("ACME_GATE_TOKEN is not set");

// Codex keys hook trust by the real path, so a symlinked directory has to be resolved first.
const dir = realpathSync(target);
writeAgentSecrets(dir, {
  hookToken,
  gateToken,
  gateUrl: process.env.CLEARANCE_GATE_URL || "http://127.0.0.1:7710",
});
console.log(
  `${dir}: wrote .clearance/, .claude/settings.local.json and .codex/config.toml (mode 600)`,
);

const codexHome = values["codex-home"];
if (codexHome) {
  try {
    const seeded = await seedCodexTrust(codexHome, dir);
    console.log(`${dir}: Codex trusts the project and its ${seeded} hooks in ${codexHome}`);
  } catch (err) {
    fail(err instanceof Error ? err.message : "could not seed Codex trust");
  }
}
