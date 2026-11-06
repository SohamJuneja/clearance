/**
 * Each person says one short thing to Clearance in their own direct room. Switch can only name an approver on a card
 * once that person has written in that room, or the card says "Nobody here is linked to this agent's owner". So every
 * take starts with this. These are the people's words, which scenes are allowed to script.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PEOPLE = ["priya", "sam", "neha", "alex", "dev"] as const;
const CLEARANCE = "clearance";

export type GreetOptions = {
  mattermostUrl: string;
  tokens: Record<string, string>;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
};

export function personaTokens(root: string): Record<string, string> {
  const secrets = JSON.parse(readFileSync(join(root, "data/secrets.json"), "utf8")) as { mattermostTokens: Record<string, string> };
  return secrets.mattermostTokens;
}

/** Throws naming the person if anyone could not say it, because the card would then read wrong on camera. */
export async function greetClearance(options: GreetOptions): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.mattermostUrl.replace(/\/$/, "");
  for (const person of PEOPLE) {
    const token = options.tokens[person];
    if (!token) throw new Error(`no Mattermost token for ${person}: run scripts/setup-identities.ts`);
    const call = async (method: string, path: string, json?: unknown): Promise<{ id: string }> => {
      const res = await doFetch(`${base}/api/v4${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      if (!res.ok) throw new Error(`${person} could not say hello to Clearance: ${method} ${path} answered ${res.status}`);
      return (await res.json()) as { id: string };
    };
    const me = await call("GET", "/users/me");
    const clearance = await call("GET", `/users/username/${CLEARANCE}`);
    const direct = await call("POST", "/channels/direct", [me.id, clearance.id]);
    await call("POST", "/posts", { channel_id: direct.id, message: "hello" });
  }
  options.log?.(`said hello to Clearance as ${PEOPLE.join(", ")}`);
}
