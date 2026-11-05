/** Builds what a card says for one audience, from the request and the routing trace. No IO. */
import type { Vendor } from "@clearance/contracts";
import type { Directory } from "../people/directory.js";
import type { RequestRecord } from "../requests/store.js";
import type { RouteTrace } from "../router/router.js";
import { whyCopy, whyFallback, whyYou } from "../router/why.js";
import { formatClockWithZone } from "../time.js";
import type { CallDescription } from "./describe.js";
import type { CardView } from "./render.js";

const VENDOR_NAMES: Record<Vendor, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor CLI",
  antigravity: "Antigravity",
  gate: "through the gate",
};

export type CardEvidence = {
  description: CallDescription;
  agentOwnerIds: string[];
  policySubject?: string;
  agentClaim?: string;
};

export type Audience = { kind: "person"; id: string } | { kind: "room" } | { kind: "fallback" };

function personWithGroup(directory: Directory, id: string): string {
  const person = directory.person(id);
  if (!person) return "an unlinked account";
  return person.groups[0] ? `${person.name} (${person.groups[0]})` : person.name;
}

function whyFor(trace: RouteTrace, audience: Audience): string {
  if (audience.kind === "person") return whyYou(trace, audience.id);
  return audience.kind === "fallback" ? whyFallback(trace) : whyCopy(trace);
}

export function buildCardView(input: {
  request: RequestRecord;
  evidence: CardEvidence;
  trace: RouteTrace;
  audience: Audience;
  directory: Directory;
  reversible: boolean | undefined;
  tz: string;
}): CardView {
  const { request, evidence, trace, audience, directory } = input;
  const vendor = directory.agentVendor(request.agent) ?? request.vendor;
  const quorum = request.quorumRequired;
  const subject = evidence.policySubject ?? "protected calls with no rule";
  const approvers = trace.label === "approver" ? "approver" : `${trace.label} approver`;
  return {
    id: request.id,
    headline: evidence.description.headline,
    tier: request.tier,
    reversible: input.reversible,
    call: evidence.description.call,
    context: evidence.description.context,
    flags: request.flags.map((flag) => flag.text),
    claim: evidence.agentClaim,
    askedBy: request.requesterIds.map((id) => personWithGroup(directory, id)),
    agent: request.agent,
    vendor: VENDOR_NAMES[vendor],
    owners: evidence.agentOwnerIds.map((id) => directory.person(id)?.name ?? id),
    whyLabel: audience.kind === "person" ? "Why you" : "Why here",
    why: whyFor(trace, audience),
    policyLine: `${subject} need ${quorum} ${approvers}${quorum === 1 ? "" : "s"}`,
    expires: formatClockWithZone(request.expiresAtMs, input.tz),
  };
}
