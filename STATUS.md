# STATUS

Updated: Fri Nov 6, 02:40 IST. Freeze Sat 15:00 and submit Sat 20:00 do not move.

## Gates

| Gate | Time (IST) | Must be true | State |
|---|---|---|---|
| G0 | Fri 05:00 | Repo scaffolded with CI. Switch standalone + Mattermost up. Spikes S1-S11 run, results and fallbacks in DECISIONS.md | scaffold and stack done; spikes running |
| G1 | Fri 11:00 | Submittable spine: SC3 end to end on Mattermost. SC1, SC2, SC14 clips. README stub. Repo pushed | not started |
| G2 | Fri 19:00 | Escalation + inbox, evidence card with mismatch, type-to-confirm. Codex, OpenCode (Cursor if S5) holding on SC5/SC6. Anti-evasion. Desk Queue + Ledger. Approval Lab and in-Switch study ready | not started |
| G3 | Sat 03:00 | Drills, rubber-stamp friction, earned autonomy with replay (SC9, SC11). Authority suite >= 23/25. E2, E4 running overnight | not started |
| G4 | Sat 13:00 | RESULTS.md complete from `pnpm eval:report`, with the negative result. Study analysed. README, blog, social drafts. Track 03 PR ready. P2 if green | not started |
| Freeze | Sat 15:00 | Only demo-breaking fixes, each logged | |
| Video | Sat 15:00-19:00 | Automated capture, composition, captions, voice-over | |
| Submit pack | Sat 19:00 | SUBMISSION.md filled. `v1.0.0` tagged. CI green. Fresh-clone `just demo` verified | |

## Current task per workstream

| Subagent | Scope | Current task |
|---|---|---|
| lead | integration, merges, docs | Scaffold and Switch stack done. Waiting on wave 1, then SC3 integration |
| brain | `packages/core` | Wave 1: F1, F3, F4, F6 card, F8, API, mismatch, F5 |
| gate-hooks | `packages/gate`, `packages/adapters`, `packages/hook-cli`, `acme-mini-app/` | Wave 1: gate HTTP, adapters, hook CLI, vendor configs, MCP |
| switchboard | `packages/switch-agent`, inbox, docs, templates, identities | Wave 1: personas, protocol client, S2, S3, S4, S7, S8, S11, templates |
| vendor-spikes | `spikes/`, controller | Wave 1: controller, S1, S5, S6, S9 (Claude); others blocked on logins |
| world-ui | `packages/acme`, `packages/desk`, `study/` | Wave 1: Acme, demo-reset, study sets, Approval Lab, S10 |
| proof | `eval/`, `scripts/`, demo automation, video pipeline | Starts when Acme and core land |
