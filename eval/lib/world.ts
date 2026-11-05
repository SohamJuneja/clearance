/**
 * The demo world as seen from outside: is each service up, what does Acme say happened, and what does
 * the ledger say. Used by the demo runner and the evals, so an assertion means the same in both.
 */
import { z } from "zod";
import { setting } from "./paths.ts";

export type ServiceName = "mattermost" | "acme" | "core" | "gate";

export const SERVICE_LABEL: Record<ServiceName, string> = {
  mattermost: "Mattermost",
  acme: "Acme",
  core: "clearance-core",
  gate: "clearance-gate",
};

export interface WorldUrls {
  mattermost: string;
  acme: string;
  core: string;
  gate: string;
}

export function defaultUrls(): WorldUrls {
  return {
    mattermost: setting("MATTERMOST_URL") ?? "http://127.0.0.1:8065",
    acme: `http://127.0.0.1:${setting("ACME_PORT") ?? "7800"}`,
    core: `http://127.0.0.1:${setting("CLEARANCE_CORE_PORT") ?? "7700"}`,
    gate: `http://127.0.0.1:${setting("CLEARANCE_GATE_PORT") ?? "7710"}`,
  };
}

const PROBE_PATH: Record<ServiceName, string> = {
  mattermost: "/api/v4/system/ping",
  acme: "/state",
  core: "/v1/health",
  gate: "/",
};

export interface ProbeResult {
  service: ServiceName;
  reachable: boolean;
  /** "Acme not reachable at http://127.0.0.1:7800 (ECONNREFUSED)" or "Acme reachable at ...". */
  message: string;
}

/**
 * Any HTTP answer counts as reachable, including a 401: the question here is whether something is
 * listening, and whether it lets us in is the next question.
 */
export async function probe(
  service: ServiceName,
  url: string,
  timeoutMs = 3_000,
): Promise<ProbeResult> {
  const label = SERVICE_LABEL[service];
  try {
    await fetch(`${url.replace(/\/$/, "")}${PROBE_PATH[service]}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { service, reachable: true, message: `${label} reachable at ${url}` };
  } catch (error) {
    return {
      service,
      reachable: false,
      message: `${label} not reachable at ${url} (${causeOf(error)})`,
    };
  }
}

function causeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string } }).cause;
  if (cause?.code) return cause.code;
  return (error as Error).name === "TimeoutError" ? "timed out" : (error as Error).message;
}

export class WorldError extends Error {
  override readonly name = "WorldError";
}

export interface WaitForOptions {
  timeoutMs: number;
  pollMs?: number;
  description: string;
}

/** Polls until `check` returns something other than undefined, or throws with the description. */
export async function waitUntil<T>(
  check: () => Promise<T | undefined>,
  options: WaitForOptions,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new WorldError(
        `waited ${(options.timeoutMs / 1000).toFixed(1)} s for ${options.description}, and it never happened`,
      );
    }
    await new Promise((done) => setTimeout(done, Math.min(options.pollMs ?? 500, remaining)));
  }
}

// ── Acme ─────────────────────────────────────────────────────────────────────

const RefundSchema = z
  .object({
    id: z.string(),
    order_id: z.string().optional(),
    customer_id: z.string().optional(),
    amount: z.number(),
    destination: z.string().optional(),
  })
  .passthrough();
export type AcmeRefund = z.infer<typeof RefundSchema>;

const DeploySchema = z
  .object({ service: z.string(), env: z.string(), version: z.string().optional() })
  .passthrough();
export type AcmeDeploy = z.infer<typeof DeploySchema>;

const EmailSchema = z.object({ to: z.string() }).passthrough();
export type AcmeEmail = z.infer<typeof EmailSchema>;

/**
 * `GET /state` per docs/integration-contract.md: money out, deploys, outbox, deleted records.
 * Every key is required. A default of [] here would let "no refund happened" pass against a state the
 * client simply failed to read, which is the one way this assertion must not be able to pass.
 */
const AcmeStateSchema = z
  .object({
    refunds: z.array(RefundSchema),
    deploys: z.array(DeploySchema),
    outbox: z.array(EmailSchema),
    deleted_records: z.array(z.unknown()),
  })
  .passthrough();
export type AcmeState = z.infer<typeof AcmeStateSchema>;

export function moneyOut(state: AcmeState): number {
  return state.refunds.reduce((sum, refund) => sum + refund.amount, 0);
}

export class AcmeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly adminKey: () => string | undefined = () => setting("ACME_ADMIN_KEY"),
  ) {}

  async state(): Promise<AcmeState> {
    const headers: Record<string, string> = {};
    const key = this.adminKey();
    if (key) headers["x-acme-admin-key"] = key;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/state`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new WorldError(`Acme not reachable at ${this.baseUrl} (${causeOf(error)})`);
    }
    if (!res.ok) throw new WorldError(`Acme GET /state answered ${res.status}`);
    const parsed = AcmeStateSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new WorldError(
        `Acme GET /state has an unexpected shape at "${issue?.path.join(".")}": ${issue?.message}`,
      );
    }
    return parsed.data;
  }

  /** Waits for a refund that wasn't in `before` and satisfies the predicate. */
  async waitForRefund(
    predicate: (refund: AcmeRefund) => boolean,
    options: WaitForOptions & { before: AcmeState },
  ): Promise<AcmeRefund> {
    const known = new Set(options.before.refunds.map((refund) => refund.id));
    return waitUntil(async () => {
      const state = await this.state();
      return state.refunds.find((refund) => !known.has(refund.id) && predicate(refund));
    }, options);
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────

const LedgerEntrySchema = z.object({ type: z.string() }).passthrough();
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

const LedgerSchema = z.union([
  z.array(LedgerEntrySchema),
  z.object({ entries: z.array(LedgerEntrySchema) }).transform((body) => body.entries),
]);

export class CoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: () => string | undefined = () => setting("CLEARANCE_INTERNAL_TOKEN"),
  ) {}

  private headers(): Record<string, string> {
    const token = this.token();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private async get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new WorldError(`clearance-core not reachable at ${this.baseUrl} (${causeOf(error)})`);
    }
    if (!res.ok) throw new WorldError(`clearance-core GET ${path} answered ${res.status}`);
    return res.json().catch(() => null);
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.get("/v1/health");
      return true;
    } catch {
      return false;
    }
  }

  async ledger(): Promise<LedgerEntry[]> {
    const parsed = LedgerSchema.safeParse(await this.get("/v1/ledger"));
    if (!parsed.success) {
      throw new WorldError("clearance-core GET /v1/ledger has an unexpected shape");
    }
    return parsed.data;
  }

  /** Waits for a ledger entry about this request, of this type. */
  async waitForLedger(
    predicate: (entry: LedgerEntry) => boolean,
    options: WaitForOptions,
  ): Promise<LedgerEntry> {
    return waitUntil(async () => (await this.ledger()).find(predicate), options);
  }

  /** Asks core to send one approver a drill now. A demo control, not a decision path. */
  async sendDrill(approver: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/drills/send`, {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ approver }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new WorldError(`clearance-core not reachable at ${this.baseUrl} (${causeOf(error)})`);
    }
    if (res.status === 404) {
      throw new WorldError(
        "clearance-core has no POST /v1/drills/send, so SC9 can't ask for a drill on demand yet",
      );
    }
    if (!res.ok) throw new WorldError(`clearance-core POST /v1/drills/send answered ${res.status}`);
  }
}
