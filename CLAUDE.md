# Clearance: rules for coding agents working in this repo

Read PLAN.md first. It is the source of truth; if a task conflicts with it, stop and say so.

Resume protocol: if you are a fresh session or were interrupted, read `STATUS.md`, `TASKS.md`, `HUMAN.md`, `DECISIONS.md` and `git log -20`, then continue from the first unticked task in the current gate. Never restart work that is already ticked.

## Hard rules
- No LLM calls in the decision path (classify, risk, route, grant, escalate, drill, promote). Deterministic code only.
- Fail closed. If something needed for a decision is missing, the answer is "hold" or "deny", never "allow".
- Identity comes from Switch events (sender, on_behalf_of, answered_by). Never trust identity text written by an agent.
- Every number in README/RESULTS/video/blog comes from a script in eval/. Never type a number by hand. Never fake agent output. Label synthetic data as synthetic.
- Never weaken, skip or delete a test to make it pass. If a test is wrong, explain why in the commit message.
- Switch is "source-available (Apache 2.0 with a modified Commons Clause)". Do not call it open source.
- Do not modify the Switch repo (`vendor/switch`, gitignored, pinned commit recorded in DECISIONS.md) or its bundled example templates for the main project.
- Secrets: never print, log or commit them. `.env` is gitignored, `.env.example` carries placeholders. Run `gitleaks detect` before every push.
- No destructive actions outside this repo and its Docker containers. The machine also runs containers from other projects (`sr-prod-pg`, `faultline-falkordb`): leave them alone. No force-push to `main`.
- Public actions need the human's OK: prepare the text, put it in `HUMAN.md`, and post with `gh` only after he ticks it.
- Demo host has 14 GB RAM and has hit OOM before: never run more than four agent sessions at once.

## Conventions
- TypeScript strict, Node 22, pnpm workspaces, Vitest, zod at every boundary. Test-driven: write the PLAN.md section 5 acceptance tests first. A feature is done only when its tests pass and its scenario runs on Mattermost.
- Commits (see DECISIONS.md for why this differs from the kickoff prompt): conventional prefixes (`feat(router): ...`), each commit covers a whole piece of work, feature and subagent branches come in with `git merge --squash` as one commit, doc and status updates go in the commit of the work they describe, no tiny fix-up commits. No attribution trailers. No "wip" on main after the freeze.
- Tick acceptance checkboxes in `TASKS.md` only when tests prove them. Update `STATUS.md` when you finish a task.

## Autonomy contract (kickoff prompt section 1)
1. Do all of the work yourself: code, tests, setup, Docker, Switch stack, scripts, evals, Desk UI, demo automation, video capture and editing, README, blog draft, social drafts, submission pack, and the Track 03 PR code.
2. Ask the human only for things impossible without him: browser logins and OAuth for agent CLIs and `gh`; typing API keys into `.env`; real people (study participants); posting anything public under his name (issue comments, PRs to other repos, the blog, social posts, Discord messages); signing the CLA; the submission form; spending money beyond the cap.
3. Never block on the human. Add needs to `HUMAN.md` as a checkbox with exact steps, copy-paste commands or text, why it's needed, and the deadline. Keep working on everything else.
4. Batch his tasks.
5. End of every turn: print a short banner with gate status and open `HUMAN.md` items, marked NOW or LATER.
6. Decide by yourself whenever PLAN.md answers the question or a sensible default exists. Log it in `DECISIONS.md` (`time IST | decision | why`) and move on.

## Hard rules from the kickoff prompt (section 2), in addition to the above
- Follow PLAN.md section 6.3 design decisions.
- Pin the Switch commit and record the SHA.
- Spikes first (PLAN 4.7). If one fails, take the documented fallback immediately, log it, and do not re-litigate it.
- Budget: track agent-run spend in `eval/costs.json`. Stop E2 and ask in `HUMAN.md` before passing the cap.

## When you must stop and ask (kickoff prompt section 7, only these)
- A login, key, CLA or submission step only he can do.
- Anything public under his name.
- Spend about to exceed the cap.
- A choice that can't be undone and isn't covered by PLAN.md or a sensible default.

For everything else, decide, log it and keep going.
