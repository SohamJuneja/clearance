# Clearance — rules for Claude Code

Clearance: the approval layer for teams of people + AI agents on Switch. Hackathon deadline Sat Nov 7, 20:00 IST.

## How we work
1. One task per session. The human names the task id (A-x or B-x). Do only that task.
2. Write tests first, run them, and show the real output. A task is done only when its "Done when" check passes.
3. Read CONTRACTS.md before writing code. Never change a contract unless the human says the change was agreed by both people; then update CONTRACTS.md in the same commit.
4. Folder ownership. Soham (A) owns: `clearance/`, `hook/`, `policy/policy.yaml` schema, `CLAUDE.md`, `CONTRACTS.md`. Teammate (B) owns: `demo/`, `study/`, `policy/org.yaml`, demo values in `policy/policy.yaml`, `README.md`, `docs/` writing, `blog.md`. Tests live in `tests/`; each person tests their own code. Do not edit the other person's folders.
5. Secrets go only in `.env` (gitignored). Never print or commit API keys or passwords.
6. Commit after each passing task: `A-4: policy engine, 17 tests`. Always `git pull --rebase` before `git push`.
7. Python 3.11+, type hints, standard library where possible. `hook/clearance_hook.py` must use the standard library only.
8. Keep it simple and deterministic: security decisions (who may approve, what is risky) are made in tested code, never by an LLM.
