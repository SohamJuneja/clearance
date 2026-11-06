import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addLabel, cardFor, labelsFileFor, nextUp, readDone, readPack, stepFor, undoLast } from "./label.ts";
import { blindRow, type ActionRow, parseLabels, resolveLabels } from "./metrics.ts";

/** Synthetic rows. None of this is a result. */
function action(id: string): ActionRow {
  return {
    id,
    at: "2026-11-07T01:00:00.000Z",
    source: "hook",
    vendor: "opencode",
    agent: "ops-agent",
    kind: "shell",
    class: "deploy",
    decision: "hold",
    request_id: "CLR-1",
    raw: JSON.stringify({ tool_name: "Bash", tool_input: { command: `echo ${id}` } }),
  };
}
const packText = (...ids: string[]): string =>
  ids.map((id) => JSON.stringify(blindRow(action(id)))).join("\n") + "\n";

describe("the labelling tool", () => {
  let dir: string;
  let labels: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e3-label-"));
    labels = join(dir, "labels.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the pack the sampler writes, and refuses a bad line, saying which", () => {
    expect(readPack(packText("a", "b")).map((row) => row.id)).toEqual(["a", "b"]);
    expect(() => readPack(`${packText("a")}not json\n`)).toThrow(/line 2/);
    expect(() => readPack('{"id":"a"}\n')).toThrow(/line 1/);
  });

  it("takes only the keys it names, so a stray key can never become a label", () => {
    expect(stepFor("r")).toEqual({ kind: "label", label: "risky" });
    expect(stepFor("s")).toEqual({ kind: "label", label: "safe" });
    expect(stepFor("u")).toEqual({ kind: "undo" });
    expect(stepFor("q")).toEqual({ kind: "quit" });
    expect(stepFor("\u0003")).toEqual({ kind: "quit" });
    for (const key of ["x", "R ", "\r", " ", ""]) expect(stepFor(key)).toEqual({ kind: "ignore" });
  });

  it("shows the labeller nothing about what Clearance decided", () => {
    const shown = cardFor(readPack(packText("a"))[0]!, 3, 300);
    expect(shown).toContain("3 of 300");
    expect(shown).toContain("echo a");
    expect(shown).not.toMatch(/deploy|hold|CLR-1/);
  });

  it("writes lines the scorer reads, and two people's give a kappa", () => {
    addLabel(labels, "a", "risky", "prashant");
    addLabel(labels, "b", "safe", "prashant");
    const second = join(dir, "second.jsonl");
    addLabel(second, "a", "risky", "soham");
    addLabel(second, "b", "safe", "soham");
    const all = parseLabels(readFileSync(labels, "utf8") + readFileSync(second, "utf8"));
    const { agreement } = resolveLabels(all);
    expect(agreement.compared).toBe(2);
    expect(agreement.kappa).toBe(1);
  });

  it("picks up where it stopped", () => {
    const pack = readPack(packText("a", "b", "c"));
    addLabel(labels, "a", "risky", "soham");
    expect(nextUp(pack, readDone(labels))?.id).toBe("b");
    addLabel(labels, "b", "safe", "soham");
    addLabel(labels, "c", "safe", "soham");
    expect(nextUp(pack, readDone(labels))).toBeUndefined();
  });

  it("undoes the last answer only, and is harmless with nothing to undo", () => {
    expect(undoLast(labels)).toBeUndefined();
    addLabel(labels, "a", "risky", "soham");
    addLabel(labels, "b", "safe", "soham");
    expect(undoLast(labels)).toBe("b");
    expect([...readDone(labels)]).toEqual(["a"]);
    expect(undoLast(labels)).toBe("a");
    expect(undoLast(labels)).toBeUndefined();
    expect(readFileSync(labels, "utf8")).toBe("");
  });

  it("keeps each person's answers in their own file, beside the pack", () => {
    expect(labelsFileFor("/x/to-label.jsonl", "soham")).toBe("/x/to-label.soham.labels.jsonl");
  });

  it("refuses a name that would mean something else to the scorer, or none at all", () => {
    expect(() => labelsFileFor("/x/to-label.jsonl", "resolved")).toThrow(/resolved/);
    expect(() => labelsFileFor("/x/to-label.jsonl", "")).toThrow(/name/);
    expect(() => labelsFileFor("/x/to-label.jsonl", "../evil")).toThrow(/name/);
  });

  it("refuses a labels file with someone else's answers in it", () => {
    writeFileSync(labels, '{"id":"a","label":"risky","labeller":"prashant"}\n');
    expect(() => addLabel(labels, "b", "safe", "soham")).toThrow(/prashant/);
  });
});
