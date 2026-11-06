#!/usr/bin/env node
/**
 * Fills in the secrets `just demo` needs, in the root .env and Switch's. Only what is blank or a placeholder: a value
 * someone set is never replaced, so a rerun changes nothing and a running stack keeps working. Plain Node, because it
 * runs before dependencies are installed. Never prints a value.
 *
 *   node scripts/demo-env.mjs [--check] [--root <dir>]
 *
 * --check says which keys still need filling and exits 3 if any do, changing nothing.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Which actions each agent's gate token may ask for. PLAN 8.4. */
export const GATE_GRANTS = {
  "refunds-agent": ["refund", "payout_change"],
  "support-agent": ["customer_email"],
  coder: ["merge"],
  "ops-agent": ["deploy", "delete"],
  reviewer: ["merge"],
};

const RANDOM_ROOT_KEYS = ["CLEARANCE_INTERNAL_TOKEN", "ACME_ADMIN_KEY", "STUDY_LINK_SECRET"];
const RANDOM_SWITCH_KEYS = ["CONTROLLER_TOKEN_SECRET", "AGENT_REGISTRATION_TOKEN"];
const PLACEHOLDER = "change-me";

const hex = () => randomBytes(24).toString("hex");

export function readKey(text, key) {
  const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1).replace(/^(["'])(.*)\1$/, "$2");
}

/** Sets a key where it already is, or adds it at the end. */
export function setKey(text, key, value) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (at >= 0) {
    lines[at] = `${key}=${value}`;
    return lines.join("\n");
  }
  return `${text.replace(/\n*$/, "")}\n${key}=${value}\n`;
}

const blank = (value) => value === undefined || value === "" || value === PLACEHOLDER;

export function fillRootEnv(text, random = hex) {
  let next = text;
  const changed = [];
  for (const key of RANDOM_ROOT_KEYS) {
    if (blank(readKey(next, key))) {
      next = setKey(next, key, random());
      changed.push(key);
    }
  }
  // Off for a demo, as in .env.example. A surprise practice card in the middle of a take means nothing to a viewer.
  if (readKey(next, "CLEARANCE_DRILL_RATE") === undefined) {
    next = setKey(next, "CLEARANCE_DRILL_RATE", "0");
    changed.push("CLEARANCE_DRILL_RATE");
  }
  if (blank(readKey(next, "GATE_AGENT_TOKENS"))) {
    const grants = Object.fromEntries(Object.entries(GATE_GRANTS).map(([agent, classes]) => [random(), { agent, classes }]));
    next = setKey(next, "GATE_AGENT_TOKENS", `'${JSON.stringify(grants)}'`);
    changed.push("GATE_AGENT_TOKENS");
  }
  return { text: next, changed };
}

export function fillSwitchEnv(text, sha, random = hex) {
  let next = text;
  const changed = [];
  for (const key of RANDOM_SWITCH_KEYS) {
    if (blank(readKey(next, key))) {
      next = setKey(next, key, random());
      changed.push(key);
    }
  }
  // Images come from the pinned checkout, not from a registry, so the tag names that commit.
  const version = readKey(next, "SWITCH_VERSION");
  if (blank(version) || version === "latest") {
    next = setKey(next, "SWITCH_VERSION", `local-${sha.slice(0, 8)}`);
    changed.push("SWITCH_VERSION");
  }
  const flags = (readKey(next, "FEATURE_FLAGS_ENABLED") ?? "").split(",").filter(Boolean);
  if (!flags.includes("agent_management")) {
    next = setKey(next, "FEATURE_FLAGS_ENABLED", [...flags, "agent_management"].join(","));
    changed.push("FEATURE_FLAGS_ENABLED");
  }
  return { text: next, changed };
}

/** Agent name to token, the file scripts/smoke-spine.ts reads. Derived, so it can never disagree with .env. */
export function gateTokensFile(rootEnvText) {
  const grants = JSON.parse(readKey(rootEnvText, "GATE_AGENT_TOKENS") ?? "{}");
  return Object.fromEntries(Object.entries(grants).map(([token, grant]) => [grant.agent, token]));
}

function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function main() {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false }, root: { type: "string" }, sha: { type: "string" } } });
  const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const sha = values.sha ?? /switch_sha := "([0-9a-f]+)"/.exec(readFileSync(join(root, "justfile"), "utf8"))?.[1];
  if (!sha) throw new Error("no Switch commit given and none in the justfile");
  const rootPath = join(root, ".env");
  const switchPath = join(root, "vendor/switch/.env");
  const problems = [];

  const rootText = existsSync(rootPath) ? readFileSync(rootPath, "utf8") : readFileSync(join(root, ".env.example"), "utf8");
  const filledRoot = fillRootEnv(rootText);
  if (!existsSync(rootPath)) problems.push(".env does not exist yet");
  if (filledRoot.changed.length > 0) problems.push(`.env needs: ${filledRoot.changed.join(", ")}`);

  let filledSwitch = null;
  if (existsSync(switchPath)) {
    filledSwitch = fillSwitchEnv(readFileSync(switchPath, "utf8"), sha);
    if (filledSwitch.changed.length > 0) problems.push(`vendor/switch/.env needs: ${filledSwitch.changed.join(", ")}`);
  } else {
    problems.push("vendor/switch/.env does not exist yet: `just init-env` in vendor/switch makes it");
  }

  if (values.check) {
    for (const problem of problems) console.log(problem);
    process.exit(problems.length > 0 ? 3 : 0);
  }

  if (!existsSync(rootPath)) copyFileSync(join(root, ".env.example"), rootPath);
  writePrivate(rootPath, filledRoot.text);
  writePrivate(join(root, "data/gate-tokens.json"), `${JSON.stringify(gateTokensFile(filledRoot.text), null, 2)}\n`);
  if (filledSwitch) writePrivate(switchPath, filledSwitch.text);
  console.log(`env ready. Filled: ${[...filledRoot.changed, ...(filledSwitch?.changed ?? [])].join(", ") || "nothing"}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
