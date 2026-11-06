import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionSchema, type Action, type CheckResponse } from "@clearance/contracts";
import { hookRoutes } from "../src/index.js";

/** One token per agent. "someone-else" holds a token but is not in the team. */
const HOOK_TOKENS: Record<string, string> = {
  "tok-spike-s1": "spike-s1",
  "tok-support": "support-agent",
  "tok-reviewer": "reviewer",
  "tok-ops": "ops-agent",
  "tok-coder": "coder",
  "tok-refunds": "refunds-agent",
  "tok-someone-else": "someone-else",
};
const tokenOf = (agent: string): string => {
  const entry = Object.entries(HOOK_TOKENS).find(([, name]) => name === agent);
  if (!entry) throw new Error(`no token for ${agent}`);
  return entry[0];
};
const as = (agent: string) => ({ authorization: `Bearer ${tokenOf(agent)}` });
/** Whose calls each vendor's fixtures are, unless a test says otherwise. */
const FIXTURE_AGENT: Record<string, string> = {
  claude: "spike-s1",
  codex: "support-agent",
  cursor: "reviewer",
  opencode: "ops-agent",
};
const FIXTURES = join(import.meta.dirname, "fixtures");
const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;

const AGENT_DIRS: Record<string, string> = {
  "/home/agent/coder": "coder",
  "/home/agent/refunds-agent": "refunds-agent",
  "/home/agent/support-agent": "support-agent",
  "/home/agent/reviewer": "reviewer",
  "/home/agent/ops-agent": "ops-agent",
  "/home/agent-user/.local/share/clearance-tools/spike-work/s1": "spike-s1",
  "/home/agent-user/.local/share/clearance-tools/spike-work/s5-codex-switch": "support-agent",
  "/home/agent-user/.local/share/clearance-tools/spike-work/s5-opencode": "ops-agent",
};
const KNOWN_AGENTS = new Set(["spike-s1", "coder"]);

/** Takes a payload back to identifying its agent by directory alone. */
function withoutAgentType(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...payload };
  delete copy.agent_type;
  return copy;
}

let app: FastifyInstance;
let checks: Action[];
let decide: (action: Action) => CheckResponse | Promise<CheckResponse>;

async function build(extra: Partial<Parameters<typeof hookRoutes>[1]> = {}) {
  app = Fastify();
  await hookRoutes(app, {
    check: async (action) => {
      checks.push(action);
      return decide(action);
    },
    resolveAgent: (cwd, agentType) => {
      if (agentType !== undefined) return KNOWN_AGENTS.has(agentType) ? agentType : null;
      return cwd ? (AGENT_DIRS[cwd] ?? null) : null;
    },
    hookTokens: HOOK_TOKENS,
    ...extra,
  });
  await app.ready();
}

beforeEach(async () => {
  checks = [];
  decide = () => ({ decision: "allow", reason: "ok" });
  await build();
});

afterEach(async () => {
  await app.close();
});

