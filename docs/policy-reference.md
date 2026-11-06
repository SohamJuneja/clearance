# Policy reference

Two files decide what happens to an agent's call. `policy/clearance.policy.yaml` says which calls are risky and who may approve them. `policy/team.yaml` says who those people are. Both are validated with strict zod schemas (`packages/core/src/policy/schema.ts`), so a misspelled key stops core from loading the file, with a line number in the error.

No LLM reads either file. Decisions are deterministic code, and the same call against the same policy gets the same answer.

## How a call is decided

The order is fixed (`packages/core/src/policy/engine.ts`):

1. The call is turned into a normal form. If the part its kind needs is missing, it's held.
2. Classes with `decision: deny` run first, so nothing can be called safe before they've looked at it.
3. The `safe` list passes a call silently. A read outside the agent's own folder isn't safe, whatever the list says, unless `defaults.readable_outside` covers it.
4. The first class that matches is used, so the order of `classes` matters. Core extracts its fields, adds up its aggregate rules, scores the risk and picks a tier. A single-use grant for this exact call is consulted here.
5. The agent's autonomy level for that class and bucket may let the call run.
6. If no class matched and the call is protected, `defaults.unknown_protected_action` decides. If it isn't protected, it's allowed.
7. Anything held goes to the router.

A shell line goes through this once per sub-command, and the most severe answer wins. `ls && git push` is held, and a grant for the push doesn't cover `git push && rm -rf /`. A line the parser can't read with confidence is held, and its grant binds to the exact bytes.

Missing data never lowers risk. A lookup that found nothing, or a field of the wrong type, is unknown, and a risk rule with an unknown condition counts as true and says so on the card. If core is down, the gate returns 503 for everything except plain reads.

## Top-level keys

| Key | What it is |
|---|---|
| `version` | Always `1` |
| `mode` | `enforce` holds calls. `shadow` records what would have happened and holds nothing |
| `currency` | Used on cards, for example `INR` |
| `time_scale` | Required, and not read when core runs. The running clock takes `CLEARANCE_TIME_SCALE`, which the demo sets to 10 |
| `tiers` | Score ranges for `low`, `medium`, `high` and `critical`, lower bound included |
| `defaults` | See below |
| `safe` | Matchers that pass silently |
| `protected` | Matchers that are held when no class matched. Gate writes are always protected |
| `classes` | The risky kinds of call, in the order they're tried |
| `drills` | Practice requests with a planted flaw |
| `rubber_stamp` | When an approval counts as too fast, and what happens then |
| `digest` | A daily summary in the fallback room, as `{ at: "18:30" }` |
| `policy_owners`, `policy_change_quorum` | Who signs a policy change, and how many |
| `break_glass` | Who may run something urgent first, and how soon it must be reviewed |

## `defaults`

| Key | Meaning |
|---|---|
| `request_ttl` | How long a held request stays open |
| `grant_ttl` | How long an approved call's retry stays valid |
| `max_open_cards_per_person` | The router passes over someone with this many cards open, and the trace says so |
| `exclude_requester` | The person who asked can't approve |
| `exclude_agent_owner_from` | The tier at which the agent's owner stops being able to approve |
| `unknown_requester_quorum` | At least 2. When nobody can tell who asked, this many different people must approve, since only one of them can be the person who asked |
| `gate_hosts` | A `curl` or `wget` whose every URL is one of these is left to the gate |
| `readable_outside` | Paths outside the agent's folder that may be read without a hold |
| `unknown_protected_action` | `hold` or `deny` |
| `business_hours` | `{ days, hours, tz }`. `outside_hours()` and `friday_after()` read it |
| `fallback` | `{ group, room }`, used when nobody is eligible. The room is told why |
| `gate_mcp_servers` | MCP servers that are the gate itself |
| `known_mcp_servers` | Any other MCP server is denied |

## Matchers

Each entry in `match`, `safe` or `protected` has exactly one kind:

| Kind | Example | How it's read |
|---|---|---|
| `gate` | `'POST /acme/refunds'` | A glob over the verb and path |
| `mcp` | `'refund_customer'` or `'^builtin/(Task\|Agent)'` | A glob, or a regular expression if it starts with `^` |
| `shell` | `'(^\|/)acme\s+refund\b'` | A regular expression over each sub-command, with wrappers and git's global options removed |
| `file_write`, `file_read` | `'(^\|/)\.env'` | A regular expression over the path |
| `http` | `'^(POST\|PUT)\s'` | A regular expression over the verb and URL |

