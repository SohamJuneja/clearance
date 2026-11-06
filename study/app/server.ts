/**
 * The Approval Lab: one participant link runs the whole of PLAN 11.6.
 *
 * Plain node:http on purpose: no new dependencies, nothing to build, and it binds to 127.0.0.1 so the
 * only way in from outside is a tunnel somebody opened deliberately. All URLs the page uses are
 * relative, so it works behind cloudflared unchanged.
 *
 * Nothing is recorded before someone agrees to the consent text. Ground truth never leaves this
 * process until the debrief. Links are signed so a curious participant cannot edit p07 to p08 and
 * write into someone else's results.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BREAK_SECONDS,
  BRIEFING,
  CONFIDENCE_QUESTION,
  CONFIRM_FAILED,
  CONFIRM_REASK,
  CONSENT,
  CONSENT_AGREE,
  DEBRIEF_ACKNOWLEDGE,
  DEBRIEF_DATA,
  DEBRIEF_MISSED_INTRO,
  DEBRIEF_NONE_MISSED,
  DEBRIEF_THANKS,
  FAMILIARITY_QUESTION,
  FREE_TEXT_HINT,
  FREE_TEXT_QUESTION,
  LAB_TYPED_EMPTY,
  LAB_TYPED_HINT,
  REPLICA_NOTICE,
  ROLE_OPTIONS,
  STOP_KEEP_GOING,
  STOP_QUESTION,
  STOP_YES,
  STOPPED_MESSAGE,
} from "../lib/materials";
import { answerRecord, assignGroup, deriveStep, locate, resolveAnswer, type Sets, type Step } from "../lib/protocol";
import { DEFAULT_RESULTS_DIR, createResultsLog } from "../lib/results";
import { loadSet } from "../lib/sets";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, "public");

export { DEFAULT_RESULTS_DIR };

const STATIC_FILES: Record<string, string> = {
  "/static/app.js": "text/javascript; charset=utf-8",
  "/static/main.js": "text/javascript; charset=utf-8",
  "/static/style.css": "text/css; charset=utf-8",
};

const MAX_BODY_BYTES = 16 * 1024;
/** The longest time a card can record. The client stops its clock here, so anything over it is not a real timing. */
const MAX_CARD_MS = 60 * 60 * 1000;

export function linkToken(participant: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(participant).digest("hex").slice(0, 16);
  return `${participant}.${signature}`;
}

/** The participant a token is for, or null. Never says why a token failed. */
export function participantFromToken(token: string, secret: string): string | null {
  const participant = token.split(".")[0] ?? "";
  if (!/^p\d{2}$/.test(participant) || Number(participant.slice(1)) < 1) return null;
  const expected = Buffer.from(linkToken(participant, secret));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given) ? participant : null;
}

export const loadSets = (): Sets => ({ X: loadSet("X").requests, Y: loadSet("Y").requests, practice: loadSet("practice").requests });

export type LabOptions = {
  resultsDir: string;
  secret: string;
  /** Marks every event `synthetic: true`. Refused for the real results directory. */
  synthetic?: boolean;
  breakSeconds?: number;
  now?: () => Date;
};

const ConsentBody = z.object({ agreed: z.literal(true), role: z.enum(ROLE_OPTIONS), familiarity: z.number().int().min(1).max(5) });
const AnswerBody = z.object({
  request_id: z.string(),
  label: z.string().optional(),
  typed: z.string().max(200).optional(),
  ms: z.number().positive().max(MAX_CARD_MS),
  interrupted: z.boolean().default(false),
});
const ConfidenceBody = z.object({ block: z.number().int().min(1).max(2), value: z.number().int().min(1).max(5) });
const CommentBody = z.object({ text: z.string().max(2000) });

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, "body does not match");
  return parsed.data;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  // The link is the credential, so it must not leak in a Referer.
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Approval Lab</title>
<link rel="stylesheet" href="../static/style.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="../static/main.js"></script>
</body>
</html>
`;

const NOT_A_LINK = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Approval Lab</title></head><body><p>This isn't a valid study link. Please check the link you were sent.</p></body></html>`;

/** The fixed text the page shows, and the one limit it must keep to, so the client holds no copy of its own. */
const COPY = {
  consent: CONSENT,
  consentAgree: CONSENT_AGREE,
  briefing: BRIEFING,
  replicaNotice: REPLICA_NOTICE,
  typedHint: LAB_TYPED_HINT,
  typedEmpty: LAB_TYPED_EMPTY,
  stopQuestion: STOP_QUESTION,
  stopKeepGoing: STOP_KEEP_GOING,
  stopYes: STOP_YES,
  maxCardMs: MAX_CARD_MS,
  roles: ROLE_OPTIONS,
  familiarityQuestion: FAMILIARITY_QUESTION,
  confidenceQuestion: CONFIDENCE_QUESTION,
  freeTextQuestion: FREE_TEXT_QUESTION,
  freeTextHint: FREE_TEXT_HINT,
  debriefThanks: DEBRIEF_THANKS,
  debriefMissedIntro: DEBRIEF_MISSED_INTRO,
  debriefNoneMissed: DEBRIEF_NONE_MISSED,
  debriefAcknowledge: DEBRIEF_ACKNOWLEDGE,
  debriefData: DEBRIEF_DATA,
  stopped: STOPPED_MESSAGE,
};

