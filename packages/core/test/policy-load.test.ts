import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDuration, parsePolicy, parseTeam, PolicyLoadError } from "../src/policy/load.js";

const POLICY_PATH = new URL("../../../policy/clearance.policy.yaml", import.meta.url);
const TEAM_PATH = new URL("../../../policy/team.yaml", import.meta.url);
const realPolicy = readFileSync(POLICY_PATH, "utf8");
const realTeam = readFileSync(TEAM_PATH, "utf8");

/** Edit the real file so a failing test always means the loader, not a stale fixture. */
function broken(find: string, replace: string): string {
  if (!realPolicy.includes(find)) throw new Error(`fixture out of date, cannot find: ${find}`);
  return realPolicy.replace(find, replace);
}

function lineOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`no ${needle}`);
  return text.slice(0, index).split("\n").length;
}

function loadError(text: string): PolicyLoadError {
  try {
    parsePolicy(text, "policy.yaml");
  } catch (error) {
    if (error instanceof PolicyLoadError) return error;
    throw error;
  }
  throw new Error("expected the policy to be refused");
}

describe("policy loader", () => {
  it("loads the real policy and keeps class order", () => {
    const loaded = parsePolicy(realPolicy, "clearance.policy.yaml");
    expect(loaded.classes.map((cls) => cls.name)).toEqual([
      "refund",
      "payout_change",
      "deploy",
      "rollback",
      "merge",
      "customer_email",
      "delete",
      "protected_config",
    ]);
    expect(loaded.classes.find((cls) => cls.name === "protected_config")?.deny).toBe(true);
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.requestTtlMs).toBe(25 * 60_000);
    expect(loaded.grantTtlMs).toBe(10 * 60_000);
  });

  it("names the line of a wrong type", () => {
    const text = broken("max_open_cards_per_person: 6", 'max_open_cards_per_person: "lots"');
    const error = loadError(text);
    expect(error.line).toBe(lineOf(text, "max_open_cards_per_person"));
    expect(error.message).toMatch(/^policy\.yaml:\d+:\d+/);
    expect(error.message).toContain("defaults.max_open_cards_per_person");
  });

  it("names the line of a misspelt key", () => {
    const text = broken("    reversible: false\n", "    reversable: false\n");
    const error = loadError(text);
    expect(error.line).toBe(lineOf(text, "reversable"));
    expect(error.message).toContain("reversable");
  });

  it("names the line of a bad expression", () => {
    const text = broken("when: 'amount > 10000'", "when: 'amount >'");
    const error = loadError(text);
    expect(error.line).toBe(lineOf(text, "amount >'"));
    expect(error.message).toContain("risk.add");
  });

  it("names the line of an expression that reads a field no extract rule defines", () => {
    const text = broken("when: 'amount > 10000'", "when: 'amout > 10000'");
    const error = loadError(text);
    expect(error.line).toBe(lineOf(text, "amout"));
    expect(error.message).toContain("amout");
  });

  it("names the line of a bad regex", () => {
    const text = broken("{ shell: '(^|/)docker(\\s|$)' }", "{ shell: '(unclosed' }");
    const error = loadError(text);
    expect(error.line).toBe(lineOf(text, "(unclosed"));
    expect(error.message).toMatch(/regular expression/i);
  });

  it("names the line of a bad duration", () => {
    const text = broken("request_ttl: 25m", "request_ttl: soon");
    expect(loadError(text).line).toBe(lineOf(text, "request_ttl"));
  });

  it("names the line of a YAML syntax error", () => {
    const error = loadError("version: 1\nmode: [enforce\n");
    expect(error.line).toBeGreaterThanOrEqual(2);
  });

  it("refuses a class with neither a deny decision nor approvers", () => {
    const text = realPolicy.replace(
      "  delete:\n",
      "  orphan:\n    match:\n      - { shell: 'orphan' }\n    risk: { base: 1 }\n  delete:\n",
    );
    const error = loadError(text);
    expect(error.line).toBe(lineOf(text, "orphan:"));
    expect(error.message).toContain("approvers");
  });

  it("refuses a via_gate shell rule that is not anchored, since it could wave through any command", () => {
    const text = broken(
      "{ shell: '^(\\./)?(bin/)?acme\\s+refund\\b', via_gate: true }",
      "{ shell: 'acme\\s+refund\\b', via_gate: true }",
    );
    const error = loadError(text);
    expect(error.line).toBe(lineOf(text, "acme\\s+refund\\b', via_gate"));
    expect(error.message).toContain("via_gate");
  });

  it("refuses tiers that leave a gap", () => {
    const text = broken("medium:   [30, 55]", "medium:   [31, 55]");
    expect(loadError(text).message).toMatch(/tiers/);
  });

  it("parses durations", () => {
    expect(parseDuration("25m")).toBe(1_500_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(() => parseDuration("soon")).toThrow();
  });
});

describe("team loader", () => {
  it("loads the real team file with an owner for every agent", () => {
    const team = parseTeam(realTeam, "team.yaml");
    expect(team.people.map((person) => person.id)).toEqual(["priya", "sam", "neha", "alex", "dev"]);
    for (const agent of Object.values(team.agents)) expect(agent.owner).toMatch(/^(priya|alex)$/);
    expect(team.agents["refunds-agent"]?.owner).toBe("priya");
    expect(team.agents["ops-agent"]?.owner).toBe("alex");
  });

  it("names the line of an agent whose owner does not exist", () => {
    const text = realTeam.replace("owner: priya", "owner: nobody");
    try {
      parseTeam(text, "team.yaml");
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyLoadError);
      expect((error as PolicyLoadError).line).toBe(lineOf(text, "owner: nobody"));
    }
  });
});
