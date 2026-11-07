/** Every value worth keeping out of a public file. The values are only ever compared, and never printed. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir, REPO_ROOT } from "./paths.ts";

/** The values of a .env's secret settings, by the setting's name. Addresses and agent names aren't secrets. */
export function secretValuesIn(envFile: string): string[] {
  const values: string[] = [];
  for (const line of envFile.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || !/KEY|TOKEN|SECRET|PASS|CREDENTIAL/i.test(match[1]!)) continue;
    const value = match[2]!.trim().replace(/^['"]|['"]$/g, "");
    if (value) values.push(value);
  }
  return values;
}

export function knownSecrets(): string[] {
  const values = new Set<string>();
  const fromEnvFile = (file: string): void => {
    if (!existsSync(file)) return;
    for (const value of secretValuesIn(readFileSync(file, "utf8"))) values.add(value);
  };
  fromEnvFile(join(REPO_ROOT, ".env"));
  const workspaces = join(homedir(), ".switch/agents");
  if (existsSync(workspaces)) {
    for (const host of readdirSync(workspaces)) {
      const hostDir = join(workspaces, host);
      for (const agent of readdirSync(hostDir, { withFileTypes: true })) {
        if (!agent.isDirectory()) continue;
        fromEnvFile(join(hostDir, agent.name, ".env"));
        const token = join(hostDir, agent.name, ".clearance/gate-token");
        if (existsSync(token)) values.add(readFileSync(token, "utf8").trim());
      }
    }
  }
  for (const file of ["hook-tokens.json", "gate-tokens.json"]) {
    const path = join(dataDir(), file);
    if (!existsSync(path)) continue;
    // One file is token to agent and the other agent to token, so go by length: an agent's name is short.
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (key.length >= 24) values.add(key);
      if (typeof value === "string" && value.length >= 24) values.add(value);
    }
  }
  return [...values];
}
