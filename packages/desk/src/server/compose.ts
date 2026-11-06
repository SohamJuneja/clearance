/**
 * Builds each tab's data from core's real routes. Nothing here invents a value: every number is core's, or a
 * sum of what core returned.
 *
 * Two things are read from disk, because core has no route for them. team.yaml gives an agent's vendor, since a
 * gate call reports its vendor as "gate". The policy file is only compared with what core enforces.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ZodType, ZodTypeDef } from "zod";
import { parse } from "yaml";
import type {
  AutonomyView,
  BucketReplay,
  CoverageView,
  Health,
  LedgerVerification,
  LedgerView,
  PeopleView,
  PersonDetail,
  PolicyClass,
  PolicyRelation,
  PolicyView,
  QueueItem,
  QueueView,
} from "../shared/api";
import { CoreUnavailable, type CoreSource } from "./core-source";
import {
  AutonomySchema,
  ClosedMarkSchema,
  CoverageSchema,
  HealthSchema,
  HumanLoadSchema,
  InboxSchema,
  LedgerSchema,
  OpenRequestsSchema,
  PersonStatsSchema,
  PolicyFileSchema,
  PolicyInfoSchema,
  ReplaySchema,
  RosterSchema,
  TeamFileSchema,
  VerifySchema,
  type PolicyFile,
  type Roster,
} from "./schemas";
import { drillsWithoutResult, teamDrillTotals, teamLedger, type TeamLedger } from "./team-view";

export type WorldFiles = { policyPath: string; teamPath: string };

/** Core answered, but not with something the Desk can read. Shown on the page rather than guessed around. */
export class CoreShapeError extends Error {}

/** Core refused the Desk, which means the token is wrong. */
export class CoreRefused extends Error {}

const VENDOR_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor CLI",
  antigravity: "Antigravity",
  gate: "the gate",
};

const AUTONOMY_HISTORY_TYPES = new Set(["promotion_proposed", "promotion_signed", "promotion_rejected", "demoted", "incident"]);

function checked<T>(path: string, answer: { status: number; body: string }, schema: ZodType<T, ZodTypeDef, unknown>): T {
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

const read = async <T>(core: CoreSource, path: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> => checked(path, await core.get(path), schema);

/** Someone core's roster lists but this route doesn't know: nothing to show, which is not a broken page. */
async function readIfKnown<T>(core: CoreSource, path: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T | null> {
  const answer = await core.get(path);
  return answer.status === 404 ? null : checked(path, answer, schema);
}

const readEntries = (core: CoreSource, path = "/v1/ledger") => read(core, path, LedgerSchema);
const readRoster = (core: CoreSource) => read(core, "/v1/people", RosterSchema);
const namesOf = (roster: Roster): Record<string, string> => Object.fromEntries(roster.people.map((person) => [person.id, person.name]));
const named = (ids: string[], names: Record<string, string>) => ids.map((id) => names[id] ?? id);

export const readHealth = (core: CoreSource): Promise<Health> => read(core, "/v1/health", HealthSchema);
export const readCoverage = (core: CoreSource): Promise<CoverageView> => read(core, "/v1/coverage", CoverageSchema);

/**
 * The ledger as the team may read it (team-view.ts). A drill can close without a result, as a cancelled one does, and
 * a list held still for good would be its own failure. So core has the last word on any drill with no result, by
 * the same test as the mirror: is that request still open?
 */
async function readTeamLedger(core: CoreSource): Promise<TeamLedger> {
  const { entries } = await readEntries(core);
  const open = await Promise.all(
    drillsWithoutResult(entries).map(async (id) => {
      const request = await readIfKnown(core, `/v1/requests/${encodeURIComponent(id)}`, ClosedMarkSchema);
      return request !== null && request.is_drill === undefined ? [id] : [];
    }),
  );
  return teamLedger(entries, new Set(open.flat()));
}

export async function composeLedger(core: CoreSource): Promise<LedgerView> {
  const [{ entries }, roster] = await Promise.all([readTeamLedger(core), readRoster(core)]);
  return { entries, names: namesOf(roster) };
}

export async function composeVerify(core: CoreSource): Promise<LedgerVerification> {
  const [chain, { entries }] = await Promise.all([read(core, "/v1/ledger/verify", VerifySchema), readTeamLedger(core)]);
  const newest = entries.at(-1);
  return { ok: chain.ok, through_seq: newest?.seq ?? null, head: newest?.entry_hash ?? null, ...(chain.firstBad ? { firstBad: chain.firstBad } : {}) };
}

function agentVendors(path: string): Record<string, string | undefined> {
  try {
    const { agents } = TeamFileSchema.parse(parse(readFileSync(path, "utf8")));
    return Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, agent.vendor]));
  } catch {
    return {}; // Only makes a label plainer. Core's own vendor still shows.
  }
}

