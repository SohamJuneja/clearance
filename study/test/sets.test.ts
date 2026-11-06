import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buttonDecision, clearanceDetail, clearancePrompt, clearanceTitle, confirmMatches, renderCard } from "../lib/cards";
import { FLAW_TYPES, StudyRequestSchema, loadSet, type StudyRequest } from "../lib/sets";
import * as materials from "../lib/materials";
import { MAX_TITLE_CHARS, mattermostEscape } from "../lib/switch-card";
import { SETS, renderYaml } from "../tools/build-sets";

const X = loadSet("X").requests;
const Y = loadSet("Y").requests;
const PRACTICE = loadSet("practice").requests;
const ALL = [...X, ...Y, ...PRACTICE];
const bySetAndTemplate = (set: StudyRequest[], template: string) => set.find((r) => r.template === template)!;

const flawedPositions = (set: StudyRequest[]) => set.flatMap((r, i) => (r.kind === "flawed" ? [i + 1] : []));

/** What a text costs against Switch's budget: the zero-width spaces its escape adds count. */
const size = (text: string) => Array.from(mattermostEscape(text)).length;

describe("committed sets match the generator", () => {
  it.each(["X", "Y", "practice"] as const)("%s.yaml", (name) => {
    expect(readFileSync(resolve(import.meta.dirname, `../sets/${name}.yaml`), "utf8")).toBe(renderYaml(SETS[name]));
  });
});

describe("PLAN 11.2 design rules", () => {
  it.each([["X", X], ["Y", Y]] as const)("set %s has 12 requests: 8 legitimate, 4 flawed", (_name, set) => {
    expect(set).toHaveLength(12);
    expect(set.filter((r) => r.kind === "legit")).toHaveLength(8);
    expect(set.filter((r) => r.kind === "flawed")).toHaveLength(4);
  });

  it.each([["X", X], ["Y", Y]] as const)("set %s never opens with a flawed request", (_name, set) => {
    expect(set[0]!.kind).toBe("legit");
  });

  it("both sets are built from the same 12 templates", () => {
    const templates = (set: StudyRequest[]) => set.map((r) => r.template).sort();
    expect(templates(X)).toEqual(templates(Y));
    expect(new Set(templates(X)).size).toBe(12);
  });

  it("a template has the same role, class and flaw type in both sets", () => {
    for (const x of X) {
      const y = bySetAndTemplate(Y, x.template);
      expect(y.kind, x.template).toBe(x.kind);
      expect(y.call.class, x.template).toBe(x.call.class);
      expect(y.flaw?.type, x.template).toBe(x.flaw?.type);
      expect(y.b.tier, x.template).toBe(x.b.tier);
      expect(y.b.score, x.template).toBe(x.b.score);
      expect(y.flaw?.evidence_in_a, x.template).toBe(x.flaw?.evidence_in_a);
    }
  });

  it("no value carries over between sets, so block 2 is not a repeat of block 1", () => {
    for (const x of X) {
      const y = bySetAndTemplate(Y, x.template);
      expect(y.a.command, x.template).not.toBe(x.a.command);
      expect(y.call.args, x.template).not.toEqual(x.call.args);
    }
    const money = (set: StudyRequest[]) => set.flatMap((r) => (typeof r.call.args.amount === "number" ? [r.call.args.amount] : []));
    expect(money(X).filter((amount) => money(Y).includes(amount))).toEqual([]);
  });

  it("flaw positions differ between sets, so block 1 does not teach where block 2's flaws are", () => {
    expect(flawedPositions(X).filter((p) => flawedPositions(Y).includes(p))).toEqual([]);
  });

  it.each([["X", X], ["Y", Y]] as const)("set %s has 2 flaws in each half, for the exploratory split", (_name, set) => {
    expect(flawedPositions(set).filter((p) => p <= 6)).toHaveLength(2);
    expect(flawedPositions(set).filter((p) => p > 6)).toHaveLength(2);
  });

  it("the flaw mix is the same 4 types in both sets, all from the 11.3 library", () => {
    const mix = (set: StudyRequest[]) => set.flatMap((r) => (r.flaw ? [r.flaw.type] : [])).sort();
    expect(mix(X)).toEqual(mix(Y));
    expect(new Set(mix(X)).size).toBe(4);
    expect(mix(X)).toEqual([...FLAW_TYPES].sort());
  });

  it("there are two practice cards, neither of them scored or flawed, and they repeat no set value", () => {
    expect(PRACTICE).toHaveLength(2);
    expect(PRACTICE.every((r) => r.kind === "legit")).toBe(true);
    const setCommands = new Set([...X, ...Y].map((r) => r.a.command));
    expect(PRACTICE.some((r) => setCommands.has(r.a.command))).toBe(false);
  });

  it("every request validates against the schema and stores the call and both renderings' inputs", () => {
    for (const request of ALL) {
      expect(() => StudyRequestSchema.parse(request)).not.toThrow();
      expect(request.call.args).toBeTypeOf("object");
      expect(request.a.command.length).toBeGreaterThan(0);
      expect(request.b.parsed.length).toBeGreaterThan(0);
    }
  });
});

