/**
 * Builds each tab's data from core's real routes. Nothing here invents a value: every number is core's,
 * or a count of what core returned.
 *
 * Core has no "list open requests" route, so the Queue finds them in the ledger and asks core about each
 * one. `disagreement` reports it if that ever differs from core's own count in /v1/health.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ZodType, ZodTypeDef } from "zod";
import { parse } from "yaml";
import type {
  AutonomyView,
  CoverageView,
  Health,
  LedgerEntry,
  LedgerVerification,
  LedgerView,
  PeopleView,
  PersonRow,
  PolicyClass,
  PolicyView,
  QueueItem,
  QueueView,
} from "../shared/api";
import { CoreUnavailable, type CoreSource } from "./core-source";
import {
  AutonomySchema,
  CoverageSchema,
  HealthSchema,
  InboxSchema,
  LedgerSchema,
  PersonStatsSchema,
  PolicyFileSchema,
  RequestDetailSchema,
  TeamSchema,
  VerifySchema,
  type PolicyFile,
  type Team,
} from "./schemas";

export type WorldFiles = { policyPath: string; teamPath: string };

/** Core answered, but not with something the Desk can read. Shown on the page rather than guessed around. */
export class CoreShapeError extends Error {}

/** Core refused the Desk, which means the token is wrong. */
export class CoreRefused extends Error {}

const OPEN_STATES = new Set(["HELD", "ROUTED"]);
/** Once one of these is in the ledger the request cannot be open, so the Desk need not ask about it. */
const CLOSING_TYPES = new Set(["denied", "approved", "expired", "cancelled", "executed", "break_glass"]);

const VENDOR_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor CLI",
  antigravity: "Antigravity",
  gate: "the gate",
};

const AUTONOMY_HISTORY_TYPES = new Set(["promotion_proposed", "promotion_signed", "demoted"]);

