/**
 * What Switch posts in an agent's name when the agent itself said nothing: its greeting when it joins a room, and that it
 * is offline, stopped or may not be addressed. Switch flags these on its side (`com.switch.auto_reply`), but the flag
 * doesn't reach the event stream, so they're told apart by their exact words at the pinned commit: delivery/recipient.py,
 * delivery/addressing.py and bridges/agent/commands.py.
 *
 * They aren't the agent's claim. A card that quoted one would put Switch's words in the agent's mouth. Only the exact
 * sentences match, with only names in the places Switch puts names, so an agent can't hide what it says in the shape of one.
 */
const NAME = String.raw`@[\w.-]+`;
/**
 * A room, an agent or a machine, as Switch writes one in bold. At most three words, and none of them a bare number, because
 * this is the one place a sentence could hide: "**Refunding 4000 to Rohan**" would read as Switch's words, and go uncompared.
 */
const BOLD_WORD = String.raw`(?!\d[\d,.]*(?:[ *]))[\w.-]+`;
const BOLD = String.raw`\*\*${BOLD_WORD}(?: ${BOLD_WORD}){0,2}\*\*`;
const SOMEONE = String.raw`(?:[Yy]ou|[Mm]y owner|${NAME})`;
const SIGN_IN = String.raw`If Switch Console says I'm signed out, sign me in first with \`[\w .-]+\` on the machine I run on\.`;
const OWNER = String.raw`(?:[Mm]y owner(?: \(${NAME}\))?)`;

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
  new RegExp(
    String.raw`^I have a session connected to this room, but it isn't reporting as live, so I'm not receiving messages\. ${SOMEONE} can restart it by opening ${BOLD} in Switch Console\. ${SIGN_IN}$`,
  ),
  new RegExp(
    String.raw`^I don't have a session connected to this room\. ${SOMEONE} can start one connected to ${BOLD} by opening ${BOLD} in Switch Console\. ${SIGN_IN}$`,
  ),
  new RegExp(
    String.raw`^I don't have a session in this room right now, but I'm working in ${BOLD}(?:(?:, | and |, and )${BOLD})*, so you can ask me there\. Or ${SOMEONE} can start one connected to ${BOLD} by opening ${BOLD} in Switch Console\. ${SIGN_IN}$`,
  ),
  new RegExp(
    String.raw`^(${NAME} — you've stopped me|I'm stopped), so I'm not running(, and ${NAME} needs me)?\. (Set me to running|\*\*My owner has to set me to running\*\*) in Switch to bring me back\.$`,
  ),
  new RegExp(
    String.raw`^My machine, ${BOLD}, is offline or reconnecting to Switch, so I can't answer right now\. If I haven't answered once it's back, address me again\. If it stays offline, ${OWNER} needs to check it\.$`,
  ),
  new RegExp(String.raw`^My machine, ${BOLD}, was asleep and is starting now\. I'll pick this up as soon as it's back, usually within a few minutes\.$`),
  new RegExp(String.raw`^My machine, ${BOLD}, is stopped, so I can't answer\. ${OWNER} can start it again in Switch Console\.$`),
  new RegExp(
    String.raw`^(${NAME} — )?[Mm]y machine, ${BOLD}, has been removed from Switch, so nothing runs me\. My owner has to move me to another machine to bring me back\.$`,
  ),
  new RegExp(String.raw`^I hold a role in this room, but the session that assumed it is active in ${BOLD}(?:, ${BOLD})* right now — I'll pick this up when it reconnects here\.$`),
  /^🎭 (assumed|released) the `[\w.-]+` role\.$/,
  /^Hi! I'm [\w.-]+ — how can I help\?$/,
  new RegExp(
    String.raw`^(Hey there! Tag ${NAME} if you need me\.|Hi! Mention ${NAME} to get my attention\.|Hello! I'm ready — just tag ${NAME} when you need me\.|Hey! Ping ${NAME} and I'll jump in\.|Hi! I'm here to help — mention ${NAME} anytime\.|Hello! Tag ${NAME} to loop me in\.|Hey! I'm on standby — ${NAME} to get started\.|Hi there! Just ${NAME} me when you're ready\.)$`,
  ),
];

/**
 * What Switch's admin posts when someone tags a role with no live holder (clients/mention_warnings.py). It tags whoever wrote,
 * which would read as someone unlinked asking that agent, and a stranger asking raises the next hold to two approvers.
 * Only from that sender, so nobody else's words count as this.
 */
const UNHELD_ROLE = new RegExp(
  String.raw`^⚠️ ${NAME} no agent currently holds the ${BOLD} role — your message may go unanswered\. Run \`!roles\` to see availability, or have an agent assume it\.$`,
);

/** Its other warning, for tagging an agent that isn't in the room. A label there is a display name, with the name itself in backticks. */
const ABSENT_LABEL = String.raw`\*\*[\w .-]+(?: \(\`[\w.-]+\`\))?\*\*`;
const ABSENT_AGENT = new RegExp(
  String.raw`^⚠️ ${NAME} ${ABSENT_LABEL}(?:, ${ABSENT_LABEL})* (?:isn't|aren't) in this room, so your message won't reach (?:it|them)\. Add the agent from the room's detail page in the gateway, or have an agent with room-management tools invite it\.$`,
);

/** Either warning: the admin talking about a message, and nobody asking anyone for anything. */
export function isMentionWarning(sender: string, body: string): boolean {
  const text = body.trim();
  return sender.startsWith("@switch-admin:") && (UNHELD_ROLE.test(text) || ABSENT_AGENT.test(text));
}

/** Switch puts `@whoever ` in front of a reply that doesn't already name them. */
const LEADING_MENTION = new RegExp(String.raw`^${NAME} `);

export function isSwitchNotice(body: string): boolean {
  const text = body.trim();
  const unaddressed = text.replace(LEADING_MENTION, "");
  return NOTICES.some((notice) => notice.test(text) || notice.test(unaddressed));
}
