// Spike S1/S5/S9: a tiny local server for vendor hooks to call.
//
//   node spikes/echo-hook-server.mjs [--port 7790] [--log-dir <dir>]
//
// The URL path picks the behaviour, so each spike directory's hook config picks its own:
//   /hook/log         log only, answer {} (no decision)
//   /hook/deny-push   deny any Bash command that runs `git push`
//   /hook/held        same match, but answer the HELD text from PLAN 8.5, unless a grant is open
//   /control/approve  open a one-shot grant for /hook/held; /control/hold closes it
//   /hook/http500     answer 500 (fail-mode test)
//   /hook/slow        answer after 30 s (timeout fail-mode test)
//   /hook/cursor-deny /hook/codex-deny   same match, in that vendor's response shape
//
// Every request is appended to <log-dir>/hook-calls.jsonl. The Authorization header
// is never logged: only whether it was present, its length, and whether it matches
// CLEARANCE_HOOK_TOKEN from the repo's .env.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readEnvFile } from './switch-api.mjs';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '7790' },
    'log-dir': { type: 'string', default: '/home/prashant/projects/Clearance/data/spike-logs' },
    env: { type: 'string', default: '/home/prashant/projects/Clearance/.env' },
  },
});

const logDir = values['log-dir'];
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, 'hook-calls.jsonl');
const expected = existsSync(values.env) ? readEnvFile(values.env).CLEARANCE_HOOK_TOKEN : undefined;

const DENY_REASON =
  'Blocked by the spike echo server: git push needs approval (spike reason code SPIKE-DENY-7731).';
const HELD_REASON =
  'HELD CLR-0042: needs approval. Do not try another way. Tell the person it is waiting and give the id, then stop.';

const isPush = (body) => {
  const command =
    body?.tool_input?.command ?? // Claude Code, Codex, OpenCode bridge
    body?.command ?? // Cursor beforeShellExecution
    '';
  return /\bgit\b[^|;&]*\bpush\b/.test(String(command));
};

const claudeDeny = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

const claudeAllow = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: reason,
  },
});

// Grants left for /hook/held. /control/approve sets it to one, as a real approval would.
let grants = 0;

function authSummary(req) {
  const header = req.headers.authorization;
  if (header === undefined) return { present: false };
  const token = header.replace(/^Bearer\s*/i, '');
  return {
    present: true,
    bearer_length: token.length,
    literal_placeholder: token.startsWith('$'),
    matches_clearance_hook_token: expected !== undefined && token === expected,
  };
}

function scrubHeaders(headers) {
  const { authorization: _authorization, cookie: _cookie, ...rest } = headers;
  return rest;
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { unparsed: raw.slice(0, 2000) };
    }
    const path = new URL(req.url, 'http://local').pathname;
    let status = 200;
    let answer = {};
    let delayMs = 0;
    switch (path) {
      case '/hook/log':
        break;
      case '/hook/deny-push':
        if (isPush(body)) answer = claudeDeny(DENY_REASON);
        break;
      case '/hook/held':
        if (isPush(body)) {
          if (grants > 0) {
            grants -= 1;
            answer = claudeAllow('CLR-0042 approved: one retry.');
          } else {
            answer = claudeDeny(HELD_REASON);
          }
        }
        break;
      case '/control/approve': // One-shot grant, as Clearance would issue on approval.
        grants = 1;
        answer = { grants };
        break;
      case '/control/hold':
        grants = 0;
        answer = { grants };
        break;
      case '/hook/http500':
        status = 500;
        answer = { error: 'spike 500' };
        break;
      case '/hook/slow':
        delayMs = 30_000;
        break;
      default:
        status = 404;
        answer = { error: 'unknown spike path' };
    }
    const record = {
      at: new Date().toISOString(),
      method: req.method,
      path,
      headers: scrubHeaders(req.headers),
      authorization: authSummary(req),
      body,
      answered: { status, answer, delayMs },
    };
    appendFileSync(logFile, `${JSON.stringify(record)}\n`);
    const event = body?.hook_event_name ?? '?';
    const tool = body?.tool_name ?? '?';
    const command = String(body?.tool_input?.command ?? '').slice(0, 100);
    console.log(
      `${record.at} ${path} ${event} ${tool} ${command} -> ${answer.hookSpecificOutput?.permissionDecision ?? status}`
    );
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    }, delayMs);
  });
});

server.listen(Number(values.port), '127.0.0.1', () => {
  console.log(`echo hook server on 127.0.0.1:${values.port}, log ${logFile}`);
});
