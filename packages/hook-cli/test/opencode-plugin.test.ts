import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Action, CheckResponse } from "@clearance/contracts";
import { hookRoutes } from "@clearance/adapters";
import plugin from "../../../acme-mini-app/.opencode/plugins/clearance.ts";
import { deadUrl, startServer } from "./helpers.js";

const TOKEN = "hook-token-value";
const AGENT_DIR = "/home/agent/ops-agent";

let TOKEN_DIR: string;
beforeAll(() => {
  TOKEN_DIR = mkdtempSync(join(tmpdir(), "plugin-token-"));
  mkdirSync(join(TOKEN_DIR, ".clearance"));
  writeFileSync(join(TOKEN_DIR, ".clearance", "hook-token"), `${TOKEN}\n`);
});
afterAll(() => rmSync(TOKEN_DIR, { recursive: true, force: true }));

const saved = { ...process.env };
let core: FastifyInstance;
let checks: Action[];
let decide: () => CheckResponse;

beforeEach(async () => {
  checks = [];
  decide = () => ({ decision: "allow", reason: "ok" });
  core = Fastify();
  await hookRoutes(core, {
    check: async (action) => {
      checks.push(action);
      return decide();
    },
    resolveAgent: (cwd) => (cwd === AGENT_DIR || cwd === TOKEN_DIR ? "ops-agent" : null),
    hookTokens: { [TOKEN]: "ops-agent" },
  });
  process.env.CLEARANCE_CORE_URL = await core.listen({ port: 0, host: "127.0.0.1" });
  process.env.CLEARANCE_HOOK_TOKEN = TOKEN;
  delete process.env.CLEARANCE_HOOK_TIMEOUT_MS;
});

afterEach(async () => {
  await core.close();
  process.env = { ...saved };
});

const before = async (tool: string, args: Record<string, unknown>, directory = AGENT_DIR) => {
  const hooks = await plugin.server({ directory });
  await hooks["tool.execute.before"]({ tool, sessionID: "ses_1", callID: "call_1" }, { args });
};

describe("OpenCode plugin", () => {
  it("has the shape the 1.18 loader requires of a local plugin: default {id, server}", () => {
    expect(plugin.id).toBe("clearance");
    expect(typeof plugin.server).toBe("function");
  });

  it("allow returns, and core saw the call as this agent", async () => {
    await expect(before("bash", { command: "ls" })).resolves.toBeUndefined();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      vendor: "opencode",
      kind: "shell",
      shell: { command: "ls" },
      agent: { name: "ops-agent", cwd: AGENT_DIR },
      session: { vendorSessionId: "ses_1" },
    });
  });

  it("a hold throws core's reason verbatim, which is how OpenCode blocks", async () => {
    const reason = "HELD CLR-0042: needs approval. Do not try another way.";
    decide = () => ({ decision: "hold", reason, request_id: "CLR-0042" });
    await expect(before("bash", { command: "git push --force origin main" })).rejects.toThrow(
      reason,
    );
  });

  it("a deny throws its reason", async () => {
    decide = () => ({ decision: "deny", reason: "protected config" });
    await expect(before("edit", { filePath: `${AGENT_DIR}/.opencode/x` })).rejects.toThrow(
      "protected config",
    );
  });

  it("reads its token from .clearance/hook-token, since the env does not reach it", async () => {
    delete process.env.CLEARANCE_HOOK_TOKEN;
    await expect(before("bash", { command: "ls" }, TOKEN_DIR)).resolves.toBeUndefined();
    expect(checks).toHaveLength(1);
  });

  it("prefers that file, so a stale shared value in the env can't win", async () => {
    process.env.CLEARANCE_HOOK_TOKEN = "stale-shared-token";
    await expect(before("bash", { command: "ls" }, TOKEN_DIR)).resolves.toBeUndefined();
    expect(checks).toHaveLength(1);
  });

  it("maps a real gate tool name through to core as mcp", async () => {
    await before("clearance_gate_refund_customer", { order_id: "A-1931", amount: 4000 });
    expect(checks[0]).toMatchObject({
      kind: "mcp",
      mcp: { server: "clearance_gate", tool: "refund_customer" },
    });
  });

  it("leaves Switch's own tools alone, so an outage cannot silence the agent", async () => {
    process.env.CLEARANCE_CORE_URL = await deadUrl();
    await expect(before("switch_post_message", { body: "x" })).resolves.toBeUndefined();
    expect(checks).toHaveLength(0);
  });

  it("does not extend that to anything else named like it", async () => {
    process.env.CLEARANCE_CORE_URL = await deadUrl();
    await expect(before("switcher_do_thing", {})).rejects.toThrow(/Clearance denied/);
  });

  it("an unknown directory throws", async () => {
    await expect(before("bash", { command: "ls" }, "/somewhere/else")).rejects.toThrow(/directory/);
    expect(checks).toHaveLength(0);
  });

  it("a wrong token throws", async () => {
    process.env.CLEARANCE_HOOK_TOKEN = "wrong";
    await expect(before("bash", { command: "ls" })).rejects.toThrow(/token/);
  });

  it("no token configured throws without calling core", async () => {
    delete process.env.CLEARANCE_HOOK_TOKEN;
    await expect(before("bash", { command: "ls" })).rejects.toThrow(/Clearance denied/);
    expect(checks).toHaveLength(0);
  });

  it("core down throws", async () => {
    process.env.CLEARANCE_CORE_URL = await deadUrl();
    await expect(before("bash", { command: "ls" })).rejects.toThrow(/Clearance denied/);
  });

  describe("against a misbehaving core", () => {
    it.each([
      ["a non-200", 500, JSON.stringify({ decision: "allow", reason: "x" })],
      ["unparsable JSON", 200, "{not json"],
      ["the wrong shape", 200, JSON.stringify({ decision: "yes" })],
    ])("%s throws", async (_name, status, body) => {
      const server = await startServer();
      server.respond(() => ({ status, body }));
      process.env.CLEARANCE_CORE_URL = server.url;
      await expect(before("bash", { command: "ls" })).rejects.toThrow(/Clearance denied/);
      await server.close();
    });

    it("a core that hangs throws within the timeout", async () => {
      const server = await startServer();
      server.respond(() => null);
      process.env.CLEARANCE_CORE_URL = server.url;
      process.env.CLEARANCE_HOOK_TIMEOUT_MS = "100";
      await expect(before("bash", { command: "ls" })).rejects.toThrow(/Clearance denied/);
      await server.close();
    });
  });
});
