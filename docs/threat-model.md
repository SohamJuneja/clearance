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

A grant is for one run of one call. Its hash covers:

- The command's words, with quoting kept wherever it changes what runs. `'$X'` and `$X` differ, and so do `$(echo a)` and `$(echo b)`. `"origin"` and `origin` run the same, so they hash the same.
- The directory it runs in, including a vendor's own working-directory argument. A relative path means nothing without one.
- Anything earlier on the line that changes where or how it runs: `cd`, `export`, a bare assignment, `alias`, `git remote`, and what a shell string runs under (`sudo bash -c '...'`).
- The whole line as written, when the command repeats, is fed from a pipe or heredoc, or gets arguments through `bash -c '...' _ x`.
- What a file write would put in the file, and for an edit, what it replaces. A write through the shell is bound to its line, which is where its content is.

The same command twice on a line needs two approvals, because a grant covers one run. A grant for a command alone doesn't cover it in a loop. Approving the loop as written does, once, and its card says it repeats. A patch touching several files spends no grant until every file can proceed.

What comes after a command on the line isn't bound. Agents really do change the tail on retry (spike S9), and whatever follows is classified in its own right. So `git push origin main; rm -rf ../x` needs a grant for each.

## Identity

The requester comes from Switch's `sender` and `on_behalf_of` fields on message events. The approver comes from `answered_by` on Switch's `approval_outcome` event, resolved through identity claims. Nothing an agent writes can change either one. An answer from an account that maps to no known person is ineligible.

The Clearance agent has its own Switch owner, `clearance-admin`. Two agents with the same owner can change each other's addressing policy, so no persona or Acme agent shares that owner.

When we can't tell exactly who asked, we take the cautious reading: everyone who addressed that agent in the last 10 minutes counts as a requester and can't approve. So does anyone whose message was sent before the hold and arrived after it, and anyone past the 10 minutes who has had no reply from the agent since they asked, for up to an hour. All Clearance can see of an agent's turn is its messages, so an agent that posts progress as it goes ends that second rule early.

That reading only covers rooms Clearance is in. Someone can ask the same agent somewhere it isn't, and leave no trace. If nobody at all is on record, two different people must approve, since only one of them can be the person who asked. If someone else is on record, the request looks attributed, so core also asks Switch, each time it holds a new request, whether the agent is in a room Clearance isn't in or has a live session in one. If it is, or if Switch can't say within 1.5 seconds, two people must approve and the card says why. A call that says which room it came from takes its requesters from that room, though anyone who asked elsewhere in the window still can't approve, because the room on a call is only the agent's word.

## Agents run in a fence

Each machine's controller runs in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox, and every session on that machine inherits it (`scripts/fence.sh`). `scripts/check-fence.sh` proves it with no LLM: it runs a probe inside the same arguments, and inside each running controller's own namespaces, and `just demo` calls it.

From inside the fence, an agent cannot see:

- The real home, so no `~/.ssh`, cloud credentials, operator settings or other Claude transcripts. Each machine has a home of its own instead.
- The repo and `data/`, so no `.env`, Acme admin key, gate token list, Mattermost tokens or gate database.
- Other machines' agent folders, data folders and homes.
- The Docker socket, anything else under `/run`, and other processes, including core's and the gate's environments.

Everything else on the host is read-only. Only the machine's own agent folders, data folder and home can be written.

OpenCode's agent has its own machine, with no Claude or Codex login bound, because a third-party model is on the other end. In one run before the fence, that agent read this repo's scenario script and printed two tokens into its tool output, which is why this exists. The baseline has its own machine too, because its folder holds the Acme admin key on purpose.

## Where agents can be addressed

Each protected agent can only be addressed in its own rooms, and Switch enforces it. In a listed room it hears the message. A direct message draws "You're not permitted", and the agent hears nothing. A private chat gets a 403. `scripts/setup-world.ts` sets this, by room id, each time rooms are recreated. Clearance can't check another agent's policy from outside, so `just demo --check` checks it as the owner. If a room that holds the agent and not Clearance still exists, such as one from an old direct message, that agent's requests need two approvers until it is archived, which each take does.

## Limits

**A grant doesn't bind the world around the call.** It binds the call. A `git remote set-url` or a commit in an earlier call still changes where an approved push goes, or what it pushes, and so does anything in a shell profile. A business action doesn't have this problem, because the gate executes it with the arguments that were approved.

**A card shows a preview of a write or an email's body.** That's the first 160 characters, with the total alongside, because a longer card can't be answered at all. Everything past the preview is approved too, so a person seeing "first 160 of 5000 characters" should say no or ask.

**Reading a shell line isn't running it.** The parser knows the wrappers it lists (`sudo`, `doas`, `busybox`, `flock`, `taskset` and others). One it doesn't list hides the command behind it, as with zsh's `repeat`, `npx` or `make`. A script hides everything in it, and an agent can write one and run it. Hooks catch mistakes and ordinary misbehaviour on the line in front of them, and the gate stays the boundary.

