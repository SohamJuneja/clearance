/** Builds a real core over temp files with fakes for every port. Used by every core-level test. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, ChatMessageEvent } from "@clearance/contracts";
import { parse } from "yaml";
import { createClearanceCore, type Clearance } from "../src/core.js";
import { FakeChat, FakeClock, FakeGate, FakeLookup, type World } from "./fakes.js";

const POLICY_DIR = new URL("../../../policy/", import.meta.url);
export const POLICY_PATH = new URL("clearance.policy.yaml", POLICY_DIR).pathname;
export const TEAM_PATH = new URL("team.yaml", POLICY_DIR).pathname;
export const DRILLS_PATH = new URL("../drills/flaws.yaml", POLICY_DIR).pathname;
/** No second engineer: the only team where a merge or delete can run out of people. */
export const TEAM_ALEX_ONLY_PATH = new URL("./fixtures/team-alex-only.yaml", import.meta.url).pathname;
export const WORLD = parse(readFileSync(new URL("tests/world.yaml", POLICY_DIR), "utf8")) as World;

/** A Wednesday, 14:00 IST: Sam is on duty. */
export const NOW = Date.parse("2026-11-04T14:00:00+05:30");
export const MINUTE = 60_000;

/** Stable participant ids per person. Sam has two linked chat accounts, for the quorum tests. */
export const PARTICIPANTS = {
  priya: "@switch-user-priya:localhost",
  sam: "@switch-user-sam:localhost",
  samSecond: "@switch-user-sam-slack:localhost",
  neha: "@switch-user-neha:localhost",
  alex: "@switch-user-alex:localhost",
  dev: "@switch-user-dev:localhost",
  guest: "@switch-user-guest:localhost",
  refundsAgent: "@switch-agent-refunds:localhost",
  supportAgent: "@switch-agent-support:localhost",
  clearance: "@switch-agent-clearance:localhost",
} as const;

export const IDENTITIES = {
  people: {
    priya: { switchUserId: "u-priya", participantIds: [PARTICIPANTS.priya], mattermostUser: "priya" },
    sam: { switchUserId: "u-sam", participantIds: [PARTICIPANTS.sam, PARTICIPANTS.samSecond], mattermostUser: "sam" },
    neha: { switchUserId: "u-neha", participantIds: [PARTICIPANTS.neha], mattermostUser: "neha" },
    alex: { switchUserId: "u-alex", participantIds: [PARTICIPANTS.alex], mattermostUser: "alex" },
    dev: { switchUserId: "u-dev", participantIds: [PARTICIPANTS.dev], mattermostUser: "dev" },
  },
  agents: {
    clearance: { switchAgentId: "ag-clearance", participantId: PARTICIPANTS.clearance },
    "refunds-agent": { switchAgentId: "ag-refunds", participantId: PARTICIPANTS.refundsAgent },
    "support-agent": { switchAgentId: "ag-support", participantId: PARTICIPANTS.supportAgent },
  },
};

export type Harness = {
  core: Clearance;
  chat: FakeChat;
  gate: FakeGate;
  lookup: FakeLookup;
  clock: FakeClock;
  dbPath: string;
  dir: string;
  restart(): Harness;
};

export type HarnessOptions = {
  now?: number;
  scale?: number;
  policyPath?: string;
  teamPath?: string;
  identities?: unknown;
  /** Off by default here, so a 5% roll on a request id cannot add a card to a test about something else. */
  rollDrills?: boolean;
  /** CLEARANCE_DRILL_RATE, as main passes it. */
  drillRate?: number;
  runningInbox?: boolean;
};

export function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "clearance-core-"));
  const identitiesPath = join(dir, "identities.json");
  writeFileSync(identitiesPath, JSON.stringify(options.identities ?? IDENTITIES));
  const dbPath = join(dir, "clearance.sqlite");
  const chat = new FakeChat();
  const gate = new FakeGate();
  const lookup = new FakeLookup(WORLD);
  const clock = new FakeClock(options.now ?? NOW, options.scale ?? 1);
  const build = (): Harness => {
    const core = createClearanceCore({
      dbPath,
      policyPath: options.policyPath ?? POLICY_PATH,
      teamPath: options.teamPath ?? TEAM_PATH,
      identitiesPath,
      drillsPath: DRILLS_PATH,
      rollDrills: options.rollDrills ?? false,
      ...(options.drillRate !== undefined ? { drillRate: options.drillRate } : {}),
      chat,
      gate,
      lookup,
      clock,
      ...(options.runningInbox ? { runningInbox: true } : {}),
    });
    return {
      core,
      chat,
      gate,
      lookup,
      clock,
      dbPath,
      dir,
      restart: () => {
        core.close();
        return build();
      },
    };
  };
  return build();
}

let actionCounter = 0;

export function actionId(): string {
  actionCounter += 1;
  return `action-${actionCounter}`;
}

export function hookShell(command: string, overrides: Partial<Action> = {}): Action {
  return {
    id: actionId(),
    at: new Date(NOW).toISOString(),
    source: "hook",
    vendor: "claude",
    agent: { name: "coder" },
    kind: "shell",
    raw: { command },
    shell: { command },
    ...overrides,
  };
}

export const REFUND_SC3 = { order_id: "A-1931", customer_id: "cus_8812", amount: 40000, destination: "meera.k@okaxis" };
export const REFUND_SC4 = { order_id: "A-2004", customer_id: "cus_2044", amount: 40000, destination: "rohan.s@okhdfc" };
/** Over ₹1,00,000: reaches critical, so it needs two people. */
export const REFUND_CRITICAL = { order_id: "A-2004", customer_id: "cus_2044", amount: 150000, destination: "rohan.s@okhdfc" };

export function gateRefund(args: Record<string, unknown> = REFUND_SC3, overrides: Partial<Action> = {}): Action {
  return {
    id: actionId(),
    at: new Date(NOW).toISOString(),
    source: "gate",
    vendor: "gate",
    agent: { name: "refunds-agent" },
    session: { switchRoomId: "#support", threadId: "t-77" },
    kind: "business",
    raw: args,
    business: { endpoint: "POST /acme/refunds", args },
    ...overrides,
  };
}

let messageCounter = 0;

/** A chat message as Switch delivers it. `sender` is the only identity that counts. */
export function chatMessage(sender: string, body: string, overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  messageCounter += 1;
  return {
    roomId: "#support",
    threadId: "t-77",
    messageId: `m-${messageCounter}`,
    sender,
    addressed: false,
    body,
    timestampMs: 0,
    ...overrides,
  };
}
