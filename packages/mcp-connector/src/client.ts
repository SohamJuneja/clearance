/**
 * How the connector talks to core: GET and POST with the bearer token, a timeout, and zod on every answer. Anything other
 * than a well-formed answer is an error the tool reports, never data it guesses at. The token stays in this process.
 */
import type { z } from "zod";
import type { ConnectorConfig } from "./config.ts";

export type CoreErrorKind = "refused" | "unavailable" | "not_found" | "bad_request" | "no_route" | "bad_answer";

export class CoreError extends Error {
  readonly kind: CoreErrorKind;
  constructor(kind: CoreErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface CoreClient {
  get<T>(path: string, schema: z.ZodType<T>): Promise<T>;
  post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T>;
}

function errorText(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : undefined;
}

export function createCoreClient(config: Pick<ConnectorConfig, "coreUrl" | "token" | "timeoutMs">, fetchImpl: typeof fetch = fetch): CoreClient {
  const call = async <T>(method: "GET" | "POST", path: string, body: unknown, schema: z.ZodType<T>): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${config.coreUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      // The cause can carry the request, headers and all, so it stays out of the message.
      throw new CoreError("unavailable", `Clearance core is not answering at ${config.coreUrl}.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      parsed = null;
    }
    if (response.status === 401 || response.status === 403) {
      throw new CoreError("refused", "Clearance core refused the connector's token. It takes core's CLEARANCE_INTERNAL_TOKEN, and no agent's token.");
    }
    if (response.status === 404) {
      // Fastify's own answer for a path it has no route for, as an older core than this connector gives.
      const message = (parsed as { message?: unknown } | null)?.message;
      if (typeof message === "string" && message.startsWith("Route ")) {
        throw new CoreError("no_route", `This Clearance core has no ${method} ${path.split("?")[0]}: it is older than the connector. Update core.`);
      }
      throw new CoreError("not_found", errorText(parsed) ?? "Not found.");
    }
    if (response.status === 400) throw new CoreError("bad_request", errorText(parsed) ?? "Clearance core refused the request.");
    if (response.status < 200 || response.status >= 300) throw new CoreError("unavailable", `Clearance core answered ${response.status}.`);
    const checked = schema.safeParse(parsed);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new CoreError("bad_answer", `Clearance core's answer isn't what this connector expects${issue ? ` (${issue.path.join(".") || "body"}: ${issue.message})` : ""}.`);
    }
    return checked.data;
  };

  return {
    get: (path, schema) => call("GET", path, undefined, schema),
    post: (path, body, schema) => call("POST", path, body, schema),
  };
}
