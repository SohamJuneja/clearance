import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillRootEnv, fillSwitchEnv, GATE_GRANTS, gateTokensFile, readKey, setKey } from "./demo-env.mjs";

let counter = 0;
const random = () => `token-${++counter}`;

describe("--check on a fresh clone", () => {
  it("says what just demo will do, and gives the person nothing to do by hand", () => {
    const root = mkdtempSync(join(tmpdir(), "demo-env-"));
    try {
      writeFileSync(join(root, "justfile"), 'switch_sha := "abc123"\n');
      writeFileSync(join(root, ".env"), "CLEARANCE_INTERNAL_TOKEN=change-me\n");
      const script = join(import.meta.dirname, "demo-env.mjs");
      const result = spawnSync("node", [script, "--check", "--root", root], { encoding: "utf8" });
      expect(result.status).toBe(3);
      expect(result.stdout).toContain("just demo generates in .env: CLEARANCE_INTERNAL_TOKEN");
      expect(result.stdout).toContain("just demo makes vendor/switch/.env");
      expect(result.stdout).not.toContain("just init-env");
      expect(existsSync(join(root, "vendor"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fillRootEnv", () => {
  it("fills blanks and placeholders, and gives every agent its own gate token", () => {
    const { text, changed } = fillRootEnv("# comment\nCLEARANCE_INTERNAL_TOKEN=change-me\nACME_ADMIN_KEY=\nGATE_AGENT_TOKENS=\n", random);
    expect(changed).toEqual(["CLEARANCE_INTERNAL_TOKEN", "ACME_ADMIN_KEY", "STUDY_LINK_SECRET", "CLEARANCE_DRILL_RATE", "GATE_AGENT_TOKENS"]);
    expect(readKey(text, "CLEARANCE_DRILL_RATE")).toBe("0");
    expect(text).toContain("# comment");
    expect(readKey(text, "CLEARANCE_INTERNAL_TOKEN")).toMatch(/^token-/);
    const grants = JSON.parse(readKey(text, "GATE_AGENT_TOKENS")!) as Record<string, { agent: string; classes: string[] }>;
    expect(Object.values(grants).map((g) => g.agent).sort()).toEqual(Object.keys(GATE_GRANTS).sort());
    expect(new Set(Object.keys(grants)).size).toBe(Object.keys(GATE_GRANTS).length);
  });

  it("never replaces a value someone set, so a rerun changes nothing", () => {
    const first = fillRootEnv("CLEARANCE_INTERNAL_TOKEN=change-me\n", random);
    const second = fillRootEnv(first.text, random);
    expect(second.changed).toEqual([]);
    expect(second.text).toBe(first.text);
    const kept = fillRootEnv("ACME_ADMIN_KEY=mine\n", random);
    expect(readKey(kept.text, "ACME_ADMIN_KEY")).toBe("mine");
  });
});

describe("fillSwitchEnv", () => {
  const SHA = "1fe56227b6e330452ac80d7b7b2ca0a66aaeaeab";

  it("names the pinned commit, turns on agent management and fills what generate-env-secrets left", () => {
    const { text, changed } = fillSwitchEnv("SWITCH_VERSION=latest\nFEATURE_FLAGS_ENABLED=\nCONTROLLER_TOKEN_SECRET=\nAGENT_REGISTRATION_TOKEN=x\n", SHA, random);
    expect(readKey(text, "SWITCH_VERSION")).toBe("local-1fe56227");
    expect(readKey(text, "FEATURE_FLAGS_ENABLED")).toBe("agent_management");
    expect(readKey(text, "CONTROLLER_TOKEN_SECRET")).toMatch(/^token-/);
    expect(readKey(text, "AGENT_REGISTRATION_TOKEN")).toBe("x");
    expect(changed).toEqual(["CONTROLLER_TOKEN_SECRET", "SWITCH_VERSION", "FEATURE_FLAGS_ENABLED"]);
  });

  it("keeps other flags and a version someone chose", () => {
    const { text, changed } = fillSwitchEnv("SWITCH_VERSION=0.3.0\nFEATURE_FLAGS_ENABLED=a,agent_management\nCONTROLLER_TOKEN_SECRET=s\nAGENT_REGISTRATION_TOKEN=t\n", SHA, random);
    expect(changed).toEqual([]);
    expect(readKey(text, "SWITCH_VERSION")).toBe("0.3.0");
  });
});

describe("gateTokensFile", () => {
  it("maps each agent to its token", () => {
    const text = setKey("", "GATE_AGENT_TOKENS", `'${JSON.stringify({ abc: { agent: "coder", classes: ["merge"] } })}'`);
    expect(gateTokensFile(text)).toEqual({ coder: "abc" });
  });
});
