/** Both platforms write one format, one analysis reads it, and each record says where it came from. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyse } from "../../eval/study/analysis";
import { StudyEventSchema } from "../lib/events";
import { DEFAULT_RESULTS_DIR, createResultsLog } from "../lib/results";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "study-results-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const start = { type: "session_start", group: 1, schema: 1 };

describe("the results log", () => {
  it.each(["approval-lab", "switch"] as const)("stamps every %s record with its platform", (platform) => {
    const log = createResultsLog({ resultsDir: tempDir(), platform, synthetic: true });
    log.record("p01", { ...start, platform });
    log.record("p01", { type: "briefing_read" });
    log.record("p01", { type: "confidence", block: 1, value: 3 });
    for (const event of log.read("p01")) expect(event.platform).toBe(platform);
  });

  it("still reads a record from before every line carried one", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "p01.jsonl"), `${JSON.stringify({ type: "briefing_read", participant: "p01", at: "2026-11-06T16:00:00.000Z" })}\n`);
    const [event] = createResultsLog({ resultsDir: dir, platform: "switch" }).read("p01");
    expect(event?.platform).toBeUndefined();
  });

  it("refuses a platform nobody has heard of", () => {
    const parsed = StudyEventSchema.safeParse({ ...start, participant: "p01", at: "now", platform: "somewhere-else" });
    expect(parsed.success).toBe(false);
  });

  it("refuses synthetic events in the real results folder, from either platform", () => {
    for (const platform of ["approval-lab", "switch"] as const) {
      expect(() => createResultsLog({ resultsDir: DEFAULT_RESULTS_DIR, platform, synthetic: true })).toThrow("refusing");
    }
  });

  it("writes one JSON object per line, and nothing about anyone but their id", () => {
    const dir = tempDir();
    const log = createResultsLog({ resultsDir: dir, platform: "switch", synthetic: true, now: () => new Date("2026-11-06T16:00:00.000Z") });
    log.record("p01", { type: "briefing_read" });
    expect(JSON.parse(readFileSync(join(dir, "p01.jsonl"), "utf8").trim())).toEqual({
      type: "briefing_read",
      participant: "p01",
      at: "2026-11-06T16:00:00.000Z",
      platform: "switch",
      synthetic: true,
    });
  });
});

describe("the analysis, across platforms", () => {
  it("counts who used which, and each person's platform travels with them", () => {
    const at = "2026-11-06T16:00:00.000Z";
    const events = [
      { type: "session_start", participant: "p01", at, group: 1, platform: "approval-lab", schema: 1, synthetic: true },
      { type: "session_start", participant: "p02", at, group: 2, platform: "switch", schema: 1, synthetic: true },
      { type: "session_start", participant: "p03", at, group: 3, platform: "switch", schema: 1, synthetic: true },
    ].map((event) => StudyEventSchema.parse(event));
    expect(analyse(events, at).participants.by_platform).toEqual({ "approval-lab": 1, switch: 2 });
  });
});
