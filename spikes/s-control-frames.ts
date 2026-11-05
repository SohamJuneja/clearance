/**
 * The control paths the client depends on, as the real server behaves: a takeover, a resume past the
 * end, refused heartbeats, a reopen with the same connection id. Records fixtures for the contract tests.
 */
import { randomUUID } from "node:crypto";
import { createParser } from "../packages/switch-agent/node_modules/eventsource-parser/dist/index.js";
import { BRIDGE_URL, identities, say, secrets, sleep, writeFixture } from "./lib.js";

const agentId = identities.agents.clearance!.switchAgentId;
const key = secrets.switchAgentKeys.clearance!;

type Open = { frames: { event?: string; data: Record<string, unknown> }[]; cancel: () => void; status: number };

async function open(params: Record<string, string>): Promise<Open> {
  const controller = new AbortController();
  const query = new URLSearchParams({ scope: "all", filter: "all", protocol: "9", protocol_accepts: "9", ...params });
  const res = await fetch(`${BRIDGE_URL}/agents/${agentId}/events?${query.toString()}`, {
    headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" },
    signal: controller.signal,
  });
  const frames: Open["frames"] = [];
  if (res.ok && res.body) {
    const parser = createParser({ onEvent: (event) => frames.push({ event: event.event, data: JSON.parse(event.data) as Record<string, unknown> }) });
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) parser.feed(decoder.decode(chunk, { stream: true }));
      } catch {
        // Cancelled.
      }
    })();
  } else {
    say(`open refused: ${res.status} ${(await res.text()).slice(0, 400)}`);
  }
  return { frames, cancel: () => controller.abort(), status: res.status };
}

async function beat(connectionId: string, generation: number | null) {
  const res = await fetch(`${BRIDGE_URL}/agents/${agentId}/connection/beat`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ connection_id: connectionId, generation }),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

// A heartbeat for a connection that never existed.
const unknown = await beat(randomUUID(), 1);
say(`beat on an unknown connection: ${JSON.stringify(unknown)}`);
writeFixture("beat_unknown", unknown);

// Open, read connection_state, beat.
const connectionId = randomUUID();
const first = await open({ connection_id: connectionId, start_at: "head" });
await sleep(500);
const state = first.frames[0]!.data;
const generation = Number(state.generation);
say(`beat ok: ${JSON.stringify(await beat(connectionId, generation))}`);
const fenced = await beat(connectionId, null);
say(`beat without a generation, having declared revision 9: ${JSON.stringify(fenced)}`);
writeFixture("beat_unfenced", fenced);

// A second stream on the same id, stating the incarnation it holds: a clean reattach.
const second = await open({ connection_id: connectionId, start_at: "head", expected_generation: String(generation) });
await sleep(500);
const evicted = first.frames.find((frame) => frame.event === "evicted");
say(`the first stream was told: ${JSON.stringify(evicted?.data)}`);
if (evicted) writeFixture("evicted_taken_over", evicted.data);
const stale = await beat(connectionId, generation);
say(`beat from the displaced incarnation: ${JSON.stringify(stale)}`);
writeFixture("beat_taken_over", stale);
const staleOpen = await open({ connection_id: connectionId, start_at: "head", expected_generation: String(generation) });
say(`reattach naming the old incarnation: HTTP ${staleOpen.status}`);

// The socket drops and the connection waits out its window: a beat now finds no stream.
const secondGeneration = Number(second.frames[0]!.data.generation);
second.cancel();
await sleep(800);
const noStream = await beat(connectionId, secondGeneration);
say(`beat with no stream attached: ${JSON.stringify(noStream)}`);
writeFixture("beat_no_stream", noStream);

// Reopen with the same id and a position past the end of everything.
const past = await open({ connection_id: connectionId, start_at: JSON.stringify({ s: Number.MAX_SAFE_INTEGER - 1 }) });
await sleep(800);
const gap = past.frames.find((frame) => frame.event === "gap");
say(`resuming past the end: ${JSON.stringify(past.frames.map((frame) => frame.event))}`);
if (gap) writeFixture("gap", gap.data);
past.cancel();
