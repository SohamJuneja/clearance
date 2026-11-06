import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../lib/paths.ts";
import { AUDIT_CHECKS } from "../audit.ts";
import { CASES } from "../cases.ts";
import { applyEdits, MUTATIONS } from "./index.ts";

describe("the mutation checks", () => {
  const policy = readFileSync(join(REPO_ROOT, "policy/clearance.policy.yaml"), "utf8");

  it.each(MUTATIONS.map((one) => [one.id, one] as const))(
    "%s still applies to today's code and policy, and targets something real",
    (_id, mutation) => {
      const target = [...CASES, ...AUDIT_CHECKS].find((one) => one.id === mutation.target);
      expect(target, `target ${mutation.target}`).toBeDefined();
      if (mutation.variant) {
        const names = ((target as { variants?: { name: string }[] }).variants ?? []).map(
          (variant) => variant.name,
        );
        expect(names).toContain(mutation.variant);
      }
      expect(mutation.policy ?? mutation.source).toBeDefined();
      expect(applyEdits(policy, mutation.policy ?? [], "the policy")).toBeTypeOf("string");
      for (const edit of mutation.source ?? []) {
        const text = readFileSync(join(REPO_ROOT, edit.file), "utf8");
        expect(applyEdits(text, [edit], edit.file)).not.toBe(text);
      }
    },
  );

  it("says why, when a control's removal doesn't flip its case", () => {
    for (const mutation of MUTATIONS) {
      if (mutation.expect === "still holds") expect(mutation.because, mutation.id).toBeTruthy();
    }
  });

  it("has a mutation for every audit finding, and for the two cases the audit doubted", () => {
    const targets = new Set(MUTATIONS.map((one) => one.target));
    for (const check of AUDIT_CHECKS) expect(targets.has(check.id), check.id).toBe(true);
    expect(targets.has(2)).toBe(true);
    expect(targets.has(9)).toBe(true);
  });

  it("refuses an edit that no longer matches, so a mutation can't quietly mutate nothing", () => {
    expect(() => applyEdits("abc", [{ find: "xyz", replace: "" }], "a file")).toThrow(
      /no longer contains/,
    );
  });
});

describe("the audit group", () => {
  it("is F1 to F5 and is not one of the 25", () => {
    expect(AUDIT_CHECKS.map((one) => one.id)).toEqual(["F1", "F2", "F3", "F4", "F5"]);
    expect(CASES.length).toBe(25);
    const ids = new Set<number | string>(CASES.map((one) => one.id));
    for (const check of AUDIT_CHECKS) expect(ids.has(check.id)).toBe(false);
  });
});

describe("the strengthened cases", () => {
  const byId = (id: number) => CASES.find((one) => one.id === id);

  it("case 1 covers a requester who never wrote @name: a role, an alias and a direct room", () => {
    const names = (byId(1)?.variants ?? []).map((variant) => variant.name).join("\n");
    expect(names).toMatch(/role/);
    expect(names).toMatch(/alias/);
    expect(names).toMatch(/direct room/);
  });

  it("case 2's owner could otherwise approve: the test team makes a finance approver the owner", () => {
    const team = readFileSync(join(REPO_ROOT, "policy/team.yaml"), "utf8");
    const edit = byId(2)?.team;
    expect(edit).toBeDefined();
    const changed = (edit as (yaml: string) => string)(team);
    expect(changed).not.toBe(team);
    expect(changed).toMatch(/refunds-agent:.*owner: sam/);
    expect(changed).toMatch(/support-agent:.*owner: priya/);
  });
});