**The scan of inline code can be evaded.** Agents parse JSON with `python3 -c` and `node -e` all the time, so holding every one would bury real calls in cards. Code given to `python`, `node`, `tsx`, `bun`, `deno eval`, `perl`, `ruby`, `php` or `awk` is held when its text writes files, starts a process or reaches the network, or is only known at run time, and plain computation passes. It's a scan of text that starts from an allowed list of imports where the language has them, and it isn't an analysis of a program, so enough ingenuity will get past it. It doesn't read `sed` scripts, whose `e` and `w` commands run things and write files. It doesn't hold reads either: `python3 -c "print(open('/etc/hostname').read())"` passes where `cat` of a path outside the agent's directory would be held. An approved inline line is bound to its exact bytes.

**Switch's tools are checked by name.** Six chat tools skip Clearance, so an outage can't silence an agent. Everything else on Switch goes to core, where looking around stays quiet and anything that changes a room, an agent or a template gets a card. A tool Switch adds later gets a card until the policy names it.

**The fence is about files and processes, not the network.** Network stays shared so loopback reaches core and the gate. So an agent can reach anything on loopback, including Mattermost, Switch's API and database, any other local service, and the host's abstract Unix sockets, though it needs credentials it no longer holds to do much with most of them. It can also reach the internet, so anything it can read, it can send.

**A Claude agent can read Claude's credential.** Until an API key exists, Claude agents run on a login, and the agent can read what its own session authenticates with. With a login, that is a copy of the short-lived access token and never the refresh token, so what leaks stops working when it expires, at most about 8 hours later. With an API key in `.env`, the agent can read the key, and it works until someone revokes it. A key with a low spend limit is the better choice for that reason.

**Agents on the same machine are not fenced from each other.** `refunds-agent` and `support-agent` share Priya's machine, and `coder` and `reviewer` share Alex's. Each can read the other's folder, including its hook and gate tokens. Per-agent tokens only separate agents across machines. Running one machine per agent would close this.

**An agent can read its machine's controller credential,** which sits in the data folder the controller needs. With it, the agent could speak to Switch as that machine. We have not measured how far that goes.

**An agent can write its own folder and home,** including the hook configuration in its clone. Hooks stay a guardrail for that reason, and the gate stays the boundary. The bare repository standing in for GitHub is writable too, because a local `git push` needs that, so a held push is a guardrail here. With real GitHub, only the gate holds the token.

**The gate and core run outside the fence as the same OS user.** The fence is what keeps agents from their files. In production, run the gate on another host or as another OS user.

**It relies on the host.** The fence needs Linux and unprivileged user namespaces, so `just demo` refuses to start agents on macOS or where AppArmor blocks bubblewrap. It hides all of `/home` only when `$HOME` is under `/home`, so with `HOME=/root` other users' homes stay visible read-only inside the fence. There is no seccomp filter, so a kernel bug is out of scope. Codex and Cursor binds are written but untested, because no login for them exists yet.

Clearance can't stop an agent that has its own unscoped credentials outside the gate. Baseline agent `refunds-agent-vanilla` in our evaluation holds the Acme key directly, on purpose, to show that case.

Switch's Trust guardrails see messages and not tool calls, and they fail open after 2 seconds, so our optional Trust endpoint is advisory.

Clearance can't see every room an agent is working in. Measured on Switch (`spikes/s-hidden-session.ts`, `spikes/s-hidden-live.ts`):

| Where someone asks | Protocol agent | Managed agent |
|---|---|---|
| A Mattermost direct room, which Switch makes readable | Seen | Seen, by membership |
| A private chat in Switch, with a live session | Seen, by a session with no room name | **Not seen.** A live managed agent reads as one session with no room, whatever it is doing |
| A private chat in Switch, before a session starts | Not seen | **Not seen** |

So the break remains for a managed agent in a private chat, when someone else also asked it in the last 10 minutes: Clearance records the wrong person, asks for one approver, and the person in the chat can approve their own request alone. The evaluation doesn't cover this: its case 1 passes a room on the call, and its chat can't answer where an agent is, so a full score there doesn't mean this is closed.

To shut it, an agent's owner limits who can address it to named rooms. Switch enforces that: a direct message draws "You're not permitted", the agent hears nothing, and a private chat is refused. Clearance can't check this from outside, because another agent can only read that a policy is `custom`. `pnpm eval:authority --live` checks the effect on a real stack with a throwaway agent, and in our run the direct message and the private chat were both refused. Making `clearance-admin` a workspace admin would also show private chats, by membership, with no code change, but it puts a workspace admin's password on the demo machine, so we don't.

A room Clearance isn't in counts for good once someone has written there. Switch shows that an agent belongs to a room, not when it was last used, so one old direct message means two approvals for that agent until the room is archived. We accept that: it asks too much, not too little.

A type-to-confirm prompt proves someone read one field. It doesn't prove they thought about it. Drills measure attention, and a drill catch rate from a small group is a pilot number, not a guarantee.
