/**
 * What the gate does, independent of transport. HTTP routes and MCP tools both call `perform`, so
 * there is one path through core's `check` and one place that holds or executes a call.
 */
import { GATE_WORDS, jobRoleFor, type Action, type ExecuteResult, type JobRole } from "@clearance/contracts";
import { ulid } from "ulid";
import type { GateConfig } from "./config.js";
import { AMOUNT_EDITABLE, LOOKUP_PATHS, OPERATIONS, type Operation } from "./operations.js";
import { GateStore, type HeldCall } from "./store.js";
import { AcmeClient, CoreClient, UpstreamError, type UpstreamResponse } from "./upstreams.js";

export type Principal = { agent: string; classes: readonly string[] };
export type Hints = { room?: string; thread?: string };

export type GateReply = {
  status: number;
  body: unknown;
  /** When set, send this text verbatim with `contentType` instead of serialising `body`. */
  raw?: { text: string; contentType: string | null };
  /** For the log. Never contains a secret. */
  logReason?: string;
};

const POLL_AFTER_S = 15;
/**
 * A refund makes at most four upstream calls, so these keep the worst case near 40 s, inside the
 * 50 s a gate call may take (Cursor's MCP calls die at 60 s and Codex's default to it).
 */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const UNAVAILABLE_TEXT =
  "Clearance is not available right now, so nothing was executed. Do not try another way. Try again later.";

const unavailable = (logReason: string): GateReply => ({
  status: 503,
  body: { status: "unavailable", message: UNAVAILABLE_TEXT },
  logReason,
});

const STATE_TO_STATUS: Record<string, string> = {
  HELD: "pending",
  ROUTED: "pending",
  APPROVED: "approved",
  BREAK_GLASS: "approved",
  GRANTED: "approved",
  EXECUTED: "executed",
  CONSUMED: "executed",
  EDITED: "edited",
  OUTCOME_UNKNOWN: "outcome_unknown",
  AUTO: "executed",
  DENIED: "denied",
  VOIDED: "denied",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
};

const plainRefusal = (agent: string, cls: string): string => `${agent} is not allowed to call ${cls} actions.`;

/**
 * F24: what a call outside an agent's job is told. It's a refusal whatever follows, and the words after the first sentence
 * only say where the work goes next. No role is read to reach this point and none can change it: this runs once the grant
 * has already said no. A class with no role, or a role the refused agent is itself meant to hold, leaves just the refusal.
 */
export function refusalFor(
  agent: string,
  cls: string,
  roleOf: (cls: string) => JobRole | null = jobRoleFor,
): { message: string; handoff?: { role: string; room: string; address: string } } {
  const plain = plainRefusal(agent, cls);
  const job = roleOf(cls);
  if (!job || job.grantHolders.includes(agent)) return { message: plain };
  const address = `@${job.role}`;
  return {
    message: `${plain} Nothing ran, and no approval changes this. That job belongs to the ${job.role} role: in #${job.room}, write ${address} with what is needed, who asked and why. Don't try it another way.`,
    handoff: { role: job.role, room: job.room, address },
  };
}

export class GateService {
  private readonly store: GateStore;
  private readonly acme: AcmeClient;
  private readonly core: CoreClient;
  /** Runs in progress in this process, so a racing execute can wait for the winner's result. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(config: GateConfig) {
    this.store = new GateStore(config.dbPath);
    this.acme = new AcmeClient(
      config.acmeUrl,
      config.acmeAdminKey,
      config.acmeTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    );
    this.core = new CoreClient(
      config.coreUrl,
      config.internalToken,
      config.coreTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    );
  }

  close(): void {
    this.store.close();
  }

  /** One gate call: scope, validate, ask core, then execute, hold or refuse. */
  async perform(
    principal: Principal,
    op: Operation,
    input: unknown,
    hints: Hints = {},
  ): Promise<GateReply> {
    if (!principal.classes.includes(op.cls)) {
      // The record says what the agent tried. Where the work may go next isn't part of that.
      await this.core.reportRefused(this.refusedAction(principal, op, input, hints), op.cls, plainRefusal(principal.agent, op.cls));
      return { status: 403, body: { status: "denied", ...refusalFor(principal.agent, op.cls) } };
    }
    const parsed = op.schema.safeParse(input);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return { status: 400, body: { status: "invalid", message } };
    }
    const args = await this.enrich(op, parsed.data);
    const endpoint = `${op.method} ${op.gatePath(args)}`;
    const verdict = await this.core.check(this.buildAction(principal, op, endpoint, args, hints));
    if (!verdict.ok) return unavailable(verdict.reason);

