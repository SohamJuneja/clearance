/**
 * Registration, once and out of band. The credential is a personal registration key of whoever should
 * own the agent: the agent's owner is the user the key belongs to. Never the deployment's shared
 * AGENT_REGISTRATION_TOKEN for Clearance, which resolves to a bootstrap owner other agents may share.
 */
import { SwitchApiError } from "./agent.js";

export type RegisterAgentInput = {
  bridgeUrl: string;
  registrationKey: string;
  name: string;
  displayName?: string;
  description: string;
  /** Re-registering rotates the API key. Switch refuses it when another owner holds the name. */
  overwrite?: boolean;
  fetch?: typeof fetch;
};

export type RegisteredAgent = { agentId: string; apiKey: string };

/** A protocol agent that is reachable whenever its service runs, in every room it belongs to. */
const ALWAYS_ON_PROFILE = {
  connection_model: "always_on",
  message_exchange: true,
  pre_invocation_mediation: [],
  post_invocation_mediation: [],
  event_reporting: [],
} as const;

export async function registerAgent(input: RegisterAgentInput): Promise<RegisteredAgent> {
  const doFetch = input.fetch ?? fetch;
  const path = "/agents";
  const res = await doFetch(`${input.bridgeUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.registrationKey}` },
    body: JSON.stringify({
      name: input.name,
      display_name: input.displayName ?? null,
      description: input.description,
      connector_type: "external",
      integration_profile: ALWAYS_ON_PROFILE,
      overwrite: input.overwrite ?? false,
    }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the text is the detail.
  }
  if (!res.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : body;
    throw new SwitchApiError(res.status, path, detail);
  }
  const { id, api_key: apiKey } = body as { id: string; api_key: string };
  return { agentId: id, apiKey };
}
