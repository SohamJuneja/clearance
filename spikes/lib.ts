/**
 * Shared helpers for the switchboard spikes. Everything here reads data/identities.json and
 * data/secrets.json and never prints a secret. Spike code, not product code (PLAN 4.7).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSwitchAgent, type SwitchAgent, type SwitchAgentHandlers } from "../packages/switch-agent/src/agent.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = resolve(process.env.CLEARANCE_DATA_DIR ?? join(HERE, "..", "data"));
export const BRIDGE_URL = (process.env.SWITCH_BRIDGE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
export const MATTERMOST_URL = (process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065").replace(/\/$/, "");
const FIXTURE_DIR = join(HERE, "..", "packages", "switch-agent", "test", "fixtures");

export type Identities = {
  people: Record<
    string,
    {
      switchUserId: string;
      participantIds: string[];
      mattermostUser: string;
      mattermostUserId: string;
      externalUserRowId: string;
    }
  >;
  unlinked: Record<string, { participantIds: string[]; mattermostUser: string; mattermostUserId: string }>;
  agents: Record<string, { switchAgentId: string; participantId: string; ownerUserId: string }>;
  bridgeId: string;
  mattermostTeam: string;
};
export type Secrets = {
  mattermostTokens: Record<string, string>;
  switchAgentKeys: Record<string, string>;
  clearanceAdminPassword: string;
};

export const identities = JSON.parse(readFileSync(join(DATA_DIR, "identities.json"), "utf8")) as Identities;
export const secrets = JSON.parse(readFileSync(join(DATA_DIR, "secrets.json"), "utf8")) as Secrets;

export function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

export function clearanceAgent(): SwitchAgent {
  return createSwitchAgent({
    bridgeUrl: BRIDGE_URL,
    agentId: identities.agents.clearance!.switchAgentId,
    apiKey: secrets.switchAgentKeys.clearance!,
  });
}

/** Records frames as they arrive, and lets a spike wait on them. */
export class Frames {
  readonly all: { name: string; data: Record<string, unknown>; at: number }[] = [];
  readonly handler: NonNullable<SwitchAgentHandlers["frame"]> = (name, data) => {
    this.all.push({ name, data: data as Record<string, unknown>, at: Date.now() });
  };
  waitFor(what: string, match: (name: string, data: Record<string, unknown>) => boolean, ms = 20_000) {
    return waitFor(what, () => this.all.find((frame) => match(frame.name, frame.data)), ms);
  }
}

/** A persona's hands: the Mattermost REST API, authenticated with that persona's access token. */
export function mattermost(persona: string) {
  const token = secrets.mattermostTokens[persona];
  if (!token) throw new Error(`no access token for ${persona}`);
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await fetch(`${MATTERMOST_URL}/api/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON.
    }
    return { status: res.status, body: body as Record<string, unknown> };
  };
  return {
    call,
    async post(channelId: string, message: string, rootId?: string) {
      const res = await call("POST", "/posts", { channel_id: channelId, message, root_id: rootId ?? "" });
      if (res.status !== 201) throw new Error(`${persona} could not post: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as { id: string };
    },
    async press(postId: string, actionId: string) {
      return call("POST", `/posts/${postId}/actions/${actionId}`, {});
    },
    async posts(channelId: string) {
      const res = await call("GET", `/channels/${channelId}/posts?per_page=200`);
      const body = res.body as unknown as { order: string[]; posts: Record<string, MattermostPost> };
      return body.order.map((id) => body.posts[id]!);
    },
  };
}

export type MattermostPost = {
  id: string;
  channel_id: string;
  root_id: string;
  user_id: string;
  message: string;
  type: string;
  props: Record<string, unknown> & {
    attachments?: { text?: string; title?: string; actions?: { id: string; name: string; type?: string }[] }[];
  };
};

/** The channel a Switch room lives in, seen from a persona who is a member of it. */
export async function channelOfRoom(
  persona: string,
  channelName: string,
): Promise<{ id: string; name: string; type: string; display_name: string }> {
  const team = identities.mattermostTeam;
  const hands = mattermost(persona);
  const res = await hands.call("GET", `/teams/name/${team}/channels/name/${channelName}?include_deleted=false`);
  if (res.status !== 200) throw new Error(`${persona} cannot see channel ${channelName}: ${res.status}`);
  return res.body as unknown as { id: string; name: string; type: string; display_name: string };
}

const TOKEN_LIKE = /[A-Za-z0-9_-]{32,}/g;

/** Writes a frame recorded off the live stack into the package's test fixtures. */
export function writeFixture(name: string, frame: unknown): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const text = JSON.stringify(frame, null, 2);
  for (const token of [...Object.values(secrets.mattermostTokens), ...Object.values(secrets.switchAgentKeys)]) {
    if (text.includes(token)) throw new Error(`fixture ${name} would contain a credential`);
  }
  const suspicious = text.match(TOKEN_LIKE)?.filter((match) => !/^[0-9a-f-]+$/.test(match) && !match.includes("switch-mattermost"));
  if (suspicious?.length) say(`fixture ${name}: review ${suspicious.length} long tokens before committing`);
  writeFileSync(join(FIXTURE_DIR, `${name}.json`), `${text}\n`);
  say(`recorded fixture ${name}`);
}
