# STATUS

Updated: Sat Nov 7, after Soham's review. Freeze Sat 15:00 and submit Sat 20:00 do not move. Soham's repo is the main repo. Its `master` is behind local `main`, and pushing is waiting on the owner's word.

Where things stand:
- **E1:** 25 of 25 isolated, and all 25 also ran on real Switch and Mattermost, with 5 adapted and saying how (`pnpm eval:authority:live`).
- **E2:** Claude's 120 runs are complete, with G-shadow and C rerun on the final code. OpenCode is partial, because its free tier ran out. It finishes with `--redo C` and `--retry-unfinished` if the limit lifts, and a background check is watching for that.
- **E3:** a 200-call blind sample is with the owner, for the owner and Soham to label by hand by 13:00.
- **F24:** Switch room roles say where refused work goes, and decide nothing. Live for the `merges` role.
- **Sixth review:** a teammate's break-it review (REVIEW.md), on an older commit. Each finding was run again on current code. Twelve breaks fixed, and re-checked in E1 as their own group, with four guards. What runs a hook is now read-only in the fence.
- **Fifth review:** 14 findings against the newest authority code, two of them self-approval that moves money. Fixed, and re-checked in E1 as its own group. E1 live passes on the fixed code. Waiting on the owner's word to push.
- **Video:** the script is recut around a real hand-off scene, with cropped cards. Scenes are being re-recorded on the final code. SC6 keeps its earlier take while OpenCode's free tier refuses.

After the freeze: latency and the 2-hour soak on frozen code, then rebuild the video with the corrected narration and these numbers.


## Gates

| Gate | Time (IST) | Must be true | State |
|---|---|---|---|
| G0 | Fri 05:00 | Repo scaffolded with CI. Switch standalone + Mattermost up. Spikes S1-S11 run, results and fallbacks in DECISIONS.md | done, except S5 for Codex and Cursor, blocked on logins; CI not yet run because nothing is pushed |
| G1 | Fri 11:00 | Submittable spine: SC3 end to end on Mattermost. SC1, SC2, SC14 clips. README stub. Repo pushed | SC3 passes on a real fenced agent; README done; final cut built on the fixed code, 2:44, refusal at 0:19; push waits on the owner and Soham |
| G2 | Fri 19:00 | Escalation + inbox, evidence card with mismatch, type-to-confirm. Codex, OpenCode (Cursor if S5) holding on SC5/SC6. Anti-evasion. Desk Queue + Ledger. Approval Lab and in-Switch study ready | done: the scenes for it pass live, and the Desk and the Lab are built |
| G3 | Sat 03:00 | Drills, rubber-stamp friction, earned autonomy with replay (SC9, SC11). Authority suite >= 23/25. E2, E4 running overnight | SC9, SC11 pass live. E1 25/25, and its live check, including a private chat, passes. Reviews 5/5, 28/28 and 19/19 on the fixed code, 0/28 and 0/19 before it. All 18 scenes pass live. Soak reruns on the frozen code. E2 is ready and only the owner can start it E2 hasn't started, and it now keeps every run's calls for E3, which a reset used to delete |
| G4 | Sat 13:00 | RESULTS.md complete from `pnpm eval:report`, with the negative result. Study analysed. README, blog, social drafts. Track 03 PR ready. P2 if green | E3 has a guide and a labelling tool and waits on E2. Soham has Track 03, recruiting and second labelling. The study runs Sat 09:00-13:00. F23, the report, is built and its tests pass. Its live run, SCRO, is still to do |
| Freeze | Sat 15:00 | Only demo-breaking fixes, each logged | |
| Video | Sat 15:00-19:00 | Automated capture, composition, captions, voice-over | |
| Submit pack | Sat 19:00 | SUBMISSION.md filled. `v1.0.0` tagged. CI green. Fresh-clone `just demo` verified | |

