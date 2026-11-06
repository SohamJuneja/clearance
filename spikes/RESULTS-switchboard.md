# Spike results: switchboard

Run on Fri Nov 6 against the live stack at Switch `1fe56227` (server reports version 0.31.0, agent-protocol speaks 9, accepts 1). Every line here was observed by the script named, through the Mattermost REST API with persona tokens and through Clearance's own client. Raw frames are in `packages/switch-agent/test/fixtures/`.

| Spike | Result | Fallback taken |
|---|---|---|
| S2 native cards | **PASS** | none |
| S3 addressing restricts answerers | **PASS** | none |
| S4 attribution from the stream | **PASS** on what the stream shows; mention parsing and chains are core's job | none |
| S7 direct room | **FAIL as written**, passes when the person opens the DM | variant below; PLAN's `#approvals` + `send_targeted_message` also works |
| S8 room documents | **PASS** for create and update; **FAIL** for `!list-documents`, a crash in the pinned Switch | Room notice and Gateway page, plus PLAN's Desk page |
| S11 template with Clearance | **PASS** | none |

## S2 native cards (`spikes/s2-cards.ts`)

Pass test met: card opens, a press in Mattermost arrives as `approval_outcome` with `answered_by`, ack with `.../delivered`.

- **The stream must declare a revision.** `approval_outcome` goes only to a `scope=all` stream that declares protocol 4 or later (`protocol/stream.py:224-229`). A client that declares nothing still connects, so it would never hear an answer and never be told why. The client sends `protocol=9&protocol_accepts=9`.
- **Open body.** Every field is required and unknown fields are refused: `{request_id, turn_id, kind, title, detail, options:[{id,label,decision}], questions, room_id, thread_id, expires_at}`. `decision` is `accept|acceptForSession|decline|cancel`. There is no `description` on an approval option. The session id is any string; no session has to exist.
- **Handle.** Shape `A1`, `A2`, counted **per Mattermost channel**. It is written only into the post: `**Permission needed** · request \`A1\``. The approvals API never returns it, and `read_context` does not show it, because a card is not a room message. To read it you read the post from Mattermost and match the title. It appeared 215 ms after the open.
  - `A3` in a DM and `A3` in `#approvals` are different cards. A typed answer only resolves in the channel it was typed in, so an inbox line that shows a handle only works if that card is also in that channel.
  - The handle is not known when `detail` is written and `detail` cannot change, so the Appendix D line "Reply A12 yes or A12 no" cannot go in `detail`. Switch adds its own: "Reply with `A1` and your choice, e.g. `A1 1`."
- **Press by API.** `POST /api/v4/posts/{post_id}/actions/{action_id}` with the persona's token. Action ids `switch1`, `switch2`; button names are numbered: `1. Allow`, `2. Deny`. Answered 200 `{"status":"OK"}`. The card redraws with no buttons: `**Allow** · request \`A1\` ... Chosen by @sam from Mattermost.`
- **Typed grammar.** `A2 no` gave `answer:"deny"`. A bare `yes` as a direct reply to the card gave `answer:"allow"`. `A4 q1="40000"` on a questions card gave `answers:[{question_id:"amount", custom_text:"40000", selected_option_ids:[]}]`.
- **Outcome frame** has no `type` and no `room_id`: `{session_id, request_id, kind, state, answer, answers, answered_by, answered_at}`. `answered_at` is ISO. `answered_by` is the participant id. An answer given from Console or the web is recorded as `user:<switchUserId>` instead (code, not run).
- **Expiry.** With `expires_at` 4 s out, the frame arrived after 4.4 s: `state:"expired"`, `answered_by:null`.
- **Close.** The card redraws as `**Closed** ... Cancelled before it was answered.` Its buttons are gone, and a late press is a 404 from Mattermost. `delivered` refuses a closed request, so there is nothing to ack.
- **Offline answers.** An answer given while Clearance's stream is down is delivered when the stream reopens, even with a new connection id, until it is acked.
- **Wart.** Every card ends: "Nobody here is linked to this agent's owner, so this notified no one. Link your Mattermost account in Switch Console to be notified." `clearance-admin` has no account in the room. It is true: the card mentions nobody, so Clearance must follow it with a targeted `@sam`. Removing the line would take linking `clearance-admin` to an account in every room, which fails in real DMs and adds a ghost member everywhere else. Left in.

