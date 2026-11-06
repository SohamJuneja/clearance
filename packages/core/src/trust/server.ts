/**
 * F21: the listener for Switch's Trust setting. It has this one route and no way to reach core, so it can't read a
 * request or change a decision however it's called. It's a listener of its own because Switch runs in Docker and core's
 * API is on loopback: making this reachable shouldn't make the rest of the API reachable too.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { checkMessages } from "./pressure.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7701;
const POLICY_NAME = "clearance-pressure";

/** What Switch sends (trust/client.py). Extra fields are Switch's business, so they're let through. */
const CheckBody = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
});

function sameKey(given: string, expected: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** Null is off, which is the default: no key, the placeholder, or a port that can't be one. */
export function trustListenFrom(env: Record<string, string | undefined>): { key: string; host: string; port: number } | null {
  const key = env.CLEARANCE_TRUST_KEY;
  if (!key || key === "change-me") return null;
  const port = Number(env.CLEARANCE_TRUST_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { key, host: env.CLEARANCE_TRUST_HOST || DEFAULT_HOST, port };
}

export function buildTrustServer(key: string): FastifyInstance {
  if (!key) throw new Error("buildTrustServer needs a key: refusing to serve the check open");
  const app = Fastify({ logger: false });
  app.post("/guardrails/check", async (request, reply) => {
    const given = request.headers["x-flintai-api-key"];
    if (typeof given !== "string" || !sameKey(given, key)) return reply.code(401).send({ error: "unauthorized" });
    const parsed = CheckBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "body must be {messages: [{role, content}]}" });
    const policyId = request.headers["x-guardrails-policy-id"];
    return {
      ...checkMessages(parsed.data.messages),
      policy_id: typeof policyId === "string" ? policyId : POLICY_NAME,
      policy_name: POLICY_NAME,
    };
  });
  return app;
}