export function createLabServer(options: LabOptions): Server {
  if (!options.secret) throw new Error("STUDY_LINK_SECRET must be set");
  const sets = loadSets();
  const breakSeconds = options.breakSeconds ?? BREAK_SECONDS;
  const { read: readEvents, record } = createResultsLog({ resultsDir: options.resultsDir, platform: "approval-lab", synthetic: options.synthetic, now: options.now });

  const stateFor = (participant: string): Step => deriveStep(readEvents(participant), participant, sets, breakSeconds);

  const handleAnswer = (participant: string, raw: string): { step: Step; notice?: string } => {
    const body = parseBody(AnswerBody, raw);
    const events = readEvents(participant);
    const step = deriveStep(events, participant, sets, breakSeconds);
    // A double tap or a stale page answers a card that has already moved on: ignore it.
    if ((step.step !== "card" && step.step !== "practice") || step.request_id !== body.request_id) return { step };

    const group = assignGroup(participant);
    const located = locate(sets, group, step);

    const outcome = resolveAnswer(located.request, located.condition, step.attempts, { label: body.label, typed: body.typed });
    if (outcome.kind === "invalid") throw new HttpError(400, outcome.reason);
    if (outcome.kind === "reask") {
      record(participant, { type: "confirm_wrong", request_id: body.request_id });
      return { step: stateFor(participant), notice: CONFIRM_REASK };
    }

    record(participant, answerRecord(group, step, located, outcome, { ms: body.ms, interrupted: body.interrupted }, body.typed !== undefined));
    const notice = outcome.decision === "confirm_failed" ? CONFIRM_FAILED : undefined;
    return { step: stateFor(participant), notice };
  };

  const handleApi = (participant: string, action: string, method: string, raw: string): { step: Step; notice?: string } => {
    if (action === "state" && method === "GET") return { step: stateFor(participant) };
    if (method !== "POST") throw new HttpError(405, "method not allowed");

    const current = stateFor(participant);
    if (action === "answer") return handleAnswer(participant, raw);
    if (action === "stop") {
      // Before consent there is nothing to keep, so nothing is written. After the end there is nothing to stop: a
      // second tab still showing a card must not turn a finished session into a stopped one.
      if (current.step !== "stopped" && current.step !== "consent" && current.step !== "debrief") record(participant, { type: "stopped" });
      return { step: current.step === "consent" ? current : stateFor(participant) };
    }
    if (action === "consent") {
      const body = parseBody(ConsentBody, raw);
      if (current.step !== "consent") return { step: current };
      record(participant, { type: "session_start", group: assignGroup(participant).group, platform: "approval-lab", schema: 1 });
      record(participant, { type: "consent", agreed: true, role: body.role, familiarity: body.familiarity });
      return { step: stateFor(participant) };
    }
    if (action === "briefing") {
      if (current.step === "briefing") record(participant, { type: "briefing_read" });
      return { step: stateFor(participant) };
    }
    if (action === "confidence") {
      const body = parseBody(ConfidenceBody, raw);
      if (current.step === "confidence" && current.block === body.block) record(participant, { type: "confidence", block: body.block, value: body.value });
      return { step: stateFor(participant) };
    }
    if (action === "break") {
      if (current.step === "break") record(participant, { type: "break_done" });
      return { step: stateFor(participant) };
    }
    if (action === "comment") {
      const body = parseBody(CommentBody, raw);
      if (current.step === "comment") {
        record(participant, { type: "comment", text: body.text });
        record(participant, { type: "session_end" });
      }
      return { step: stateFor(participant) };
    }
    throw new HttpError(404, "no such action");
  };

  return createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && STATIC_FILES[path]) {
        return send(res, 200, STATIC_FILES[path]!, readFileSync(resolve(PUBLIC_DIR, path.replace("/static/", "")), "utf8"));
      }

      const page = /^\/p\/([^/]+)$/.exec(path);
      if (page && method === "GET") {
        const valid = participantFromToken(page[1]!, options.secret);
        return valid ? send(res, 200, "text/html; charset=utf-8", INDEX_HTML) : send(res, 404, "text/html; charset=utf-8", NOT_A_LINK);
      }

      const api = /^\/api\/([^/]+)\/([a-z]+)$/.exec(path);
      if (api) {
        const participant = participantFromToken(api[1]!, options.secret);
        if (!participant) return sendJson(res, 404, { error: "not a study link" });
        const raw = method === "POST" ? await readBody(req) : "";
        const result = handleApi(participant, api[2]!, method, raw);
        return sendJson(res, 200, { ...result, copy: COPY });
      }

      return send(res, 404, "text/html; charset=utf-8", NOT_A_LINK);
    })().catch((error: unknown) => {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      // Loud on the server, and nothing about the internals on the wire.
      console.error("approval-lab: request failed:", error);
      return sendJson(res, 500, { error: "something went wrong, please reload" });
    });
  });
}

function main(): void {
  const envFile = resolve(here, "../../.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const secret = process.env.STUDY_LINK_SECRET ?? "";
  if (!secret || secret === "change-me") {
    console.error("STUDY_LINK_SECRET is missing or still the placeholder. Generate one with: openssl rand -hex 24");
    process.exit(1);
  }
  const dryRun = process.env.STUDY_DRY_RUN === "1";
  const resultsDir = process.env.STUDY_RESULTS_DIR ?? DEFAULT_RESULTS_DIR;
  const port = Number(process.env.STUDY_PORT ?? 7950);
  const server = createLabServer({ resultsDir, secret, synthetic: dryRun });
  server.listen(port, "127.0.0.1", () => {
    console.log(`approval-lab: listening on http://127.0.0.1:${port}`);
    console.log(`approval-lab: results go to ${resultsDir}${dryRun ? " (DRY RUN: every event is marked synthetic)" : ""}`);
    console.log("approval-lab: print participant links with: pnpm study:links <base-url>");
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
