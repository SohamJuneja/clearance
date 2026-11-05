/**
 * Core's HTTP client for the gate. Implements `GatePort` and `LookupPort` from contracts.
 *
 * `execute` never throws: core gets `{ok:false, error}` and exactly-once still holds on a retry.
 * `lookup` returns null only for a real not-found and throws otherwise, so a gate that cannot
 * answer is never read as "this order does not exist".
 */
import {
  ExecuteResultSchema,
  type ExecuteResult,
  type GatePort,
  type LookupPort,
} from "@clearance/contracts";

export type GateClientOptions = {
  baseUrl: string;
  internalToken: string;
  executeTimeoutMs?: number;
  lookupTimeoutMs?: number;
};

export type GateClient = GatePort & LookupPort;

export function createGateClient(options: GateClientOptions): GateClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const authorization = `Bearer ${options.internalToken}`;
  const executeTimeoutMs = options.executeTimeoutMs ?? 30_000;
  const lookupTimeoutMs = options.lookupTimeoutMs ?? 5_000;

  return {
    async execute(requestId: string, callHash: string): Promise<ExecuteResult> {
      try {
        const res = await fetch(`${base}/internal/execute/${encodeURIComponent(requestId)}`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ call_hash: callHash }),
          redirect: "error",
          signal: AbortSignal.timeout(executeTimeoutMs),
        });
        const text = await res.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        const result = ExecuteResultSchema.safeParse(parsed);
        if (result.success) return result.data;
        return {
          ok: false,
          alreadyExecuted: false,
          status: res.status,
          error: `gate answered ${res.status}`,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : "unknown error";
        return { ok: false, alreadyExecuted: false, error: `gate unreachable: ${reason}` };
      }
    },

    async lookup(kind: string, id: string): Promise<Record<string, unknown> | null> {
      const res = await fetch(
        `${base}/internal/lookup/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
        {
          headers: { authorization },
          redirect: "error",
          signal: AbortSignal.timeout(lookupTimeoutMs),
        },
      );
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`gate lookup answered ${res.status}`);
      const value: unknown = await res.json();
      if (value === null || typeof value !== "object")
        throw new Error("gate lookup did not answer with an object");
      return value as Record<string, unknown>;
    },
  };
}
