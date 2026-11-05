# DECISIONS

Append-only. Format: `time IST | decision | why`.

## Fri Nov 6

- 02:30 | Timeline: use the kickoff prompt's revised gates (G0 Fri 05:00 ... submit pack Sat 19:00), not PLAN section 9 | Kickoff prompt says so; we start about 10 h behind PLAN section 9.
- 02:30 | Build order: solo order from PLAN 9.4, run by five subagents (gate-hooks, switchboard, brain, world-ui, proof) | Kickoff section 5.
- 02:30 | Commit style: conventional prefixes, but each commit is a whole piece of work and subagent branches come in with `git merge --squash`. Push whenever a whole piece lands, not on a fixed hourly tick | The kickoff asks for "small commits pushed hourly"; the owner's global rules for every project ask for as few, large commits as possible and squash merges. The global rule is the standing preference and history still shows work across the event dates. Flagged in the first banner so he can overrule it.
- 02:30 | Switch pinned at `1fe56227b6e330452ac80d7b7b2ca0a66aaeaeab` (2026-11-05 09:33 UTC, describes as `switch-v0.32.0-rc.1-106-g1fe56227b`) in `vendor/switch` (gitignored) | Kickoff section 4.4: the commit still exists, and main has moved 89 commits past it. No upgrades mid-build (risk R6).
- 02:30 | User-space installs only: `just` via `uv tool`. No `sqlite3` CLI: use Python's `sqlite3` module or better-sqlite3 for debugging. Cursor CLI install moved to HUMAN.md | No passwordless sudo on this machine, and this session's permission rules refuse `curl | bash` remote installers, so he runs Cursor's installer himself when he runs `agent login`. Nothing in the product or `just demo` needs the `sqlite3` binary.
- 02:30 | OpenCode 1.18.27 installed side by side in `~/.local/share/clearance-tools`; the owner's global 1.18.34 stays | PLAN pins 1.18.27 (plugin API v1); changing his global CLI could break his other work. The controller gets this path first on PATH.
- 02:30 | GitHub repos start **private**; flipping public is a LATER item in HUMAN.md | Making a repo public is a public action under his name (kickoff section 1.2). Revised G1 only asks for "repo pushed". Must be public before submission.
- 02:30 | pnpm 12.14.0 (what is installed) pinned via `packageManager`, not pnpm 9 | PLAN says pnpm 9 but no feature depends on it; avoids a second package manager on the host.
- 02:35 | Added `packages/contracts` (shared zod schemas and ports) and `docs/integration-contract.md`, beyond the PLAN 6.9 layout | Five subagents build in parallel worktrees; they need one agreed shape for Action, ports and HTTP between core, gate and Acme.
- 02:35 | Card text rendering sits in `packages/core/src/cards`, owned by brain for P0; switchboard owns the transport (`ChatPort`) | Card rendering is a pure function of the request and evidence, and the spine needs it first. Kickoff listed cards under switchboard; the split removes a cross-worktree dependency.
- 02:35 | `/v1/hooks/*` routes ship from `@clearance/adapters` as a Fastify plugin that core mounts | Lets gate-hooks and brain work without editing the same server file.
- 02:40 | GitHub repo creation and pushes are his step for now, tracked in HUMAN.md | This session's permission check refused `gh repo create` plus `git push` as a data upload. I won't route around it. All work stays in local commits and nothing is lost; CI can't run until the first push. G1 needs the repo pushed by Fri 11:00.
