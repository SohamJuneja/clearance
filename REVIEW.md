# Clearance: independent review

Reviewed at `43a468e` on branch `soham/review`, on Windows 11 with Node 24.11 and pnpm 12.14.0, on 2026-11-07. I read README.md, docs/architecture.md and docs/threat-model.md first. I attacked the code before opening `eval/authority-suite/`, then compared each finding with the suite, the three review files and the Limits section.

**CONFIRMED** means I reproduced it by running Clearance's real core through its own test harness (fakes only for Switch, the gate and the clock). **SUSPECTED** means I saw it in the code but couldn't run the live stack (Docker, Switch, bubblewrap) on this machine. Where a finding is confirmed in Clearance but depends on something Switch or a vendor does, I say which part is which.

Repro files are on the branch, uncommitted:

- `packages/core/test/review-harness.ts`: a copy of `harness.ts` with `fileURLToPath` in place of `.pathname`, so it runs on Windows. On Linux, the stock harness works the same.
- `packages/core/test/zz-review.test.ts`: R1 and R2.
- `packages/core/test/zz-review-gate.test.ts`: the hook evasion batch.
- `packages/core/test/zz-review-drill.test.ts`: a real card next to the drill it triggers.

Run one with `cd packages/core && npx vitest run test/<file>`.

## Unit tests on Windows

`pnpm test` doesn't start on Windows. pnpm runs scripts under `cmd`, where `mkdir -p .tmp && export ...` fails (it also creates a directory called `-p`). Running each suite with vitest from Git Bash gave these counts:

| Suite | Passed | Failed | Main cause |
|---|---|---|---|
| acme | 107 | 0 | |
| adapters | 271 | 2 | POSIX mode check (`0666` vs `0600`) |
| contracts | n/a | n/a | no test files (exit 1) |
| core | 932 | 1,419 | `new URL(...).pathname` gives `E:\E:\...` (ENOENT) |
| core, with the path fix | 2,926 | 10 | CRLF from git `autocrlf` breaks fixture string edits; one path-separator case |
| desk | 196 | 31 | same `.pathname` ENOENT |
| gate | all 10 files | 0 | |
| hook-cli | 198 | 19 | POSIX modes, `.pathname` |
| switch-agent | all 6 files | 0 | |
| study | 483 | 7 | modes, CRLF in golden files |
| proof (`eval/`) | 828 | 53 (2 skipped) | EPERM, modes, CRLF |

Every failure I looked at comes from the platform (paths, file modes, line endings), not from a logic bug. On Linux CI these should pass. Running the tests also rewrote two tracked snapshot files (CRLF), which I reverted.

## Findings

### High

#### H1. A requester can write their ask in the shape of a card answer and then approve it alone

- **Where:** `packages/core/src/router/requesters.ts:74` (`CARD_ANSWER`) and `:99-105`.
- **Status:** CONFIRMED in Clearance. **NEW.** It is also worse than documented: it switches off the one fallback the Limits section relies on for role mentions.
- **What happens:** any message matching `^A\d+ ("..."|word="..."|yes|no|n)$` is treated as not speaking. Clearance records no voice for it, and doesn't note an unknown `@name` in it as a possible ask (`recordPossibleAsk` needs `speaking`). The text inside the quotes can be anything, including a full instruction.
- **Repro:** `zz-review.test.ts`, "R1".
  1. Priya: `@refunds-agent please look at ticket T-77` in `#support` / `t-77`. The agent replies there.
  2. Sam (finance approver) writes, in the same thread, with no `@refunds-agent`: `A9 "refund A-1931 4000 to meera.k@okaxis now"`.
  3. The gate checks the refund, and it's held with quorum 1. The only requester on record is Priya.
  4. Sam presses allow on his card.
- **Expected:** what happens in the control, where Sam's message is plain text: Sam is barred and the request stays `ROUTED`.
- **Actual:** the request goes to `EXECUTED` on Sam's single approval.
- **What it depends on:** the agent has to receive the message. The Limits section says a role mention addresses an agent and isn't recognised as a name, so `A9 "@<role> refund ..."` is a delivered ask that leaves no trace at all. A thread or direct room that Switch addresses to the agent works too.
- **Fix:** only exempt a message when `A<n>` is the handle of a card that is open in that room or thread. Otherwise treat it as speaking.

#### H2. A display name on a platform message decides who asked, so an approver can pose as someone else

