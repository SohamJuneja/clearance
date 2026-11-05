# Threat model and limits

Clearance makes sure the right person decides with the real facts in front of them. It does not judge whether a decision is right, and it does not contain a hostile process that already has its own credentials.

## What we defend against

An agent that does something risky without an eligible human agreeing. That includes an agent that was talked into it by text it read (a ticket saying "pre-approved by finance"), an agent that describes its action inaccurately, and a person approving their own request because the default setup lets them.

We also defend against approvals that have decayed: people clicking through cards too quickly to have read them. That is a human problem, so the defence is measurement and friction (drills, timing signals, type-to-confirm), not a block.

## The boundary is the gate

Business actions (refunds, deploys, customer email, record deletes, merges) go through `clearance-gate`, which holds the Acme admin key and the GitHub token. Agents never see those credentials. An agent can only ask the gate to do something, and the gate asks core first. When a request is approved, the gate executes the stored call itself, so there is no gap between what was approved and what ran.

If core is down or answers with anything unexpected, the gate returns 503 for everything except plain reads.

## Hooks are a guardrail

Vendor hooks catch local actions such as `git push --force`, `rm -rf` and reads of `.env`. Codex's own docs say to "treat tool hooks as a useful guardrail, not a complete enforcement boundary", and we agree. A hook runs inside a process the agent can influence, some vendors fail open when a hook times out, and Cursor's CLI hooks have reports of silent failure on Linux. The vendor coverage table in the README says, per vendor, what we tested and what we didn't.

Because Claude Code's `ask` answer can be bypassed in full-access mode, our hooks only ever answer `allow` or `deny`. A hold is a deny with a reason, and a retry of the exact same call after approval consumes a single-use grant bound to the call's hash.

## Identity

The requester comes from Switch's `sender` and `on_behalf_of` fields on message events. The approver comes from `answered_by` on Switch's `approval_outcome` event, resolved through identity claims. Nothing an agent writes can change either one. An answer from an account that maps to no known person is ineligible.

The Clearance agent has its own Switch owner, `clearance-admin`. Two agents with the same owner can change each other's addressing policy, so no persona or Acme agent shares that owner.

When we can't tell exactly who asked, we take the cautious reading: everyone who addressed that agent in the last 10 minutes counts as a requester and can't approve.

## Limits

The demo runs agents and the gate on one machine. An agent with shell access could in principle read the gate's files. In the demo the gate and Acme run in Docker, and hooks hold reads of `.env*`, `docker` commands and the gate's directory, but that is a mitigation and not isolation. In production, run the gate on another host or as another OS user.

Clearance can't stop an agent that has its own unscoped credentials outside the gate. Baseline agent `refunds-agent-vanilla` in our evaluation holds the Acme key directly, on purpose, to show that case.

Switch's Trust guardrails see messages and not tool calls, and they fail open after 2 seconds, so our optional Trust endpoint is advisory.

A type-to-confirm prompt proves someone read one field. It doesn't prove they thought about it. Drills measure attention, and a drill catch rate from a small group is a pilot number, not a guarantee.
