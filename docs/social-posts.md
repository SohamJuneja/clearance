# #HowISwitch posts

## 1. Teaser

Clip: SC2 then SC3, under 45 seconds, cut from the recorded takes.

In Switch, an approval card mentions the person who asked, and anyone who may address the agent can answer it. So the person who asked can approve their own request.

In this clip, Priya asks an agent for a ₹40,000 refund and approves every card. The money goes out, and nobody else was involved.

Then the same team with Clearance, on a different refund: ₹4,000 to a payment ID added minutes ago. Priya tries to approve it. Clearance refuses in the room and sends the card to Sam in finance.

Switch runs the room, the agents and the cards. Clearance decides who may answer them. The data is synthetic and the people's clicks are scripted. The agents' words aren't.

https://github.com/SohamJuneja/clearance

#HowISwitch

## 2. Drill

Clip: SC9, under 45 seconds.

People stop reading approval cards. Anthropic's post on auto mode says users accept 93% of permission prompts: https://www.anthropic.com/engineering/claude-code-auto-mode

So we borrowed from phishing tests. Now and then, Clearance sends an approver a practice request with a planted flaw. In this clip the amount is ten times the order. Sam approves it without reading.

Nothing runs. Sam gets a private note, and the next high-risk card asks Sam to type a detail from the call before it can be approved.

Sam is a scripted persona and this drill was triggered for the clip, so read this as how drills work and not as a measurement. Switch carries the cards and reports who answered from its own events, not from anything an agent wrote.

https://github.com/SohamJuneja/clearance

#HowISwitch

## 3. Launch

Clip: the full video.

Clearance is our entry to Flip the Switch: one approval policy across agent vendors, the right other person, the real call in front of them, and a way to tell whether approvers are still reading.

We scored 25 of 25 on our own authority suite. Then an independent AI review found 5 breaks the suite had missed, including a way to approve your own refund. We fixed them. A second review, on code that passed all of that, reproduced 28 more, including a denial that could vanish while its card was opening. A third reproduced 19 more, one of them caused by fixing an earlier break. A fourth reproduced 25 more, including one refund sent twice at once running twice. A fifth reproduced 21 more, including one word that took a whole message off the record. A teammate's review reproduced 12 more, including a display name that let an approver pose as someone else. All are fixed and re-checked on their own line.

Our first autonomy rule gave 79.2 human decisions per 100 agent actions on a synthetic week, against 100 before promotion. We changed the rule after seeing that, and it now gives 25.8. Both numbers are published.

Every number comes from a script you can run.

Code: https://github.com/SohamJuneja/clearance
Blog: BLOG_URL, after it's published

#HowISwitch
