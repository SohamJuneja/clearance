# Track 03: which issue, and what to post

Rechecked with read-only `gh` on 2026-11-06, against `sandbox-quantum/switch` `main` at `13f6a2c8`. Nothing has been posted, and nothing has been pushed. **Recheck the counts before posting: they move daily.**

## Where this stands

**Still #833, the Canva connector, but it now hangs on one test that takes about 15 minutes.** The code is ready locally. The owner's decision is whether Canva's MCP server answers a developer app at all.

#1133's author reported on Oct 29 that both of Canva's MCP addresses answer `500` on `initialize` for third-party developer apps, "consistent with Canva's current MCP partner waitlist". If that still holds, **nobody can record the video the issue requires**, and a PR from us would add nothing to the two already open. Nobody has shown it either way since. A commenter assigned on Nov 6 says they will look at it too.

Deadline: **Sat Nov 7, 23:59 IST**.

| Step | Who | Time | Result |
|---|---|---|---|
| [The gate](#the-gate-15-minutes): make the app, run the probe | Owner | About 15 min | **GO**, or **DROP**, and stop there |
| Paste the probe's `RECORD` lines back | Owner, then an agent | 5 min | Real values in the entry, tests and docs |
| [Hand QA](#hand-qa-once-the-gate-says-go) on a second stack from the clone | Owner | About 45 to 60 min | Every "Done when" box checked |
| [The video](#the-video) | Owner | About 15 min | Under 3 minutes |
| Comment, fork, push, PR, CLA | Owner | About 10 min | Public |

So **15 minutes for a drop, roughly 1.5 to 2 hours in all for a go**. These are estimates, and the second stack is the likeliest overrun: none of its commands have been run, because the live demo stack had to stay untouched.

## What the recheck changed

**I got two things wrong in the first version of this doc.**

- **I said #1133 had no live testing.** It does. I had read only the start of its comment, which opens with screenshots. It reports a real Canva app: the loopback redirect and sign-in work, `/rest/v1/users/me` accepts the token, and the REST API answers 200. That also answers the doc's old worry about whether the portal accepts a loopback redirect. And it reports the `500` above, which I missed completely.
- **I listed the logo as an advantage.** The mark and its credit are already in the repo (`console/.../assets/images/connections/canva.svg` and `NOTICE.md` beside it). Nothing to do.

**A second PR has appeared**: #1584, today, from Vedant1442. It has no video and no live claims: its testing is unit tests and `ruff`. Its CI is green. So the condition for stopping, a strong PR with a video, isn't met.

| Issue | Open PRs | Strongest one | Verdict |
|---|---|---|---|
| **#833 Canva** (medium, P3) | **2**: #1133, #1584 | #1133: live sign-in, MCP `500`, no video, untouched since Oct 29. #1584: no live testing, no video | **Take it, if the gate says go** |
| #783 Factory Droid (medium, P1) | 2: #1195, #1151 | #1151: real-CLI summary from `droid` 0.251.0, video "not yet provided" | [The fallback](#if-the-gate-says-drop), with a Factory login |
| #832 Box (medium, P3) | 3: #1390, #1377, #1207 | #1390: tested live with a Box developer account, 2:51 video, CLA signed | No: a strong PR is there |
| #803 tool input and output (medium, P2) | 3, and one that mentions it: #1215, #1387, #1414 | They follow the maintainer's direction | No |
| `!list-documents` crash (#1285) | 1: #1286, still open | +102/-0, review pending | No: not a hackathon issue, and fixed in a PR |

399 PRs are open across 63 hackathon issues. The assignee count on #833 is 9.

**The rules, from petr-sandbox's comments:** everyone who expresses interest is assigned, PRs are reviewed after the hackathon window, and **only one PR is selected per issue**. On Nov 3, on this issue: "Several people are on this issue and some have PRs open, so please look at those before you start." On Nov 6 he assigned another commenter, so asking still gets you assigned. Prashant-thakur77 has no assignment, PR or comment on the repo yet.

## What we'd bring, if the gate says go

Neither open PR has any of this:

- **The video** the issue requires: connect, grant, agent uses it in a room, grant off.
- **The MCP server actually working in a session**, shown rather than assumed, and if `500` turns out to have been a matter of scopes, the reason.
- **Measured values** in the entry's comments: token lifetime, rotation, revocation. #1584 states them from Canva's documentation.
- **Whether Canva enforces the read level.** Nobody has shown this. If it doesn't, the honest entry offers one level.
- **A setup doc**, `docs/old/canva-setup.md`, as Airtable has. Neither PR has one.

We could still lose: one PR is chosen, it's P3, and others are looking at the same blocker.

## The code

**Clone:** `/home/prashant/projects/switch-track03`, from `main` at `13f6a2c8`.
**Branch:** `canva-connection`, one local commit. Its remote is upstream, read-only: nothing has been forked or pushed.

| File | What |
|---|---|
| `core/switch_core/connections/catalog/canva/connection.yaml` | The entry, in the shape of `catalog/airtable/`, with Atlassian's loopback ports |
| `core/switch_core/connections/catalog/canva/skill/SKILL.md` | Tasks and limits, safe defaults, no credentials |
| `core/tests/.../test_loader.py`, `test_registry.py`, `test_app_credentials.py` | The entry's values, the skill, the operator's own client |
| `core/tests/.../gateway/test_connection_catalog.py`, `test_workspace_services.py`, `test_connector_apps.py` | Canva among the enabled services and connector apps |
| `docs/design/service-connections-v2.md`, `docs/old/canva-setup.md`, `CLAUDE.md`, `CHANGELOG.md` | As Airtable has them |

**Tests:** the six touched files pass, 235 in all, and `ruff` is clean on them. Switch's whole suite wasn't run, on purpose. `just typecheck` wasn't run either, since no Python source changed. The Gateway's and Console's own tests weren't run, since neither changed.

**Taken from Canva's public metadata, read anonymously, so not guesses:** the MCP server answers 401 naming its metadata, the authorization server is `https://www.canva.com`, PKCE is S256, and there's no registration endpoint, no revocation endpoint and no list of client authentication methods, which Switch reads as HTTP Basic.

**Marked `TO MEASURE`, because only a real app can say:** whether refresh rotates, whether the revocation address cuts access, whether identity accepts the token, the token's lifetime, whether the scopes are enough, whether the read level is enforced, and the real tool names for the skill. The YAML needs values to load, so those are provisional, from Canva's documentation, and say so. **`grep -rn "TO MEASURE" core docs` must come back empty before any PR.**

**Left out on purpose, and said so in the PR text:** a Helm value, and a step-by-step walkthrough in the Gateway's and Console's connector-apps dialogs. Airtable has both. The dialogs work without one, `CANVA_CLIENT_CONFIG_PATH` works without Helm, and the walkthrough would describe Canva's portal, which nobody here has seen.

**Done without a Canva app:** everything above. **Only possible with one:** everything below.

## The gate (15 minutes)

1. **Recheck.** `gh pr list --repo sandbox-quantum/switch --state all --search "canva in:title"`. If someone has opened a PR with a video that works, stop.
2. **Make the app.** In Canva's Developer Portal, create an app and turn on Canva MCP. Scopes: `design:meta:read`, `design:content:read`, `design:content:write`, and tick the rest too for now, since step 4 may ask for them. Redirect URLs: `http://127.0.0.1:39231/switch-services/callback`, and the same for ports 39232 to 39235. If turning on MCP asks for a review, a waitlist or a paid plan, that is your answer: **drop**.
3. **Save its client id and secret outside any repo.** Never paste them into a chat, an issue or a commit.
   ```bash
   mkdir -p ~/.config/canva-track03
   printf '{"client_id":"%s","client_secret":"%s"}\n' 'PASTE_ID' 'PASTE_SECRET' > ~/.config/canva-track03/client.json
   chmod 600 ~/.config/canva-track03/client.json
   ```
4. **Run the probe**, from this repo, and open the address it prints. It signs in the way Switch does, prints what to record, and never prints a token.
   ```bash
   node spikes/track03/canva-gate.mjs --client ~/.config/canva-track03/client.json
   ```
   - **`GO`**: carry on.
   - **`NOT YET`**: refused with the least scopes. Run it again with `--scopes all`, to tell a missing scope from a block on the app. If that says `GO`, a scope was the problem, and that alone is worth reporting on the issue. Find which by removing them.
   - **`DROP`**, or a `STOP` you can't fix: [drop](#if-the-gate-says-drop).

The probe was only checked against a stand-in for Canva (`node spikes/track03/canva-gate.check.mjs`, 5 of 5). It has never talked to Canva with a token.

## Hand QA, once the gate says go

**1. Measure.** Each of these prints `RECORD` lines. Paste them all back to an agent: they hold no secrets, and it can fill in the entry, tests and docs in about 5 minutes.

```bash
# Rotation and revocation. This ends the sign-in, which is the point.
node spikes/track03/canva-gate.mjs --client ~/.config/canva-track03/client.json --measure

# The read level, using a write tool from the "tools" line the first run printed.
node spikes/track03/canva-gate.mjs --client ~/.config/canva-track03/client.json --scopes read --call <WRITE_TOOL> '<ITS_JSON_ARGS>'
```

Then tell the agent the tool list, and which tools need more than these scopes. In the portal, take off any scopes you ticked just for the gate.

**2. Stack.** The connector guide wants this done from Switch Console, against a server running this branch. **It can't run beside the live demo stack**: `deploy/local/docker-compose.yml` fixes ports 5432 and 8065, and Core takes 8000. So do it when nobody is recording or running the demo, stop the demo stack first, and bring it back afterwards. The machine has run out of memory before: check `free -g` shows at least 4 GB available. Skip `just up`, which builds images and starts Mattermost. A Switch chat is a room, so Postgres is enough. **None of this has been run.**

```bash
cd /home/prashant/projects/switch-track03
just init-env
# In .env: FEATURE_FLAGS_ENABLED=service_connections
#          CANVA_CLIENT_CONFIG_PATH=/home/prashant/.config/canva-track03/client.json
docker compose -f deploy/local/docker-compose.yml --project-directory . up -d postgres init-db
just migrate
just run 2>&1 | tee ~/.config/canva-track03/core.log   # switch-core on :8000; leave it running
just local-cloud-console  # in another terminal, after `cd console && pnpm install`; the heaviest step
```

Sign in as the gateway admin from `.env`, and create an agent with a provider that's already logged in on this machine.

**3. Walk the issue's "Done when".** Start a screen recording for the steps marked 🎥.

| # | Do | Pass when | Record |
|---|---|---|---|
| 1 | Settings, Connections | Canva shows, with its name and logo | |
| 2 🎥 | Connect, choosing read-only | Canva's consent, then connected | The account label shown |
| 3 🎥 | Connect again, choosing read and write | Connected | |
| 4 🎥 | Grant Canva to the agent. In a chat with it: "list my Canva designs" | It answers from Canva | Tool names used |
| 5 🎥 | "Create a small test design called Switch QA" | It shows up in Canva | |
| 6 | With a read-only connection, ask for an edit | **Canva refuses it** | If it works, the entry offers one level |
| 7 🎥 | Turn the grant off. Ask again, and time it | Refused within a minute | The seconds |
| 8 | Search Core's log, then the transcript and room as copied out, for a token: `grep -E "access_token\|refresh_token\|Bearer \|eyJ" ~/.config/canva-track03/core.log` | No token value anywhere. A field name with no value is fine | |
| 9 | Leave it past the measured lifetime, then ask again | Works with no sign-in | The time |
| 10 🎥 | Disconnect | Access gone, and revoked at Canva if step 1 showed that works | What Canva's connected-apps page shows |

**4. Finish.** Then delete the test design and `core.log`, stop the stack, and restart the demo.

```bash
grep -rn "TO MEASURE" core docs     # Must print nothing
uv run --project core ruff format --check . && uv run --project core ruff check .
uv run --project core pytest core/tests/switch_core/connections/test_loader.py core/tests/switch_core/connections/test_registry.py \
  core/tests/switch_core/connections/test_app_credentials.py core/tests/switch_core/gateway/test_connection_catalog.py \
  core/tests/switch_core/gateway/test_workspace_services.py core/tests/switch_core/gateway/test_connector_apps.py -q
```

## The video

Under 3 minutes, from the 🎥 steps above, in this order: connect, grant, the agent lists and creates a design in a room, grant off and the same request fails within a minute, disconnect. A real account, a test design, and **nothing sensitive on screen**: no tokens, client secret, tenant ids or real designs. Keep the client file and `.env` closed. The clip should show a clock or a timer across the grant-off step, since that's a claim about time.

## If the gate says drop

Reproducing #1133's `500` is still useful to the maintainers, and it costs one comment. It earns no prize:

> Hi @petr-sandbox, I tried this with a Developer Portal app with Canva MCP turned on, signing in the way Switch does. Sign-in works, and `initialize` on `https://api.canva.com/connect/v1/mcp` answers `<STATUS>`, with the least scopes and with every scope the server lists, as #1133 reported. So I don't think a connector can pass "Done when" until Canva lets developer apps in. Happy to retest if that changes.

**#783 Factory Droid**, only if Prashant already has a Factory account with credits. It is P1, so worth more if won. It is riskier: it needs a real login for the real-CLI test, the issue's launch command is disputed (`droid exec --output-format acp`, against `acp-daemon` and `stream-jsonrpc` in Factory's docs, per two comments there), it has ten "Done when" items including interrupt and resume, and it means building Console from latest `main`. #1151 has a head start: a real-CLI summary, but no video yet. Three hours is optimistic, and nothing has been prepared for it.

**Otherwise drop Track 03.** A PR without the video or the live testing would be weaker than what's there, and would cost time better spent on Track 01.

## The comment to post on #833 (UNSENT)

Post once the gate says go. Fill in what the probe printed, and only say what's true. It tags the maintainer, as the WeMakeDevs page asks.

> Hi @petr-sandbox, I'd like to work on this for the hackathon. The issue asks for a report on what Switch can use today, so here's mine, from a Developer Portal app with Canva MCP turned on, signing in the way Switch's OAuth adapter does:
>
> - `https://api.canva.com/connect/v1/mcp` answers `initialize` with `<STATUS>` with these scopes: `<SCOPES>`. #1133 reported a `500` here, so `<WHAT MADE THE DIFFERENCE, OR "it no longer does for me">`.
> - Sign-in through the loopback redirect works. The token lives `<EXPIRES_IN>` seconds. A refresh `<ROTATES OR NOT>`, and `<WHAT REVOCATION DID>`.
> - `/rest/v1/users/me` `<ACCEPTS OR REFUSES>` the token, so `team_user.user_id` `<CAN OR CAN'T>` name the connection.
> - A read-only sign-in `<IS OR ISN'T>` refused a write, so `<TWO LEVELS OR ONE>`.
>
> I've read #1133 and #1584, and they've got the entry's shape right. What I'd add is what's above, written into the entry's comments, a setup doc as Airtable has, and the video "Done when" asks for. No code outside the catalog.

## The PR (UNSENT DRAFT: do not post as it stands)

Fill every `<...>` from the QA, and delete this line. Title: `Add the Canva connection`. The template's sections on agent CLIs and messaging platforms are deleted, as it says to.

```markdown
## What this changes

A Canva connection: someone who connects their Canva account in Switch Console can let their agents search, read and edit designs, as them, through Canva's official MCP server at `https://api.canva.com/connect/v1/mcp`. Closes #833.

The shape is a static OAuth app with loopback redirects. Canva's authorization server offers no dynamic registration, so each server's operator creates an app, and `docs/old/canva-setup.md` says how. Canva matches a redirect's port, so it uses the fixed loopback ports. It's a catalog entry, a skill and tests, with no broker code.

- **Least access:** `design:meta:read` and `design:content:read` for read, plus `design:content:write` for write. <WHY, IF THE TOOLS NEEDED MORE>
- **Measured against a real app, and written in the entry's comments:** the token lives <EXPIRES_IN> s, refresh <ROTATES OR NOT>, revocation <WHAT IT DID>, and identity <WHAT IT DID>.
- **The read level:** <CANVA REFUSED A WRITE FROM A READ-ONLY SIGN-IN / IT DID NOT, SO THE ENTRY OFFERS ONE LEVEL>.
- **`initialize`:** #1133 reported a `500` for developer apps. <WHAT THIS SHOWED>

Not included: a Helm value and a step-by-step in the connector-apps dialogs, which Airtable has. `CANVA_CLIENT_CONFIG_PATH` and the dialog's default work without them. Happy to add them if you'd like them here.

## How it was tested

- By hand against the real vendor, from Switch Console, with a development app: connect read-only and read-write; grant to an agent; <TOOLS USED> in a chat; a write refused on a read-only connection <IF SO>; grant off stops the session in <SECONDS> s; a token past its lifetime renewed with no sign-in; disconnect, <WHAT CANVA SHOWED>. The token appears nowhere in the transcript, the room or Core's log.
- `pytest` on `test_loader.py`, `test_registry.py`, `test_app_credentials.py`, `test_connection_catalog.py`, `test_workspace_services.py` and `test_connector_apps.py`: <N> passed. `just check`: clean.

Video (connect, grant, agent uses it in a room, grant off): <LINK OR ATTACHMENT>
```

To send it, once there's nothing left in `<...>`. **These are the owner's alone**:

```bash
cd /home/prashant/projects/switch-track03
gh repo fork --remote --remote-name fork   # Public
git push fork canva-connection             # Public
# Then open the PR on GitHub with the text above, attach the video, and sign the CLA when the bot asks.
```
