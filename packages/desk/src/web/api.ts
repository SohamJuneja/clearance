/** Fetching for the page. A failed read throws with core's own message, and the page shows it. */
import type { BucketReplay, SimulationResult } from "../shared/api";

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const data = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(data.message ?? data.error ?? `The Desk answered with HTTP ${res.status}`);
  return data;
}

async function postJson<T>(path: string, body: string): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body });
  const data = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(data.message ?? data.error ?? `The Desk answered with HTTP ${res.status}`);
  return data;
}

export const simulate = (body: string): Promise<SimulationResult> => postJson("/api/policy/simulate", body);

export const replay = (scope: { agent: string; class: string; bucket: string }): Promise<{ replays: BucketReplay[] }> => postJson("/api/autonomy/simulate", JSON.stringify(scope));
