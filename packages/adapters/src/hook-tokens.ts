/**
 * `data/hook-tokens.json`: hook token to agent name. A token is the only proof of which agent a hook
 * call comes from, so core refuses to start on a file that is missing, empty or open to others, rather
 * than run with fewer agents than it should or let a shared token come back. Errors name the file and
 * never a token, since the keys here are secrets. `packages/hook-cli/src/setup.ts` writes this file.
 */
import { readFileSync, statSync } from "node:fs";

const PLACEHOLDER = "change-me";

export function loadHookTokens(path: string): Record<string, string> {
  const refuse = (why: string): never => {
    throw new Error(`${path} ${why}. Run scripts/setup-agents.ts to write it.`);
  };

  let mode: number;
  let text: string;
  try {
    mode = statSync(path).mode;
    text = readFileSync(path, "utf8");
  } catch {
    return refuse("can't be read");
  }
  if ((mode & 0o077) !== 0) return refuse("must be mode 600, and is open to others: chmod 600 it");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse("must be a JSON object of hook token to agent name");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) return refuse("holds no tokens");

  const tokens: Record<string, string> = {};
  entries.forEach(([token, agent], index) => {
    if (!token || token === PLACEHOLDER || typeof agent !== "string" || !agent) {
      refuse(`has a bad entry, number ${index + 1}`);
    }
    tokens[token] = agent as string;
  });
  return tokens;
}
