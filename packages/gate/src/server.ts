/**
 * clearance-gate's HTTP surface, per docs/integration-contract.md. Agents authenticate with a
 * per-agent token; core authenticates on /internal/* with the internal token. Neither token, nor
 * the Acme admin key, is ever logged or returned.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { z } from "zod";
import type { GateConfig } from "./config.js";
import { mountMcp } from "./mcp.js";
import { OPERATIONS } from "./operations.js";
import { GateService, type GateReply, type Hints, type Principal } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export type GateServerOptions = { logger?: FastifyServerOptions["logger"] };

const MAX_HINT_LENGTH = 512;
const ExecuteBody = z.object({ call_hash: z.string().min(1) }).strict();
const EditBody = z
  .object({
    call_hash: z.string().min(1),
    new_request_id: z.string().min(1).max(64),
    new_call_hash: z.string().min(1),
    amount: z.number().int().positive().safe(),
  })
  .strict();

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  const match = header ? /^bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

function hintFrom(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_HINT_LENGTH
    ? value
    : undefined;
}

function hintsOf(req: FastifyRequest): Hints {
  return {
    room: hintFrom(req.headers["x-clearance-room"]),
    thread: hintFrom(req.headers["x-clearance-thread"]),
  };
}

function sendReply(reply: FastifyReply, out: GateReply, log: FastifyBaseLogger): FastifyReply {
  if (out.logReason)
    log.warn({ reason: out.logReason, status: out.status }, "gate call not completed");
  reply.status(out.status);
  if (out.raw) {
    reply.header("content-type", out.raw.contentType ?? "text/plain; charset=utf-8");
    return reply.send(out.raw.text);
  }
  return reply.send(out.body);
}

/**
 * A read path may only be segments that stay under Acme's root once decoded. `//` is refused too:
 * it would read as a host if anything downstream ever resolved it as a URL.
 */
function safeReadPath(rawUrl: string): string | null {
  const stripped = rawUrl.slice("/acme".length);
  const queryAt = stripped.indexOf("?");
  const path = queryAt === -1 ? stripped : stripped.slice(0, queryAt);
  if (!path.startsWith("/") || path.length < 2 || path.includes("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (/[\x00-\x1f\\]/.test(decoded)) return null;
  if (decoded.split("/").some((segment) => segment === ".." || segment === ".")) return null;
  return stripped;
}

export function buildGateServer(
  config: GateConfig,
  options: GateServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const service = new GateService(config);
  const internalDigest = sha256(config.internalToken);
  // Keyed by digest so a lookup does not compare a guess against a token byte by byte.
  const principals = new Map<string, Principal>(
    Object.entries(config.agentTokens).map(([token, grant]) => [
      sha256(token).toString("hex"),
      { agent: grant.agent, classes: grant.classes },
    ]),
  );

  app.addHook("onClose", async () => service.close());
  app.decorateRequest("principal", null);

  const unauthorized = (reply: FastifyReply) =>
    reply.status(401).send({ status: "unauthorized", message: "Missing or invalid token." });

  const requireAgent = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(req);
    const principal = token ? principals.get(sha256(token).toString("hex")) : undefined;
    if (!principal) return unauthorized(reply);
    req.principal = principal;
  };

  const requireInternal = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(req);
    if (!token || !timingSafeEqual(sha256(token), internalDigest)) return unauthorized(reply);
  };

  // Anything unexpected on a route is reported without detail. A 5xx here may follow a failed
  // store or parse, and every such failure means nothing was executed.
  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ reason: err.message }, "gate route failed");
      return reply
        .status(503)
        .send({ status: "unavailable", message: "The gate could not complete this call." });
    }
    return reply.status(status).send({ status: "invalid", message: err.message });
  });

  app.get("/health", async () => ({ ok: true }));

  for (const op of Object.values(OPERATIONS)) {
    app.route({
      method: op.method,
      url: op.route,
      onRequest: requireAgent,
      handler: async (req, reply) => {
        const input = op.hasBody ? req.body : req.params;
        const out = await service.perform(req.principal!, op, input, hintsOf(req));
        return sendReply(reply, out, req.log);
      },
    });
  }

  app.get("/acme/*", { onRequest: requireAgent }, async (req, reply) => {
    const path = safeReadPath(req.url);
    if (!path) return reply.status(400).send({ status: "invalid", message: "Bad path." });
    return sendReply(reply, await service.read(path), req.log);
  });

  app.get<{ Params: { id: string } }>(
    "/pending/:id",
    { onRequest: requireAgent },
    async (req, reply) =>
      sendReply(reply, await service.pending(req.principal!, req.params.id), req.log),
  );

  app.post<{ Params: { requestId: string } }>(
    "/internal/execute/:requestId",
    { onRequest: requireInternal },
    async (req, reply) => {
      const body = ExecuteBody.safeParse(req.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ ok: false, alreadyExecuted: false, error: "body must be {call_hash}" });
      }
      const { status, result } = await service.execute(req.params.requestId, body.data.call_hash);
      return reply.status(status).send(result);
    },
  );

  app.post<{ Params: { requestId: string } }>(
    "/internal/edit/:requestId",
    { onRequest: requireInternal },
    async (req, reply) => {
      const body = EditBody.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({ ok: false, error: "body must be {call_hash, new_request_id, new_call_hash, amount}" });
      }
      const { status, body: answer } = service.edit(req.params.requestId, {
        callHash: body.data.call_hash,
        newRequestId: body.data.new_request_id,
        newCallHash: body.data.new_call_hash,
        amount: body.data.amount,
      });
      return reply.status(status).send(answer);
    },
  );

  app.get<{ Params: { kind: string; id: string } }>(
    "/internal/lookup/:kind/:id",
    { onRequest: requireInternal },
    async (req, reply) =>
      sendReply(reply, await service.lookup(req.params.kind, req.params.id), req.log),
  );

  mountMcp(app, service, requireAgent, hintsOf);

  return app;
}
