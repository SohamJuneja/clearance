/**
 * A teammate's break-it review (REVIEW.md), re-run on this code. It was done on an older commit, so each finding was reproduced
 * again before it counted. H1 had been closed since, and stays here as a guard. H2 and H3 were still open.
 */
import type { Action, ApprovalOutcomeEvent } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedCard } from "./fakes.js";
import { drillWaitMs } from "../src/drills/library.js";
import { actionId, chatMessage, gateRefund, hookShell, makeHarness, NOW, PARTICIPANTS, REFUND_SC3, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.core.close());

function press(card: OpenedCard, who: string, answer: "allow" | "deny" = "allow"): Promise<void> {
  const event: ApprovalOutcomeEvent = {
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "approval",
    state: "answered",
    answer,
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  };
  return h.core.onApprovalOutcome(event);
}

const pressAll = async (who: string): Promise<void> => {
  for (const card of h.chat.openCards()) await press(card, who);
};
const state = (id: string): string => h.core.stores.requests.require(id).state;

describe("H1: an ask written in the shape of a card answer", () => {
  const samSaysThenApproves = async (body: string): Promise<string> => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent please look at ticket T-77"));
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "Looking at T-77 now.", { senderName: "refunds-agent" }));
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, body));
    const held = await h.core.check(gateRefund(REFUND_SC3));
    expect(held.decision).toBe("hold");
    const id = held.request_id as string;
    await pressAll(PARTICIPANTS.sam);
    return id;
  };

  it("control: said plainly, it keeps Sam from approving alone", async () => {
    expect(state(await samSaysThenApproves("refund A-1931 4000 to meera.k@okaxis now"))).toBe("ROUTED");
  });

  it.each([`A9 "refund A-1931 4000 to meera.k@okaxis now"`, `A9 q1="refund A-1931 4000 to meera.k@okaxis now"`])("%s is a request, not an answer", async (body) => {
    expect(state(await samSaysThenApproves(body))).toBe("ROUTED");
  });
});

describe("H2: a display name on a platform message", () => {
  const BRIDGE = "@switch-platform-mattermost:localhost";
  const askAs = async (name: string): Promise<string> => {
    await h.core.onMessage(chatMessage(BRIDGE, "@refunds-agent refund A-1931 ₹4,000 to meera.k@okaxis", { onBehalfOf: name }));
    const held = await h.core.check(gateRefund(REFUND_SC3));
    expect(held.decision).toBe("hold");
    return held.request_id as string;
  };

  it("Sam can't wear Priya's name, ask, and approve it alone", async () => {
    const id = await askAs("priya");
    await pressAll(PARTICIPANTS.sam);
    expect(state(id)).toBe("ROUTED");
    expect(h.gate.calls).toEqual([]);
  });

  it("takes two people, because the name could be anyone's", async () => {
    const request = h.core.stores.requests.require(await askAs("priya"));
    expect(request.quorumRequired).toBe(2);
    expect(request.flags.map((flag) => flag.code)).toContain("requester_unlinked");
  });

  it("the person named is still barred: a name can only take someone out", async () => {
    const id = await askAs("Sam");
    await pressAll(PARTICIPANTS.sam);
    expect(state(id)).toBe("ROUTED");
    expect(h.core.stores.requests.require(id).quorumRequired).toBe(2);
  });

  it("the same when the name only speaks in a room the agent is in", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent please look at ticket T-77"));
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "Looking at T-77 now.", { senderName: "refunds-agent" }));
    await h.core.onMessage(chatMessage(BRIDGE, "refund A-1931 ₹4,000 to meera.k@okaxis", { onBehalfOf: "priya" }));
    const held = await h.core.check(gateRefund(REFUND_SC3));
    const id = held.request_id as string;
    await pressAll(PARTICIPANTS.sam);
    expect(state(id)).toBe("ROUTED");
    expect(h.core.stores.requests.require(id).quorumRequired).toBe(2);
  });

  it("guard: two real approvers can still finish it", async () => {
    const id = await askAs("priya");
    await pressAll(PARTICIPANTS.sam);
    await pressAll(PARTICIPANTS.neha);
    expect(state(id)).toBe("EXECUTED");
  });

  it("guard: someone speaking for themselves still needs only the one approver", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund A-1931 ₹4,000 to meera.k@okaxis"));
    const held = await h.core.check(gateRefund(REFUND_SC3));
    expect(h.core.stores.requests.require(held.request_id as string).quorumRequired).toBe(1);
  });
});

