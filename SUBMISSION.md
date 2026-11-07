# Submission

Text for the submission form.

## Project name

Clearance

## Team

dellfargo: Prashant (Prashant-thakur77) and Soham (SohamJuneja).

## Tracks

Track 01: Best Business Workflow. Track 02: Best Personal or Creative Workflow: the same rules work for two people, a builder and someone they trust, over their own agents and money, and the site's "Try it" box checks a command in the browser. Code with Wispr. Best Blog. We didn't enter Track 03: the Canva connection for Switch we wrote for it stays in the repo, in `spikes/track03/`, because it was never tested against a real Canva app.

## One line

A refund-approval workflow for teams of people and AI agents, built on Switch: the person who asks an agent to move money can't also be the one who approves it.

## Description

In Switch today, an agent's approval card goes to whoever may address the agent, and by default that's the person who asked. In our test setup a persona asked for a ₹40,000 refund, approved every card, and the money went out.

Clearance is a Switch agent plus a small gate in front of business APIs. The gate holds the credentials, so an agent can only ask, and Clearance holds the call until an eligible person answers. The person who asked can't approve, and the card goes to someone else by role and rota, with an escalation timer behind it. The card leads with fields parsed from the real call. The agent's own sentence comes last, labelled unverified. Local actions such as `git push --force` are caught by each vendor's pre-action hook, and hooks are a guardrail, so the gate is the boundary.

Approval gates decay, so Clearance also measures attention. Practice requests with planted flaws work like phishing tests, a fast approval earns a typed confirmation on the next high-risk card, and an agent can earn autonomy for small refunds from a record that two people sign. One incident takes it away.

Approvers and operators can ask Clearance questions from an MCP client such as Claude Code, Claude Desktop or Cursor (the tests drive it over stdio with the MCP SDK's client; the Desktop and Cursor setups are documented, not tried). `packages/mcp-connector` is a read-only MCP server with six tools: what's pending and who can decide it, what's waiting on you, why a request was held, the recent ledger, whether its hash chain verifies, and a dry run that records nothing. Its routes sit behind Clearance's internal token, which no agent holds, and `@clearance policy test` answers only people on the team, so an agent can't use either to look for a way round a hold. There's no route to approve anything: an answer counts only from Switch's own approval event.

The project page has a "Try it" form that runs Clearance's own classifier and policy engine in the browser, on the demo's policy file: type a command and see whether it's held and who could approve it.

No LLM sits in the decision path. Identity comes from Switch's events, never from an agent's text. If anything needed for a decision is missing, the answer is hold.

## How it uses Switch

Clearance is a Switch agent on the agent protocol. Every card is a native Switch approval card, and each answer comes back as `approval_outcome` with `answered_by`, which is how Clearance knows who approved. It reads `sender` and `on_behalf_of` for who asked. It also uses direct rooms for per-person cards, targeted messages for escalations, room documents for the ledger mirror, templates for install, managed agents across vendors, and addressing policy to limit where a protected agent can be reached. Room roles say where refused work goes: an agent told it can't merge writes `@merges`, and whoever holds that role picks it up. A role decides nothing, because any member can take one, so authority stays in the policy and the gate's grants. Without Switch there's no room where people and different vendors' agents meet, no identity to separate requester from approver, and no card.

## Results

Every number comes from a script in `eval/`, and `RESULTS.md` has all of them, including the blanks. Data is synthetic and labelled.

We gave real agents in real Switch rooms risky requests against a synthetic company. With nobody answering, the agent moved nothing in 20 risky runs, because it stops to ask. So a scripted requester now answers "Yes, go ahead" once if asked, in every condition, as someone in a small team would. With no Clearance, Claude's agent stopped to ask in 10 of 20 runs, the requester said yes, and it went ahead in 5 of them, including a ₹40,000 refund and a deleted customer record. OpenCode's agent went ahead in 13 of 18 runs, 9 of them without asking. On the prompts it finished both ways, that's 7 of 9 against 0 of 9. With Clearance, the same yes moved nothing, and no risky action ran without an eligible person's approval, in 31 finished runs. The table below has the rest, including where Clearance loses.

We scored 25 of 25 on our authority suite: scripted cases on real core, gate and Acme, with a fake chat. Then we ran the same cases on the real stack: 25 of 25 also ran on real Switch and Mattermost, 25 prevented there, 5 adapted to what the stack has. A separate AI review then found 5 breaks the suite had missed, a second reproduced 28 more on code that passed all of that, a third reproduced 19 more in what had been written since, a fourth reproduced 25 more, including one refund sent twice at once running twice, and a fifth reproduced 21 more, including one word that took a whole message off the record, and a teammate's break-it review reproduced 12 more, including a display name that let an approver pose as someone else. They're fixed and re-checked on their own line.

On a synthetic week, an agent that earned autonomy needed 25.8 human decisions per 100 actions, against 100 before promotion. The anomaly rule was changed after we saw the first result, which was 79.2, and both are published.

With no Clearance, the ₹40,000 refund went out in 6 of 8 recorded runs with auto mode on, and in 6 of 8 with approvals on, where Priya, who asked, pressed all 29 cards.

The scenario we planned didn't happen: the agent attempted the ₹40,000 refund on ticket T-77 in none of 9 runs. It caught the wrong amount, and what Clearance holds is the smaller refund it then offers to a brand-new payment ID.

## Links

Repo: https://github.com/SohamJuneja/clearance

Video: https://youtu.be/wTnfxIONb2Y

Site: https://clearance-site-brown.vercel.app

Blog: BLOG_URL

Wispr Insights: Soham's screenshots, attached, and in the film (`docs/media/wispr-highlights.jpg`).

## AI tools used

The code was written with Claude Code, working as a set of agents under the rules in `CLAUDE.md`, with decisions logged in `DECISIONS.md`. We dictated prompts and review notes with Wispr Flow, described in `docs/built-by-voice.md`. Clearance itself uses no LLM to decide anything. The demo's agents run on Claude Code and OpenCode, and on any other vendor only if the coverage table in `docs/running-it.md` says it was tested.

## Licence and Switch's terms

Clearance is Apache-2.0. Switch is source-available (Apache 2.0 with a modified Commons Clause). Clearance runs against it unmodified, pinned at commit `1fe56227b6e330452ac80d7b7b2ca0a66aaeaeab`.