`via_gate: true` marks a hook call the gate will see and hold itself, so the hook doesn't open a second card.

## Classes

```yaml
refund:
  summary: refunds
  match:
    - { gate: 'POST /acme/refunds' }
  extract:
    amount: 'args.amount'
    order_total: 'lookup("orders", args.order_id).total'
  risk:
    base: 20
    add:
      - { when: 'amount > 10000', points: 35, why: 'refunds over ₹10,000' }
      - { when: 'amount > 3 * order_total', points: 30, flag: amount_vs_order }
  aggregate:
    - { sum: amount, by: customer, window: 24h, over: 10000, then: hold }
  reversible: false
  approvers:
    label: finance
    any_of: [ { role: finance-approver }, { group: finance } ]
    quorum: { default: 1, critical: 2 }
  escalate:
    - { after: 3m, add: backup }
    - { after: 8m, post: '#approvals', mention: '@finance-approvers' }
    - { after: 20m, notify: requester }
  autonomy:
    max_level: L3
    buckets: [ { name: small, when: 'amount <= 5000', label: 'refunds up to ₹5,000', daily_cap: 25000 } ]
    promote_after: { approvals: 20, days: 7, min_distinct_approvers: 2 }
  drills: true
```

| Key | Meaning |
|---|---|
| `summary` | How the card's policy line names the class |
| `decision`, `reason` | `decision: deny` refuses the call and never routes it, and `reason` is what the agent is told |
| `extract` | Named fields, each an expression. Later expressions can read them |
| `risk` | `base` plus the `points` of each `add` rule that holds. `flag` puts a line on the card. `why` gives the words for the reason and the policy line |
| `aggregate` | A sliding window. If `sum` for one `by` key goes `over` the limit inside `window`, `then` holds or denies, whatever the score says. Paid and open requests count. Denied and expired ones leave the window |
| `reversible` | The card's title says so. A single call can overrule it: a force push is in the merge class and reads irreversible |
| `approvers` | See below |
| `escalate` | Steps on a timer. Each has `after` and one action: `add: backup`, `post` to a room with an optional `mention`, or `notify: requester` |
| `autonomy` | See below |
| `drills` | Whether this class can be drilled |

### Approvers

`any_of` lists who may approve. Each entry is exactly one of `role`, `group`, `owner_of` (a field holding a service name) or `person`. `label` is the word on the card. `exclude` names extracted fields whose person can't approve, such as a merge's `author`. `exclude_agent_owner_from` overrides the default for the class, and `never` keeps the owner eligible. `quorum` is the number of different people needed, by tier, with `default` as the fallback. `fallback` overrides the default for the class.

Every answer is checked again when it arrives, against Switch's `answered_by`. Nothing an agent writes can change who asked or who answered.

### Autonomy

An agent climbs a ladder per agent, class and bucket:

| Level | What happens |
|---|---|
| L0 | Always ask |
| L1 | One eligible approver, with no typed confirmation |
| L2 | Runs, then posts a review card that can reverse it or demote the agent |
| L3 | Runs silently up to `daily_cap`, with a line in the digest |

`max_level` is how far the class can go. `promote_after` is what Clearance needs before it proposes a promotion, and a promotion always needs people to sign it. Demotion is instant on an incident or a denial, and needs nobody's approval. Forced holds, missing data and the critical tier never run on their own. An amount above the bucket's 95th percentile holds that one call for a person and doesn't demote.

### Approving a smaller amount

There's nothing to configure. On a call through the gate whose class has an amount, someone who could approve it can offer less instead:

```
@clearance counter CLR-0042 4000
```

That opens a question card to them, in their direct room: "Approve ₹4,000 instead?". They confirm by typing the last 4 characters of the destination, or the CLR number if there's no destination to type. The question already shows the amount, so typing that back would prove nothing. A wrong value asks once more, then drops the offer. "No, deny" drops the offer and leaves the request waiting: it doesn't deny the request. Ordinary cards don't change, and they stay open while an offer is open.

