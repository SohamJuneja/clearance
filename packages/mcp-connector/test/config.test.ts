/** The connector refuses to start on a token it shouldn't trust, and never says what a token is. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CORE_URL, loadConfig } from "../src/config.ts";

const TOKEN = "config-test-token-not-a-real-one";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tokenFile(content: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "clearance-mcp-config-"));
  dirs.push(dir);
  const file = join(dir, "core-token");
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return file;
}

/** The error a config would give, which must never carry the token it was given. */
function refusal(env: Record<string, string | undefined>, secret = TOKEN): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).not.toContain(secret);
    return message;
  }
  throw new Error("expected the config to be refused");
}

describe("the token", () => {
  it("comes from CLEARANCE_INTERNAL_TOKEN", () => {
    expect(loadConfig({ CLEARANCE_INTERNAL_TOKEN: TOKEN })).toEqual({ coreUrl: DEFAULT_CORE_URL, token: TOKEN, person: null, timeoutMs: 8000 });
  });

  it("comes from a mode 600 file first, trimmed", () => {
    const file = tokenFile(`${TOKEN}\n`);
    expect(loadConfig({ CLEARANCE_TOKEN_FILE: file, CLEARANCE_INTERNAL_TOKEN: "another-token-entirely" }).token).toBe(TOKEN);
  });

  it("is refused when there is none", () => {
    expect(refusal({})).toContain("no token");
    expect(refusal({ CLEARANCE_INTERNAL_TOKEN: "  ", CLEARANCE_TOKEN_FILE: "" })).toContain("no token");
  });

  it.each(["change-me", "CHANGE-ME", "changeme", "<core token>", "placeholder"])("is refused when it is the placeholder %s", (placeholder) => {
    expect(refusal({ CLEARANCE_INTERNAL_TOKEN: placeholder })).toContain("placeholder");
    expect(refusal({ CLEARANCE_TOKEN_FILE: tokenFile(`${placeholder}\n`) })).toContain("placeholder");
  });

  it("is refused from a file others can read, without reading it out", () => {
    const message = refusal({ CLEARANCE_TOKEN_FILE: tokenFile(TOKEN, 0o644) });
    expect(message).toContain("chmod 600");
  });

  it("is refused from a file that isn't there, or holds nothing, or holds more than a token", () => {
    expect(refusal({ CLEARANCE_TOKEN_FILE: "/nonexistent/clearance/core-token" })).toContain("can't be read");
    expect(refusal({ CLEARANCE_TOKEN_FILE: tokenFile("\n") })).toContain("empty");
    expect(refusal({ CLEARANCE_TOKEN_FILE: tokenFile(`CLEARANCE_INTERNAL_TOKEN=${TOKEN}\nOTHER=x\n`) })).toContain("nothing else");
  });
});

describe("core's address", () => {
  it("defaults to core on this machine, and drops a trailing slash", () => {
    expect(loadConfig({ CLEARANCE_INTERNAL_TOKEN: TOKEN }).coreUrl).toBe("http://127.0.0.1:7700");
    expect(loadConfig({ CLEARANCE_INTERNAL_TOKEN: TOKEN, CLEARANCE_CORE_URL: "http://localhost:7701/" }).coreUrl).toBe("http://localhost:7701");
    expect(loadConfig({ CLEARANCE_INTERNAL_TOKEN: TOKEN, CLEARANCE_CORE_URL: "https://clearance.example" }).coreUrl).toBe("https://clearance.example");
  });

  it("refuses plain HTTP away from this machine, which would send the token in the clear", () => {
    expect(refusal({ CLEARANCE_INTERNAL_TOKEN: TOKEN, CLEARANCE_CORE_URL: "http://10.0.0.5:7700" })).toContain("in the clear");
  });

  it("refuses what isn't an http URL, or carries credentials", () => {
    expect(refusal({ CLEARANCE_INTERNAL_TOKEN: TOKEN, CLEARANCE_CORE_URL: "not a url" })).toContain("not a URL");
    expect(refusal({ CLEARANCE_INTERNAL_TOKEN: TOKEN, CLEARANCE_CORE_URL: "ftp://127.0.0.1/" })).toContain("http or https");
    expect(refusal({ CLEARANCE_INTERNAL_TOKEN: TOKEN, CLEARANCE_CORE_URL: "https://me:pw@clearance.example" })).toContain("user or password");
  });
});

describe("the person and the timeout", () => {
  it("takes a team id, and refuses anything else", () => {
    expect(loadConfig({ CLEARANCE_INTERNAL_TOKEN: TOKEN, CLEARANCE_PERSON: "sam" }).person).toBe("sam");
    expect(refusal({ CLEARANCE_INTERNAL_TOKEN: TOKEN, CLEARANCE_PERSON: "sam&user=neha" })).toContain("team id");
  });

  it("takes a timeout in range", () => {
    expect(loadConfig({ CLEARANCE_INTERNAL_TOKEN: TOKEN, CLEARANCE_CONNECTOR_TIMEOUT_MS: "1500" }).timeoutMs).toBe(1500);
    expect(refusal({ CLEARANCE_INTERNAL_TOKEN: TOKEN, CLEARANCE_CONNECTOR_TIMEOUT_MS: "0" })).toContain("TIMEOUT");
  });
});
