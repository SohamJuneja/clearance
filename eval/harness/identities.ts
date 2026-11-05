/**
 * Who is who in an isolated world, in the same shape `scripts/setup-identities.ts` writes to
 * data/identities.json. The participant ids look like the ones Switch hands out, and nothing real is in
 * them. Sam has two linked chat accounts, for the quorum case.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const PARTICIPANTS = {
  priya: "@switch-mattermost-eval-priya:localhost",
  sam: "@switch-mattermost-eval-sam:localhost",
  samSecond: "@switch-telegram-eval-sam:localhost",
  neha: "@switch-mattermost-eval-neha:localhost",
  alex: "@switch-mattermost-eval-alex:localhost",
  dev: "@switch-mattermost-eval-dev:localhost",
  guest: "@switch-mattermost-eval-guest:localhost",
  refundsAgent: "@switch-agent-refunds:localhost",
  supportAgent: "@switch-agent-support:localhost",
  coder: "@switch-agent-coder:localhost",
  opsAgent: "@switch-agent-ops:localhost",
  clearance: "@switch-agent-clearance:localhost",
} as const;

export type ParticipantName = keyof typeof PARTICIPANTS;

export const IDENTITIES = {
  people: {
    priya: {
      switchUserId: "u-priya",
      participantIds: [PARTICIPANTS.priya],
      mattermostUser: "priya",
    },
    sam: {
      switchUserId: "u-sam",
      participantIds: [PARTICIPANTS.sam, PARTICIPANTS.samSecond],
      mattermostUser: "sam",
    },
    neha: { switchUserId: "u-neha", participantIds: [PARTICIPANTS.neha], mattermostUser: "neha" },
    alex: { switchUserId: "u-alex", participantIds: [PARTICIPANTS.alex], mattermostUser: "alex" },
    dev: { switchUserId: "u-dev", participantIds: [PARTICIPANTS.dev], mattermostUser: "dev" },
  },
  agents: {
    clearance: { switchAgentId: "ag-clearance", participantId: PARTICIPANTS.clearance },
    "refunds-agent": { switchAgentId: "ag-refunds", participantId: PARTICIPANTS.refundsAgent },
    "support-agent": { switchAgentId: "ag-support", participantId: PARTICIPANTS.supportAgent },
    coder: { switchAgentId: "ag-coder", participantId: PARTICIPANTS.coder },
    "ops-agent": { switchAgentId: "ag-ops", participantId: PARTICIPANTS.opsAgent },
  },
};

/** Which gate classes each agent's token may call. The demo's own grants, except where a case widens them. */
export const AGENT_CLASSES: Record<string, string[]> = {
  "refunds-agent": ["refund", "customer_email"],
  "support-agent": ["customer_email"],
  coder: ["merge"],
  "ops-agent": ["deploy"],
  reviewer: ["merge"],
};

export const ROOM = { support: "room-support", eng: "room-eng", finance: "room-finance" } as const;

/** A working directory team.yaml maps to this agent. Only ever a string in a hook payload. */
export function agentCwd(agent: string): string {
  return join(homedir(), ".switch/agents/evalhost", agent);
}
