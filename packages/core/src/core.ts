/**
 * clearance-core: the only place a decision becomes an effect. `check` is the only decision entry point.
 * The engine decides; this class records, holds, routes, answers and expires.
 *
 * The rule for concurrency: every state change happens in a synchronous SQLite transaction and only then
 * does anything talk to the outside. Two answers arriving together can never both think they decided.
 */
import { readFileSync } from "node:fs";
import {
  ActionSchema,
  ApprovalOutcomeEventSchema,
  ChatMessageEventSchema,
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
} from "@clearance/contracts";
import { AnswerStore, normaliseAnswer, type AnswerDecision } from "./answers/store.js";
import { AutonomyStore } from "./autonomy/store.js";
import { describeCall, describeResult, type CallDescription } from "./cards/describe.js";
import { renderCard } from "./cards/render.js";
import { buildCardView, type Audience } from "./cards/view.js";
import { openDatabase, type Db } from "./db/index.js";
import { TimerStore, type TimerRow } from "./escalation/timers.js";
import { joinNames } from "./format.js";
import { GrantStore } from "./grants/grants.js";
import { Ledger, verifyLedger, type LedgerVerification } from "./ledger/ledger.js";
import { detectMismatch } from "./mismatch/detect.js";
import { Directory, loadIdentities, type Person } from "./people/directory.js";
import { PeopleStore } from "./people/store.js";
import { evaluateAction, MALFORMED_CLASS, UNKNOWN_PROTECTED_CLASS, UNPARSED_CLASS, type Evaluation } from "./policy/engine.js";
import { loadPolicy, loadTeam, parsePolicy, type CompiledClass, type CompiledPolicy } from "./policy/load.js";
import type { TeamFile } from "./policy/schema.js";
import { OPEN_STATES, RequestStore, type NewRequest, type RequestRecord } from "./requests/store.js";
import { AggregateStore } from "./risk/aggregates.js";
import { authorUnknownFlag, denialReason, REQUESTER_UNKNOWN_FLAG } from "./risk/flags.js";
import { RequesterTracker } from "./router/requesters.js";
import { assessAnswer, route, type Refusal, type RouteContext, type RouteTrace } from "./router/router.js";
import { RouteStore, type RouteRow, type RouteStep } from "./router/routes.js";
import { TraceStore } from "./router/traces.js";
import { article, exclusionWords, explainTrace, heldExplanation, holderSentence, routeLabel } from "./router/why.js";
import { formatClockWithZone, formatPolicyMinutes } from "./time.js";

export type CoreDeps = {
  dbPath: string;
  policyPath: string;
  teamPath: string;
  identitiesPath?: string;
  chat: ChatPort;
  gate: GatePort;
  lookup: LookupPort;
  clock: Clock;
};

export interface ClearanceCore {
  check(action: Action): Promise<CheckResponse>;
  onMessage(evt: ChatMessageEvent): Promise<void>;
  onApprovalOutcome(evt: ApprovalOutcomeEvent): Promise<void>;
  tick(): Promise<void>;
  close(): void;
}

export type InboxItem = {
  request_id: string;
  handle: string | null;
  class: string;
  tier: string;
  what: string;
  room: string | null;
  age_s: number;
  expires_at: string;
};

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
};

const CARD_OPTIONS: (CardOption & { decision: "accept" | "decline" })[] = [
  { id: "allow", label: "Approve", decision: "accept" },
  { id: "deny", label: "Deny", decision: "decline" },
];

/** Real time, not policy time: how long a gate outage we will sit out before calling an approval dead. */
const EXECUTE_RETRY_EVERY_MS = 5_000;
const EXECUTE_GIVE_UP_AFTER_MS = 5 * 60_000;

type Verdict =
  | { kind: "closed"; state: string }
  | { kind: "unrecognised" }
  | { kind: "refused"; subject: Refused }
  | { kind: "denied"; person: Person }
  | { kind: "counted"; person: Person }
  | { kind: "approved"; people: string[] };

