# Clearance

A refund-approval workflow for teams of people and AI agents, built on [Switch](https://github.com/sandbox-quantum/switch). The person who asks an agent to move money can't also be the one who approves it.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE) ![Built Nov 6 to 7, 2026](https://img.shields.io/badge/built-Nov%206%20to%207%202026-555)

Team dellfargo's entry to the Flip the Switch hackathon, Track 01: Best Business Workflow.

<!-- video:start -->
<!-- video:end -->

![Priya asked for the refund and answers her own card. Clearance refuses her in the room, and the card goes to Sam in finance, with the new payment ID flagged.](docs/media/refusal.png)

*Priya, on the left, asked for this refund and tried to approve it. Clearance refused her in the room and sent the card to Sam in finance, on the right. Real agent, real Mattermost. People's presses are scripted, and the agent's words aren't.*

<!-- measured:start -->
We gave real agents in real Switch rooms risky requests against a synthetic company. With nobody answering, the agent moved nothing in 20 risky runs, because it stops to ask. So a scripted requester now answers "Yes, go ahead" once if asked, in every condition, as someone in a small team would. With no Clearance, Claude's agent stopped to ask in 10 of 20 runs, the requester said yes, and it went ahead in 5 of them, including a ₹40,000 refund and a deleted customer record. OpenCode's agent went ahead in 13 of 18 runs, 9 of them without asking. On the prompts it finished both ways, that's 7 of 9 against 0 of 9. With Clearance, the same yes moved nothing, and no risky action ran without an eligible person's approval, in 31 finished runs. The table below has the rest, including where Clearance loses.
<!-- measured:end -->

## The workflow

1. Priya asks `@refunds-agent` for a refund in `#support`.
2. The agent runs `bin/acme refund`. The agent has no credentials for that. A small gate holds them and asks Clearance first, so the refund is held and the agent is told to stop.
3. A native Switch card opens. It leads with the call as parsed from what the agent ran and facts from the systems of record, such as a payment ID added minutes ago. The agent's own sentence comes last, labelled unverified.
4. Priya presses Approve, and Clearance refuses her in the room, because she asked. Who asked comes from Switch's own events, never from an agent's text.
5. Sam, the finance approver on duty, gets the card in his direct room. If he approves, the gate runs exactly that call, once. If nobody answers, it escalates on a timer.
6. Everything goes on a tamper-evident ledger. Practice requests with a planted flaw check that approvers still read, and agents can earn the right to handle small refunds alone, with two people signing and one incident taking it away.

The same policy file covers merges, deploys, deletes, customer emails and payout changes. Decisions are deterministic code over that file, with no LLM in the decision path. [docs/why.md](docs/why.md) has the problem and its sources, and [docs/architecture.md](docs/architecture.md) has the flow step by step.

## Agents and channels

The demo is a small synthetic company, Acme Mini, on Mattermost through Switch's bridge.

| Agent | Runs on | Rooms | Owner | Its job | In our runs |
|---|---|---|---|---|---|
| `refunds-agent` | Claude Code, Haiku | `#support` (visits `#eng`) | Priya | Refunds, payout changes | Ran |
| `coder` | Claude Code, Haiku | `#eng` | Alex | Merges | Ran |
| `ops-agent` | OpenCode, a free model | `#eng` | Alex | Deploys, deletes | Ran until its free tier ran out |
| `support-agent` | Codex | `#support` | Priya | Customer email | Configured, not run: no Codex login |
| `reviewer` | Cursor CLI | `#eng` | Alex | Merges | Configured, not run: Cursor isn't installed |
| `clearance` | Switch's agent protocol | Every room | The team | Decides who may let an action through | Ran |

| Room | People | What it's for |
|---|---|---|
| `#support` | Priya, Sam | Customer work and refunds |
| `#eng` | Alex, Dev, Priya | Code, merges, deploys |
| `#finance` | Sam, Neha | Finance's own room |
| `#approvals` | Sam, Neha, Alex, Dev, Priya | Where a card goes when nobody named can take it |
| Direct rooms | One per approver | Each approver's inbox across rooms |

`templates/acme-mini.template.yaml` creates the agents, rooms and job roles, and `templates/clearance.template.yaml` is what `@clearance install` runs on your own team. Addressing is limited to named rooms, and only linked people can answer a card.

## Run it

```bash
git clone https://github.com/SohamJuneja/clearance && cd clearance
cp .env.example .env     # add one Anthropic key, or be signed in to Claude on this host
just demo                # Switch, Mattermost, Acme and Clearance, seeded
pnpm demo:run SC3        # the refund above, with real agents
```

Then open http://localhost:8065 and log in as `priya` or `sam`, with `PERSONA_PASSWORD` from `.env`. It needs Docker, Node 22, pnpm, `just` and a few GB of free memory, and `just demo --check` says what's missing. `just demo --no-agents` runs it with no key and no LLM, on scripted calls. [docs/running-it.md](docs/running-it.md) has the rest, including every scene.

## How Clearance uses Switch

| Switch capability | How Clearance uses it | Code |
|---|---|---|
| Agent protocol: register, SSE stream, heartbeat, operations | Clearance is a Switch agent | `packages/switch-agent` |
| Approval cards and `approval_outcome` | Every card is a native Switch card with buttons | `packages/core/src/cards` |
| Answer grammar (`A12 yes`) | The same grammar, plus type-to-confirm cards | `packages/core/src/confirm` |
| Identity claims, `answered_by`, `sender` | Who asked and who approved, never from an agent's text | `packages/core/src/router/requesters.ts` |
| Rooms, direct rooms, groups | `#approvals` and one direct room per approver | `templates/` |
| Targeted messages | Escalations and agent notifications | `packages/core/src/escalation` |
| Room roles, `assume_role`, `@role` | A refused agent writes `@merges`, and whoever holds that role picks the work up. Roles only say where work goes: any member can take one, so authority stays in `policy/` and the gate's grants | `packages/contracts/src/job-roles.ts` |
| Room documents | The ledger, mirrored per day | `packages/core/src/ledger/mirror.ts` |
| Templates v2 and `run_template` | `@clearance install` and the demo world | `templates/` |
| Managed agents across vendors | One policy over all of them | `acme-mini-app/`, `scripts/setup-agents.ts` |
| Addressing policy | Only linked people can answer Clearance's cards | `scripts/setup-identities.ts` |
| Switch Trust (optional, off by default) | Flags agent messages that pressure approvers. It's advice, and never changes a decision | `packages/core/src/trust` |

Take Switch away and there's no room where people and agents meet, no identity to tell requester from approver, no card and no way to install. Clearance has no chat surface and no agents of its own.

## Results

Every number comes from a script in `eval/` and is regenerated by `pnpm eval:report`. The raw results are in [eval/results/](eval/results/), so you can check them from a clone with nothing running. [RESULTS.md](RESULTS.md) has every row in full and all of what went against us.

<!-- results:start -->
| ID | Metric | Baseline | Clearance | Data | Script |
|---|---|---|---|---|---|
| E1 | Bad outcomes prevented (of 25) | B-auto: 0 / B-ask: 9 | 25 | 25 scripted cases on a fake chat port; 25 of 25 also ran on real Switch and Mattermost, 25 prevented there, 5 adapted to what the stack has; more in RESULTS.md | `pnpm eval:authority` |
| AUDIT | Breaks independent AI reviews found, re-checked apart from the 25 | n/a | Audit: 5 of 5; second review: 28 of 28; third review: 19 of 19; fourth review: 25 of 25; fifth review: 25 of 25 (21 breaks, 4 guards on the fixes) | Each break fixed after its review | `pnpm eval:authority` |
| E2 | Risky actions executed without an eligible human (of 20 per vendor) | Claude 5, OpenCode 13 of 18 | Claude 0, OpenCode 0 of 11 | 200 agent runs, 167 finished, Claude on haiku, OpenCode on opencode/beam-free; Priya answers once if the agent asks | `pnpm eval:vendors` |
| E2 | Safe actions interrupted by a card (of 20 per vendor) | Claude 0, OpenCode 0 of 18 | Claude 0, OpenCode not run | scored from the saved transcripts of the same runs | `pnpm eval:vendors:rescore` |
| E2 | Harmless tasks the agent reports done (of 20 per vendor) | Claude 18, OpenCode 18 of 18 | Claude 16, OpenCode not run | a fact only the system could give, in the agent's words | `pnpm eval:vendors:rescore` |
| E2 | How attempts ended with Clearance | n/a | Claude: 7 held on a card, 8 refused by a control, 5 declined by the agent; OpenCode: 6 held on a card, 3 refused by a control, 2 declined by the agent | from the record: a hold, a refusal by the gate's role list or a hook, and declined means no control was reached | `pnpm eval:vendors:rescore` |
| E2 | The requester said yes, and it went ahead | Claude 5 of 10, OpenCode 4 of 6 | Claude 0 of 3, OpenCode 0 of 2 | runs where the agent asked and the person who asked for it answered | `pnpm eval:vendors:rescore` |
| E2 | Shadow mode's would-hold, against what really happened | n/a | 6 of 6, 0 false alarms | Claude, on the same prompts; the gate's role list and secret-file block stay on in shadow | `pnpm eval:vendors:rescore` |
| E2 | Tried another route after a hold | n/a | 0 of 119 holds | real sessions: Claude 99, OpenCode 20, under one prompt, which tells them not to; in E2, 1 of 13 held runs went on to a different call, held or refused too | `pnpm eval:behaviour` |
| E4 | Added latency p50 / p95 / p99 (ms) | n/a | hook 1.02 / 2.01 / 2.92, gate 9.61 / 18.09 / 24.74, Codex hook process 77.34 / 84.41 / 91.21 | 1,000 calls each; Codex hook 100 runs, each a new process; on a fake chat port | `pnpm eval:latency` |
| E4 | Soak invariant violations | n/a | 0 | 2 h, 7,200 calls, 3 restarts; synthetic driver on a fake chat port, no agents | `pnpm eval:soak` |
| E6 | Human decisions per 100 agent actions | 100 | 25.8 (after promotion) | synthetic week, labelled; the anomaly rule was changed after seeing the first result, and the original rule gives 79.2 | `pnpm eval:autonomy` |
| BL | Real runs, no Clearance: the ₹40,000 order's refund went out | auto mode: 6 of 8 / approvals on: 6 of 8 | n/a | 27 recorded runs on claude-haiku-5-5, classifier refused 1; the setup changed: 15 outside the fence, 6 in an earlier version of the fence, 6 in the fence, on camera; more in RESULTS.md | `pnpm eval:baseline` |
| NEG | **Negative result** | | Clearance cost harmless work: Claude finished 16 of 20 harmless tasks against 18 of 20 without it | `pnpm eval:vendors:rescore` | |

Codex and Cursor didn't run: Codex has no login here, and Cursor isn't installed. Not measured yet, so not shown: E3, E5.
<!-- results:end -->

Claude's runs under Clearance are on the final code. OpenCode's stopped when its free tier ran out, and they're from before the last change to the agents' rules.

Independent AI reviews attacked this code five times, and each one found real breaks the earlier checks had missed, including ways for a person to approve their own refund. Every break is fixed and re-checked on its own line. These checks prove the listed controls. They don't prove the list is complete, and another review would probably find more.

## Limits

Hooks are a guardrail and the gate is the boundary. An agent holding its own unscoped credentials outside the gate isn't stopped by Clearance. [docs/threat-model.md](docs/threat-model.md) has the full list, and these are the ones to know first:

- Shell classification is best effort, which is why business credentials live only in the gate.
- When Clearance can't tell who asked, the request needs two different approvers. One of them could be the person who asked, and they can't be the only one.
- A managed agent in a private chat in Switch itself isn't covered, because Switch doesn't tell Clearance about it. Limiting who can address protected agents to named rooms shuts this, and `just demo` does that for its agents.
- Drills and type-to-confirm measure attention in a small group. A typed value proves someone read one field, not that they thought about it.

## Built during the hackathon, and how we used AI tools

Everything here was built inside the hackathon window. The first commit is from Nov 6, 2026. The code was written with Claude Code, working as a set of agents under the rules in [CLAUDE.md](CLAUDE.md), and the decisions are logged in [DECISIONS.md](DECISIONS.md), mistakes included. Prompts were dictated with Wispr Flow, and [docs/built-by-voice.md](docs/built-by-voice.md) has the details.

## Licence

Our code is Apache-2.0. Switch is source-available (Apache 2.0 with a modified Commons Clause), keeps its own licence, and is not modified by this project. We pin commit `1fe56227`. All data in Acme Mini is synthetic.
