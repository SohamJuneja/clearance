import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action, CheckResponse } from "@clearance/contracts";
import { codexResponse, cursorResponse, hookRoutes } from "@clearance/adapters";
import { hookTimeoutMs } from "../src/hook.ts";
import { REPO_ROOT, deadUrl, runHook, startServer, tempDir, type FakeServer } from "./helpers.js";

const FIXTURES = join(REPO_ROOT, "packages", "adapters", "test", "fixtures");
const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;

const TOKEN = "hook-token-value";
const HELD = "HELD CLR-0042: needs approval from finance. Do not try another way.";

const pre = load("codex-pretooluse-stubmodel");
const perm = load("codex-permissionrequest-bash");
const cursor = load("cursor-before-shell");

describe("through the real hook routes", () => {
  let core: FastifyInstance;
  let url: string;
  let checks: Action[];
  let decide: () => CheckResponse;

  beforeAll(async () => {
    core = Fastify();
    await hookRoutes(core, {
      check: async (action) => {
        checks.push(action);
        return decide();
      },
      resolveAgent: () => "support-agent",
      hookTokens: { [TOKEN]: "support-agent" },
    });
    url = await core.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(() => core.close());
  beforeEach(() => {
    checks = [];
    decide = () => ({ decision: "allow", reason: "ok" });
  });

  const env = () => ({ CLEARANCE_CORE_URL: url, CLEARANCE_HOOK_TOKEN: TOKEN });
  const hold = (): CheckResponse => ({ decision: "hold", reason: HELD, request_id: "CLR-0042" });

  describe("codex PreToolUse", () => {
    it("allow: no output and exit 0, which Codex treats as success", async () => {
      const out = await runHook("codex", pre, env());
      expect(out).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(checks).toHaveLength(1);
      expect(checks[0]!.shell?.command).toBe("git push");
    });

    it("hold: the JSON deny with exit 0, as measured, so the hook wrapper's || does not fire", async () => {
      decide = hold;
      const out = await runHook("codex", pre, env());
      expect(out.code).toBe(0);
      expect(out.stderr).toBe("");
      expect(JSON.parse(out.stdout)).toEqual(
        codexResponse({ decision: "deny", reason: HELD }, "PreToolUse"),
      );
    });

    it("deny: the JSON deny with exit 0", async () => {
      decide = () => ({ decision: "deny", reason: "protected config" });
      const out = await runHook("codex", pre, env());
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual(
        codexResponse({ decision: "deny", reason: "protected config" }, "PreToolUse"),
      );
    });
  });

  describe("codex PermissionRequest", () => {
    it("allow: decision.behavior allow, exit 0", async () => {
      const out = await runHook("codex", perm, env());
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual(
        codexResponse({ decision: "allow", reason: "" }, "PermissionRequest"),
      );
    });

    it("hold: decision.behavior deny in JSON, exit 0", async () => {
      decide = hold;
      const out = await runHook("codex", perm, env());
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual(
        codexResponse({ decision: "deny", reason: HELD }, "PermissionRequest"),
      );
    });
  });

  describe("cursor beforeShellExecution", () => {
    it("allow: permission allow, exit 0", async () => {
      const out = await runHook("cursor", cursor, env());
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual({ permission: "allow" });
    });

    it("hold: exit 2, the JSON deny on stdout and the reason on stderr", async () => {
      decide = hold;
      const out = await runHook("cursor", cursor, env());
      expect(out.code).toBe(2);
      expect(JSON.parse(out.stdout)).toEqual(cursorResponse({ decision: "deny", reason: HELD }));
      expect(out.stderr.trim()).toBe(HELD);
    });
  });

  it("a wrong token still comes back as a deny", async () => {
    const out = await runHook("codex", pre, { ...env(), CLEARANCE_HOOK_TOKEN: "wrong-token" });
    expect(out.code).toBe(0);
    const specific = JSON.parse(out.stdout).hookSpecificOutput;
    expect(specific.permissionDecision).toBe("deny");
    expect(specific.permissionDecisionReason).toMatch(/token/i);
    expect(checks).toHaveLength(0);
  });
});

describe("failing closed on its own", () => {
  let server: FakeServer;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(() => server.close());

  const env = () => ({
    CLEARANCE_CORE_URL: server.url,
    CLEARANCE_HOOK_TOKEN: TOKEN,
    CLEARANCE_HOOK_TIMEOUT_MS: "300",
  });

  const expectCodexPreDeny = (out: { code: number | null; stdout: string; stderr: string }) => {
    expect(out.code).toBe(0);
    const reason = JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason.length).toBeGreaterThan(0);
    expect(JSON.parse(out.stdout)).toEqual(
      codexResponse({ decision: "deny", reason }, "PreToolUse"),
    );
  };
  const expectCodexPermDeny = (out: { code: number | null; stdout: string; stderr: string }) => {
    expect(out.code).toBe(0);
    const specific = JSON.parse(out.stdout).hookSpecificOutput;
    expect(specific.hookEventName).toBe("PermissionRequest");
    expect(specific.decision.behavior).toBe("deny");
    expect(specific.decision.message.length).toBeGreaterThan(0);
  };
  const expectCursorDeny = (out: { code: number | null; stdout: string; stderr: string }) => {
    expect(out.code).toBe(2);
    const reason = out.stderr.trim();
    expect(reason.length).toBeGreaterThan(0);
    expect(JSON.parse(out.stdout)).toEqual(cursorResponse({ decision: "deny", reason }));
  };

  const CASES = [
    ["codex PreToolUse", "codex", pre, expectCodexPreDeny],
    ["codex PermissionRequest", "codex", perm, expectCodexPermDeny],
    ["cursor", "cursor", cursor, expectCursorDeny],
  ] as const;

  describe.each(CASES)("%s", (_name, vendor, payload, expectDeny) => {
    it("core down is a deny", async () => {
      expectDeny(await runHook(vendor, payload, { ...env(), CLEARANCE_CORE_URL: await deadUrl() }));
    });

    it("a core that hangs is a deny within the short timeout, never a long wait", async () => {
      server.respond(() => null);
      const out = await runHook(vendor, payload, env());
      expectDeny(out);
      expect(out.ms).toBeLessThan(5000);
    });

    it("a non-200 is a deny even with an allow body", async () => {
      const allow = JSON.stringify({ permission: "allow" });
      server.respond(() => ({ status: 500, body: allow }));
      expectDeny(await runHook(vendor, payload, env()));
    });

    it("an unparsable answer is a deny", async () => {
      server.respond(() => ({ status: 200, body: "{not json" }));
      expectDeny(await runHook(vendor, payload, env()));
    });

    it("an answer of the wrong shape is a deny", async () => {
      server.respond(() => ({ status: 200, body: JSON.stringify({ decision: "allow" }) }));
      expectDeny(await runHook(vendor, payload, env()));
    });

    it("no token configured is a deny without calling core", async () => {
      const empty = tempDir("hook-no-token-");
      expectDeny(await runHook(vendor, payload, { CLEARANCE_CORE_URL: server.url }, false, empty));
      expect(server.hits).toHaveLength(0);
    });

    it("stdin that never closes is a deny, so the vendor's timeout cannot fail open", async () => {
      const out = await runHook(vendor, payload, env(), true);
      expectDeny(out);
      expect(out.ms).toBeLessThan(5000);
    });
  });

  it("codex: unreadable stdin is a PreToolUse deny, since that is the safe default", async () => {
    expectCodexPreDeny(await runHook("codex", "{not json", env()));
    expect(server.hits).toHaveLength(0);
  });

  it("cursor: unreadable stdin is a deny", async () => {
    expectCursorDeny(await runHook("cursor", "", env()));
    expect(server.hits).toHaveLength(0);
  });

  it("codex PermissionRequest: an empty answer is a deny, not silence", async () => {
    server.respond(() => ({ status: 200, body: "{}" }));
    expectCodexPermDeny(await runHook("codex", perm, env()));
  });

  it("codex: an event mismatch in the answer is a deny", async () => {
    server.respond(() => ({
      status: 200,
      body: JSON.stringify(codexResponse({ decision: "allow", reason: "" }, "PermissionRequest")),
    }));
    expectCodexPreDeny(await runHook("codex", pre, env()));
  });

  it("an unknown vendor exits 2 and calls nothing", async () => {
    const out = await runHook("gemini", pre, env());
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/codex\|cursor/);
    expect(server.hits).toHaveLength(0);
  });

  it("sends the bearer token and the payload unchanged to the vendor's route", async () => {
    await runHook("cursor", cursor, env());
    expect(server.hits[0]).toMatchObject({ method: "POST", url: "/v1/hooks/cursor" });
    expect(server.hits[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(server.hits[0]!.body)).toEqual(cursor);
  });

  describe("token from a file, since Switch does not pass the env to hook commands", () => {
    const withTokenFile = (subdir = "") => {
      const dir = tempDir("hook-token-");
      mkdirSync(join(dir, ".clearance"));
      writeFileSync(join(dir, ".clearance", "hook-token"), "token-from-file\n");
      if (subdir) mkdirSync(join(dir, subdir), { recursive: true });
      return dir;
    };
    const noEnvToken = () => ({ CLEARANCE_CORE_URL: server.url, CLEARANCE_HOOK_TIMEOUT_MS: "300" });

    it("reads .clearance/hook-token from the working directory", async () => {
      const dir = withTokenFile();
      await runHook("codex", pre, noEnvToken(), false, dir);
      expect(server.hits[0]!.headers.authorization).toBe("Bearer token-from-file");
    });

    it("finds it from a subdirectory", async () => {
      const dir = withTokenFile("src/deep");
      await runHook("codex", pre, noEnvToken(), false, join(dir, "src/deep"));
      expect(server.hits[0]!.headers.authorization).toBe("Bearer token-from-file");
    });

    it("prefers the agent's own file, so a stale shared value in the env can't win", async () => {
      const dir = withTokenFile();
      await runHook("codex", pre, env(), false, dir);
      expect(server.hits[0]!.headers.authorization).toBe("Bearer token-from-file");
    });

    it("falls back to the env when there is no file, for running it by hand", async () => {
      await runHook("codex", pre, env(), false, tempDir("hook-no-file-"));
      expect(server.hits[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    });
  });

  describe("Switch's own tools, so an outage cannot silence the agent", () => {
    const tool = (event: string) => ({
      hook_event_name: event,
      tool_name: "mcp__switch__post_message",
      tool_input: { body: "hello" },
    });

    it.each(["PreToolUse", "PermissionRequest"])(
      "%s has no opinion, with core down and no token",
      async (event) => {
        const out = await runHook("codex", tool(event), { CLEARANCE_CORE_URL: await deadUrl() });
        expect(out).toMatchObject({ code: 0, stdout: "", stderr: "" });
      },
    );

    it("does not ask core", async () => {
      await runHook("codex", tool("PreToolUse"), env());
      expect(server.hits).toHaveLength(0);
    });

    it("does not extend to anything else named like it", async () => {
      const lookalike = { ...tool("PreToolUse"), tool_name: "mcp__switcher__post_message" };
      await runHook("codex", lookalike, env());
      expect(server.hits).toHaveLength(1);
    });
  });

  it("answers inside the 2 s the Codex wrapper allows", () => {
    expect(hookTimeoutMs({})).toBeLessThan(2000);
    expect(hookTimeoutMs({ CLEARANCE_HOOK_TIMEOUT_MS: "300" })).toBe(300);
    expect(hookTimeoutMs({ CLEARANCE_HOOK_TIMEOUT_MS: "junk" })).toBeLessThan(2000);
  });

  it("does not print the token on any path", async () => {
    server.respond(() => ({ status: 500, body: "{}" }));
    const out = await runHook("codex", pre, env());
    expect(out.stdout + out.stderr).not.toContain(TOKEN);
  });
});
