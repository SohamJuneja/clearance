import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastRefusal, limitIn } from "./model-refusal.ts";
import {
  checkLines,
  type CheckState,
  chosenOpenCodeModel,
  freeModels,
  pickFreeModel,
  type ProbeIo,
  provedToolCall,
  type Run,
  runWatching,
} from "./opencode-model.ts";

/** `opencode models opencode --verbose`, cut down from a real run: a name on its own line, then its details. */
const listed = (name: string, overrides: Record<string, unknown> = {}) =>
  `${name}\n${JSON.stringify({ status: "active", cost: { input: 0, output: 0 }, capabilities: { toolcall: true }, ...overrides }, null, 2)}\n`;

const TOKEN = "probe-abc123";
/** The events `opencode run --format json` printed for a real tool call, with what doesn't matter left out. */
const toolEvent = (output: string, status = "completed") =>
  JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "read", state: { status, output } } });
const textEvent = (text: string) => JSON.stringify({ type: "text", part: { type: "text", text } });
const proved = (token: string): Run => ({
  stdout: `${toolEvent(`<file>${token}</file>`)}\n${textEvent(token)}\n`,
  refusal: null,
  timedOut: false,
});

describe("freeModels", () => {
  it("lists what costs nothing and can call tools, in the order OpenCode gives", () => {
    const text = [listed("opencode/beam-free"), listed("opencode/big-pickle")].join("");
    expect(freeModels(text)).toEqual(["opencode/beam-free", "opencode/big-pickle"]);
  });

  it("goes by OpenCode's own numbers, not by the name", () => {
    const text = [
      listed("opencode/gpt-paid", { cost: { input: 3, output: 15 } }),
      listed("opencode/half-free-free", { cost: { input: 0, output: 2 } }),
      listed("opencode/big-pickle"),
    ].join("");
    expect(freeModels(text)).toEqual(["opencode/big-pickle"]);
  });

  it("leaves out a model that can't call tools, or that's on its way out", () => {
    const text = [
      listed("opencode/no-tools-free", { capabilities: { toolcall: false } }),
      listed("opencode/old-free", { status: "deprecated" }),
      listed("opencode/beam-free"),
    ].join("");
    expect(freeModels(text)).toEqual(["opencode/beam-free"]);
  });

  it("copes with colour in the output, and with text that isn't a model", () => {
    expect(freeModels(`\x1b[0mopencode/beam-free\x1b[0m\n{}\nnot/json\nnot json at all\n`)).toEqual([]);
    expect(freeModels("")).toEqual([]);
  });
});

describe("provedToolCall", () => {
  it("needs the token from a completed tool and then in the reply", () => {
    expect(provedToolCall(proved(TOKEN).stdout, TOKEN)).toBe(true);
  });

  it("isn't fooled by a reply alone, which is a model that can't have read the file", () => {
    expect(provedToolCall(textEvent(TOKEN), TOKEN)).toBe(false);
  });

  it("isn't fooled by a tool call with no reply, or one that failed", () => {
    expect(provedToolCall(toolEvent(TOKEN), TOKEN)).toBe(false);
    expect(provedToolCall(`${toolEvent(TOKEN, "error")}\n${textEvent(TOKEN)}`, TOKEN)).toBe(false);
  });

  it("isn't fooled by another token, or by output that isn't an event", () => {
    expect(provedToolCall(proved("probe-other").stdout, TOKEN)).toBe(false);
    expect(provedToolCall(`${TOKEN}\n${TOKEN}\n`, TOKEN)).toBe(false);
  });
});

