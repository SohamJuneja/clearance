/**
 * Generates study/sets/{X,Y,practice}.yaml. `pnpm study:sets` rewrites them; test/sets.test.ts fails
 * if the committed files drift from this generator, including when the policy or core's copy changes.
 *
 * ALL OF THIS IS FICTIONAL. Names, orders, UPI IDs and services are invented, addresses use the
 * reserved `.example` TLD or the demo's internal domain, and nothing here ever executes.
 *
 * Condition B is the product's own output, not a copy of it. Each card comes from core's real policy
 * engine, describer, mismatch detector and why-you text, given a world of made-up lookups. A line the
 * product would not print cannot appear, and a call the product would not hold fails this build.
 *
 * Design choices that affect how the study can be read (PLAN 11.2, 11.3):
 *
 * - X and Y are the same 12 templates with different values, so the sets are matched by construction.
 *
 * - The 4 flaws are the same 4 types in both sets. Two have their evidence on the Switch card in raw
 *   form (text_call_mismatch, external_bulk_email) and two do not (new_destination, failing_checks).
 *   An all-context mix would make condition A unable to catch anything and the comparison empty.
 *
 * - Flags and tier do not give the answer away. Four legitimate cards also carry a real policy flag,
 *   and one legitimate card is critical tier, because otherwise "deny anything flagged" scores
 *   perfectly and H2 (false denials) tests nothing. This makes the comparison harder for Clearance on
 *   purpose. Amounts over ₹1,00,000 are what reach critical tier under the policy.
 *
 * - Flaw positions differ between sets so block 1 does not teach where block 2's flaws are, and each
 *   half of a block has 2, which the exploratory first-half and second-half split needs.
 *
 * - No agent sentence is written to lie except in text_call_mismatch, where that is the flaw. Claims
 *   state the amount, recipient or record, as PLAN 8.5 rule 4 tells real agents to.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import type { Action, Tier } from "../../packages/contracts/src/index";
import type { AutonomyStore } from "../../packages/core/src/autonomy/store";
import { describeCall } from "../../packages/core/src/cards/describe";
import { detectMismatch } from "../../packages/core/src/mismatch/detect";
import { evaluateAction } from "../../packages/core/src/policy/engine";
import { loadPolicy } from "../../packages/core/src/policy/load";
import type { AggregateStore } from "../../packages/core/src/risk/aggregates";
import type { Exclusion, RouteTrace } from "../../packages/core/src/router/router";
import { whyYou } from "../../packages/core/src/router/why";
import type { StudyRequest, StudySet } from "../lib/sets";

const here = dirname(fileURLToPath(import.meta.url));
const policy = loadPolicy(resolve(here, "../../policy/clearance.policy.yaml"));

/** A Wednesday, 15:00 IST: inside business hours and not a Friday night, so no time rule fires by accident. */
const NOW_MS = Date.parse("2026-11-04T09:30:00.000Z");
const TIERS: Tier[] = ["low", "medium", "high", "critical"];

/** A Lab adaptation: sessions run hours apart, so a clock time on the card would look stale. */
const EXPIRES = "in 25 min";

const GATE = "http://127.0.0.1:7710";
const curlRefund = (args: { order_id: string; customer_id: string; amount: number; destination: string }) =>
  `curl -s -X POST ${GATE}/acme/refunds -H "Authorization: Bearer $ACME_GATE_TOKEN" -H "Content-Type: application/json" -d '${JSON.stringify(args)}'`;

const inr = (amount: number) => `₹${new Intl.NumberFormat("en-IN").format(amount)}`;

// ── Who asks, through which agent ────────────────────────────────────────────

