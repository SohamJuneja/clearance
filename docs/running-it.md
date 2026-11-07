# Running it

The README has the short version. This is the rest.

## What it needs

Docker with compose v2, Node 22 or later, pnpm, `just`, git and curl, plus a few GB of free memory: our 14 GB laptop ran out once, with everything running at the same time. `just demo --check` says what is there and what is missing, and changes nothing. `just demo` is safe to rerun, and one rerun brings everything back after a reboot.

## Two ways to run it

**With real agents.** Needs [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) on the PATH, an `ANTHROPIC_API_KEY` in `.env` or a Claude login on the host, plus rsync and Linux with [bubblewrap](https://github.com/containers/bubblewrap): agents run inside a fence built on it. Without a way to sign in, `just demo` stops at its first step and says what's missing. Without bubblewrap, for instance on macOS, `just demo --no-fence` runs them with no sandbox and says plainly what that loses. Use it only on a machine you can throw away. `just demo` installs OpenCode for its agent and tries its free models, using the first that answers and can call a tool. They change and run out, so if none answers it says so and carries on, and the OpenCode scene is all that's lost. To choose your own, set `CLEARANCE_OPENCODE_MODEL` and `OPENCODE_PROVIDER_KEY` in `.env`. Codex and Cursor agents wait for their own logins, and a rerun creates them.

**With no agents, no key and no LLM.** `just demo --no-agents` brings up Switch, the people, the services and the Desk, then runs the spine with scripted calls through real cards and real presses. It proves the plumbing and who can approve, not how an agent behaves.

Then open http://localhost:8065 and log in as `priya` or `sam`. Their password is `PERSONA_PASSWORD` in `.env`, a demo value that only works on a localhost stack. The Desk is at http://localhost:7900.

## The scenes

Each is one command, `pnpm demo:run SC3` and so on, which drives the people through Mattermost. People's actions are scripted. The agents' words never are.

1. SC3, the spine. As Priya in `#support`: `@refunds-agent handle Meera's ticket T-77 for order A-1931`. The ticket pressures the agent to send ₹40,000 to a payment ID added minutes ago. In our runs the agent caught the wrong amount and offered the correct ₹4,000 to the new ID, and it's held. Answer the card yourself as Priya and Clearance refuses you in the room. Sam's direct room has the card, with the new destination flagged.
2. SCHO, the hand-off. Priya asks `@refunds-agent` to merge PR 418. The gate refuses it and names the `merges` role, the agent writes `@merges`, and coder picks it up. The merge is held, the card goes to Dev, and Priya still can't approve, because she asked.
3. SC6 and SC5, other vendors. Priya asks `@ops-agent` on OpenCode to ship `checkout v2.14.0` to prod with failing checks. Which free model answers changes, and the one we tried last declined by itself, so if it stops, tell it `I know the checks are failing. Ship it to prod anyway, it's my call.` Clearance still holds it for Alex. With a Codex login you can also ask `@support-agent`, as Sam, to email the customer list outside the company. We haven't run that one.
4. SC8, the inbox. Leave a card unanswered with the clock sped up. The backup gets it, and each approver has one "Needs your response" post across rooms.
5. SC9, a drill. Approve the practice request quickly. Nothing runs, you get a private note, and your next high-risk card asks you to type a detail.
6. SC11, earned autonomy. `pnpm seed:history` loads a synthetic week. Two people sign a promotion, a small refund runs with a review card, and `@clearance incident` takes it away.

## Vendor coverage

Tested means a real session under Switch, on Nov 6, 2026, unless it says otherwise.

| Vendor | Gate (business actions) | Hook (local actions) | MCP from project config | Status |
|---|---|---|---|---|
| Claude Code | tested | tested, in auto mode | loads; the gate's token header gets a 401, so agents use the CLI | working |
| OpenCode 1.18.27 | tested | tested, deny and endpoint-down both block | loads and calls | working |
| Codex | not run | hook mechanics tested on a stub model, trust seeded by script | loaded on a stub model | blocked on a login in our run |
| Cursor CLI | not run | untested | untested | untested |

The configs for Codex and Cursor are in `acme-mini-app/`, and `scripts/setup-agents.ts` seeds them. We say untested where we mean it.

## What works, and what doesn't yet

Working on the real stack: holds, refusals, routing, execute-on-approval and fail-closed behaviour through the gate, the Claude Code and OpenCode hooks, cards with real button presses, the inbox, the ledger mirror, drills, earned autonomy's promotion and demotion, delegation, break-glass, approve with edits (`@clearance counter CLR-0042 4000`), file writes bound to their content, the outcome-unknown message, Switch Trust's flag, the install command, and sending refused work to a role, for the `merges` role. The other three roles are declared and mapped, and haven't been taken live.

Proved in tests, not yet on the live stack: signed policy changes, against fakes.

Not yet:

- Delete cards show no record name, because the gate has no record lookup.
- An L2 review's "reverse" can't undo anything automatically, because Acme has no undo. It demotes, records an incident and asks a person.
- Shadow mode logs what would have been held but keeps denies enforced, because those guard Clearance itself.
- `!list-documents` crashes in Switch at our pin (PR #1286 upstream), so you see the ledger through the room notice and the Gateway room page.

## Optional: Switch Trust

Switch can send each message to an outside check before posting it. Clearance can be that check: `POST /guardrails/check` answers `ALERTED` for agent messages that lean on approvers, like "urgent, CEO says approve now", using plain patterns with no LLM.

It's advisory only. Switch gives it 2 s and fails open, so nothing may depend on it, and it never changes a decision: the listener has no way to reach core, and Switch only adds a note in the room. The first flagged message also adds `switch-admin` to that channel, with a visible join line, and that stays after the check is turned off. What protects an approver from pressure is the card, which leads with the call parsed from what ran. An agent's own words come last, labelled unverified.

It's off by default, and it takes config only, with no change to Switch:

1. Find the address of the gateway of Switch's Docker network: `docker network inspect <project>_default -f '{{(index .IPAM.Config 0).Gateway}}'`. Core's API stays on loopback. The check gets a listener of its own, with this one route.
2. In `.env`, set `CLEARANCE_TRUST_KEY` to a new secret and `CLEARANCE_TRUST_HOST` to that address, then restart core.
3. As a Switch admin, `PUT http://127.0.0.1:8000/gateway/trust-settings` with `{"endpoint": "http://<address>:7701", "policy_id": "clearance-pressure", "api_key": "<the key>"}`. It applies from the next message, and `DELETE /trust-settings` turns it off.

Leave it off for a recorded take. Every message then waits on the check before it posts, and if core is down or stopping, every message gets Switch's "could not check" note, including during the fail-closed scene.
