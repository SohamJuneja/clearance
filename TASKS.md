# TASKS

Tick a box only when tests or a run prove it. Acceptance text is copied from PLAN.md. Owners are subagents; `lead` is the main session.

## Spikes (PLAN 4.7), all for G0

- [x] **S1** (gate-hooks, lead) Switch-managed Claude Code runs PreToolUse hooks from `.claude/settings.json` in its working directory in auto mode; `deny` blocks `git push` and the reason appears in the reply. Fallback: user-level settings, then managed settings, then gate-only.
- [x] **S2** (switchboard) Protocol agent opens native approval cards; button press arrives as `approval_outcome` with `answered_by`. Fallback: text cards with our grammar.
- [x] **S3** (switchboard) Addressing policy restricts who may answer Clearance's cards. Fallback: Clearance's own re-check.
- [x] **S4** (switchboard, brain) Attribute each held action to the human who asked. Fallback: everyone who addressed that agent in the last 10 minutes counts as a requester.
- [ ] **S5** (OpenCode passes; Codex and Cursor blocked on logins) (gate-hooks) Vendor hooks run under Switch: Codex, OpenCode, Cursor. Fallback: gate-only for that vendor, coverage table says so.
- [x] **S6** (Claude, OpenCode; Codex mechanics; Cursor blocked) (gate-hooks) Agents load an MCP server from project config. Fallback: `acme` CLI through Bash.
- [x] **S7** (variant) (switchboard) Clearance can create a DM room with one approver and post a card with buttons. Fallback: `#approvals` plus `send_targeted_message`.
- [x] **S8** (create, update; list command broken upstream) (switchboard) Room documents for the ledger. Fallback: ledger in the Desk, daily summary message.
- [x] **S9** (not met; fallback taken) (brain, lead) Agents follow the HELD protocol, 5 of 5 runs per vendor. Fallback: execute-on-approval through the gate.
- [x] **S10** (reachability; phone login untested) (world-ui) Study participants reach Mattermost through a tunnel. Fallback: Approval Lab.
- [x] **S11** (switchboard) A template can include Clearance as a member. Fallback: setup script.

## Features (PLAN 5)

### P0: the submittable spine

- **F1 One policy file** (brain)
  - [x] Schema validated with zod at load; a bad policy refuses to start with a line-numbered error.
  - [x] `pnpm policy:test` runs table tests: 60+ example calls across four vendors map to the expected class and tier (`policy/tests/*.yaml`).
  - [x] Hot reload on file change, recorded as a ledger entry with the new policy hash.
  - [x] Unknown tool calls default to `allow` only if they match the `safe` list; anything touching a protected resource with no rule defaults to `hold`.
- **F2 Enforcement points** (gate-hooks; P0 gate + Claude hook, P1 others)
  - [ ] For each vendor in the coverage table, a scripted run shows a held refund and a held `git push --force origin main`, or the README marks that vendor "gate only".
  - [x] Hooks never use `ask`; they return `allow` or `deny` with a reason.
  - [ ] Hook round trip p95 under 50 ms for allowed calls on the demo host (E4).
- **F3 Hold, grant, execute** (gate-hooks + brain)
  - [x] Replay of a consumed grant is held again (test).
  - [x] Changing one argument after approval creates a new request (test).
  - [ ] Request TTL 25 minutes; on expiry the action is denied and the requester is told.
  - [x] Two parallel identical calls with one grant: exactly one executes (SQLite transaction, test).
- **F4 Router with separation of duties** (brain; P0 core, P1 presence, load, quorum)
  - [ ] Authority suite cases 1 to 4, 12 and 13 pass.
  - [ ] Requester answering their own card: Clearance records `INELIGIBLE_ANSWER (requester)`, posts a visible refusal in the room, and re-routes.
  - [ ] Identity resolution: two chat accounts linked to the same Switch user count as one person.
- **F6 Evidence card** (switchboard + brain; P0 card, P1 mismatch and context)
  - [x] Snapshot tests for card text across 10 fixture calls.
  - [x] Mismatch detector fixtures: 20 positive, 20 negative, 0 false flags on the negatives.
  - [x] Type-to-confirm rejects a wrong value and re-asks once.