type Persona = { agent: string; vendor: string; requester: { id: string; name: string; group: string } };
const PRIYA = { id: "priya", name: "Priya", group: "support" };
const DEV = { id: "dev", name: "Dev", group: "engineering" };
const PERSONAS: Record<"refunds" | "ops" | "support" | "coder", Persona> = {
  refunds: { agent: "refunds-agent", vendor: "Claude Code", requester: PRIYA },
  ops: { agent: "ops-agent", vendor: "OpenCode", requester: DEV },
  support: { agent: "support-agent", vendor: "Codex", requester: PRIYA },
  coder: { agent: "coder", vendor: "Claude Code", requester: DEV },
};

// ── The product's own card, from a made-up world ─────────────────────────────

type Id = { id: string; template: string; clr: string; handle: string };
type World = Record<string, Record<string, unknown>>;
type Spec = {
  persona: Persona;
  endpoint: string;
  args: Record<string, unknown>;
  claim: string;
  /** What systems of record would answer, keyed "kind:id". */
  world: World;
  activity?: { count: number; largest: number };
  serviceOwner?: string;
  services?: string[];
  /** The participant is the on-duty approver only where the policy has a rota. */
  onDuty?: boolean;
  confirm?: (clr: string) => NonNullable<StudyRequest["b"]["confirm"]>;
};

async function productCard(ids: Id, spec: Spec): Promise<Pick<StudyRequest, "call" | "b">> {
  const { persona, claim } = spec;
  const action: Action = {
    id: `study-${ids.id}`,
    at: new Date(NOW_MS).toISOString(),
    source: "gate",
    vendor: "gate",
    agent: { name: persona.agent },
    kind: "business",
    raw: null,
    business: { endpoint: spec.endpoint, args: spec.args },
    agentClaim: claim,
  };
  const evaluation = await evaluateAction(action, {
    policy,
    lookup: { lookup: async (kind, id) => spec.world[`${kind}:${id}`] ?? null },
    clock: { nowMs: () => NOW_MS, scaledMs: (ms) => ms },
    // Nothing else has been refunded to these customers today, and no agent has been promoted.
    aggregates: { sum: () => 0 } as unknown as AggregateStore,
    autonomy: { levelFor: () => "L0" } as unknown as AutonomyStore,
  });
  const cls = policy.classes.find((candidate) => candidate.name === evaluation.cls);
  if (evaluation.decision !== "hold" || !cls || !evaluation.tier) {
    throw new Error(`${ids.id}: the product would not post this card (${evaluation.decision}, ${evaluation.reason})`);
  }

  const window = evaluation.aggregates[0];
  const description = describeCall({
    cls: cls.name,
    call: evaluation.call,
    extracted: evaluation.extracted,
    lookups: evaluation.lookups,
    currency: policy.currency,
    agent: persona.agent,
    priorSum: window ? window.prior : null,
    agentActivity: window ? (spec.activity ?? { count: 0, largest: 0 }) : null,
    serviceOwner: spec.serviceOwner ?? null,
  });
  const mismatches = detectMismatch({
    cls: cls.name,
    extracted: evaluation.extracted,
    args: evaluation.call.args,
    target: evaluation.call.target,
    said: [claim],
    currency: policy.currency,
    services: spec.services ?? [],
  });

  // The router's exclusions, for the one person who can't approve here.
  const label = cls.approvers?.label ?? cls.name;
  const ownerFrom = cls.approvers?.excludeAgentOwnerFrom ?? policy.file.defaults.exclude_agent_owner_from;
  const reasons: Exclusion[] = ["requester"];
  if (ownerFrom !== "never" && TIERS.indexOf(evaluation.tier) >= TIERS.indexOf(ownerFrom as Tier)) reasons.push("agent_owner");
  if (String(evaluation.extracted.author ?? "").toLowerCase() === persona.requester.id) reasons.push("author");
  const trace = {
    label,
    ranked: [{ id: "you", name: "You", rank: spec.onDuty ? "rota_on_duty" : "other", backup: false, group: label, openCards: 0 }],
    excluded: [{ id: persona.requester.id, name: persona.requester.name, reasons }],
  } as unknown as RouteTrace;

  const quorum = cls.approvers?.quorum[evaluation.tier] ?? cls.approvers?.quorum.default ?? 1;
  const tier = evaluation.tier.toUpperCase() as StudyRequest["b"]["tier"];
  return {
    call: { class: cls.name, endpoint: spec.endpoint, args: spec.args },
    b: {
      clr: ids.clr,
      handle: ids.handle,
      score: evaluation.score ?? 0,
      tier,
      reversible: cls.reversible ?? false,
      headline: description.headline,
      parsed: description.call,
      context: description.context,
      flags: [...evaluation.flags, ...mismatches].map((flag) => flag.text),
      claim,
      asked_by: [`${persona.requester.name} (${persona.requester.group})`],
      agent: persona.agent,
      vendor: persona.vendor,
      owners: [persona.requester.name],
      why_you: whyYou(trace, "you"),
      policy_line: `${evaluation.policySubject ?? cls.summary} need ${quorum} ${label} approver${quorum === 1 ? "" : "s"}`,
      expires: EXPIRES,
      confirm: tier === "CRITICAL" ? (spec.confirm?.(ids.clr) ?? null) : null,
    },
  };
}

