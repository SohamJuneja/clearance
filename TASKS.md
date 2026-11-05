# TASKS

Tick a box only when tests or a run prove it. Acceptance text is copied from PLAN.md. Owners are subagents; `lead` is the main session.

## Spikes (PLAN 4.7), all for G0

- [ ] **S1** (gate-hooks, lead) Switch-managed Claude Code runs PreToolUse hooks from `.claude/settings.json` in its working directory in auto mode; `deny` blocks `git push` and the reason appears in the reply. Fallback: user-level settings, then managed settings, then gate-only.
- [x] **S2** (switchboard) Protocol agent opens native approval cards; button press arrives as `approval_outcome` with `answered_by`. Fallback: text cards with our grammar.
- [x] **S3** (switchboard) Addressing policy restricts who may answer Clearance's cards. Fallback: Clearance's own re-check.
- [x] **S4** (switchboard, brain) Attribute each held action to the human who asked. Fallback: everyone who addressed that agent in the last 10 minutes counts as a requester.
- [ ] **S5** (gate-hooks) Vendor hooks run under Switch: Codex, OpenCode, Cursor. Fallback: gate-only for that vendor, coverage table says so.
- [ ] **S6** (gate-hooks) Agents load an MCP server from project config. Fallback: `acme` CLI through Bash.
- [x] **S7** (variant) (switchboard) Clearance can create a DM room with one approver and post a card with buttons. Fallback: `#approvals` plus `send_targeted_message`.
- [x] **S8** (create, update; list command broken upstream) (switchboard) Room documents for the ledger. Fallback: ledger in the Desk, daily summary message.
- [ ] **S9** (brain, lead) Agents follow the HELD protocol, 5 of 5 runs per vendor. Fallback: execute-on-approval through the gate.
- [x] **S10** (reachability; phone login untested) (world-ui) Study participants reach Mattermost through a tunnel. Fallback: Approval Lab.
- [x] **S11** (switchboard) A template can include Clearance as a member. Fallback: setup script.

## Features (PLAN 5)

### P0: the submittable spine

- **F1 One policy file** (brain)
  - [ ] Schema validated with zod at load; a bad policy refuses to start with a line-numbered error.
  - [ ] `pnpm policy:test` runs table tests: 60+ example calls across four vendors map to the expected class and tier (`policy/tests/*.yaml`).
  - [ ] Hot reload on file change, recorded as a ledger entry with the new policy hash.
  - [ ] Unknown tool calls default to `allow` only if they match the `safe` list; anything touching a protected resource with no rule defaults to `hold`.
- **F2 Enforcement points** (gate-hooks; P0 gate + Claude hook, P1 others)
  - [ ] For each vendor in the coverage table, a scripted run shows a held refund and a held `git push --force origin main`, or the README marks that vendor "gate only".
  - [ ] Hooks never use `ask`; they return `allow` or `deny` with a reason.
  - [ ] Hook round trip p95 under 50 ms for allowed calls on the demo host (E4).
- **F3 Hold, grant, execute** (gate-hooks + brain)
  - [ ] Replay of a consumed grant is held again (test).
  - [ ] Changing one argument after approval creates a new request (test).
  - [ ] Request TTL 25 minutes; on expiry the action is denied and the requester is told.
  - [ ] Two parallel identical calls with one grant: exactly one executes (SQLite transaction, test).
- **F4 Router with separation of duties** (brain; P0 core, P1 presence, load, quorum)
  - [ ] Authority suite cases 1 to 4, 12 and 13 pass.
  - [ ] Requester answering their own card: Clearance records `INELIGIBLE_ANSWER (requester)`, posts a visible refusal in the room, and re-routes.
  - [ ] Identity resolution: two chat accounts linked to the same Switch user count as one person.
- **F6 Evidence card** (switchboard + brain; P0 card, P1 mismatch and context)
  - [ ] Snapshot tests for card text across 10 fixture calls.
  - [ ] Mismatch detector fixtures: 20 positive, 20 negative, 0 false flags on the negatives.
  - [ ] Type-to-confirm rejects a wrong value and re-asks once.
- **F8 Ledger** (brain; P0 table, P1 mirror and verify)
  - [ ] Tampering with one row makes verify fail at that row (test).
  - [ ] `!list-documents` in `#approvals` shows today's ledger document.

### P1: the differentiators

- **F5 Escalation and fail-closed expiry** (brain)
  - [ ] Timers survive a Clearance restart (stored in SQLite, resumed on boot).
  - [ ] Expired requests never execute (test with the gate).
  - [ ] Each escalation step is a ledger entry.
- **F7 One inbox across rooms** (switchboard)
  - [ ] Two requests from two rooms appear in one approver's inbox within 2 seconds of being held.
  - [ ] Answering from the inbox handle settles the original request.
- **F9 Approval drills** (brain)
  - [ ] A drill and a real request render identically apart from content (snapshot diff only in values).
  - [ ] Approving a drill calls nothing on the gate (test with a spy).
  - [ ] Drill catch rate per approver in the Desk.
- **F10 Rubber-stamp detection and friction** (brain)
  - [ ] Unit tests for each signal.
  - [ ] In the demo, a 1.8 s approval of a drill produces the private note and the next card asks for a typed amount.
- **F11 Earned autonomy** (brain)
  - [ ] Seeded 7-day history (clearly labelled synthetic) yields exactly one proposal.
  - [ ] Replay numbers come from `pnpm eval:autonomy`.
  - [ ] One incident demotes and the next refund in the bucket is held again.
