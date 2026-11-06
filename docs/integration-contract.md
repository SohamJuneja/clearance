# Integration contract

How the Clearance packages talk to each other. Types live in `packages/contracts/src/index.ts`. Subagents build against this file in parallel; if you must change it, make the change additive and say so in your final report.

## Processes

| Process | Port | Owner | Holds |
|---|---|---|---|
| clearance-core + clearance agent (one process) | 7700 | brain, switchboard | SQLite, policy, Switch API key |
| clearance-gate | 7710 | gate-hooks | `ACME_ADMIN_KEY`, `GITHUB_GATE_TOKEN`, stored calls |
| acme | 7800 | world-ui | Fake business data |
| desk | 7900 | world-ui | `CLEARANCE_INTERNAL_TOKEN` in its small server, behind a closed route list; the browser holds nothing |

Env names are in `.env.example`. Add new ones there with placeholders. All TypeScript runs through `tsx`; there is no build step for services.

## Core public API (`@clearance/core`)

```ts
createClearanceCore(deps: {
  dbPath: string; policyPath: string; teamPath: string; identitiesPath?: string;
  chat: ChatPort; gate: GatePort; lookup: LookupPort; clock: Clock;
}): ClearanceCore

interface ClearanceCore {
  check(action: Action): Promise<CheckResponse>;      // the only decision entry point
  onMessage(evt: ChatMessageEvent): Promise<void>;    // requester tracking, @clearance commands
  onApprovalOutcome(evt: ApprovalOutcomeEvent): Promise<void>;
  tick(): Promise<void>;                              // timers; called every second by main
  close(): void;
}

buildServer(core, opts): FastifyInstance              // PLAN 6.7 routes except /v1/hooks/*
```

`/v1/hooks/*` routes come from `@clearance/adapters` as a Fastify plugin:

```ts
hookRoutes(app, { check: (action: Action) => Promise<CheckResponse>, resolveAgent: (cwd?: string, agentType?: string) => string | null, hookTokens: Record<string, string> })
```

**The token decides the agent.** `hookTokens` is token to agent name, one token per agent, loaded with `loadHookTokens(path)` from `data/hook-tokens.json` (mode 600, gitignored). `scripts/setup-agents.ts` and `packages/hook-cli/src/setup-agent.ts` write it. `packages/core/src/main.ts` refuses to start if it is missing, empty or open to others, so a shared token can't silently come back. Set `CLEARANCE_HOOK_TOKENS_PATH` to keep it elsewhere. Core reads it at start, so restart core after adding an agent.

`action.agent.name` always comes from the token. What a request claims can only make it a deny:

- A missing or unknown token is a deny.
- `agent_type` or `cwd` naming a different agent is a deny, with a reason naming both.
- `cwd` in a directory no agent owns is a deny, unless the vendor named the agent (`agent_type`, Claude's main thread only), because a named session may wander. Never an allow on `cwd` alone.

`resolveAgent` reads the `agents` map in `team.yaml` and only cross-checks those claims. With `agentType` set, it answers for that name only and never falls back to `cwd`.

Each vendor reads its own token from its own directory: Claude from the `env` block of `.claude/settings.local.json`, Codex, OpenCode and Cursor from `.clearance/hook-token`. Cursor has never been run. The fence hides other machines' folders, but agents on one machine can read each other's tokens: see `docs/threat-model.md`.

Lead wires all of this together in `packages/core/src/main.ts` at integration.

## Gate to core

`POST {CORE}/v1/check`, header `Authorization: Bearer $CLEARANCE_INTERNAL_TOKEN`, body `CheckRequest`, response `CheckResponse`. Not the hook token: agents can read that one.

- The gate builds `Action{source:"gate", vendor:"gate", kind:"business", business:{endpoint:"POST /acme/refunds", args}, agent:{name}}`. `agent.name` comes from the agent's gate token, never from the request body.
- Optional headers `X-Clearance-Room` and `X-Clearance-Thread` fill `session`. They are hints for where to post, not identity.
- Core unreachable or non-200: the gate returns 503 for anything that is not a plain read. Fail closed.
- `decision: allow` executes now and returns the result. `decision: hold` stores the call and returns `202 {status:"pending", request_id, poll_after_s:15, message}`, where `message` is core's `reason` verbatim. `decision: deny` returns `403 {status:"denied", message}`.

## Core to gate

Header `Authorization: Bearer $CLEARANCE_INTERNAL_TOKEN`.

- `POST {GATE}/internal/execute/:requestId`, body `{call_hash}`, response `ExecuteResult`. The gate refuses when `call_hash` differs from what it stored. Exactly-once by `request_id` inside a SQLite transaction; a second call returns `{ok:true, alreadyExecuted:true, result}` with the original result.
- `GET {GATE}/internal/lookup/:kind/:id`, returns JSON or 404. Kinds: `orders`, `customers`, `destinations`, `ci`, `github`, `pulls`, `services`, `tickets`, `files`.

## Hash

`call_hash = sha256(canonicalJson({class, target, args}))`, computed by core. `canonicalJson` is in contracts. For hooks, `args` is `{command}` or `{path}` or the MCP args.

## Acme HTTP (port 7800, header `x-acme-admin-key: $ACME_ADMIN_KEY`, amounts are integer rupees)

| Method and path | Body or result |
|---|---|
| `GET /orders/:id` | `{id, customer_id, total, status, items}` |
| `GET /customers/:id`, `GET /customers?query=` | `{id, name, email, ...}` |
| `POST /refunds` | Body `{order_id, customer_id, amount, destination}`. Result `{id:"re_...", ...}` |
| `GET /destinations/:id` | `{id, customer_id, upi, added_at, age_hours}`. `id` is the UPI string, for example `meera.k@okaxis` |
| `POST /payouts/destinations` | Body `{customer_id, upi}` |
| `GET /services`, `GET /services/:name` | `{name, live_version, owner}` |
| `GET /ci/:version` | `{version, status:"passing"or"failing", failing:[...]}` |
| `POST /deploys` | Body `{service, env, version}` |
| `POST /rollbacks` | Body `{service, env}` |
| `POST /emails` | Body `{to, subject, body, attachments:[name]}`. Outbox only |
| `DELETE /records/:table/:id` | Tables `customers`, `orders` |
| `GET /tickets/:id` | `{id, customer_id, order_id, subject, body}` |
| `GET /pulls/:n` | `{number, repo, author, changes, files:[...], checks}` (fake GitHub) |
| `GET /state` | Money out, deploys, outbox, deleted records: what evals assert on |
| `POST /admin/reset` | Reseed everything |
| `POST /pulls/:n/merge` | Optional body `{repo}`. The gate's `/github/merge` calls this so `/state` shows merges |
| `GET /files/:name`, `GET /files/:name/content` | `{name, rows, bytes, synthetic}`, then the file. `count_rows` uses the first |
| `GET /emails/templates` | Template replies |

## Gate HTTP (port 7710, header `Authorization: Bearer <per-agent gate token>`)

Same paths with a prefix: `POST /acme/refunds` maps to Acme `POST /refunds`, `GET /acme/*` passes through, `POST /github/merge` body `{repo, pr}`, `GET /pending/:id` asks core for state.

## Identity files (written by `scripts/setup-identities.ts`, never committed)

`data/identities.json`, mode 600:

```json
{
  "people": { "sam": { "switchUserId": "...", "participantIds": ["@switch-user-...:localhost"], "mattermostUser": "sam" } },
  "agents": { "clearance": { "switchAgentId": "...", "participantId": "..." } }
}
```

`data/secrets.json`, mode 600: Mattermost personal access tokens and Switch agent API keys. Never print these.

Core merges `team.yaml` with `identities.json`. An answer from a participant id that maps to no person is ineligible.

## Agent working directory

Every agent directory needs `packages/hook-cli/src/setup-agent.ts` run on it (`ACME_GATE_TOKEN=<token> node packages/hook-cli/src/setup-agent.ts <dir> --agent <name> [--tokens-file <path>] [--codex-home <dir>]`), or `scripts/setup-agents.ts`, which does it for all five: OpenCode refuses to start without `.clearance/gate-token`, and hooks deny everything without `.clearance/hook-cli` and the agent's own `.clearance/hook-token`. `scripts/setup-agents.ts` points `hook-cli` at a copy in `~/.local/share/clearance-tools/hook-cli`, because the repo is hidden from fenced agents.

`acme-mini-app/` in this repo (later its own GitHub repo, cloned through a template's `repo:`) holds `.claude/settings.json`, `.codex/hooks.json`, `.opencode/plugins/clearance.ts`, `opencode.json`, `.cursor/hooks.json`, `.mcp.json`, `bin/acme`, and the fake checkout code.