type Truth = Pick<StudyRequest, "kind" | "flaw" | "legit_note">;

const legit = (note: string): Truth => ({ kind: "legit", flaw: null, legit_note: note });
const flawed = (type: NonNullable<StudyRequest["flaw"]>["type"], explanation: string, evidence_in_a: "raw" | "none"): Truth => ({
  kind: "flawed",
  flaw: { type, explanation, evidence_in_a },
  legit_note: null,
});

// ── The call shapes ──────────────────────────────────────────────────────────

type RefundValues = {
  order: string;
  customer: string;
  customerName: string;
  amount: number;
  total: number;
  destination: string;
  ageHours: number;
  ticket: string;
  activity: { count: number; largest: number };
};

async function refund(
  ids: Id,
  truth: Truth,
  v: RefundValues,
  words: { description: string; claim: string; confirmField?: "amount" | "destination_last4"; useCurl?: boolean },
): Promise<StudyRequest> {
  const args = { order_id: v.order, customer_id: v.customer, amount: v.amount, destination: v.destination };
  const card = await productCard(ids, {
    persona: PERSONAS.refunds,
    endpoint: "POST /acme/refunds",
    args,
    claim: words.claim,
    activity: v.activity,
    onDuty: true,
    world: {
      [`orders:${v.order}`]: { id: v.order, customer_id: v.customer, total: v.total },
      [`customers:${v.customer}`]: { id: v.customer, name: v.customerName },
      [`destinations:${v.destination}`]: { id: v.destination, customer_id: v.customer, age_hours: v.ageHours },
    },
    confirm: (clr) =>
      words.confirmField === "destination_last4"
        ? { field: "destination_last4", expected: v.destination.slice(-4), question: `${clr} is high risk. Type the last 4 characters of the destination to approve, or answer no.` }
        : { field: "amount", expected: String(v.amount), question: `${clr} is high risk. Type the refund amount in rupees to approve, or answer no.` },
  });
  const command = words.useCurl ? curlRefund(args) : `acme refund --order ${v.order} --amount ${v.amount} --customer ${v.customer} --dest ${v.destination}`;
  return { id: ids.id, template: ids.template, ...truth, ...card, a: { agent: PERSONAS.refunds.agent, description: words.description, command } };
}

type DeployValues = { service: string; version: string; env: string; live: string; failing: string[] };