describe("pickFreeModel", () => {
  const io = (results: Record<string, (token: string) => Run>, models = Object.keys(results)) => {
    const lines: string[] = [];
    const asked: string[] = [];
    const probe: ProbeIo = {
      print: (line) => lines.push(line),
      list: async () => models.map((model) => listed(model)).join(""),
      attempt: async (model, token) => {
        asked.push(model);
        return results[model]!(token);
      },
    };
    return { probe, lines, asked };
  };
  const refusing = (): Run => ({ stdout: "", refusal: "free usage limit", timedOut: false });
  const hanging = (): Run => ({ stdout: "", refusal: null, timedOut: true });
  const noTool = (): Run => ({ stdout: textEvent("ok"), refusal: null, timedOut: false });

  it("takes the first that answers and calls a tool, says which, and tries no more", async () => {
    const { probe, lines, asked } = io({
      "opencode/big-pickle": refusing,
      "opencode/deepseek-free": hanging,
      "opencode/chatty-free": noTool,
      "opencode/beam-free": proved,
      "opencode/never-tried-free": proved,
    });
    const choice = await pickFreeModel(probe);
    expect(choice.model).toBe("opencode/beam-free");
    expect(asked).not.toContain("opencode/never-tried-free");
    expect(choice.tried.map((attempt) => attempt.result)).toEqual([
      "refusing: free usage limit",
      "no answer in time",
      "no proof of a tool call",
      "answered and called a tool",
    ]);
    expect(lines.join("\n")).toContain("opencode/big-pickle: refusing: free usage limit");
  });

  it("uses a new token for each model, so one can't pass on another's", async () => {
    const tokens: string[] = [];
    const { probe } = io({
      "opencode/a-free": (token) => {
        tokens.push(token);
        return hanging();
      },
      "opencode/b-free": (token) => {
        tokens.push(token);
        return hanging();
      },
    });
    await pickFreeModel(probe);
    expect(new Set(tokens).size).toBe(2);
  });

  it("gives no model when none answers, with what each one did", async () => {
    const { probe } = io({ "opencode/big-pickle": refusing, "opencode/beam-free": hanging });
    const choice = await pickFreeModel(probe);
    expect(choice.model).toBeNull();
    expect(choice.tried).toHaveLength(2);
  });

  it("gives no model when nothing's listed, which is also what a missing OpenCode looks like, and says so", async () => {
    const { probe, lines, asked } = io({});
    expect((await pickFreeModel(probe)).model).toBeNull();
    expect(asked).toEqual([]);
    expect(lines.join("\n")).toContain("listed no free models");
  });

  it("stops trying when the time is up, so a judge isn't kept waiting", async () => {
    let clock = 0;
    const { probe, asked } = io({
      "opencode/a-free": () => {
        clock += 100;
        return hanging();
      },
      "opencode/b-free": hanging,
    });
    probe.now = () => clock;
    const choice = await pickFreeModel(probe, 50);
    expect(asked).toEqual(["opencode/a-free"]);
    expect(choice.tried[1]?.result).toBe("not tried, out of time");
  });
});

