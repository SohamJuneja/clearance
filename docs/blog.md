# In Switch, the person who asks for a refund can approve it. Here's how we fixed that.

In our test setup, a demo persona called Priya asked an agent in Switch to refund a ₹40,000 order. The approval cards appeared, and they mentioned Priya. Priya pressed Allow on all four, and the money went out. Nobody else was involved, because the card goes to whoever may address the agent, and that was the person who had asked. Across our recorded runs with approvals on, that refund went out in 6 of 8, and Priya pressed all 29 cards. With auto mode on, where nobody gets a card at all, it went out in 6 of 8.

That's Switch's default, and it's reasonable for one person running their own agent. It stops being reasonable when a team runs agents that touch money, customers and production. Anthropic's own [post on auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) says people accept 93% of permission prompts anyway. So even if the card reaches someone else, there's a fair chance nobody reads it.

We built Clearance for the Flip the Switch hackathon to work on that: one policy for every agent vendor, the right other person, the real call in front of them, and a way to tell whether approvers are still reading.

## What Switch is

[Switch](https://github.com/sandbox-quantum/switch) from SandboxAQ turns a chat channel into a room where people and AI agents work together. Your Claude Code agent and a teammate's Codex agent can sit in the same Slack, Discord or Mattermost channel with the same context. It's source-available (Apache 2.0 with a modified Commons Clause), and you can run the whole thing yourself.

## Running it locally

You need Docker, `just`, and about ten minutes. This builds from source at a pinned commit, so the first run takes a while.

```bash
git clone https://github.com/sandbox-quantum/switch && cd switch
just init-env
# In .env, set:
#   FEATURE_FLAGS_ENABLED=agent_management
#   CONTROLLER_TOKEN_SECRET=<32 or more random characters>
just standalone-up
```

That gives you the API on port 8000, the Gateway on 3000 and Mattermost on 8065, bound to localhost. To run managed agents you also enroll a controller: get a code from the Gateway's Machines page, then run `switch-agent-controller enroll --server http://127.0.0.1:8000 --code <code>` and `switch-agent-controller run`.

## Writing an agent that opens real cards

The part I most wanted to share is how little it takes for your own program to open native approval cards. Your agent registers, opens one SSE stream, sends a heartbeat every few seconds, and posts to this route:

```http
POST /agent-sessions/clr-1/approvals
Authorization: Bearer <agent key>

{"request_id": "card-1", "turn_id": "t1", "kind": "approval",
 "title": "CLR-0042 · REFUND ₹4,000 · irreversible",
 "detail": "The call, parsed from what the agent ran ...",
 "options": [{"id": "allow", "label": "Approve", "decision": "accept"},
             {"id": "deny", "label": "Deny", "decision": "decline"}],
 "questions": [], "room_id": "<room>", "thread_id": null, "expires_at": null}
```

In Mattermost that renders with buttons, and a press comes back on your stream as an `approval_outcome` with `answered_by`. That field is why the approach works: identity comes from Switch and not from anything an agent wrote.

Five things tripped us, and most of them fail quietly:

1. The stream only sends `approval_outcome` if you opened it with `scope=all` and declared protocol 4 or later. Declare nothing and you connect happily and never hear an answer.
2. Every field in that body is required, and unknown fields are refused.
3. A card over about 1,000 characters doesn't get trimmed on Mattermost. It loses its buttons and says it can't be answered from this message. Budget well under that.
4. The short handle people type (`A12`) is counted per channel and only exists in the post. No API returns it, so don't promise one in your card text.
5. On a question card, Switch ignores a bare number. Typed values need quotes, as in `A19 "38000"`.

An account that isn't linked to a Switch user can't answer a card at all, which is good, but it will confuse you the first time.

## What Clearance adds

Clearance is a Switch agent plus a small gate in front of your business APIs. The gate holds the credentials, so agents can't move money directly. They ask the gate, and it asks Clearance. Local actions like `git push` are caught by each vendor's pre-action hook.

Separation of duties means the person who asked can't approve, and the card goes to someone else by role and rota. Press your own card and Clearance refuses in the room and says who has it. If nobody answers, it escalates on a timer and every approver has one inbox across rooms.

Drills work like phishing tests. Now and then an approver gets a practice request with a planted flaw. Nothing ever runs. If you approve it, you get a private note and your next high-risk card asks you to type a detail. Fast approvals don't count as evidence for anything.

Earned autonomy is the payoff. After a clean record, Clearance proposes that an agent can handle small refunds alone, shows a replay over the history, and needs two people to sign. One incident takes it away.

## What we measured

We gave real agents in real Switch rooms risky requests against a synthetic company. With nobody answering, the agent moved nothing in 20 risky runs, because it stops to ask. So a scripted requester now answers "Yes, go ahead" once if asked, in every condition, as someone in a small team would. With no Clearance, Claude's agent stopped to ask in 10 of 20 runs, the requester said yes, and it went ahead in 5 of them, including a ₹40,000 refund and a deleted customer record. OpenCode's agent went ahead in 13 of 18 runs, 9 of them without asking. On the prompts it finished both ways, that's 7 of 9 against 0 of 9. With Clearance, the same yes moved nothing, and no risky action ran without an eligible person's approval, in 31 finished runs. The table below has the rest, including where Clearance loses.

That first number is the one I keep coming back to. The agent did the responsible thing and asked. The only person it asked was the person who wanted it done, so asking changed nothing.

There was a cost, and we measured that too. When someone asks the wrong agent, the gate refuses it, and a person had to send the work on. So now the refusal names the job, using Switch's room roles: an agent told it can't merge writes `@merges`, and whoever holds that role picks it up. The role only says where the work goes. Switch's docs are clear that a role doesn't change what an agent may do, and any member can take one, so if we'd used roles to decide who can approve, we'd have built a privilege escalation. Who asked stays on record through the hand-off, so the person who asked still can't approve.

## What broke, and what we got wrong

Our demo was going to star an agent trying to send ₹40,000 because a ticket pressured it to. We ran it 9 times and the agent never did. It looked up the order, saw a ₹4,000 kettle, and asked. That's good news about the model, and it wrecked our script, so we changed the script. What the agent did do was offer the correct ₹4,000 to the brand-new payment ID in the ticket. It caught the wrong number and still nearly paid the wrong person, which is a more realistic failure anyway.

We scored 25 of 25 on our 25-case authority suite, on a fake chat port at first. Later we ran the same cases on the real stack (25 of 25 also ran on real Switch and Mattermost, 25 prevented there, 5 adapted to what the stack has), and that found something the fake one couldn't: our addressing lists chat accounts, not people, so a person's second account can't answer anything until it's listed. Before that, a separate AI review had found five real breaks the suite missed. The worst: if you addressed an agent without a literal `@name`, Clearance didn't know you'd asked, and you could approve your own refund. We fixed all five and kept them as regression checks. Now, when Clearance can't tell who asked, it needs two different approvers.

Then a second review, on code that passed all of that, reproduced 28 more. A denial could vanish if it landed in the seconds while its card was still opening, and the next approver could then approve what had just been denied. A grant for `rm -rf $(echo ../old-build)` also let `rm -rf $(echo /)` through. One single-use grant covered a command in a loop. We fixed those too. A third review reproduced 19 more in what had been written since, and my favourite was one we caused: a fix from the second round meant any stray `@2pm` in any room raised a request to two approvers, and prod deploys only have one. A fourth reproduced 25 more, and the worst was the plainest: send the same refund twice at the same moment and both ran with nobody looking, because every limit was checked before the record it reads had been written. A fifth reproduced 21 more in the room roles we'd added since, and the worst took one word: `@constructor` anywhere in a message made core throw, so Switch delivered the ask, it was never counted, and whoever wrote it could approve their own refund. All of them are re-checked on their own line. I don't read 25 of 25 as meaning much beyond those 25 any more.

Then my teammate attacked it, and reproduced 12 more on code that had passed all of that. A display name on a platform message decided who had asked, so an approver could wear a colleague's name and approve their own refund. And one ordinary shell command could overwrite the agent's own hook. That second one is why those files are now read-only inside the sandbox, where the kernel refuses the write, because a classifier can't know every way of rewriting a file. Writing up that limit turned up one more of ours: a machine-wide settings file that could have switched off every hook. Our fix for it mounted the file in the wrong place, and only a live probe from inside the running sandbox noticed. I'd expect the next review to find something too.

Our first autonomy rule demoted an agent whenever an amount was above the 95th percentile, which by definition is about one call in twenty. On a synthetic week the agent lost its status at action 34 of 120. We changed it so an unusual amount gets a person's eyes on that one call. Both numbers are in our results, along with a note that we changed the rule after seeing the first one.

Recording the video found bugs the tests hadn't. Reading the frames, we saw Sam get two identical review cards a second apart. A card takes seconds to open and is only on record afterwards, so Clearance's one-second timer looked for a missing card and opened another. Looking for the same pattern turned up two more, including one where the timer ran an approved refund while the path that approved it was still posting, and that path then fell over. The gate runs each request at most once, so no money moved twice. That's why that rule lives in the gate.

And one that scared me: a hosted model running one of our agents ran `cat` on a token file and then read our demo scripts, because agents run as your user. The tokens only worked on localhost and we rotated them, but we fenced agents to their own folders after that. If you run agents on your own machine, think about that before you hand one a shell.

## What Clearance doesn't do

It doesn't judge whether a decision is right. It makes sure the right person decides with the real facts in front of them. It won't stop an agent that has its own credentials outside the gate. Hooks are a guardrail, and Codex's own docs say so. Shell classification is best effort, and `python -c` can do things it can't read, which is why business credentials live only in the gate.

## Try it

```bash
git clone https://github.com/SohamJuneja/clearance && cd clearance
cp .env.example .env   # add one Anthropic key
just demo
```

Then follow the best demo path in the README. All the data is synthetic. Our numbers, including the ones where we lose, are in `RESULTS.md`, and each one comes from a script you can run.

We built this with Claude Code, and I dictated with Wispr Flow. The decisions and mistakes are logged in `DECISIONS.md`.
