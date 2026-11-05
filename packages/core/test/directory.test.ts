import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Directory, loadIdentities } from "../src/people/directory.js";
import { parseTeam } from "../src/policy/load.js";
import { TEAM_PATH } from "./harness.js";

const team = parseTeam(readFileSync(TEAM_PATH, "utf8"), "team.yaml");

/** The shape scripts/setup-identities.ts really writes, as measured by the Switch spikes. */
const REAL_SHAPE = {
  bridgeId: "bridge-1",
  mattermostTeam: "acme-mini",
  people: {
    sam: {
      switchUserId: "u-sam",
      participantIds: ["@switch-user-sam:localhost", "@switch-user-sam-slack:localhost"],
      mattermostUser: "sam.k",
      mattermostUserId: "mm-1",
      externalUserRowId: "row-1",
      directRoomId: "!dm-sam:localhost",
    },
    priya: {
      switchUserId: "u-priya",
      participantIds: ["@switch-user-priya:localhost"],
      mattermostUser: "priya",
      mattermostUserId: "mm-2",
      externalUserRowId: "row-2",
      directRoomId: "!dm-priya:localhost",
    },
  },
  unlinked: { guest: { participantIds: ["@switch-user-guest:localhost"], mattermostUser: "guest" } },
  agents: {
    clearance: {
      switchAgentId: "ag-1",
      participantId: "@switch-agent-clearance:localhost",
      ownerUserId: "u-admin",
      ownerName: "clearance-admin",
    },
  },
};

describe("identities file", () => {
  it("loads the real shape, ignoring what it does not use", () => {
    const dir = mkdtempSync(join(tmpdir(), "clearance-identities-"));
    const path = join(dir, "identities.json");
    writeFileSync(path, JSON.stringify(REAL_SHAPE));
    const directory = new Directory(team, loadIdentities(path));
    expect(directory.personByParticipant("@switch-user-sam:localhost")?.id).toBe("sam");
    expect(directory.isSelf("@switch-agent-clearance:localhost")).toBe(true);
  });

  it("treats a missing file as nobody being linked, not as an error", () => {
    const directory = new Directory(team, loadIdentities(join(tmpdir(), "clearance-no-such-file.json")));
    expect(directory.personByParticipant("@switch-user-sam:localhost")).toBeNull();
    expect(directory.person("sam")?.name).toBe("Sam");
  });

  it("uses the Mattermost username for the name Switch knows them by", () => {
    const directory = new Directory(team, REAL_SHAPE);
    expect(directory.person("sam")?.userName).toBe("sam.k");
    expect(directory.person("neha")?.userName).toBe("neha");
  });
});

describe("resolving an answer's identity", () => {
  const directory = new Directory(team, REAL_SHAPE);

  it("resolves a participant id", () => {
    expect(directory.personFromAnswer("@switch-user-priya:localhost")?.id).toBe("priya");
  });

  it("resolves two linked accounts to one person", () => {
    expect(directory.personFromAnswer("@switch-user-sam:localhost")?.id).toBe("sam");
    expect(directory.personFromAnswer("@switch-user-sam-slack:localhost")?.id).toBe("sam");
  });

  it("resolves user:<switchUserId>", () => {
    expect(directory.personFromAnswer("user:u-sam")?.id).toBe("sam");
  });

  it.each([
    ["an unlinked guest", "@switch-user-guest:localhost"],
    ["an agent", "@switch-agent-clearance:localhost"],
    ["a user nobody knows", "user:u-nobody"],
    ["a display name", "Sam"],
    ["a person's id", "sam"],
    ["nothing", null],
    ["empty", ""],
    ["the bare prefix", "user:"],
  ])("maps %s to nobody", (_name, value) => {
    expect(directory.personFromAnswer(value)).toBeNull();
  });
});

describe("on_behalf_of is a display name", () => {
  const directory = new Directory(team, REAL_SHAPE);

  it("maps by person name, ignoring case and spaces", () => {
    expect(directory.personByDisplayName("Priya")?.id).toBe("priya");
    expect(directory.personByDisplayName(" neha ")?.id).toBe("neha");
    expect(directory.personByDisplayName("NEHA")?.id).toBe("neha");
  });

  it("maps nobody it does not know", () => {
    expect(directory.personByDisplayName("Priya S.")).toBeNull();
    expect(directory.personByDisplayName(null)).toBeNull();
  });
});

describe("who is an agent", () => {
  const directory = new Directory(team, { people: {}, agents: { "refunds-agent": { participantId: "@a:localhost" } } });

  it("knows an agent by participant id", () => {
    expect(directory.agentForSender("@a:localhost")).toBe("refunds-agent");
  });

  it("knows a team agent by Switch's sender name when identities has no entry", () => {
    expect(directory.agentForSender("@b:localhost", "coder")).toBe("coder");
  });

  it("does not call a linked person an agent, whatever their display name", () => {
    const linked = new Directory(team, { people: { sam: { participantIds: ["@s:localhost"] } }, agents: {} });
    expect(linked.agentForSender("@s:localhost", "coder")).toBeNull();
  });

  it("does not call a stranger an agent", () => {
    expect(directory.agentForSender("@c:localhost", "someone")).toBeNull();
  });
});

describe("resolveAgent maps a hook's cwd to its agent", () => {
  const directory = new Directory(team, { people: {}, agents: {} });
  const home = homedir();

  it("matches the agent directory, with <host> standing for one path segment", () => {
    expect(directory.resolveAgent(`${home}/.switch/agents/demo-host/refunds-agent`)).toBe("refunds-agent");
    expect(directory.resolveAgent(`${home}/.switch/agents/demo-host/coder/src`)).toBe("coder");
  });

  it("does not match a name that merely starts the same", () => {
    expect(directory.resolveAgent(`${home}/.switch/agents/demo-host/coder-two`)).toBeNull();
  });

  it("returns null for an unknown cwd, which is never an allow", () => {
    expect(directory.resolveAgent("/tmp/somewhere")).toBeNull();
    expect(directory.resolveAgent(undefined)).toBeNull();
  });
});