- **F8 Ledger** (brain; P0 table, P1 mirror and verify)
  - [x] Tampering with one row makes verify fail at that row (test).
  - [ ] `!list-documents` in `#approvals` shows today's ledger document.

### P1: the differentiators

- **F5 Escalation and fail-closed expiry** (brain)
  - [x] Timers survive a Clearance restart (stored in SQLite, resumed on boot).
  - [ ] Expired requests never execute (test with the gate).
  - [x] Each escalation step is a ledger entry.
- **F7 One inbox across rooms** (switchboard)
  - [x] Two requests from two rooms appear in one approver's inbox within 2 seconds of being held.
  - [x] Answering from the inbox handle settles the original request.
- **F9 Approval drills** (brain)
  - [x] A drill and a real request render identically apart from content (snapshot diff only in values).
  - [x] Approving a drill calls nothing on the gate (test with a spy).
  - [ ] Drill catch rate per approver in the Desk.
- **F10 Rubber-stamp detection and friction** (brain)
  - [x] Unit tests for each signal.
  - [ ] In the demo, a 1.8 s approval of a drill produces the private note and the next card asks for a typed amount.
- **F11 Earned autonomy** (brain)
  - [x] Seeded 7-day history (clearly labelled synthetic) yields exactly one proposal.
  - [x] Replay numbers come from `pnpm eval:autonomy`.
  - [x] One incident demotes and the next refund in the bucket is held again.
- **F12 Clearance Desk** (world-ui)
  - [x] Loads in under 1 s locally.
  - [x] Every number on the Desk matches the API.
- **F13 Why me / why held** (brain)
  - [x] Trace is generated from the same function the router uses (no second implementation).
- **F14 Anti-evasion** (gate-hooks + brain)
  - [ ] Authority suite cases 9, 10 and 11 pass.
- **F15 One-command install** (switchboard)
  - [x] `@clearance install` runs the template through `run_template` and replies with what it created. No changes to Switch code or bundled templates.

### P2: after P0 and P1 are green

- [x] **F16** Shadow mode and policy simulator (brain)
- [x] **F17** Policy changes need two approvers (brain)
- [x] **F18** Break-glass with named emergency approvers (brain)
- [x] **F19** Delegation, away mode, quiet hours (brain)
- [x] **F20** Approve with edits (gate-hooks + brain). Live as SCCO: one refund, for the edited amount.
- [x] **F21** Switch Trust endpoint that flags pressure messages (switchboard). Live: flagged in the room, no card or decision changed, about 10 ms per agent send. Off by default.
- [x] **F22** Daily digest and audit export (brain)
- [ ] **F23** The report: `@clearance roi`, the daily `clearance-roi` document and the Desk tile (brain, world-ui). Tests pass. Open until `pnpm demo:run SCRO` runs on Mattermost and the document's notice is seen in `#approvals`.
- [x] **F24** Send refused work to the job with Switch room roles, which decide nothing (lead). Tests pass. Live on the code with the fifth review's fixes as SCHO 3 of 3 and SCHW 1 of 1, for the `merges` role only. Two earlier takes after those fixes failed and led to changes: one agent rightly refused a PR that removes a session check, and one named the role before being refused. The other three roles are declared and mapped, and haven't been taken live.

## Scenarios (PLAN 8.7): each must run on Mattermost via `pnpm demo:run SCn`

