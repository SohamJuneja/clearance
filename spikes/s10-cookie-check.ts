/** Which attributes does Mattermost put on its session cookies? Prints names and attributes, never values. */
import { join } from "node:path";
import { loadStudyAccounts } from "../study/lib/accounts";
import { DATA_DIR, say } from "./lib.js";

const base = process.argv[2] ?? "http://127.0.0.1:8065";
const person = loadStudyAccounts(join(DATA_DIR, "study-accounts.json")).participants.p03!;
const login = await fetch(`${base}/api/v4/users/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
  body: JSON.stringify({ login_id: person.mattermostUser, password: person.oneTimePassword }),
});
say(`login at ${base}: HTTP ${login.status}`);
for (const cookie of login.headers.getSetCookie()) {
  const [pair, ...attributes] = cookie.split("; ");
  say(`  ${pair!.split("=")[0]}: ${attributes.filter((attribute) => !/^(Expires|Max-Age)=/i.test(attribute)).join("; ")}`);
}
const token = login.headers.get("token");
if (token) await fetch(`${base}/api/v4/users/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
