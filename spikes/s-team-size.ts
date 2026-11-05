/** Who fills the team? Mattermost refuses new members past TeamSettings.MaxUsersPerTeam. Names and counts only. */
import { identities, mattermost, say } from "./lib.js";

const sam = mattermost("sam");
const team = await sam.call("GET", `/teams/name/${identities.mattermostTeam}`);
const stats = await sam.call("GET", `/teams/${String(team.body.id)}/stats`);
say(`stats: ${JSON.stringify(stats.body)}`);
const people: { username: string; is_bot?: boolean; delete_at?: number }[] = [];
for (let page = 0; page < 10; page += 1) {
  const res = await sam.call("GET", `/users?in_team=${String(team.body.id)}&per_page=100&page=${page}`);
  const batch = res.body as unknown as typeof people;
  if (!Array.isArray(batch) || batch.length === 0) break;
  people.push(...batch);
}
const bots = people.filter((person) => person.is_bot);
say(`members listed: ${people.length}, bots: ${bots.length}, humans: ${people.length - bots.length}`);
say(`bots: ${bots.map((bot) => bot.username).sort().join(" ")}`);
say(`humans: ${people.filter((person) => !person.is_bot).map((person) => person.username).sort().join(" ")}`);
