/**
 * The templates against PLAN 8.3, 8.4 and 8.6, and against what the spikes proved about Switch. The
 * server's own validation is in spikes/s11-templates.ts; this keeps the world from drifting offline.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Resource = {
  type: "agent" | "room" | "group";
  if?: string;
  name?: string;
  provider?: string;
  machine?: string;
  directory?: string;
  addressing?: string;
  auto_mode?: unknown;
  can_manage_agents?: boolean;
  instructions?: string;
  agents?: string[];
  users?: string[];
  group?: string;
  docs?: { name: string; content: string }[];
  links?: { from: string; to: string; label: string }[];
};
type Template = {
  version: number;
  params: Record<string, { type?: string; default?: unknown; required?: boolean }>;
  resources: Record<string, Resource>;
};

const load = (name: string): Template =>
  parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "templates", `${name}.template.yaml`), "utf8"),
  ) as Template;

const of = (template: Template, type: Resource["type"]) =>
  Object.entries(template.resources).filter(([, resource]) => resource.type === type);

const sorted = (values: string[] | undefined) => [...(values ?? [])].sort();

describe("acme-mini", () => {
  const template = load("acme-mini");
  const byName = (type: Resource["type"]): Record<string, Resource> =>
    Object.fromEntries(of(template, type).map(([, resource]) => [resource.name ?? "", resource]));
  const rooms = byName("room");
  const agents = byName("agent");

  it("is a version 2 document", () => {
    expect(template.version).toBe(2);
  });

  it.each([
    ["support", ["clearance", "refunds-agent", "support-agent"], ["priya", "sam"]],
    ["finance", ["clearance"], ["neha", "sam"]],
    ["eng", ["clearance", "coder", "ops-agent", "reviewer"], ["alex", "dev", "priya"]],
    ["approvals", ["clearance"], ["alex", "dev", "neha", "priya", "sam"]],
  ])("has room %s with the agents and people PLAN 8.3 puts in it", (name, roomAgents, users) => {
    expect(sorted(rooms[name]?.agents)).toEqual(roomAgents);
    expect(sorted(rooms[name]?.users)).toEqual(users);
  });

  it("puts every room in the group, as Switch requires of several rooms in one template", () => {
    const [[key]] = of(template, "group") as [[string, Resource]];
    for (const room of Object.values(rooms)) expect(room.group).toBe(key);
  });

  it("links support, eng and finance to approvals", () => {
    const [[, group]] = of(template, "group") as [[string, Resource]];
    expect(group.links?.map((link) => `${link.from}>${link.to}`).sort()).toEqual([
      "eng>approvals",
      "finance>approvals",
      "support>approvals",
    ]);
    for (const link of group.links ?? []) expect(link.label).toEqual(expect.any(String));
  });

  it("keeps the ledger's explanation in approvals", () => {
    expect(rooms.approvals?.docs?.[0]?.name).toBe("how-clearance-works");
  });

  it.each([
    ["refunds-agent", "claude"],
    ["support-agent", "codex"],
    ["coder", "claude"],
    ["ops-agent", "opencode"],
    ["reviewer", "cursor"],
  ])("runs %s on %s, as PLAN 8.4 says", (name, provider) => {
    expect(agents[name]?.provider).toBe(provider);
  });

  it("leaves every agent in auto mode with no power over other agents", () => {
    for (const agent of Object.values(agents)) {
      expect(agent.auto_mode).toBe(true);
      expect(agent.can_manage_agents).toBe(false);
    }
  });

  it("lets Clearance wake every agent: its owner differs, so owner-agents would refuse it", () => {
    for (const agent of Object.values(agents)) expect(agent.addressing).toBe("anyone");
  });

  it("gives every agent the Clearance rules and a working folder of its own", () => {
    const folders = Object.values(agents).map((agent) => agent.directory);
    expect(new Set(folders).size).toBe(folders.length);
    for (const agent of Object.values(agents)) {
      expect(agent.instructions).toContain("{clearance_rules}");
      expect(agent.machine).toBe("{machine}");
    }
    const rules = String(template.params.clearance_rules?.default);
    expect(rules).toContain("HELD or PENDING");
    expect(rules).toContain("Never try a held action another way");
    expect(rules).toContain("Clearance compares what you say with what you run");
  });

  it("names no agent the same as its key, which would stop a rooms-only run naming it", () => {
    for (const [key, agent] of of(template, "agent")) expect(agent.name).not.toBe(key);
  });

  it("can create the agents and the rooms in separate runs", () => {
    for (const [, resource] of Object.entries(template.resources)) expect(resource.if).toEqual(expect.any(String));
    expect(template.params.machine?.required).toBe(false);
  });
});

describe("clearance", () => {
  const template = load("clearance");
  const rooms = of(template, "room");

  it("creates one room and no agent, so Clearance can run it with no capability to manage agents", () => {
    expect(rooms).toHaveLength(1);
    expect(of(template, "agent")).toHaveLength(0);
    expect(rooms[0]![1].agents).toEqual(["clearance"]);
  });

  it("does not lean on the deployer: run by Clearance, that is clearance-admin, who has no chat account", () => {
    expect(JSON.stringify(template)).not.toContain("$creator");
  });

  it("explains itself in a room document", () => {
    expect(rooms[0]![1].docs?.[0]?.content).toContain("Drills");
  });
});

describe("acme-vanilla", () => {
  const template = load("acme-vanilla");

  it("has the baseline agent and room, and no Clearance anywhere in them", () => {
    const [[, room]] = of(template, "room") as [[string, Resource]];
    const [[key, agent]] = of(template, "agent") as [[string, Resource]];
    expect(room.name).toBe("support-vanilla");
    expect(room.agents).toEqual([key]);
    expect(room.users).toEqual(["priya"]);
    expect(agent.name).toBe("refunds-agent-vanilla");
    expect(JSON.stringify(template.resources)).not.toMatch(/clearance_rules|"clearance"/);
  });

  it("switches auto mode by a param, for SC1 and SC2", () => {
    const [[, agent]] = of(template, "agent") as [[string, Resource]];
    expect(agent.auto_mode).toBe("{auto_mode}");
    expect(template.params.auto_mode?.type).toBe("boolean");
  });
});