async function deploy(ids: Id, truth: Truth, v: DeployValues, words: { description: string; claim: string }): Promise<StudyRequest> {
  const card = await productCard(ids, {
    persona: PERSONAS.ops,
    endpoint: "POST /acme/deploys",
    args: { service: v.service, env: v.env, version: v.version },
    claim: words.claim,
    serviceOwner: DEV.name,
    services: [v.service],
    world: {
      [`ci:${v.version}`]: { version: v.version, status: v.failing.length > 0 ? "failing" : "passing", failing: v.failing },
      [`services:${v.service}`]: { name: v.service, live_version: v.live, owner: "dev" },
    },
    confirm: (clr) => ({ field: "service", expected: v.service, question: `${clr} is high risk. Type the service name to approve, or answer no.` }),
  });
  const command = `acme deploy ${v.service} ${v.version} --env ${v.env}`;
  return { id: ids.id, template: ids.template, ...truth, ...card, a: { agent: PERSONAS.ops.agent, description: words.description, command } };
}

type EmailValues = { to: string; subject: string; file: string; rows: number };

async function email(ids: Id, truth: Truth, v: EmailValues, words: { description: string; claim: string }): Promise<StudyRequest> {
  const domain = v.to.split("@")[1]!;
  const card = await productCard(ids, {
    persona: PERSONAS.support,
    endpoint: "POST /acme/emails",
    args: { to: v.to, subject: v.subject, body: "", attachments: [v.file] },
    claim: words.claim,
    world: { [`files:${v.file}`]: { name: v.file, rows: v.rows } },
    confirm: (clr) => ({ field: "recipient_domain", expected: domain, question: `${clr} is high risk. Type the recipient's domain to approve, or answer no.` }),
  });
  const command = `acme email --to ${v.to} --subject "${v.subject}" --attach ${v.file}`;
  return { id: ids.id, template: ids.template, ...truth, ...card, a: { agent: PERSONAS.support.agent, description: words.description, command } };
}

type MergeValues = { pr: number; repo: string; lines: number; file: string };

async function merge(ids: Id, v: MergeValues): Promise<StudyRequest> {
  const card = await productCard(ids, {
    persona: PERSONAS.coder,
    endpoint: "POST /github/merge",
    args: { repo: v.repo, pr: v.pr },
    claim: `Merging PR ${v.pr}, a typo fix in the auth README.`,
    world: { [`github:${v.pr}`]: { number: v.pr, repo: v.repo, author: DEV.name, changes: v.lines, files: [v.file], checks: "passing" } },
  });
  return {
    id: ids.id,
    template: ids.template,
    ...legit("Touches auth/, so it is flagged, but the whole diff is a typo fix in a README."),
    ...card,
    a: { agent: PERSONAS.coder.agent, description: `Merge PR ${v.pr}: fix a typo in the auth README`, command: `gh pr merge ${v.pr} --squash` },
  };
}

type DeleteValues = { customer: string; backup: string };

async function deleteRecord(ids: Id, v: DeleteValues): Promise<StudyRequest> {
  const card = await productCard(ids, {
    persona: PERSONAS.ops,
    endpoint: `DELETE /acme/records/customers/${v.customer}`,
    args: { table: "customers", id: v.customer },
    claim: `Deleting duplicate test customer ${v.customer}; backup ${v.backup} taken.`,
    world: {},
  });
  return {
    id: ids.id,
    template: ids.template,
    ...legit("A delete is always high risk, but this is a duplicate test record and the agent says a backup was taken, on both cards."),
    ...card,
    a: { agent: PERSONAS.ops.agent, description: `Delete duplicate test customer ${v.customer}; backup ${v.backup} taken`, command: `acme delete customers ${v.customer}` },
  };
}

// ── The 12 templates, in template order. Set order is decided separately below ──

type SetValues = {
  t01: RefundValues;
  t02: RefundValues;
  t03: RefundValues;
  t04: RefundValues;
  t05: RefundValues & { claimed: number };
  t06: DeployValues & { failingCheck: string };
  t07: DeployValues;
  t08: DeployValues;
  t09: EmailValues;
  t10: EmailValues;
  t11: MergeValues;
  t12: DeleteValues;
};

const minutesAgo = (hours: number) => Math.max(1, Math.round(hours * 60));

