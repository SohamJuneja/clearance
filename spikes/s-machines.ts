/** Read only: whose machines exist, which agents exist, and is the name `support` free on Mattermost? */
import { readFileSync } from "node:fs";
import { BRIDGE_URL, identities, mattermost, say } from "./lib.js";

const env = Object.fromEntries(
  readFileSync(process.env.SWITCH_ENV_FILE!, "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BRIDGE_URL}/gateway/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login as ${email}: ${res.status}`);
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}
const get = async (path: string, cookie: string) => {
  const res = await fetch(`${BRIDGE_URL}/gateway${path}`, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as unknown };
};

const admin = await login(env.GATEWAY_ADMIN_EMAIL!, env.GATEWAY_ADMIN_PASSWORD!);
const alex = await login("alex@clearance.example", process.env.PERSONA_PASSWORD!);
const summary = (body: unknown) =>
  JSON.stringify(
    (Array.isArray(body) ? body : ((body as { controllers?: unknown[] }).controllers ?? [])).map((entry) => {
      const machine = entry as Record<string, unknown>;
      return { id: machine.id, name: machine.name, state: machine.state ?? machine.status, owner: machine.owner_id };
    }),
  );
for (const path of ["/management/controllers", "/controllers", "/machines"]) {
  const asAdmin = await get(path, admin);
  say(`${path} as the gateway admin: HTTP ${asAdmin.status} ${asAdmin.status === 200 ? summary(asAdmin.body) : ""}`);
  const asAlex = await get(path, alex);
  say(`${path} as Alex: HTTP ${asAlex.status} ${asAlex.status === 200 ? summary(asAlex.body) : ""}`);
}
const agents = await get("/agents", admin);
const list = (Array.isArray(agents.body) ? agents.body : ((agents.body as { agents?: unknown[] }).agents ?? [])) as {
  name: string;
  owner_name?: string;
  owner_id?: string;
}[];
say(`agents: ${JSON.stringify(list.map((agent) => ({ name: agent.name, owner: agent.owner_name ?? agent.owner_id })))}`);
const sam = mattermost("sam");
for (const name of ["support", "finance", "eng", "approvals"]) {
  const channel = await sam.call("GET", `/teams/name/${identities.mattermostTeam}/channels/name/${name}?include_deleted=true`);
  say(`mattermost channel ${name}: HTTP ${channel.status} delete_at=${String(channel.body.delete_at ?? "-")}`);
}
