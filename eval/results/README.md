# Result files you can check

These are the raw results behind the numbers in `RESULTS.md`, kept in git so you can read them without running anything.
Every file here is synthetic-world data: the customers, orders and money are Acme's seed data, and nothing real moved.

| File | What it is | How to use it |
|---|---|---|
| `e2-transcripts.jsonl` | The chat in every E2 room, one run per line: who said what, when, and which buttons each post offered. Known secret values are taken out on export. | `pnpm eval:vendors:rescore` works out E2's chat-based scores again from this file, with no agent, stack or Mattermost. |
| `vendors-as-run.json` | E2's results exactly as the runs left them, before the rescore. | Compare it with the scored results to see what the rescore changed. It changes cards, safe tasks and how a run ended, and gives up runs the agent was still working in. It never changes what was measured in Acme, git or the ledger. |
