/**
 * The HTTP API (PLAN 6.7) except /v1/hooks/*, which come from @clearance/adapters and carry their own token
 * check. Everything here sits behind CLEARANCE_INTERNAL_TOKEN, not the hook token, because agents can read the
 * hook token. It is its own Fastify scope, so hook routes mounted on the returned app are not affected.
 * Anything unexpected is a non-200, which the gate treats as fail closed.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { ActionSchema, CheckRequestSchema, RefusedRequestSchema, RequestStateSchema } from "@clearance/contracts";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import type { Clearance } from "../core.js";
import { PolicyLoadError } from "../policy/load.js";
import type { LedgerMirror } from "../ledger/mirror.js";
import { DryRunBodySchema } from "../connector/dry-run.js";

export type ServerOptions = {
  /** CLEARANCE_INTERNAL_TOKEN. Gate and Desk send it as `Authorization: Bearer ...`. */
  internalToken: string;
  logger?: boolean;
  /** Without one, the mirror routes answer 404: the API still serves, and the ledger is still the ledger. */
  mirror?: Pick<LedgerMirror, "flush" | "status">;
};

function sameToken(given: string, expected: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** F22. Who requested and approved, the separation proof, times and hashes: NIST AC-5 and PCI DSS 6.x evidence. */
const AUDIT_COLUMNS = [
  "request_id",
  "class",
  "tier",
  "agent",
  "vendor",
  "target",
  "call_hash",
  "requested_by",
  "approved_by",
  "denied_by",
  "break_glass_by",
  "excluded_from_approving",
  "separation_holds",
  "quorum_required",
  "quorum_met",
  "state",
  "held_at",
  "decided_at",
  "executed_at",
  "last_ledger_hash",
  "edited_by",
  "edited_to",
  "edit_of",
] as const;

const DEFAULT_REPLAY = 100;
const MAX_REPLAY = 500;

const CancelBody = z.object({ by: z.string().optional() }).nullish();

/** From the gate: what ran alone didn't go through. `never_ran` means that's known; otherwise nobody can say. */
const RunFailedBody = z.object({ never_ran: z.boolean(), error: z.string().min(1).max(500) }).strict();

/** `approver` is what the demo client sends; `person` is the documented name. */
const DrillBody = z.object({ person: z.string().optional(), approver: z.string().optional(), flaw: z.string().optional() });

/** The read-only connector's views. A person is a team id, as in /v1/inbox. */
const PendingQuery = z.object({ person: z.string().min(1).max(128).optional() }).strict();
const TeamLedgerQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }).strict();

const LedgerQuery = z.object({
  request_id: z.string().optional(),
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(0).max(10_000).optional(),
});

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function badRequest(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(400).send({ error });
}