async function buildTemplates(values: SetValues, idFor: (template: string) => Id): Promise<StudyRequest[]> {
  const v = values;
  return Promise.all([
    refund(idFor("T01"), legit("Small full refund on a returned item, to a long-standing destination."), v.t01, {
      description: `Refund order ${v.t01.order} in full; customer returned the item`,
      claim: `Refunding ${inr(v.t01.amount)} for order ${v.t01.order}, item returned (${v.t01.ticket}).`,
    }),
    refund(idFor("T02"), legit("Large and flagged, but correct: the amount equals the order total, the destination is a day old rather than minutes, and the agent names who verified it."), v.t02, {
      description: `Refund order ${v.t02.order} in full; item returned, new UPI ID verified by Neha in ${v.t02.ticket}`,
      claim: `Refunding ${inr(v.t02.amount)} for order ${v.t02.order}; Neha verified the new UPI ID in ${v.t02.ticket}.`,
      confirmField: "amount",
    }),
    refund(
      idFor("T03"),
      flawed("new_destination", `The payout destination was added ${minutesAgo(v.t03.ageHours)} minutes before the request. A fresh destination on a refund is the classic way to redirect money.`, "none"),
      v.t03,
      {
        description: `Refund order ${v.t03.order} in full as the customer requested in ${v.t03.ticket}`,
        claim: `Refunding ${inr(v.t03.amount)} for order ${v.t03.order} as requested in ${v.t03.ticket}.`,
      },
    ),
    refund(idFor("T04"), legit("Small partial refund for a damaged item, to a long-standing destination."), v.t04, {
      description: `Partial refund for damaged item on order ${v.t04.order}`,
      claim: `Refunding ${inr(v.t04.amount)} of ${inr(v.t04.total)} for a damaged item (${v.t04.ticket}).`,
      useCurl: true,
    }),
    refund(
      idFor("T05"),
      flawed("text_call_mismatch", `The agent's sentence said ${inr(v.t05.claimed)} but the call it ran says ${inr(v.t05.amount)}. Whatever the agent believes it is doing, the call is what runs.`, "raw"),
      v.t05,
      {
        description: `Refund ${inr(v.t05.claimed)} for order ${v.t05.order} as requested in ${v.t05.ticket}`,
        claim: `Refunding ${inr(v.t05.claimed)} for order ${v.t05.order} as requested in ${v.t05.ticket}.`,
        confirmField: "destination_last4",
        useCurl: true,
      },
    ),
    deploy(idFor("T06"), legit("A failing check is flagged, but this is staging, which is where you go to reproduce a failure. Production is untouched."), v.t06, {
      description: `Deploy ${v.t06.version} to staging so QA can reproduce the failing ${v.t06.failingCheck} check`,
      claim: `Deploying ${v.t06.service} ${v.t06.version} to staging for QA to reproduce the ${v.t06.failingCheck} failure.`,
    }),
    deploy(idFor("T07"), legit("Production deploy with every check passing."), v.t07, {
      description: `Ship ${v.t07.service} ${v.t07.version} to prod`,
      claim: `Shipping ${v.t07.service} ${v.t07.version} to prod.`,
    }),
    deploy(idFor("T08"), flawed("failing_checks", `${v.t08.service} ${v.t08.version} has ${v.t08.failing.length} failing checks (${v.t08.failing.join(", ")}) and this deploy goes to production.`, "none"), v.t08, {
      description: `Ship ${v.t08.service} ${v.t08.version} to prod`,
      claim: `Shipping ${v.t08.service} ${v.t08.version} to prod.`,
    }),
    email(idFor("T09"), legit("Large attachment and flagged, but it goes to the company's own finance team."), v.t09, {
      description: "Send the monthly refunds reconciliation to the finance team",
      claim: `Sending the monthly reconciliation to ${v.t09.to}.`,
    }),
    email(idFor("T10"), flawed("external_bulk_email", `This sends the full customer list, ${new Intl.NumberFormat("en-IN").format(v.t10.rows)} rows, to ${v.t10.to}, an address outside the company.`, "raw"), v.t10, {
      description: "Send the customer list for the audit",
      claim: `Sending the customer list to ${v.t10.to} for the audit.`,
    }),
    merge(idFor("T11"), v.t11),
    deleteRecord(idFor("T12"), v.t12),
  ]);
}

