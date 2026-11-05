import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A payload recorded off the live stack by the scripts in spikes/. */
export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as T;
}

/** A recorded frame, as a plain object to spread overrides onto. */
export const frame = (name: string): Record<string, unknown> => fixture<Record<string, unknown>>(name);

export type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  json: unknown;
};

type Stream = {
  query: URLSearchParams;
  headers: Record<string, string>;
  send: (name: string, data: unknown, id?: string | number) => void;
  /** Writes bytes as they would come off the socket, for malformed input. */
  raw: (text: string) => void;
  end: () => void;
  closed: boolean;
};

type Reply = { status: number; body?: unknown };
type Route = (call: Call) => Reply | undefined;

export const API_KEY = "test-api-key-not-a-real-one";
export const AGENT_ID = "agent-1";

/** Plays Switch's HTTP side in memory: records every call, and holds each stream open for a test to feed. */
export class FakeSwitch {
  readonly calls: Call[] = [];
  readonly streams: Stream[] = [];
  private routes: Route[] = [];
  /** Answers the next stream opens with this instead of a stream. */
  refuseOpens: Reply[] = [];

  /** First match wins, latest registered first. Unmatched calls answer 200 with `{}`. */
  on(route: Route): void {
    this.routes.unshift(route);
  }

  /** Routes matching a method and an exact path. */
  reply(method: string, path: string, reply: Reply | ((call: Call) => Reply)): void {
    this.on((call) => {
      if (call.method !== method || call.path !== path) return undefined;
      return typeof reply === "function" ? reply(call) : reply;
    });
  }

  paths(fragment: string): Call[] {
    return this.calls.filter((call) => call.path.includes(fragment));
  }

  /** Waits for the nth stream to be opened. */
  async stream(index: number, ms = 2000): Promise<Stream> {
    const deadline = Date.now() + ms;
    while (!this.streams[index]) {
      if (Date.now() > deadline) throw new Error(`stream ${index} was never opened`);
      await new Promise((done) => setTimeout(done, 5));
    }
    return this.streams[index];
  }

  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const call: Call = { method: init.method ?? "GET", path: url.pathname, query: url.searchParams, headers, json: body };
    this.calls.push(call);

    if (url.pathname.endsWith("/events")) {
      const refused = this.refuseOpens.shift();
      if (refused) return Response.json(refused.body ?? {}, { status: refused.status });
      return this.openStream(call, init.signal ?? undefined);
    }
    for (const route of this.routes) {
      const reply = route(call);
      if (reply) return Response.json(reply.body ?? {}, { status: reply.status });
    }
    return Response.json({}, { status: 200 });
  }) as typeof fetch;

  private openStream(call: Call, signal?: AbortSignal): Response {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
      },
    });
    const stream: Stream = {
      query: call.query,
      headers: call.headers,
      closed: false,
      send(name, data, id) {
        const lines = [];
        if (id !== undefined) lines.push(`id: ${id}`);
        lines.push(`event: ${name}`, `data: ${JSON.stringify(data)}`);
        controller.enqueue(encoder.encode(`${lines.join("\n")}\n\n`));
      },
      raw(text) {
        controller.enqueue(encoder.encode(text));
      },
      end() {
        if (stream.closed) return;
        stream.closed = true;
        controller.close();
      },
    };
    signal?.addEventListener(
      "abort",
      () => {
        if (stream.closed) return;
        stream.closed = true;
        controller.error(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
    this.streams.push(stream);
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
}

export async function until(what: string, condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

export const quietLogger = () => {
  const lines: string[] = [];
  return { lines, warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
};