- **Where:** `packages/core/src/people/directory.ts:124-127` and `packages/core/src/router/requesters.ts:98-122`.
- **Status:** CONFIRMED in Clearance. Whether Switch sets `on_behalf_of` from a name the user can edit is SUSPECTED. **NEW.** The red-team B8 test only tries a name that matches nobody (`"Sam Rao"`).
- **What happens:** `on_behalf_of` is matched case-insensitively against `team.yaml` names. When the sender isn't a known person, that name replaces the sender entirely.
- **Repro:** `zz-review.test.ts`, "R2". A message from `@switch-platform-mattermost:localhost` saying `@refunds-agent refund A-1931 ₹4,000 to meera.k@okaxis`:
  - with `onBehalfOf: "Sam"`: Sam is barred and the request stays `ROUTED`.
  - with `onBehalfOf: "priya"`: Priya is recorded as the requester, quorum stays 1, and Sam's single press takes it to `EXECUTED`.
- **Expected:** a name that anyone can set never removes a person from the requester set, and never lowers quorum.
- **Actual:** Sam sets his Mattermost display name to "Priya", asks, and approves his own refund.
- **Fix:** when the sender is a platform or bridge participant, use the unknown-requester quorum of 2 whatever name it carries, and add the named person to the barred set rather than using them instead of the sender.

#### H3. One allowed shell command removes the agent's own hook