    const { decision, reason, request_id: requestId, call_hash: callHash } = verdict.response;
    if (decision === "deny") return { status: 403, body: { status: "denied", message: reason } };
    if (decision === "hold") {
      if (!requestId || !callHash)
        return unavailable("core held a call without request_id or call_hash");
      return this.hold(principal, op, args, requestId, callHash, reason);
    }
    // Only earned autonomy allows with a request id. Core has it down as having run, so it has to hear if it didn't.
    // The id goes along as the idempotency key, as it does for an approved call: the same request can't pay twice.
    try {
      const res = await this.send(op, args, requestId);
      if (requestId && res.status >= 400) {
        await this.core.reportRunFailed(requestId, { never_ran: res.status < 500, error: `acme answered ${res.status}` });
      }
      return {
        status: res.status,
        body: res.value,
        raw: { text: res.text, contentType: res.contentType },
      };
    } catch (err) {
      if (requestId) {
        const neverRan = err instanceof UpstreamError && err.notSent;
        await this.core.reportRunFailed(requestId, {
          never_ran: neverRan,
          error: neverRan ? "acme was not reached" : `${GATE_WORDS.outcomeUnknown}: acme did not answer`,
        });
      }
      return upstreamDown(err);
    }
  }

  /**
   * A refund's customer decides per-customer limits and its destination decides where the money
   * goes, so neither can be left to whether the agent chose to send it: core has to see the real
   * values, and they become part of the exact call that is held. A failed read leaves the gap for
   * core to see and hold on.
   */
  private async enrich(
    op: Operation,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (op.name !== "refund") return args;
    const filled = { ...args };
    if (filled.customer_id === undefined) {
      const path = `/orders/${encodeURIComponent(String(filled.order_id))}`;
      const customer = await this.readField(path, "customer_id");
      if (customer !== undefined) filled.customer_id = customer;
    }
    if (filled.destination === undefined && filled.customer_id !== undefined) {
      const path = `/customers/${encodeURIComponent(String(filled.customer_id))}`;
      const destination = await this.readField(path, "default_destination");
      if (destination !== undefined) filled.destination = destination;
    }
    return filled;
  }

  private async readField(path: string, field: string): Promise<string | undefined> {
    try {
      const res = await this.acme.call("GET", path);
      const value = (res.value as Record<string, unknown> | null)?.[field];
      return res.status === 200 && typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** What a refused call asked for, as far as it can be read. A body that doesn't parse is still a call that was tried. */
  private refusedAction(principal: Principal, op: Operation, input: unknown, hints: Hints): Action {
    const parsed = op.schema.safeParse(input);
    const args = (parsed.success ? parsed.data : {}) as Record<string, unknown>;
    let path: string = op.name;
    try {
      path = op.gatePath(args);
    } catch {
      // A path built from arguments it doesn't have. The operation's name says enough.
    }
    return this.buildAction(principal, op, `${op.method} ${path}`, args, hints);
  }

  private buildAction(
    principal: Principal,
    op: Operation,
    endpoint: string,
    args: Record<string, unknown>,
    hints: Hints,
  ): Action {
    const session = {
      ...(hints.room ? { switchRoomId: hints.room } : {}),
      ...(hints.thread ? { threadId: hints.thread } : {}),
    };
    return {
      id: ulid(),
      at: new Date().toISOString(),
      source: "gate",
      vendor: "gate",
      agent: { name: principal.agent },
      ...(Object.keys(session).length > 0 ? { session } : {}),
      kind: "business",
      raw: { method: op.method, path: endpoint.slice(op.method.length + 1), body: op.hasBody ? args : undefined },
      business: { endpoint, args },
    };
  }

  private hold(
    principal: Principal,
    op: Operation,
    args: Record<string, unknown>,
    requestId: string,
    callHash: string,
    reason: string,
  ): GateReply {
    let stored: boolean;
    try {
      stored = this.store.hold({
        request_id: requestId,
        call_hash: callHash,
        agent: principal.agent,
        operation: op.name,
        method: op.method,
        path: op.upstreamPath(args),
        body: JSON.stringify(args),
      });
    } catch {
      return unavailable("could not store the held call");
    }
    if (!stored) return unavailable("core reused a request id for a different call");
    return {
      status: 202,
      body: {
        status: "pending",
        request_id: requestId,
        poll_after_s: POLL_AFTER_S,
        message: reason,
      },
    };
  }

  private send(
    op: Operation,
    args: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<UpstreamResponse> {
    const body = op.upstreamBody(args);
    return this.acme.call(op.method, op.upstreamPath(args), {
      body: body === null ? null : JSON.stringify(body),
      idempotencyKey,
    });
  }

  /** What happened to a call, and nothing else: asking this can't start it. */
  async look(requestId: string, callHash: string): Promise<{ status: number; result: ExecuteResult }> {
    const row = this.store.get(requestId);
    if (!row) return { status: 404, result: { ok: false, alreadyExecuted: false, error: GATE_WORDS.unknownRequest } };
    if (row.call_hash !== callHash) {
      return { status: 409, result: { ok: false, alreadyExecuted: false, error: "call_hash does not match the stored call" } };
    }
    const running = this.inFlight.get(requestId);
    if (running) await running;
    const current = this.store.get(requestId) ?? row;
    if (current.state === "held") return { status: 409, result: { ok: false, alreadyExecuted: false, error: GATE_WORDS.nothingStarted } };
    return this.answerFromRow(current);
  }

  /** Execute-on-approval. Core asks; the gate runs exactly the stored call, at most once. */
  async execute(
    requestId: string,
    callHash: string,
  ): Promise<{ status: number; result: ExecuteResult }> {
    const claim = this.store.claim(requestId, callHash);
    switch (claim.kind) {
      case "unknown_request":
        return {
          status: 404,
          result: { ok: false, alreadyExecuted: false, error: GATE_WORDS.unknownRequest },
        };
      case "hash_mismatch":
        return {
          status: 409,
          result: {
            ok: false,
            alreadyExecuted: false,
            error: "call_hash does not match the stored call",
          },
        };
      case "existing": {
        const running = this.inFlight.get(requestId);
        if (running) await running;
        return this.answerFromRow(this.store.get(requestId) ?? claim.row);
      }
      case "claimed": {
        const run = this.run(claim.row);
        this.inFlight.set(requestId, run);
        try {
          return await run;
        } finally {
          this.inFlight.delete(requestId);
        }
      }
    }
  }

  /**
   * F20. Core has decided, and this is the last place that decision can be wrong, so the rules are checked again here:
   * only the amount, only on an operation that has one, and only down. The copy is the stored call with one field
   * changed, so nothing else an approver or a bug might send can reach Acme.
   */
  edit(
    requestId: string,
    input: { callHash: string; newRequestId: string; newCallHash: string; amount: number },
  ): { status: number; body: { ok: boolean; error?: string } } {
    const outcome = this.store.edit({
      requestId,
      callHash: input.callHash,
      newRequestId: input.newRequestId,
      newCallHash: input.newCallHash,
      build: (row) => {
        const op = OPERATIONS[row.operation as Operation["name"]];
        if (!op || !AMOUNT_EDITABLE.has(row.operation)) return { refused: `a ${row.operation} call has no amount to edit` };
        const args = JSON.parse(row.body ?? "{}") as Record<string, unknown>;
        const held = args.amount;
        if (typeof held !== "number" || input.amount >= held) return { refused: "an edit can only lower the amount" };
        const edited = op.schema.safeParse({ ...args, amount: input.amount });
        if (!edited.success) return { refused: "the edited call isn't valid" };
        return { path: op.upstreamPath(edited.data), body: JSON.stringify(edited.data) };
      },
    });
    switch (outcome.kind) {
      case "edited":
        return { status: 200, body: { ok: true } };
      case "unknown_request":
        return { status: 404, body: { ok: false, error: "unknown request" } };
      case "hash_mismatch":
        return { status: 409, body: { ok: false, error: "call_hash does not match the stored call" } };
      case "refused":
        return { status: 409, body: { ok: false, error: outcome.error } };
    }
  }

  private async run(row: HeldCall): Promise<{ status: number; result: ExecuteResult }> {
    const op = OPERATIONS[row.operation as Operation["name"]];
    if (!op) {
      const error = `outcome unknown: stored operation ${row.operation} is not recognised`;
      this.store.markUnknown(row.request_id, error);
      return { status: 409, result: { ok: false, alreadyExecuted: false, error } };
    }
    try {
      const args = JSON.parse(row.body ?? "{}") as Record<string, unknown>;
      const res = await this.send(op, args, row.request_id);
      const ok = res.status >= 200 && res.status < 300;
      // A 4xx is Acme saying no. A 5xx is Acme falling over, perhaps after doing it, so nobody can say.
      const error = ok ? undefined : res.status >= 500 ? `${GATE_WORDS.outcomeUnknown}: acme answered ${res.status}` : `upstream answered ${res.status}`;
      this.store.finish(row.request_id, { ok, status: res.status, result: res.value, error });
      return {
        status: 200,
        result: {
          ok,
          alreadyExecuted: false,
          status: res.status,
          result: res.value,
          ...(error ? { error } : {}),
        },
      };
    } catch (err) {
      if (err instanceof UpstreamError && err.notSent) {
        this.store.release(row.request_id);
        return {
          status: 502,
          result: {
            ok: false,
            alreadyExecuted: false,
            error: GATE_WORDS.nothingRan,
          },
        };
      }
      const error = `${GATE_WORDS.outcomeUnknown}: acme did not answer, so the gate will not run this again`;
      this.store.markUnknown(row.request_id, error);
      return { status: 502, result: { ok: false, alreadyExecuted: false, error } };
    }
  }

  private answerFromRow(row: HeldCall): { status: number; result: ExecuteResult } {
    if (row.state === "done") {
      return {
        status: 200,
        result: {
          ok: row.ok === 1,
          alreadyExecuted: true,
          status: row.result_status ?? undefined,
          result: row.result_json === null ? undefined : (JSON.parse(row.result_json) as unknown),
          ...(row.error ? { error: row.error } : {}),
        },
      };
    }
    const error =
      row.state === "unknown"
        ? (row.error ?? GATE_WORDS.outcomeUnknown)
        : row.state === "held"
          ? GATE_WORDS.nothingRan
          : GATE_WORDS.busy;
    return { status: 409, result: { ok: false, alreadyExecuted: false, error } };
  }

  async lookup(kind: string, id: string): Promise<GateReply> {
    const base = LOOKUP_PATHS[kind];
    if (!base) return { status: 404, body: { error: "unknown lookup kind" } };
    try {
      const res = await this.acme.call("GET", `${base}/${encodeURIComponent(id)}`);
      if (res.status === 404) return { status: 404, body: { error: "not found" } };
      if (res.status !== 200) return { status: 502, body: { error: "acme could not answer" } };
      return {
        status: 200,
        body: res.value,
        raw: { text: res.text, contentType: res.contentType },
      };
    } catch (err) {
      return upstreamDown(err);
    }
  }

  /** Plain read pass-through. `path` must already be validated by the caller. */
  async read(path: string): Promise<GateReply> {
    try {
      const res = await this.acme.call("GET", path);
      return {
        status: res.status,
        body: res.value,
        raw: { text: res.text, contentType: res.contentType },
      };
    } catch (err) {
      return upstreamDown(err);
    }
  }

  /** An agent may poll its own requests. Evidence stays with core; the agent gets state only. */
  async pending(principal: Principal, id: string): Promise<GateReply> {
    const row = this.store.get(id);
    const notFound: GateReply = {
      status: 404,
      body: { status: "not_found", message: `No such request: ${id}` },
    };
    if (row && row.agent !== principal.agent) return notFound;
    const answer = await this.core.request(id);
    if (!answer.ok) return unavailable(answer.reason);
    if (!answer.found) return notFound;
    if (answer.agent !== undefined && answer.agent !== principal.agent) return notFound;

    const status = STATE_TO_STATUS[answer.state] ?? "pending";
    const executed = row?.state === "done" && row.ok === 1;
    return {
      status: 200,
      body: {
        status,
        request_id: id,
        state: answer.state,
        message: pendingMessage(status, id, answer.editedTo),
        ...(answer.editedTo ? { edited_to: answer.editedTo } : {}),
        ...(status === "pending" ? { poll_after_s: POLL_AFTER_S } : {}),
        ...(executed ? { result: JSON.parse(row.result_json ?? "null") as unknown } : {}),
      },
    };
  }
}

function pendingMessage(status: string, id: string, editedTo?: string): string {
  if (status === "pending")
    return `PENDING ${id}: still waiting for approval. Do not try another way.`;
  if (status === "outcome_unknown")
    return `${id}: nobody can say whether it ran. Do not retry it. A person has to check.`;
  if (status === "edited")
    return `${id} did not run and will not. An approver edited it${editedTo ? ` to ${editedTo}` : ""}. Do not try it again.`;
  return `${id} is ${status}.`;
}

function upstreamDown(err: unknown): GateReply {
  return {
    status: 502,
    body: { status: "upstream_error", message: "Acme did not answer." },
    logReason: err instanceof Error ? err.message : "acme error",
  };
}
