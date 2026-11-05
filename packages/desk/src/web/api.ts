/** Fetching for the page. A failed read throws with core's own message, and the page shows it. */
import type { SimulationResult } from "../shared/api";

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const data = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(data.message ?? data.error ?? `The Desk answered with HTTP ${res.status}`);
  return data;
}

export async function simulate(body: string): Promise<SimulationResult> {
  const res = await fetch("/api/policy/simulate", { method: "POST", headers: { "content-type": "application/json" }, body });
  const data = (await res.json()) as SimulationResult & { error?: string; message?: string };
  if (!res.ok) throw new Error(data.message ?? data.error ?? `The Desk answered with HTTP ${res.status}`);
  return data;
}
