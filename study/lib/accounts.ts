/**
 * The file scripts/setup-study-accounts.ts writes and study/bot reads: data/study-accounts.json, mode
 * 600, never committed. It holds credentials, so nothing that reads it may print it.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { PARTICIPANT_ID } from "./events";

export const ParticipantAccountSchema = z.object({
  mattermostUser: z.string(),
  mattermostUserId: z.string(),
  switchUserId: z.string(),
  /** The bridge's row for this account: what an addressing rule names. */
  externalUserRowId: z.string(),
  /** Who Switch says sent a message or answered a card. Identity comes from this and nothing else. */
  participantId: z.string(),
  roomId: z.string(),
  channelId: z.string(),
  /** Given to one person for one session. Retire the account afterwards so it stops working. */
  oneTimePassword: z.string(),
  /** Never handed out: it lets the setup script confirm the link on a re-run. */
  switchPassword: z.string(),
  retired: z.boolean().default(false),
});
export type ParticipantAccount = z.infer<typeof ParticipantAccountSchema>;

export const StudyAccountsSchema = z.object({
  bridgeId: z.string(),
  mattermostTeam: z.string(),
  owner: z.object({ name: z.string(), email: z.string(), switchUserId: z.string(), password: z.string() }),
  agent: z.object({ name: z.string(), switchAgentId: z.string(), apiKey: z.string() }),
  participants: z.record(z.string().regex(PARTICIPANT_ID), ParticipantAccountSchema),
});
export type StudyAccounts = z.infer<typeof StudyAccountsSchema>;

export function loadStudyAccounts(path: string): StudyAccounts {
  return StudyAccountsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** p01 to pNN, the ids PLAN 11.5 provisions and `assignGroup` counterbalances. */
export function participantIds(count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 99) throw new Error(`--count must be 1 to 99, got ${count}`);
  return Array.from({ length: count }, (_, index) => `p${String(index + 1).padStart(2, "0")}`);
}

/** Each participant may address the bot in their own room and nowhere else, and no agent may. */
export function addressingRules(participants: Pick<ParticipantAccount, "roomId" | "externalUserRowId">[]) {
  return participants.map((participant) => ({
    rooms: [participant.roomId],
    users: [participant.externalUserRowId],
    agents: [] as string[],
  }));
}

/**
 * Mattermost refuses new team members past TeamSettings.MaxUsersPerTeam, 50 by default, and every agent's
 * bot is a member, deleted agents' included. Twenty participants on top of a demo world can reach that,
 * and once they do, new agents can't join the team either.
 */
export const STUDY_TEAM_SIZE = 200;

/** The new limit, or null if the current one is already enough. Never lowers it. */
export function raisedTeamLimit(current: unknown): number | null {
  return typeof current === "number" && current >= STUDY_TEAM_SIZE ? null : STUDY_TEAM_SIZE;
}

export const ROOM_PREFIX = "study-";
export const roomNameFor = (participant: string) => `${ROOM_PREFIX}${participant}`;