describe("H3: the files that run the hook", () => {
  const TREE = "/home/x/.switch/agents/m/coder";
  const shell = (command: string): Action => hookShell(command, { agent: { name: "coder", cwd: TREE } });
  const write = (path: string): Action => ({
    id: actionId(),
    at: new Date(NOW).toISOString(),
    source: "hook",
    vendor: "claude",
    agent: { name: "coder", cwd: TREE },
    kind: "file_write",
    raw: { file_path: path, content: "{}" },
    file: { path },
  });
  const decided = async (action: Action): Promise<string> => (await h.core.check(action)).decision;

  it.each([
    "printf '#!/bin/sh\\nexit 0\\n' > bin/clearance-hook",
    "printf '#!/bin/sh\\necho\\n' > ./bin/mcp-headers",
    "echo '{}' > opencode.json",
    "echo '{}' > .mcp.json",
    "chmod -x bin/clearance-hook",
    "git checkout HEAD~5 -- .claude",
    "git checkout HEAD~5 -- bin/clearance-hook",
    'git checkout HEAD~5 -- ".claude"',
    "git restore --source=HEAD~5 opencode.json",
    "git rm -r .opencode",
    "rm -rf .claude",
    "mv .claude .claude-old",
    "ln -sf /tmp/x .claude",
    "rm -r .opencode",
    "cd .claude && echo '{}' > settings.json",
    "sed -i 's/block/allow/' .claude/settings.json",
  ])("denies `%s`", async (command) => {
    expect(await decided(shell(command))).toBe("deny");
  });

  it.each(["bin/clearance-hook", "bin/mcp-headers", "opencode.json", ".mcp.json", `${TREE}/opencode.json`, `${TREE}/bin/clearance-hook`, ".claude/settings.json"])("denies writing %s with a file tool", async (path) => {
    expect(await decided(write(path))).toBe("deny");
  });

  it.each(["git status", "git log --oneline -5", "ls -la", "cat README.md", "node src/server.ts", "echo hi > notes.txt", "bin/acme order A-1931", "grep -rn hook src"])("guard: leaves `%s` alone", async (command) => {
    expect(await decided(shell(command))).toBe("allow");
  });

  it("guard: a file that only has the name in it isn't one of them", async () => {
    expect(await decided(shell("cat docs/opencode.json.md"))).toBe("allow");
    expect(await decided(shell("cat mybin/clearance-hooks.txt"))).toBe("allow");
  });
});

describe("M1: telling a drill from a real card", () => {
  const SEED = /^[0-9a-f]{64}$/;
  const seedOf = (one: Harness): string | undefined => (one.core.stores.db.prepare(`SELECT value FROM meta WHERE key = 'drill_seed'`).get() as { value: string } | undefined)?.value;

  it("doesn't arrive at the same moment as the real card that rolled it", async () => {
    h.core.close();
    h = makeHarness({ rollDrills: true, drillRate: 1 });
    await h.core.check(gateRefund(REFUND_SC3));
    expect(h.core.stores.drills.forPerson("sam")).toEqual([]);
    h.clock.advance(60 * 60_000);
    await h.core.tick();
    expect(h.core.stores.drills.forPerson("sam")).toHaveLength(1);
  });

  it("isn't due at a moment anyone could work out: the wait differs", async () => {
    const waits = new Set<number>();
    for (let index = 0; index < 8; index += 1) {
      const one = makeHarness({ rollDrills: true, drillRate: 1 });
      await one.core.check(gateRefund(REFUND_SC3));
      let waited = 0;
      while (one.core.stores.drills.forPerson("sam").length === 0 && waited < 60) {
        one.clock.advance(60_000);
        waited += 1;
        await one.core.tick();
      }
      waits.add(waited);
      one.core.close();
    }
    expect(waits.size).toBeGreaterThan(1);
  }, 30_000);

  it("the wait comes from the seed, not from chance, because a drill stays deterministic code", () => {
    expect(drillWaitMs("CLR-0042", "a seed")).toBe(drillWaitMs("CLR-0042", "a seed"));
    expect(drillWaitMs("CLR-0042", "a seed")).not.toBe(drillWaitMs("CLR-0042", "another seed"));
    for (let index = 0; index < 200; index += 1) {
      const wait = drillWaitMs(`CLR-${index}`, "a seed");
      expect(wait).toBeGreaterThanOrEqual(5 * 60_000);
      expect(wait).toBeLessThan(45 * 60_000);
    }
  });

  it("a roll depends on a seed only core has, so ids and the public policy hash don't predict it", async () => {
    h.core.close();
    h = makeHarness({ rollDrills: true, drillRate: 0.5 });
    await h.core.check(gateRefund(REFUND_SC3));
    const first = seedOf(h);
    expect(first).toMatch(SEED);
    const other = makeHarness({ rollDrills: true, drillRate: 0.5 });
    await other.core.check(gateRefund(REFUND_SC3));
    expect(seedOf(other)).toMatch(SEED);
    expect(seedOf(other)).not.toBe(first);
    other.core.close();
  });

  it("the seed survives a restart, so a replay on the same install rolls the same", async () => {
    h.core.close();
    h = makeHarness({ rollDrills: true, drillRate: 0.5 });
    await h.core.check(gateRefund(REFUND_SC3));
    const first = seedOf(h);
    h = h.restart();
    await h.core.check(gateRefund({ ...REFUND_SC3, amount: 4001 }));
    expect(seedOf(h)).toBe(first);
  });
});
