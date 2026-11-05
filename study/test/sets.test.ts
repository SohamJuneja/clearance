import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buttonDecision, clearanceDetail, clearanceTitle, confirmMatches, renderCard } from "../lib/cards";
import { FLAW_TYPES, StudyRequestSchema, loadSet, type StudyRequest } from "../lib/sets";
import { MAX_TITLE_CHARS } from "../lib/switch-card";
import { SETS, renderYaml } from "../tools/build-sets";

const X = loadSet("X").requests;
const Y = loadSet("Y").requests;
const PRACTICE = loadSet("practice").requests;
const ALL = [...X, ...Y, ...PRACTICE];
const bySetAndTemplate = (set: StudyRequest[], template: string) => set.find((r) => r.template === template)!;

const flawedPositions = (set: StudyRequest[]) => set.flatMap((r, i) => (r.kind === "flawed" ? [i + 1] : []));

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
      expect(B(checks).text).toMatch(/2 failing checks/);
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
      reversibility: "irreversible",
      headline: "REFUND ₹40,000",
      parsed: ["Refund ₹40,000 to customer Meera K. (cus_8812)", "Destination: UPI meera.k@okaxis", "Order A-1931 · total ₹4,000"],
      context: ["Refunds to this customer in 24 h: ₹0", "Destination added 4 minutes ago", "refunds-agent refunds today: 3 (largest ₹2,500)"],
      flags: ["Amount is 10x the order total", "Destination added in the last 24 h", 'The agent wrote "₹4,000" in the thread; the call says ₹40,000'],
      claim: "Refunding ₹4,000 for order A-1931 as requested in T-77.",
      asked_by: "Asked by Priya (support) through refunds-agent (Claude Code, owned by Priya)",
      why_you: "finance approver on duty. Priya asked and owns the agent, so she can't approve this.",
      policy: "refunds over ₹10,000 need 1 finance approver · expires 15:42 IST",
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
      const positions = ["The call (parsed", "\nContext\n", "\nFlags\n", "Agent's claim (unverified)", "Asked by", "Why you:", "Policy:", `Reply ${request.b.handle} yes`].map((part) =>
        detail.indexOf(part),
      );
      expect(positions.every((p) => p >= 0), request.id).toBe(true);
      expect(positions, request.id).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("labels the agent's sentence as an unverified claim", () => {
    for (const request of ALL) expect(renderCard(request, "B").text).toContain(`Agent's claim (unverified): "${request.b.claim}"`);
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

  it("uses the Appendix D wording for the type-to-confirm question", () => {
    const amount = [...X, ...Y].find((r) => r.b.confirm?.field === "amount")!;
    expect(plan).toContain("is high risk. Type the refund amount in rupees to approve, or answer no.");
    expect(amount.b.confirm!.question).toBe(`${amount.b.clr} is high risk. Type the refund amount in rupees to approve, or answer no.`);
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
    expect(buttonDecision("No")).toBe("deny");
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
});