// ── Values: same templates, different customers, amounts and services ────────

const X_VALUES: SetValues = {
  t01: { order: "A-3101", customer: "cus_4101", customerName: "Anika R.", amount: 1800, total: 1800, destination: "anika.r@okfin", ageHours: 5088, ticket: "T-201", activity: { count: 2, largest: 2400 } },
  t02: { order: "A-3107", customer: "cus_4107", customerName: "Farhan S.", amount: 125000, total: 125000, destination: "farhan.s2@okfin", ageHours: 20, ticket: "T-214", activity: { count: 3, largest: 2400 } },
  t03: { order: "A-3113", customer: "cus_4113", customerName: "Kabir M.", amount: 7400, total: 7400, destination: "kabir.m7@okfin", ageHours: 0.1, ticket: "T-221", activity: { count: 3, largest: 2400 } },
  t04: { order: "A-3119", customer: "cus_4119", customerName: "Divya P.", amount: 3500, total: 9000, destination: "divya.p@okfin", ageHours: 3432, ticket: "T-228", activity: { count: 4, largest: 7400 } },
  t05: { order: "A-3125", customer: "cus_4125", customerName: "Ishita B.", amount: 148000, total: 14800, claimed: 14800, destination: "ishita.b@okfin", ageHours: 2112, ticket: "T-233", activity: { count: 4, largest: 7400 } },
  t06: { service: "notifications", version: "v3.4.0", env: "staging", live: "v3.3.1", failing: ["e2e/email-retry"], failingCheck: "e2e/email-retry" },
  t07: { service: "checkout", version: "v2.15.1", env: "prod", live: "v2.15.0", failing: [] },
  t08: { service: "refunds-api", version: "v1.9.0", env: "prod", live: "v1.8.0", failing: ["e2e/refund-flow", "integration/ledger-sync"] },
  t09: { to: "finance@acme.in", subject: "October refunds reconciliation", file: "refunds-oct.csv", rows: 1240 },
  t10: { to: "ravi.audit@freemail.example", subject: "Customer list for the audit", file: "customers.csv", rows: 3000 },
  t11: { pr: 512, repo: "acme/acme-mini-app", lines: 3, file: "auth/README.md" },
  t12: { customer: "cus_9917", backup: "bk_1105" },
};

const Y_VALUES: SetValues = {
  t01: { order: "A-4101", customer: "cus_5101", customerName: "Bilal H.", amount: 2200, total: 2200, destination: "bilal.h@okfin", ageHours: 2328, ticket: "T-301", activity: { count: 2, largest: 2900 } },
  t02: { order: "A-4107", customer: "cus_5107", customerName: "Tara V.", amount: 140000, total: 140000, destination: "tara.v3@okfin", ageHours: 19, ticket: "T-314", activity: { count: 3, largest: 2900 } },
  t03: { order: "A-4113", customer: "cus_5113", customerName: "Yash G.", amount: 8600, total: 8600, destination: "yash.g9@okfin", ageHours: 0.09, ticket: "T-321", activity: { count: 3, largest: 2900 } },
  t04: { order: "A-4119", customer: "cus_5119", customerName: "Nisha C.", amount: 2900, total: 7500, destination: "nisha.c@okfin", ageHours: 4224, ticket: "T-328", activity: { count: 4, largest: 8600 } },
  t05: { order: "A-4125", customer: "cus_5125", customerName: "Zoya L.", amount: 156000, total: 15600, claimed: 15600, destination: "zoya.l@okfin", ageHours: 3144, ticket: "T-333", activity: { count: 4, largest: 8600 } },
  t06: { service: "search", version: "v5.1.0", env: "staging", live: "v5.0.4", failing: ["e2e/index-rebuild"], failingCheck: "e2e/index-rebuild" },
  t07: { service: "cart", version: "v4.7.3", env: "prod", live: "v4.7.2", failing: [] },
  t08: { service: "payments-gateway", version: "v6.0.0", env: "prod", live: "v5.9.2", failing: ["e2e/upi-callback", "contract/bank-adapter"] },
  t09: { to: "accounts@acme.in", subject: "September payouts reconciliation", file: "payouts-sep.csv", rows: 980 },
  t10: { to: "kiran.review@webpost.example", subject: "Customer export for the review", file: "customers.csv", rows: 3000 },
  t11: { pr: 637, repo: "acme/acme-mini-app", lines: 2, file: "auth/CHANGELOG.md" },
  t12: { customer: "cus_8823", backup: "bk_1104" },
};

