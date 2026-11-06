/**
 * clearance-core: the only place a decision becomes an effect. `check` is the only decision entry point.
 * The engine decides; this class records, holds, routes, answers and expires.
 *
 * The rule for concurrency: every state change happens in a synchronous SQLite transaction and only then
 * does anything talk to the outside. Two answers arriving together can never both think they decided.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ActionSchema,
  ApprovalOutcomeEventSchema,
  ChatMessageEventSchema,
  RequestStateSchema,
  type Action,
  type ApprovalOutcomeEvent,
  type CardOption,
  type ChatMessageEvent,
  type ChatPort,
  type CheckResponse,
  type Clock,
  type ExecuteResult,
  type Flag,
  type GatePort,
  type LookupPort,
  type OpenCardInput,
  type OpenCardResult,
  type RequestState,
} from "@clearance/contracts";
import { ulid } from "ulid";
import { AnswerStore, normaliseAnswer, type AnswerDecision } from "./answers/store.js";
import { BucketEventStore, type EventOutcome } from "./autonomy/history.js";
import { IncidentStore } from "./autonomy/incidents.js";
import { bucketStats, demotionText, meetsPromotion, plural, promotedText, promotionDetail, proposedLevel, type BucketStats, type Criteria } from "./autonomy/promotion.js";
import { ProposalStore, type Proposal } from "./autonomy/proposals.js";
import { AutonomyStore, capLevel, type Level } from "./autonomy/store.js";
import { describeCall, describeResult, type CallDescription } from "./cards/describe.js";
import { describedAction, parseAway, parseCommand, type Command } from "./commands/parse.js";
import { clipToBudget, renderCard, renderPrompt, renderReviewCard, TITLE_MAX } from "./cards/render.js";
import { buildCardView, type Audience } from "./cards/view.js";
import {
  askText,
  confirmFieldsFor,
  DENY_OPTION_ID,
  readQuestionAnswer,
  typedMatches,
  type ConfirmField,
} from "./confirm/typed.js";
import { openDatabase, type Db } from "./db/index.js";
import { DrillStore, loadFlaws, rollsDrill, type Flaw } from "./drills/library.js";
import { TimerStore, type TimerRow } from "./escalation/timers.js";
import { formatMoney, joinNames, oneLine, toNumber } from "./format.js";
import { GrantStore } from "./grants/grants.js";
import { inboxMessage, inboxText, listInbox, type InboxItem } from "./inbox/inbox.js";
import { Ledger, verifyLedger, type LedgerVerification } from "./ledger/ledger.js";
import { detectMismatch } from "./mismatch/detect.js";
import { Directory, loadIdentities, type Person } from "./people/directory.js";
import { PeopleStore } from "./people/store.js";
import { bucketFor, evaluateAction, MALFORMED_CLASS, UNKNOWN_PROTECTED_CLASS, UNPARSED_CLASS, type Evaluation } from "./policy/engine.js";
import { HELPERS, UNKNOWN, type EvalScope, type HelperName } from "./policy/expr.js";
import { changeSummary, patchedPolicyText, policyChanges } from "./policy/diff.js";
import { loadPolicy, loadTeam, parseDuration, parsePolicy, PolicyLoadError, type CompiledClass, type CompiledPolicy } from "./policy/load.js";
import type { TeamFile } from "./policy/schema.js";
import { OPEN_STATES, RequestStore, type NewRequest, type RequestRecord } from "./requests/store.js";
import { AggregateStore } from "./risk/aggregates.js";
import { agentElsewhereFlag, agentReachUnknownFlag, authorUnknownFlag, requesterUnknownFlag, uniqueFlags } from "./risk/flags.js";
import {
  evidenceLines,
  ignoredFlags,
  isBatch,
  isConcentrated,
  isStreak,
  stampConfig,
  tMinMs,
} from "./rubberstamp/signals.js";
import { AgentReachCheck, type AgentReach } from "./router/reach.js";
import { RequesterTracker } from "./router/requesters.js";
import { assessAnswer, route, type Refusal, type RouteContext, type RouteTrace } from "./router/router.js";
import { RouteStore, type RouteRow, type RouteStep } from "./router/routes.js";
import { TraceStore } from "./router/traces.js";
import { article, exclusionWords, explainTrace, heldExplanation, holderSentence, routeLabel } from "./router/why.js";
import { formatClockWithZone, formatPolicyMinutes, zonedParts } from "./time.js";

export type CoreDeps = {
  dbPath: string;
  policyPath: string;
  teamPath: string;
  identitiesPath?: string;
  /** Where the flaw library is. Defaults to the policy's `drills.library`, relative to the repo above policy/. */
  drillsPath?: string;
  /** Whether real holds roll for a drill at all. Sending one on demand works either way. */
  rollDrills?: boolean;
  /** CLEARANCE_DRILL_RATE: replaces the policy's rate for natural drills, so a take can be reproducible. */
  drillRate?: number | undefined;
  chat: ChatPort;
  gate: GatePort;
  lookup: LookupPort;
  clock: Clock;
  /** An `InboxKeeper` is running, so its post tells a person a card arrived and no separate line is needed. */
  runningInbox?: boolean;
};

export interface ClearanceCore {
  check(action: Action): Promise<CheckResponse>;
  onMessage(evt: ChatMessageEvent): Promise<void>;
  onApprovalOutcome(evt: ApprovalOutcomeEvent): Promise<void>;
  tick(): Promise<void>;
  close(): void;
}

export type { InboxItem };

/** What a request carries beyond its columns, fixed when it is held. */
export type Evidence = {
  extracted: Record<string, unknown>;
  lookups: Record<string, Record<string, unknown>>;
  aggregates: Evaluation["aggregates"];
  fired: Evaluation["fired"];
  holdSummary: string;
  policySubject?: string;
  bucket?: string;
  agentOwnerIds: string[];
  authorIds: string[];
  agentClaim?: string;
  description: CallDescription;
  /** The autonomy level of this call's bucket when it was held. L1 is the fast lane. */
  level?: string;
  /** Whether autonomy could have run this: no forced hold, no missing data, not critical. */
  autoEligible?: boolean;
  /** People who asked this agent in other rooms in the window. Not who asked for this, but they can't approve it. */
  askedElsewhereIds?: string[];
};

/** One line of `POST /v1/autonomy/simulate`: what the rule would do over the last days of decisions. */
export type BucketReplay = {
  agent: string;
  class: string;
  bucket: string;
  label: string;
  level: Level;
  max_level: Level;
  proposed_level: Level | null;
  window_days: number;
  requests: number;
  counted: number;
  fast_excluded: number;
  denied: number;
  incidents: number;
  edited: number;
  approvers: string[];
  would_auto: number;
  would_auto_approved: number;
  would_auto_denied: number;
  meets_criteria: boolean;
  needs: { approvals: number; min_distinct_approvers: number };
  synthetic_events: number;
  real_events: number;
};

const CARD_OPTIONS: (CardOption & { decision: "accept" | "decline" })[] = [
  { id: "allow", label: "Approve", decision: "accept" },
  { id: "deny", label: "Deny", decision: "decline" },
];

/** Real time, not policy time: how long a gate outage we will sit out before calling an approval dead. */
const EXECUTE_RETRY_EVERY_MS = 5_000;
const EXECUTE_GIVE_UP_AFTER_MS = 5 * 60_000;

/** Tries at a typed value: one, and one more when it was wrong. */
const CONFIRM_TRIES = 2;

const MAX_OPEN_CARDS_FOR_A_DRILL = 3;
const DAY_MS = 24 * 3_600_000;

/** L2's review window (F11). */
const REVIEW_WINDOW_MS = DAY_MS;
const REVIEW_OPTIONS: (CardOption & { decision: "accept" | "decline" | "cancel" })[] = [
  { id: "keep", label: "Keep", decision: "accept" },
  { id: "demote", label: "Demote", decision: "decline" },
  { id: "reverse", label: "Reverse", decision: "cancel" },
];
const REVIEW_CHOICES = new Set(REVIEW_OPTIONS.map((option) => option.id));

/** F18's review asks one question: was it right to do that? */
const GLASS_REVIEW_OPTIONS: (CardOption & { decision: "accept" | "decline" })[] = [
  { id: "justified", label: "Justified", decision: "accept" },
  { id: "not_justified", label: "Not justified", decision: "decline" },
];
const DEFAULT_GLASS_REVIEW = "24h";

/** How many recent actions a proposed policy is replayed over on its card. */
const POLICY_CARD_REPLAY = 100;

/** A command that arrives later than this, because core was down, is history rather than a request. */
const STALE_COMMAND_MS = 10 * 60_000;

/** The hash of the policy file when it was last acted on. Only a file that differs from this is news. */
const POLICY_FILE_SEEN = "policy_file_seen";

/** How long two people have to sign something. */
const PROPOSAL_TTL_MS = 3 * DAY_MS;
const POLICY_QUORUM_DEFAULT = 2;
/** When a policy doesn't say. Below two, the person who asked could be the only one who decides. */
const UNKNOWN_REQUESTER_QUORUM = 2;

/** Replay reads stored fields only: a rule that needs a lookup is unknown, and unknown is in no bucket. */
const NO_HELPERS = Object.fromEntries(HELPERS.map((name) => [name, () => UNKNOWN])) as EvalScope["helpers"] & Record<HelperName, () => unknown>;

type Verdict =
  | { kind: "closed"; state: string }
  | { kind: "unrecognised" }
  | { kind: "refused"; subject: Refused }
  | { kind: "denied"; person: Person; demotion: string | null }
  | { kind: "counted"; person: Person }
  | { kind: "approved"; people: string[] }
  | { kind: "retype"; person: Person }
  | { kind: "failed_confirm"; person: Person }
  | { kind: "needs_typed"; person: Person }
  | { kind: "drill"; person: Person; caught: boolean; latencyMs: number };

type CardPlace = { roomId: string; threadId?: string | undefined; named?: boolean };

type ReviewVerdict =
  | { kind: "closed" }
  | { kind: "unrecognised" }
  | { kind: "refused"; subject: Refused }
  | { kind: "kept" }
  | { kind: "demote" | "reverse"; person: Person; demotion: string | null };

type BucketAssessment = {
  agent: string;
  cls: CompiledClass;
  bucket: string;
  label: string;
  level: Level;
  max: Level;
  target: Level | null;
  criteria: Criteria;
  stats: BucketStats;
  meets: boolean;
  synthetic: number;
  real: number;
};

type StampReading = { fast: boolean; signals: string[]; tMin: number; flagsIgnored: string[] };

type Refused =
  | { type: "person"; person: Person; reasons: Refusal[] }
  | { type: "agent"; name: string }
  | { type: "unknown"; answeredBy: string | null };

export class Clearance implements ClearanceCore {
  readonly stores: {
    db: Db;
    ledger: Ledger;
    requests: RequestStore;
    grants: GrantStore;
    aggregates: AggregateStore;
    autonomy: AutonomyStore;
    routes: RouteStore;
    answers: AnswerStore;
    timers: TimerStore;
    drills: DrillStore;
    incidents: IncidentStore;
    events: BucketEventStore;
    proposals: ProposalStore;
  };
  readonly people: { directory: Directory; store: PeopleStore; requesters: RequesterTracker };
  readonly traces: TraceStore;
  readonly team: TeamFile;
  private currentPolicy: CompiledPolicy;
  private policyError: string | null = null;
  private ticking = false;
  private readonly lastExecuteAttempt = new Map<string, number>();
  private readonly executing = new Set<string>();
  /** Requests whose first cards are being opened right now. They are HELD meanwhile, which the tick's retry reads as failed. */
  private readonly opening = new Set<string>();
  private readonly reach: AgentReachCheck;

  constructor(private readonly deps: CoreDeps) {
    this.reach = new AgentReachCheck(deps.chat, deps.clock);
    this.team = loadTeam(deps.teamPath);
    const db = openDatabase(deps.dbPath);
    this.currentPolicy = this.policyAtBoot(db);
    const ledger = new Ledger(db, deps.clock);
    const requests = new RequestStore(db, ledger, deps.clock);
    this.stores = {
      db,
      ledger,
      requests,
      grants: new GrantStore(db, requests, ledger, deps.clock),
      aggregates: new AggregateStore(db),
      autonomy: new AutonomyStore(db),
      routes: new RouteStore(db, deps.clock),
      answers: new AnswerStore(db),
      timers: new TimerStore(db),
      drills: new DrillStore(db),
      incidents: new IncidentStore(db),
      events: new BucketEventStore(db),
      proposals: new ProposalStore(db),
    };
    const directory = new Directory(this.team, loadIdentities(deps.identitiesPath));
    this.people = {
      directory,
      store: new PeopleStore(db, directory, deps.clock),
      requesters: new RequesterTracker(db, directory, deps.clock),
    };
    this.people.store.sync(this.team);
    this.traces = new TraceStore(db, deps.clock);
    const firstBoot = db.prepare(`SELECT 1 FROM policy_versions LIMIT 1`).get() === undefined;
    this.recordPolicyVersion(this.currentPolicy);
    if (firstBoot) this.setMeta(POLICY_FILE_SEEN, this.currentPolicy.hash);
  }

