/**
 * What Switch posts in an agent's name when the agent itself said nothing: its greeting when it joins a room, and that it
 * is offline, stopped or may not be addressed. Switch flags these on its side (`com.switch.auto_reply`), but the flag
 * doesn't reach the event stream, so they're told apart by their exact words at the pinned commit: delivery/recipient.py,
 * delivery/addressing.py and bridges/agent/commands.py.
 *
 * They aren't the agent's claim. A card that quoted one would put Switch's words in the agent's mouth. Only whole
 * sentences match, so something of the agent's own that merely starts the same way is still the agent's.
 */
const NAME = String.raw`@[\w.-]+`;

const NOTICES: RegExp[] = [
  /^Starting a session to handle this — one moment\.$/,
  /^You're not permitted to direct messages to me in this room — my operator has restricted who can address me here\.$/,
  /^I only take instructions from my owner, and this chat account isn't linked to a Switch user yet — so I can't tell whether that's you\. If it is, link this account to your Switch user in Switch Console, post the code it shows you from this account, and try again\.$/,
  new RegExp(
    String.raw`^I read room messages asynchronously, not in real time — (you have|my owner has|${NAME} has) to trigger me to pull the latest messages, either from a session I already have open or by starting a new one\.$`,
  ),
  new RegExp(
    String.raw`^(${NAME} — )?I'm not online in this room(, and ${NAME} needs me)?\. (Open Switch Console|\*\*My owner needs to open Switch Console\*\*) to bring me online here\.$`,
  ),
  /^I have a session connected to this room, but it isn't reporting as live, so I'm not receiving messages\. .+ on the machine I run on\.$/,
  /^I don't have a session (connected to this room|in this room right now).+ on the machine I run on\.$/,
  new RegExp(
    String.raw`^(${NAME} — you've stopped me|I'm stopped), so I'm not running(, and ${NAME} needs me)?\. .+ to bring me back\.$`,
  ),
  /^My machine, \*\*[^*]+\*\*, is offline or reconnecting to Switch, so I can't answer right now\. .+ needs to check it\.$/,
  /^My machine, \*\*[^*]+\*\*, was asleep and is starting now\. I'll pick this up as soon as it's back, usually within a few minutes\.$/,
  /^My machine, \*\*[^*]+\*\*, is stopped, so I can't answer\. .+ can start it again in Switch Console\.$/,
  new RegExp(
    String.raw`^(${NAME} — )?[Mm]y machine, \*\*[^*]+\*\*, has been removed from Switch, so nothing runs me\. My owner has to move me to another machine to bring me back\.$`,
  ),
  /^I hold a role in this room, but the session that assumed it is active in .+ right now — I'll pick this up when it reconnects here\.$/,
  /^Hi! I'm [\w.-]+ — how can I help\?$/,
  new RegExp(
    String.raw`^(Hey there! Tag ${NAME} if you need me\.|Hi! Mention ${NAME} to get my attention\.|Hello! I'm ready — just tag ${NAME} when you need me\.|Hey! Ping ${NAME} and I'll jump in\.|Hi! I'm here to help — mention ${NAME} anytime\.|Hello! Tag ${NAME} to loop me in\.|Hey! I'm on standby — ${NAME} to get started\.|Hi there! Just ${NAME} me when you're ready\.)$`,
  ),
];

/** Switch puts `@whoever ` in front of a reply that doesn't already name them. */
const LEADING_MENTION = new RegExp(String.raw`^${NAME} `);

export function isSwitchNotice(body: string): boolean {
  const text = body.trim();
  const unaddressed = text.replace(LEADING_MENTION, "");
  return NOTICES.some((notice) => notice.test(text) || notice.test(unaddressed));
}
