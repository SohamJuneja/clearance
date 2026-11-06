/**
 * Core's HTTP client for the gate. Implements `GatePort` and `LookupPort` from contracts.
 *
 * `execute` throws when the gate can't be reached, so core keeps the approval and retries: exactly-once by
 * request id makes that safe. An answer from the gate that isn't a success stays `{ok:false, error}`, and core
 * voids on it, since retrying a refusal can't change it.
 * `lookup` returns null only for a real not-found and throws otherwise, so a gate that cannot
 * answer is never read as "this order does not exist".
 */
import {
  ExecuteResultSchema,
  GATE_WORDS,
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
    async execute(requestId: string, callHash: string, options?: { lookOnly?: boolean }): Promise<ExecuteResult> {
      const res = await fetch(`${base}/internal/execute/${encodeURIComponent(requestId)}`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ call_hash: callHash, ...(options?.lookOnly ? { look_only: true } : {}) }),
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
      // Not a result: a proxy, a rotated token, a gate falling over. That says nothing about the call, and an earlier
      // attempt may have run it, so it mustn't read as the gate having refused.
      throw new Error(`${GATE_WORDS.brokenAnswer} ${res.status}`);
    },

    async edit(requestId, edit) {
      const res = await fetch(`${base}/internal/edit/${encodeURIComponent(requestId)}`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          call_hash: edit.callHash,
          new_request_id: edit.newRequestId,
          new_call_hash: edit.newCallHash,
          amount: edit.amount,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(executeTimeoutMs),
      });
      // A gate that's broken hasn't refused anything, and asking again is safe.
      if (res.status >= 500) throw new Error(`gate answered ${res.status}`);
      const answer = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
      if (res.ok && answer?.ok === true) return { ok: true };
      return { ok: false, error: typeof answer?.error === "string" ? answer.error : `gate answered ${res.status}` };
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
