# The Clearance MCP connector

The connector lets the people who approve and run Clearance ask it questions from Claude Code, Claude Desktop or Cursor. It is a small MCP server over stdio, in `packages/mcp-connector`, and it talks to core over HTTP.

It only reads. It can't approve, deny or cancel anything, and no tool for that will be added.

## What you can ask

| Tool | What it answers | Core route |
|---|---|---|
| `pending_requests` | Every request Clearance is holding: the call, the agent, who asked, and who can decide it. It marks the ones waiting on you | `GET /v1/pending` |
| `waiting_on_me` | The cards waiting for you, the same list Clearance keeps in your direct room | `GET /v1/inbox` |
| `explain_request` | Why a request was held. The answer is the one `@clearance why CLR-0042` gives in Switch, with who asked, who can decide it now and why the others can't, its flags, and what the call is | `GET /v1/requests/:id/explain` |
| `recent_ledger` | The newest ledger entries, 20 unless you ask for up to 100, as the team reads them in `#approvals` | `GET /v1/ledger/team` |
| `verify_ledger` | Whether the ledger's hash chain holds from the first entry to the last, or where it breaks | `GET /v1/ledger/verify` |
| `dry_run` | Whether a call would be held, without making it: the decision, class and tier, and for a hold who would be asked, who could decide and why | `POST /v1/dry-run` |

So you can ask things like "what's waiting on me?", "why was CLR-0042 held?", "would `git push --force origin main` from coder be held?" or "does the ledger verify?".

A dry run takes a shell command, as an agent's hook would send it, or a gate operation with its arguments: `refund`, `deploy`, `rollback`, `email`, `payout`, `delete` or `merge`. Core checks the arguments with the gate's own schemas, and fills a refund's customer and destination the way the gate does. It runs the policy and the router over a request that is never made. No action, request, card, grant, timer or ledger entry is written, and a test counts every row of every table before and after to prove it.

## What it can't do, and why

It can't approve, deny or cancel. An approval counts only when an eligible person answers the card in Switch. Switch's `approval_outcome` event says who pressed it, and that is the only identity Clearance accepts for a decision. A tool call from an assistant, or a line of text, says nothing about who someone is, so a tool that approved would be a way around the rule that the person who asked can't approve.

It is for people, and never for agents. It uses core's `CLEARANCE_INTERNAL_TOKEN`, the token the Desk uses. Agents never hold it: they have only their own hook and gate tokens, and the fence hides the repo, `data/` and `.env` from them. Every route it uses refuses an agent's hook token and gate token, and tests prove that for each one. So an agent can't use these routes to list requests or to probe the policy with dry runs. Inside an agent's fence the connector finds no token and refuses to start, which is the point. Don't put it in an agent's folder or in a project `.mcp.json` that agents load.

`CLEARANCE_PERSON` only picks whose cards `waiting_on_me` lists and which requests are marked as waiting on you. It isn't an identity, and nothing is decided by it.

It shows the ledger as the team reads it in `#approvals`, not the admin's full copy. A drill only works if it can't be told from a real request, and approvers can run this. So practice requests are left out, per-person timing is removed, and while a drill is open the list stands still at the entry before it. For the same reason `verify_ledger` gives only the verdict, and `pending_requests` shows you your own practice requests looking like real ones, as your inbox does, and nobody else's. The full ledger stays in core's SQLite, and an admin reads it with `GET /v1/ledger`.

A dry run is the policy's answer as things stand now. Who has asked that agent, who is away and what has run lately can change it. It doesn't look at an approval already granted for that exact call, and the gate also refuses an operation the agent's own gate token doesn't cover.

It needs a core with these routes. An older core answers the tools it can, and for the rest the connector says that core is older than it.

## Set it up

You need a clone of this repo with `pnpm install` done, and Node 22.18 or later, which runs the connector's TypeScript directly. On an earlier Node 22, add `--experimental-strip-types` before the path.

Put core's token in a file only you can read. It holds the token and nothing else:

```bash
mkdir -p ~/.config/clearance
(umask 077; grep '^CLEARANCE_INTERNAL_TOKEN=' /path/to/clearance/.env | cut -d= -f2- > ~/.config/clearance/core-token)
```

The connector reads these settings:

| Variable | What it is |
|---|---|
| `CLEARANCE_TOKEN_FILE` | A mode 600 file holding core's `CLEARANCE_INTERNAL_TOKEN`. Read first |
| `CLEARANCE_INTERNAL_TOKEN` | The token itself, if you'd rather not use a file |
| `CLEARANCE_PERSON` | Your team id, as in `policy/team.yaml`, such as `sam` |
| `CLEARANCE_CORE_URL` | Core's address. Defaults to `http://127.0.0.1:7700` |
| `CLEARANCE_CONNECTOR_TIMEOUT_MS` | How long to wait for core. Defaults to 8000 |

It refuses to start on a missing token, the `change-me` placeholder, a token file others can read, or plain HTTP to anything but this machine, because the token would travel in the clear. If core runs on another machine, forward its port and keep the default address:

```bash
ssh -N -L 7700:127.0.0.1:7700 that-host
```

### Claude Code

```bash
claude mcp add clearance -s user \
  -e CLEARANCE_TOKEN_FILE=$HOME/.config/clearance/core-token \
  -e CLEARANCE_PERSON=sam \
  -- node --disable-warning=ExperimentalWarning /path/to/clearance/packages/mcp-connector/src/main.ts
```

Or in a `.mcp.json` of your own, never one in a folder an agent works in:

```json
{
  "mcpServers": {
    "clearance": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "/path/to/clearance/packages/mcp-connector/src/main.ts"],
      "env": {
        "CLEARANCE_TOKEN_FILE": "/home/you/.config/clearance/core-token",
        "CLEARANCE_PERSON": "sam"
      }
    }
  }
}
```

### Claude Desktop

Add the same `clearance` entry under `mcpServers` in `claude_desktop_config.json`. On macOS that's `~/Library/Application Support/Claude/claude_desktop_config.json`. Use full paths, because Claude Desktop doesn't start in your shell. Restart Claude Desktop after saving.

### Cursor

Add the same `clearance` entry under `mcpServers` in `~/.cursor/mcp.json`. Keep it out of a project's `.cursor/mcp.json` if agents work in that project.

## Check it

```bash
pnpm --filter @clearance/mcp-connector test
pnpm --filter @clearance/core exec vitest run test/connector-routes.test.ts
```

The connector's tests run it against a real core with the repo's policy, and start the bin under plain `node` over stdio, as a client would. Core's tests cover the routes: the tokens they refuse, that a dry run writes nothing and agrees with the real check that follows, that `explain_request` gives the same words as `@clearance why`, and how drills stay out of sight.