  private getMeta(key: string): string | null {
    const row = this.stores.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.stores.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  /**
   * F17: once a policy that takes signatures is in force, a restart mustn't launder an unsigned edit. So the database's
   * last signed policy wins over the file, and the tick then proposes the file. The first boot adopts the file.
   */
  private readableOrNull(text: string): CompiledPolicy | null {
    try {
      return parsePolicy(text, this.deps.policyPath);
    } catch {
      return null; // Stored by a version whose schema this one no longer reads. The file is all there is.
    }
  }

  private policyAtBoot(db: Db): CompiledPolicy {
    const row = db.prepare(`SELECT hash, text FROM policy_versions ORDER BY loaded_at DESC, rowid DESC LIMIT 1`).get() as
      | { hash: string; text: string | null }
      | undefined;
    const signed = row?.text ? this.readableOrNull(row.text) : null;
    try {
      const file = loadPolicy(this.deps.policyPath);
      return signed && signed.hash !== file.hash && signed.file.policy_change_quorum ? signed : file;
    } catch (error) {
      if (!signed) throw error;
      this.policyError = (error as Error).message;
      return signed;
    }
  }

  policy(): CompiledPolicy {
    return this.currentPolicy;
  }

  /** Why the last hot reload was refused; null when the file on disk is the policy in force. */
  lastPolicyError(): string | null {
    return this.policyError;
  }

  verifyLedger(): LedgerVerification {
    return verifyLedger(this.stores.db);
  }

  /** For `hookRoutes`: a hook's cwd to its agent. Null is an unknown agent, which is never an allow. */
  resolveAgent(cwd: string | undefined, agentType?: string): string | null {
    return this.people.directory.resolveAgent(cwd, agentType);
  }

  health(): { ok: true; policy_hash: string; mode: string; policy_error: string | null; open_requests: number } {
    return {
      ok: true,
      policy_hash: this.currentPolicy.hash,
      mode: this.currentPolicy.file.mode,
      policy_error: this.policyError,
      open_requests: this.stores.requests.listInState(OPEN_STATES).filter((request) => !request.isDrill).length,
    };
  }

  /** State and evidence for GET /v1/requests/:id. The gate reads `state` at the top level. */
  describeRequest(id: string): Record<string, unknown> | null {
    const request = this.stores.requests.get(id);
    if (!request) return null;
    return {
      id: request.id,
      state: request.state,
      class: request.cls,
      tier: request.tier,
      score: request.score,
      call_hash: request.callHash,
      target: request.target,
      agent: request.agent,
      vendor: request.vendor,
      source: request.source,
      requester_ids: request.requesterIds,
      agent_owner_id: request.agentOwnerId,
      origin_room: request.originRoom,
      origin_thread: request.originThread,
      flags: request.flags,
      evidence: request.evidence,
      quorum_required: request.quorumRequired,
      approvals: this.stores.answers.countedApprovers(request.id),
      created_at: new Date(request.createdAtMs).toISOString(),
      expires_at: new Date(request.expiresAtMs).toISOString(),
      decided_at: request.decidedAtMs === null ? null : new Date(request.decidedAtMs).toISOString(),
      // Only once it is over: while it is open, a drill looks like anything else.
      ...(OPEN_STATES.includes(request.state) ? {} : { is_drill: request.isDrill }),
    };
  }

  /** Requester or agent changed their mind. Nothing runs; cards close; the agent hears. */
  async cancel(id: string, by: string | null): Promise<"cancelled" | "not_found" | "not_open"> {
    const { requests, ledger, aggregates } = this.stores;
    const request = requests.get(id);
    if (!request) return "not_found";
    const write = this.stores.db.transaction((): boolean => {
      if (!OPEN_STATES.includes(requests.require(id).state)) return false;
      requests.transition(id, "CANCELLED");
      ledger.append("cancelled", id, { by });
      aggregates.voidRequest(id);
      return true;
    });
    if (!write.immediate()) return "not_open";
    await this.closeOpenCards(request);
    await this.notifyAgent(request, `${id} was cancelled. Nothing was executed.`);
    return "cancelled";
  }

  /** Open requests holding a card for one person, newest first. Null for someone unknown. */
  inbox(userId: string): { user: string; count: number; items: InboxItem[]; text: string } | null {
    if (!this.people.directory.person(userId)) return null;
    const items = this.inboxItems(userId);
    return { user: userId, count: items.length, items, text: inboxText(items) };
  }

  inboxItems(userId: string): InboxItem[] {
    const { db, routes, requests } = this.stores;
    return listInbox({ db, routes, requests, traces: this.traces, directory: this.people.directory, nowMs: this.deps.clock.nowMs() }, userId);
  }

  personStats(userId: string): Record<string, unknown> | null {
    if (!this.people.directory.person(userId)) return null;
    const rows = this.stores.db
      .prepare(
        `SELECT a.decision, a.eligible, a.latency_ms, a.fast, a.signals, r.tier FROM answers a JOIN requests r ON r.id = a.request_id
         WHERE a.user_id = ? AND r.is_drill = 0`,
      )
      .all(userId) as {
      decision: string | null;
      eligible: number;
      latency_ms: number | null;
      fast: number;
      signals: string | null;
      tier: string;
    }[];
    const counted = rows.filter((row) => row.eligible === 1);
    const medianLatency = (from: typeof rows) => {
      const latencies = from.flatMap((row) => (row.latency_ms === null ? [] : [row.latency_ms])).sort((a, b) => a - b);
      return latencies.length > 0 ? (latencies[Math.floor((latencies.length - 1) / 2)] as number) : null;
    };
    const signals: Record<string, number> = {};
    for (const row of counted) {
      for (const signal of JSON.parse(row.signals ?? "[]") as string[]) signals[signal] = (signals[signal] ?? 0) + 1;
    }
    const byTier: Record<string, { answers: number; median_latency_ms: number | null }> = {};
    for (const tier of new Set(counted.map((row) => row.tier))) {
      const inTier = counted.filter((row) => row.tier === tier);
      byTier[tier] = { answers: inTier.length, median_latency_ms: medianLatency(inTier) };
    }
    return {
      user: userId,
      answers: counted.length,
      approvals: counted.filter((row) => row.decision === "approve").length,
      denials: counted.filter((row) => row.decision === "deny").length,
      ineligible: rows.length - counted.length,
      median_latency_ms: medianLatency(counted),
      open_cards: this.stores.routes.openCount(userId),
      fast_approvals: counted.filter((row) => row.fast === 1).length,
      flags_ignored: signals.flag_ignored ?? 0,
      batch_approvals: signals.batch ?? 0,
      streaks: signals.streak ?? 0,
      signals,
      friction: this.people.store.friction(userId),
      by_tier: byTier,
      drills: this.stores.drills.summary(userId),
    };
  }

  /** What each vendor has actually sent, from real traffic. */
  coverage(): { vendors: Record<string, unknown>[] } {
    const vendors = this.stores.db
      .prepare(
        `SELECT vendor, source, COUNT(*) AS calls,
           SUM(decision = 'allow') AS allowed, SUM(decision = 'hold') AS held, SUM(decision = 'deny') AS denied,
           MAX(at) AS last_at
         FROM actions GROUP BY vendor, source ORDER BY vendor, source`,
      )
      .all() as Record<string, unknown>[];
    return { vendors };
  }

  /** GET /v1/autonomy, less the replay, which `autonomyReplay` works out. */
  autonomyReport(): {
    levels: ReturnType<AutonomyStore["all"]>;
    proposals: Record<string, unknown>[];
    history: { synthetic: number; real: number };
  } {
    const { autonomy, proposals, events } = this.stores;
    return {
      levels: autonomy.all(),
      proposals: proposals.all().filter((proposal) => proposal.kind === "promotion").map((proposal) => {
        const { title, detail, stats: _stats, ...about } = proposal.payload;
        return {
          id: proposal.id,
          kind: proposal.kind,
          state: proposal.state,
          quorum: proposal.quorum,
          signed_by: proposals.signers(proposal.id),
          created_at: new Date(proposal.createdAtMs).toISOString(),
          expires_at: new Date(proposal.expiresAtMs).toISOString(),
          decided_at: proposal.decidedAtMs === null ? null : new Date(proposal.decidedAtMs).toISOString(),
          title,
          detail,
          ...about,
        };
      }),
      history: events.counts(),
    };
  }

  /** POST /v1/autonomy/simulate: the proposed rule over recorded history. Reads only. */
  async autonomyReplay(filter: { agent?: string | undefined; class?: string | undefined; bucket?: string | undefined } = {}): Promise<BucketReplay[]> {
    const assessed = await this.assessBuckets(filter);
    return assessed.map((row) => ({
      agent: row.agent,
      class: row.cls.name,
      bucket: row.bucket,
      label: row.label,
      level: row.level,
      max_level: row.max,
      proposed_level: row.target,
      window_days: row.criteria.days,
      requests: row.stats.requests,
      counted: row.stats.counted,
      fast_excluded: row.stats.fastExcluded,
      denied: row.stats.denied,
      incidents: row.stats.incidents,
      edited: row.stats.edited,
      approvers: row.stats.approvers,
      would_auto: row.stats.wouldAuto,
      would_auto_approved: row.stats.wouldAutoApproved,
      would_auto_denied: row.stats.wouldAutoDenied,
      meets_criteria: row.meets,
      needs: { approvals: row.criteria.approvals, min_distinct_approvers: row.criteria.minDistinctApprovers },
      synthetic_events: row.synthetic,
      real_events: row.real,
    }));
  }

  /** GET /v1/requests. Drills stay out of every list: they are between Clearance and one person. */
  listRequests(state?: "open" | RequestState): Record<string, unknown>[] {
    const { requests } = this.stores;
    const states = state === undefined ? RequestStateSchema.options : state === "open" ? OPEN_STATES : [state];
    return requests
      .listInState([...states])
      .filter((request) => !request.isDrill)
      .map((request) => this.describeRequest(request.id) as Record<string, unknown>);
  }

  /** GET /v1/people. Who there is and who is away. What each person's record looks like is /v1/people/:id/stats. */
  listPeople(): Record<string, unknown>[] {
    const { directory, store } = this.people;
    return directory.all().map((person) => {
      const away = store.away(person.id);
      return {
        id: person.id,
        name: person.name,
        groups: person.groups,
        roles: person.roles,
        away: away ? { until: new Date(away.untilMs).toISOString(), delegate_to: away.delegateTo } : null,
      };
    });
  }

  /** GET /v1/policy: what is in force, whatever the file on disk says. */
  policyInfo(): Record<string, unknown> {
    const policy = this.currentPolicy;
    const { n } = this.stores.db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE would_decide = 'hold'`).get() as { n: number };
    const pending = this.stores.proposals.openOfKind("policy_change");
    return {
      hash: policy.hash,
      mode: policy.file.mode,
      source: policy.source,
      error: this.policyError,
      text: policy.text,
      classes: policy.classes.map((cls) => cls.name),
      shadow_would_hold: n,
      pending: pending
        ? { proposal: pending.id, hash: pending.payload.hash, signed_by: this.stores.proposals.signers(pending.id), quorum: pending.quorum, detail: pending.payload.detail }
        : null,
    };
  }

  /**
   * GET /v1/export.csv (F22): one row per real request, for NIST AC-5 and PCI DSS 6.x evidence: who requested, who
   * approved, the separation proof, timestamps and hashes. `separation_holds` is worked out here from who approved,
   * not read from anything the router said when it routed.
   */
  auditRows(): Record<string, string | number>[] {
    const { requests, answers, ledger } = this.stores;
    return requests
      .listInState([...RequestStateSchema.options])
      .filter((request) => !request.isDrill)
      .map((request) => {
        const entries = ledger.list({ requestId: request.id });
        const of = (type: string) => entries.find((entry) => entry.type === type);
        const counted = answers.countedApprovers(request.id);
        const trace = this.traces.latest(request.id);
        const excluded = (trace?.excluded ?? []).filter((entry) => entry.reasons.length > 0);
        const barred = new Set([...request.requesterIds, ...excluded.map((entry) => entry.id)]);
        const auto = request.state === "AUTO" ? (this.evidenceOf(request).level ?? "L2") : null;
        return {
          request_id: request.id,
          class: request.cls,
          tier: request.tier,
          agent: request.agent,
          vendor: request.vendor,
          target: request.target,
          call_hash: request.callHash,
          requested_by: request.requesterIds.join(" "),
          approved_by: counted.length > 0 ? counted.join(" ") : auto ? `autonomy:${auto}` : "",
          denied_by: String(of("denied")?.payload.denied_by ?? ""),
          break_glass_by: String(of("break_glass")?.payload.by ?? ""),
          excluded_from_approving: excluded.map((entry) => `${entry.id}(${entry.reasons.join("+")})`).join(" "),
          separation_holds: counted.length === 0 ? "n/a" : String(!counted.some((id) => barred.has(id))),
          quorum_required: request.quorumRequired,
          quorum_met: String(counted.length >= request.quorumRequired),
          state: request.state,
          held_at: new Date(request.createdAtMs).toISOString(),
          decided_at: request.decidedAtMs === null ? "" : new Date(request.decidedAtMs).toISOString(),
          executed_at: of("executed")?.at ?? of("grant_consumed")?.at ?? "",
          last_ledger_hash: entries.at(-1)?.entry_hash ?? "",
        };
      });
  }

  /** GET /v1/digest (F22): the last day. Drills only as totals: who missed one is that person's business. */
  digest(): Record<string, unknown> & { text: string } {
    const { db, events } = this.stores;
    const now = this.deps.clock.nowMs();
    const since = now - DAY_MS;
    const { currency } = this.currentPolicy;
    const requests = db.prepare(`SELECT state, created_at, decided_at FROM requests WHERE is_drill = 0 AND created_at > ?`).all(since) as {
      state: RequestState;
      created_at: number;
      decided_at: number | null;
    }[];
    const inState = (...states: RequestState[]) => requests.filter((row) => states.includes(row.state)).length;
    const held = requests.filter((row) => row.state !== "AUTO");
    const waits = held.flatMap((row) => (row.decided_at === null ? [] : [row.decided_at - row.created_at])).sort((a, b) => a - b);
    const medianDecisionMs = waits.length > 0 ? (waits[Math.floor((waits.length - 1) / 2)] as number) : null;
    const tally = {
      held: held.length,
      approved: inState("APPROVED", "EXECUTED", "GRANTED", "CONSUMED"),
      denied: inState("DENIED"),
      expired: inState("EXPIRED"),
      cancelled: inState("CANCELLED"),
      break_glass: (db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE type = 'break_glass' AND at > ?`).get(new Date(since).toISOString()) as { n: number }).n,
      ran_alone: inState("AUTO"),
    };
    const groups = new Map<string, { agent: string; cls: string; bucket: string; ran: number; spent: number }>();
    for (const event of events.autoRuns(since)) {
      if (!event.bucket) continue;
      const key = `${event.agent}/${event.cls}/${event.bucket}`;
      const group = groups.get(key) ?? { agent: event.agent, cls: event.cls, bucket: event.bucket, ran: 0, spent: 0 };
      group.ran += 1;
      group.spent += toNumber(event.fields.amount) ?? 1;
      groups.set(key, group);
    }
    const autonomy = [...groups.values()].map((group) => {
      const cls = this.classOf(group.cls);
      return {
        agent: group.agent,
        class: group.cls,
        bucket: group.bucket,
        label: cls ? this.bucketLabel(cls, group.bucket) : group.bucket,
        level: this.stores.autonomy.levelFor(group.agent, group.cls, group.bucket),
        ran: group.ran,
        spent: group.spent,
        cap: cls?.autonomy?.buckets.find((bucket) => bucket.name === group.bucket)?.dailyCap ?? null,
      };
    });
    const drills = db
      .prepare(`SELECT COUNT(*) AS sent, COALESCE(SUM(result = 'caught'), 0) AS caught, COALESCE(SUM(result = 'missed'), 0) AS missed FROM drills WHERE at > ?`)
      .get(since) as { sent: number; caught: number; missed: number };
    const incidents = this.stores.incidents.all().filter((row) => row.at > since).length;
    const money = (value: number) => (currency ? formatMoney(value, currency) : String(value));
    const lines = [
      `Clearance digest, last 24 h: ${tally.held} held, ${tally.approved} approved, ${tally.denied} denied, ${tally.expired} expired, ${tally.break_glass} break-glass, ${tally.ran_alone} ran alone.`,
      medianDecisionMs === null ? null : `Median time to a decision: ${Math.round(medianDecisionMs / 1000)} s.`,
      ...autonomy.map((row) => {
        const spent = row.cap !== null ? `, ${money(row.spent)} of its ${money(row.cap)} daily cap` : "";
        return `${row.agent} ran ${row.ran} of ${row.label} on its own${spent}.`;
      }),
      `Incidents: ${incidents}. Drills: ${drills.sent} sent, ${drills.caught} caught, ${drills.missed} missed.`,
    ].filter((line): line is string => line !== null);
    return {
      since: new Date(since).toISOString(),
      until: new Date(now).toISOString(),
      requests: tally,
      median_decision_ms: medianDecisionMs,
      autonomy,
      incidents,
      drills,
      text: lines.join("\n"),
    };
  }

  /** Once a day at the policy's time, and never for a time that had already gone by when this first looked. */
  private async sendDigestIfDue(now: number): Promise<void> {
    const at = this.currentPolicy.file.digest?.at;
    if (!at) return;
    const { db } = this.stores;
    const tz = this.currentPolicy.defaults.business_hours.tz;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    const [hours, minutes] = at.split(":").map(Number) as [number, number];
    const due = zonedParts(now, tz).minutes >= hours * 60 + minutes;
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'digest_last'`).get() as { value: string } | undefined;
    const remember = (value: string) =>
      db.prepare(`INSERT INTO meta (key, value) VALUES ('digest_last', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(value);
    if (!row) {
      remember(due ? day : "");
      return;
    }
    if (!due || row.value === day) return;
    remember(day);
    await this.announce(this.digest().text);
  }

  /** What `mode: shadow` has logged, newest first. */
  shadowLog(limit = 100): { would_hold: Record<string, unknown>[] } {
    const rows = this.stores.db
      .prepare(`SELECT id, at, agent, vendor, class, tier, score, call_hash, step FROM actions WHERE would_decide = 'hold' ORDER BY rowid DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return { would_hold: rows };
  }

  /**
   * GET /v1/metrics/human-load: human decisions per 100 agent actions, from real traffic only. A decision is an
   * eligible answer on a real request. "Governed" leaves out the work policy lets through without a thought.
   */
  humanLoad(): Record<string, unknown> {
    const { db } = this.stores;
    const known = new Set(this.currentPolicy.classes.map((cls) => cls.name));
    const per100 = (decisions: number, actions: number) => (actions === 0 ? null : Math.round((decisions / actions) * 1000) / 10);
    const actions = db.prepare(`SELECT class, step, COUNT(*) AS n FROM actions GROUP BY class, step`).all() as { class: string | null; step: string; n: number }[];
    const decisions = db
      .prepare(
        `SELECT r.class AS class, COUNT(*) AS n FROM answers a JOIN requests r ON r.id = a.request_id
         WHERE a.eligible = 1 AND a.decision IS NOT NULL AND r.is_drill = 0 GROUP BY r.class`,
      )
      .all() as { class: string; n: number }[];
    const governed = (row: { class: string | null; step: string }) => row.class !== null && known.has(row.class) && row.step !== "via_gate";
    const total = actions.reduce((sum, row) => sum + row.n, 0);
    const governedTotal = actions.filter(governed).reduce((sum, row) => sum + row.n, 0);
    const humanDecisions = decisions.reduce((sum, row) => sum + row.n, 0);
    const byClass = [...known].flatMap((name) => {
      const agentActions = actions.filter((row) => row.class === name && governed(row)).reduce((sum, row) => sum + row.n, 0);
      const human = decisions.find((row) => row.class === name)?.n ?? 0;
      return agentActions === 0 && human === 0 ? [] : [{ class: name, agent_actions: agentActions, human_decisions: human, per_100: per100(human, agentActions) }];
    });
    return {
      agent_actions: total,
      governed_actions: governedTotal,
      human_decisions: humanDecisions,
      per_100: per100(humanDecisions, total),
      per_100_governed: per100(humanDecisions, governedTotal),
      by_class: byClass,
    };
  }

  /**
   * POST /v1/policy/simulate with `last`: replays the last N actions under the policy in force and under a proposed
   * one, each at its own time and with its own running window, and reports the deltas. Writes nothing.
   */
  async replayPolicy(input: { policy?: string | undefined; last: number }): Promise<Record<string, unknown>> {
    const proposed = input.policy !== undefined ? parsePolicy(input.policy, "proposed policy") : this.currentPolicy;
    const rows = (
      this.stores.db.prepare(`SELECT id, at, agent, action_json FROM actions ORDER BY rowid DESC LIMIT ?`).all(input.last) as {
        id: string;
        at: string;
        agent: string;
        action_json: string | null;
      }[]
    ).reverse();
    const actions = rows.flatMap((row) => (row.action_json ? [JSON.parse(row.action_json) as Action] : []));
    const seen = new Map<string, Promise<Record<string, unknown> | null>>();
    const lookup: LookupPort = {
      lookup: (kind, id) => {
        const key = `${kind}/${id}`;
        const known = seen.get(key) ?? this.deps.lookup.lookup(kind, id);
        seen.set(key, known);
        return known;
      },
    };
    const under = (policy: CompiledPolicy) => this.replayUnder(policy, actions, lookup);
    const current = await under(this.currentPolicy);
    const next = proposed === this.currentPolicy ? current : await under(proposed);
    const tally = (results: Evaluation[]) => {
      const counts = { allow: 0, hold: 0, deny: 0 };
      for (const result of results) counts[result.decision] += 1;
      return counts;
    };
    const before = tally(current);
    const after = tally(next);
    return {
      replayed: actions.length,
      skipped: rows.length - actions.length,
      policy_hash: { current: this.currentPolicy.hash, proposed: proposed.hash },
      current: before,
      proposed: after,
      delta: { allow: after.allow - before.allow, hold: after.hold - before.hold, deny: after.deny - before.deny },
      changed: actions.flatMap((action, index) => {
        const from = current[index] as Evaluation;
        const to = next[index] as Evaluation;
        if (from.decision === to.decision) return [];
        return [{ action_id: action.id, at: action.at, agent: action.agent.name, class: to.cls ?? from.cls, tier: to.tier ?? null, from: from.decision, to: to.decision }];
      }),
    };
  }

  private async replayUnder(policy: CompiledPolicy, actions: Action[], lookup: LookupPort): Promise<Evaluation[]> {
    let nowMs = this.deps.clock.nowMs();
    const clock: Clock = { nowMs: () => nowMs, scaledMs: (ms) => this.deps.clock.scaledMs(ms) };
    const window: { cls: string; by: string; key: string; value: number; atMs: number }[] = [];
    const spent: { agent: string; cls: string; bucket: string; cost: number; atMs: number }[] = [];
    const results: Evaluation[] = [];
    for (const action of actions) {
      const at = Date.parse(action.at);
      if (!Number.isNaN(at)) nowMs = at;
      const evaluation = await evaluateAction(action, {
        policy,
        lookup,
        clock,
        aggregates: {
          sum: (cls, by, key, since) =>
            window.filter((row) => row.cls === cls && row.by === by && row.key === key && row.atMs > since).reduce((sum, row) => sum + row.value, 0),
        },
        autonomy: {
          levelFor: (agent, cls, bucket) => this.stores.autonomy.levelFor(agent, cls, bucket),
          ceiling: (agent, cls, bucket, at2) => this.stores.autonomy.ceiling(agent, cls, bucket, at2),
          spentToday: (agent, cls, bucket, at2) =>
            spent.filter((row) => row.agent === agent && row.cls === cls && row.bucket === bucket && row.atMs > at2 - DAY_MS).reduce((sum, row) => sum + row.cost, 0),
        },
      });
      results.push(evaluation);
      if (evaluation.decision === "deny") continue;
      for (const hit of evaluation.aggregates) window.push({ cls: evaluation.call.class, by: hit.by, key: hit.key, value: hit.value, atMs: nowMs });
      if (evaluation.step === "autonomy" && evaluation.cls && evaluation.bucket) {
        spent.push({ agent: action.agent.name, cls: evaluation.cls, bucket: evaluation.bucket, cost: toNumber(evaluation.extracted.amount) ?? 1, atMs: nowMs });
      }
    }
    return results;
  }

  /** Runs the policy over a call and records nothing. Makes real lookups, never consumes a grant. */
  async simulate(action: Action): Promise<Record<string, unknown>> {
    const evaluation = await evaluateAction(action, {
      policy: this.currentPolicy,
      lookup: this.deps.lookup,
      clock: this.deps.clock,
      aggregates: this.stores.aggregates,
      autonomy: this.stores.autonomy,
    });
    return { ...this.responseFor(evaluation), step: evaluation.step, hold_summary: evaluation.holdSummary ?? null };
  }

  async check(input: Action): Promise<CheckResponse> {
    const parsed = ActionSchema.safeParse(input);
    if (!parsed.success) return { decision: "deny", reason: "DENIED: malformed action" };
    const action = parsed.data;
    const { grants } = this.stores;
    if (!this.people.directory.isTeamAgent(action.agent.name)) return this.denyUnknownAgent(action);
    const shadowing = this.currentPolicy.file.mode === "shadow";
    const evaluation = await evaluateAction(action, {
      policy: this.currentPolicy,
      lookup: this.deps.lookup,
      clock: this.deps.clock,
      aggregates: this.stores.aggregates,
      autonomy: this.stores.autonomy,
      // Only a hook call retries under a grant. An approved gate call runs through gate.execute.
      grants:
        action.source === "hook"
          ? {
              has: (hash, a) => grants.has(hash, a.agent.name),
              consumeAll: (hashes, a) => grants.consumeAll(hashes, a.agent.name, a.id),
            }
          : undefined,
    });
    if (shadowing && evaluation.decision !== "deny") return this.inShadow(action, evaluation);
    switch (evaluation.decision) {
      case "allow":
        return evaluation.step === "autonomy" ? this.runOnItsOwn(action, evaluation) : this.allow(action, evaluation);
      case "deny":
        return this.deny(action, evaluation);
      case "hold":
        return this.hold(action, evaluation);
    }
  }

  async onMessage(input: ChatMessageEvent): Promise<void> {
    const parsed = ChatMessageEventSchema.safeParse(input);
    if (!parsed.success) return;
    const evt = parsed.data;
    const { directory, store, requesters } = this.people;
    if (directory.isSelf(evt.sender, evt.senderName)) return;
    const person = directory.personByParticipant(evt.sender);
    if (person) store.noteActive(person.id, evt.roomId, evt.messageId);
    requesters.observe(evt);
    await this.handleCommand(evt, person?.id ?? null);
  }

  async onApprovalOutcome(input: ApprovalOutcomeEvent): Promise<void> {
    const parsed = ApprovalOutcomeEventSchema.safeParse(input);
    if (!parsed.success) return;
    const evt = parsed.data;
    const { routes, answers, requests } = this.stores;
    const card = routes.bySwitchRequest(evt.switchRequestId);
    if (!card || card.session_id !== evt.sessionId) return; // Not one of our cards.
    if (evt.state !== "answered") {
      routes.close(card.id);
      return;
    }
    if (card.step === "proposal") {
      await this.answerProposal(card, evt);
      return;
    }
    if (answers.existsForCard(evt.switchRequestId)) return; // Redelivered.
    routes.close(card.id);
    if (card.step === "review") {
      await this.answerReview(card, evt);
      return;
    }
    if (card.step === "glass_review") {
      await this.answerGlassReview(card, evt);
      return;
    }

    let request = requests.require(card.request_id);
    if (OPEN_STATES.includes(request.state) && request.expiresAtMs <= this.deps.clock.nowMs()) {
      await this.expire(request);
      request = requests.require(card.request_id);
    }
    const judge = this.stores.db.transaction(() => this.judgeAnswer(request, card, evt));
    const verdict = judge.immediate();
    await this.actOnVerdict(request.id, card, verdict);
  }

  /** Timers and retries. main calls this every second, so a slow one must not overlap the next. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.reloadPolicyIfChanged();
      const { requests, grants, timers, routes } = this.stores;
      const now = this.deps.clock.nowMs();
      for (const request of requests.listExpired(now)) await this.expire(request);
      grants.voidExpired();
      // A card that could not be opened (Switch down) is retried until the request expires.
      for (const request of requests.listInState(["HELD"])) {
        if (!this.opening.has(request.id)) await this.routeAndOpen(request, "primary");
      }
      for (const timer of timers.due(now)) await this.fireEscalation(timer);
      for (const request of requests.listInState(["APPROVED", "BREAK_GLASS"])) await this.retryExecution(request);
      for (const row of routes.staleReviews(now)) await this.closeOpenCards(requests.require(row.request_id));
      for (const request of requests.awaitingReview(now)) await this.openReview(request);
      await this.expireProposals(now);
      for (const proposal of this.stores.proposals.allOpen()) await this.coverProposal(proposal);
      await this.openMissingGlassReviews();
      await this.chaseGlassReviews(now);
      await this.sendDigestIfDue(now);
    } finally {
      this.ticking = false;
    }
  }

  close(): void {
    this.stores.db.close();
  }

  // ── Decisions ──────────────────────────────────────────────────────────────

  /**
   * `mode: shadow` (F16): logs what enforcement would have done and blocks nothing. No request, no card, no review.
   * The window still adds up, so what it reports is what enforcing would really do. A deny stays a deny, because
   * those guard Clearance itself and shadow is a question about holds.
   */
  private inShadow(action: Action, evaluation: Evaluation): CheckResponse {
    const would = evaluation.decision;
    const write = this.stores.db.transaction(() => {
      this.recordAction(action, { ...evaluation, decision: "allow" }, evaluation.grantRequestId ?? null, would);
      this.recordAggregates(action, evaluation, null);
    });
    write.immediate();
    const response: CheckResponse = { ...this.responseFor(evaluation), decision: "allow", would_decide: would };
    if (would === "hold") response.reason = `SHADOW, not enforced: would have held: ${evaluation.holdSummary ?? evaluation.reason}`;
    return response;
  }

  private allow(action: Action, evaluation: Evaluation): CheckResponse {
    const write = this.stores.db.transaction(() => {
      this.recordAction(action, evaluation, evaluation.grantRequestId ?? null);
      this.recordAggregates(action, evaluation, null);
    });
    write.immediate();
    const response = this.responseFor(evaluation);
    if (evaluation.grantRequestId) {
      response.request_id = evaluation.grantRequestId;
      response.grant_consumed = true;
    }
    return response;
  }

  private deny(action: Action, evaluation: Evaluation): CheckResponse {
    const write = this.stores.db.transaction(() => {
      this.recordAction(action, evaluation, null);
      this.stores.ledger.append("denied", null, {
        action_id: action.id,
        agent: action.agent.name,
        class: evaluation.cls,
        target: evaluation.call.target,
        reason: evaluation.reason,
      });
    });
    write.immediate();
    return this.responseFor(evaluation);
  }

  private denyUnknownAgent(action: Action): CheckResponse {
    const reason = `DENIED: ${action.agent.name} is not an agent on this team.`;
    const evaluation: Evaluation = {
      decision: "deny",
      step: "unknown_agent",
      cls: null,
      call: { class: "unknown_agent", target: "", args: {} },
      callHash: "",
      flags: [],
      reason,
      extracted: {},
      lookups: {},
      fired: [],
      aggregates: [],
    };
    return this.deny(action, evaluation);
  }

  private async hold(action: Action, evaluation: Evaluation): Promise<CheckResponse> {
    const { requests } = this.stores;
    const now = this.deps.clock.nowMs();
    const stale = requests.findOpen(evaluation.callHash, action.agent.name);
    if (stale && stale.expiresAtMs <= now) await this.expire(stale);
    // Asked before the transaction, which can't wait, and only for a request that will be new.
    const reach = stale && stale.expiresAtMs > now ? "all_seen" : await this.reach.of(action.agent.name);

    const write = this.stores.db.transaction((): { request: RequestRecord; isNew: boolean } => {
      const open = requests.findOpen(evaluation.callHash, action.agent.name);
      if (open) {
        this.recordAction(action, evaluation, open.id);
        return { request: open, isNew: false };
      }
      const created = requests.create(this.newRequest(action, evaluation, now, undefined, reach));
      this.recordAction(action, evaluation, created.id);
      this.recordAggregates(action, evaluation, created.id);
      this.startLadder(created);
      return { request: created, isNew: true };
    });
    const { request, isNew } = write.immediate();
    if (isNew) {
      this.opening.add(request.id);
      try {
        await this.routeAndOpen(request, "primary");
      } finally {
        this.opening.delete(request.id);
      }
      await this.maybeRollDrill(request);
    }
    const response: CheckResponse = {
      ...this.responseFor(evaluation),
      reason: this.holdReason(request.id, action, evaluation),
      request_id: request.id,
    };
    if (request.flags.length > 0) response.flags = request.flags;
    return response;
  }

  private classOf(name: string): CompiledClass | null {
    return this.currentPolicy.classes.find((candidate) => candidate.name === name) ?? null;
  }

  private newRequest(action: Action, evaluation: Evaluation, now: number, drill?: Flaw & { askedBy: string }, reach: AgentReach = "all_seen"): NewRequest {
    const policy = this.currentPolicy;
    const { directory, requesters } = this.people;
    const { aggregates } = this.stores;
    const clsName = evaluation.cls ?? evaluation.call.class;
    const cls = this.classOf(clsName);
    const tier = evaluation.tier ?? "high";
    // A call that says which room it came from was asked for in that room: anyone on record elsewhere is someone
    // else's request. Nobody on record there is nobody known, even if the agent is busy in other rooms.
    const askedIn = drill ? undefined : action.session?.switchRoomId;
    const everyoneAsking = drill ? [drill.askedBy] : requesters.requestersOf(action.agent.name);
    const requesterIds = askedIn === undefined ? everyoneAsking : requesters.requestersOf(action.agent.name, directory.roomId(askedIn));
    const agentOwnerIds = directory.agentOwners(action.agent.name, action.agent.ownerUserId);
    const origin = drill
      ? null
      : action.session?.switchRoomId !== undefined
        ? { room: action.session.switchRoomId, thread: action.session.threadId ?? null }
        : requesters.lastOrigin(action.agent.name);

    const said = drill
      ? drill.said
        ? [drill.said]
        : []
      : requesters.lastMessages(action.agent.name, origin?.room ?? null, origin?.thread ?? null, 2);
    const mismatches = detectMismatch({
      cls: clsName,
      extracted: evaluation.extracted,
      args: evaluation.call.args,
      target: evaluation.call.target,
      said: action.agentClaim ? [...said, action.agentClaim] : said,
      currency: policy.currency,
      services: Object.keys(this.team.owners.services),
    });

    const flags: Flag[] = uniqueFlags([...evaluation.flags, ...mismatches, ...(drill?.extra_flags ?? [])]);
    // L1 is the fast lane: one eligible approver, whatever the tier would otherwise ask for.
    const stated = evaluation.level === "L1" ? 1 : (cls?.approvers?.quorum[tier] ?? cls?.approvers?.quorum.default ?? 1);
    // Nobody can tell who asked, so whoever it was could be the one approving. Of two different people, only one can be.
    const unknownQuorum = Math.max(stated, policy.defaults.unknown_requester_quorum ?? UNKNOWN_REQUESTER_QUORUM);
    if (requesterIds.length === 0) flags.push(requesterUnknownFlag(unknownQuorum));
    // The same reasoning when someone is on record but the record may not be everyone.
    if (reach === "elsewhere") flags.push(agentElsewhereFlag(unknownQuorum));
    if (reach === "unknown") flags.push(agentReachUnknownFlag(unknownQuorum));
    const asked = reach === "all_seen" ? stated : unknownQuorum;

    // A name the policy excludes (a merge's author, say) that we cannot pin to a person: flag it, keep the hold.
    const authorIds: string[] = [];
    for (const field of cls?.approvers?.exclude ?? []) {
      const resolved = directory.resolveAuthor(evaluation.extracted[field]);
      authorIds.push(...resolved);
      if (resolved.length === 0) flags.push(authorUnknownFlag(field));
    }

    const window = evaluation.aggregates[0];
    const serviceOwner = this.team.owners.services[String(evaluation.extracted.service)];
    const description = describeCall({
      cls: clsName,
      call: evaluation.call,
      extracted: evaluation.extracted,
      lookups: evaluation.lookups,
      currency: policy.currency,
      agent: action.agent.name,
      priorSum: window ? window.prior : null,
      agentActivity: window ? aggregates.agentActivity(action.agent.name, clsName, now - window.windowMs) : null,
      serviceOwner: serviceOwner ? (directory.person(serviceOwner)?.name ?? serviceOwner) : null,
      ...(action.shell && action.shell.command !== evaluation.call.args.command ? { asWritten: action.shell.command } : {}),
    });

    const evidence: Evidence = {
      extracted: evaluation.extracted,
      lookups: evaluation.lookups,
      aggregates: evaluation.aggregates,
      fired: evaluation.fired,
      holdSummary: evaluation.holdSummary ?? `${evaluation.call.class} needs approval`,
      agentOwnerIds,
      authorIds,
      description,
    };
    if (evaluation.policySubject) evidence.policySubject = evaluation.policySubject;
    if (evaluation.bucket) evidence.bucket = evaluation.bucket;
    if (evaluation.level) evidence.level = evaluation.level;
    if (evaluation.autoEligible !== undefined) evidence.autoEligible = evaluation.autoEligible;
    // A room on a call is only the agent's word for it, so someone asking elsewhere still can't approve.
    const askedElsewhereIds = everyoneAsking.filter((id) => !requesterIds.includes(id));
    if (askedElsewhereIds.length > 0) evidence.askedElsewhereIds = askedElsewhereIds;
    const claim = action.agentClaim ?? said[0];
    if (claim) evidence.agentClaim = claim;

    return {
      actionId: action.id,
      source: action.source,
      vendor: action.vendor,
      agent: action.agent.name,
      callHash: evaluation.callHash,
      cls: clsName,
      target: evaluation.call.target,
      call: evaluation.call,
      tier,
      score: evaluation.score ?? 0,
      requesterIds,
      agentOwnerId: agentOwnerIds[0] ?? null,
      originRoom: origin?.room ?? null,
      originThread: origin?.thread ?? null,
      evidence: evidence as unknown as Record<string, unknown>,
      flags,
      quorumRequired: requesterIds.length === 0 ? unknownQuorum : asked,
      expiresAtMs: now + this.deps.clock.scaledMs(policy.requestTtlMs),
      ...(drill ? { isDrill: true } : {}),
    };
  }

  private holdReason(id: string, action: Action, evaluation: Evaluation): string {
    const summary = evaluation.holdSummary ?? `${evaluation.call.class} needs approval`;
    const next =
      action.source === "gate"
        ? "You will be told in this thread when it is decided."
        : `When you are told ${id} is approved, run the exact same command once.`;
    return `HELD ${id}: ${summary}. Do not try another way. ${next}`;
  }

  private responseFor(evaluation: Evaluation): CheckResponse {
    const response: CheckResponse = {
      decision: evaluation.decision,
      reason: evaluation.reason,
      call_hash: evaluation.callHash,
    };
    const shownClass =
      evaluation.cls ??
      ([UNKNOWN_PROTECTED_CLASS, MALFORMED_CLASS, UNPARSED_CLASS].includes(evaluation.call.class)
        ? evaluation.call.class
        : undefined);
    if (shownClass) response.class = shownClass;
    if (evaluation.tier) response.tier = evaluation.tier;
    if (evaluation.score !== undefined) response.score = evaluation.score;
    if (evaluation.flags.length > 0) response.flags = evaluation.flags;
    return response;
  }

  /** Fail closed: nothing runs, every card closes, and the people waiting are told. */
  private async expire(request: RequestRecord): Promise<void> {
    const { requests, ledger, aggregates, drills } = this.stores;
    if (request.isDrill) {
      const write = this.stores.db.transaction(() => {
        requests.transition(request.id, "EXPIRED");
        drills.setResult(request.id, "expired", null);
        ledger.append("drill_result", request.id, { result: "expired", user_id: drills.byRequest(request.id)?.user_id ?? null });
      });
      write.immediate();
      await this.closeOpenCards(request);
      return;
    }
    const write = this.stores.db.transaction(() => {
      requests.transition(request.id, "EXPIRED");
      ledger.append("expired", request.id, { after_ms: this.deps.clock.nowMs() - request.createdAtMs });
      aggregates.voidRequest(request.id);
    });
    write.immediate();
    await this.closeOpenCards(request);
    const minutes = formatPolicyMinutes(this.currentPolicy.requestTtlMs);
    const asker = this.requesterNames(request);
    const again = asker.length > 0 ? `${joinNames(asker)}, ask again` : "Ask again";
    const body = `${request.id} expired after ${minutes} with no eligible answer. Nothing was executed. ${again} if it's still needed.`;
    await this.tell(request, body, [request.agent, ...this.requesterUserNames(request)]);
  }

  // ── Drills ─────────────────────────────────────────────────────────────────

  private drillsPath(): string {
    const library = this.currentPolicy.file.drills?.library ?? "drills/flaws.yaml";
    return this.deps.drillsPath ?? resolve(dirname(this.deps.policyPath), "..", library);
  }

  private drillsEnabled(): boolean {
    if (!this.currentPolicy.file.drills?.enabled) return false;
    const row = this.stores.db.prepare(`SELECT value FROM meta WHERE key = 'drills_off'`).get() as { value: string } | undefined;
    return row?.value !== "1";
  }

  private async maybeRollDrill(request: RequestRecord): Promise<void> {
    const settings = this.currentPolicy.file.drills;
    if (this.deps.rollDrills === false || !settings || !this.classOf(request.cls)?.drills) return;
    if (!rollsDrill(request.id, this.currentPolicy.hash, this.deps.drillRate ?? settings.rate)) return;
    const approver = this.traces.latest(request.id)?.chosen[0];
    if (approver) await this.sendDrill(approver);
  }

  /** Sends one person a practice request. Everything that would stop it says why, in words. */
  async sendDrill(personId: string, flawId?: string): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }> {
    const { directory } = this.people;
    const { drills, incidents, routes } = this.stores;
    const now = this.deps.clock.nowMs();
    if (!directory.person(personId)) return { ok: false, reason: `no person ${personId}` };
    if (!this.drillsEnabled()) return { ok: false, reason: "drills are off for this team" };
    if (incidents.anyOpen(now)) return { ok: false, reason: "there is an open incident" };
    if (routes.openCount(personId) > MAX_OPEN_CARDS_FOR_A_DRILL) return { ok: false, reason: `${personId} has more than 3 open cards` };
    const limit = this.currentPolicy.file.drills?.max_per_person_per_day ?? 1;
    if (drills.sentSince(personId, now - DAY_MS) >= limit) return { ok: false, reason: `${personId} already had a drill today` };

    let library: Flaw[];
    try {
      library = loadFlaws(this.drillsPath());
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
    if (flawId && !library.some((flaw) => flaw.id === flawId)) return { ok: false, reason: `no flaw named ${flawId}` };
    // The flaw they have seen least, so it rotates. Ties go in library order, so it is the same every run.
    const seen = drills.forPerson(personId);
    const times = (flaw: Flaw) => seen.filter((row) => row.flaw_id === flaw.id).length;
    const candidates = (flawId ? library.filter((flaw) => flaw.id === flawId) : library)
      .map((flaw, index) => ({ flaw, index }))
      .sort((a, b) => times(a.flaw) - times(b.flaw) || a.index - b.index);

    for (const { flaw } of candidates) {
      const prepared = await this.prepareDrill(flaw, personId, now);
      if (prepared) return this.openDrill(prepared, flaw, personId, now);
    }
    return { ok: false, reason: flawId ? `${flawId} is not something ${personId} can approve` : `no flaw fits ${personId}` };
  }

  /** The request a flaw makes for this person, or null when they could not approve it. Writes nothing. */
  private async prepareDrill(flaw: Flaw, personId: string, now: number): Promise<NewRequest | null> {
    const askedBy = this.drillRequester(flaw, personId);
    if (!askedBy || !this.people.directory.isTeamAgent(flaw.agent)) return null;
    const action: Action = {
      id: `drill-${ulid(now)}`,
      at: new Date(now).toISOString(),
      source: "gate",
      vendor: "gate",
      agent: { name: flaw.agent },
      kind: "business",
      raw: { drill: true },
      business: { endpoint: flaw.endpoint, args: flaw.args },
    };
    const evaluation = await evaluateAction(action, {
      policy: this.currentPolicy,
      // Synthetic systems of record: a drill reads nothing real.
      lookup: { lookup: async (kind, id) => flaw.world[kind]?.[id] ?? null },
      clock: this.deps.clock,
      aggregates: this.stores.aggregates,
      autonomy: { levelFor: () => "L0" },
    });
    if (evaluation.decision !== "hold") return null;
    const input = this.newRequest(action, evaluation, now, { ...flaw, askedBy });
    const preview: RequestRecord = {
      ...input,
      id: "CLR-PREVIEW",
      state: "HELD",
      isDrill: true,
      createdAtMs: now,
      decidedAtMs: null,
      execAttempts: 0,
    };
    return assessAnswer(this.routeContext(preview), personId).eligible ? input : null;
  }

  /** Someone other than the person who gets it: the flaw's own choice, then the agent's owner, then anyone. */
  private drillRequester(flaw: Flaw, personId: string): string | null {
    const { directory } = this.people;
    const preferred = [flaw.asked_by, ...directory.agentOwners(flaw.agent), ...directory.all().map((person) => person.id)];
    return preferred.find((id): id is string => id !== undefined && id !== personId && directory.person(id) !== null) ?? null;
  }

  private async openDrill(
    input: NewRequest,
    flaw: Flaw,
    personId: string,
    now: number,
  ): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }> {
    const { requests, drills, ledger } = this.stores;
    const write = this.stores.db.transaction(() => {
      const created = requests.create(input);
      drills.add({ id: ulid(now), requestId: created.id, flawId: flaw.id, userId: personId, atMs: now });
      return created;
    });
    const request = write.immediate();
    const trace = route(this.routeContext(request), 1);
    const single: RouteTrace = { ...trace, chosen: [personId], fallback: null };
    this.opening.add(request.id);
    const opened = await this.dispatch(request, single, "primary", false).finally(() => this.opening.delete(request.id));
    if (opened === 0) {
      // Nobody will ever see it, and the tick must not route it to someone else.
      const undo = this.stores.db.transaction(() => {
        requests.transition(request.id, "CANCELLED");
        drills.setResult(request.id, "not_sent", null);
        ledger.append("drill_result", request.id, { result: "not_sent", user_id: personId });
      });
      undo.immediate();
      return { ok: false, reason: "the card could not be opened" };
    }
    this.traces.add(request.id, single);
    requests.transition(request.id, "ROUTED");
    return { ok: true, requestId: request.id };
  }

  /** Only ever to that person. */
  private async sendDrillFeedback(request: RequestRecord, person: Person, caught: boolean, latencyMs: number): Promise<void> {
    const flawId = this.stores.drills.byRequest(request.id)?.flaw_id;
    let flaw: Flaw | undefined;
    try {
      flaw = loadFlaws(this.drillsPath()).find((entry) => entry.id === flawId);
    } catch {
      // The library changed underneath a running drill. The note still has to go out, with less in it.
    }
    const seconds = (latencyMs / 1000).toFixed(1);
    const body = caught
      ? `Good catch. That was a practice request${flaw ? `; the flaw was ${flaw.caught}` : ""}.`
      : `That was a practice request; nothing ran.${flaw ? ` The flaw: ${flaw.explain}.` : ""} You decided in ${seconds} s. Your next high-risk card will ask you to type a detail.`;
    try {
      const { roomId } = await this.deps.chat.ensureDirectRoom({ userName: person.userName });
      await this.deps.chat.postMessage({ roomId, body });
    } catch {
      // The ledger has the result.
    }
  }

  // ── Escalation ─────────────────────────────────────────────────────────────

  private startLadder(request: RequestRecord): void {
    this.classOf(request.cls)?.escalate.forEach((step, index) => {
      this.stores.timers.add(request.id, index, step, request.createdAtMs + this.deps.clock.scaledMs(step.afterMs));
    });
  }

  /** A step that could not reach Switch stays due, and the next tick tries it again. */
  private async fireEscalation(timer: TimerRow): Promise<void> {
    const { requests, timers, ledger, db } = this.stores;
    const now = this.deps.clock.nowMs();
    const request = requests.get(timer.request_id);
    if (!request || !OPEN_STATES.includes(request.state)) {
      timers.markFired(timer.id, now);
      return;
    }
    const outcome = await this.runEscalationStep(request, timer);
    if (!outcome) return;
    const write = db.transaction(() => {
      timers.markFired(timer.id, now);
      ledger.append("escalated", request.id, { step: timer.step_index, after_ms: timer.step.afterMs, ...outcome });
    });
    write.immediate();
  }

  private runEscalationStep(request: RequestRecord, timer: TimerRow): Promise<Record<string, unknown> | null> {
    const { step } = timer;
    const waited = `${request.id} has waited ${formatPolicyMinutes(step.afterMs)}`;
    if (step.add) return this.escalateToBackup(request, waited);
    if (step.post) return this.escalateToRoom(request, waited, step.post, step.mention);
    return this.escalateToRequester(request, waited);
  }

  private async escalateToBackup(request: RequestRecord, waited: string): Promise<Record<string, unknown> | null> {
    const ctx = this.routeContext(request);
    const trace = route(ctx, 1);
    const id = trace.chosen[0];
    if (!id) return { kind: "add", added: null };
    const entry = trace.ranked.find((ranked) => ranked.id === id);
    const role = entry?.backup ? `the backup ${trace.label} approver` : `${article(trace.label)} ${trace.label} approver`;
    const body = (person: Person) => `${waited}. ${person.name}, you're ${role}. The card is just above.`;
    const opened = await this.dispatch(request, { ...trace, fallback: null }, "backup", false, body);
    if (opened === 0) return null;
    this.traces.add(request.id, trace);
    return { kind: "add", added: id };
  }

  private async escalateToRoom(
    request: RequestRecord,
    waited: string,
    roomName: string,
    mention: string | undefined,
  ): Promise<Record<string, unknown> | null> {
    const { directory } = this.people;
    const roomId = directory.roomId(roomName);
    const trace = this.traces.latest(request.id);
    const hasCard = this.stores.routes.openForRequest(request.id).some((row) => row.card_room === roomId);
    if (!hasCard && trace) {
      const place = await this.tryOpen(request, trace, { kind: "room" }, async () => ({ roomId }), "group", null, []);
      if (!place) return null;
    }
    const eligible = route(this.routeContext(request), 0).ranked.map((entry) => entry.id);
    const targets = eligible.flatMap((id) => directory.person(id)?.userName ?? []);
    const body = mention ? `${waited}. ${mention}: the card is just above.` : `${waited}. The card is just above.`;
    await this.tell({ ...request, originRoom: roomId, originThread: null }, body, targets);
    return { kind: "post", room: roomName, mention: mention ?? null, told: eligible };
  }

  private async escalateToRequester(request: RequestRecord, waited: string): Promise<Record<string, unknown> | null> {
    const asker = this.requesterNames(request);
    const expires = formatClockWithZone(request.expiresAtMs, this.currentPolicy.defaults.business_hours.tz);
    const nudge = asker.length > 0 ? `${joinNames(asker)}, it expires at ${expires}` : `It expires at ${expires}`;
    await this.tell(request, `${waited} with no decision. ${nudge}.`, this.requesterUserNames(request));
    return { kind: "notify", notified: request.requesterIds };
  }

  // ── Answers ────────────────────────────────────────────────────────────────

  /** Runs inside one transaction. Everything that decides is here; nothing here talks to the outside. */
  private judgeAnswer(request: RequestRecord, card: RouteRow, evt: ApprovalOutcomeEvent): Verdict {
    const { requests, ledger, answers, aggregates, grants } = this.stores;
    const { directory } = this.people;
    const now = this.deps.clock.nowMs();
    const answeredBy = evt.answeredBy ?? null;
    const current = requests.require(request.id);
    const person = directory.personFromAnswer(answeredBy);
    const typedField = card.confirm_field as ConfirmField | null;
    const reading = evt.kind === "questions" && typedField ? readQuestionAnswer(evt.answers, typedField) : null;
    const decision: AnswerDecision | null = reading
      ? reading.kind === "deny"
        ? "deny"
        : reading.kind === "typed"
          ? "approve"
          : null
      : normaliseAnswer(evt.answer);
    const record = (eligible: boolean, reason: string | null, stamp?: StampReading) =>
      answers.record({
        requestId: current.id,
        switchRequestId: evt.switchRequestId,
        answeredBy,
        userId: person?.id ?? null,
        decision,
        latencyMs: now - card.notified_at,
        eligible,
        reason,
        atMs: now,
        ...(stamp ? { fast: stamp.fast, signals: stamp.signals, tMinMs: stamp.tMin } : {}),
      });
    const refuse = (reasons: string[]) => {
      record(false, reasons.join(","));
      ledger.append("ineligible_answer", current.id, {
        answered_by: answeredBy,
        user_id: person?.id ?? null,
        answer: evt.answer ?? null,
        reasons,
        card_room: card.card_room,
      });
    };

    if (!OPEN_STATES.includes(current.state)) {
      refuse(["request_closed"]);
      return { kind: "closed", state: current.state };
    }
    if (!person) {
      const agent = answeredBy ? directory.agentForSender(answeredBy) : null;
      refuse([agent ? "agent" : "unknown_participant"]);
      return { kind: "refused", subject: agent ? { type: "agent", name: agent } : { type: "unknown", answeredBy } };
    }
    if (!decision) {
      refuse(["unrecognised_answer"]);
      return { kind: "unrecognised" };
    }
    const assessment = assessAnswer(this.routeContext(current), person.id);
    if (!assessment.eligible) {
      refuse(assessment.reasons);
      return { kind: "refused", subject: { type: "person", person, reasons: assessment.reasons } };
    }

    // Who may answer comes first; only then does it matter what they typed.
    if (decision === "approve") {
      if (reading?.kind === "typed" && typedField) {
        if (!typedMatches(typedField, reading.text, this.evidenceOf(current).extracted, current.id)) {
          refuse(["wrong_confirmation"]);
          const tries = answers.wrongConfirmations(current.id, person.id);
          return tries >= CONFIRM_TRIES ? { kind: "failed_confirm", person } : { kind: "retype", person };
        }
      } else if (this.needsTyped(current, person.id)) {
        refuse(["needs_typed_confirmation"]);
        return { kind: "needs_typed", person };
      }
    }

    if (current.isDrill) {
      const caught = decision === "deny";
      record(true, null);
      const latencyMs = now - card.notified_at;
      if (current.state === "HELD") requests.transition(current.id, "ROUTED");
      requests.transition(current.id, caught ? "DENIED" : "APPROVED");
      // Approved or not, nothing ran: an approved drill goes straight to void and never near the gate.
      if (!caught) requests.transition(current.id, "VOIDED");
      const drill = this.stores.drills.byRequest(current.id);
      this.stores.drills.setResult(current.id, caught ? "caught" : "missed", latencyMs);
      ledger.append("drill_result", current.id, {
        result: caught ? "caught" : "missed",
        user_id: person.id,
        flaw: drill?.flaw_id ?? null,
        latency_ms: latencyMs,
      });
      if (!caught) this.people.store.setFriction(person.id, "drill_miss");
      return { kind: "drill", person, caught, latencyMs };
    }

    const stamp = this.readStamp(current, person.id, decision, now - card.notified_at, now);
    record(true, null, stamp);
    ledger.append("answered", current.id, {
      answered_by: answeredBy,
      user_id: person.id,
      decision,
      latency_ms: now - card.notified_at,
      card_room: card.card_room,
      fast_approval: stamp.fast,
      signals: stamp.signals,
      t_min_ms: stamp.tMin,
      ...(stamp.flagsIgnored.length > 0 ? { flags_ignored: stamp.flagsIgnored } : {}),
      ...(reading?.kind === "typed" && typedField ? { typed_field: typedField } : {}),
    });
    // Still a valid answer. The response is more friction next time and no credit towards autonomy.
    const signal = stamp.signals[0];
    if (signal) this.people.store.setFriction(person.id, signal);
    if (current.state === "HELD") requests.transition(current.id, "ROUTED");

    if (decision === "deny") {
      requests.transition(current.id, "DENIED");
      ledger.append("denied", current.id, { denied_by: person.id, call_hash: current.callHash });
      aggregates.voidRequest(current.id);
      this.recordBucketEvent(current, "denied", [person.id], false);
      const demotion = this.demote(current, `${person.name} denied ${current.id}`, { reason: "denial", by: person.id });
      return { kind: "denied", person, demotion };
    }

    const counted = answers.countedApprovers(current.id);
    if (counted.length < current.quorumRequired) return { kind: "counted", person };

    requests.transition(current.id, "APPROVED");
    ledger.append("approved", current.id, {
      approved_by: counted,
      quorum: current.quorumRequired,
      call_hash: current.callHash,
    });
    this.recordBucketEvent(current, "approved", counted, answers.anyFast(current.id));
    if (current.source === "hook") {
      const ttl = this.deps.clock.scaledMs(this.currentPolicy.grantTtlMs);
      grants.mint(current.id, current.callHash, current.agent, ttl);
      requests.transition(current.id, "GRANTED");
    }
    return { kind: "approved", people: counted };
  }

  private async actOnVerdict(requestId: string, card: RouteRow, verdict: Verdict): Promise<void> {
    const request = this.stores.requests.require(requestId);
    // A drill stays between Clearance and the person it was sent to.
    if (request.isDrill && (verdict.kind === "closed" || verdict.kind === "refused")) return;
    switch (verdict.kind) {
      case "drill":
        await this.closeOpenCards(request);
        await this.sendDrillFeedback(request, verdict.person, verdict.caught, verdict.latencyMs);
        return;
      case "closed":
        await this.say(request, `${request.id} is already decided (${verdict.state}). That answer changed nothing.`, card.card_room);
        return;
      case "unrecognised":
        await this.keepCovered(request);
        return;
      case "refused":
        await this.keepCovered(request);
        await this.say(request, this.refusalText(request, verdict.subject));
        return;
      case "counted":
        await this.keepCovered(request);
        return;
      case "retype":
        await this.askToType(request, verdict.person, `That didn't match. ${request.id} asks once more; the card is just above.`);
        return;
      case "needs_typed":
        await this.askToType(request, verdict.person);
        return;
      case "failed_confirm":
        await this.keepCovered(request);
        await this.deps.chat
          .postMessage({ roomId: card.card_room, body: `That didn't match either, so your answer on ${request.id} doesn't count.` })
          .catch(() => undefined);
        return;
      case "denied":
        await this.closeOpenCards(request);
        await this.tellOriginCopy(request, `${request.id} denied by ${verdict.person.name}.`);
        await this.notifyDenied(request, verdict.person);
        if (verdict.demotion) await this.announce(verdict.demotion);
        return;
      case "approved":
        await this.closeOpenCards(request);
        await this.tellOriginCopy(request, `${request.id} approved by ${this.approverNames(verdict.people)}.`);
        if (request.source === "hook") {
          const names = this.approverNames(verdict.people);
          await this.notifyAgent(request, `${request.id} approved by ${names}. Run the exact same command once.`);
        } else {
          await this.executeApproved(request);
        }
        await this.proposePromotions();
        return;
    }
  }

  /** What this answer looks like against the person's record. A denial is never a rubber stamp. */
  private readStamp(request: RequestRecord, userId: string, decision: AnswerDecision, latencyMs: number, now: number): StampReading {
    const config = stampConfig(this.currentPolicy.file.rubber_stamp);
    const lines = evidenceLines(this.evidenceOf(request).description, request.flags);
    const tMin = tMinMs(lines, request.tier, config);
    if (decision !== "approve") return { fast: false, signals: [], tMin, flagsIgnored: [] };
    const { answers } = this.stores;
    const current = { decision, latencyMs, tMinMs: tMin, atMs: now };
    const signals: string[] = [];
    if (latencyMs < tMin) signals.push("fast");
    if (isStreak([current, ...answers.recentDecisions(userId, config.streakApprovals)], config)) signals.push("streak");
    const within = now - config.batchWithinS * 1000;
    if (isBatch([now, ...answers.approvalTimes(userId, within)], now, config)) signals.push("batch");
    // Timing is what makes it a fast approval. Ignoring a flag may be a considered call, so it only adds friction.
    const fast = signals.length > 0;
    const flagsIgnored = ignoredFlags(request.flags);
    if (flagsIgnored.length > 0) signals.push("flag_ignored");
    return { fast, signals, tMin, flagsIgnored };
  }

  /** A typed card for this one person, with whatever note goes with it. */
  private async askToType(request: RequestRecord, person: Person, note?: string): Promise<void> {
    const trace = this.traces.latest(request.id) ?? route(this.routeContext(request), 0);
    const single = { ...trace, chosen: [person.id], fallback: null };
    const opened = await this.dispatch(request, single, "reroute", true, note ? () => note : undefined);
    if (opened > 0 && !request.isDrill) {
      this.stores.ledger.append("routed", request.id, single as unknown as Record<string, unknown>);
    }
  }

  /** Whether this person has to type a value to approve this request. */
  private needsTyped(request: RequestRecord, personId: string): boolean {
    if (this.evidenceOf(request).level === "L1") return false;
    if (request.tier === "critical") return true;
    if (this.stores.routes.askedToType(request.id, personId)) return true;
    return request.tier === "high" && this.people.store.friction(personId) !== null;
  }

  /** The field a card asks for, or null for a plain card. Rotates per person, or per request for a room's card. */
  private typedFieldFor(request: RequestRecord, audience: Audience): ConfirmField | null {
    const fields = confirmFieldsFor(this.evidenceOf(request).extracted);
    const { routes } = this.stores;
    if (audience.kind === "person") {
      if (!this.needsTyped(request, audience.id)) return null;
      return fields[routes.confirmCount(audience.id) % fields.length] as ConfirmField;
    }
    if (request.tier !== "critical" || this.evidenceOf(request).level === "L1") return null;
    return fields[routes.roomConfirmCount(request.id) % fields.length] as ConfirmField;
  }

  private refusalText(request: RequestRecord, subject: Refused): string {
    let head: string;
    if (subject.type === "person") {
      const label = this.traces.latest(request.id)?.label ?? "approver";
      head = `${subject.person.name} can't approve ${request.id} (${exclusionWords(subject.reasons, label)}).`;
    } else if (subject.type === "agent") {
      head = `${subject.name} can't approve ${request.id} (agents can't approve).`;
    } else {
      head = `That account can't approve ${request.id} (not linked to anyone on the team).`;
    }
    return `${head} ${this.sentToSentence(request)}`;
  }

  /** Who holds it now, from the open cards and the latest trace. */
  private sentToSentence(request: RequestRecord): string {
    const open = this.stores.routes.openForRequest(request.id);
    const trace = this.traces.latest(request.id);
    const labels = open
      .filter((row) => row.user_id)
      .map((row) => {
        const entry = trace?.ranked.find((ranked) => ranked.id === row.user_id);
        return entry ? routeLabel(entry) : (this.people.directory.person(row.user_id as string)?.name ?? (row.user_id as string));
      });
    if (labels.length > 0) return `Sent to ${joinNames(labels)}.`;
    if (trace?.fallback && open.some((row) => row.step === "fallback")) {
      return `Sent to ${trace.fallback.group} in ${trace.fallback.room}.`;
    }
    const tz = this.currentPolicy.defaults.business_hours.tz;
    return `Nobody else can take it; it expires at ${formatClockWithZone(request.expiresAtMs, tz)}.`;
  }

  private approverNames(ids: string[]): string {
    return joinNames(ids.map((id) => this.people.directory.person(id)?.name ?? id));
  }

  private requesterNames(request: RequestRecord): string[] {
    return request.requesterIds.flatMap((id) => this.people.directory.person(id)?.name ?? []);
  }

  private requesterUserNames(request: RequestRecord): string[] {
    return request.requesterIds.flatMap((id) => this.people.directory.person(id)?.userName ?? []);
  }

  /** "Tell Priya and stop." */
  private requesterWords(request: RequestRecord): string {
    const names = this.requesterNames(request);
    return names.length > 0 ? joinNames(names) : "the person who asked";
  }

  private async notifyDenied(request: RequestRecord, person: Person): Promise<void> {
    // Only what happened. Switch has no reason field, so anything more would be credited to someone who never said it.
    await this.notifyAgent(request, `${request.id} denied by ${person.name}. Tell ${this.requesterWords(request)} and stop.`);
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  private async executeApproved(request: RequestRecord): Promise<void> {
    if (this.executing.has(request.id)) return;
    this.executing.add(request.id);
    this.lastExecuteAttempt.set(request.id, this.deps.clock.nowMs());
    this.stores.requests.noteExecutionAttempt(request.id);
    let result: ExecuteResult;
    try {
      result = await this.deps.gate.execute(request.id, request.callHash);
    } catch (error) {
      // The gate is exactly-once by request id, so trying again is safe. The tick does that.
      this.lastExecuteError.set(request.id, (error as Error).message);
      return;
    } finally {
      this.executing.delete(request.id);
    }
    await this.finishExecution(request, result);
  }

  private readonly lastExecuteError = new Map<string, string>();

  private async finishExecution(request: RequestRecord, result: ExecuteResult): Promise<void> {
    const { requests, ledger, answers } = this.stores;
    const write = this.stores.db.transaction(() => {
      requests.transition(request.id, result.ok ? "EXECUTED" : "VOIDED");
      ledger.append("executed", request.id, {
        ok: result.ok,
        already_executed: result.alreadyExecuted,
        status: result.status ?? null,
        result: result.result ?? null,
        error: result.error ?? null,
      });
    });
    write.immediate();
    this.lastExecuteAttempt.delete(request.id);
    this.lastExecuteError.delete(request.id);
    const counted = answers.countedApprovers(request.id);
    const names = counted.length > 0 ? this.approverNames(counted) : `break-glass by ${this.breakGlassBy(request.id) ?? "someone"}`;
    if (result.ok) {
      const evidence = this.evidenceOf(request);
      const what = describeResult(request.cls, evidence.extracted, request.target, result.result, this.currentPolicy.currency);
      await this.notifyAgent(request, `${request.id} approved by ${names} and executed: ${what}. Continue.`);
    } else {
      const why = result.error ?? `the gate answered ${result.status ?? "with an error"}`;
      await this.notifyAgent(request, `${request.id} approved by ${names} but it did not run: ${why}. Tell ${this.requesterWords(request)} and stop.`);
    }
  }

  private breakGlassBy(requestId: string): string | null {
    const entry = this.stores.ledger.list({ requestId }).find((row) => row.type === "break_glass");
    if (!entry) return null;
    const id = String(entry.payload.by);
    return this.people.directory.person(id)?.name ?? id;
  }

  /** An approved gate call whose execute did not get an answer. Hook calls are never left in APPROVED. */
  private async retryExecution(request: RequestRecord): Promise<void> {
    if (request.source !== "gate") return;
    const now = this.deps.clock.nowMs();
    if (now - (request.decidedAtMs ?? now) > EXECUTE_GIVE_UP_AFTER_MS) {
      const error = this.lastExecuteError.get(request.id) ?? "the gate did not answer";
      await this.finishExecution(request, { ok: false, alreadyExecuted: false, error });
      return;
    }
    const last = this.lastExecuteAttempt.get(request.id) ?? 0;
    if (now - last >= EXECUTE_RETRY_EVERY_MS) await this.executeApproved(request);
  }

  // ── Routing and cards ──────────────────────────────────────────────────────

  private evidenceOf(request: RequestRecord): Evidence {
    return request.evidence as unknown as Evidence;
  }

  /** Everything the router needs to know right now about a request. Used to route and to re-check answers. */
  private routeContext(request: RequestRecord): RouteContext {
    const { directory, store } = this.people;
    const { routes, answers } = this.stores;
    const evidence = this.evidenceOf(request);
    const open = routes.openForRequest(request.id);
    const config = stampConfig(this.currentPolicy.file.rubber_stamp);
    const todaysAnswerers = answers.answerers(request.cls, this.deps.clock.nowMs() - DAY_MS);
    return {
      requestId: request.id,
      policy: this.currentPolicy,
      directory,
      team: this.team,
      cls: this.classOf(request.cls),
      className: request.cls,
      tier: request.tier,
      quorumRequired: request.quorumRequired,
      requesterIds: [...request.requesterIds, ...(evidence.askedElsewhereIds ?? [])],
      agentOwnerIds: evidence.agentOwnerIds,
      authorIds: evidence.authorIds,
      extracted: evidence.extracted,
      originRoom: request.originRoom,
      nowMs: this.deps.clock.nowMs(),
      signals: {
        openCards: (userId) => routes.openCount(userId),
        lastActive: (userId) => store.lastActive(userId),
        lastActiveIn: (userId, room) => store.lastActiveIn(userId, room),
        away: (userId) => store.away(userId),
        concentrated: (userId) => isConcentrated(todaysAnswerers, userId, config),
      },
      counted: answers.countedApprovers(request.id),
      failedConfirm: answers.failedConfirmations(request.id, CONFIRM_TRIES),
      alreadyRouted: open.flatMap((row) => (row.user_id ? [row.user_id] : [])),
      fallbackActive: routes.forRequest(request.id).some((row) => row.step === "fallback"),
    };
  }

  /** How many more people need a live card for this request to be decidable. */
  private coverageNeed(request: RequestRecord, ctx: RouteContext): number {
    const live = new Set(ctx.alreadyRouted.filter((id) => assessAnswer(ctx, id).eligible));
    return request.quorumRequired - ctx.counted.length - live.size;
  }

  /** After an answer used up a card or disqualified someone: open whatever is now missing. */
  private async keepCovered(request: RequestRecord): Promise<void> {
    if (!OPEN_STATES.includes(request.state) || request.isDrill) return;
    await this.routeAndOpen(request, "reroute");
  }

  private async routeAndOpen(request: RequestRecord, step: RouteStep): Promise<void> {
    const ctx = this.routeContext(request);
    const need = this.coverageNeed(request, ctx);
    if (need <= 0) return;
    const trace = route(ctx, need);
    const openFallback = this.stores.routes.openForRequest(request.id).some((row) => row.step === "fallback");
    if (trace.chosen.length === 0 && (!trace.fallback || openFallback)) return; // Nothing new to open.

    const opened = await this.dispatch(request, trace, step, openFallback);
    if (opened === 0) return; // Switch is unreachable: the tick tries again and nothing has been claimed.

    const { requests, ledger } = this.stores;
    const write = this.stores.db.transaction(() => {
      this.traces.add(request.id, trace);
      ledger.append("routed", request.id, trace as unknown as Record<string, unknown>);
      if (requests.require(request.id).state === "HELD") requests.transition(request.id, "ROUTED");
    });
    write.immediate();
    if (trace.fallback && !openFallback) {
      const fallback = trace.fallback;
      await this.say(request, `Nobody eligible for ${request.id}: ${fallback.reason}. Posted to ${fallback.room} for ${fallback.group}.`);
    }
  }

  private async dispatch(
    request: RequestRecord,
    trace: RouteTrace,
    step: RouteStep,
    openFallback: boolean,
    personBody?: (person: Person) => string,
  ): Promise<number> {
    const { directory } = this.people;
    const { routes } = this.stores;
    const headline = this.evidenceOf(request).description.headline;
    const userNames = (ids: string[]) => ids.flatMap((id) => directory.person(id)?.userName ?? []);
    let opened = 0;
    for (const id of trace.chosen) {
      const person = directory.person(id);
      if (!person) continue;
      const place = await this.tryOpen(request, trace, { kind: "person", id }, async () => {
        const { roomId } = await this.deps.chat.ensureDirectRoom({ userName: person.userName });
        return { roomId };
      }, step, id, [id]);
      if (!place) continue;
      opened += 1;
      const body = personBody?.(person) ?? `${request.id} needs your decision: ${headline}. The card is just above.`;
      // A card that names them has told them. personBody says something the card doesn't, like why they were brought in.
      if (personBody || !(this.deps.runningInbox || place.named)) await this.notifyCard(place, [person.userName], body);
    }
    const fallbackRoom = trace.fallback ? directory.roomId(trace.fallback.room) : null;
    const fallbackNames = userNames(trace.fallback?.eligible ?? []);
    if (trace.fallback && fallbackRoom && !openFallback) {
      const { group } = trace.fallback;
      // A group is being asked, so the note stays whoever the card names.
      const place = await this.tryOpen(request, trace, { kind: "fallback" }, async () => ({ roomId: fallbackRoom }), "fallback", null, trace.fallback.eligible);
      if (place) {
        opened += 1;
        await this.notifyCard(place, fallbackNames, `${request.id} needs a decision from ${group}: ${headline}. The card is just above.`);
      }
    }
    const hasCopy = routes.forRequest(request.id).some((row) => row.step === "origin_copy");
    // A drill is private to the person it was sent to: a copy would show a room a request that vanishes.
    if (opened > 0 && !request.isDrill && request.originRoom && !hasCopy && request.originRoom !== fallbackRoom) {
      const originRoom = request.originRoom;
      const threadId = request.originThread ?? undefined;
      const place = await this.tryOpen(request, trace, { kind: "room" }, async () => ({ roomId: originRoom, threadId }), "origin_copy", null, [...request.requesterIds, ...trace.chosen]);
      const targets = trace.chosen.length > 0 ? userNames(trace.chosen) : fallbackNames;
      if (place && !place.named) await this.notifyCard(place, targets, `${request.id} is waiting for a decision: ${headline}. The card is just above.`);
    }
    return opened;
  }

  /**
   * Opens a card that names the first of these people who has written in the room: Switch names the sender of the message
   * it's given, which is what notifies them, and without one the card says it notified nobody. If Switch won't take the
   * mention, the card opens without it, because nobody should lose a card over a line at the top.
   */
  private async openNaming(input: OpenCardInput, people: string[]): Promise<{ result: OpenCardResult; named: boolean }> {
    const { store } = this.people;
    const message = people.map((id) => store.lastMessageIn(id, input.roomId)).find((id) => id !== null);
    if (message) {
      try {
        return { result: await this.deps.chat.openCard({ ...input, mentionMessageId: message }), named: true };
      } catch {
        // Tried again below, as a plain card.
      }
    }
    return { result: await this.deps.chat.openCard(input), named: false };
  }

  /** Whoever must decide and isn't named on the card is told by name. Targets are names Switch knows, not ids. */
  private async notifyCard(place: CardPlace, targets: string[], body: string): Promise<void> {
    if (targets.length === 0) return;
    try {
      await this.deps.chat.sendTargeted({
        roomId: place.roomId,
        ...(place.threadId ? { threadId: place.threadId } : {}),
        body,
        targets,
      });
    } catch {
      // The card is open and answerable; the notification is the courtesy.
    }
  }

  private async tryOpen(
    request: RequestRecord,
    trace: RouteTrace,
    audience: Audience,
    where: () => Promise<CardPlace>,
    step: RouteStep,
    userId: string | null,
    nameOneOf: string[],
  ): Promise<CardPlace | null> {
    const evidence = this.evidenceOf(request);
    const view = buildCardView({
      request,
      evidence,
      trace,
      audience,
      directory: this.people.directory,
      reversible: this.classOf(request.cls)?.reversible,
      tz: this.currentPolicy.defaults.business_hours.tz,
    });
    const { title, detail } = renderCard(view);
    const typedField = this.typedFieldFor(request, audience);
    const ask = typedField ? askText(typedField, request.id, request.cls, this.currentPolicy.currency) : null;
    const form =
      typedField && ask
        ? {
            kind: "questions" as const,
            detail: "",
            options: [],
            questions: [
              {
                id: typedField,
                title: "Confirm",
                prompt: renderPrompt(view, ask),
                options: [{ id: DENY_OPTION_ID, label: "No, deny" }],
                multiSelect: false,
                allowCustomAnswer: true,
              },
            ],
          }
        : { kind: "approval" as const, detail, options: CARD_OPTIONS, questions: [] };
    try {
      const { roomId, threadId } = await where();
      const { result, named } = await this.openNaming(
        {
          roomId,
          ...(threadId ? { threadId } : {}),
          title,
          ...form,
          expiresAtMs: request.expiresAtMs,
        },
        nameOneOf,
      );
      this.stores.routes.add({
        requestId: request.id,
        userId,
        step,
        cardRoom: roomId,
        sessionId: result.sessionId,
        switchRequestId: result.switchRequestId,
        handle: result.handle,
        confirmField: typedField ?? undefined,
      });
      if (typedField && userId) this.people.store.clearFriction(userId);
      return { roomId, threadId, named };
    } catch {
      return null;
    }
  }

  /**
   * Switch can only close the room's copy of a card as "Cancelled before it was answered", even when someone answered in
   * their direct room. So the room is told what really happened, in the thread the copy was in. No timing in it.
   */
  private async tellOriginCopy(request: RequestRecord, body: string): Promise<void> {
    const copy = this.stores.routes.forRequest(request.id).find((row) => row.step === "origin_copy");
    if (!copy) return;
    const threadId = request.originThread ?? undefined;
    await this.deps.chat.postMessage({ roomId: copy.card_room, ...(threadId ? { threadId } : {}), body }).catch(() => undefined);
  }

  private async closeOpenCards(request: RequestRecord): Promise<void> {
    const { routes } = this.stores;
    for (const row of routes.openForRequest(request.id)) {
      routes.close(row.id);
      try {
        await this.deps.chat.closeCard(row.session_id, row.switch_request_id);
      } catch {
        // A card we can't close is harmless: any late answer to it is refused.
      }
    }
  }

  // ── Talking ────────────────────────────────────────────────────────────────

  /** The room to tell people in: the origin when known, else the fallback room. */
  private addressFor(request: RequestRecord): { roomId: string; threadId?: string } {
    if (request.originRoom) {
      return { roomId: request.originRoom, ...(request.originThread ? { threadId: request.originThread } : {}) };
    }
    const fallback = this.classOf(request.cls)?.approvers?.fallback ?? this.currentPolicy.defaults.fallback;
    return { roomId: this.people.directory.roomId(fallback.room) };
  }

  private async say(request: RequestRecord, body: string, overrideRoom?: string): Promise<void> {
    const address = request.originRoom || !overrideRoom ? this.addressFor(request) : { roomId: overrideRoom };
    try {
      await this.deps.chat.postMessage({ ...address, body });
    } catch {
      // Messages are courtesy; the ledger already has the fact.
    }
  }

  /** Addressed to these names when there are any, otherwise to the room. */
  private async tell(request: RequestRecord, body: string, targets: string[]): Promise<void> {
    const address = this.addressFor(request);
    try {
      if (targets.length > 0) await this.deps.chat.sendTargeted({ ...address, body, targets });
      else await this.deps.chat.postMessage({ ...address, body });
    } catch {
      // The ledger already has the fact.
    }
  }

  /** Switch prepends @name for each target, so the body starts at the request id. */
  private async notifyAgent(request: RequestRecord, body: string): Promise<void> {
    try {
      await this.deps.chat.sendTargeted({ ...this.addressFor(request), body, targets: [request.agent] });
    } catch {
      // The agent can still poll; a hook grant still works on retry.
    }
  }

  // ── Earned autonomy (F11) ──────────────────────────────────────────────────

  private bucketLabel(cls: CompiledClass, bucket: string): string {
    return cls.autonomy?.buckets.find((candidate) => candidate.name === bucket)?.label ?? `${cls.summary} (${bucket})`;
  }

  private approvalsRoom(): string {
    return this.people.directory.roomId(this.currentPolicy.defaults.fallback.room);
  }

  private async announce(body: string): Promise<void> {
    try {
      await this.deps.chat.postMessage({ roomId: this.approvalsRoom(), body });
    } catch {
      // The ledger already has the fact.
    }
  }

  /** Inside the transaction that decided it. Drills are nobody's record. */
  private recordBucketEvent(request: RequestRecord, outcome: EventOutcome, approvers: string[], fast: boolean): void {
    if (request.isDrill || !this.classOf(request.cls)?.autonomy) return;
    const evidence = this.evidenceOf(request);
    this.stores.events.add({
      agent: request.agent,
      cls: request.cls,
      bucket: evidence.bucket ?? null,
      requestId: request.id,
      atMs: this.deps.clock.nowMs(),
      fields: evidence.extracted,
      outcome,
      approvers,
      fast,
      edited: false,
      incident: false,
      autoEligible: evidence.autoEligible ?? false,
      synthetic: false,
    });
  }

  /** L2 and L3: nobody is asked first, and everything is on the record. Core runs nothing: the allow does. */
  private async runOnItsOwn(action: Action, evaluation: Evaluation): Promise<CheckResponse> {
    const { requests } = this.stores;
    const now = this.deps.clock.nowMs();
    const level = evaluation.level as Level;
    const earlier = this.stores.db.prepare(`SELECT request_id FROM actions WHERE id = ? AND step = 'autonomy'`).get(action.id) as { request_id: string | null } | undefined;
    if (earlier?.request_id) return { ...this.responseFor(evaluation), request_id: earlier.request_id };
    const write = this.stores.db.transaction(() => {
      const created = requests.create({
        ...this.newRequest(action, evaluation, now),
        auto: { level, bucket: evaluation.bucket as string },
        expiresAtMs: now + this.deps.clock.scaledMs(REVIEW_WINDOW_MS),
      });
      this.recordAction(action, evaluation, created.id);
      this.recordAggregates(action, evaluation, created.id);
      this.recordBucketEvent(created, "auto", [], false);
      return created;
    });
    const request = write.immediate();
    if (level === "L2") await this.openReview(request);
    return { ...this.responseFor(evaluation), request_id: request.id };
  }

  private async openReview(request: RequestRecord): Promise<void> {
    const { directory } = this.people;
    const { routes, ledger } = this.stores;
    const ctx = this.routeContext(request);
    const trace = route(ctx, 1);
    const personId = trace.chosen[0];
    const person = personId ? directory.person(personId) : null;
    const fallbackRoom = !person && trace.fallback ? directory.roomId(trace.fallback.room) : null;
    if (!person && !fallbackRoom) return; // Nobody yet. The tick asks again until the window closes.
    const evidence = this.evidenceOf(request);
    const level = evidence.level ?? "L2";
    const cls = this.classOf(request.cls);
    const label = cls && evidence.bucket ? this.bucketLabel(cls, evidence.bucket) : request.cls;
    const view = {
      ...buildCardView({
        request,
        evidence,
        trace,
        audience: person ? ({ kind: "person", id: person.id } as const) : ({ kind: "fallback" } as const),
        directory,
        reversible: cls?.reversible,
        tz: this.currentPolicy.defaults.business_hours.tz,
      }),
      policyLine: `${request.agent} is at ${level} for ${label}`,
    };
    const note = `${request.agent} ran this on its own at ${level}. Review it: Keep it, Demote the agent to 'always ask', or Reverse, which demotes, reports an incident and asks for it to be undone by hand.`;
    const { title, detail } = renderReviewCard(view, level, note);
    try {
      const roomId = person ? (await this.deps.chat.ensureDirectRoom({ userName: person.userName })).roomId : (fallbackRoom as string);
      const { result, named } = await this.openNaming(
        { roomId, kind: "approval", title, detail, options: REVIEW_OPTIONS, questions: [], expiresAtMs: request.expiresAtMs },
        person ? [person.id] : (trace.fallback?.eligible ?? []),
      );
      routes.add({
        requestId: request.id,
        userId: person?.id ?? null,
        step: "review",
        cardRoom: roomId,
        sessionId: result.sessionId,
        switchRequestId: result.switchRequestId,
        handle: result.handle,
      });
      const write = this.stores.db.transaction(() => {
        this.traces.add(request.id, trace);
        ledger.append("routed", request.id, { ...(trace as unknown as Record<string, unknown>), review: true });
      });
      write.immediate();
      const targets = person ? [person.userName] : (trace.fallback?.eligible ?? []).flatMap((id) => directory.person(id)?.userName ?? []);
      if (!named || !person) await this.notifyCard({ roomId }, targets, `${request.id} ran on its own and is up for review: ${evidence.description.headline}. The card is just above.`);
    } catch {
      // It already ran. The tick opens the review as soon as Switch answers.
    }
  }

  private async answerReview(card: RouteRow, evt: ApprovalOutcomeEvent): Promise<void> {
    const { requests } = this.stores;
    const request = requests.require(card.request_id);
    const judge = this.stores.db.transaction(() => this.judgeReview(request, card, evt));
    const verdict = judge.immediate();
    switch (verdict.kind) {
      case "kept":
        return;
      case "closed":
        await this.say(request, `The review of ${request.id} has closed. That answer changed nothing.`, card.card_room);
        return;
      case "unrecognised":
        await this.openReview(request);
        return;
      case "refused":
        await this.openReview(request);
        await this.say(request, this.refusalText(request, verdict.subject));
        return;
      case "demote":
      case "reverse":
        await this.closeOpenCards(request);
        if (verdict.demotion) await this.announce(verdict.demotion);
        if (verdict.kind === "reverse") {
          const headline = this.evidenceOf(request).description.headline;
          await this.announce(`${request.id} has no automatic undo. ${verdict.person.name} asked for it to be reversed, so someone needs to undo it by hand: ${headline}.`);
        }
        return;
    }
  }

  private judgeReview(request: RequestRecord, card: RouteRow, evt: ApprovalOutcomeEvent): ReviewVerdict {
    const { answers, ledger, events, incidents } = this.stores;
    const { directory } = this.people;
    const now = this.deps.clock.nowMs();
    const answeredBy = evt.answeredBy ?? null;
    const person = directory.personFromAnswer(answeredBy);
    const choice = evt.answer && REVIEW_CHOICES.has(evt.answer) ? evt.answer : null;
    const decision: AnswerDecision | null = choice === null ? null : choice === "keep" ? "approve" : "deny";
    const latencyMs = now - card.notified_at;
    const base = { requestId: request.id, switchRequestId: evt.switchRequestId, answeredBy, userId: person?.id ?? null, decision, latencyMs, atMs: now };
    const refuse = (reasons: string[]) => {
      answers.record({ ...base, eligible: false, reason: reasons.join(",") });
      ledger.append("ineligible_answer", request.id, {
        answered_by: answeredBy,
        user_id: person?.id ?? null,
        answer: evt.answer ?? null,
        reasons,
        card_room: card.card_room,
      });
    };

    if (request.expiresAtMs <= now) {
      refuse(["review_closed"]);
      return { kind: "closed" };
    }
    if (!person) {
      const agent = answeredBy ? directory.agentForSender(answeredBy) : null;
      refuse([agent ? "agent" : "unknown_participant"]);
      return { kind: "refused", subject: agent ? { type: "agent", name: agent } : { type: "unknown", answeredBy } };
    }
    if (!decision) {
      refuse(["unrecognised_answer"]);
      return { kind: "unrecognised" };
    }
    const assessment = assessAnswer(this.routeContext(request), person.id);
    if (!assessment.eligible) {
      refuse(assessment.reasons);
      return { kind: "refused", subject: { type: "person", person, reasons: assessment.reasons } };
    }

    const stamp = this.readStamp(request, person.id, decision, latencyMs, now);
    answers.record({ ...base, eligible: true, reason: null, fast: stamp.fast, signals: stamp.signals, tMinMs: stamp.tMin });
    ledger.append("answered", request.id, {
      answered_by: answeredBy,
      user_id: person.id,
      decision,
      review: choice,
      latency_ms: latencyMs,
      card_room: card.card_room,
      fast_approval: stamp.fast,
      signals: stamp.signals,
      t_min_ms: stamp.tMin,
    });
    const signal = stamp.signals[0];
    if (signal) this.people.store.setFriction(person.id, signal);

    if (choice === "keep") {
      events.markReviewed(request.id, "approved", [person.id], stamp.fast);
      return { kind: "kept" };
    }
    events.markReviewed(request.id, "denied", [person.id], false);
    if (choice === "reverse") {
      const note = "reversed on review";
      incidents.add({ requestId: request.id, reportedBy: person.id, note, atMs: now });
      events.markIncident(request.id);
      ledger.append("incident", request.id, { reported_by: person.id, note, reversal: true });
    }
    const because = choice === "reverse" ? `${person.name} reversed ${request.id} on review` : `${person.name} demoted it on review of ${request.id}`;
    const demotion = this.demote(request, because, { reason: choice === "reverse" ? "reversed" : "review", by: person.id });
    return { kind: choice as "demote" | "reverse", person, demotion };
  }

  /**
   * Instant, needs nobody's approval, and only ever goes down. Inside a transaction; the caller announces the text.
   * Null when there was no ladder to fall from: a drill, a call outside every bucket, or a bucket already at L0.
   */
  private demote(request: RequestRecord, because: string, facts: Record<string, unknown> & { reason: string }): string | null {
    const { autonomy, ledger } = this.stores;
    const evidence = this.evidenceOf(request);
    const cls = this.classOf(request.cls);
    if (request.isDrill || !evidence.bucket || !cls) return null;
    const from = autonomy.levelFor(request.agent, request.cls, evidence.bucket);
    if (from === "L0") return null;
    autonomy.setLevel(request.agent, request.cls, evidence.bucket, "L0", this.deps.clock.nowMs());
    ledger.append("demoted", request.id, {
      agent: request.agent,
      class: request.cls,
      bucket: evidence.bucket,
      from,
      to: "L0",
      ...facts,
    });
    return demotionText(request.agent, this.bucketLabel(cls, evidence.bucket), because);
  }

  /** The same arithmetic behind the proposal card, the API and `pnpm eval:autonomy`. Reads only. */
  private async assessBuckets(
    filter: { agent?: string | undefined; class?: string | undefined; bucket?: string | undefined } = {},
  ): Promise<BucketAssessment[]> {
    const { events, autonomy } = this.stores;
    const now = this.deps.clock.nowMs();
    const out: BucketAssessment[] = [];
    for (const cls of this.currentPolicy.classes) {
      if (!cls.autonomy || cls.autonomy.maxLevel === "L0") continue;
      if (filter.class && filter.class !== cls.name) continue;
      const { maxLevel, promoteAfter: criteria } = cls.autonomy;
      const windowStart = now - criteria.days * DAY_MS;
      const bucketNames = cls.autonomy.buckets.length > 0 ? cls.autonomy.buckets.map((bucket) => bucket.name) : ["default"];
      const onLadder = autonomy.all().filter((row) => row.class === cls.name).map((row) => row.agent);
      const agents = [...new Set([...events.agents(cls.name, windowStart), ...onLadder])].sort();
      for (const agent of agents) {
        if (filter.agent && filter.agent !== agent) continue;
        const rows = events.forClass(cls.name, agent, windowStart);
        const placed = await Promise.all(rows.map((row) => this.replayBucket(cls, row.fields)));
        for (const bucket of bucketNames) {
          if (filter.bucket && filter.bucket !== bucket) continue;
          const since = autonomy.since(agent, cls.name, bucket) ?? 0;
          // Evidence from before this rung began has been used, or was the reason for the fall.
          const inBucket = rows.filter((row, index) => placed[index] === bucket && row.atMs > since);
          const stats = bucketStats(inBucket);
          const level = capLevel(autonomy.levelFor(agent, cls.name, bucket), maxLevel);
          const target = proposedLevel(level, maxLevel);
          out.push({
            agent,
            cls,
            bucket,
            label: this.bucketLabel(cls, bucket),
            level,
            max: maxLevel,
            target,
            criteria,
            stats,
            meets: target !== null && meetsPromotion(stats, criteria),
            synthetic: inBucket.filter((row) => row.synthetic).length,
            real: inBucket.filter((row) => !row.synthetic).length,
          });
        }
      }
    }
    return out;
  }

  private replayBucket(cls: CompiledClass, fields: Record<string, unknown>): Promise<string | null> {
    return bucketFor(cls, { vars: fields, helpers: NO_HELPERS, structuredArgs: false });
  }

  /** Opens whatever has been earned. Returns the sentences to say when something earned can't be proposed. */
  private async proposePromotions(filter: { agent?: string | undefined } = {}): Promise<string[]> {
    const { proposals } = this.stores;
    const now = this.deps.clock.nowMs();
    const notes: string[] = [];
    for (const row of await this.assessBuckets(filter)) {
      if (!row.meets || !row.target) continue;
      const subject = `${row.agent}/${row.cls.name}/${row.bucket}`;
      if (proposals.openFor(subject)) continue;
      if (proposals.rejectedSince(subject, now - row.criteria.days * DAY_MS)) continue;
      const exclude = this.people.directory.agentOwners(row.agent);
      const quorum = this.currentPolicy.file.policy_change_quorum ?? POLICY_QUORUM_DEFAULT;
      if (this.signers(exclude, quorum).chosen.length < quorum) {
        notes.push(`${row.agent} has earned a proposal for ${row.label}, but it needs two policy owners who are here and don't own the agent.`);
        continue;
      }
      await this.openPromotion(row, subject, exclude, quorum);
    }
    return notes;
  }

  private async openPromotion(row: BucketAssessment, subject: string, exclude: string[], quorum: number): Promise<void> {
    const { proposals, ledger } = this.stores;
    const level = row.target as Level;
    const now = this.deps.clock.nowMs();
    const detail = promotionDetail({
      agent: row.agent,
      label: row.label,
      level,
      days: row.criteria.days,
      stats: row.stats,
      synthetic: row.synthetic > 0,
      quorum,
    });
    const write = this.stores.db.transaction(() => {
      const proposal = proposals.create({
        kind: "promotion",
        subject,
        quorum,
        exclude,
        atMs: now,
        expiresAtMs: now + this.deps.clock.scaledMs(PROPOSAL_TTL_MS),
        payload: {
          title: `Autonomy proposal for ${row.agent}: ${row.label}`,
          detail,
          agent: row.agent,
          class: row.cls.name,
          bucket: row.bucket,
          label: row.label,
          from: row.level,
          level,
          stats: row.stats,
          synthetic: row.synthetic > 0,
        },
      });
      ledger.append("promotion_proposed", proposal.id, {
        agent: row.agent,
        class: row.cls.name,
        bucket: row.bucket,
        from: row.level,
        level,
        quorum,
        requests: row.stats.requests,
        counted: row.stats.counted,
        fast_excluded: row.stats.fastExcluded,
        would_auto: row.stats.wouldAuto,
        would_auto_denied: row.stats.wouldAutoDenied,
        synthetic_events: row.synthetic,
      });
      return proposal;
    });
    await this.coverProposal(write.immediate());
  }

  /** Who can sign, and who gets a card: one per policy_owners entry, then anyone else until there are enough. */
  private signers(exclude: string[], quorum: number): { eligible: Person[]; chosen: Person[] } {
    const { directory, store } = this.people;
    const refs = this.currentPolicy.file.policy_owners ?? [];
    const matches = (person: Person, ref: (typeof refs)[number]) =>
      (ref.person !== undefined && ref.person === person.id) ||
      (ref.role !== undefined && person.roles.includes(ref.role)) ||
      (ref.group !== undefined && person.groups.includes(ref.group));
    const allowed = (person: Person) => !exclude.includes(person.id);
    const eligible = directory.all().filter((person) => allowed(person) && refs.some((ref) => matches(person, ref)));
    const present = eligible.filter((person) => store.away(person.id) === null);
    const chosen: Person[] = [];
    for (const ref of refs) {
      const next = present.find((person) => matches(person, ref) && !chosen.includes(person));
      if (next) chosen.push(next);
    }
    for (const person of present) {
      if (chosen.length >= quorum) break;
      if (!chosen.includes(person)) chosen.push(person);
    }
    return { eligible, chosen };
  }

  /** Everyone chosen who hasn't answered holds a live card. Run after opening, and after a card is used up. */
  private async coverProposal(proposal: Proposal): Promise<void> {
    const { proposals, routes } = this.stores;
    const voted = proposals.voters(proposal.id);
    const open = routes.openForRequest(proposal.id);
    for (const person of this.signers(proposal.exclude, proposal.quorum).chosen) {
      if (voted.includes(person.id) || open.some((row) => row.user_id === person.id)) continue;
      try {
        const { roomId } = await this.deps.chat.ensureDirectRoom({ userName: person.userName });
        const { result, named } = await this.openNaming(
          {
            roomId,
            kind: "approval",
            title: `${proposal.id} · ${proposal.payload.title}`.slice(0, TITLE_MAX),
            detail: clipToBudget(proposal.payload.detail),
            options: CARD_OPTIONS,
            questions: [],
            expiresAtMs: proposal.expiresAtMs,
          },
          [person.id],
        );
        routes.add({
          requestId: proposal.id,
          userId: person.id,
          step: "proposal",
          cardRoom: roomId,
          sessionId: result.sessionId,
          switchRequestId: result.switchRequestId,
          handle: result.handle,
        });
        if (!named) await this.notifyCard({ roomId }, [person.userName], `${proposal.id} needs your signature: ${proposal.payload.title}. The card is just above.`);
      } catch (error) {
        // Usually Switch is down. The next answer, or asking again, covers it.
        console.error(`could not open ${proposal.id}'s card for ${person.userName}: ${(error as Error).message}`);
      }
    }
  }

  private async answerProposal(card: RouteRow, evt: ApprovalOutcomeEvent): Promise<void> {
    const { proposals, routes, ledger } = this.stores;
    const { directory } = this.people;
    if (proposals.cardAnswered(evt.switchRequestId)) return; // Redelivered.
    routes.close(card.id);
    const proposal = proposals.get(card.request_id);
    if (!proposal) return;
    const now = this.deps.clock.nowMs();
    const answeredBy = evt.answeredBy ?? null;
    const person = directory.personFromAnswer(answeredBy);
    const decision = normaliseAnswer(evt.answer);
    const refuse = (reasons: string[]) =>
      ledger.append("ineligible_answer", proposal.id, {
        answered_by: answeredBy,
        user_id: person?.id ?? null,
        answer: evt.answer ?? null,
        reasons,
        card_room: card.card_room,
      });
    const tellRoom = (body: string) => this.deps.chat.postMessage({ roomId: card.card_room, body }).catch(() => undefined);

    if (proposal.state !== "open") {
      refuse(["proposal_closed"]);
      await tellRoom(`${proposal.id} is already ${proposal.state}. That answer changed nothing.`);
      return;
    }
    const eligible = this.signers(proposal.exclude, proposal.quorum).eligible;
    if (!person || !eligible.some((candidate) => candidate.id === person.id)) {
      refuse([person ? "not_a_policy_owner" : directory.agentForSender(answeredBy ?? "") ? "agent" : "unknown_participant"]);
      const who = person?.name ?? "That account";
      await tellRoom(`${who} can't sign ${proposal.id}: it takes a policy owner who doesn't own the agent.`);
      await this.coverProposal(proposal);
      return;
    }
    if (!decision) {
      await this.coverProposal(proposal);
      return;
    }
    const write = this.stores.db.transaction((): { rejected: boolean; signedBy: string[] } => {
      const counted = proposals.vote({ proposalId: proposal.id, userId: person.id, decision, switchRequestId: evt.switchRequestId, atMs: now });
      if (counted) ledger.append("answered", proposal.id, { answered_by: answeredBy, user_id: person.id, decision, proposal: true });
      const rejected = counted && decision === "deny";
      if (rejected) {
        proposals.setState(proposal.id, "rejected", now);
        ledger.append(proposal.kind === "promotion" ? "promotion_rejected" : "policy_rejected", proposal.id, { reason: "denied", by: person.id });
      }
      return { rejected, signedBy: proposals.signers(proposal.id) };
    });
    const { rejected, signedBy } = write.immediate();
    if (rejected) {
      await this.closeProposalCards(proposal);
      await this.announce(`${proposal.id} was turned down by ${person.name}. Nothing changed.`);
      return;
    }
    if (signedBy.length < proposal.quorum) {
      await this.coverProposal(proposal);
      return;
    }
    await this.applyProposal(proposal, signedBy);
  }

  private async closeProposalCards(proposal: Proposal): Promise<void> {
    const { routes } = this.stores;
    for (const row of routes.openForRequest(proposal.id)) {
      routes.close(row.id);
      await this.deps.chat.closeCard(row.session_id, row.switch_request_id).catch(() => undefined);
    }
  }

  private async applyProposal(proposal: Proposal, signedBy: string[]): Promise<void> {
    const { proposals, autonomy, ledger } = this.stores;
    const now = this.deps.clock.nowMs();
    if (proposal.kind === "policy_change") {
      await this.applyPolicyChange(proposal, signedBy);
      return;
    }
    const { agent, class: cls, bucket, level, label } = proposal.payload as Proposal["payload"] & {
      agent: string;
      class: string;
      bucket: string;
      level: Level;
      label: string;
    };
    // Two signatures on evidence that has since gone are two signatures on nothing.
    const [current] = await this.assessBuckets({ agent, class: cls, bucket });
    await this.closeProposalCards(proposal);
    if (!current?.meets || current.target !== level) {
      const write = this.stores.db.transaction(() => {
        proposals.setState(proposal.id, "rejected", now);
        ledger.append("promotion_rejected", proposal.id, { reason: "evidence_changed", signed_by: signedBy });
      });
      write.immediate();
      await this.announce(`${proposal.id} was signed, but the record has changed since it was proposed, so ${agent} stays where it is.`);
      return;
    }
    const write = this.stores.db.transaction(() => {
      autonomy.setLevel(agent, cls, bucket, level, now);
      proposals.setState(proposal.id, "signed", now);
      ledger.append("promotion_signed", proposal.id, { agent, class: cls, bucket, level, signed_by: signedBy });
    });
    write.immediate();
    await this.announce(promotedText(agent, label, level, this.approverNames(signedBy)));
  }

  private async expireProposals(now: number): Promise<void> {
    const { proposals } = this.stores;
    for (const proposal of proposals.listExpired(now)) {
      proposals.setState(proposal.id, "expired", now);
      await this.closeProposalCards(proposal);
    }
  }

  // ── @clearance commands ────────────────────────────────────────────────────

  private async handleCommand(evt: ChatMessageEvent, askerId: string | null): Promise<void> {
    const command = parseCommand(evt);
    if (!command) return;
    // Delivered late, after a restart. Break-glass hours after someone asked for it isn't what they asked for.
    if (evt.timestampMs > 0 && this.deps.clock.nowMs() - evt.timestampMs > STALE_COMMAND_MS) return;
    const reply = await this.commandReply(command, evt, askerId);
    if (!reply) return;
    await this.deps.chat.postMessage({
      roomId: evt.roomId,
      body: reply,
      ...(evt.threadId ? { threadId: evt.threadId } : {}),
    });
  }

  /** The one place commands are told apart. `askerId` comes from the event's sender; an agent has none. */
  private async commandReply(command: Command, evt: ChatMessageEvent, askerId: string | null): Promise<string | null> {
    const [first, ...others] = command.words;
    const after = others.join(" ") || undefined;
    switch (command.verb) {
      case "why":
        return first ? this.whyReply(first, askerId, evt.roomId) : null;
      case "status":
        return first ? this.statusReply(first, evt.roomId) : null;
      case "inbox":
        return askerId && this.people.directory.person(askerId) ? inboxMessage(this.inboxItems(askerId), { roomId: evt.roomId }) : null;
      case "autonomy":
        return this.autonomyReply(first);
      case "policy":
        return first?.toLowerCase() === "test" ? this.policyTestReply(after) : this.policyReply();
      case "incident":
        return askerId ? this.incidentReply(first, after, askerId, evt.roomId) : null;
      case "away":
        return askerId ? this.awayReply(command.args, askerId) : null;
      case "back":
        return askerId ? this.backReply(askerId) : null;
      case "breakglass":
        return askerId ? this.breakGlassReply(first, after, askerId) : null;
      case "drills":
        return askerId ? this.drillsReply(first, askerId) : null;
      default:
        return null;
    }
  }

  private policyReply(): string {
    const policy = this.currentPolicy;
    const quorum = policy.file.policy_change_quorum;
    const change = quorum ? `Changing it takes ${quorum} policy owners.` : "Changing it takes nobody's signature yet.";
    const pending = this.stores.proposals.openOfKind("policy_change");
    const waiting = pending ? ` ${pending.id} is waiting on a change, ${this.stores.proposals.signers(pending.id).length} of ${pending.quorum} signed.` : "";
    return `Policy ${policy.hash.slice(0, 12)}, mode ${policy.file.mode}. Classes: ${policy.classes.map((cls) => cls.name).join(", ")}. ${change}${waiting} Try one: @clearance policy test git push --force origin main`;
  }

  /** A dry run through the simulator: it records nothing, opens nothing and can't spend a grant. */
  private async policyTestReply(text: string | undefined): Promise<string> {
    if (!text) return "Say what to test: `@clearance policy test git push --force origin main`, or `@clearance policy test POST /acme/refunds amount=40000 order_id=A-2004`.";
    const agent = Object.keys(this.team.agents)[0] ?? "agent";
    const result = await this.simulate(describedAction(text, agent, this.deps.clock.nowMs()));
    const decided: Record<string, string> = { allow: "allowed", hold: "held", deny: "denied" };
    const about = [result.class ? `class ${String(result.class)}` : "no class", result.tier ? `tier ${String(result.tier)}` : null].filter(Boolean).join(", ");
    const summary = result.decision === "hold" && result.hold_summary ? ` ${String(result.hold_summary)}.` : "";
    const flags = (result.flags as Flag[] | undefined) ?? [];
    const flagged = flags.length > 0 ? ` Flags: ${flags.map((flag) => flag.text).join("; ")}.` : "";
    return `That would be ${decided[String(result.decision)] ?? String(result.decision)} (${about}).${summary}${flagged} Nothing was recorded.`;
  }

  private delegateFor(reference: string): Person | null {
    const wanted = reference.toLowerCase();
    return this.people.directory.all().find((person) => [person.id, person.userName, person.name].some((name) => name.toLowerCase() === wanted)) ?? null;
  }

  private async awayReply(args: string, personId: string): Promise<string | null> {
    const { store } = this.people;
    const person = this.people.directory.person(personId);
    if (!person) return null;
    const tz = this.currentPolicy.defaults.business_hours.tz;
    const away = parseAway(args, this.deps.clock.nowMs(), tz);
    if (!away) return "Say until when: `@clearance away until 18:00`, or `@clearance away until 18:00 delegate @neha`.";
    let delegate: Person | null = null;
    if (away.delegate) {
      delegate = this.delegateFor(away.delegate);
      if (!delegate) return `I don't know ${away.delegate}, so ${person.name} isn't marked away.`;
      if (delegate.id === person.id) return `${person.name} can't delegate to yourself. Name someone else, or leave out the delegate.`;
    }
    store.setAway(person.id, away.untilMs, delegate?.id ?? null);
    // What this person was holding moves on: someone away can't answer, so it isn't covered any more.
    const { routes, requests } = this.stores;
    const holding = new Set(routes.openFor(person.id).map((row) => row.request_id));
    for (const id of holding) await this.keepCovered(requests.require(id));
    const until = formatClockWithZone(away.untilMs, tz);
    return delegate ? `${person.name} is away until ${until}. ${delegate.name} has ${person.name}'s approvals until then.` : `${person.name} is away until ${until}.`;
  }

  private backReply(personId: string): string | null {
    const person = this.people.directory.person(personId);
    if (!person) return null;
    this.people.store.setAway(person.id, null, null);
    return `${person.name} is back.`;
  }

  private drillsReply(setting: string | undefined, personId: string): string {
    const person = this.people.directory.person(personId);
    const value = setting?.toLowerCase();
    if (value !== "on" && value !== "off") return "`@clearance drills on`, or `@clearance drills off`.";
    if (!(this.team.admins ?? []).includes(personId)) return `Only a team admin can turn drills ${value}, and ${person?.name ?? "that account"} isn't one.`;
    this.stores.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('drills_off', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(value === "off" ? "1" : "0");
    return `Drills are ${value} for this team.`;
  }

  // ── Break-glass (F18) ──────────────────────────────────────────────────────

  private async breakGlassReply(reference: string | undefined, reason: string | undefined, actorId: string): Promise<string> {
    const { requests, ledger, grants } = this.stores;
    const { directory } = this.people;
    if (!reference) return "Which request? `@clearance breakglass CLR-0042 why it can't wait`.";
    const found = this.findRequest(reference);
    // A drill has nothing behind it to run, and saying so would give it away.
    if (!found || found.isDrill) return `I can't find ${reference}.`;
    const actor = directory.person(actorId);
    const named = this.currentPolicy.file.break_glass?.people ?? [];
    const refuse = (reasons: string[]) =>
      ledger.append("ineligible_answer", found.id, { answered_by: null, user_id: actorId, answer: null, reasons, break_glass: true });
    if (!named.includes(actorId)) {
      refuse(["not_break_glass_person"]);
      const who = joinNames(named.map((id) => directory.person(id)?.name ?? id));
      return `${actor?.name ?? "That account"} can't break glass on ${found.id}: only ${who || "people named in the policy"} can.`;
    }
    if (found.requesterIds.includes(actorId)) {
      refuse(["requester"]);
      return `${actor?.name ?? "That account"} asked for ${found.id}, so can't break glass on it.`;
    }
    if (!reason) return `Say the reason: \`@clearance breakglass ${found.id} why it can't wait\`.`;

    if (OPEN_STATES.includes(found.state) && found.expiresAtMs <= this.deps.clock.nowMs()) await this.expire(found);
    const write = this.stores.db.transaction((): RequestRecord | null => {
      const current = requests.require(found.id);
      if (!OPEN_STATES.includes(current.state)) return null;
      if (current.state === "HELD") requests.transition(current.id, "ROUTED");
      requests.transition(current.id, "BREAK_GLASS");
      ledger.append("break_glass", current.id, { by: actorId, reason, call_hash: current.callHash });
      if (current.source === "hook") {
        grants.mint(current.id, current.callHash, current.agent, this.deps.clock.scaledMs(this.currentPolicy.grantTtlMs));
        requests.transition(current.id, "GRANTED");
      }
      return current;
    });
    const request = write.immediate();
    if (!request) return `${found.id} is already decided (${requests.require(found.id).state}). Nothing ran.`;

    await this.closeOpenCards(request);
    const dueMs = this.deps.clock.nowMs() + this.glassReviewWindow();
    const name = actor?.name ?? actorId;
    await this.tellOriginCopy(request, `${request.id} let through by break-glass by ${name}.`);
    const tz = this.currentPolicy.defaults.business_hours.tz;
    const headline = this.evidenceOf(request).description.headline;
    const others = directory.all().filter((person) => person.id !== actorId).map((person) => person.userName);
    await this.deps.chat
      .sendTargeted({
        roomId: this.approvalsRoom(),
        body: `${name} broke glass on ${request.id}: ${headline}. Reason: ${reason}. A review is due by ${formatClockWithZone(dueMs, tz)} tomorrow.`,
        targets: others,
      })
      .catch(() => undefined);
    await this.openGlassReview(request, actorId, reason);
    if (request.source === "hook") {
      await this.notifyAgent(request, `${request.id} let through by break-glass by ${name}. Run the exact same command once.`);
    } else {
      await this.executeApproved(request);
    }
    return `${request.id}: glass broken. ${request.source === "hook" ? "The agent has been told to run it." : "Sent to run."}`;
  }

  private glassReviewWindow(): number {
    return this.deps.clock.scaledMs(parseDuration(this.currentPolicy.file.break_glass?.review_within ?? DEFAULT_GLASS_REVIEW));
  }

  /** Who may review a break-glass: the policy owners, but not the person who did it or the people who asked for it. */
  private glassReviewers(request: RequestRecord, actorId: string): { eligible: Person[]; chosen: Person[] } {
    return this.signers([actorId, ...request.requesterIds], 1);
  }

  private async openGlassReview(request: RequestRecord, actorId: string, reason: string): Promise<void> {
    const { routes } = this.stores;
    const { directory } = this.people;
    const evidence = this.evidenceOf(request);
    const actor = directory.person(actorId)?.name ?? actorId;
    const expiresAtMs = this.deps.clock.nowMs() + this.glassReviewWindow();
    const open = routes.openForRequest(request.id).filter((row) => row.step === "glass_review");
    const { chosen } = this.glassReviewers(request, actorId);
    if (chosen.length === 0) {
      await this.announce(`Nobody can review the break-glass on ${request.id}: every policy owner did it or asked for it. Someone needs to look at it.`);
      return;
    }
    for (const person of chosen) {
      if (open.some((row) => row.user_id === person.id)) continue;
      try {
        const { roomId } = await this.deps.chat.ensureDirectRoom({ userName: person.userName });
        const { result, named } = await this.openNaming({
          roomId,
          kind: "approval",
          title: `${request.id} · BREAK-GLASS REVIEW · ${evidence.description.headline}`.slice(0, TITLE_MAX),
          detail: clipToBudget(
            [
              `${actor} broke glass on this, so it ran without an approver. Was that justified? @clearance why ${request.id}`,
              `Reason given: ${oneLine(reason, 300)}`,
              evidence.description.call.map((line) => `  ${oneLine(line, 200)}`).join("\n"),
            ].join("\n\n"),
          ),
          options: GLASS_REVIEW_OPTIONS,
          questions: [],
          expiresAtMs,
        }, [person.id]);
        routes.add({
          requestId: request.id,
          userId: person.id,
          step: "glass_review",
          cardRoom: roomId,
          sessionId: result.sessionId,
          switchRequestId: result.switchRequestId,
          handle: result.handle,
        });
        if (!named) await this.notifyCard({ roomId }, [person.userName], `${request.id} needs your review: ${actor} broke glass on it. The card is just above.`);
      } catch {
        // The page has gone out. The overdue chase is what finally surfaces a review nobody could be shown.
      }
    }
  }

  private async answerGlassReview(card: RouteRow, evt: ApprovalOutcomeEvent): Promise<void> {
    const { requests, ledger, answers, incidents, events } = this.stores;
    const { directory } = this.people;
    const request = requests.require(card.request_id);
    const now = this.deps.clock.nowMs();
    const answeredBy = evt.answeredBy ?? null;
    const person = directory.personFromAnswer(answeredBy);
    const glass = ledger.list({ requestId: request.id }).find((entry) => entry.type === "break_glass");
    const actorId = String(glass?.payload.by ?? "");
    const reason = String(glass?.payload.reason ?? "");
    const choice = evt.answer === "justified" || evt.answer === "not_justified" ? evt.answer : null;
    const eligible = this.glassReviewers(request, actorId).eligible.some((candidate) => candidate.id === person?.id);
    const base = { requestId: request.id, switchRequestId: evt.switchRequestId, answeredBy, userId: person?.id ?? null, decision: null, latencyMs: now - card.notified_at, atMs: now };
    if (!person || !eligible || !choice) {
      const reasons = !person ? ["unknown_participant"] : !eligible ? ["not_a_reviewer"] : ["unrecognised_answer"];
      answers.record({ ...base, eligible: false, reason: reasons.join(",") });
      ledger.append("ineligible_answer", request.id, { answered_by: answeredBy, user_id: person?.id ?? null, answer: evt.answer ?? null, reasons, card_room: card.card_room });
      await this.openGlassReview(request, actorId, reason);
      return;
    }
    const write = this.stores.db.transaction(() => {
      answers.record({ ...base, eligible: true, reason: `break_glass_review:${choice}` });
      ledger.append("answered", request.id, { answered_by: answeredBy, user_id: person.id, break_glass_review: choice, card_room: card.card_room });
      if (choice === "not_justified") {
        const note = "break-glass reviewed as not justified";
        incidents.add({ requestId: request.id, reportedBy: person.id, note, atMs: now });
        events.markIncident(request.id);
        ledger.append("incident", request.id, { reported_by: person.id, note });
      }
    });
    write.immediate();
    await this.closeOpenCards(request);
    if (choice === "not_justified") await this.announce(`${person.name} says the break-glass on ${request.id} was not justified. An incident is recorded.`);
  }

  /** A review that couldn't be opened when glass was broken, because Switch was down. */
  private async openMissingGlassReviews(): Promise<void> {
    const { db, ledger, requests } = this.stores;
    const rows = db
      .prepare(
        `SELECT DISTINCT request_id FROM ledger WHERE type = 'break_glass'
           AND request_id NOT IN (SELECT request_id FROM routes WHERE step = 'glass_review')`,
      )
      .all() as { request_id: string }[];
    for (const row of rows) {
      const glass = ledger.list({ requestId: row.request_id }).find((entry) => entry.type === "break_glass");
      if (!glass) continue;
      const request = requests.require(row.request_id);
      // With nobody to show it to, the room was told once when it happened. Asking again every second helps nobody.
      if (this.glassReviewers(request, String(glass.payload.by)).chosen.length === 0) continue;
      await this.openGlassReview(request, String(glass.payload.by), String(glass.payload.reason));
    }
  }

  /** "Mandatory" means someone gets chased. Once, in the room, with the card closed behind it. */
  private async chaseGlassReviews(now: number): Promise<void> {
    const { routes, requests, ledger } = this.stores;
    const seen = new Set<string>();
    for (const row of routes.overdueGlassReviews(now - this.glassReviewWindow())) {
      seen.add(row.request_id);
      routes.close(row.id);
      await this.deps.chat.closeCard(row.session_id, row.switch_request_id).catch(() => undefined);
    }
    for (const id of seen) {
      const request = requests.require(id);
      ledger.append("escalated", id, { kind: "post", room: this.currentPolicy.defaults.fallback.room, break_glass_review: true });
      await this.announce(`The review of the break-glass on ${request.id} is overdue. Someone needs to look at it: \`@clearance why ${request.id}\`.`);
    }
  }

  private async autonomyReply(agent: string | undefined): Promise<string> {
    const notes = await this.proposePromotions({ agent });
    const { proposals } = this.stores;
    const rows = await this.assessBuckets({ agent });
    if (rows.length === 0) return `${agent ?? "Nothing"} has no autonomy history yet.`;
    const lines = rows.map((row) => {
      const open = proposals.openFor(`${row.agent}/${row.cls.name}/${row.bucket}`);
      const where = `${row.agent}: ${row.label} at ${row.level}.`;
      if (open) return `${where} ${open.id} is open, ${proposals.signers(open.id).length} of ${open.quorum} signed.`;
      if (!row.target) return `${where} That is as far as the policy goes.`;
      const { stats, criteria } = row;
      return `${where} ${stats.counted} of ${criteria.approvals} approvals, ${stats.approvers.length} of ${criteria.minDistinctApprovers} people, ${stats.denied} denied, ${plural(stats.incidents, "incident")}.`;
    });
    return [...lines, ...notes].join("\n");
  }

  /** The reporter comes from the sender, never from the text. Returns what to say in the room it was asked in. */
  private async incidentReply(reference: string | undefined, note: string | undefined, reporterId: string, room: string): Promise<string | null> {
    const { incidents, ledger, events } = this.stores;
    if (!reference) return "Which request? `@clearance incident CLR-0042 what went wrong`.";
    const request = this.findRequest(reference);
    if (!request) return `I can't find ${reference}.`;
    if (!note) return `Say what went wrong: \`@clearance incident ${request.id} what went wrong\`.`;
    const reporter = this.people.directory.person(reporterId);
    const now = this.deps.clock.nowMs();
    const write = this.stores.db.transaction((): string | null => {
      incidents.add({ requestId: request.id, reportedBy: reporterId, note, atMs: now });
      events.markIncident(request.id);
      ledger.append("incident", request.id, { reported_by: reporterId, note });
      return this.demote(request, `of incident ${request.id} reported by ${reporter?.name ?? reporterId}`, { reason: "incident", by: reporterId });
    });
    const demotion = write.immediate();
    if (!demotion) return `Incident recorded on ${request.id}. ${request.agent} wasn't running on its own there, so no level changed.`;
    await this.announce(demotion);
    return room === this.approvalsRoom() ? null : demotion;
  }

  /** A CLR id, or an answer handle like A12, which means the card of that name in this room if there is one. */
  private findRequest(reference: string, roomId?: string): RequestRecord | null {
    const { requests, routes } = this.stores;
    const direct = requests.get(reference.toUpperCase());
    if (direct) return direct;
    const found = routes.byHandle(reference, roomId);
    return found ? requests.get(found.request_id) : null;
  }

  private whyReply(reference: string, askerId: string | null, roomId: string): string {
    const request = this.findRequest(reference, roomId);
    const trace = request ? this.traces.latest(request.id) : null;
    if (!request || !trace) return `I can't find ${reference}.`;
    const evidence = this.evidenceOf(request);
    const explained = explainTrace(trace, {
      handle: reference,
      tier: request.tier,
      className: request.cls,
      fired: evidence.fired,
      extracted: evidence.extracted,
      currency: this.currentPolicy.currency,
      tz: this.currentPolicy.defaults.business_hours.tz,
      escalation: this.escalationPlan(request, trace),
      expiresAtMs: request.expiresAtMs,
    });
    if (askerId && request.requesterIds.includes(askerId)) {
      return `${heldExplanation(trace, evidence.holdSummary, askerId)} ${explained}`;
    }
    return explained;
  }

  private statusReply(reference: string, roomId: string): string {
    const request = this.findRequest(reference, roomId);
    if (!request) return `I can't find ${reference}.`;
    const trace = this.traces.latest(request.id);
    const tz = this.currentPolicy.defaults.business_hours.tz;
    const holder = trace ? ` ${holderSentence(trace)}` : "";
    return `${request.id}: ${request.state}.${holder} Expires ${formatClockWithZone(request.expiresAtMs, tz)}.`;
  }

  /** Who the ladder reaches next and when, as the why trace reports it. */
  private escalationPlan(
    request: RequestRecord,
    trace: RouteTrace,
  ): { kind: "person" | "room"; name: string; atMs: number }[] {
    const cls = this.classOf(request.cls);
    const spare = trace.ranked.filter((entry) => !trace.chosen.includes(entry.id)).map((entry) => entry.name);
    const plan: { kind: "person" | "room"; name: string; atMs: number }[] = [];
    for (const step of cls?.escalate ?? []) {
      const atMs = request.createdAtMs + this.deps.clock.scaledMs(step.afterMs);
      if (step.add) {
        const next = spare.shift();
        if (next) plan.push({ kind: "person", name: next, atMs });
      } else if (step.post) {
        plan.push({ kind: "room", name: step.post, atMs });
      }
    }
    return plan;
  }

  // ── Records ────────────────────────────────────────────────────────────────

  private recordAction(action: Action, evaluation: Evaluation, requestId: string | null, wouldDecide: string | null = null): void {
    this.stores.db
      .prepare(
        `INSERT OR IGNORE INTO actions (id, at, source, vendor, agent, kind, class, tier, score, call_hash, decision, step, request_id, raw, would_decide, action_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.id,
        action.at,
        action.source,
        action.vendor,
        action.agent.name,
        action.kind,
        evaluation.cls ?? evaluation.call.class,
        evaluation.tier ?? null,
        evaluation.score ?? null,
        evaluation.callHash,
        evaluation.decision,
        evaluation.step,
        requestId,
        JSON.stringify(action.raw ?? null),
        wouldDecide,
        JSON.stringify(action),
      );
  }

  private recordAggregates(action: Action, evaluation: Evaluation, requestId: string | null): void {
    for (const hit of evaluation.aggregates) {
      this.stores.aggregates.record({
        cls: evaluation.call.class,
        byField: hit.by,
        key: hit.key,
        value: hit.value,
        agent: action.agent.name,
        actionId: action.id,
        requestId,
        atMs: this.deps.clock.nowMs(),
      });
    }
  }

  // ── Policy ─────────────────────────────────────────────────────────────────

  private recordPolicyVersion(policy: CompiledPolicy, approvedBy?: string[]): void {
    const { db, ledger } = this.stores;
    const latest = db.prepare(`SELECT hash, text FROM policy_versions ORDER BY loaded_at DESC, rowid DESC LIMIT 1`).get() as
      | { hash: string; text: string | null }
      | undefined;
    if (latest?.hash === policy.hash) {
      // A database from before texts were kept. Keep this one, so a restart has something signed to go back to.
      if (latest.text === null) db.prepare(`UPDATE policy_versions SET text = ? WHERE hash = ?`).run(policy.text, policy.hash);
      return;
    }
    const write = db.transaction(() => {
      db.prepare(`INSERT INTO policy_versions (hash, loaded_at, source, approved_by, text) VALUES (?, ?, ?, ?, ?)`).run(
        policy.hash,
        this.deps.clock.nowMs(),
        policy.source,
        JSON.stringify(approvedBy ?? []),
        policy.text,
      );
      ledger.append("policy_loaded", null, { hash: policy.hash, source: policy.source, ...(approvedBy ? { approved_by: approvedBy } : {}) });
    });
    write.immediate();
  }

  /**
   * F17: with a quorum in force, a change is only ever a proposal, from the file or from POST /v1/policy/propose. It
   * applies when enough people have signed it. Null when there aren't enough people here to sign it.
   */
  private async proposePolicyChange(
    next: CompiledPolicy,
    source: { origin: "file" | "api"; proposedBy?: string | undefined; reason?: string | undefined },
  ): Promise<Proposal | null> {
    const { proposals, ledger } = this.stores;
    const waiting = proposals.openOfKind("policy_change");
    if (waiting) await this.withdrawProposal(waiting);
    const quorum = this.currentPolicy.file.policy_change_quorum ?? POLICY_QUORUM_DEFAULT;
    const exclude = source.proposedBy ? [source.proposedBy] : [];
    if (this.signers(exclude, quorum).chosen.length < quorum) return null;
    const now = this.deps.clock.nowMs();
    const proposer = source.proposedBy ? (this.people.directory.person(source.proposedBy)?.name ?? source.proposedBy) : null;
    const why = source.reason ? `Reason${proposer ? ` from ${proposer}` : ""}: ${oneLine(source.reason, 200)}` : proposer ? `Proposed by ${proposer}.` : null;
    const changed = changeSummary(policyChanges(this.currentPolicy.file, next.file));
    const replay = await this.replayPolicy({ policy: next.text, last: POLICY_CARD_REPLAY });
    const delta = replay.delta as { allow: number; hold: number; deny: number };
    const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
    const detail = [
      `Policy change. In force ${this.currentPolicy.hash.slice(0, 12)}, proposed ${next.hash.slice(0, 12)}.`,
      ...(why ? [why] : []),
      `What changes: ${changed}.`,
      `Replay over the last ${String(replay.replayed)} actions: held ${signed(delta.hold)}, allowed ${signed(delta.allow)}, denied ${signed(delta.deny)}.`,
      `${["Zero", "One", "Two", "Three", "Four", "Five"][quorum] ?? quorum} approvals needed.`,
    ].join("\n\n");
    const write = this.stores.db.transaction(() => {
      const proposal = proposals.create({
        kind: "policy_change",
        subject: `policy:${next.hash}`,
        quorum,
        exclude,
        atMs: now,
        expiresAtMs: now + this.deps.clock.scaledMs(PROPOSAL_TTL_MS),
        payload: { title: `Policy change ${next.hash.slice(0, 12)}`, detail, hash: next.hash, policy_text: next.text, origin: source.origin },
      });
      ledger.append("policy_proposed", proposal.id, {
        hash: next.hash,
        from: this.currentPolicy.hash,
        changed,
        quorum,
        origin: source.origin,
        ...(source.proposedBy ? { proposed_by: source.proposedBy } : {}),
        ...(source.reason ? { reason: source.reason } : {}),
      });
      return proposal;
    });
    const proposal = write.immediate();
    await this.coverProposal(proposal);
    return proposal;
  }

  /**
   * POST /v1/policy/propose: a change that didn't come from the file. A patch applies to the policy in force and keeps
   * the file's comments. What's asked for here is a proposal, the same as editing the file: nothing changes until
   * enough people sign it, and the person proposing isn't one of them.
   */
  async proposePolicy(input: {
    proposedBy?: string | undefined;
    reason?: string | undefined;
    policy?: string | undefined;
    patch?: Record<string, unknown> | undefined;
  }): Promise<{ ok: true; proposal: Proposal } | { ok: false; status: 400 | 409; error: string }> {
    if ((input.policy === undefined) === (input.patch === undefined)) return { ok: false, status: 400, error: "send either policy or patch" };
    if (input.proposedBy && !this.people.directory.person(input.proposedBy)) return { ok: false, status: 400, error: `no person ${input.proposedBy}` };
    let next: CompiledPolicy;
    try {
      const text = input.policy ?? patchedPolicyText(this.currentPolicy.text, input.patch as Record<string, unknown>);
      next = parsePolicy(text, "proposed policy");
    } catch (error) {
      const line = error instanceof PolicyLoadError ? `line ${error.line}: ` : "";
      return { ok: false, status: 400, error: `${line}${(error as Error).message}` };
    }
    if (next.hash === this.currentPolicy.hash || policyChanges(this.currentPolicy.file, next.file).length === 0) {
      return { ok: false, status: 409, error: "that is the policy already in force" };
    }
    const proposal = await this.proposePolicyChange(next, { origin: "api", proposedBy: input.proposedBy, reason: input.reason });
    if (!proposal) return { ok: false, status: 409, error: "there aren't enough policy owners here to sign it" };
    return { ok: true, proposal };
  }

  private async withdrawProposal(proposal: Proposal): Promise<void> {
    this.stores.proposals.setState(proposal.id, "expired", this.deps.clock.nowMs());
    await this.closeProposalCards(proposal);
  }

  private async applyPolicyChange(proposal: Proposal, signedBy: string[]): Promise<void> {
    const { proposals } = this.stores;
    const next = parsePolicy(String(proposal.payload.policy_text), this.deps.policyPath);
    await this.closeProposalCards(proposal);
    const write = this.stores.db.transaction(() => {
      proposals.setState(proposal.id, "signed", this.deps.clock.nowMs());
      this.recordPolicyVersion(next, signedBy);
    });
    write.immediate();
    this.currentPolicy = next;
    await this.announce(`Policy ${next.hash.slice(0, 12)} is in force. Signed by ${this.approverNames(signedBy)}.`);
  }

  private async reloadPolicyIfChanged(): Promise<void> {
    let text: string;
    try {
      text = readFileSync(this.deps.policyPath, "utf8");
    } catch (error) {
      this.policyError = (error as Error).message;
      return;
    }
    try {
      const next = parsePolicy(text, this.deps.policyPath);
      this.policyError = null;
      // Nothing has happened to the file since it was last acted on, whichever way that went.
      if (next.hash === this.getMeta(POLICY_FILE_SEEN)) return;
      if (next.hash === this.currentPolicy.hash) {
        // The file is back to what's in force, so what it was asking for isn't being asked for any more.
        const waiting = this.stores.proposals.openOfKind("policy_change");
        if (waiting?.payload.origin === "file") await this.withdrawProposal(waiting);
        this.setMeta(POLICY_FILE_SEEN, next.hash);
        return;
      }
      if (this.currentPolicy.file.policy_change_quorum) {
        const proposal = await this.proposePolicyChange(next, { origin: "file" });
        if (proposal) this.setMeta(POLICY_FILE_SEEN, next.hash);
        else this.policyError = "The policy file has changed, but there aren't enough policy owners here to sign it. The last signed policy stays in force.";
        return;
      }
      this.currentPolicy = next;
      this.recordPolicyVersion(next);
      this.setMeta(POLICY_FILE_SEEN, next.hash);
    } catch (error) {
      // Keep enforcing the last good policy rather than running with none.
      this.policyError = (error as Error).message;
    }
  }
}

export function createClearanceCore(deps: CoreDeps): Clearance {
  return new Clearance(deps);
}