| Rule | What happens |
|---|---|
| Who | The same check as answering a card, when the command is sent and again when the card is answered. The requester, the agent's owner where the class bars them, people who aren't approvers, and anyone whose approval already counted are refused, on the ledger. An agent is ignored. |
| What | Only the amount, only down, to a whole number above zero. An increase is refused: that's a new request for the agent to make, not an edit. Destination, customer and order are never editable. The command takes no other value, and the gate builds the new call from the one it stored. |
| Hook calls | Refused. Nothing can make an agent re-run a different command. |
| Policy | The edited call goes through the normal policy path before anything runs, with the amount it replaces left out of the 24 h window. A `deny` leaves the original waiting. The new tier sets the quorum, so an edit can't skip one: if that tier needs more people than the one who offered, it's held and routed as usual. An approval of the original doesn't carry over, because it was for a different call. A quorum raised because nobody knows who asked, or because the agent is working somewhere Clearance can't see, carries over. |
| Running it | On a yes the original ends as `EDITED` and can't run, and a new request with its own id and hash carries the edit. The gate runs that exactly once. A gate that doesn't answer leaves it retrying, and after 5 minutes it's voided, as for any approved call. A gate that refuses the edit voids it at once. The gate checks the rules again itself and only allows edits on `refund`. |
| Records | The ledger has `edit_proposed`, `edit_withdrawn` and `edited`, which holds both amounts, both hashes and who made it. `approved` and `executed` appear only on the new request. The audit export has `edited_by`, `edited_to` and `edit_of`. |
| The agent | It's told "CLR-0042 did not run and will not", then what ran instead, or that the edit still needs someone. |
| Promotion | An approval with edits counts against promotion. Both requests are recorded as edited, neither counts towards `promote_after`, and either one blocks promotion while it's in the window. |

## Expressions

`when`, `extract` and bucket conditions use a small language, parsed by jsep, checked against a whitelist and walked by a small evaluator (`packages/core/src/policy/expr.ts`). There is no `eval`, and nothing can be called except the helpers below. It has comparisons, arithmetic, `and`, `or`, `not` and `in`.

| Helper | What it gives |
|---|---|
| `lookup(kind, id)` | A record from the systems of record. A failure or a miss is unknown, never a pass |
| `domain(address)` | The part of an email address after the `@` |
| `len(list)` | Its length |
| `count_rows(attachments)` | Total rows across attachments |
| `touches(glob)` | Whether the call's files, or its pull request's, match |
| `outside_hours()` | Outside `defaults.business_hours` |
| `friday_after("16:00")` | A Friday after that time |

## Drills and rubber-stamping

```yaml
drills: { enabled: true, rate: 0.05, max_per_person_per_day: 1, library: drills/flaws.yaml }

rubber_stamp:
  t_min: { base_s: 2, per_evidence_line_s: 0.25, tier_bonus_s: { high: 3, critical: 6 } }
  streak: { approvals: 5, max_denials: 0 }
  batch: { approvals: 3, within_s: 20 }
  concentration: { share: 0.6, min_answers: 5 }
  friction: type_to_confirm
```

`rate` is the share of requests that bring a drill along. The roll has no randomness in it: a request and a policy always roll the same way. A drill never runs anything. `CLEARANCE_DRILL_RATE` overrides the rate, and the demo sets it to 0 so that drills only appear where a scene asks for one.

`t_min` is how long a card needs to be read, and it grows with the evidence on the card and the tier. `streak`, `batch` and `concentration` describe patterns of approving. `friction` is what comes next: the person's next high-risk card asks for a typed value.

## `team.yaml`

| Key | Meaning |
|---|---|
| `people` | `id`, `name`, `switch_user`, `groups`, `roles`, and optionally `github`, `away_until` and `delegate_to` |
| `rotas` | Per role, a list of `{ person, days, hours, tz, backup }` |
| `owners.services` | Service name to person |
| `agents` | Agent name to `{ cwd, owner, vendor }` |
| `rooms` | Room names used by the policy, mapped to Switch room ids |
| `admins` | People who may switch drills on and off |

`switch_user` holds a person's Switch id. The demo leaves a placeholder in this file, and `scripts/setup-identities.ts` writes the real ids to `data/identities.json`, which core also reads. An answer from an account that maps to nobody here is ineligible.

## Changing the policy

`@clearance policy test <text>` shows what a call would get, without running it. `pnpm policy:test` runs the table of example calls in `policy/tests/`.

If `policy_change_quorum` is set, editing the file doesn't change what's enforced. Core keeps enforcing the last signed policy, opens a proposal that shows what changed and a replay over recent actions, and applies the edit once that many people have signed. Whoever proposed it can't sign it. Every step goes in the ledger. For the demo, resetting the database starts again from the file.