const post = (
  vendor: string,
  payload: unknown,
  headers: Record<string, string> = as(FIXTURE_AGENT[vendor] ?? ""),
) =>
  app.inject({
    method: "POST",
    url: `/v1/hooks/${vendor}`,
    headers: { "content-type": "application/json", ...headers },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const ROUTES = [
  ["claude", "claude-pretooluse"],
  ["codex", "codex-pretooluse-stubmodel"],
  ["codex", "codex-permissionrequest-bash"],
  ["cursor", "cursor-before-shell"],
  ["opencode", "opencode-tool-execute-before"],
] as const;

/** Reads the vendor's own answer, so these tests check what the vendor would actually do. */
function decisionOf(
  vendor: string,
  body: Record<string, never>,
): { deny: boolean; reason?: string } {
  if (vendor === "cursor") {
    const out = body as { permission?: string; agent_message?: string };
    return { deny: out.permission !== "allow", reason: out.agent_message };
  }
  if (vendor === "opencode") {
    const out = body as { decision?: string; reason?: string };
    return { deny: out.decision !== "allow", reason: out.reason };
  }
  const specific = (body as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
  if (!specific) return { deny: false };
  if (specific.hookEventName === "PermissionRequest") {
    const decision = specific.decision as { behavior: string; message?: string };
    return { deny: decision.behavior !== "allow", reason: decision.message };
  }
  return {
    deny: specific.permissionDecision !== "allow",
    reason: specific.permissionDecisionReason as string,
  };
}

describe.each(ROUTES)("/v1/hooks/%s with %s", (vendor, fixture) => {
  it("allow lets it through and sends check a valid Action", async () => {
    const res = await post(vendor, load(fixture));
    expect(res.statusCode).toBe(200);
    expect(decisionOf(vendor, res.json()).deny).toBe(false);
    expect(checks).toHaveLength(1);
    expect(ActionSchema.safeParse(checks[0]).success).toBe(true);
    expect(checks[0]!.source).toBe("hook");
    expect(checks[0]!.vendor).toBe(vendor);
    expect(checks[0]!.id.length).toBeGreaterThan(5);
  });

  it("the agent name comes from the token, not the payload", async () => {
    await post(vendor, { ...load(fixture), agent: { name: "sam" }, agent_name: "sam" });
    expect(checks[0]!.agent.name).toBe(FIXTURE_AGENT[vendor]);
  });

  it("a hold becomes a deny carrying core's reason verbatim", async () => {
    const reason = "HELD CLR-0042: needs approval from finance. Do not try another way.";
    decide = () => ({ decision: "hold", reason, request_id: "CLR-0042" });
    const res = await post(vendor, load(fixture));
    expect(res.statusCode).toBe(200);
    expect(decisionOf(vendor, res.json())).toEqual({ deny: true, reason });
  });

  it("a deny stays a deny with its reason", async () => {
    decide = () => ({ decision: "deny", reason: "protected config" });
    const res = await post(vendor, load(fixture));
    expect(decisionOf(vendor, res.json())).toEqual({ deny: true, reason: "protected config" });
  });

  it.each([
    ["no token", {}],
    ["a wrong token", { authorization: "Bearer wrong" }],
    ["another scheme", { authorization: `Basic ${tokenOf(FIXTURE_AGENT[vendor] ?? "")}` }],
  ])("%s is a deny with a reason, and check never runs", async (_name, headers) => {
    const res = await post(vendor, load(fixture), headers);
    expect(res.statusCode).toBe(200);
    const out = decisionOf(vendor, res.json());
    expect(out.deny).toBe(true);
    expect(out.reason).toMatch(/token/i);
    expect(res.body).not.toContain(tokenOf(FIXTURE_AGENT[vendor] ?? ""));
    expect(checks).toHaveLength(0);
  });

  it("an unknown cwd is a deny with a reason, and check never runs", async () => {
    const payload = {
      ...withoutAgentType(load(fixture)),
      cwd: "/somewhere/else",
      workspace_roots: ["/somewhere/else"],
    };
    const res = await post(vendor, payload);
    expect(res.statusCode).toBe(200);
    const out = decisionOf(vendor, res.json());
    expect(out.deny).toBe(true);
    expect(out.reason).toMatch(/directory/i);
    expect(checks).toHaveLength(0);
  });

  it("no cwd at all is a deny", async () => {
    const payload = withoutAgentType(load(fixture));
    delete payload.cwd;
    delete payload.workspace_roots;
    const res = await post(vendor, payload);
    expect(decisionOf(vendor, res.json()).deny).toBe(true);
    expect(checks).toHaveLength(0);
  });

  it.each([
    ["broken JSON", "{not json"],
    ["an empty body", ""],
    ["a JSON string", '"hello"'],
    ["a JSON array", "[]"],
    ["an object with nothing useful", "{}"],
  ])("%s is a deny with a reason", async (_name, payload) => {
    const res = await post(vendor, payload);
    expect(res.statusCode).toBe(200);
    expect(decisionOf(vendor, res.json()).deny).toBe(true);
    expect(checks).toHaveLength(0);
  });

  it("a recognised tool with unusable arguments is a deny", async () => {
    const res = await post(vendor, {
      ...load(fixture),
      tool_input: {},
      args: {},
      command: "",
    });
    expect(decisionOf(vendor, res.json()).deny).toBe(true);
    expect(checks).toHaveLength(0);
  });

  it("a check that throws is a deny that does not leak the error", async () => {
    decide = () => {
      throw new Error("sqlite is on fire at /secret/path");
    };
    const res = await post(vendor, load(fixture));
    expect(res.statusCode).toBe(200);
    const out = decisionOf(vendor, res.json());
    expect(out.deny).toBe(true);
    expect(out.reason).toBeTruthy();
    expect(res.body).not.toContain("/secret/path");
  });

  it("a check that returns junk is a deny", async () => {
    decide = () => ({ decision: "maybe", reason: "x" }) as unknown as CheckResponse;
    const res = await post(vendor, load(fixture));
    expect(decisionOf(vendor, res.json()).deny).toBe(true);
  });

  it("a check that never answers is a deny once the timeout passes", async () => {
    await app.close();
    await build({ checkTimeoutMs: 20 });
    decide = () => new Promise(() => {});
    const res = await post(vendor, load(fixture));
    expect(res.statusCode).toBe(200);
    expect(decisionOf(vendor, res.json()).deny).toBe(true);
  });

  it("an oversized body is a deny, not a framework error", async () => {
    const res = await post(vendor, { ...load(fixture), filler: "x".repeat(17 * 1024 * 1024) });
    expect(res.statusCode).toBe(200);
    expect(decisionOf(vendor, res.json()).deny).toBe(true);
    expect(checks).toHaveLength(0);
  });

  it("answers with no content type header at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/hooks/${vendor}`,
      headers: as(FIXTURE_AGENT[vendor] ?? ""),
      payload: JSON.stringify(load(fixture)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});

describe("agent resolution", () => {
  it("accepts a subdirectory of an agent's directory", async () => {
    const res = await post(
      "claude",
      {
        ...withoutAgentType(load("claude-pretooluse")),
        cwd: "/home/agent/coder/src/deep",
      },
      as("coder"),
    );
    expect(decisionOf("claude", res.json()).deny).toBe(false);
    expect(checks[0]!.agent.name).toBe("coder");
  });

  it("does not let .. walk into another agent's directory unnoticed", async () => {
    const res = await post(
      "claude",
      {
        ...withoutAgentType(load("claude-pretooluse")),
        cwd: "/home/agent/coder/../refunds-agent",
      },
      as("coder"),
    );
    expect(decisionOf("claude", res.json()).deny).toBe(true);
    expect(checks).toHaveLength(0);
  });

  it("a resolver that throws is a deny", async () => {
    await app.close();
    await build({
      resolveAgent: () => {
        throw new Error("team.yaml is broken");
      },
    });
    const res = await post("claude", load("claude-pretooluse"));
    expect(decisionOf("claude", res.json()).deny).toBe(true);
    expect(res.body).not.toContain("team.yaml");
    expect(checks).toHaveLength(0);
  });
});

describe("agent_type, the Switch agent name on real Claude payloads", () => {
  const real = () => load("claude-pretooluse");

  it("identifies the agent, wherever the session has wandered", async () => {
    const res = await post("claude", { ...real(), cwd: "/somewhere/else" });
    expect(decisionOf("claude", res.json()).deny).toBe(false);
    expect(checks[0]!.agent.name).toBe("spike-s1");
  });

  it("an agent holding a token but not in the team is a deny", async () => {
    const res = await post(
      "claude",
      {
        ...real(),
        agent_type: "someone-else",
        cwd: "/somewhere/else",
      },
      as("someone-else"),
    );
    const out = decisionOf("claude", res.json());
    expect(out.deny).toBe(true);
    expect(out.reason).toMatch(/agent/i);
    expect(checks).toHaveLength(0);
  });

  it("the directory is checked instead when it is absent", async () => {
    await post("claude", { ...withoutAgentType(real()), cwd: "/home/agent/coder" }, as("coder"));
    expect(checks[0]!.agent.name).toBe("coder");
  });

  it("inside a subagent it names the subagent, so it is not compared with the token", async () => {
    await post(
      "claude",
      {
        ...real(),
        agent_id: "agent-1",
        agent_type: "Explore",
        cwd: "/home/agent/coder",
      },
      as("coder"),
    );
    expect(checks[0]!.agent.name).toBe("coder");
  });

  it("is ignored when it is not a string", async () => {
    await post("claude", { ...real(), agent_type: 5, cwd: "/home/agent/coder" }, as("coder"));
    expect(checks[0]!.agent.name).toBe("coder");
  });

  it("means nothing on another vendor's payload", async () => {
    await post("codex", { ...load("codex-pretooluse-stubmodel"), agent_type: "coder" });
    expect(checks[0]!.agent.name).toBe("support-agent");
  });
});

describe("the token decides the agent (audit F5)", () => {
  const claude = () => load("claude-pretooluse");
  const expectForgeryRefused = (
    vendor: string,
    res: { statusCode: number; json: () => Record<string, never> },
    holder: string,
    claimed: string,
  ) => {
    expect(res.statusCode).toBe(200);
    const out = decisionOf(vendor, res.json());
    expect(out.deny).toBe(true);
    expect(out.reason).toContain(holder);
    expect(out.reason).toContain(claimed);
    expect(checks).toHaveLength(0);
  };

  describe.each(ROUTES)("another agent's token on /v1/hooks/%s with %s", (vendor, fixture) => {
    it("is a deny, and check never runs", async () => {
      const holder = FIXTURE_AGENT[vendor] === "coder" ? "ops-agent" : "coder";
      const res = await post(vendor, load(fixture), as(holder));
      expect(decisionOf(vendor, res.json()).deny).toBe(true);
      expect(decisionOf(vendor, res.json()).reason).toContain(holder);
      expect(checks).toHaveLength(0);
    });
  });

  it("a forged agent_type is a deny", async () => {
    const res = await post(
      "claude",
      { ...claude(), agent_type: "coder", cwd: undefined },
      as("ops-agent"),
    );
    expectForgeryRefused("claude", res, "ops-agent", "coder");
  });

  it("a forged agent_type is a deny even from the forger's own directory", async () => {
    const res = await post(
      "claude",
      { ...claude(), agent_type: "coder", cwd: "/home/agent/ops-agent" },
      as("ops-agent"),
    );
    expectForgeryRefused("claude", res, "ops-agent", "coder");
  });

  it("a true agent_type with a forged cwd is a deny", async () => {
    const res = await post(
      "claude",
      { ...claude(), agent_type: "coder", cwd: "/home/agent/refunds-agent" },
      as("coder"),
    );
    expectForgeryRefused("claude", res, "coder", "refunds-agent");
  });

  it("a forged cwd behind a subagent's agent_type is a deny", async () => {
    const res = await post(
      "claude",
      { ...claude(), agent_id: "agent-1", agent_type: "Explore", cwd: "/home/agent/coder" },
      as("ops-agent"),
    );
    expectForgeryRefused("claude", res, "ops-agent", "coder");
  });

  it.each([
    ["codex", "codex-pretooluse-stubmodel", { cwd: "/home/agent/coder" }],
    ["codex", "codex-permissionrequest-bash", { cwd: "/home/agent/coder" }],
    ["opencode", "opencode-tool-execute-before", { cwd: "/home/agent/coder" }],
    ["cursor", "cursor-before-shell", { workspace_roots: ["/home/agent/coder"] }],
  ])("a forged cwd on %s (%s) is a deny", async (vendor, fixture, forged) => {
    const holder = FIXTURE_AGENT[vendor] ?? "";
    const res = await post(vendor, { ...load(fixture), ...forged });
    expectForgeryRefused(vendor, res, holder, "coder");
  });

  it("an unknown token is a deny, whatever the payload claims", async () => {
    const res = await post(
      "claude",
      { ...claude(), agent_type: "coder", cwd: "/home/agent/coder" },
      { authorization: "Bearer not-a-real-token" },
    );
    expect(decisionOf("claude", res.json()).reason).toMatch(/token/i);
    expect(checks).toHaveLength(0);
  });

  it("a missing token is a deny, whatever the payload claims", async () => {
    const res = await post(
      "claude",
      { ...claude(), agent_type: "coder", cwd: "/home/agent/coder" },
      {},
    );
    expect(decisionOf("claude", res.json()).reason).toMatch(/token/i);
    expect(checks).toHaveLength(0);
  });

  it.each(Object.entries(FIXTURE_AGENT))(
    "%s: every action reaching check names the token's agent",
    async (vendor, agent) => {
      const fixture = ROUTES.find(([v]) => v === vendor)![1];
      await post(vendor, load(fixture), as(agent));
      expect(checks.length).toBeGreaterThan(0);
      for (const action of checks) expect(action.agent.name).toBe(agent);
    },
  );

  it("every file of a multi-file patch names the token's agent", async () => {
    await post("codex", load("codex-pretooluse-apply-patch"), as("support-agent"));
    expect(checks.map((c) => c.agent.name)).toEqual(Array(5).fill("support-agent"));
  });

  it("an agent wandering outside any agent's directory keeps its identity", async () => {
    await post("claude", { ...claude(), cwd: "/tmp/elsewhere" }, as("spike-s1"));
    expect(checks[0]!.agent.name).toBe("spike-s1");
  });

  it("an unknown cwd stays a deny where the vendor has no agent_type", async () => {
    const res = await post("codex", {
      ...load("codex-pretooluse-stubmodel"),
      cwd: "/tmp/elsewhere",
    });
    expect(decisionOf("codex", res.json()).reason).toMatch(/directory/i);
    expect(checks).toHaveLength(0);
  });

  it("does not let one agent reuse another's allow for the same session and call", async () => {
    await post("codex", load("codex-pretooluse-stubmodel"), as("support-agent"));
    await post(
      "codex",
      { ...load("codex-permissionrequest-bash"), cwd: "/home/agent/reviewer" },
      as("reviewer"),
    );
    expect(checks.map((c) => c.agent.name)).toEqual(["support-agent", "reviewer"]);
  });
});

describe("Claude specifics", () => {
  it("answers exactly the PreToolUse shape", async () => {
    const res = await post("claude", load("claude-pretooluse"));
    expect(res.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "ok",
      },
    });
  });

  it("never answers ask", async () => {
    for (const decision of ["allow", "hold", "deny"] as const) {
      decide = () => ({ decision, reason: "x", request_id: "CLR-1" });
      const res = await post("claude", load("claude-pretooluse"));
      expect(res.body).not.toContain('"ask"');
    }
  });
});

describe("multi-file patches", () => {
  const patch = () => load("codex-pretooluse-apply-patch");

  it("allows only when every file is allowed", async () => {
    const res = await post("codex", patch());
    expect(res.json()).toEqual({});
    expect(checks).toHaveLength(5);
  });

  it("denies when any one file is not allowed, and says why", async () => {
    decide = (action) =>
      action.file?.path?.startsWith(".codex")
        ? { decision: "deny", reason: "protected config" }
        : { decision: "allow", reason: "ok" };
    const res = await post("codex", patch());
    expect(decisionOf("codex", res.json())).toEqual({ deny: true, reason: "protected config" });
    expect(checks.map((c) => c.file?.path)).toEqual([
      "src/checkout.ts",
      "docs/note.md",
      ".codex/hooks.json",
    ]);
  });
});

describe("Codex PreToolUse then PermissionRequest for one call", () => {
  const pre = () => load("codex-pretooluse-stubmodel");
  const perm = () => load("codex-permissionrequest-bash");

  it("does not spend a single-use grant twice: the second event reuses the allow", async () => {
    let grants = 1;
    decide = () =>
      grants-- > 0
        ? { decision: "allow", reason: "grant", grant_consumed: true }
        : { decision: "hold", reason: "HELD CLR-9", request_id: "CLR-9" };
    expect(decisionOf("codex", (await post("codex", pre())).json()).deny).toBe(false);
    const second = await post("codex", perm());
    expect(decisionOf("codex", second.json()).deny).toBe(false);
    expect(checks).toHaveLength(1);
  });

  it("reuses it once only", async () => {
    await post("codex", pre());
    await post("codex", perm());
    await post("codex", perm());
    expect(checks).toHaveLength(2);
  });

  it("does not reuse across sessions, turns or changed commands", async () => {
    await post("codex", pre());
    await post("codex", { ...perm(), session_id: "other" });
    await post("codex", pre());
    await post("codex", { ...perm(), turn_id: "turn-other" });
    await post("codex", pre());
    const changed = perm();
    changed.tool_input = { command: "git push origin main" };
    await post("codex", changed);
    expect(checks).toHaveLength(6);
  });

  it("does not reuse a hold or a deny", async () => {
    decide = () => ({ decision: "hold", reason: "HELD CLR-1", request_id: "CLR-1" });
    await post("codex", pre());
    await post("codex", perm());
    expect(checks).toHaveLength(2);
  });

  it("does not reuse an allow once it has expired", async () => {
    await app.close();
    let now = 1000;
    await build({ now: () => now });
    await post("codex", pre());
    now += 121_000;
    await post("codex", perm());
    expect(checks).toHaveLength(2);
  });

  it("two identical PreToolUse calls both go to check", async () => {
    await post("codex", pre());
    await post("codex", pre());
    expect(checks).toHaveLength(2);
  });
});

describe("registration", () => {
  it("works as a plugin through app.register too", async () => {
    const other = Fastify();
    await other.register(hookRoutes, {
      check: async () => ({ decision: "allow", reason: "ok" }),
      resolveAgent: () => "spike-s1",
      hookTokens: HOOK_TOKENS,
    });
    const res = await other.inject({
      method: "POST",
      url: "/v1/hooks/claude",
      headers: as("spike-s1"),
      payload: JSON.stringify(load("claude-pretooluse")),
    });
    expect(res.statusCode).toBe(200);
    expect(decisionOf("claude", res.json()).deny).toBe(false);
    await other.close();
  });

  it("does not change JSON parsing on the rest of the app", async () => {
    const other = Fastify();
    other.post("/other", async (req) => req.body);
    await hookRoutes(other, {
      check: async () => ({ decision: "allow", reason: "ok" }),
      resolveAgent: () => "coder",
      hookTokens: HOOK_TOKENS,
    });
    const res = await other.inject({ method: "POST", url: "/other", payload: { a: 1 } });
    expect(res.json()).toEqual({ a: 1 });
    await other.close();
  });

  it.each([
    ["no tokens", {}],
    ["an empty token", { "": "coder" }],
    ["a token with no agent", { "tok-coder": "" }],
  ])("denies everything when configured with %s", async (_name, hookTokens) => {
    await app.close();
    await build({ hookTokens });
    for (const headers of [{ authorization: "Bearer " }, as("coder"), {}]) {
      const res = await post("claude", load("claude-pretooluse"), headers);
      expect(decisionOf("claude", res.json()).deny).toBe(true);
    }
    expect(checks).toHaveLength(0);
  });

  it("denies everything when the old single hookToken option is all it is given", async () => {
    await app.close();
    await build({ hookTokens: undefined, hookToken: "tok-coder" } as never);
    const res = await post("claude", load("claude-pretooluse"), as("coder"));
    expect(decisionOf("claude", res.json()).deny).toBe(true);
    expect(checks).toHaveLength(0);
  });
});