function escalationWords(payload: Record<string, unknown>, names: Record<string, string>): string {
  switch (payload.kind) {
    case "add":
      return typeof payload.added === "string" ? `Backup added: ${names[payload.added] ?? payload.added}` : "No backup was available";
    case "post":
      return `Posted to ${String(payload.room)}`;
    case "notify":
      return "Requester told";
    default:
      return "Escalated";
  }
}

/** The policy core is enforcing, from core. It validated this text before loading it, so a failure here is a surprise. */
function inForce(text: string): PolicyFile {
  try {
    return PolicyFileSchema.parse(parse(text));
  } catch (error) {
    throw new CoreShapeError(`The policy core is enforcing has an unexpected shape: ${(error as Error).message}`);
  }
}

/**
 * Core's list leaves drills out, but that alone would give one away: a card with no row here is a drill. So while one
 * is open, anything newer stays off the list as well, and a missing card says nothing about why it is missing.
 */
export async function composeQueue(core: CoreSource, files: WorldFiles): Promise<QueueView> {
  const [{ requests: listed }, roster, policyInfo, team] = await Promise.all([
    read(core, "/v1/requests?state=open", OpenRequestsSchema),
    readRoster(core),
    read(core, "/v1/policy", PolicyInfoSchema),
    readTeamLedger(core),
  ]);
  const names = namesOf(roster);
  const policy = inForce(policyInfo.text);
  const vendors = agentVendors(files.teamPath);
  const about = (id: string) => team.entries.filter((entry) => entry.request_id === id);
  const open = team.holdingBack ? listed.filter((request) => about(request.id).length > 0) : listed;

  const inboxes = await Promise.all(
    roster.people.map(async (person) => ({ person, inbox: await readIfKnown(core, `/v1/inbox?user=${encodeURIComponent(person.id)}`, InboxSchema) })),
  );

  const requests: QueueItem[] = open.map((request) => {
    const holders = inboxes.flatMap(({ person, inbox }) =>
      (inbox?.items ?? []).filter((item) => item.request_id === request.id).map((item) => ({ person: person.name, handle: item.handle, room: item.room })),
    );
    const entries = about(request.id);
    const escalations = entries.filter((entry) => entry.type === "escalated");
    const lastEscalation = escalations.at(-1);
    const routed = entries.filter((entry) => entry.type === "routed").at(-1);
    const fallback = routed?.payload.fallback as { group?: string; room?: string; reason?: string } | null | undefined;
    const agentVendor = vendors[request.agent] ?? request.vendor;
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
      asked_by: named(request.requester_ids, names),
      flags: request.flags,
      quorum_required: request.quorum_required,
      approvals: request.approvals.length,
      created_at: request.created_at,
      expires_at: request.expires_at,
      // Core's room field is an opaque id unless it is a name, and an id means nothing to a person.
      room: holders.find((holder) => holder.room)?.room ?? (request.origin_room?.startsWith("#") ? request.origin_room : null),
      waiting_on: holders.map(({ person, handle }) => ({ person, handle })),
      fallback: fallback?.group && fallback.room ? { group: fallback.group, room: fallback.room, reason: fallback.reason ?? "" } : null,
      escalation: {
        fired: escalations.length,
        // Zero is a class with no ladder. Null is a class the policy does not know, such as an unmatched call.
        of: policyClass ? (policyClass.escalate?.length ?? 0) : null,
        last: lastEscalation ? escalationWords(lastEscalation.payload, names) : null,
      },
    };
  });

  return { open_count: requests.length, requests };
}

