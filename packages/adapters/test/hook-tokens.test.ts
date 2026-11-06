import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadHookTokens } from "../src/index.js";

function file(content: string | null, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "hook-tokens-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hook-tokens.json");
  if (content !== null) {
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
  }
  return path;
}

const GOOD = JSON.stringify({ "secret-token-aaaa": "coder", "secret-token-bbbb": "ops-agent" });

describe("loadHookTokens", () => {
  it("reads token to agent", () => {
    expect(loadHookTokens(file(GOOD))).toEqual({
      "secret-token-aaaa": "coder",
      "secret-token-bbbb": "ops-agent",
    });
  });

  it.each([
    ["a missing file", null],
    ["an empty file", ""],
    ["no tokens at all", "{}"],
    ["bad JSON", "secret-token-aaaa not json"],
    ["a list", '["secret-token-aaaa"]'],
    ["a bare string", '"secret-token-aaaa"'],
    ["a token with no agent", '{"secret-token-aaaa":""}'],
    ["a token whose agent is not a name", '{"secret-token-aaaa":{"agent":"coder"}}'],
    ["an empty token", '{"":"coder"}'],
    ["the .env.example placeholder", '{"change-me":"coder"}'],
  ])("refuses %s, naming the file and never a token", (_name, content) => {
    const path = file(content);
    let message = "";
    try {
      loadHookTokens(path);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("hook-tokens.json");
    expect(message).not.toContain("secret-token");
  });

  it.each([
    ["group readable", 0o640],
    ["world readable", 0o644],
    ["group writable", 0o620],
  ])("refuses a file that is %s, since each token proves one agent", (_name, mode) => {
    expect(() => loadHookTokens(file(GOOD, mode))).toThrow(/mode 600|chmod/i);
  });

  it("is not fooled by __proto__ in the file", () => {
    const tokens = loadHookTokens(file('{"__proto__":"coder","secret-token-aaaa":"coder"}'));
    expect(Object.keys(tokens)).toContain("secret-token-aaaa");
    expect(({} as Record<string, unknown>).coder).toBeUndefined();
  });
});