## S3 addressing (`spikes/s3-addressing.ts`)

- **Body.** `PUT /gateway/agents/{id}/addressing-policy` as the owner, `{"policy":{"rules":[{"users":["<external user row id>"],"agents":[]}]}}`. Ids in `users` are **`ExternalUser` row ids**, what the claim call returns as `id`, not Switch user ids and not participant ids. Stored form: `{"rooms":"*","room_groups":"*","users":[...],"agents":[],"owner":false,"owner_agents":false,"platform":false}`.
- **Refusal.** With only Sam and Neha listed, Priya (linked, not listed) and guest (unlinked) both got HTTP 200 from Mattermost on a press and no outcome. A typed answer draws a post: "guest: Your answer to A1 did not land, because you may not address this agent, so you may not answer it." Sam's press then landed.
- **Addressing.** `@clearance inbox` from either of them draws a public auto-reply: "@priya You're not permitted to direct messages to me in this room — my operator has restricted who can address me here." The message still reaches Clearance's stream with `addressed:false`.
- **What setup leaves in place.** All four linked personas may address Clearance, because F4 wants a requester's press to reach Clearance so it can refuse visibly. Guest is excluded at the Switch level. **Agents are admitted (`agents:"*"`):** an agent cannot answer a card (`s4-attribution.ts`: an agent typing `A1 yes` into the room answered nothing), and refusing one makes Clearance post a mention that wakes that agent. Clearance's own re-check of `answered_by` remains the policy.

## S4 attribution (`spikes/s4-attribution.ts`)

A persona addressed a protocol agent owned by Alex, in a room with Clearance. On **Clearance's** stream:

```json
{"addressed":false,"sender":"@switch-mattermost-<bridge>-priya:localhost","sender_name":"priya","sender_kind":null,
 "on_behalf_of":null,"message_id":"sw_...","body":"@spike-worker refund order A-1931","timestamp":1793913570175,"thread_id":null}
```

- `sender` and `thread_id` are there. A threaded message carries the root's id. It arrived within about 120 ms.
- **Nothing says who was addressed.** `addressed` is about the reader. Core must parse `@name` from `body` to know which agent a person spoke to.
- **`on_behalf_of` is null for people and for agents.** It is set only on a platform message, and it holds a **display name**, not a participant id. A template kickoff run by Alex arrives as `sender:"@switch-admin:localhost", sender_name:"alex", sender_kind:"platform", on_behalf_of:"alex"`.
- **No chain through agents.** An agent's message shows `sender:"@switch-agent-1941a4a0:localhost"`, `sender_name:"spike-worker"`, `sender_kind:null`. `sender_kind` does not separate people from agents. Clearance has to build chains itself from who addressed whom, and identify agents by comparing with its own list.
- **A follow-up in a thread with no mention** is `addressed:false` even for the agent that was asked.
- **Clearance waking an agent.** `send_targeted_message` to the worker returned `target_statuses:{"spike-worker":"live"}` once the worker's policy admitted Clearance. On the default `owner-agents` policy it returns `not_permitted`, the message still goes out, and the agent does not wake. **So every Acme agent needs `addressing: anyone`**, which the templates set.
- **A missed-history trap.** A connection only starts reading a room it has newly joined on its next pass, up to 15 s later. Earlier messages count as history and are not delivered: Priya's first message in a new room was skipped. Telling the client about the room (any op with `roomId`) wakes the stream at once. It does not matter for rooms that exist before a demo starts.

Linking to the hook call within a turn is core's part. This spike confirms the data is on the stream.

## S7 direct room (`spikes/s7-s8-direct-and-docs.ts`)

- **As written, it fails.** `create_room(channel_type="direct", ...)`: `400 Failed to create room: Mattermost cannot create DM channels — on this platform DMs are initiated by the user from the messaging client`.
- **If the person opens the DM, it works.** `POST /api/v4/channels/direct` with `[person, agent's Mattermost account]` then a first message. Switch makes a room named `Mattermost: sam / clearance` with `channel_type:"direct"` (the Gateway shows it as `sam / clearance`). Channel type `D`, members exactly `clearance, sam`. The card has working buttons. Every message is `addressed:true` with no mention.
- **A private channel with one person also works.** `channel_type:"channel_private"`: the card has working buttons, but the members are `clearance, admin, user, neha`, because the bridge adds its default member to every channel it creates, and messages must mention `@clearance`.
- **Taken.** `setup-identities.ts` opens a real DM per linked persona, with that persona's token, and records `directRoomId`. `ChatPort.ensureDirectRoom` finds it by name and checks it is `direct`; otherwise it makes the private channel `clearance-<user>`. In real use a person writes to `@clearance` once. Rooms must be looked up with `list_rooms`, which returns **`room_id`**, not `id`, and leaves out archived rooms unless asked.