export async function composeAutonomy(core: CoreSource): Promise<AutonomyView> {
  const [autonomy, humanLoad, team, roster] = await Promise.all([
    read(core, "/v1/autonomy", AutonomySchema),
    read(core, "/v1/metrics/human-load", HumanLoadSchema),
    readTeamLedger(core),
    readRoster(core),
  ]);
  const names = namesOf(roster);
  return {
    levels: autonomy.levels,
    proposals: autonomy.proposals.map(({ id, state, quorum, signed_by, created_at, expires_at, decided_at, title, detail }) => ({
      id,
      state,
      quorum,
      signed_by: named(signed_by, names),
      created_at,
      expires_at,
      decided_at,
      title,
      detail,
    })),
    buckets: autonomy.buckets,
    evidence: autonomy.history,
    human_load: humanLoad,
    history: team.entries.filter((entry) => AUTONOMY_HISTORY_TYPES.has(entry.type)),
    names,
  };
}

/** A replay of one scope, on request. Core reads its history and writes nothing. */
export async function replayScope(core: CoreSource, filter: { agent?: string | undefined; class?: string | undefined; bucket?: string | undefined }): Promise<{ replays: BucketReplay[] }> {
  return checked("/v1/autonomy/simulate", await core.post("/v1/autonomy/simulate", filter), ReplaySchema);
}

/** The team view. It gets sums, and drill results in whole groups, never anyone's own record: that is `composePerson`. */
export async function composePeople(core: CoreSource): Promise<PeopleView> {
  const [roster, team] = await Promise.all([readRoster(core), readTeamLedger(core)]);
  const stats = await Promise.all(roster.people.map((person) => readIfKnown(core, `/v1/people/${encodeURIComponent(person.id)}/stats`, PersonStatsSchema)));
  const known = stats.flatMap((row) => (row ? [row] : []));
  const sum = (key: "answers" | "approvals" | "denials" | "fast_approvals" | "flags_ignored" | "batch_approvals" | "streaks") => known.reduce((total, row) => total + row[key], 0);
  return {
    people: roster.people,
    team: {
      answers: sum("answers"),
      approvals: sum("approvals"),
      denials: sum("denials"),
      fast_approvals: sum("fast_approvals"),
      flags_ignored: sum("flags_ignored"),
      batch_approvals: sum("batch_approvals"),
      streaks: sum("streaks"),
      drills: teamDrillTotals(team.drillResults),
    },
  };
}

/** One person's own record, for the admin's view. Null unless the id is on core's roster, so only those reach core. */
export async function composePerson(core: CoreSource, id: string): Promise<PersonDetail | null> {
  const roster = await readRoster(core);
  const person = roster.people.find((candidate) => candidate.id === id);
  if (!person) return null;
  return { ...person, stats: await read(core, `/v1/people/${encodeURIComponent(id)}/stats`, PersonStatsSchema) };
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

function fileHash(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
  } catch {
    return null; // The Desk may not run beside the policy file. Core's copy is what matters.
  }
}

/** Renders what core enforces, from core. The file is only compared with it, and a difference is usually expected. */
export async function composePolicy(core: CoreSource, files: WorldFiles): Promise<PolicyView> {
  const [info, ledger, roster] = await Promise.all([read(core, "/v1/policy", PolicyInfoSchema), readEntries(core), readRoster(core)]);
  const names = namesOf(roster);
  const file = inForce(info.text);
  const onDisk = fileHash(files.policyPath);
  const loaded = ledger.entries.filter((entry) => entry.type === "policy_loaded" && entry.payload.hash === info.hash).at(-1);
  const signedBy = Array.isArray(loaded?.payload.approved_by) ? (loaded.payload.approved_by as unknown[]).map(String) : [];

  let relation: PolicyRelation;
  if (onDisk === null) relation = "no_file";
  else if (onDisk === info.hash) relation = "same";
  else if (info.pending?.hash === onDisk) relation = "file_pending";
  else if (signedBy.length > 0) relation = "signed";
  else relation = "differs";

  return {
    core_hash: info.hash,
    file_hash: onDisk,
    relation,
    signed_by: named(signedBy, names),
    policy_error: info.error,
    mode: info.mode ?? file.mode ?? null,
    shadow_would_hold: info.shadow_would_hold,
    pending: info.pending ? { ...info.pending, signed_by: named(info.pending.signed_by, names) } : null,
    tiers: Object.entries(file.tiers).map(([name, [from, to]]) => ({ name, from, to })),
    classes: Object.entries(file.classes).map(([name, value]) => classRow(name, value)),
    text: info.text,
  };
}
