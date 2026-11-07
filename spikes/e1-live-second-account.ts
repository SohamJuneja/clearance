/**
 * A second real chat account for Sam, so case 10 of `pnpm eval:authority --live` has what it's about: two accounts linked
 * to one Switch user. It's a real Mattermost account, joined to #support, and it's really linked to Sam's Switch user,
 * through the claim and confirm that scripts/setup-identities.ts uses for everyone. Core then learns it the way it learns
 * anyone's: from data/identities.json, at its next start. Prints no credential.
 *
 *   pnpm exec tsx spikes/e1-live-second-account.ts up     create and link it, and add it to data/identities.json and data/secrets.json
 *   pnpm exec tsx spikes/e1-live-second-account.ts down   drop the link, deactivate the account, and remove those entries
 *
 * It exists for one run. Nothing else needs it, and scripts/clear-leftovers.ts clears the name if a run dies before `down`.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAM_SECOND_ACCOUNT as NAME } from "../eval/authority-suite/live-cases.ts";
import { Persona } from "../eval/lib/persona.ts";
import { readDotenv, rootEnv, ROOT } from "../scripts/gateway-owner.ts";
import {
  BRIDGE_URL,
  call,
  EMAIL_DOMAIN,
  ensureAccessToken,
  ensureMattermostAccount,
  expectOk,
  gatewayLogin,
  linkAccount,
  type Linked,
  MATTERMOST_URL,
  mattermostLogin,
} from "../scripts/lib-provisioning.ts";

const TEAM = "switch";
const secretsPath = join(ROOT, "data/secrets.json");
const identitiesPath = join(ROOT, "data/identities.json");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const write = (path: string, value: unknown) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

/** Switch's id for a Mattermost account names the bridge and the username, so Sam's own says what this one's will be. */
function participantsFor(): { bridgeId: string; second: string } {
  const sam = (read(identitiesPath).people?.sam?.participantIds as string[] | undefined)?.[0];
  const match = sam ? /^@switch-mattermost-(.+)-sam:localhost$/.exec(sam) : null;
  if (!match?.[1]) throw new Error("Sam's participant id doesn't have the expected form, so this one can't be worked out");
  return { bridgeId: match[1], second: `@switch-mattermost-${match[1]}-${NAME}:localhost` };
}

async function mattermostAdmin(): Promise<string> {
  const env = readDotenv(join(ROOT, "vendor/switch/.env"));
  const user = env.MATTERMOST_ADMIN_USER;
  const password = env.MATTERMOST_ADMIN_PASSWORD;
  if (!user || !password) throw new Error("no Mattermost admin in vendor/switch/.env");
  return mattermostLogin(user, password);
}

const samCookie = (): Promise<string> =>
  gatewayLogin(`sam@${EMAIL_DOMAIN}`, rootEnv().PERSONA_PASSWORD ?? "");

function supportChannel(): Promise<{ id: string }> {
  const priya = Persona.fromSecrets("priya", { baseUrl: MATTERMOST_URL, secretsPath });
  return priya.channel("support");
}

async function up(): Promise<void> {
  const { bridgeId, second } = participantsFor();
  const admin = await mattermostAdmin();
  const team = expectOk(await call(MATTERMOST_URL, "GET", `/api/v4/teams/name/${TEAM}`, { token: admin }), "reading the team");
  const password = `${randomBytes(18).toString("base64url")}aA1!`;
  // A run's `down` deactivates it rather than erasing it, so the next run brings it back.
  const earlier = await call(MATTERMOST_URL, "GET", `/api/v4/users/username/${NAME}`, { token: admin });
  if (earlier.status === 200 && (earlier.body as { delete_at?: number }).delete_at) {
    const earlierId = (earlier.body as { id: string }).id;
    expectOk(
      await call(MATTERMOST_URL, "PUT", `/api/v4/users/${earlierId}/active`, { token: admin, json: { active: true } }),
      "reactivating it",
    );
  }
  const userId = await ensureMattermostAccount(admin, String(team.id), NAME, password);
  // It may outlive an earlier run that died, and then this run has no password for it.
  expectOk(
    await call(MATTERMOST_URL, "PUT", `/api/v4/users/${userId}/password`, { token: admin, json: { new_password: password } }),
    "setting its password",
  );
  const channel = await supportChannel();
  expectOk(
    await call(MATTERMOST_URL, "POST", `/api/v4/channels/${channel.id}/members`, { token: admin, json: { user_id: userId } }),
    "joining #support",
  );
  const cookie = await samCookie();
  await linkAccount(cookie, bridgeId, NAME, userId, password);
  const token = await ensureAccessToken(admin, NAME, userId, undefined);

  const secrets = read(secretsPath);
  secrets.mattermostTokens = { ...secrets.mattermostTokens, [NAME]: token };
  write(secretsPath, secrets);
  const identities = read(identitiesPath);
  const ids = identities.people.sam.participantIds as string[];
  if (!ids.includes(second)) ids.push(second);
  write(identitiesPath, identities);
  // Core reads who's who at its start, and this says nothing to it until then.
  console.log(`${NAME} is a real account, in #support and linked to Sam's Switch user`);
}

async function down(): Promise<void> {
  const { bridgeId, second } = participantsFor();
  const admin = await mattermostAdmin();
  const found = await call(MATTERMOST_URL, "GET", `/api/v4/users/username/${NAME}`, { token: admin });
  if (found.status === 200) {
    const userId = String((found.body as { id: string }).id);
    const cookie = await samCookie();
    const mine = await call(BRIDGE_URL, "GET", "/gateway/auth/me/identities", { cookie });
    const link = (mine.body as Linked[]).find(
      (identity) => identity.bridge_id === bridgeId && identity.external_user_id === userId,
    );
    if (link) {
      const released = await call(
        BRIDGE_URL,
        "DELETE",
        `/gateway/collaborations/${bridgeId}/identities/${link.id}`,
        { cookie },
      );
      console.log(`released the link to Sam: HTTP ${released.status}`);
    }
    const channel = await supportChannel();
    await call(MATTERMOST_URL, "DELETE", `/api/v4/channels/${channel.id}/members/${userId}`, { token: admin });
    // Deactivated, not erased: Mattermost keeps a user's posts, and what it typed is part of the record.
    const gone = await call(MATTERMOST_URL, "DELETE", `/api/v4/users/${userId}`, { token: admin });
    console.log(`deactivated ${NAME}: HTTP ${gone.status}`);
  }
  const secrets = read(secretsPath);
  delete secrets.mattermostTokens?.[NAME];
  write(secretsPath, secrets);
  const identities = read(identitiesPath);
  identities.people.sam.participantIds = (identities.people.sam.participantIds as string[]).filter((id) => id !== second);
  write(identitiesPath, identities);
}

const what = process.argv[2];
if (what === "up") await up();
else if (what === "down") await down();
else throw new Error("usage: e1-live-second-account.ts up|down");
