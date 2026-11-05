import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIEFING, CONSENT, CONSENT_AGREE, FREE_TEXT_QUESTION, RECRUITMENT } from "../lib/materials";

const plan = readFileSync(resolve(import.meta.dirname, "../../PLAN.md"), "utf8");

describe("participant text is verbatim from the plan", () => {
  it("briefing, from 11.6", () => {
    expect(plan).toContain(`"${BRIEFING}"`);
  });

  it("consent, from Appendix C, including its agreement line", () => {
    expect(plan).toContain(`> ${CONSENT} ☐ ${CONSENT_AGREE}`);
  });

  it("recruitment, from Appendix C", () => {
    expect(plan).toContain(`> ${RECRUITMENT}`);
  });

  it("the free-text question, from 11.6", () => {
    expect(plan).toContain(FREE_TEXT_QUESTION);
  });

  it("recruitment.txt is the same text, ready to paste", () => {
    expect(readFileSync(resolve(import.meta.dirname, "../recruitment.txt"), "utf8").trim()).toBe(RECRUITMENT);
  });
});
