import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { groupOf, policyRoomMap, roomLimitedPolicy, roomsOf, roomsOfAgents, withRoomMap, worldDocument } from "./setup-world.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const template = readFileSync(join(REPO, "templates/acme-mini.template.yaml"), "utf8");
type Doc = { resources: Record<string, { type?: string; agents?: string[]; group?: string; name?: string }> };
const resources = (text: string | null) => (parse(text ?? "") as Doc).resources;

describe("roomsOf", () => {
  it("finds the four rooms PLAN 8.3 names, with their agents", () => {
    const rooms = roomsOf(template);
    expect(rooms.map((r) => r.name).sort()).toEqual(["approvals", "eng", "finance", "support"]);
    expect(rooms.find((r) => r.name === "support")?.agents).toContain("refunds-agent");
  });
});

describe("worldDocument", () => {
  const everyone = ["refunds-agent", "support-agent", "coder", "ops-agent", "reviewer", "clearance"];

  it("names no agent that does not exist, because the server refuses the whole run", () => {
    const text = worldDocument(template, { agents: ["refunds-agent", "ops-agent", "clearance"], rooms: [] });
    const out = resources(text);
    expect(out.support?.agents).toEqual(["refunds-agent", "clearance"]);
    expect(out.eng?.agents).toEqual(["ops-agent", "clearance"]);
    expect(out.approvals?.agents).toEqual(["clearance"]);
  });

  it("keeps the group and links on a first run", () => {
    const out = resources(worldDocument(template, { agents: everyone, rooms: [] }));
    expect(out.acme?.type).toBe("group");
    expect(out.support?.group).toBe("acme");
  });

  it("creates only what is missing on a later run, with no group to collide with", () => {
    const out = resources(worldDocument(template, { agents: everyone, rooms: ["support", "eng", "finance"] }));
    expect(Object.keys(out).filter((k) => out[k]?.type === "room")).toEqual(["approvals"]);
    expect(out.acme).toBeUndefined();
    expect(out.approvals?.group).toBeUndefined();
  });

  it("creates no agents, since setup-agents does that with their own owners", () => {
    const out = resources(worldDocument(template, { agents: everyone, rooms: [] }));
    expect(Object.values(out).filter((r) => r.type === "agent")).toEqual([]);
  });

  it("returns nothing to run when every room exists", () => {
    expect(worldDocument(template, { agents: everyone, rooms: ["support", "eng", "finance", "approvals"] })).toBeNull();
  });
});

describe("policyRoomMap", () => {
  it("uses the names the policy file uses, with their hash", () => {
    expect(policyRoomMap([{ name: "support", id: "r1" }, { name: "eng", id: "r2" }])).toEqual({ "#support": "r1", "#eng": "r2" });
  });
});

describe("withRoomMap", () => {
  it("keeps everything else in the identities file", () => {
    const out = withRoomMap({ people: { a: 1 }, rooms: { "#old": "x" } }, { "#support": "r1" });
    expect(out).toEqual({ people: { a: 1 }, rooms: { "#old": "x", "#support": "r1" } });
  });
});

describe("groupOf", () => {
  it("reads the group and its links, so a recreated room can go back in", () => {
    const group = groupOf(readFileSync(join(REPO, "templates/acme-mini.template.yaml"), "utf8"));
    expect(group?.name).toBe("Acme Mini");
    expect(group?.links).toContainEqual(expect.objectContaining({ from: "support", to: "approvals" }));
  });
});

describe("room-limited addressing", () => {
  it("lists the rooms, and leaves people, agents and the owner open within them", () => {
    expect(roomLimitedPolicy(["b", "a"])).toEqual({ rules: [{ rooms: ["a", "b"], users: "*", agents: "*", owner: true }] });
  });

  it("gives each agent the rooms the template puts it in, and never one that does not exist yet", () => {
    const wanted = roomsOf(readFileSync(join(REPO, "templates/acme-mini.template.yaml"), "utf8"));
    const present = [
      { id: "room-support", name: "support" },
      { id: "room-eng", name: "eng" },
    ];
    const rooms = roomsOfAgents(wanted, present, ["refunds-agent", "coder", "ops-agent"]);
    expect(rooms).toEqual({ "refunds-agent": ["room-support"], coder: ["room-eng"], "ops-agent": ["room-eng"] });
  });
});
