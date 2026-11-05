/** Does a one-time password stop working when retired, and work again after a reset? Prints statuses only. */
import { join } from "node:path";
import { loadStudyAccounts } from "../study/lib/accounts";
import { DATA_DIR, MATTERMOST_URL, say } from "./lib.js";

const person = loadStudyAccounts(join(DATA_DIR, "study-accounts.json")).participants[process.argv[2] ?? "p03"]!;
const login = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ login_id: person.mattermostUser, password: person.oneTimePassword }),
});
say(`${person.mattermostUser} logs in: HTTP ${login.status}, retired in the file: ${person.retired}`);
const token = login.headers.get("token");
if (token) await fetch(`${MATTERMOST_URL}/api/v4/users/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
