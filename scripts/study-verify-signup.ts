/**
 * Proves anonymous signup is off on a Mattermost, through its API, or exits non-zero.
 *
 *   tsx scripts/study-verify-signup.ts http://127.0.0.1:8065
 *
 * Reads the public config first, and only tries a real signup once that says it is off, so this cannot
 * create an account on an open server unless the config is lying. If it does, that account is removed
 * and the check fails. A participant can read their team's invite id, so a signup through that link is
 * tried too. Prints no credential.
 */
import { randomBytes } from "node:crypto";
import { attemptProblem, configProblem, type SignupAttempt } from "../study/lib/exposure";
import { SWITCH_ENV_FILE, call, fail, mattermostLogin, need, readEnvFile } from "./lib-provisioning.js";

async function attempt(base: string, query: string): Promise<SignupAttempt & { userId?: string }> {
  const tag = randomBytes(6).toString("hex");
  const res = await call(base, "POST", `/api/v4/users${query}`, {
    // Well formed, with a strong password, so that signup being off is the only reason to refuse it.
    json: { username: `signup-probe-${tag}`, email: `signup-probe-${tag}@clearance.example`, password: `${randomBytes(18).toString("base64url")}aA1!` },
  });
  const body = (res.body ?? {}) as { id?: string };
  return { status: res.status, id: body.id, userId: res.status < 300 ? body.id : undefined };
}

async function main(): Promise<void> {
  const base = (process.argv[2] ?? fail("usage: study-verify-signup.ts <mattermost url>")).replace(/\/$/, "");

  const config = await call(base, "GET", "/api/v4/config/client?format=old");
  if (config.status !== 200) fail(`could not read the public config from ${base}: HTTP ${config.status}`);
  const problem = configProblem(config.body as Record<string, unknown>);
  if (problem) fail(`signup is not off at ${base}: ${problem}`);
  process.stdout.write("public config: signup settings all off\n");

  const env = readEnvFile(SWITCH_ENV_FILE);
  // Local on purpose, whatever is being checked: the admin password does not go over the tunnel.
  const admin = await mattermostLogin(need(env, "MATTERMOST_ADMIN_USER"), need(env, "MATTERMOST_ADMIN_PASSWORD"));
  const local = process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065";
  const team = await call(local, "GET", `/api/v4/teams/name/${need(env, "MATTERMOST_TEAM_NAME")}`, { token: admin });
  const inviteId = (team.body as { invite_id?: string }).invite_id;

  const attempts: [string, string][] = [["anonymous signup", ""]];
  if (inviteId) attempts.push(["signup through the team's invite link", `?iid=${inviteId}`]);
  for (const [what, query] of attempts) {
    const result = await attempt(base, query);
    if (result.userId) {
      await call(local, "DELETE", `/api/v4/users/${result.userId}`, { token: admin });
      fail(`${what} SUCCEEDED at ${base}. The account was removed. Do not expose this server.`);
    }
    const refused = attemptProblem(result);
    if (refused) fail(`${what} at ${base}: ${refused}`);
    process.stdout.write(`${what}: refused (HTTP ${result.status}, ${String(result.id)})\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`study-verify-signup: ${(error as Error).message}\n`);
  process.exit(1);
});