type CardPlace = { roomId: string; threadId?: string | undefined };

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
  };
  readonly people: { directory: Directory; store: PeopleStore; requesters: RequesterTracker };
  readonly traces: TraceStore;
  readonly team: TeamFile;
  private currentPolicy: CompiledPolicy;
  private policyError: string | null = null;
  private ticking = false;
  private readonly lastExecuteAttempt = new Map<string, number>();
  private readonly executing = new Set<string>();

  constructor(private readonly deps: CoreDeps) {
    this.currentPolicy = loadPolicy(deps.policyPath);
    this.team = loadTeam(deps.teamPath);
    const db = openDatabase(deps.dbPath);
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
    };
    const directory = new Directory(this.team, loadIdentities(deps.identitiesPath));
    this.people = {
      directory,
      store: new PeopleStore(db, directory, deps.clock),
      requesters: new RequesterTracker(db, directory, deps.clock),
    };
    this.people.store.sync(this.team);
    this.traces = new TraceStore(db, deps.clock);
    this.recordPolicyVersion(this.currentPolicy);
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
  resolveAgent(cwd: string | undefined): string | null {
    return this.people.directory.resolveAgent(cwd);
  }

  health(): { ok: true; policy_hash: string; policy_error: string | null; open_requests: number } {
    return {
      ok: true,
      policy_hash: this.currentPolicy.hash,
      policy_error: this.policyError,
      open_requests: this.stores.requests.listInState(OPEN_STATES).length,
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
      is_drill: request.isDrill,
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
    const { requests, routes } = this.stores;
    const { directory } = this.people;
    const now = this.deps.clock.nowMs();
    const seen = new Set<string>();
    const items: InboxItem[] = [];
    for (const row of routes.openFor(userId)) {
      if (seen.has(row.request_id)) continue;
      seen.add(row.request_id);
      const request = requests.require(row.request_id);
      items.push({
        request_id: request.id,
        handle: row.handle,
        class: request.cls,
        tier: request.tier,
        what: inboxWhat(this.evidenceOf(request).description.headline),
        room: request.originRoom ? directory.roomName(request.originRoom) : null,
        age_s: Math.round((now - request.createdAtMs) / 1000),
        expires_at: new Date(request.expiresAtMs).toISOString(),
      });
    }
    return { user: userId, count: items.length, items, text: inboxText(items) };
  }

  personStats(userId: string): Record<string, unknown> | null {
    if (!this.people.directory.person(userId)) return null;
    const rows = this.stores.db
      .prepare(`SELECT decision, eligible, latency_ms FROM answers WHERE user_id = ?`)
      .all(userId) as { decision: string | null; eligible: number; latency_ms: number | null }[];
    const counted = rows.filter((row) => row.eligible === 1);
    const latencies = counted.flatMap((row) => (row.latency_ms === null ? [] : [row.latency_ms])).sort((a, b) => a - b);
    return {
      user: userId,
      answers: counted.length,
      approvals: counted.filter((row) => row.decision === "approve").length,
      denials: counted.filter((row) => row.decision === "deny").length,
      ineligible: rows.length - counted.length,
      median_latency_ms: latencies.length > 0 ? latencies[Math.floor((latencies.length - 1) / 2)] : null,
      open_cards: this.stores.routes.openCount(userId),
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
    switch (evaluation.decision) {
      case "allow":
        return this.allow(action, evaluation);
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
    if (person) store.noteActive(person.id, evt.roomId);
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
    if (answers.existsForCard(evt.switchRequestId)) return; // Redelivered.
    routes.close(card.id);

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
      this.reloadPolicyIfChanged();
      const { requests, grants, timers } = this.stores;
      const now = this.deps.clock.nowMs();
      for (const request of requests.listExpired(now)) await this.expire(request);
      grants.voidExpired();
      // A card that could not be opened (Switch down) is retried until the request expires.
      for (const request of requests.listInState(["HELD"])) await this.routeAndOpen(request, "primary");
      for (const timer of timers.due(now)) await this.fireEscalation(timer);
      for (const request of requests.listInState(["APPROVED"])) await this.retryExecution(request);
    } finally {
      this.ticking = false;
    }
  }

  close(): void {
    this.stores.db.close();
  }

  // ── Decisions ──────────────────────────────────────────────────────────────

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

    const write = this.stores.db.transaction((): { request: RequestRecord; isNew: boolean } => {
      const open = requests.findOpen(evaluation.callHash, action.agent.name);
      if (open) {
        this.recordAction(action, evaluation, open.id);
        return { request: open, isNew: false };
      }
      const created = requests.create(this.newRequest(action, evaluation, now));
      this.recordAction(action, evaluation, created.id);
      this.recordAggregates(action, evaluation, created.id);
      this.startLadder(created);
      return { request: created, isNew: true };
    });
    const { request, isNew } = write.immediate();
    if (isNew) await this.routeAndOpen(request, "primary");
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

  private newRequest(action: Action, evaluation: Evaluation, now: number): NewRequest {
    const policy = this.currentPolicy;
    const { directory, requesters } = this.people;
    const { aggregates } = this.stores;
    const clsName = evaluation.cls ?? evaluation.call.class;
    const cls = this.classOf(clsName);
    const tier = evaluation.tier ?? "high";
    const requesterIds = requesters.requestersOf(action.agent.name);
    const agentOwnerIds = directory.agentOwners(action.agent.name, action.agent.ownerUserId);
    const origin =
      action.session?.switchRoomId !== undefined
        ? { room: action.session.switchRoomId, thread: action.session.threadId ?? null }
        : requesters.lastOrigin(action.agent.name);

    const said = requesters.lastMessages(action.agent.name, origin?.room ?? null, origin?.thread ?? null, 2);
    const mismatches = detectMismatch({
      cls: clsName,
      extracted: evaluation.extracted,
      args: evaluation.call.args,
      target: evaluation.call.target,
      said: action.agentClaim ? [...said, action.agentClaim] : said,
      currency: policy.currency,
      services: Object.keys(this.team.owners.services),
    });

    const flags: Flag[] = [...evaluation.flags, ...mismatches];
    if (requesterIds.length === 0) flags.push(REQUESTER_UNKNOWN_FLAG);

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
      quorumRequired: cls?.approvers?.quorum[tier] ?? cls?.approvers?.quorum.default ?? 1,
      expiresAtMs: now + this.deps.clock.scaledMs(policy.requestTtlMs),
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
    const { requests, ledger, aggregates } = this.stores;
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
      const place = await this.tryOpen(request, trace, { kind: "room" }, async () => ({ roomId }), "group", null);
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
    const decision: AnswerDecision | null = normaliseAnswer(evt.answer);
    const record = (eligible: boolean, reason: string | null) =>
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

    record(true, null);
    ledger.append("answered", current.id, {
      answered_by: answeredBy,
      user_id: person.id,
      decision,
      latency_ms: now - card.notified_at,
      card_room: card.card_room,
    });
    if (current.state === "HELD") requests.transition(current.id, "ROUTED");

    if (decision === "deny") {
      requests.transition(current.id, "DENIED");
      ledger.append("denied", current.id, { denied_by: person.id, call_hash: current.callHash });
      aggregates.voidRequest(current.id);
      return { kind: "denied", person };
    }

    const counted = answers.countedApprovers(current.id);
    if (counted.length < current.quorumRequired) return { kind: "counted", person };

    requests.transition(current.id, "APPROVED");
    ledger.append("approved", current.id, {
      approved_by: counted,
      quorum: current.quorumRequired,
      call_hash: current.callHash,
    });
    if (current.source === "hook") {
      const ttl = this.deps.clock.scaledMs(this.currentPolicy.grantTtlMs);
      grants.mint(current.id, current.callHash, current.agent, ttl);
      requests.transition(current.id, "GRANTED");
    }
    return { kind: "approved", people: counted };
  }

  private async actOnVerdict(requestId: string, card: RouteRow, verdict: Verdict): Promise<void> {
    const request = this.stores.requests.require(requestId);
    switch (verdict.kind) {
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
      case "denied":
        await this.closeOpenCards(request);
        await this.notifyDenied(request, verdict.person);
        return;
      case "approved":
        await this.closeOpenCards(request);
        if (request.source === "hook") {
          const names = this.approverNames(verdict.people);
          await this.notifyAgent(request, `${request.id} approved by ${names}. Run the exact same command once.`);
        } else {
          await this.executeApproved(request);
        }
        return;
    }
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
    const reason = denialReason(request.flags);
    const because = reason ? `: ${reason}` : "";
    await this.notifyAgent(request, `${request.id} denied by ${person.name}${because}. Tell ${this.requesterWords(request)} and stop.`);
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
    const names = this.approverNames(answers.countedApprovers(request.id));
    if (result.ok) {
      const evidence = this.evidenceOf(request);
      const what = describeResult(request.cls, evidence.extracted, request.target, result.result, this.currentPolicy.currency);
      await this.notifyAgent(request, `${request.id} approved by ${names} and executed: ${what}. Continue.`);
    } else {
      const why = result.error ?? `the gate answered ${result.status ?? "with an error"}`;
      await this.notifyAgent(request, `${request.id} approved by ${names} but it did not run: ${why}. Tell ${this.requesterWords(request)} and stop.`);
    }
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
    return {
      requestId: request.id,
      policy: this.currentPolicy,
      directory,
      team: this.team,
      cls: this.classOf(request.cls),
      className: request.cls,
      tier: request.tier,
      quorumRequired: request.quorumRequired,
      requesterIds: request.requesterIds,
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
      },
      counted: answers.countedApprovers(request.id),
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
    if (!OPEN_STATES.includes(request.state)) return;
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
      }, step, id);
      if (!place) continue;
      opened += 1;
      const body = personBody?.(person) ?? `${request.id} needs your decision: ${headline}. The card is just above.`;
      await this.notifyCard(place, [person.userName], body);
    }
    const fallbackRoom = trace.fallback ? directory.roomId(trace.fallback.room) : null;
    const fallbackNames = userNames(trace.fallback?.eligible ?? []);
    if (trace.fallback && fallbackRoom && !openFallback) {
      const { group } = trace.fallback;
      const place = await this.tryOpen(request, trace, { kind: "fallback" }, async () => ({ roomId: fallbackRoom }), "fallback", null);
      if (place) {
        opened += 1;
        await this.notifyCard(place, fallbackNames, `${request.id} needs a decision from ${group}: ${headline}. The card is just above.`);
      }
    }
    const hasCopy = routes.forRequest(request.id).some((row) => row.step === "origin_copy");
    if (opened > 0 && request.originRoom && !hasCopy && request.originRoom !== fallbackRoom) {
      const originRoom = request.originRoom;
      const threadId = request.originThread ?? undefined;
      const place = await this.tryOpen(request, trace, { kind: "room" }, async () => ({ roomId: originRoom, threadId }), "origin_copy", null);
      const targets = trace.chosen.length > 0 ? userNames(trace.chosen) : fallbackNames;
      if (place) await this.notifyCard(place, targets, `${request.id} is waiting for a decision: ${headline}. The card is just above.`);
    }
    return opened;
  }

  /** Cards mention nobody, so whoever must decide is told by name. Targets are names Switch knows, not ids. */
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
    try {
      const { roomId, threadId } = await where();
      const result = await this.deps.chat.openCard({
        roomId,
        ...(threadId ? { threadId } : {}),
        kind: "approval",
        title,
        detail,
        options: CARD_OPTIONS,
        questions: [],
        expiresAtMs: request.expiresAtMs,
      });
      this.stores.routes.add({
        requestId: request.id,
        userId,
        step,
        cardRoom: roomId,
        sessionId: result.sessionId,
        switchRequestId: result.switchRequestId,
        handle: result.handle,
      });
      return { roomId, threadId };
    } catch {
      return null;
    }
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

  // ── @clearance commands ────────────────────────────────────────────────────

  private async handleCommand(evt: ChatMessageEvent, askerId: string | null): Promise<void> {
    const match = /^\s*@clearance\s+(\S+)(?:\s+(\S+))?/i.exec(evt.body);
    if (!match) return;
    const verb = (match[1] as string).toLowerCase();
    const argument = match[2];
    let reply: string | null = null;
    if (verb === "why" && argument) reply = this.whyReply(argument, askerId);
    if (verb === "status" && argument) reply = this.statusReply(argument);
    if (verb === "inbox" && askerId) reply = this.inbox(askerId)?.text ?? null;
    if (!reply) return;
    await this.deps.chat.postMessage({
      roomId: evt.roomId,
      body: reply,
      ...(evt.threadId ? { threadId: evt.threadId } : {}),
    });
  }

  /** A CLR id, or an answer handle like A12. */
  private findRequest(reference: string): RequestRecord | null {
    const { requests, routes } = this.stores;
    const direct = requests.get(reference.toUpperCase());
    if (direct) return direct;
    const found = routes.byHandle(reference);
    return found ? requests.get(found.request_id) : null;
  }

  private whyReply(reference: string, askerId: string | null): string {
    const request = this.findRequest(reference);
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

  private statusReply(reference: string): string {
    const request = this.findRequest(reference);
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

  private recordAction(action: Action, evaluation: Evaluation, requestId: string | null): void {
    this.stores.db
      .prepare(
        `INSERT OR IGNORE INTO actions (id, at, source, vendor, agent, kind, class, tier, score, call_hash, decision, step, request_id, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  private recordPolicyVersion(policy: CompiledPolicy): void {
    const { db, ledger } = this.stores;
    const latest = db.prepare(`SELECT hash FROM policy_versions ORDER BY loaded_at DESC, rowid DESC LIMIT 1`).get() as
      | { hash: string }
      | undefined;
    if (latest?.hash === policy.hash) return;
    const write = db.transaction(() => {
      db.prepare(`INSERT INTO policy_versions (hash, loaded_at, source) VALUES (?, ?, ?)`).run(
        policy.hash,
        this.deps.clock.nowMs(),
        policy.source,
      );
      ledger.append("policy_loaded", null, { hash: policy.hash, source: policy.source });
    });
    write.immediate();
  }

  private reloadPolicyIfChanged(): void {
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
      if (next.hash === this.currentPolicy.hash) return;
      this.currentPolicy = next;
      this.recordPolicyVersion(next);
    } catch (error) {
      // Keep enforcing the last good policy rather than running with none.
      this.policyError = (error as Error).message;
    }
  }
}

/** "REFUND ₹40,000" reads "refund ₹40,000" in a list. Only the class word is shouting; values keep their case. */
function inboxWhat(headline: string): string {
  return headline.replace(/^[A-Z]+(?: [A-Z]+)*(?= |$)/, (word) => word.toLowerCase());
}

function inboxAge(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}

/** Appendix D's inbox line. The handle appears when Switch gave one; the CLR id always does. */
function inboxText(items: InboxItem[]): string {
  const lines = items.map((item) => {
    const handle = item.handle ? `${item.handle} ` : "";
    const room = item.room ? ` · ${item.room}` : "";
    return `${handle}${item.request_id} ${item.what}${room} · ${inboxAge(item.age_s)}`;
  });
  return [`Needs your response (${items.length})`, ...lines].join(" · ");
}

export function createClearanceCore(deps: CoreDeps): Clearance {
  return new Clearance(deps);
}
