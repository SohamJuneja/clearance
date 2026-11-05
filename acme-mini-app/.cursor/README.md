# Cursor config: untested

Nothing in this folder has been run. Cursor's CLI is not installed on the demo host, so `hooks.json` and `mcp.json` come from Cursor's docs and Switch's adapter source. Spikes S5 and S6 are still blocked on install and login.

Check these first when it can be run:

- Whether project hooks are silently skipped until the workspace is trusted. Codex does exactly that, and the docs say "Project hooks run in any trusted workspace."
- Whether a hook that exits 2 still delivers `agent_message`.
- How to pass the gate token to `mcp.json`. It has only the URL for now, so the gate answers 401 and the `acme` CLI remains the way in.

Until then the gate is the only control for Cursor agents. Call them "gate only" in the README's coverage table.
