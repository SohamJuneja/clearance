import { describe, expect, it } from "vitest";
import { GROUPS, assignGroup, deriveStep, resolveAnswer, type Sets } from "../lib/protocol";
import type { StudyEvent } from "../lib/events";
import { loadSet } from "../lib/sets";

const sets: Sets = { X: loadSet("X").requests, Y: loadSet("Y").requests, practice: loadSet("practice").requests };
const at = "2026-11-06T16:00:00.000Z";

describe("counterbalancing, PLAN 11.2", () => {
  it("defines exactly the plan's four orders", () => {
    const orders = GROUPS.map((g) => g.blocks.map((b) => `${b.condition}-${b.set}`).join(" then "));
    expect(orders).toEqual(["A-X then B-Y", "A-Y then B-X", "B-X then A-Y", "B-Y then A-X"]);
  });

  it("assigns round-robin by participant id", () => {
    expect(["p01", "p02", "p03", "p04", "p05", "p08", "p09"].map((p) => assignGroup(p).group)).toEqual([1, 2, 3, 4, 1, 4, 1]);
  });

  it("balances 20 participants into 5 per group, and every order sees both sets and conditions", () => {
    const counts = new Map<number, number>();
    for (let n = 1; n <= 20; n += 1) {
      const group = assignGroup(`p${String(n).padStart(2, "0")}`).group;
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual([5, 5, 5, 5]);
    for (const { blocks } of GROUPS) {
      expect(blocks.map((b) => b.condition).sort()).toEqual(["A", "B"]);
      expect(blocks.map((b) => b.set).sort()).toEqual(["X", "Y"]);
    }
  });

  it("rejects ids that are not participant ids", () => {
    for (const id of ["p00", "p1", "bob", "p007", ""]) expect(() => assignGroup(id), id).toThrow();
  });
});

describe("the protocol's order of steps, PLAN 11.6", () => {
  const participant = "p01";
  const ev = (type: string, extra: object = {}): StudyEvent => ({ type, participant, at, ...extra }) as StudyEvent;
  const started: StudyEvent[] = [ev("session_start", { group: 1, platform: "approval-lab", schema: 1 }), ev("consent", { agreed: true, role: "other", familiarity: 3 })];
  const step = (events: StudyEvent[]) => deriveStep(events, participant, sets, 30);
  const practice = (id: string, condition: string) => ev("practice", { condition, request_id: id, decision: "approve", option: "x", ms: 100, interrupted: false, confirm_attempts: 0 });
  const decision = (block: number, position: number, id: string) =>
    ev("decision", { block, position, request_id: id, condition: "A", decision: "deny", option: "x", ms: 100, interrupted: false, confirm_attempts: 0, group: 1, set: "X", template: "T01", kind: "legit", flaw_type: null, evidence_in_a: null });
  const blockOf = (block: number, set: "X" | "Y") => sets[set].map((r, i) => decision(block, i + 1, r.id));

  it("opens on consent with nothing recorded", () => {
    expect(step([])).toEqual({ step: "consent" });
  });

  it("goes consent, briefing, then two practice cards", () => {
    expect(step(started)).toEqual({ step: "briefing" });
    const read = [...started, ev("briefing_read")];
    const first = step(read);
    expect(first).toMatchObject({ step: "practice", index: 1, total: 2 });
    const second = step([...read, practice("P01", "A")]);
    expect(second).toMatchObject({ step: "practice", index: 2, total: 2 });
  });

  it("practice shows one card in each style, starting with this participant's first condition", () => {
    const read = [...started, ev("briefing_read")];
    const first = step(read) as { card: { sender: string } };
    const second = step([...read, practice("P01", "A")]) as { card: { sender: string } };
    expect(first.card.sender).toBe("refunds-agent");
    expect(second.card.sender).toBe("clearance");
    const groupThree = deriveStep([...started, ev("briefing_read")], "p03", sets, 30) as { card: { sender: string } };
    expect(groupThree.card.sender).toBe("clearance");
  });

  const readied = [...started, ev("briefing_read"), practice("P01", "A"), practice("P02", "B")];

  it("runs block 1's 12 cards in set order, without leaking truth to the browser", () => {
    for (let i = 0; i < 12; i += 1) {
      const current = step([...readied, ...blockOf(1, "X").slice(0, i)]);
      expect(current).toMatchObject({ step: "card", block: 1, position: i + 1, total: 12, request_id: sets.X[i]!.id });
      const serialised = JSON.stringify(current);
      expect(serialised).not.toContain("flaw");
      expect(serialised).not.toContain('"kind":"legit"');
      expect(serialised).not.toContain('"kind":"flawed"');
      expect(serialised).not.toContain("expected");
    }
  });

  it("follows the group's order: group 1 is A-X then B-Y, group 3 is B-X then A-Y", () => {
    const groupOne = step(readied) as { request_id: string; card: { sender: string } };
    expect(groupOne.request_id).toBe(sets.X[0]!.id);
    expect(groupOne.card.sender).not.toBe("clearance");
    const threeEvents = readied.map((e) => ({ ...e, participant: "p03" }));
    const groupThree = deriveStep(threeEvents, "p03", sets, 30) as { request_id: string; card: { sender: string } };
    expect(groupThree.request_id).toBe(sets.X[0]!.id);
    expect(groupThree.card.sender).toBe("clearance");
  });

  it("asks confidence after each block, puts the break after block 1 only, then the free text, then debrief", () => {
    const afterBlock1 = [...readied, ...blockOf(1, "X")];
    expect(step(afterBlock1)).toEqual({ step: "confidence", block: 1 });
    const confident1 = [...afterBlock1, ev("confidence", { block: 1, value: 4 })];
    expect(step(confident1)).toEqual({ step: "break", seconds: 30 });
    const rested = [...confident1, ev("break_done")];
    expect(step(rested)).toMatchObject({ step: "card", block: 2, position: 1, request_id: sets.Y[0]!.id });
    const afterBlock2 = [...rested, ...blockOf(2, "Y")];
    expect(step(afterBlock2)).toEqual({ step: "confidence", block: 2 });
    const confident2 = [...afterBlock2, ev("confidence", { block: 2, value: 3 })];
    expect(step(confident2)).toEqual({ step: "comment" });
    expect(step([...confident2, ev("comment", { text: "" }), ev("session_end")])).toMatchObject({ step: "debrief" });
  });

  it("the debrief lists exactly the flawed requests the participant approved", () => {
    const flawedX = sets.X.filter((r) => r.kind === "flawed");
    const decided = (id: string, kind: string, verdict: string) => ({ ...decision(1, 1, id), kind, decision: verdict }) as StudyEvent;
    const events: StudyEvent[] = [
      ...readied,
      decided(flawedX[0]!.id, "flawed", "approve"),
      decided(flawedX[1]!.id, "flawed", "deny"),
      decided(flawedX[2]!.id, "flawed", "confirm_failed"),
      decided(sets.X.find((r) => r.kind === "legit")!.id, "legit", "approve"),
      ...Array.from({ length: 8 }, () => decision(1, 1, "x")),
      ...blockOf(2, "Y"),
      ev("confidence", { block: 1, value: 1 }),
      ev("confidence", { block: 2, value: 1 }),
      ev("break_done"),
      ev("session_end"),
    ];
    const debrief = step(events) as { step: string; missed: { explanation: string }[] };
    expect(debrief.step).toBe("debrief");
    expect(debrief.missed.map((m) => m.explanation)).toEqual([flawedX[0]!.flaw!.explanation]);
  });

  it("stopped wins from any point", () => {
    expect(step([...readied, ev("stopped")])).toEqual({ step: "stopped" });
  });
});

describe("what an answer means", () => {
  const legit = sets.X.find((r) => r.kind === "legit" && !r.b.confirm)!;
  const critical = sets.X.find((r) => r.b.confirm)!;

  it("in condition A both Allow buttons approve and Decline denies", () => {
    expect(resolveAnswer(legit, "A", 0, { label: "Allow once" })).toEqual({ kind: "final", decision: "approve", option: "Allow once" });
    expect(resolveAnswer(legit, "A", 0, { label: "Allow for this session" })).toEqual({ kind: "final", decision: "approve", option: "Allow for this session" });
    expect(resolveAnswer(legit, "A", 0, { label: "Decline" })).toEqual({ kind: "final", decision: "deny", option: "Decline" });
  });

  it("a button from the other card style is refused", () => {
    expect(resolveAnswer(legit, "A", 0, { label: "Approve" }).kind).toBe("invalid");
    expect(resolveAnswer(legit, "B", 0, { label: "Decline" }).kind).toBe("invalid");
  });

  it("a critical card in condition A is an ordinary button card with nothing to type", () => {
    expect(resolveAnswer(critical, "A", 0, { label: "Allow once" }).kind).toBe("final");
    expect(resolveAnswer(critical, "A", 0, { typed: critical.b.confirm!.expected }).kind).toBe("invalid");
  });

  it("a critical card in condition B cannot be approved by a button", () => {
    expect(resolveAnswer(critical, "B", 0, { label: "Approve" }).kind).toBe("invalid");
    expect(resolveAnswer(critical, "B", 0, { label: "No, deny" })).toEqual({ kind: "final", decision: "deny", option: "No, deny" });
  });

  it("type-to-confirm approves on the right value, re-asks once on a wrong one, then gives up (PLAN F6)", () => {
    const expected = critical.b.confirm!.expected;
    expect(resolveAnswer(critical, "B", 0, { typed: expected })).toEqual({ kind: "final", decision: "approve", option: "typed" });
    expect(resolveAnswer(critical, "B", 0, { typed: "wrong" })).toEqual({ kind: "reask" });
    expect(resolveAnswer(critical, "B", 1, { typed: "wrong" })).toEqual({ kind: "final", decision: "confirm_failed", option: "typed" });
    expect(resolveAnswer(critical, "B", 1, { typed: expected })).toEqual({ kind: "final", decision: "approve", option: "typed" });
  });

  it("no answer at all is invalid", () => {
    expect(resolveAnswer(legit, "A", 0, {}).kind).toBe("invalid");
  });
});