## S8 room documents (`spikes/s7-s8-direct-and-docs.ts`, `spikes/s8-list-documents.ts`)

- **Create and update work.** `create_room_document` took 15 to 27 ms, `update_room_document` 27 to 32 ms. Both need a room binding. A second create of the same name is refused, so finding the id is by `connect_to_room().documents`. `load_internal_documents` read back the update.
- **Every create and update posts in the room:** `📄 updated room document “clearance-ledger-2026-11-05”.` A ledger mirrored on every entry would flood `#approvals`. Mirror on a timer, or put it in a quiet room.
- **`!list-documents` is broken at the pinned commit.** The person gets no reply. Log: `AttributeError: 'CommandConsumer' object has no attribute '_package_store'` at `bridges/agent/commands.py:1963`, in `_package_sources`, which `_cmd_list_documents` calls. `!list-references` goes through the same helper. Clearance cannot fix this without changing Switch.
- **What a person can see instead.** The room notice above, and `GET /gateway/rooms/{id}/documents` signed in as Sam, which lists the document (the Gateway's room page). F8's acceptance line "`!list-documents` shows today's ledger document" cannot pass at this pin.

## S11 templates (`spikes/s11-templates.ts`)

- **An agent can run a template that includes itself.** Clearance ran `save_template` then `run_template` with `templates/clearance.template.yaml`. It got one room with `agents:["clearance"]`, four users and one document. It needed no "can manage agents" capability, because the template creates no agent.
- **A person's run accepts an existing external agent** in a room's `agents:`, by name, and a kickoff that mentions it. Links in the group were created with no errors.
- **Not idempotent.** Running again with the same room name makes a second room, and its channel gets a suffix. `@clearance install` must check first.
- **Clearance cannot join a room by itself.** `invite_agent_to_room` on a room it is not in: `403 Not authorized to change this room's membership`. Alex adding it through `POST /gateway/rooms/{id}/agents {agent_ids:[...]}` worked. F15's "adds Clearance to the chosen rooms" has to be a person or a member doing it.
- **A person's rooms-only run with missing agents half succeeds.** HTTP 201 with the rooms that could be made, and `errors:[{room_name, error:"Unknown agents: ..."}]`. Anything driving this must read `errors`.
- **Machines belong to one owner.** "your owner has no machine". The only controller, `clearance-host`, belongs to the gateway admin; Alex sees none. An agent can only be created on a machine its owner holds, so Priya and Alex owning agents, as PLAN 8.2 has it, takes a controller enrolled under each of them.

**Template validation.** All three pass `POST /gateway/templates/validate` with no errors or warnings. All three reach the planner through `POST /gateway/rooms/from-template-document` with a machine that does not exist, which refuses before creating anything and lists only that problem per agent. Acme Mini's rooms half was provisioned for real under spike names, against stand-in protocol agents: 4 rooms, `errors:[]`. The Clearance template was run for real. Creating agents has not been run, because that starts real sessions.

## Other facts that differ from PLAN section 3 and the protocol doc

- **Heartbeat.** The doc says beat every 2 s with a 6 s TTL. The server states `heartbeat_interval_seconds: 10` and the code has a 30 s TTL. The client beats every 2 s as asked, which is harmless.
- **`generation` is required on the beat.** A client that declared revision 2 or later and omits it gets 409 `unfenced`. A refused beat has `detail.code`: `no_stream`, `unfenced`, `taken_over`. A 404 has a plain string detail. `taken_over` must not reopen, since reopening is the takeover.
- **Positions, not `Last-Event-ID`.** At revision 9 a room message has no `sequence` and no SSE id, only `position:{"r:<room>":n}`. Resume with `start_at=<json position>`.
- **Room-scoped ops on an all-scope connection.** Once the connection has more than one room, an op refuses with "This connection covers several rooms". Claiming the room from a second connection takes it off the watcher's stream. What works is one session per room placed on the same connection: `POST /connection/placements`, then `X-Switch-Session-Id` on each call. Placements restate the whole set.
- **`POST /message`** cannot thread. Threads need `post_message`, which needs a room binding.
- **`!reset @agent`** reaches a revision 9 watcher with a session in the room as `session_command`, not `command`. A `command` frame needs no session placed in that room. Clearance's stream never sees either for another agent, nor the command's text as a message. By the code, `!reset @clearance` draws "this isn't supported for me", since its capability levels are `unsupported`.
- **`AGENT_REGISTRATION_TOKEN` is not usable for Clearance.** It resolves to a shared bootstrap owner. Setup mints a personal key for `clearance-admin`, uses it once and deletes it.
- **Identity by API.** `POST /gateway/collaborations/{bridge}/identities {external_user_id, username, expects_confirmation:true}` as the person, then `.../identities/{id}/verify-session {token:<their Mattermost session>}`. No browser. Participant ids are not listed by any API for people: `list_participants` returns row ids. Setup reads them from the join entries in `read_context` of a throwaway room.

## A mistake in this spike run, and how it was cleaned up

A rerun of `s11-templates.ts` after a crash found its stand-in agents still present, so a "rooms only, agents absent" check succeeded and created real rooms named `support`, `finance`, `eng` and `approvals` under Alex, in a group `Acme Mini`. They were removed with the spike's other rooms: Switch rooms through `spikes/cleanup.ts`, Mattermost channels with `mmctl --local channel delete`, because deleting a Switch room leaves its channel behind and Switch then auto-bridges it again. The names are free, confirmed by `mmctl channel list`. Other subagents' `spike-*` rooms were not touched: the room log shows each of those deleted by its owner outside these runs, or created after them. The check now runs under spike names and `cleanup.ts` only deletes ids named on its command line.

A run of any spike here leaves channels in Mattermost. Clean up with `pnpm exec tsx spikes/cleanup.ts`, then pass it the ids it lists after `--delete`, and delete the channels with `mmctl`.

---

# The in-Switch study (D11)

Run against the live stack with `study-bot`. Probes: `s-study-card-probe.ts`, `s-after-override.ts`, `s10-cookie-check.ts`, `s10-tunnel-check.ts`, `s-card-lengths.ts`. Rehearsal: `study/tools/rehearsal.ts`. Nothing here is a study result, and no rate or time from a rehearsal may be reported.

## How much detail a card can hold

Measured live with a multi-line `detail`, the shape Clearance cards have:

| | keeps its buttons up to | loses them from |
|---|---|---|
| Card that names someone | 998 characters | 999 |
| Card that names nobody | 966 characters | 967 |

The card that names nobody also carries "Nobody here is linked to this agent's owner, so this notified no one...", and that sentence is charged to the budget. **The 990 in DECISIONS.md is only safe on a card that names someone.** Characters are code points, counted after Switch adds a zero-width space following each `@` and `]`. The prompt on a questions card holds to 800 either way.

## Naming the person on a card

A card names the sender of the message its turn answers. `POST /agent-sessions/{sid}/activity` with `kind:"turn"`, `room_id:null` and `message_id` set to something the person said makes Switch name them on every card of that turn, which also removes the "notified no one" sentence. With no room, Switch draws no status post for the turn. Available as `OpenCardInput.mentionMessageId`. It needs a message from that person in that room, which is why the study starts when the participant says hello.

## What real cards do that the Lab does not

- **Typing a value takes quotes.** `A20 38000` is silently not an answer; `A20 "38,000"` is. A questions card's own footer says `A19 1`, which picks the first option, so on a type-to-confirm card it means No. The study's card says how, and the bot explains once if someone gets it wrong.
- **`A19 no` is refused on a questions card**: "a word answers a permission request, and that card asks questions". The Appendix D sentence says "or answer no", so the study's card says to press No. F6's real type-to-confirm has both of these problems.
- **A press on a questions card** sends `answers:[{question_id, selected_option_ids:["no"], custom_text:null}]` and `answer:null`.
- **The same request id opened again** posts nothing, whether the card is open or answered, as long as the content is the same.
- **A typed answer also arrives as a message**, and can be stamped just after the next card went up, because the bridge handles the answer before it relays the message. So a message's time can't by itself say which card it was about.
- **An open card loses its buttons if the agent is gone past Switch's 30 s window.** It shows "Host offline. Answers are unavailable until the session reconnects", and gets its buttons back when the agent returns. A restart shorter than that goes unnoticed. This applies to Clearance's own cards too. The bot marks the time on such a card `interrupted`.

## Exposure

- **Signup.** With the override, all three settings read `false`, and a real attempt is refused with HTTP 501 `api.user.create_user.signup_email_disabled.app_error`, both anonymously and through the team invite link, which any participant could read. With signup open, the checker refuses from the config alone and creates no account.
- **Admin-created accounts still work**: `p03` was created with signup off. Persona tokens, `setup-identities.ts`, a card and a press all still work after Mattermost restarted.
- **SITEURL matters, for one thing.** This Mattermost only upgrades a websocket whose Origin is SiteURL or is listed in AllowCorsFrom. Through a tunnel it answered 403, so a browser would get no live updates and never see a new card. `study-expose.sh` puts the tunnel's origin in AllowCorsFrom, which takes effect at once with no restart and keeps local browsers working, requires a 101 through the tunnel before it gives out the URL, and clears the setting on exit. Other origins stay refused.
- **Nothing else needed SiteURL**: session cookies carry no Domain, and cards hold no links. Through the tunnel: login with a one-time password, a post, a card with its buttons and a press all worked. Tunnel up for about a minute at a time, stopped each time.
- **Not tested:** a real browser or a phone. These checks are what a browser does, made over the API. S10's phone login is still open.

## Team size

Mattermost refuses new team members past `TeamSettings.MaxUsersPerTeam`, 50 by default, and every agent's bot counts, including bots of deleted agents. Provisioning stopped at `p11` when the team reached 50: 32 bots, many left by spikes, and 18 people. New agents could not have joined the team either. `setup-study-accounts.ts` raises the limit to 200 through the admin API, which takes effect at once and needs no override.

## Rehearsal (synthetic)

A script played p01 through Mattermost's REST API with its one-time password, in a scratch results folder, on the final code.

- **Cards:** 34 posted, 34 expected, none doubled. Every card had its buttons when first seen, named the participant, and had no "notified no one" line.
- **Evidence:** every card comes from `cardInput` in `study/lib/cards.ts`, the same function the Lab draws from, so it is the card the product posts. Longest condition A detail 230 of 990, longest condition B detail 745 of 990, longest prompt 749 of 790 (`s-card-lengths.ts`). The four critical cards the prompt can't hold whole (X06, X07, Y07, Y10) give up the agent's claim, as core's rule says, on both platforms.
- **Someone else** (the bridge's default member, who is in the room) pressed and typed: Switch refused both and the card stayed open.
- **Killed with a card open,** answered while down: recorded once, on restart. **Killed and restarted:** one copy of the card, with its buttons.
- **Down for 40 s:** the open card showed "Host offline" with no buttons, and got them back on restart. It is the one decision marked `interrupted`.
- **Records:** every one says `platform:"switch"` and `synthetic:true`. The analysis labels it synthetic with a null headline. `study/results` was untouched.

Four earlier rehearsals found the hint firing on a message about the previous card, which this one confirms fixed. Those runs also logged `UNKNOWN: unknown error, write` five times once, from the bot's own file writes, on the third process of the first rehearsal. It did not recur in the next four, 560k writes to that disk in a stress loop did not reproduce it, and every record was intact, because a failed write is retried and nothing is acknowledged until it is saved. Cause unknown. The log now shows the syscall and call site if it comes back.

**Not rehearsed:** more than one participant live at a time (the fake ChatPort covers routing), or a real person.

**One line on the card does nothing in the study.** Condition B's approval card ends with the product's `@clearance why CLR-...`, on both platforms, and no Clearance is listening. Typing it is not an answer, the card stays open, and the clock keeps running.

---

# Inbox, ledger mirror and install (F7, F8, F15)

`s-inbox-live.ts` runs the real `packages/core/src/main.ts` as its own process: port 7791, a spare database, a stub gate on 7793, and a throwaway agent with its own bot, in throwaway rooms. Sam, Neha and Alex's real accounts talk to it. All 50 checks passed on the final code, on top of the merged drills. `s-inbox-cleanup.ts` removed everything by name afterwards. `clearance`, `support`, `eng` and the running core weren't touched.

## What a person sees in their direct room

Before: a long card, plus "@sam CLR-0001 needs your decision: REFUND ₹40,000. The card is just above." With an inbox line too, that is three posts per request, two of them saying the same thing. **Chosen:**

- **The inbox replaces that line.** A request adds a card and changes the list, nothing else. A backup still gets their own line, because it says why they're suddenly involved.
- **One live copy, at the bottom.** When the list changes, the old post goes and a new one follows. An empty list is no post at all.
- **The card has the evidence and the list doesn't.** Each line is one short pointer, so they don't repeat each other.
- **A mention only for new work.** A list that only shrank is posted without one.
- **"Ages as of 04:49 IST."** The post stays up, so its ages stop being true. Editing it every minute wasn't worth it.

Two open, as Sam saw it:

```
**Permission needed** · request `A15`   (2 buttons, about 20 lines of evidence)
**Permission needed** · request `A16`   (2 buttons, about 20 lines of evidence)
@sam **Needs your response (2)**
A16 CLR-0016 refund ₹70,200 · #finance · 1 s
A15 CLR-0015 refund ₹60,200 · #support · 2 s
Ages as of 04:49 IST. Reply here with a code, like `A16 yes` or `A16 no`, or use the card's buttons.
```

## Why it needs a token for Clearance's own bot

`s-inbox-posts.ts`. Switch has no operation for an agent to edit or delete a message. And the reader account the core used for handles gets **403 on a real DM**, so every inbox line there would have had no code to answer with.

| With a token for the agent's bot | Result |
|---|---|
| Minted by the admin, as for the personas | HTTP 200 |
| Reads its own real DM | HTTP 200 |
| Edits, deletes its own post | HTTP 200, gone for Sam, and later messages still flow |
| Deletes Sam's post | **HTTP 403** |

`setup-identities.ts` now mints it as `mattermostTokens.clearance`. **Without it the inbox still works**, with CLR ids instead of codes, and old posts stay: the newest is the true one, and a list that empties says "(0)", since a stale "(1)" at the bottom would be a lie. Checked on a scratch copy of the data folder against the real `clearance` bot: `rooms` kept, agent key and persona tokens unchanged, Sam's real DM readable (reader still 403). That token was revoked afterwards.

## The acceptance lines

| | Measured (from just before `/v1/check`, to the list being readable by Sam) |
|---|---|
| Two requests from two rooms, together | 531, 653, 621, 630, 633 ms |
| A second request with one open | 648, 596, 673 ms |
| Typing `A15 yes` in the DM, to `EXECUTED` | 219 ms |

Answering from the code also ran the gate once, took the buttons off the card in the origin room, counted as Sam's approval, and shrank the list. `A16 no` denied the other, nothing ran, and the post went.

## What the live run and reading the code found

- **Two identical cards for one request.** `hold` waits for the card while the request is `HELD`, and `tick` retries anything `HELD`, so a tick in that window opened a second card. It was there before, but the window was tiny while the handle lookup failed at once on a 403. With the bot's token the lookup takes about 250 ms, about a quarter of every tick. Seen on the first live run (`A17` and `A18`, both CLR-0016), fixed in `core.ts` with a test. **Fakes alone wouldn't have shown this.**
- **`@clearance ledger` could have held up answers.** Frames go through one serial queue (`agent.ts:205`), so an awaited copy on a stuck Switch would delay every approval behind it by up to 30 s. Operator commands now run outside the queue.
- **A handle shown in the wrong room can answer the wrong card.** `A12` is counted per channel. `@clearance inbox` was showing DM codes anywhere, and `@clearance why A12` took the newest match from any room. Now a code shows only in its card's room, and `why` and `status` prefer the card in the room they're asked in.
- **Re-running `setup-identities` dropped `identities.rooms`,** which would have broken every room-based route. It now keeps what it doesn't write.
- **A brand new bot:** a first message to it can open no room. Retrying worked. Only a fresh agent would see this; `clearance` is long-lived.

## Ledger mirror

- **Documents:** `clearance-ledger-YYYY-MM-DD`, the date in the team's zone, then `-2`, `-3` past 1,000,000 bytes. Live: Switch took 1,000,000 bytes and refused 1,048,577. An entry too big for any document keeps its place and hash, and says where its payload is.
- **Never loses an entry:** `ledger_mirror_seq` moves only after Switch takes a document, and a retry rebuilds the same documents from SQLite. Live: all 54 entries in the document, hash for hash.
- **Never blocks:** nothing waits on it. `tick` only starts a copy.
- **Debounce:** at most every 5 real minutes, not scaled, and nothing at all if nothing changed or a drill is open. Every rewrite posts a notice, so yesterday's document and an unchanged `clearance-state` are left alone. **The 5 minutes were tested with a fake clock, not waited out live.** Live: a boot copy with no asking, and a second on-demand copy posting no notice.
- **On demand:** `POST /v1/ledger/mirror`, or `@clearance ledger` from anyone.

**How a judge sees it,** since `!list-documents` crashes at the pin:

1. In `#approvals`: `📄 updated room document “clearance-ledger-2026-11-06”.`, seen live.
2. On the room's Gateway page, `http://127.0.0.1:3000/rooms/<room id>`. `GET /gateway/rooms/{id}/documents` as Sam listed both documents and read them back, and the page itself answers 200. **Not opened in a real browser.**
3. `@clearance ledger` replies with that link when `CLEARANCE_GATEWAY_URL` is set.

## Drills, in the mirror and the inbox

Approvers read `#approvals`, and a drill only works if it can't be told from a real request (PLAN F9). What is left out gives one away as surely as what is put in. Brain's drill writes `drill_sent` where a real request writes `held`, and no `routed`. So hiding `drill_*` alone would leave a gap in the entry numbers beside the card's arrival, a card missing from the open list, and a `clearance-state` notice with no ledger notice beside it, at the moment the card lands. **Chosen:**

- **While any drill is open, the whole mirror stands still:** ledger and state, timed or on demand. A document's "as of" time comes before that drill and before every later request alike. Holds and answers are unaffected, and everything real is copied once it closes.
- **A drill's entries are never copied, even after it closes.** That is every entry on its request, including `ineligible_answer`, since they say who answered what. Entry numbers skip there, and every document says numbers can skip.
- **The team gets totals only, in `clearance-state`, and only in whole groups of 3.** "1 finished, 0 caught" is one person's result, and so is the difference between two totals. So they read 3, then 6, and never 4.
- **`@clearance ledger` says where the copy has reached and never how far behind it is,** since that gap is what an open drill looks like.
- **Inbox:** the same fields, the same line, the same mention. A drill from no room reads as coming from where real requests of its kind come from, because a line with no room would be the only one like it.

**What remains:** a mirror standing still is a weak signal. Someone who knows there was other activity, and checks the documents more than 5 minutes after a card, could suspect a drill. It lasts until the drill closes, at most its 25-minute expiry. Silence is also normal, since nothing is written when nothing changed, and I found no way to avoid this without publishing something false in a tamper-evident copy. `drill-privacy.test.ts` and the live check run real drills, through `sendDrill` and `POST /v1/drills/send`.

**Also found in the drills:** `openDrill` waits for its card with the request still `HELD`, so the tick's retry could route it to someone else, the same race as the doubled card. It now goes through the same guard.

**For brain:** a drill can take a real room from `requesters.lastOrigin`, and `dispatch` then posts a copy of its card there, where everyone sees a request that later vanishes with no outcome. Not changed here.

## `@clearance install`

Live, with a spike template and room name: Sam refused, Alex installs, the reply says what was made, a second run says "already installed" with still one room, and `#approvals` is remembered in `identities.json`. It looks across every room the owner can see (`list_all_rooms`), so it won't make a second room beside one it isn't in or an archived one. Two at once make one. **Admin is `admins:` in `team.yaml`,** the list `@clearance drills` goes by, checked against `sender` only. **Not run under the real names,** per the brief.

## Not tested

A real browser or phone. Waiting out the 5 minutes. A document past 1 MB through a real rollover (fakes, plus the live limit above). The mirror with Switch really down, since the stack is shared (fakes).

---

# Is the agent working somewhere Clearance can't see?

Priya names `@refunds-agent` in `#support`. Within 10 minutes Sam asks the same agent somewhere Clearance isn't. Clearance records Priya, quorum stays 1, Sam gets the card and approves his own refund alone. `s-hidden-session.ts` measures what Switch will say, `s-hidden-live.ts` runs the break end to end on a spare core, port 7791, spare database, stub gate. Both use throwaway agents and rooms. Real agents were only read.

## What Switch reveals

Read with `get_agent_detail`, by a viewer owned by `clearance-admin` as the real Clearance is, and one owned by the gateway admin.

| Where Sam asks | Membership, to Clearance's owner | Membership, to a workspace admin's agent | Live session, protocol agent | Live session, managed agent |
|---|---|---|---|---|
| Mattermost direct room (`read_visibility: public`) | **Named** | Named | Named | No room, see below |
| Private chat in Switch (`read_visibility: private`) | **Not shown** | Shown | Room id, no name | No room, see below |

- **A live managed agent is one session with no room.** Measured on `coder` and `ops-agent` with their controllers up: `{room_id: null, lifecycle: "controller", state: "live"}`. `presence.py` says why: "Switch does not know where its sessions are". So for a managed agent only membership can tell, and only for rooms Clearance's owner can read.
- **Bridged rooms are `public` by default**, including Mattermost direct rooms, so any agent's owner can list them. `list_all_rooms` names one `Mattermost: sam / <agent>`. A Switch chat is created `private`.
- **Nothing else reveals it.** On the hidden room's id, `get_room_detail` answers 403 and `read_context` 403, for both viewers. `connect_to_room` answers 400, and `list_participants` works only after it, so neither helps. `list_agents` counts tools and models, not rooms or sessions.
- **A stopped agent's session lingers** as `live` for a while, so a hidden session counts for a short time after it ends. That is the cautious direction.
- **All real agents are only in rooms Clearance is in**, default channels included: `refunds-agent`, `coder`, `ops-agent`. So the normal flow stays at quorum 1.

## What core does

1. **A call that names its room** takes its requesters from that room. Nobody on record there means unknown, so quorum 2. Anyone who asked elsewhere in the window still can't approve, since the room on a call is only the agent's word: otherwise Sam could ask in `#finance`, have the call say `#support` where Priya asked, and approve alone.
2. **Every new hold asks `ChatPort.unseenRoomCount`**, 5 s cache, 1.5 s timeout. Any room the agent belongs to or has a live session in that Clearance isn't in, and the record may be incomplete: quorum 2, and the card says so. A failed lookup, or an agent Switch doesn't know, is the same with its own wording. A port with no such method changes nothing, which is why E1's fake chat can't exercise this.

## The break, end to end

No room on the call, as under Switch today.

| Situation | Quorum | Who can finish it |
|---|---|---|
| Agent only in rooms Clearance is in, Priya on record | 1 | Sam |
| Sam has written to it in a Mattermost direct room, Priya on record | **2** | Sam alone runs nothing; Neha as well runs it, once |
| Private chat, protocol agent with a live session there | **2** | |
| Private chat, no live session: how a managed agent always looks | **1** | **Not detected. This is the limit** |
| An agent Switch doesn't know | **2** | |

The card reads: "This agent is also working somewhere Clearance can't see, so this needs two approvals from different people."

## What is left

**A managed agent in a private chat in Switch, when someone else asked it in the last 10 minutes.** Clearance can't see it, and the person in the chat can approve alone.

`pnpm eval:authority` reads 25 of 25, but **that number doesn't cover this**. E1's case 1 passes a room on the call, which layer 1 answers, and under Switch a managed agent's call has no room. E1's chat is a fake that can't answer where an agent is. A variant for this would still fail.

Options, measured where it says so:

- **Recommended: limit addressing to named rooms, per protected agent.** `{rooms: [...], users: "*", agents: "*", owner: true}`, set by the agent's owner. Measured: named in a listed room it hears `addressed: true`. A direct message draws "You're not permitted...", and it hears nothing. A private chat gets 403 `AGENT_NOT_ALLOWED`. It stops the request happening, for any kind of agent, and Switch enforces it. All real agents read `anyone` today. Not set here, because they are vendor-spikes' and being brought up now. Clearance can't check it from outside: another agent reads only `{policy: "custom"}`.
- **Make `clearance-admin` a workspace admin.** Measured: its agents then see private chats, by membership, and this code picks that up unchanged. But it puts a workspace admin's password on the demo machine. Only if addressing can't be used.
- **Treat every session with no known room as incomplete.** Rejected: every managed agent looks like that, so everything would need two people, and SC3 and SC4 would break.

**A room counts for good.** Switch shows membership and not when a room was last used, so one old direct message means two approvals for that agent until the room is archived. That asks too much rather than too little.

