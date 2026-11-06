# Architecture

Clearance is three processes beside a Switch deployment, plus a fake company to act on.

```mermaid
flowchart LR
  subgraph Chat["Team chat: Mattermost through Switch"]
    P[Priya, support]
    S[Sam, finance]
    X[Alex, eng]
  end
  subgraph Switch["Switch standalone"]
    R[(Rooms, threads, identity claims, cards, room documents)]
  end
  subgraph Agents["Managed agents on the agent controller"]
    RA[refunds-agent, Claude Code]
    SA[support-agent, Codex, config only]
    OA[ops-agent, OpenCode]
    CU[reviewer, Cursor CLI, config only]
  end
  subgraph Clearance
    CORE[clearance-core :7700 and the Clearance Switch agent]
    GATE[clearance-gate :7710, holds credentials]
    DESK[Desk :7900]
    DB[(SQLite)]
  end
  ACME[Acme Mini :7800]

  Chat <--> Switch
  Switch <--> Agents
  CORE <-- SSE events, HTTP ops, approval cards --> Switch
  RA & SA & OA & CU -- vendor hooks --> CORE
  Agents -- acme CLI or MCP --> GATE
  GATE -- check, execute on approval --> CORE
  GATE -- custody credentials --> ACME
  CORE <--> DB
  DESK --> CORE
```

## A refund, step by step

```mermaid
sequenceDiagram
  autonumber
  actor Priya
  participant Room as #support
  participant Agent as refunds-agent
  participant Gate as clearance-gate
  participant Core as clearance-core
  actor Sam
  Priya->>Room: @refunds-agent handle ticket T-77
  Room-->>Core: message event, sender is Priya
  Agent->>Gate: acme refund --amount 4000 --dest meera.k@okaxis
  Gate->>Core: check(action)
  Core->>Core: classify, score, flag, route. Exclude Priya (requester, owner)
  Core-->>Gate: HELD CLR-0042
  Gate-->>Agent: 202 pending
  Core->>Room: card copy in the origin room
  Core->>Sam: card in Sam's direct room
  Priya->>Room: A12 yes
  Room-->>Core: approval_outcome, answered_by is Priya
  Core->>Room: Priya can't approve CLR-0042. Sent to Sam.
  Sam->>Core: A13 no
  Core->>Core: ledger entry, hash chained
  Core->>Room: @refunds-agent CLR-0042 denied by Sam
```

That's the refund our real runs produced: the agent caught the ticket's ₹40,000 and offered the correct ₹4,000 to a payment ID added minutes earlier. The new ID is what the card flags.

On approval the gate executes the stored call with its own credentials and core posts the refund id to the thread. The agent never retries a business action.

For a local action caught by a hook, a hold is a deny with a reason. On approval core mints a grant bound to the call's hash, single use, valid for 10 minutes, and tells the agent to run the same command once. Any change to the arguments creates a new request.

## Decisions that shape the code

No LLM runs in the decision path. Classify, score, route, grant, escalate, drill and promote are deterministic code over `policy/clearance.policy.yaml`.

Everything fails closed. A missing fact, an unknown agent directory, a dead core and an expired request all end in hold or deny.

Our request lifetime is 25 minutes, under the 30-minute interrupt in Switch's docs, so Clearance always decides first.

Core and the Switch client are one process, to keep the moving parts few for someone cloning the repo. The gate is separate because it holds credentials.

Agents run inside a bubblewrap fence, one per machine, so they can't read the repo, `data/`, the real home or other processes. [The threat model](threat-model.md) has what that does and doesn't stop.

Core's 1 s tick retries what didn't finish: a card Switch didn't take, an execute the gate didn't answer, a review that never opened. Each of those also has a path that does it straight away, so each one guards against the tick arriving while that path is still working.

## Package map

| Package | Purpose |
|---|---|
| `packages/contracts` | Shared zod schemas and the ports core depends on |
| `packages/core` | Policy, classify, risk, router, requests, grants, escalation, drills, rubber-stamp, autonomy, ledger, cards, API |
| `packages/switch-agent` | Switch protocol client and the `ChatPort` implementation |
| `packages/adapters` | Vendor payload to `Action`, vendor response builders, hook routes |
| `packages/gate` | HTTP proxy and MCP server, custody credentials, execute on approval |
| `packages/hook-cli` | `clearance-hook` for vendors without HTTP hooks |
| `packages/acme` | The fake company, with synthetic data |
| `packages/desk` | Read-mostly dashboard |
| `acme-mini-app/` | The agents' working directory, carrying each vendor's enforcement config |

`docs/integration-contract.md` has the HTTP shapes between them.
