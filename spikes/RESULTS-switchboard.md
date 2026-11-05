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
