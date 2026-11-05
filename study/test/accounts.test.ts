import { describe, expect, it } from "vitest";
import { STUDY_TEAM_SIZE, StudyAccountsSchema, addressingRules, participantIds, raisedTeamLimit, roomNameFor } from "../lib/accounts";
import { PARTICIPANT_ID } from "../lib/events";
import { assignGroup } from "../lib/protocol";

describe("participant ids", () => {
  it("makes p01 to p20 by default count, all valid and balanced across the four orders", () => {
    const ids = participantIds(20);
    expect(ids[0]).toBe("p01");
    expect(ids[19]).toBe("p20");
    for (const id of ids) expect(id).toMatch(PARTICIPANT_ID);
    const groups = ids.map((id) => assignGroup(id).group);
    for (const group of [1, 2, 3, 4]) expect(groups.filter((value) => value === group)).toHaveLength(5);
  });

  it("makes only as many as asked for", () => {
    expect(participantIds(2)).toEqual(["p01", "p02"]);
  });

  it.each([0, -1, 1.5, 100, Number.NaN])("refuses a count of %s", (count) => {
    expect(() => participantIds(count)).toThrow("--count");
  });
});

describe("the bot's addressing policy", () => {
  it("lets each person address it only in their own room, and no agent anywhere", () => {
    const rules = addressingRules([
      { roomId: "room-1", externalUserRowId: "row-1" },
      { roomId: "room-2", externalUserRowId: "row-2" },
    ]);
    expect(rules).toEqual([
      { rooms: ["room-1"], users: ["row-1"], agents: [] },
      { rooms: ["room-2"], users: ["row-2"], agents: [] },
    ]);
  });
});

describe("the team size limit", () => {
  it("raises Mattermost's default, which twenty participants and the bots can reach", () => {
    expect(raisedTeamLimit(50)).toBe(STUDY_TEAM_SIZE);
  });

  it("leaves a limit that is already enough, and never lowers one", () => {
    expect(raisedTeamLimit(STUDY_TEAM_SIZE)).toBeNull();
    expect(raisedTeamLimit(1000)).toBeNull();
  });

  it("raises it if the setting can't be read", () => {
    expect(raisedTeamLimit(undefined)).toBe(STUDY_TEAM_SIZE);
  });
});

describe("the accounts file", () => {
  const participant = {
    mattermostUser: "p01",
    mattermostUserId: "m",
    switchUserId: "s",
    externalUserRowId: "row",
    participantId: "@p:localhost",
    roomId: "room",
    channelId: "channel",
    oneTimePassword: "x",
    switchPassword: "y",
  };
  const file = {
    bridgeId: "b",
    mattermostTeam: "switch",
    owner: { name: "study-admin", email: "e", switchUserId: "s", password: "p" },
    agent: { name: "study-bot", switchAgentId: "a", apiKey: "k" },
    participants: { p01: participant },
  };

  it("reads what the setup script writes, and treats a missing retired flag as not retired", () => {
    expect(StudyAccountsSchema.parse(file).participants.p01?.retired).toBe(false);
  });

  it("refuses a key that is not a participant id", () => {
    expect(() => StudyAccountsSchema.parse({ ...file, participants: { bob: participant } })).toThrow();
  });

  it("names rooms by participant id, so no name reaches Mattermost", () => {
    expect(roomNameFor("p07")).toBe("study-p07");
  });
});
