/** F24: the one mapping from gate class to Switch role, held to everything it has to agree with. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JOB_ROLES, jobRoleFor, jobRoleNamed } from "../packages/contracts/src/index.ts";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "../eval/lib/paths.ts";
import { GATE_CLASSES } from "../packages/gate/src/operations.ts";
import { GATE_GRANTS } from "./demo-env.mjs";
import { roomsOf } from "./setup-world.ts";

const template = readFileSync(join(REPO_ROOT, "templates/acme-mini.template.yaml"), "utf8");
const rooms = roomsOf(template);
const rules = (parse(template) as { params: { clearance_rules: { default: string } } }).params.clearance_rules.default;
const policy = parse(readFileSync(join(REPO_ROOT, "policy/clearance.policy.yaml"), "utf8")) as { classes: Record<string, unknown> };

const jobs = Object.values(JOB_ROLES);
const holdersOfGrant = (cls: string) =>
  Object.entries(GATE_GRANTS)
    .filter(([, classes]) => classes.includes(cls))
    .map(([agent]) => agent)
    .sort();

describe("the mapping from class to role", () => {
  it("covers every class the gate can refuse, and every one is a class in the policy", () => {
    expect(Object.keys(JOB_ROLES).sort()).toEqual([...GATE_CLASSES].sort());
    for (const cls of Object.keys(JOB_ROLES)) expect(policy.classes[cls], cls).toBeDefined();
  });

  it("names exactly the agents GATE_GRANTS gives that class", () => {
    for (const [cls, job] of Object.entries(JOB_ROLES)) {
      expect([...job.grantHolders].sort(), cls).toEqual(holdersOfGrant(cls));
    }
  });

  it("is declared by the template, in the room it says", () => {
    for (const job of jobs) {
      const room = rooms.find((one) => one.name === job.room);
      expect(room?.roles.map((role) => role.name), job.role).toContain(job.role);
    }
  });

  it("declares nothing in the template that the mapping doesn't know, so one place stays the one place", () => {
    const declared = rooms.flatMap((room) => room.roles.map((role) => role.name));
    expect(declared.sort()).toEqual([...new Set(jobs.map((job) => job.role))].sort());
  });

  it("keeps a role where the agents with the grant can reach it", () => {
    for (const job of jobs) {
      const room = rooms.find((one) => one.name === job.room);
      for (const agent of job.grantHolders) expect(room?.agents, `${agent} in #${job.room}`).toContain(agent);
    }
  });

  it("gives one agent one role, since Switch lets an agent hold only one at a time", () => {
    const rolesOf = new Map<string, Set<string>>();
    for (const job of jobs) {
      for (const agent of job.grantHolders) rolesOf.set(agent, (rolesOf.get(agent) ?? new Set()).add(job.role));
    }
    for (const [agent, roles] of rolesOf) expect([...roles], agent).toHaveLength(1);
  });

  it("uses names Switch can address and nothing else in the room answers to", () => {
    const agents = Object.keys(GATE_GRANTS);
    for (const job of jobs) {
      expect(job.role, job.role).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(agents).not.toContain(job.role);
      expect(["all", "channel", "here", "everyone", "clearance"]).not.toContain(job.role);
    }
  });

  it("finds a role by class exactly, and by name whatever the case", () => {
    expect(jobRoleFor("merge")?.role).toBe("merges");
    expect(jobRoleFor("constructor")).toBeNull();
    expect(jobRoleFor("nothing-of-the-kind")).toBeNull();
    expect(jobRoleNamed("MERGES")?.room).toBe("eng");
    expect(jobRoleNamed("refunds-agent")).toBeNull();
  });
});

describe("each agent's own brief", () => {
  const briefs = Object.values(
    (parse(template) as { resources: Record<string, { type?: string; name?: string; instructions?: string }> }).resources,
  ).filter((resource) => resource.type === "agent");

  it("names the role it holds the grant for, or told to take it, it has no reason to", () => {
    for (const job of jobs) {
      for (const agent of job.grantHolders) {
        const brief = briefs.find((one) => one.name === agent)?.instructions ?? "";
        expect(brief, agent).toContain(`role in #${job.room}, \`${job.role}\``);
        expect(brief, agent).toMatch(/grants nothing/);
        expect(brief, agent).toMatch(/Clearance says nobody holds it, take it with `assume_role`/);
      }
    }
  });
});

describe("each role's brief", () => {
  const briefs = rooms.flatMap((room) => room.roles);

  it("says the role grants nothing, so nobody taking it thinks otherwise", () => {
    for (const role of briefs) expect(role.instructions, role.name).toMatch(/It grants nothing/);
  });

  it("stops the work going round in circles: a refused holder tells the person", () => {
    for (const role of briefs) expect(role.instructions, role.name).toMatch(/if it refuses you, tell the person who asked and don't hand it on/);
  });

  it("has each exclusive flag set on purpose: only a job two agents have the grant for", () => {
    for (const role of briefs) {
      const job = jobRoleNamed(role.name);
      expect(role.exclusive, role.name).toBe((job?.grantHolders.length ?? 0) > 1);
    }
  });
});

describe("the rules every agent gets", () => {
  it("keeps rule 2 exactly as it was", () => {
    expect(rules).toContain("2. Never try a held action another way: no other tool, no direct API call, no smaller pieces, no edits to config files.");
  });

  it("tells a refused agent to hand the work to the role, saying who asked and what for", () => {
    expect(rules).toMatch(/hand the work to that role in the room it names: write @role once, not an agent's name, with what is\s+needed, who asked and why/);
    expect(rules).toMatch(/run it, and let the gate say/);
    expect(rules).toMatch(/Don't stop there and don't try another route/);
  });

  it("says a hold is never handed around", () => {
    expect(rules).toMatch(/Only a refusal is handed over: a held action stays held and goes to nobody/);
  });
});
