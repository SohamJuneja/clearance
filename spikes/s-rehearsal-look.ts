/** Reads p01's room after a rehearsal, to see what a participant saw. Synthetic content only. */
import { join } from "node:path";
import { loadStudyAccounts } from "../study/lib/accounts";
import { DATA_DIR, MATTERMOST_URL, say } from "./lib.js";

const accounts = loadStudyAccounts(join(DATA_DIR, "study-accounts.json"));
const person = accounts.participants.p01!;
const login = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ login_id: person.mattermostUser, password: person.oneTimePassword }),
});
const token = login.headers.get("token")!;
const res = await fetch(`${MATTERMOST_URL}/api/v4/channels/${person.channelId}/posts?per_page=200`, { headers: { authorization: `Bearer ${token}` } });
const { order, posts } = (await res.json()) as { order: string[]; posts: Record<string, { id: string; message: string; type: string; props: { attachments?: { actions?: { name: string }[] }[] } }> };
const all = order.map((id) => posts[id]!).reverse();

const titleOf = (message: string) => message.split("\n").find((line) => line && !line.startsWith("@") && !line.startsWith("**")) ?? "";
const titles = all.filter((post) => /request `A\d+`/.test(post.message)).map((post) => titleOf(post.message));
const repeated = [...new Set(titles.filter((title, index) => titles.indexOf(title) !== index))];
say(`titles on more than one card: ${JSON.stringify(repeated.map((title) => title.slice(0, 70)))}`);
say(`plain posts from the room, oldest first:`);
for (const post of all) {
  if (/request `A\d+`/.test(post.message) || post.type) continue;
  say(`  ${JSON.stringify(post.message.slice(0, 110))}`);
}
const show = (label: string, match: (message: string) => boolean) => {
  const post = all.find((entry) => /request `A\d+`/.test(entry.message) && match(entry.message));
  if (!post) return say(`${label}: none`);
  say(`\n--- ${label} (${Array.from(post.message).length} chars)\n${post.message}`);
};
show("first card (consent), as answered", (message) => message.includes("Before we start"));
show("a confidence card", (message) => message.includes("How confident"));
show("an answered Clearance card", (message) => message.includes("Chosen by") && message.includes("CLR-"));
show("an answered type-to-confirm card", (message) => message.includes("CLR-") && message.includes("Questions") === false && message.includes("Answered"));
await fetch(`${MATTERMOST_URL}/api/v4/users/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