describe("runWatching", () => {
  it("ends as soon as the log says the model is refusing, as OpenCode would only retry", async () => {
    const started = Date.now();
    const run = await runWatching(
      "sh",
      ["-c", "echo 'partial'; echo 'level=ERROR error.error=\"Free usage limit reached\"' >&2; sleep 30"],
      { timeoutMs: 20_000 },
    );
    expect(run.refusal).toBe("free usage limit");
    expect(run.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("ends a hang at the timeout, and says so", async () => {
    const run = await runWatching("sh", ["-c", "sleep 30"], { timeoutMs: 200 });
    expect(run.timedOut).toBe(true);
    expect(run.refusal).toBeNull();
  });

  it("hands back what it printed", async () => {
    const run = await runWatching("sh", ["-c", "echo hello"], { timeoutMs: 5_000 });
    expect(run.stdout).toContain("hello");
  });

  it("doesn't throw when the command isn't there", async () => {
    const run = await runWatching("no-such-command-here", [], { timeoutMs: 1_000 });
    expect(run.stdout).toBe("");
  });
});

describe("what `just demo --check` says", () => {
  const state = (overrides: Partial<CheckState> = {}): CheckState => ({
    model: "",
    keySet: false,
    noFence: false,
    remembered: null,
    authProblems: [],
    refusing: null,
    ...overrides,
  });
  const refusing = {
    agent: "ops-agent",
    refusal: { reason: "free usage limit", model: "opencode/big-pickle", atMs: 0 },
  };
  const at = "2026-11-06T10:16:00.000Z";
  const text = (overrides: Partial<CheckState>) => checkLines(state(overrides)).lines.join("\n");

  it("leaves the picking to a real run", () => {
    const { lines, done } = checkLines(state());
    expect(done).toBe(false);
    expect(lines.join("\n")).toContain("just demo tries the free ones");
  });

  it("says which model was found, and asks no more of it", () => {
    const memory = { model: "opencode/beam-free", at, tried: [] };
    const { lines, done } = checkLines(state({ remembered: memory }));
    expect(done).toBe(true);
    expect(lines.join("\n")).toContain("use opencode/beam-free, which answered and called a tool at 10:16");
  });

  it("says what's lost when none answered, and that a rerun tries again", () => {
    const { lines, done } = checkLines(state({ remembered: { model: null, at, tried: [] } }));
    expect(done).toBe(false);
    expect(lines.join("\n")).toContain("no free OpenCode model answered at 10:16");
    expect(lines.join("\n")).toContain("the OpenCode scene is what's lost");
    expect(lines.join("\n")).toContain("Claude's agents and the rest of the demo still work");
  });

  it("says a remembered model is refusing, and that a rerun tries the others", () => {
    const memory = { model: "opencode/big-pickle", at, tried: [] };
    const { lines, done } = checkLines(state({ remembered: memory, refusing }));
    expect(done).toBe(false);
    expect(lines.join("\n")).toContain("this agent's model is refusing: free usage limit");
    expect(lines.join("\n")).toContain("just demo tries the others");
  });

  it("never tries another when someone chose the model, and tells them to change it", () => {
    const { lines, done } = checkLines(state({ model: "opencode/big-pickle", refusing }));
    expect(done).toBe(true);
    expect(lines.join("\n")).toContain("this agent's model is refusing");
    expect(lines.join("\n")).toContain("Change CLEARANCE_OPENCODE_MODEL");
  });

  it("goes by a chosen model over a remembered one", () => {
    const memory = { model: "opencode/beam-free", at, tried: [] };
    expect(text({ model: "opencode/glm-free", remembered: memory })).toContain("use opencode/glm-free, from CLEARANCE_OPENCODE_MODEL");
  });

  it("says a paid model needs a key, not that all is well", () => {
    expect(text({ model: "anthropic/claude-haiku-5-5" })).toContain("OPENCODE_PROVIDER_KEY is blank, so they can't sign in to anthropic");
  });

  it("says a key with no model is doing nothing", () => {
    expect(text({ keySet: true })).toContain("nothing uses the key");
  });

  it("says a model needs a provider's name", () => {
    expect(text({ model: "claude-haiku" })).toContain("OpenCode needs provider/model");
  });

  it("has work to do while a machine lacks the key", () => {
    const { lines, done } = checkLines(state({ model: "anthropic/claude-haiku-5-5", keySet: true, authProblems: ["clearance-alex-open doesn't have OPENCODE_PROVIDER_KEY yet"] }));
    expect(done).toBe(false);
    expect(lines[0]).toContain("todo");
  });

  it("says --no-fence doesn't use the key, since sessions run in the real home", () => {
    expect(text({ model: "anthropic/claude-haiku-5-5", keySet: true, noFence: true })).toContain("this host's own login");
  });
});

describe("chosenOpenCodeModel", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "opencode-model-"));
    mkdirSync(join(root, "data"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("takes the setting first", () => {
    vi.stubEnv("CLEARANCE_OPENCODE_MODEL", "anthropic/claude-haiku-5-5");
    writeFileSync(join(root, "data/opencode-model.json"), JSON.stringify({ model: "opencode/beam-free", at: "", tried: [] }));
    expect(chosenOpenCodeModel(root)).toBe("anthropic/claude-haiku-5-5");
  });

  it("remembers what the probe found, so a rerun doesn't try them all again", () => {
    writeFileSync(join(root, "data/opencode-model.json"), JSON.stringify({ model: "opencode/beam-free", at: "", tried: [] }));
    expect(chosenOpenCodeModel(root, () => "")).toBe("opencode/beam-free");
  });

  it("has nothing when none was found, and the template's name stands", () => {
    writeFileSync(join(root, "data/opencode-model.json"), JSON.stringify({ model: null, at: "", tried: [] }));
    expect(chosenOpenCodeModel(root, () => "")).toBeNull();
    rmSync(join(root, "data/opencode-model.json"));
    expect(chosenOpenCodeModel(root, () => "")).toBeNull();
  });
});

describe("lastRefusal", () => {
  /** From a real machine's log. */
  const refused = (at: string, model = "big-pickle") =>
    `timestamp=${at} level=ERROR run=84f4f5b4 message="stream error" providerID=opencode modelID=${model} session.id=ses_1 small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"`;
  const since = Date.parse("2026-11-06T10:00:00.000Z");

  it("reads the reason and the model from the line", () => {
    expect(lastRefusal(refused("2026-11-06T10:04:10.724Z"), { sinceMs: since })).toEqual({
      reason: "free usage limit",
      model: "opencode/big-pickle",
      atMs: Date.parse("2026-11-06T10:04:10.724Z"),
    });
  });

  it("doesn't hold an old limit against a model now", () => {
    expect(lastRefusal(refused("2026-11-06T09:00:00.000Z"), { sinceMs: since })).toBeNull();
  });

  it("doesn't hold one model's limit against another", () => {
    const log = refused("2026-11-06T10:04:10.724Z");
    expect(lastRefusal(log, { sinceMs: since, model: "opencode/beam-free" })).toBeNull();
    expect(lastRefusal(log, { sinceMs: since, model: "opencode/big-pickle" })).not.toBeNull();
  });

  it("takes the latest", () => {
    const log = [refused("2026-11-06T10:01:00.000Z", "first"), refused("2026-11-06T10:02:00.000Z", "second")].join("\n");
    expect(lastRefusal(log, { sinceMs: since })?.model).toBe("opencode/second");
  });

  it("leaves other errors and ordinary lines alone", () => {
    const log = [
      'timestamp=2026-11-06T10:04:10.724Z level=INFO run=1 message=loading path=/tmp/x',
      'timestamp=2026-11-06T10:04:10.724Z level=ERROR run=1 message="stream error" providerID=opencode modelID=x error.error="socket hang up"',
      'timestamp=2026-11-06T10:04:10.724Z level=ERROR run=1 message="share subscriber failed" error="Free usage limit reached"',
    ].join("\n");
    expect(lastRefusal(log, { sinceMs: since })).toBeNull();
  });

  it("knows a key the provider refused", () => {
    const line = 'timestamp=2026-11-06T10:04:10.724Z level=ERROR run=1 message="stream error" providerID=anthropic modelID=claude-haiku-5-5 error.error="AI_APICallError: invalid x-api-key"';
    expect(lastRefusal(line, { sinceMs: since })?.reason).toBe("its key was refused");
  });
});

describe("limitIn", () => {
  it("knows a limit in what an agent said", () => {
    expect(limitIn("Free usage limit reached.")).toBe("free usage limit");
    expect(limitIn("You've hit a rate limit, try later")).toBe("usage or rate limit");
    expect(limitIn("Your credit balance is too low")).toBe("out of credit");
  });

  it("doesn't take a refund limit, or Acme saying unauthorized, for a model refusing", () => {
    expect(limitIn("That's over the ₹10,000 limit, so it's waiting for finance")).toBeNull();
    expect(limitIn("The Acme API answered 401 unauthorized")).toBeNull();
  });
});
