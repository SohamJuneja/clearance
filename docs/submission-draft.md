<!-- Text for the submission form. `pnpm numbers:fill` writes SUBMISSION.md from this file. Anything in capitals below is for the owner to paste in on the day. -->
# Submission

Check this against the real form on Saturday, since the form may ask for fields PLAN didn't list.

## Project name

Clearance

## Team

CoffeeAndWispr. Members: TEAM_MEMBERS, as they appear on the team page.

## Tracks

Track 01: Best Business Workflow. Code with Wispr. Best Blog. Track 04: Best Integration or Extension, only if the organisers confirm it's a real prize. Track 03 goes in separately as a pull request to Switch, if we open one.

## One line

The approval layer for teams of people and AI agents, built on Switch: one policy across agent vendors, separation of duties, the real call on the card, and a way to tell whether approvers are still reading.

## Description

In Switch today, an agent's approval card goes to whoever may address the agent, and by default that's the person who asked. In our test setup a persona asked for a ₹40,000 refund, approved every card, and the money went out.

Clearance is a Switch agent plus a small gate in front of business APIs. The gate holds the credentials, so an agent can only ask, and Clearance holds the call until an eligible person answers. The person who asked can't approve, and the card goes to someone else by role and rota, with an escalation timer behind it. The card leads with fields parsed from the real call. The agent's own sentence comes last, labelled unverified. Local actions such as `git push --force` are caught by each vendor's pre-action hook, and hooks are a guardrail, so the gate is the boundary.

Approval gates decay, so Clearance also measures attention. Practice requests with planted flaws work like phishing tests, a fast approval earns a typed confirmation on the next high-risk card, and an agent can earn autonomy for small refunds from a record that two people sign. One incident takes it away.

No LLM sits in the decision path. Identity comes from Switch's events, never from an agent's text. If anything needed for a decision is missing, the answer is hold.

## How it uses Switch

Clearance is a Switch agent on the agent protocol. Every card is a native Switch approval card, and each answer comes back as `approval_outcome` with `answered_by`, which is how Clearance knows who approved. It reads `sender` and `on_behalf_of` for who asked. It also uses direct rooms for per-person cards, targeted messages for escalations, room documents for the ledger mirror, templates for install, managed agents across vendors, and addressing policy to limit where a protected agent can be reached. Without Switch there's no room where people and different vendors' agents meet, no identity to separate requester from approver, and no card.

## Results

Every number comes from a script in `eval/`, and `RESULTS.md` has all of them, including the blanks. Data is synthetic and labelled.

We scored {{E1}} on our authority suite: scripted cases on real core, gate and Acme, with a fake chat. An independent review then found {{AUDIT_BREAKS}} breaks the suite had missed. They're fixed and re-checked on their own line.

On a synthetic week, an agent that earned autonomy needed {{E6_AFTER}} human decisions per 100 actions, against {{E6_BEFORE}} before promotion. The anomaly rule was changed after we saw the first result, which was {{E6_ORIGINAL}}, and both are published.

The scenario we planned didn't happen: the agent attempted the ₹40,000 refund on ticket T-77 in none of {{T77_RUNS}} runs. It caught the wrong amount, and what Clearance holds is the smaller refund it then offers to a brand-new payment ID.

## Links

Repo: {{REPO_URL}}

Video: VIDEO_URL

Blog: BLOG_URL

Wispr Insights screenshots: attach the ones taken at 19:00 on Saturday.

## AI tools used

The code was written with Claude Code, working as a set of agents under the rules in `CLAUDE.md`, with decisions logged in `DECISIONS.md`. The owner dictated with Wispr Flow, described in `docs/built-by-voice.md`. Clearance itself uses no LLM to decide anything. The demo's agents run on Claude Code and OpenCode, and on any other vendor only if the coverage table in the README says it was tested.

## Licence and Switch's terms

Clearance is Apache-2.0. Switch is source-available (Apache 2.0 with a modified Commons Clause). Clearance runs against it unmodified, pinned at commit `1fe56227b6e330452ac80d7b7b2ca0a66aaeaeab`.