export function buildServer(core: Clearance, options: ServerOptions): FastifyInstance {
  if (!options.internalToken) throw new Error("buildServer needs the internal token: refusing to serve the API open");
  const app = Fastify({ logger: options.logger ?? false });

  void app.register(async (scope) => {
    scope.addHook("onRequest", async (request, reply) => {
      const header = request.headers.authorization ?? "";
      const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (!sameToken(given, options.internalToken)) await reply.code(401).send({ error: "unauthorized" });
    });

    scope.post("/v1/check", async (request, reply) => {
      const parsed = CheckRequestSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? "not a CheckRequest");
      return core.check(parsed.data.action);
    });

    scope.post("/v1/refused", async (request, reply) => {
      const parsed = RefusedRequestSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? "not a RefusedRequest");
      core.recordRefusal(parsed.data.action, parsed.data.class, parsed.data.reason);
      return { recorded: true };
    });

    scope.get("/v1/health", async () => core.health());

    scope.get<{ Querystring: { state?: string } }>("/v1/requests", async (request, reply) => {
      const { state } = request.query;
      if (state === undefined || state === "open") return { requests: core.listRequests(state) };
      const parsed = RequestStateSchema.safeParse(state);
      if (!parsed.success) return badRequest(reply, `no state ${state}`);
      return { requests: core.listRequests(parsed.data) };
    });

    scope.get("/v1/people", async () => ({ people: core.listPeople() }));
    scope.get("/v1/policy", async () => core.policyInfo());
    scope.get("/v1/shadow", async () => core.shadowLog());
    scope.get("/v1/metrics/human-load", async () => core.humanLoad());

    scope.get<{ Params: { id: string } }>("/v1/requests/:id", async (request, reply) => {
      const found = core.describeRequest(request.params.id);
      return found ?? reply.code(404).send({ error: `no request ${request.params.id}` });
    });

    scope.post<{ Params: { id: string } }>("/v1/requests/:id/cancel", async (request, reply) => {
      const body = CancelBody.safeParse(request.body);
      if (!body.success) return badRequest(reply, "bad body");
      const result = await core.cancel(request.params.id, body.data?.by ?? null);
      if (result === "not_found") return reply.code(404).send({ error: `no request ${request.params.id}` });
      if (result === "not_open") return reply.code(409).send({ error: `${request.params.id} is already decided` });
      return core.describeRequest(request.params.id);
    });

    scope.get<{ Querystring: { user?: string } }>("/v1/inbox", async (request, reply) => {
      const { user } = request.query;
      if (!user) return badRequest(reply, "user is required");
      const inbox = core.inbox(user);
      return inbox ?? reply.code(404).send({ error: `no person ${user}` });
    });

    scope.get("/v1/ledger", async (request, reply) => {
      const query = LedgerQuery.safeParse(request.query);
      if (!query.success) return badRequest(reply, "bad query");
      const { request_id: requestId, after, limit } = query.data;
      return {
        entries: core.stores.ledger.list({
          ...(requestId !== undefined ? { requestId } : {}),
          ...(after !== undefined ? { afterSeq: after } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      };
    });

    scope.get("/v1/ledger/verify", async () => core.verifyLedger());

    scope.get("/v1/ledger/mirror", async (_request, reply) =>
      options.mirror ? options.mirror.status() : reply.code(404).send({ error: "no ledger mirror is running" }),
    );

    scope.post("/v1/ledger/mirror", async (_request, reply) =>
      options.mirror ? options.mirror.flush() : reply.code(404).send({ error: "no ledger mirror is running" }),
    );

    scope.get<{ Querystring: { kind?: string } }>("/v1/export.csv", async (request, reply) => {
      const { kind } = request.query;
      if (kind !== undefined && kind !== "ledger" && kind !== "requests") return badRequest(reply, "kind is requests or ledger");
      void reply.type("text/csv; charset=utf-8");
      if (kind === "ledger") {
        const fields = ["seq", "at", "type", "request_id", "payload", "prev_hash", "entry_hash"] as const;
        const rows = core.stores.ledger.list().map((entry) => fields.map((field) => csvField(entry[field])).join(","));
        return [fields.join(","), ...rows].join("\n") + "\n";
      }
      const rows = core.auditRows();
      return [AUDIT_COLUMNS.join(","), ...rows.map((row) => AUDIT_COLUMNS.map((column) => csvField(row[column])).join(","))].join("\n") + "\n";
    });

    scope.get("/v1/digest", async () => core.digest());
    scope.get("/v1/roi", async () => core.roiReport());

    scope.get<{ Params: { id: string } }>("/v1/people/:id/stats", async (request, reply) => {
      const stats = core.personStats(request.params.id);
      return stats ?? reply.code(404).send({ error: `no person ${request.params.id}` });
    });

    scope.post<{ Params: { id: string } }>("/v1/requests/:id/run-failed", async (request, reply) => {
      const parsed = RunFailedBody.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, "body must be {never_ran, error}");
      const answer = await core.autoRunFailed(request.params.id, { neverRan: parsed.data.never_ran, error: parsed.data.error });
      return answer === "not_found" ? reply.code(404).send({ error: `no request ${request.params.id}` }) : { ok: answer === "recorded", answer };
    });

    scope.post("/v1/drills/send", async (request, reply) => {
      const body = DrillBody.safeParse(request.body);
      const person = body.success ? (body.data.person ?? body.data.approver) : undefined;
      if (!body.success || !person) return badRequest(reply, "person is required");
      if (!core.people.directory.person(person)) return reply.code(404).send({ error: `no person ${person}` });
      const result = await core.sendDrill(person, body.data.flaw);
      if (!result.ok) return reply.code(409).send({ error: result.reason });
      return { request_id: result.requestId };
    });

    scope.get("/v1/autonomy", async () => ({ ...core.autonomyReport(), buckets: await core.autonomyReplay() }));

    scope.post("/v1/autonomy/simulate", async (request, reply) => {
      const parsed = z
        .object({ agent: z.string().optional(), class: z.string().optional(), bucket: z.string().optional() })
        .strict()
        .safeParse(request.body ?? {});
      if (!parsed.success) return badRequest(reply, "expected {agent?, class?, bucket?}");
      return { replays: await core.autonomyReplay(parsed.data) };
    });

    scope.post("/v1/policy/propose", async (request, reply) => {
      const body = z
        .object({
          proposed_by: z.string().optional(),
          reason: z.string().optional(),
          policy: z.string().optional(),
          patch: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
        .safeParse(request.body);
      if (!body.success) return badRequest(reply, "expected {policy} or {patch}, with proposed_by and reason if you have them");
      const { proposed_by: proposedBy, reason, policy, patch } = body.data;
      const result = await core.proposePolicy({ proposedBy, reason, policy, patch });
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
      const { proposal } = result;
      return reply.code(202).send({ request_id: proposal.id, state: proposal.state, hash: proposal.payload.hash, quorum: proposal.quorum });
    });

    scope.post("/v1/policy/simulate", async (request, reply) => {
      const one = z.object({ action: ActionSchema }).safeParse(request.body);
      if (one.success) return core.simulate(one.data.action);
      const replay = z
        .object({ policy: z.string().optional(), last: z.number().int().min(1).max(MAX_REPLAY).optional() })
        .strict()
        .refine((body) => body.policy !== undefined || body.last !== undefined)
        .safeParse(request.body);
      if (!replay.success) return badRequest(reply, `expected {action}, or {policy?, last?} with last from 1 to ${MAX_REPLAY}`);
      try {
        return await core.replayPolicy({ policy: replay.data.policy, last: replay.data.last ?? DEFAULT_REPLAY });
      } catch (error) {
        if (error instanceof PolicyLoadError) return badRequest(reply, `line ${error.line}: ${error.message}`);
        throw error;
      }
    });

    scope.get("/v1/coverage", async () => core.coverage());

    // For the read-only connector (packages/mcp-connector, docs/mcp-connector.md). Behind this token like everything here, which
    // agents never hold, so no agent can list, explain or probe the classifier with a dry run. Each reads only; the dry run
    // records nothing. There is no route here to approve: an answer counts only from Switch's own approval_outcome event.
    scope.get("/v1/pending", async (request, reply) => {
      const query = PendingQuery.safeParse(request.query);
      if (!query.success) return badRequest(reply, "expected ?person=<team id> or nothing");
      const requests = core.pendingView(query.data.person);
      return requests ? { requests } : reply.code(404).send({ error: `no person ${query.data.person}` });
    });

    scope.get<{ Params: { id: string } }>("/v1/requests/:id/explain", async (request, reply) => {
      const found = core.explainRequest(request.params.id);
      return found ?? reply.code(404).send({ error: `no request ${request.params.id}` });
    });

    scope.get("/v1/ledger/team", async (request, reply) => {
      const query = TeamLedgerQuery.safeParse(request.query);
      if (!query.success) return badRequest(reply, "limit is from 1 to 200");
      return { entries: core.teamLedger(query.data.limit) };
    });

    scope.post("/v1/dry-run", async (request, reply) => {
      const body = DryRunBodySchema.safeParse(request.body);
      if (!body.success) return badRequest(reply, "expected {shell, agent?} or {operation, args, agent?}");
      const result = await core.dryRun(body.data);
      return result.ok ? result.answer : reply.code(result.status).send({ error: result.error });
    });
  });

  return app;
}
