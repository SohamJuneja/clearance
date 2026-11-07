# Result files you can check

These are the raw results behind the numbers in `RESULTS.md`, kept in git so you can read them without running anything. On a fresh clone, `pnpm eval:report` builds the table from this folder. `pnpm eval:publish` copies a machine's own runs here, and refuses if a file holds a known secret or anything shaped like a real key.

The customers, orders and money in all of these are Acme's seed data, and nothing real moved. Where a file says synthetic or says a chat port is fake, the table says so too.

| File | What it is |
|---|---|
| `authority.json` | E1: the 25 cases and the five reviews' re-checks, with why each ended as it did. |
| `authority-live.json` | E1's cases run through real Mattermost and Switch, by `pnpm eval:authority:live`: real presses by real accounts, and real core, gate and Acme. The agent's call is scripted. Each row's `differs` says what's different from the isolated case, and `adapted` marks a case that had to change to fit the shared stack. |
| `authority-mutations.json` | Checks that E1's cases test what they say, by breaking a control and seeing a case fail. |
| `vendors.json` | E2: every run's result, scored from its transcript. |
| `e2-transcripts.jsonl` | The chat in every E2 room, one run per line: who said what, when, and which buttons each post offered. `pnpm eval:vendors:rescore` works E2's chat-based scores out again from this file, with no agent, stack or Mattermost. A condition that was run again keeps its earlier rooms here too, and `vendors.json` says which room each current run used. |
| `vendors-as-run.json` | E2's results exactly as the runs left them, before the rescore. Compare it with `vendors.json` to see what the rescore changed: cards, safe tasks and how a run ended, and runs given up because the agent was still working. It never changes what was measured in Acme, git or the ledger. |
| `e3-calls.jsonl` | Every tool call Clearance logged during E2, one per line, with what it decided and which run it came from. A run named `earlier:` was run again later. `pnpm eval:vendors:rescore` reads it to say which runs a control refused, and E3's labels point at its ids. |
| `e2-first-attempt.json` | The E2 attempt where nobody answered the agent, kept because of what it showed. |
| `baseline.json`, `baseline-extra.jsonl`, `baseline-left-out.jsonl` | Real runs with no Clearance. |
| `behaviour.json` | What agents did after a hold. |
| `autonomy.json` | E6, on a synthetic week. |
| `e4-latency.json`, `e4-soak.json` | E4: added latency and the soak. |
