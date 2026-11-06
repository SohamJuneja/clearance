/**
 * The Desk's server. It serves the built page and a closed list of read routes. There is no generic
 * passthrough to core, so /v1/check, /v1/requests/:id/cancel and the hooks cannot be reached through it,
 * and nothing here can approve or deny anything. All actions happen in Switch.
 *
 * Binds to loopback, and refuses other Host headers, so a web page cannot use DNS rebinding to read core
 * through it. Someone who deliberately exposes the Desk has to name their host in DESK_ALLOWED_HOSTS.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { Meta } from "../shared/api";
import { composeAutonomy, composeLedger, composePeople, composePerson, composePolicy, composeQueue, composeVerify, CoreRefused, CoreShapeError, readCoverage, readHealth, replayScope, type WorldFiles } from "./compose";
import { CoreUnavailable, type CoreSource } from "./core-source";
import { ReplayScopeSchema, SimulationSchema } from "./schemas";
import { ledgerCsv } from "./team-view";

export type DeskOptions = WorldFiles & {
  core: CoreSource;
  /** Fixture mode. Sent to the page, which shows the SYNTHETIC banner. */
  synthetic: boolean;
  distDir: string;
  allowedHosts?: string[];
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function hostAllowed(req: IncomingMessage, extra: string[]): boolean {
  const header = req.headers.host;
  if (!header) return false;
  const hostname = header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : (header.split(":")[0] ?? "");
  return LOCAL_HOSTS.has(hostname) || extra.includes(hostname);
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createDeskServer(options: DeskOptions): Server {
  const { core } = options;
  const allowedHosts = options.allowedHosts ?? [];
  const distDir = resolve(options.distDir);

  const reads: Record<string, () => Promise<unknown>> = {
    "/api/health": () => readHealth(core),
    "/api/queue": () => composeQueue(core, options),
    "/api/ledger": () => composeLedger(core),
    "/api/ledger/verify": () => composeVerify(core),
    "/api/coverage": () => readCoverage(core),
    "/api/autonomy": () => composeAutonomy(core),
    "/api/people": () => composePeople(core),
    "/api/policy": () => composePolicy(core, options),
  };

  const serveFile = (res: ServerResponse, path: string): void => {
    const relative = path === "/" ? "index.html" : path.slice(1);
    const file = resolve(distDir, relative);
    const inside = file.startsWith(`${distDir}${sep}`);
    if (!inside || !existsSync(file)) {
      res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      // Vite hashes asset names, so they can be cached for good. The page itself never is.
      "cache-control": relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(readFileSync(file));
  };

  /**
   * The body, or null once this has answered for itself. Requiring JSON makes this a request another site cannot send
   * without a CORS preflight, which fails.
   */
  const readJson = async (req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | null> => {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
      sendJson(res, 415, { error: "expected JSON" });
      return null;
    }
    try {
      return { body: JSON.parse(await readBody(req)) as unknown };
    } catch (error) {
      if (error instanceof BodyTooLarge) sendJson(res, 413, { error: "That call is too large to simulate." });
      else sendJson(res, 400, { error: "That is not valid JSON." });
      return null;
    }
  };

  const handleSimulate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const read = await readJson(req, res);
    if (!read) return;
    const answer = await core.post("/v1/policy/simulate", read.body);
    if (answer.status === 400) {
      const reason = (JSON.parse(answer.body) as { error?: string }).error ?? "Core could not read that call.";
      return sendJson(res, 400, { error: reason });
    }
    if (answer.status !== 200) return sendJson(res, 502, { error: "core_error", message: `Core answered the simulation with HTTP ${answer.status}` });
    const parsed = SimulationSchema.safeParse(JSON.parse(answer.body));
    if (!parsed.success) return sendJson(res, 502, { error: "core_shape", message: "Core's simulation answer has an unexpected shape" });
    return sendJson(res, 200, parsed.data);
  };

  /** Forwards a scope and nothing else. Core's replay reads its history and writes nothing. */
  const handleReplay = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const read = await readJson(req, res);
    if (!read) return;
    const scope = ReplayScopeSchema.safeParse(read.body);
    if (!scope.success) return sendJson(res, 400, { error: "Expected an agent, class or bucket to replay." });
    return sendJson(res, 200, await replayScope(core, scope.data));
  };

  const handlePerson = async (res: ServerResponse, encoded: string): Promise<void> => {
    let id: string;
    try {
      id = decodeURIComponent(encoded);
    } catch {
      return sendJson(res, 404, { error: "No such person." });
    }
    const person = await composePerson(core, id);
    return person ? sendJson(res, 200, person) : sendJson(res, 404, { error: "No such person." });
  };

  const handleExport = async (res: ServerResponse): Promise<void> => {
    const { entries } = await composeLedger(core);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="clearance-ledger.csv"',
      "cache-control": "no-store",
    });
    res.end(`${options.synthetic ? "# SYNTHETIC fixture data\n" : ""}${ledgerCsv(entries)}`);
  };

  return createServer((req, res) => {
    void (async () => {
      if (!hostAllowed(req, allowedHosts)) return sendJson(res, 403, { error: "This host is not allowed. Set DESK_ALLOWED_HOSTS to expose the Desk." });
      const path = new URL(req.url ?? "/", "http://desk.invalid").pathname;
      const method = req.method ?? "GET";

      if (path.startsWith("/api/")) {
        if (path === "/api/policy/simulate" && method === "POST") return await handleSimulate(req, res);
        if (path === "/api/autonomy/simulate" && method === "POST") return await handleReplay(req, res);
        if (method !== "GET") return sendJson(res, 405, { error: "The Desk is read-only." });
        if (path === "/api/meta") return sendJson(res, 200, { synthetic: options.synthetic } satisfies Meta);
        if (path === "/api/export.csv") return await handleExport(res);
        const person = /^\/api\/people\/([^/]+)$/.exec(path);
        if (person) return await handlePerson(res, person[1]!);
        const read = reads[path];
        if (!read) return sendJson(res, 404, { error: "No such route." });
        return sendJson(res, 200, await read());
      }

      if (method !== "GET") return sendJson(res, 405, { error: "The Desk is read-only." });
      return serveFile(res, path);
    })().catch((error: unknown) => {
      if (error instanceof CoreUnavailable) return sendJson(res, 502, { error: "core_unreachable", message: error.message });
      if (error instanceof CoreRefused) return sendJson(res, 502, { error: "core_refused", message: error.message });
      if (error instanceof CoreShapeError) return sendJson(res, 502, { error: "core_shape", message: error.message });
      console.error("desk: request failed:", error);
      return sendJson(res, 500, { error: "desk_error", message: "The Desk hit an error. Its log has the details." });
    });
  });
}
