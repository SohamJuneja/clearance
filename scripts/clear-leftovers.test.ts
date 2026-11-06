import { describe, expect, it } from "vitest";
import {
  buildPlan,
  describePlan,
  isEmptyPlan,
  isLeftover,
  KEEP,
  type Snapshot,
  staleReason,
} from "./clear-leftovers.ts";

const empty: Snapshot = {
  rooms: [],
  agents: [],
  users: [],
  channels: [],
  sidebars: [],
  machines: [],
};
const user = (name: string, deleted = false) => ({ id: `id-${name}`, name, deleted, bot: true });
const channel = (name: string, team = "switch", type = "O") => ({
  id: `id-${name}`,
  name,
  team,
  type,
});

describe("what may be removed", () => {
  it("takes the exact prefixes and the two rooms, and nothing that merely contains them", () => {
    for (const name of [
      "spike-clr-1",
      "e1-live-agent",
      "e1-live-c",
      "clearance-identity-probe",
      "fence-proof",
    ]) {
      expect(isLeftover(name)).toBe(true);
    }
    for (const name of [
      "sam / e1-live-agent",
      "myspike-room",
      "spike",
      "e1-live",
      "clearance-s9",
      "fence-proof-2",
      "Clearance-Identity-Probe",
    ]) {
      expect(isLeftover(name)).toBe(false);
    }
  });

  it("never removes what E2 needs, or the world's own agents and rooms", () => {
    for (const name of [
      ...KEEP,
      "support",
      "support-vanilla",
      "approvals",
      "refunds-agent",
      "refunds-agent-vanilla",
      "ops-agent",
      "coder",
      "clearance",
      "study-bot",
      "study-p01",
    ]) {
      expect(isLeftover(name)).toBe(false);
    }
  });
});

describe("the plan", () => {
  it("removes leftovers from Switch and Mattermost, and only those", () => {
    const plan = buildPlan({
      ...empty,
      rooms: [
        { id: "1", name: "Mattermost: fence-proof" },
        { id: "2", name: "spike-chat-1" },
        { id: "3", name: "support" },
        { id: "4", name: "ops-vanilla" },
      ],
      agents: [
        { id: "a", name: "spike-clr-9" },
        { id: "b", name: "ops-agent-vanilla" },
      ],
      users: [user("spike-tgt-1"), user("e1-live-c"), user("clearance"), user("ops-agent-vanilla")],
      channels: [
        channel("spike-chat-1"),
        channel("fence-proof"),
        channel("support"),
        channel("ops-vanilla"),
      ],
    });
    expect(plan.rooms.map((room) => room.id)).toEqual(["1", "2"]);
    expect(plan.agents.map((agent) => agent.name)).toEqual(["spike-clr-9"]);
    expect(plan.bots.map((bot) => bot.name)).toEqual(["spike-tgt-1", "e1-live-c"]);
    expect(plan.channels.map((found) => found.name)).toEqual(["spike-chat-1", "fence-proof"]);
  });

  it("stays inside the switch team", () => {
    const plan = buildPlan({ ...empty, channels: [channel("spike-elsewhere", "other-team")] });
    expect(plan.channels).toEqual([]);
    expect(plan.listed.join("\n")).toContain("spike-elsewhere");
  });

  it("is empty when run again, because a deactivated bot and a removed room are not in it", () => {
    const plan = buildPlan({ ...empty, users: [user("spike-tgt-1", true)] });
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it("still hides a deactivated bot's direct channel, which stays in the sidebar", () => {
    const sidebars = [{ person: "sam", botId: "id-spike-tgt-1", botName: "spike-tgt-1" }];
    const plan = buildPlan({ ...empty, users: [user("spike-tgt-1", true)], sidebars });
    expect(plan.sidebars).toEqual(sidebars);
    expect(isEmptyPlan(plan)).toBe(false);
  });

  it("lists other stale things rather than removing them", () => {
    const plan = buildPlan({
      ...empty,
      rooms: [
        { id: "1", name: "sam / e1-live-agent" },
        { id: "2", name: "Mattermost: priya / refunds-agent" },
      ],
      users: [user("clearance-s9")],
      channels: [channel("support-take-20261106-010203"), channel("mystery")],
      machines: [{ owner: "alex", name: "old", revoked: true }],
    });
    expect(isEmptyPlan(plan)).toBe(true);
    const listed = plan.listed.join("\n");
    expect(listed).toContain("sam / e1-live-agent");
    expect(listed).toContain("priya / refunds-agent");
    expect(listed).toContain("clearance-s9");
    expect(listed).toContain("mystery");
    expect(listed).toContain("1 retired *-take-* channels");
    expect(listed).toContain("machine old (alex): revoked");
    expect(describePlan(plan).join("\n")).toContain("Left alone, but it looks stale");
  });

  it("has nothing to say about the stack's own rooms", () => {
    for (const name of [
      "Off-Topic",
      "Mattermost: sam / clearance",
      "study-p03",
      "support",
      "ops-vanilla",
    ]) {
      expect(staleReason("room", name)).toBeUndefined();
    }
  });

  it("doesn't call the template's agents stale while they wait for a login", () => {
    for (const name of ["support-agent", "reviewer"]) {
      expect(staleReason("account", name), name).toBeUndefined();
      expect(isLeftover(name), name).toBe(false);
    }
  });
});