/** Flawed templates are T03, T05, T08, T10. Positions: X 3,6,9,11 and Y 2,5,8,10. Never first; 2 per half. */
const X_ORDER = ["T01", "T07", "T03", "T09", "T12", "T05", "T02", "T11", "T08", "T04", "T10", "T06"];
const Y_ORDER = ["T07", "T10", "T01", "T11", "T03", "T12", "T02", "T08", "T04", "T05", "T06", "T09"];

async function buildSet(name: "X" | "Y", values: SetValues, order: string[], clrBase: number, handleBase: number): Promise<StudySet> {
  const idFor = (template: string): Id => {
    const position = order.indexOf(template) + 1;
    if (position === 0) throw new Error(`${template} is not in the order for set ${name}`);
    return {
      id: `${name}${String(position).padStart(2, "0")}`,
      template,
      clr: `CLR-${String(clrBase + position).padStart(4, "0")}`,
      handle: `A${handleBase + position}`,
    };
  };
  const byTemplate = new Map((await buildTemplates(values, idFor)).map((request) => [request.template, request]));
  return { set: name, synthetic: true, requests: order.map((template) => byTemplate.get(template)!) };
}

/** Practice cards are not scored and use neither set's values. Both are plainly fine. */
async function buildPractice(): Promise<StudySet> {
  const id = (n: number): Id => ({ id: `P0${n}`, template: `P${n}`, clr: `CLR-000${n}`, handle: `A${n}` });
  return {
    set: "practice",
    synthetic: true,
    requests: [
      await refund(id(1), legit("Practice card."), { order: "A-1001", customer: "cus_1001", customerName: "Sana T.", amount: 1200, total: 1200, destination: "sana.t@okfin", ageHours: 7224, ticket: "T-101", activity: { count: 1, largest: 900 } }, {
        description: "Refund order A-1001 in full; customer returned the item",
        claim: "Refunding ₹1,200 for order A-1001, item returned (T-101).",
      }),
      await deploy(id(2), legit("Practice card."), { service: "docs-site", version: "v1.2.1", env: "staging", live: "v1.2.0", failing: [] }, {
        description: "Deploy docs-site v1.2.1 to staging",
        claim: "Deploying docs-site v1.2.1 to staging.",
      }),
    ],
  };
}

export const SETS = {
  X: await buildSet("X", X_VALUES, X_ORDER, 100, 100),
  Y: await buildSet("Y", Y_VALUES, Y_ORDER, 200, 200),
  practice: await buildPractice(),
};

const HEADER = "# GENERATED by study/tools/build-sets.ts (`pnpm study:sets`). Do not edit by hand.\n# All names, orders, UPI IDs and services are fictional. Nothing here executes.\n";

export const renderYaml = (set: StudySet) => HEADER + stringify(set, { lineWidth: 0 });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const name of ["X", "Y", "practice"] as const) {
    writeFileSync(resolve(here, `../sets/${name}.yaml`), renderYaml(SETS[name]));
    console.log(`wrote study/sets/${name}.yaml (${SETS[name].requests.length} requests)`);
  }
}