- **F12 Clearance Desk** (world-ui)
  - [ ] Loads in under 1 s locally.
  - [ ] Every number on the Desk matches the API.
- **F13 Why me / why held** (brain)
  - [ ] Trace is generated from the same function the router uses (no second implementation).
- **F14 Anti-evasion** (gate-hooks + brain)
  - [ ] Authority suite cases 9, 10 and 11 pass.
- **F15 One-command install** (switchboard)
  - [ ] `@clearance install` runs the template through `run_template` and replies with what it created. No changes to Switch code or bundled templates.

### P2: after P0 and P1 are green

- [ ] **F16** Shadow mode and policy simulator (brain)
- [ ] **F17** Policy changes need two approvers (brain)
- [ ] **F18** Break-glass with named emergency approvers (brain)
- [ ] **F19** Delegation, away mode, quiet hours (brain)
- [ ] **F20** Approve with edits (gate-hooks + brain)
- [ ] **F21** Switch Trust endpoint that flags pressure messages (switchboard)
- [ ] **F22** Daily digest and audit export (brain)

## Scenarios (PLAN 8.7): each must run on Mattermost via `pnpm demo:run SCn`

- [ ] **SC1** (proof) Baseline, auto mode on: refund executes, no card.
- [ ] **SC2** (proof) Baseline, auto mode off: native card mentions Priya; she presses Allow; refund executes.
- [ ] **SC3** (lead) Hold, refusal, route, mismatch; Sam denies; ledger entry.
- [ ] **SC4** (lead) Legit large refund: Sam approves; gate executes; refund ID posted.
- [ ] **SC5** (gate-hooks) Cross-vendor email (Codex): held, routed to Priya, Sam cannot approve, Priya denies.
- [ ] **SC6** (gate-hooks) Cross-vendor deploy (OpenCode): held, routed to Alex, 2 failing checks, Alex denies.
- [ ] **SC7** (gate-hooks) Claude coder force-push: hook held; escalates to `#eng`.
- [ ] **SC8** (switchboard) Escalation and inbox: Neha gets the card after 18 s at 10x; both inboxes update.
- [ ] **SC9** (brain) Drill: Sam approves under 2 s; private note; next high card asks to type the amount.
- [ ] **SC10** (brain) Structuring: third refund held by the aggregate rule.
- [ ] **SC11** (brain) Earned autonomy: promotion, review card, incident demotes, next refund held.
- [ ] **SC12** (gate-hooks) Fail closed: core down gives 503; restart resumes timers.
- [ ] **SC13** (gate-hooks) Evasion: hook denies direct curl with a reason; ledger entry.
- [ ] **SC14** (proof) Rubber-stamping without Clearance: five cards in under ten seconds, labelled staged.

## Evaluations (PLAN 10)

- [ ] **E1** (proof, brain) Authority suite, 25 cases, B-auto, B-ask, C. `pnpm eval:authority`. Target >= 23/25 by G3.
- [ ] **E2** (proof) Cross-vendor holds, 360 runs. `pnpm eval:vendors`. Respect the spend cap.
- [ ] **E3** (proof, brain) Quiet on safe work and recall, held-out split at Fri 20:00. `pnpm eval:classifier`.
- [ ] **E4** (proof) Latency 1,000 calls each; 2 h soak; three chaos restarts. `pnpm eval:latency`, `pnpm eval:soak`.
- [ ] **E5** (world-ui, proof) Human study, Switch card vs Clearance card. `pnpm eval:study`.
- [ ] **E6** (brain) Earned autonomy, labelled synthetic week. `pnpm eval:autonomy`.
- [ ] **Report** (proof) `pnpm eval:report` writes RESULTS.md, including a negative result.

## Deliverables

- [x] **D1** (lead) Repo scaffold, CI, licence (CI runs once the repo is on GitHub).
- [x] **D2** (world-ui) Acme Mini services, CLI, seed data; `scripts/demo-reset.ts` under 10 s.
- [x] **D3** (switchboard) `templates/` for clearance, acme-mini, acme-vanilla.
- [ ] **D4** (proof) `pnpm demo:run SCn` for every scenario through the Mattermost API and Playwright. People scripted, agents never.
- [ ] **D5** (proof) Video pipeline: Playwright capture at 1920x1080, ffmpeg split screens, captions, "clock 10x", numbers slide from RESULTS.md, offline TTS. Under 3:00.
- [ ] **D6** (lead) README per PLAN 13, including Best demo path, "Remove Switch and this breaks", Related work, How we used AI tools, Threat model and limits, vendor coverage table.
- [ ] **D7** (lead) `docs/threat-model.md`, `docs/architecture.md`, `docs/policy-reference.md`, `docs/built-by-voice.md`.
- [ ] **D8** (lead) Blog draft, 1,000 to 1,500 words, in HUMAN.md.
- [ ] **D9** (lead) Three #HowISwitch posts with clips, in HUMAN.md.
- [ ] **D10** (switchboard) Track 03 #803: design comment text, PR code in a fork, in HUMAN.md.
- [ ] **D11** (world-ui) Study: recruitment text, consent, sets X and Y, Approval Lab, in-Switch study bot, analysis.
- [ ] **D12** (proof) Competition re-scan Fri 12:00 and Sat 12:00; update README Related work.
- [ ] **D13** (lead) `SUBMISSION.md` with every form field. Tag `v1.0.0`. CI green. Fresh-clone `just demo` verified in a clean temp directory.