describe("the comparison is fair to both cards", () => {
  const A = (r: StudyRequest) => renderCard(r, "A");
  const B = (r: StudyRequest) => renderCard(r, "B");

  it("flags do not give the answer away: 4 legitimate cards in each set also carry a flag", () => {
    for (const set of [X, Y]) {
      expect(set.filter((r) => r.kind === "legit" && r.b.flags.length > 0)).toHaveLength(4);
      expect(set.filter((r) => r.kind === "flawed" && r.b.flags.length > 0)).toHaveLength(4);
    }
  });

  it("critical tier does not give the answer away: one legitimate card is critical and one flawed card is not", () => {
    for (const set of [X, Y]) {
      expect(set.filter((r) => r.kind === "legit" && r.b.tier === "CRITICAL")).toHaveLength(1);
      expect(set.filter((r) => r.kind === "flawed" && r.b.tier !== "CRITICAL")).toHaveLength(1);
    }
  });

  it("some flaws are catchable on the Switch card: 2 of 4 in each set have raw evidence", () => {
    for (const set of [X, Y]) {
      expect(set.filter((r) => r.flaw?.evidence_in_a === "raw")).toHaveLength(2);
      expect(set.filter((r) => r.flaw?.evidence_in_a === "none")).toHaveLength(2);
    }
  });

  it("evidence_in_a is true: a mismatch really is on the Switch card, in both the sentence and the command", () => {
    for (const set of [X, Y]) {
      const request = set.find((r) => r.flaw?.type === "text_call_mismatch")!;
      const amount = request.call.args.amount as number;
      const text = A(request).text;
      expect(text).toContain(`"amount":${amount}`);
      const claimed = new Intl.NumberFormat("en-IN").format(amount / 10);
      expect(text).toContain(`₹${claimed}`);
      expect(text).not.toContain(`₹${new Intl.NumberFormat("en-IN").format(amount)}`);
    }
  });

  it("evidence_in_a is true: an external bulk email shows its recipient and file on the Switch card", () => {
    for (const set of [X, Y]) {
      const request = set.find((r) => r.flaw?.type === "external_bulk_email")!;
      const text = A(request).text;
      expect(text).toContain(request.call.args.to as string);
      expect(text).toContain("customers.csv");
    }
  });

  it("evidence_in_a is true: context-only flaws really are absent from the Switch card and present on Clearance's", () => {
    for (const set of [X, Y]) {
      const destination = set.find((r) => r.flaw?.type === "new_destination")!;
      expect(A(destination).text).not.toMatch(/minutes|added/i);
      expect(B(destination).text).toMatch(/added \d+ minutes ago/i);
      const checks = set.find((r) => r.flaw?.type === "failing_checks")!;
      expect(A(checks).text).not.toMatch(/failing|checks/i);
      expect(B(checks).text).toMatch(/Checks: failing \(2 failing: /);
    }
  });

  it("no card leaks the ground truth or the debrief text", () => {
    for (const request of [...X, ...Y]) {
      for (const card of [A(request), B(request)]) {
        const serialised = JSON.stringify(card);
        expect(serialised).not.toContain("flawed");
        expect(serialised).not.toContain("legit");
        if (request.flaw) expect(serialised).not.toContain(request.flaw.explanation);
      }
    }
  });
});

describe("condition A is what Switch shows", () => {
  it("has the agent's sentence as title, the literal command as detail, and the three buttons", () => {
    for (const request of ALL) {
      const card = renderCard(request, "A");
      expect(card.text, request.id).toContain(request.a.description);
      expect(card.text, request.id).toContain(`\`${request.a.command}\``);
      expect(card.buttons, request.id).toEqual(["Allow once", "Allow for this session", "Decline"]);
      expect(card.sender, request.id).toBe(request.a.agent);
      expect(card.typeToConfirm).toBe(false);
    }
  });

  it("keeps long curl lines whole, because Switch does: some commands are over the plan's stated 160", () => {
    const long = [...X, ...Y].filter((r) => r.a.command.length > 160);
    expect(long.length).toBeGreaterThan(0);
    for (const request of long) expect(renderCard(request, "A").text).toContain(request.a.command);
  });

  it("every card can be answered on real Mattermost, in both conditions", () => {
    for (const request of ALL) {
      expect(renderCard(request, "A").answerable, `${request.id} A`).toBe(true);
      expect(renderCard(request, "B").answerable, `${request.id} B`).toBe(true);
    }
  });
});

describe("condition B is the Appendix D card", () => {
  const plan = readFileSync(resolve(import.meta.dirname, "../../PLAN.md"), "utf8");

  /** The exact values on the Appendix D example. */
  const appendixD: StudyRequest = {
    id: "X01",
    template: "T01",
    kind: "flawed",
    flaw: { type: "new_destination", explanation: "x", evidence_in_a: "none" },
    legit_note: null,
    call: { class: "refund", endpoint: "POST /acme/refunds", args: {} },
    a: { agent: "refunds-agent", description: "x", command: "x" },
    b: {
      clr: "CLR-0042",
      handle: "A12",
      score: 0,
      tier: "HIGH",
      reversible: false,
      headline: "REFUND ₹40,000",
      parsed: ["Refund ₹40,000 to customer Meera K. (cus_8812)", "Destination: UPI meera.k@okaxis", "Order A-1931 · total ₹4,000"],
      context: ["Refunds to this customer in 24 h: ₹0", "Destination added 4 minutes ago", "refunds-agent refunds today: 3 (largest ₹2,500)"],
      flags: ["Amount is 10x the order total", "Destination added in the last 24 h", 'The agent wrote "₹4,000" in the thread; the call says ₹40,000'],
      claim: "Refunding ₹4,000 for order A-1931 as requested in T-77.",
      asked_by: ["Priya (support)"],
      agent: "refunds-agent",
      vendor: "Claude Code",
      owners: ["Priya"],
      why_you: "finance approver on duty. Can't approve: Priya (requester, agent owner).",
      policy_line: "refunds over ₹10,000 need 1 finance approver",
      expires: "15:42 IST",
      confirm: null,
    },
  };

  it("reproduces the Appendix D title and detail byte for byte, given its values", () => {
    expect(plan).toContain(`\`\`\`text\n${clearanceTitle(appendixD)}\n\`\`\``);
    expect(plan).toContain(`\`\`\`text\n${clearanceDetail(appendixD)}\n\`\`\``);
  });

  it("keeps the fixed order from F6: call, context, flags, claim, who and why, answer", () => {
    for (const request of [...X, ...Y]) {
      if (request.b.confirm) continue;
      const detail = clearanceDetail(request);
      // A section with nothing in it is left out, as core leaves it out.
      const parts = [
        "The call (parsed",
        ...(request.b.context.length > 0 ? ["\nContext\n"] : []),
        ...(request.b.flags.length > 0 ? ["\nFlags\n"] : []),
        "Agent's claim (unverified)",
        "Asked by",
        "Why you:",
        "Policy:",
        `@clearance why ${request.b.clr}`,
      ];
      const positions = parts.map((part) => detail.indexOf(part));
      expect(positions.every((p) => p >= 0), request.id).toBe(true);
      expect(positions, request.id).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("posts what the product posts: no answer line of its own, because Switch's renderer adds one", () => {
    for (const request of ALL) {
      const card = renderCard(request, "B");
      expect(card.text, request.id).not.toMatch(/yes or|Reply [A-Z]\d+/);
      expect(card.text.match(/Reply with/g), request.id).toHaveLength(1);
      if (!request.b.confirm) expect(clearanceDetail(request).endsWith(`\n\n@clearance why ${request.b.clr}`), request.id).toBe(true);
    }
  });

  it("names the people who can't approve, in the router's words", () => {
    for (const request of ALL) {
      expect(request.b.why_you, request.id).toMatch(/Can't approve: (Priya|Dev) \(requester(, agent owner)?(, code author)?\)\.$/);
      expect(renderCard(request, "B").text, request.id).toContain(`Why you: ${request.b.why_you}`);
    }
  });

  it("carries only what the product prints: no ticket lines, no backup notes, no invented flags", () => {
    // These were on an earlier hand-written version of the card, and core has no way to produce them.
    // They made flaws easier to catch here than on the real card, which would have inflated the result.
    for (const request of [...X, ...Y]) {
      const text = renderCard(request, "B").text;
      expect(text, request.id).not.toMatch(/verified this UPI ID|asks for this UPI ID|Backup bk_\d+ taken 2 hours|outside the company|Duplicate of/);
    }
    const remove = [...X, ...Y].filter((r) => r.call.class === "delete");
    for (const request of remove) expect(request.b.context, request.id).toEqual([]);
  });

  it("states the flaw's fact only where the product states it: a destination's age, a check's status, a mismatch", () => {
    for (const set of [X, Y]) {
      expect(set.find((r) => r.flaw?.type === "new_destination")!.b.flags).toEqual(["Destination added in the last 24 h"]);
      expect(set.find((r) => r.flaw?.type === "failing_checks")!.b.flags[0]).toMatch(/^Checks are not passing for /);
      const mismatch = set.find((r) => r.flaw?.type === "text_call_mismatch")!.b.flags;
      expect(mismatch[0]).toBe("Amount is 10x the order total");
      expect(mismatch[1]).toMatch(/^The agent wrote "₹[\d,]+" in the thread; the call says ₹[\d,]+$/);
      expect(set.find((r) => r.flaw?.type === "external_bulk_email")!.b.flags).toEqual(["Attachments hold 3,000 rows"]);
    }
  });

  it("the real mismatch detector raises no false flag on a legitimate card's claim", () => {
    for (const request of [...X, ...Y]) {
      if (request.kind === "legit") expect(request.b.flags.join(), request.id).not.toMatch(/The agent (wrote|did not say)/);
    }
  });

  it("stays inside the logged card budget, counted as Mattermost counts it: detail 960, prompt 790", () => {
    // The real cliff is 966 with no mention line and about 800; the budget keeps a margin below it.
    for (const request of ALL) {
      if (request.b.confirm) expect(size(clearancePrompt(request)), request.id).toBeLessThanOrEqual(790);
      else expect(size(clearanceDetail(request)), request.id).toBeLessThanOrEqual(960);
    }
  });

  it("omits the Flags section when there are none, as the product does, rather than printing None", () => {
    const unflagged = ALL.filter((r) => r.b.flags.length === 0);
    expect(unflagged.length).toBeGreaterThan(0);
    for (const request of unflagged) expect(renderCard(request, "B").text, request.id).not.toMatch(/Flags|None/);
  });

  it("labels the agent's sentence as an unverified claim on every card with room for it", () => {
    // Switch's escape puts a zero-width space after every @ in prose, so a claim naming an address has one.
    const shown = (request: StudyRequest) => renderCard(request, "B").text.replaceAll("​", "");
    for (const request of ALL) {
      if (!request.b.confirm) expect(shown(request), request.id).toContain(`Agent's claim (unverified): "${request.b.claim}"`);
    }
  });

  it("builds a type-to-confirm prompt as the product does: the ask first, the claim given up first when over budget", () => {
    const critical = ALL.filter((r) => r.b.confirm);
    expect(critical.length).toBeGreaterThan(0);
    for (const request of critical) {
      const prompt = clearancePrompt(request);
      const ask = request.b.confirm!.question;
      expect(prompt.startsWith(`${ask}\n\n`), request.id).toBe(true);
      // Never given up: the call, the flags, who asked, why you, and the expiry.
      for (const line of [...request.b.parsed, ...request.b.flags, `Asked by ${request.b.asked_by[0]}`, request.b.why_you, request.b.policy_line, `expires ${request.b.expires}`]) {
        expect(prompt, request.id).toContain(line);
      }
      expect(prompt, request.id).not.toContain("@clearance why");
    }
  });

  it("keeps the agent's claim on the legitimate critical card, because that claim is the case for approving it", () => {
    for (const set of [X, Y]) {
      const request = set.find((r) => r.kind === "legit" && r.b.confirm)!;
      expect(clearancePrompt(request), request.id).toContain(`Agent's claim (unverified): "${request.b.claim}"`);
    }
  });

  it("stays within Switch's title limit", () => {
    for (const request of ALL) expect(Array.from(clearanceTitle(request)).length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });

  it("uses type-to-confirm on exactly the critical cards, and the asked field rotates", () => {
    const confirms = [...X, ...Y].filter((r) => r.b.confirm);
    for (const request of [...X, ...Y]) {
      const card = renderCard(request, "B");
      expect(card.typeToConfirm, request.id).toBe(request.b.tier === "CRITICAL");
      expect(card.kind, request.id).toBe(request.b.tier === "CRITICAL" ? "questions" : "approval");
    }
    expect(new Set(confirms.map((r) => r.b.confirm!.field)).size).toBeGreaterThanOrEqual(3);
  });

  it("uses the product's wording for the type-to-confirm question, with the exact reply Switch accepts", () => {
    const amount = [...X, ...Y].find((r) => r.b.confirm?.field === "amount")!;
    expect(amount.b.confirm!.question).toBe(
      `${amount.b.clr} is high risk. To approve, type the refund amount in rupees, in quotes, after the request code. Or choose No, deny.`,
    );
  });

  it("never prints the answer in the question: the person has to look at the evidence", () => {
    const confirms = ALL.filter((request) => request.b.confirm);
    expect(confirms.length).toBeGreaterThan(0);
    for (const request of confirms) {
      const { question, expected } = request.b.confirm!;
      expect(question, request.id).not.toContain(expected);
      expect(question, request.id).not.toContain("<handle>");
    }
  });

  it("type-to-confirm expected values are on the card, so the task is reading, not recall", () => {
    for (const request of [...X, ...Y]) {
      if (!request.b.confirm) continue;
      const { field, expected } = request.b.confirm;
      const text = renderCard(request, "B").text;
      if (field === "amount") expect(text).toContain(`₹${new Intl.NumberFormat("en-IN").format(Number(expected))}`);
      else expect(text.replaceAll("​", "")).toContain(expected);
    }
  });
});

describe("policy-derived values", () => {
  it("every tier agrees with its score under the policy's thresholds", () => {
    const expected = (score: number) => (score < 30 ? "LOW" : score < 55 ? "MEDIUM" : score < 80 ? "HIGH" : "CRITICAL");
    for (const request of ALL) expect(request.b.tier, request.id).toBe(expected(request.b.score));
  });
});

describe("people are named, never given pronouns", () => {
  const GENDERED = /\b(he|she|him|his|her|hers|himself|herself)\b/i;

  it("in any card, in either condition", () => {
    for (const request of ALL) {
      for (const condition of ["A", "B"] as const) expect(renderCard(request, condition).text, `${request.id} ${condition}`).not.toMatch(GENDERED);
    }
  });

  it("in the set files, including the debrief explanations", () => {
    for (const name of ["X", "Y", "practice"]) expect(readFileSync(resolve(import.meta.dirname, `../sets/${name}.yaml`), "utf8"), name).not.toMatch(GENDERED);
  });

  it("in the participant-facing text", () => {
    for (const [name, value] of Object.entries(materials)) {
      if (typeof value === "string") expect(value, name).not.toMatch(GENDERED);
    }
  });
});

describe("all data is fictional", () => {
  it("every email address is the demo's internal domain or a reserved .example domain", () => {
    for (const request of ALL) {
      const to = request.call.args.to;
      if (typeof to === "string") expect(to, request.id).toMatch(/(@acme\.in|\.example)$/);
    }
  });

  it("the sets are labelled synthetic", () => {
    expect(loadSet("X").synthetic).toBe(true);
    expect(loadSet("Y").synthetic).toBe(true);
    expect(loadSet("practice").synthetic).toBe(true);
    expect(readFileSync(resolve(import.meta.dirname, "../sets/X.yaml"), "utf8")).toContain("fictional");
  });
});

describe("answers", () => {
  it("both Allow buttons approve, Decline, Deny and No deny, and anything else is an error", () => {
    expect(buttonDecision("Allow once")).toBe("approve");
    expect(buttonDecision("Allow for this session")).toBe("approve");
    expect(buttonDecision("Approve")).toBe("approve");
    expect(buttonDecision("Decline")).toBe("deny");
    expect(buttonDecision("Deny")).toBe("deny");
    expect(buttonDecision("No, deny")).toBe("deny");
    expect(() => buttonDecision("Maybe")).toThrow();
  });

  it("type-to-confirm accepts the value however it is written, and nothing else", () => {
    for (const typed of ["38000", " 38000 ", "38,000", "₹38,000", "Rs 38000", "INR 38,000"]) {
      expect(confirmMatches("amount", "38000", typed), typed).toBe(true);
    }
    for (const typed of ["3800", "380000", "38001", "", "yes"]) expect(confirmMatches("amount", "38000", typed), typed).toBe(false);
    expect(confirmMatches("service", "refunds-api", "Refunds-API ")).toBe(true);
    expect(confirmMatches("service", "refunds-api", "checkout")).toBe(false);
    expect(confirmMatches("destination_last4", "kfin", "KFIN")).toBe(true);
    expect(confirmMatches("recipient_domain", "freemail.example", "freemail.example")).toBe(true);
    expect(confirmMatches("recipient_domain", "freemail.example", "gmail.com")).toBe(false);
  });

  it("type-to-confirm accepts the reply form the card itself teaches, because a careful person types exactly that", () => {
    const accepted = ['A107 "38000"', '"38000"', "“38000”", "A107 38000", '<handle> "38000"', "a107 “₹38,000”", "‘38000’", 'A107"38000"'];
    for (const typed of accepted) expect(confirmMatches("amount", "38000", typed), typed).toBe(true);
    expect(confirmMatches("destination_last4", "kfin", 'A106 "kfin"')).toBe(true);
    expect(confirmMatches("destination_last4", "kfin", "A106 “kfin”")).toBe(true);
    expect(confirmMatches("service", "refunds-api", 'A109 "Refunds-API"')).toBe(true);
    expect(confirmMatches("recipient_domain", "freemail.example", 'A111 "freemail.example"')).toBe(true);
  });

  it("type-to-confirm is still strict about the value: the card's own example and a code alone are not it", () => {
    for (const typed of ["A107 1", 'A107 "3800"', "A107", '""', "<handle>", 'A107 "38000" extra']) expect(confirmMatches("amount", "38000", typed), typed).toBe(false);
    // A value that looks like a card's code is still the value.
    expect(confirmMatches("destination_last4", "A123", "A123")).toBe(true);
    expect(confirmMatches("destination_last4", "A123", 'A106 "A123"')).toBe(true);
  });

  it("matches core's option label on a type-to-confirm card", () => {
    const critical = [...X, ...Y].find((r) => r.b.confirm)!;
    expect(renderCard(critical, "B").buttons).toEqual(["No, deny"]);
    expect(readFileSync(resolve(import.meta.dirname, "../../packages/core/src/core.ts"), "utf8")).toContain('label: "No, deny"');
  });
});
