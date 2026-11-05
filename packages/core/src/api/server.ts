/**
 * The HTTP API (PLAN 6.7) except /v1/hooks/*, which come from @clearance/adapters and carry their own token
 * check. Everything here sits behind CLEARANCE_INTERNAL_TOKEN, not the hook token, because agents can read the
 * hook token. It is its own Fastify scope, so hook routes mounted on the returned app are not affected.
 * Anything unexpected is a non-200, which the gate treats as fail closed.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { ActionSchema, CheckRequestSchema } from "@clearance/contracts";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import type { Clearance } from "../core.js";

export type ServerOptions = {
  /** CLEARANCE_INTERNAL_TOKEN. Gate and Desk send it as `Authorization: Bearer ...`. */
  internalToken: string;
  logger?: boolean;
};

function sameToken(given: string, expected: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const CancelBody = z.object({ by: z.string().optional() }).nullish();

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

    scope.get("/v1/health", async () => core.health());

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

    scope.get("/v1/export.csv", async (_request, reply) => {
      const fields = ["seq", "at", "type", "request_id", "payload", "prev_hash", "entry_hash"] as const;
      const rows = core.stores.ledger.list().map((entry) => fields.map((field) => csvField(entry[field])).join(","));
      void reply.type("text/csv; charset=utf-8");
      return [fields.join(","), ...rows].join("\n") + "\n";
    });

    scope.get<{ Params: { id: string } }>("/v1/people/:id/stats", async (request, reply) => {
      const stats = core.personStats(request.params.id);
      return stats ?? reply.code(404).send({ error: `no person ${request.params.id}` });
    });

    scope.get("/v1/autonomy", async () => ({ levels: core.stores.autonomy.all() }));

    scope.post("/v1/autonomy/simulate", async (_request, reply) =>
      reply.code(501).send({ error: "autonomy replay is not built yet" }),
    );

    scope.post("/v1/policy/simulate", async (request, reply) => {
      const parsed = z.object({ action: ActionSchema }).safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? "expected {action}");
      return core.simulate(parsed.data.action);
    });

    scope.get("/v1/coverage", async () => core.coverage());
  });

  return app;
}
