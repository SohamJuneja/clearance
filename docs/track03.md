# Track 03: which issue, and what to post

Read from `sandbox-quantum/switch` with read-only `gh` on 2026-11-06, against `main` at `3d35bf55`. Nothing has been posted. **Recheck the counts in step 1 before posting: they move daily.**

## Recommendation: #833, the Canva connector

Post the comment below, then open a PR with `Closes #833` before **Sat Nov 7, 23:59 IST**.

It is the only issue that is finishable in about 3 hours and has a weak field: one open PR, with room to be plainly better on what the issue asks for. It is P3, so it is worth less to the maintainers than a P1, and one PR is chosen per issue, so we could still lose. If the Canva app gate below fails, see [the fallback](#if-the-canva-gate-fails).

## What changed since DECISIONS 02:50

**The "no open PR" list was wrong for our purposes.** It looked at the latest 100 PRs, which only reach back to Nov 4. There are 387 open. Counting all of them:

| Issue | Open PRs | Strongest one | Verdict |
|---|---|---|---|
| **#833 Canva** (medium, P3) | **1**: #1133 | Right endpoint and shape, tests. Token lifetime and rotation are taken from Canva's guide, not measured. No video, no logo or `NOTICE.md`, not touched since Oct 29 | **Take it** |
| #832 Box (medium, P3) | 3: #1390, #1377, #1207 | #1390: tested live with a Box developer account, 2:51 video, CLA signed. Also needs a Box AI plan | No: a strong PR is already there |
| #783 Factory Droid (medium, P1) | 2: #1195, #1151 | #1151: real-CLI summary from `droid` 0.251.0, video "not yet provided" | Second choice: [needs a Factory login](#if-the-canva-gate-fails) |
| `!list-documents` crash (#1285) | 1: #1286 | Open since Nov 1, +102/-0, review pending | No: not a hackathon issue, and already fixed in a PR |
| #803 tool input and output | at least 3: #1215, #1387, #1414 | They follow the maintainer's Oct 31 and Nov 2 direction | No: a fourth is unlikely to be picked |

**`!list-documents`, in full.** The crash is still on latest `main` (`client._package_store`, now at `commands.py:1952`). But #1285 has no `hackathon` label and no comments, and another participant filed it with a fix a few minutes later. It doesn't count for the track and the work is taken. A short "reproduced at our pin, this is what it blocks" comment on #1286 would be useful goodwill, and F8 would benefit if it merges. It earns no prize.

**The rules question in HUMAN.md is mostly answered in the threads.** petr-sandbox, on every issue we read:

- Oct 22: issues won't be assigned; anyone may try any number.
- Oct 29: "issues are now assigned to everyone who expressed interest, and the resulting PRs will be reviewed after the hackathon time window. **Only one PR will be selected per issue.**"
- Oct 30 and 31: late arrivals on a crowded issue were told "we've assigned you to five issues with fewer participants... Please focus on those." So he might redirect us. A comment with a concrete design, on an issue with one PR, gives him little reason to.
- Nov 3, on this issue: "Several people are on this issue and some have PRs open, so please look at those before you start."

Prashant-thakur77 has no assignment, PR or comment on the repo yet, so the 5-PR limit isn't in play.

## Why we can beat #1133

The issue's "Done when" list and the connector guide ask for things #1133 doesn't show. Its "How it was tested" lists test suites and a screenshot comment:

- **A video** of connect, grant, agent uses it in a room, grant off. Required by the issue.
- **Measured values in the entry's comments**: token lifetime, refresh behaviour, revocation. #1133 states the first two from Canva's guide. The connector guide requires "QA by hand against the real vendor", and glasspollution listed the same points on Nov 4 as still to measure.
- **Whether Canva really enforces a read level.** Nobody has shown this. If it doesn't, the honest entry says so rather than offering a level that only looks safe.
- **The logo**, credited in `NOTICE.md`. #1133 changes neither.

**Two others may get there first.** glasspollution (Nov 4) and Vedant1442 (Nov 5) have both said they are working on it, with no PR yet. If either opens one with a video before we start, reread this table.

## Before anything else: the Canva gate (Prashant, about 15 minutes)

This decides whether we go ahead. Everything else depends on it, and none of it can be done by an agent.

1. Recheck `gh pr list --repo sandbox-quantum/switch --state all --search "canva in:title"`.
2. In Canva's Developer Portal, create an app and turn on Canva MCP. **Check that it accepts a loopback redirect** (`http://127.0.0.1:39231/...`, ports 39231 to 39235), since Switch Console's connect uses those. Others have read the docs but nobody has reported this working: sudo-anshul's plan is to report back if the portal refuses it. The issue also mentions a waitlist for redirect URIs on the older route.
3. Save the client id and secret to a file outside the repo. Never paste them into a chat, an issue or a commit.

Stop here if the portal refuses loopback or wants a review or a paid plan to turn MCP on.

## The comment to post on #833

Post once the gate has passed, because it says the app exists. It tags the maintainer, as the WeMakeDevs page asks.

> Hi @petr-sandbox, I'd like to work on this for the hackathon.
>
> **What I read.** The earlier reports here and #1133. I agree with where they landed: Canva's current endpoint is `https://api.canva.com/connect/v1/mcp`, with a static OAuth app from the Developer Portal (`registration: static`, `client_settings: CANVA`), since nobody should depend on the deprecated registration route. I have a development app with Canva MCP turned on, and it accepts the loopback redirect Console uses.
>
> **What I'd add**, which the "Done when" list asks for and I haven't seen shown yet:
> - Measured, and written in the entry's comments: access token lifetime, whether refresh rotates, what revocation really does, and whether `/rest/v1/users/me` accepts a token from the MCP flow.
> - Whether Canva enforces the read level. I'll connect read-only and try a real write. If it isn't enforced, I'll say so in the entry instead of offering a level that only looks safe.
> - The official mark, credited in `NOTICE.md`.
> - A short video: connect, grant, agent uses it in a room, grant off and access gone within a minute.
>
> Least access: `design:meta:read` and `design:content:read` for read, plus `design:content:write` for write, unless a tool turns out to need more, which I'd justify in the PR. No code outside the catalog unless the vendor forces it, and I'd comment here first.

## Design

Follows "Adding a connector" in `docs/design/service-connections-v2.md`, in shape 1 (remote MCP server with OAuth). Reference: `catalog/airtable/`, merged, also static. **No Switch code changes.** Write it fresh: no Clearance code goes in, and nothing is copied from #1133.

**`core/switch_core/connections/catalog/canva/connection.yaml`**: replaces the placeholder.

| Field | Value | Basis |
|---|---|---|
| `enabled`, `adapter` | `true`, `oauth` | Issue |
| `auth.oauth.registration`, `client_settings` | `static`, `CANVA` | Documented route; no registration endpoint advertised |
| `auth.oauth.redirect`, `loopback_ports` | `[loopback]`, `[39231..39235]` | **Confirmed by the gate** |
| `auth.refresh` | **measure** | Rotating is what others expect |
| `auth.oauth.revocation_url` | **measure** | Documented as `/rest/v1/oauth/revoke`; check that it really cuts access |
| `auth.identity` | `/rest/v1/users/me`, `team_user.user_id` | **Measure**: it may refuse an MCP-issued token. If it does, comment on the issue before writing anything else |
| `token` | `{ kind: pass_through, max_lifetime: <measured> }` | Comment says "measured", as Airtable's does |
| `mcp.servers` | `{ name: canva, url: https://api.canva.com/connect/v1/mcp }` | Must be unique, and not `switch` |
| `access.read.scopes` | `design:meta:read`, `design:content:read` | **Measure** against the real tool list |
| `access.write.scopes` | read plus `design:content:write` | No `brandtemplate:content:write` and no folder writes without a written reason |
| `tools` | `{ mode: pass_through }` | Per-tool levels are out of scope |

**`skill/SKILL.md`**: tasks, tools and limits, with `name: canva`. Acting as the owner, what the grant reaches, safe defaults (read before writing, confirm before anything hard to undo), and the edit transaction's real steps, read from the tool list rather than from #1133. It never mentions credentials: the loader refuses that.

**Also:** the mark and its `NOTICE.md` credit (look at where #838 put Airtable's), and `tests/switch_core/connections/test_loader.py` moving `canva` from placeholders to enabled entries, with assertions on the values above.

**Running it.** PRs are against latest `main`, not our pin, and our stack is shared and pinned, so this needs a **second stack from a separate clone** under its own compose project and ports, with `FEATURE_FLAGS_ENABLED=service_connections`. The machine has 14 GB and little free. Do it when nobody is running real agents, and take it down straight after. Never point it at `vendor/switch`. Check first that `uv` and `just` are installed, since we have no sudo.

**Gates:** `just check`, `just typecheck`, `just test`.

**Time (agent, once the gate has passed):** about 45 minutes for the entry, skill and tests; 45 for the second stack; 60 for live measuring and fixes. **Prashant:** the gate, recording the video (about 15 minutes, under 3 minutes long), posting the comment, signing the CLA on the PR. These estimates haven't been tested, and the second stack is the likeliest overrun.

**The video:** connect in Console, read-only then read-write → grant to an agent → the agent lists and creates a design in a room → grant off → the same request fails within a minute → disconnect. Real account, nothing sensitive on screen, no tokens or tenant ids.

**Done when:** every box in the issue's "Done when" is ticked with evidence in the PR body, and `Closes #833` is in it.

## If the Canva gate fails

**#783 Factory Droid**, only if Prashant already has a Factory account with credits. It is P1, so it is worth more if won. It is also riskier: it needs a real login for the real-CLI test, the issue's launch command is disputed (`droid exec --output-format acp`, against `acp-daemon` and `stream-jsonrpc` in Factory's docs, per two comments there), it has ten "Done when" items including interrupt and resume, and it means building Console from latest `main`. #1151 has a head start: a real-CLI summary, but no video yet. Three hours is optimistic.

**Otherwise drop Track 03.** A PR without the video or the live testing would be weaker than what's there and would cost time better spent on Track 01.