- [x] **SC1** (proof) Baseline, auto mode on: refund executes, no card.
- [x] **SC2** (proof) Baseline, auto mode off: native card mentions Priya; she presses Allow; refund executes.
- [x] **SC3** (lead) Hold, refusal, route, mismatch; Sam denies; ledger entry.
- [x] **SC4** (lead) Legit large refund: Sam approves; gate executes; refund ID posted.
- [ ] **SC5** (gate-hooks) Cross-vendor email (Codex): held, routed to Priya, Sam cannot approve, Priya denies.
- [x] **SC6** (gate-hooks) Cross-vendor deploy (OpenCode): held, routed to Alex, 2 failing checks, Alex denies.
- [x] **SC7** (gate-hooks) Claude coder force-push: hook held; Alex refused; card goes to Dev, who denies.
- [x] **SC8** (switchboard) Escalation and inbox: Neha gets the card after 18 s at 10x; both inboxes update.
- [x] **SC9** (brain) Drill: Sam approves under 2 s; private note; next high card asks to type the amount.
- [x] **SC10** (brain) Structuring: third refund held by the aggregate rule.
- [x] **SC11** (brain) Earned autonomy: promotion, review card, incident demotes, next refund held.
- [x] **SC12** (gate-hooks) Fail closed: core down gives 503; restart resumes timers.
- [x] **SC13** (gate-hooks) Evasion: hook denies direct curl with a reason; ledger entry.
- [x] **SC14** (proof) Rubber-stamping without Clearance: five cards in under ten seconds of looking, labelled staged. It claims speed only, since no take included the ₹40,000 refund.

## Evaluations (PLAN 10)

- [x] **E1** (proof, brain) Authority suite, 25 cases, B-auto, B-ask, C. `pnpm eval:authority`. Target >= 23/25 by G3.
- [ ] **E2** (proof) Cross-vendor holds, 360 runs planned, 200 possible with Codex and Cursor blocked. `pnpm eval:vendors`. Respect the spend cap. Claude complete (120 of 120). OpenCode partial: its free tier ran out, `--retry-unfinished` finishes it. Scored from saved transcripts by `pnpm eval:vendors:rescore`.
- [ ] **E3** (proof, brain) Quiet on safe work and recall, held-out split at Fri 20:00. `pnpm eval:classifier`.
- [x] **E4** (proof) Latency 1,000 calls each; 2 h soak; three chaos restarts. `pnpm eval:latency`, `pnpm eval:soak`.
- [ ] **E5** (world-ui, proof) Human study, Switch card vs Clearance card. `pnpm eval:study`.
- [x] **E6** (brain) Earned autonomy, labelled synthetic week. `pnpm eval:autonomy`.
- [ ] **Report** (proof) `pnpm eval:report` writes RESULTS.md, including a negative result.

## Deliverables

- [x] **D1** (lead) Repo scaffold, CI, licence (CI runs once the repo is on GitHub).
- [x] **D2** (world-ui) Acme Mini services, CLI, seed data; `scripts/demo-reset.ts` under 10 s.
- [x] **D3** (switchboard) `templates/` for clearance, acme-mini, acme-vanilla.
- [x] **D4** (proof) `pnpm demo:run SCn` for every scenario through the Mattermost API and Playwright. People scripted, agents never.
- [x] **D5a** (proof) Get Clearance's first refusal on screen by 0:20 of the video, by shortening the opening. A judge skims.
- [x] **D5** (proof) Video pipeline: Playwright capture at 1920x1080, ffmpeg split screens, captions, "clock 10x", numbers slide from RESULTS.md, offline TTS. Under 3:00.
- [ ] **D6** (lead) README per PLAN 13, including Best demo path, "Remove Switch and this breaks", How we used AI tools, Threat model and limits, vendor coverage table.
- [ ] **D7** (lead) `docs/threat-model.md`, `docs/architecture.md`, `docs/policy-reference.md`, `docs/built-by-voice.md`.
- [ ] **D8** (lead) Blog draft, 1,000 to 1,500 words, in HUMAN.md.
- [ ] **D9** (lead) Three #HowISwitch posts with clips, in HUMAN.md.
- [ ] **D10** (switchboard) Track 03, now #833 Canva: connector built locally in `/home/prashant/projects/switch-track03`, comment and PR text drafted, go or drop waits on the owner's Canva probe.
- [x] **D11** (world-ui, switchboard) Study: recruitment text, consent, sets X and Y, Approval Lab, in-Switch study bot, analysis. Built and rehearsed; no real participant yet.
- [ ] **D12a** (lead) At release, commit the result files from gitignored `eval/out` to a tracked folder, after a secret scan, so a judge can read what each number came from. The baseline's raw runs are already tracked in `eval/baseline/runs/`.
- [ ] **D13** (lead) `SUBMISSION.md` with every form field. Tag `v1.0.0`. CI green. Fresh-clone `just demo` verified in a clean temp directory.
