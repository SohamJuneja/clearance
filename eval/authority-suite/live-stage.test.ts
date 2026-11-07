import { describe, expect, it } from "vitest";
import {
  hookTokenFor,
  lastLineSince,
  runningAgents,
  serviceOwnsGroup,
  withAccountListed,
  withAgentsStopped,
  wouldWake,
} from "./live-stage.ts";

describe("--live won't start a session", () => {
  it("names any managed agent that is running, because naming it in a room would wake it", () => {
    expect(
      runningAgents([
        { name: "refunds-agent", desired_state: "stopped" },
        { name: "coder", desired_state: "running" },
        { name: "ops-agent", desired_state: "running" },
      ]),
    ).toEqual(["coder", "ops-agent"]);
  });

  it("is happy when every agent is stopped", () => {
    expect(runningAgents([{ name: "refunds-agent", desired_state: "stopped" }])).toEqual([]);
  });

  it("counts an agent whose state it can't read as running: it fails closed", () => {
    expect(runningAgents([{ name: "coder" }])).toEqual(["coder"]);
  });

  it("knows which running agent a message would wake, whatever the case", () => {
    expect(wouldWake("@coder push my branch to main", ["coder"])).toEqual(["coder"]);
    expect(wouldWake("@Coder push my branch to main", ["coder"])).toEqual(["coder"]);
    expect(wouldWake("please ask @refunds-agent, then @coder", ["coder", "ops-agent"])).toEqual(["coder"]);
  });

  it("lets through a message that names only a stopped agent, or Clearance", () => {
    expect(wouldWake("@refunds-agent refund order A-2004", ["coder"])).toEqual([]);
    expect(wouldWake("@clearance autonomy coder", ["coder"])).toEqual([]);
    expect(wouldWake("nobody named here", ["coder"])).toEqual([]);
  });
});

describe("agents left running by someone else's run", () => {
  function control(running: string[]) {
    const calls: string[] = [];
    return {
      calls,
      control: {
        running: async () => running,
        stop: async (names: string[]) => void calls.push(`stop ${names.join(",")}`),
        restore: async (names: string[]) => void calls.push(`restore ${names.join(",")}`),
      },
    };
  }

  it("stops them for the run, and puts back exactly those", async () => {
    const { calls, control: agents } = control(["coder", "ops-agent"]);
    const result = await withAgentsStopped(agents, async () => {
      calls.push("work");
      return 7;
    });
    expect(result).toBe(7);
    expect(calls).toEqual(["stop coder,ops-agent", "work", "restore coder,ops-agent"]);
  });

  it("puts them back even when the run fails", async () => {
    const { calls, control: agents } = control(["coder"]);
    await expect(
      withAgentsStopped(agents, async () => {
        throw new Error("the run fell over");
      }),
    ).rejects.toThrow("the run fell over");
    expect(calls).toEqual(["stop coder", "restore coder"]);
  });

  it("starts nothing when nothing was running", async () => {
    const { calls, control: agents } = control([]);
    await withAgentsStopped(agents, async () => void calls.push("work"));
    expect(calls).toEqual(["work"]);
  });

  it("puts back any it did stop if stopping another one fails", async () => {
    const { calls, control: agents } = control(["coder", "ops-agent"]);
    agents.stop = async () => {
      calls.push("stop failed");
      throw new Error("Switch said no");
    };
    await expect(withAgentsStopped(agents, async () => void calls.push("work"))).rejects.toThrow(
      "Switch said no",
    );
    expect(calls).toEqual(["stop failed", "restore coder,ops-agent"]);
  });
});

describe("listing an account on Clearance's addressing", () => {
  const policy = {
    rules: [{ rooms: "*", users: ["row-sam", "row-neha"], agents: "*", owner: true }],
  };

  it("adds the account to the rule that lists people, and leaves the rest of the rule alone", () => {
    expect(withAccountListed(policy, "row-second")).toEqual({
      rules: [{ rooms: "*", users: ["row-sam", "row-neha", "row-second"], agents: "*", owner: true }],
    });
  });

  it("doesn't change what it was given, because that's what gets put back", () => {
    const before = JSON.stringify(policy);
    withAccountListed(policy, "row-second");
    expect(JSON.stringify(policy)).toBe(before);
  });

  it("doesn't list an account twice", () => {
    expect(withAccountListed(policy, "row-sam")).toEqual(policy);
  });

  it("refuses a policy with no list of people, rather than guess what it means", () => {
    expect(() => withAccountListed({ rules: [{ users: "*" }] }, "row-second")).toThrow(/no rule lists people/);
    expect(() => withAccountListed({ rules: [] }, "row-second")).toThrow(/no rule lists people/);
    expect(() => withAccountListed(null, "row-second")).toThrow(/no rule lists people/);
  });
});

describe("hook tokens", () => {
  const file = { "secret-token-one": "coder", "secret-token-two": "refunds-agent" };

  it("finds an agent's token in a file whose keys are the tokens", () => {
    expect(hookTokenFor(file, "coder")).toBe("secret-token-one");
  });

  it("names the agent and never a token when there is none", () => {
    let message = "";
    try {
      hookTokenFor(file, "ops-agent");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("ops-agent");
    expect(message).not.toContain("secret-token");
  });
});

describe("knowing core is back on Switch", () => {
  const line = "clearance-core listening on 127.0.0.1:7700, Switch agent connected";

  it("only counts a line written after the restart began", () => {
    const before = `${line}\n`;
    expect(lastLineSince(before, before.length, /Switch agent connected/)).toBe(false);
    expect(lastLineSince(`${before}${line}\n`, before.length, /Switch agent connected/)).toBe(true);
  });

  it("isn't fooled by a log that was cut shorter than where it was", () => {
    expect(lastLineSince(`${line}\n`, 10_000, /Switch agent connected/)).toBe(true);
  });
});

describe("killing a service", () => {
  it("only touches a process group whose leader is that service of ours", () => {
    const cmdline = "node\0/x/tsx/dist/cli.mjs\0--env-file=.env\0packages/core/src/main.ts\0";
    expect(serviceOwnsGroup(cmdline, "core")).toBe(true);
    expect(serviceOwnsGroup(cmdline, "gate")).toBe(false);
    expect(serviceOwnsGroup("postgres\0-D\0/var/lib\0", "core")).toBe(false);
    expect(serviceOwnsGroup("", "core")).toBe(false);
  });
});
