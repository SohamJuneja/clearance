/**
 * HTTP clients for the two systems behind the gate. Neither follows redirects: a redirect could
 * carry the custody key to another host, and a redirected check is not an answer from core.
 */
import { CheckResponseSchema, type Action, type CheckResponse } from "@clearance/contracts";

export type UpstreamResponse = {
  status: number;
  text: string;
  contentType: string | null;
  /** Parsed body when it is JSON, otherwise the text. */
  value: unknown;
};

/** `notSent` means Acme definitely never saw the request, so sending it later cannot duplicate it. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly notSent: boolean,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function connectionRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown } }).cause;
  return cause?.code === "ECONNREFUSED";
}

export class AcmeClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly adminKey: string,
    private readonly timeoutMs: number,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  /** `path` must be absolute and already validated. Concatenated, so it can never change the host. */
  async call(
    method: string,
    path: string,
    opts: { body?: string | null; idempotencyKey?: string } = {},
  ): Promise<UpstreamResponse> {
    const headers: Record<string, string> = {
      "x-acme-admin-key": this.adminKey,
      accept: "application/json",
    };
    if (opts.body !== undefined && opts.body !== null) headers["content-type"] = "application/json";
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: opts.body ?? undefined,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      throw new UpstreamError(
        connectionRefused(err) ? "acme refused the connection" : "acme did not answer",
        connectionRefused(err),
      );
    }
    const scrubbed = this.scrub(text);
    return {
      status: res.status,
      text: scrubbed,
      contentType: res.headers.get("content-type"),
      value: parseMaybeJson(scrubbed),
    };
  }

  /** The key must not leave the gate even if an upstream reflects it. */
  private scrub(text: string): string {
    return this.adminKey ? text.replaceAll(this.adminKey, "[redacted]") : text;
  }
}

export type CoreCheck = { ok: true; response: CheckResponse } | { ok: false; reason: string };
export type CoreRequest =
  | { ok: true; found: true; state: string; agent?: string; editedTo?: string }
  | { ok: true; found: false }
  | { ok: false; reason: string };

export class CoreClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  async check(action: Action): Promise<CoreCheck> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.base}/v1/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ action }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch {
      return { ok: false, reason: "core unreachable" };
    }
    if (res.status !== 200) return { ok: false, reason: `core answered ${res.status}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "core answered invalid JSON" };
    }
    const result = CheckResponseSchema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: "core answered the wrong shape" };
    return { ok: true, response: result.data };
  }

  /** What ran alone didn't go through. If core can't be told the agent still knows, from the gate's answer, so nothing waits on this. */
  async reportRunFailed(id: string, report: { never_ran: boolean; error: string }): Promise<void> {
    try {
      await fetch(`${this.base}/v1/requests/${encodeURIComponent(id)}/run-failed`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(report),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      console.error(`could not tell core that ${id} did not run: ${(error as Error).message}`);
    }
  }

  async request(id: string): Promise<CoreRequest> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.base}/v1/requests/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${this.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch {
      return { ok: false, reason: "core unreachable" };
    }
    if (res.status === 404) return { ok: true, found: false };
    if (res.status !== 200) return { ok: false, reason: `core answered ${res.status}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "core answered invalid JSON" };
    }
    const top = parsed as {
      state?: unknown;
      agent?: unknown;
      edited_to?: unknown;
      request?: { state?: unknown; agent?: unknown };
    } | null;
    const state = top?.state ?? top?.request?.state;
    if (typeof state !== "string") return { ok: false, reason: "core answered the wrong shape" };
    const agent = top?.agent ?? top?.request?.agent;
    return {
      ok: true,
      found: true,
      state,
      agent: typeof agent === "string" ? agent : undefined,
      ...(typeof top?.edited_to === "string" ? { editedTo: top.edited_to } : {}),
    };
  }
}
