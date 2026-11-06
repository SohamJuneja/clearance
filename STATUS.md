# STATUS

Updated: Fri Nov 6, 09:45 IST. Freeze Sat 15:00 and submit Sat 20:00 do not move.

## Gates

| Gate | Time (IST) | Must be true | State |
|---|---|---|---|
| G0 | Fri 05:00 | Repo scaffolded with CI. Switch standalone + Mattermost up. Spikes S1-S11 run, results and fallbacks in DECISIONS.md | done, except S5 for Codex and Cursor, blocked on logins; CI not yet run because nothing is pushed |
| G1 | Fri 11:00 | Submittable spine: SC3 end to end on Mattermost. SC1, SC2, SC14 clips. README stub. Repo pushed | SC3 passes on a real fenced agent; README done; recording next; push waits on the owner and Soham |
| G2 | Fri 19:00 | Escalation + inbox, evidence card with mismatch, type-to-confirm. Codex, OpenCode (Cursor if S5) holding on SC5/SC6. Anti-evasion. Desk Queue + Ledger. Approval Lab and in-Switch study ready | not started |
| G3 | Sat 03:00 | Drills, rubber-stamp friction, earned autonomy with replay (SC9, SC11). Authority suite >= 23/25. E2, E4 running overnight | SC9, SC11 pass live. E1 25/25, and its live check, including a private chat, passes. Soak running. E2 is set up and waits on the owner |
| G4 | Sat 13:00 | RESULTS.md complete from `pnpm eval:report`, with the negative result. Study analysed. README, blog, social drafts. Track 03 PR ready. P2 if green | not started |
| Freeze | Sat 15:00 | Only demo-breaking fixes, each logged | |
| Video | Sat 15:00-19:00 | Automated capture, composition, captions, voice-over | |
| Submit pack | Sat 19:00 | SUBMISSION.md filled. `v1.0.0` tagged. CI green. Fresh-clone `just demo` verified | |

## Current task per workstream

| Subagent | Scope | Current task |
|---|---|---|
| lead | integration, merges, docs | Core, gate and Switch client merged and wired. Live spine check passes with real cards. Next: real agent on SC3 |
| brain | `packages/core` | Wave 1 merged. Wave 2: type-to-confirm, drills, friction, autonomy, shadow, commands, P2 |
| gate-hooks | `packages/gate`, `packages/adapters`, `packages/hook-cli`, `acme-mini-app/` | Merged. Next when agents run: real payload checks per vendor |
| switchboard | `packages/switch-agent`, inbox, docs, templates, identities | Wave 1 merged (S2, S3, S4, S7, S8, S11). Wave 2: in-Switch study bot, safe exposure |
| vendor-spikes | `spikes/`, controller | Wave 1 merged. Wave 2: connector containment, controllers per owner, SC1 and SC2, agent setup |
| world-ui | `packages/acme`, `packages/desk`, `study/` | Wave 1 merged. Wave 2: Desk |
| proof | `eval/`, `scripts/`, demo automation, video pipeline | Wave 1 merged (runner, video, TTS, scan). Evals brief follows once a real agent passes SC3 |