async function read<T>(core: CoreSource, path: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const answer = await core.get(path);
  if (answer.status === 401 || answer.status === 403) throw new CoreRefused("Core refused the Desk's token. Check CLEARANCE_INTERNAL_TOKEN.");
  if (answer.status >= 500) throw new CoreUnavailable(`Core answered ${path} with HTTP ${answer.status}`);
  if (answer.status !== 200) throw new CoreShapeError(`Core answered ${path} with HTTP ${answer.status}`);
  let json: unknown;
  try {
    json = JSON.parse(answer.body);
  } catch {
    throw new CoreShapeError(`Core's answer to ${path} is not JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CoreShapeError(`Core's answer to ${path} has an unexpected shape at ${issue?.path.join(".") || "the top"}: ${issue?.message}`);
  }
  return parsed.data;
}

/** A person in team.yaml whom core does not know: no stats to show, which is not a broken page. */
async function readIfKnown<T>(core: CoreSource, path: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T | null> {
  const answer = await core.get(path);
  if (answer.status === 404) return null;
  if (answer.status !== 200) return read(core, path, schema);
  return read({ get: async () => answer, post: core.post }, path, schema);
}

export const readHealth = (core: CoreSource): Promise<Health> => read(core, "/v1/health", HealthSchema);
const readEntries = (core: CoreSource) => read(core, "/v1/ledger", LedgerSchema);

export async function composeLedger(core: CoreSource, files: WorldFiles): Promise<LedgerView> {
  const { entries } = await readEntries(core);
  return { entries, names: Object.fromEntries(loadTeam(files.teamPath).people.map((person) => [person.id, person.name])) };
}

export const readVerify = (core: CoreSource): Promise<LedgerVerification> => read(core, "/v1/ledger/verify", VerifySchema);
export const readCoverage = (core: CoreSource): Promise<CoverageView> => read(core, "/v1/coverage", CoverageSchema);

function loadTeam(path: string): Team {
  return TeamSchema.parse(parse(readFileSync(path, "utf8")));
}

function loadPolicyFile(path: string): { text: string; file: PolicyFile } {
  const text = readFileSync(path, "utf8");
  return { text, file: PolicyFileSchema.parse(parse(text)) };
}

/** Requests the ledger has opened and not closed, oldest first. */
function candidates(entries: LedgerEntry[]): string[] {
  const closed = new Set(entries.filter((entry) => entry.request_id && CLOSING_TYPES.has(entry.type)).map((entry) => entry.request_id));
  const held = entries.filter((entry) => entry.type === "held" && entry.request_id && !closed.has(entry.request_id));
  return held.map((entry) => entry.request_id as string);
}

function escalationWords(payload: Record<string, unknown>, nameOf: (id: string) => string): string {
  switch (payload.kind) {
    case "add":
      return typeof payload.added === "string" ? `Backup added: ${nameOf(payload.added)}` : "No backup was available";
    case "post":
      return `Posted to ${String(payload.room)}`;
    case "notify":
      return "Requester told";
    default:
      return "Escalated";
  }
}

export async function composeQueue(core: CoreSource, files: WorldFiles): Promise<QueueView> {
  const [health, ledger] = await Promise.all([readHealth(core), readEntries(core)]);
  const team = loadTeam(files.teamPath);
  const { file: policy } = loadPolicyFile(files.policyPath);
  const nameOf = (id: string) => team.people.find((person) => person.id === id)?.name ?? id;

  const details = await Promise.all(candidates(ledger.entries).map((id) => read(core, `/v1/requests/${encodeURIComponent(id)}`, RequestDetailSchema)));
  const open = details.filter((request) => OPEN_STATES.has(request.state));

  const inboxes = await Promise.all(
    team.people.map(async (person) => ({ person, inbox: await readIfKnown(core, `/v1/inbox?user=${encodeURIComponent(person.id)}`, InboxSchema) })),
  );

  const requests: QueueItem[] = open.map((request) => {
    const holders = inboxes.flatMap(({ person, inbox }) =>
      (inbox?.items ?? []).filter((item) => item.request_id === request.id).map((item) => ({ person: person.name, handle: item.handle, room: item.room })),
    );
    const about = ledger.entries.filter((entry) => entry.request_id === request.id);
    const escalations = about.filter((entry) => entry.type === "escalated");
    const lastEscalation = escalations.at(-1);
    const routed = about.filter((entry) => entry.type === "routed").at(-1);
    const fallback = routed?.payload.fallback as { group?: string; room?: string; reason?: string } | null | undefined;
    const agentVendor = team.agents[request.agent]?.vendor ?? request.vendor;
    const policyClass = policy.classes[request.class];
    return {
      id: request.id,
      state: request.state,
      class: request.class,
      tier: request.tier,
      score: request.score,
      headline: request.evidence.description?.headline ?? request.class.toUpperCase(),
      agent: request.agent,
      vendor: VENDOR_NAMES[agentVendor] ?? agentVendor,
      asked_by: request.requester_ids.map(nameOf),
      flags: request.flags,
      quorum_required: request.quorum_required,
      approvals: request.approvals.length,
      created_at: request.created_at,
      expires_at: request.expires_at,
      room: holders.find((holder) => holder.room)?.room ?? request.origin_room,
      waiting_on: holders.map(({ person, handle }) => ({ person, handle })),
      fallback: fallback?.group && fallback.room ? { group: fallback.group, room: fallback.room, reason: fallback.reason ?? "" } : null,
      escalation: {
        fired: escalations.length,
        // Zero is a class with no ladder. Null is a class this file does not know, such as an unmatched call.
        of: policyClass ? (policyClass.escalate?.length ?? 0) : null,
        last: lastEscalation ? escalationWords(lastEscalation.payload, nameOf) : null,
      },
    };
  });

  return {
    open_count: health.open_requests,
    requests,
    disagreement:
      requests.length === health.open_requests ? null : `Core reports ${health.open_requests} open, but the Desk found ${requests.length} in the ledger.`,
  };
}

export async function composeAutonomy(core: CoreSource): Promise<AutonomyView> {
  const [autonomy, ledger] = await Promise.all([read(core, "/v1/autonomy", AutonomySchema), readEntries(core)]);
  return { levels: autonomy.levels, history: ledger.entries.filter((entry) => AUTONOMY_HISTORY_TYPES.has(entry.type)) };
}

export async function composePeople(core: CoreSource, files: WorldFiles): Promise<PeopleView> {
  const team = loadTeam(files.teamPath);
  const people: PersonRow[] = await Promise.all(
    team.people.map(async (person) => {
      const [stats, inbox] = await Promise.all([
        readIfKnown(core, `/v1/people/${encodeURIComponent(person.id)}/stats`, PersonStatsSchema),
        readIfKnown(core, `/v1/inbox?user=${encodeURIComponent(person.id)}`, InboxSchema),
      ]);
      return { id: person.id, name: person.name, groups: person.groups, roles: person.roles, stats, inbox: inbox?.items ?? [] };
    }),
  );
  return { people };
}

function classRow(name: string, value: PolicyFile["classes"][string]): PolicyClass {
  const quorum = value.approvers?.quorum;
  return {
    name,
    base: value.risk?.base ?? null,
    rules: value.risk?.add?.length ?? 0,
    approvers: value.approvers?.label ?? null,
    // A class with approvers and no quorum needs one person: core's own default.
    quorum: quorum ? Object.entries(quorum).map(([tier, count]) => `${count} ${tier === "default" ? "" : `(${tier})`}`.trim()).join(", ") : value.approvers ? "1" : "",
    reversible: value.reversible ?? null,
    escalation_steps: value.escalate?.length ?? 0,
    max_level: value.autonomy?.max_level ?? null,
    decision: value.decision ?? null,
  };
}

/** Core serves no policy text, so this reads the file and compares its hash with what core has loaded. */
export async function composePolicy(core: CoreSource, files: WorldFiles): Promise<PolicyView> {
  const health = await readHealth(core);
  const { text, file } = loadPolicyFile(files.policyPath);
  const fileHash = createHash("sha256").update(text).digest("hex");
  return {
    core_hash: health.policy_hash,
    file_hash: fileHash,
    matches: fileHash === health.policy_hash,
    policy_error: health.policy_error,
    mode: file.mode ?? null,
    tiers: Object.entries(file.tiers).map(([name, [from, to]]) => ({ name, from, to })),
    classes: Object.entries(file.classes).map(([name, value]) => classRow(name, value)),
    text,
  };
}