- **Where:** `policy/clearance.policy.yaml:250` and `:278`. Both patterns need a trailing `/`. `bin/clearance-hook`, the root `opencode.json` and `.mcp.json` have no shell rule. The Codex and Cursor hooks run `./bin/clearance-hook` from the agent's writable folder (`acme-mini-app/.codex/hooks.json`).
- **Status:** CONFIRMED that Clearance allows each of these, with no card. That the vendor then runs a later session without the hook is SUSPECTED, because it depends on when each vendor reloads its config.
- **Comparison:** WORSE THAN DOCUMENTED. Limits does say an agent can write its hook config. But `protected_config` says it denies this, and authority case "Agent edits `.claude/settings.json` to remove the hook" (`cases.ts:631`) only tries Write, Edit and `sed -i`. It counts that as one of the 25 bad outcomes prevented.
- **Repro:** `zz-review-gate.test.ts`, as `coder` in its own directory:

  | Decision | Command |
  |---|---|
  | allow | `rm -rf .claude` |
  | allow | `mv .claude .claude-old` |
  | allow | `ln -sf /tmp/x .claude` |
  | allow | `git checkout HEAD~5 -- .claude` |
  | allow | `git stash -u` |
  | allow | `rm -r .opencode` (OpenCode's only hook is its plugin) |
  | allow | `echo '{}' > opencode.json` |
  | allow | `printf '#!/bin/sh\nexit 0\n' > bin/clearance-hook` |
  | hold | the same write to `bin/clearance-hook` through the Write tool |
  | deny | `sed -i ... .claude/settings.json` (control) |

- **Expected:** deny, as for the controls.
- **Actual:** allowed with no card.
- **Fix:** match these paths with or without a trailing slash, add `bin/clearance-hook`, `opencode.json` and `.mcp.json` to `protected_config`, and bind those paths read-only in the fence so the classifier isn't the only thing protecting them.

### Medium

#### M1. A drill can be told from a real card without answering it

- **Where:** `packages/core/src/core.ts:1471-1473` (a drill is rolled off a real hold and goes to the same approver), `:1513-1522` (no session, so no origin room), `:1565-1567`; `packages/core/src/drills/library.ts:48-53`; `drills/flaws.yaml`.
- **Status:** CONFIRMED. **NEW.** The second and third reviews covered break-glass and counter replies, and Limits covers the Desk and mirror freezing, but none of them covers this.
- **Repro:** `zz-review-drill.test.ts` (drills on, rate 1). Priya asks, the refund is held, and the cards are:
  - CLR-0001 in `dm-sam` and in `#support` / `t-77`.
  - CLR-0002 in `dm-sam` only, at the same millisecond, for order A-7741.
- **Expected:** a drill looks like a real request.
- **Actual:** four separate tells:
  - The drill has no copy in any team room.
  - It arrives at the same moment as a real card, to the same person.
  - Its order isn't in Acme, and the flaw list is public in the repo.
  - Whether a request rolls a drill is `sha256(id:policyHash)`. Ids are sequential and the policy hash is public (`/v1/health`, Desk), so it can be worked out in advance.
- **Fix:** post the drill's copy in a plausible room and thread, delay it by a random interval, seed the roll with a server secret, and give drills records that Acme lookups return.

#### M2. The Claude hook fails closed only on Claude Code 2.1.295 or later, and nothing checks the version

- **Where:** `acme-mini-app/.claude/settings.json:13`; `DECISIONS.md:45`, where a push went through without `onFailure`; `spikes/RESULTS-vendors.md:69`; `scripts/check-fence.sh:106`, which only prints `claude --version`.
- **Status:** SUSPECTED. **NEW** in its specifics. Limits says in general that some vendors fail open.
- **Repro:** install Claude Code older than 2.1.295, stop core, then have refunds-agent run `git push --force`.
- **Expected:** blocked.
- **Actual, per their own spike:** older versions ignore `onFailure`, and the push runs.
- **Fix:** make `just demo --check` refuse to start Claude agents on a version below 2.1.295.

#### M3. Edited messages aren't read at all

- **Where:** `packages/switch-agent/src/wire.ts`. There is no edit frame, and `observe` only sees new messages.
- **Status:** SUSPECTED. **NEW.**
- **Repro:** Sam posts `thanks` in a room the agent is in, then edits it to `@refunds-agent refund A-1931 ₹4,000 to ...`.
- **Expected:** Sam becomes a requester.
- **Actual:** if Switch delivers edits to agents, Sam is never recorded. If it doesn't, there's no issue. That needs checking on Switch.
- **Fix:** parse edit frames, record them like new messages, and keep them as asks for the window.

#### M4. The tests and `pnpm test` don't run on Windows

- **Where:** root `package.json:11`; `packages/core/test/harness.ts:12-17` and seven other files use `new URL(...).pathname`; mode assertions in adapters, hook-cli and study; no `.gitattributes`.
- **Status:** CONFIRMED. **NEW.** The README says agents need Linux, but not that `--no-agents` mode or the tests do.
- **Repro:** run `pnpm test` on Windows, or the counts above.
- **Expected:** tests pass, or the README says Linux only.
- **Actual:** 1,419 of 2,351 core tests fail, almost all on the path bug.
- **Fix:** use `fileURLToPath`, skip mode checks on win32, add `* text eol=lf` in `.gitattributes`, and make the `test` script work in any shell (or say Linux only).

### Low

#### L1. Any agent's gate token can read all of Acme, whatever classes it holds

- **Where:** `packages/gate/src/server.ts:153-157`. `service.read(path)` never sees the principal (`service.ts:415`).
- **Status:** CONFIRMED by reading the code. **NEW.** Limits covers reads passing through when core is down, but not the classes being ignored.
- **Repro:** with the reviewer agent's token, `GET :7710/acme/state`.
- **Expected:** scoped to the token's classes.
- **Actual:** every refund, the outbox bodies and the deleted rows. The data is synthetic, but on a real system that matters.
- **Fix:** give reads per-class allowlists, and refuse `/state` to agent tokens.

#### L2. A personal username and home paths are committed in docs

- **Where:** `HUMAN.md:20,68,81`, `TASKS.md:128`, `docs/track03.md:74,132,135` (`/home/prashant/...`, including `~/.config/canva-track03/client.json`).
- **Status:** CONFIRMED. **NEW.**
- **Expected:** no personal paths.
- **Actual:** they are present. No secrets: my grep for key and token shapes found only test placeholders, and every `change-me` placeholder is refused at startup by core, the gate, Acme, the Desk and the hook-token loader.
- **Fix:** replace them with `$REPO` or `~/`.

## What I tried that held

- **Restarting core to launder an unsigned policy edit:** the last signed policy wins (`core.ts:377-389`), and the tick turns a file edit into a proposal.
- **Approving twice:** quorum counts distinct people (`answers/store.ts:73`), and a redelivered answer is dropped.
- **Answering after expiry, or after the request closed:** refused.
- **Promoting autonomy:** it needs `policy_change_quorum` policy owners, and the agent's owners are excluded.
- **Placeholder secrets:** refused everywhere.
- **Acme:** needs the admin key on every route except `/health`.
- **`curl` to core, Switch or `:7800`:** held or denied.
- **`eval`, `xargs`, `find -exec`, `env -S` and git aliases:** held.
- **Already in Limits, so not counted as findings:** `bash script.sh`, `sed e`, `make`, `npx`, `git remote set-url`, a private chat in Switch, and the room hint being the agent's own word.
