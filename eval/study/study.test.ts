/** Analysis tests. ALL DATA HERE IS SYNTHETIC (see fixtures/synthetic.ts). No result comes from this file. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StudyEvent } from "../../study/lib/events";
import { analyse, WILCOXON_MIN_N } from "./analysis";
import { syntheticSession, type SyntheticConditionPlan } from "./fixtures/synthetic";
import { DEFAULT_OUT_FILE, DEFAULT_RESULTS_DIR, pathsFromEnv, readResults, runStudyEval } from "./run";
import { bootstrapMeanCi, median, quantile, spread, wilcoxonSignedRank } from "./stats";

const AT = "2026-11-06T00:00:00.000Z";
const id = (n: number) => `p${String(n).padStart(2, "0")}`;
const plan = (overrides: Partial<SyntheticConditionPlan> = {}): SyntheticConditionPlan => ({ catches: 1, falseDenies: 0, msLegit: 3000, msFlawed: 4000, confidence: 3, ...overrides });

describe("median and quantiles", () => {
  it("match numpy's default linear interpolation", () => {
    // np.percentile([1,2,3,4], [25,50,75]) == [1.75, 2.5, 3.25]
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(median([5])).toBe(5);
  });

  it("are null for no data, never zero", () => {
    expect(median([])).toBeNull();
    expect(spread([])).toEqual({ n: 0, median: null, q1: null, q3: null, iqr: null });
  });

  it("do not reorder their input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("Wilcoxon signed-rank, exact", () => {
  /** An independent oracle: enumerate all sign assignments of the midranks directly. */
  function bruteForceP(differences: number[]): number {
    const nonzero = differences.filter((d) => d !== 0);
    const sorted = [...nonzero].map(Math.abs).sort((a, b) => a - b);
    const rankOf = (abs: number) => {
      const first = sorted.indexOf(abs);
      const last = sorted.lastIndexOf(abs);
      return (first + last) / 2 + 1;
    };
    const ranks = nonzero.map((d) => rankOf(Math.abs(d)));
    const observedPlus = nonzero.reduce((sum, d, i) => sum + (d > 0 ? ranks[i]! : 0), 0);
    const total = ranks.reduce((a, b) => a + b, 0);
    const observed = Math.min(observedPlus, total - observedPlus);
    let extreme = 0;
    for (let mask = 0; mask < 2 ** ranks.length; mask += 1) {
      const plus = ranks.reduce((sum, rank, i) => sum + (mask & (1 << i) ? rank : 0), 0);
      if (plus <= observed) extreme += 1;
    }
    return Math.min(1, (2 * extreme) / 2 ** ranks.length);
  }

  it("gives the textbook value when every difference has the same sign", () => {
    // n = 10, all positive: only one of 2^10 assignments per tail, so p = 2/1024.
    expect(wilcoxonSignedRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).p).toBe(2 / 1024);
    expect(wilcoxonSignedRank([-1, -2, -3, -4, -5, -6, -7, -8, -9, -10]).p).toBe(2 / 1024);
  });

  it("matches scipy.stats.wilcoxon with an exact permutation null, values recorded from running scipy", () => {
    // stats.wilcoxon(x, method=PermutationMethod(n_resamples=np.inf), zero_method="wilcox")
    expect(wilcoxonSignedRank([1, -2, 3, 4, 5, -6, 7, 8, 9, 10])).toMatchObject({ w_minus: 8, p: 0.048828125 });
    expect(wilcoxonSignedRank([0.25, 0.25, 0.5, 0, 0.75, 0.25, -0.25, 0.5, 0.25, 0])).toMatchObject({ w_minus: 3, p: 0.046875 });
    expect(wilcoxonSignedRank([0.5, 0.5, 0.5, 0.5, 0.25, -0.25, 0, 0, 0.75, 0.25, 0.25, -0.5])).toMatchObject({ w_minus: 9.5, p: 0.078125 });
  });

  it("agrees with brute force across messy tied data like catch rates", () => {
    const samples = [
      [0.25, 0.25, 0.5, 0, 0.75, 0.25, -0.25, 0.5, 0.25, 0],
      [0.5, 0.5, 0.5, 0.5, 0.25, -0.25, 0, 0, 0.75, 0.25, 0.25, -0.5],
      [1, -1, 1, -1, 1, -1, 1, -1, 1, -1],
      [0.125, 0.125, -0.125, 0.25, 0, 0.375, -0.25, 0.125, 0.5, 0.125, 0.25],
    ];
    for (const sample of samples) expect(wilcoxonSignedRank(sample).p).toBeCloseTo(bruteForceP(sample), 12);
  });

  it("drops zeros, and all zeros gives p = 1", () => {
    const result = wilcoxonSignedRank([0, 0, 1, 2, 3]);
    expect(result.n_nonzero).toBe(3);
    expect(wilcoxonSignedRank([0, 0, 0])).toMatchObject({ n_nonzero: 0, p: 1 });
    expect(wilcoxonSignedRank([])).toMatchObject({ n_nonzero: 0, p: 1 });
  });

  it("is symmetric: flipping every sign leaves p alone and swaps W", () => {
    const sample = [0.25, 0.5, -0.25, 0.75, 0.25, 0.5];
    const flipped = sample.map((d) => -d);
    expect(wilcoxonSignedRank(flipped).p).toBe(wilcoxonSignedRank(sample).p);
    expect(wilcoxonSignedRank(flipped).w_plus).toBe(wilcoxonSignedRank(sample).w_minus);
  });

  it("never exceeds p = 1 on a perfectly balanced sample", () => {
    expect(wilcoxonSignedRank([1, -1]).p).toBe(1);
  });
});

describe("bootstrap 95% CI", () => {
  it("is deterministic for the same input and seed", () => {
    const values = [0.25, 0.5, 0, 0.75, 0.25, -0.25, 0.5];
    expect(bootstrapMeanCi(values)).toEqual(bootstrapMeanCi(values));
  });

  it("has zero width when everyone has the same difference", () => {
    expect(bootstrapMeanCi([0.5, 0.5, 0.5])).toMatchObject({ low: 0.5, high: 0.5 });
  });

  it("contains the sample mean, and the mean's sampling spread is about right", () => {
    // 200 draws of a two-point variable: SE = 0.5/sqrt(200), so the CI half-width should be near 0.069.
    const values = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 1 : 0));
    const ci = bootstrapMeanCi(values)!;
    expect(ci.low).toBeLessThan(0.5);
    expect(ci.high).toBeGreaterThan(0.5);
    expect((ci.high - ci.low) / 2).toBeCloseTo(0.069, 1);
  });

  it("is null with no data", () => {
    expect(bootstrapMeanCi([])).toBeNull();
  });
});

describe("per-person metrics", () => {
  const events = syntheticSession("p01", {
    A: plan({ catches: 1, falseDenies: 2, msLegit: 2000, msFlawed: 3000, confidence: 2 }),
    B: plan({ catches: 3, falseDenies: 1, msLegit: 2500, msFlawed: 9000, confidence: 4 }),
  });
  const report = analyse(events, AT);
  const person = report.per_participant[0]!;

  it("catch rate is flawed denied over 4, and false-deny rate is legitimate denied over 8", () => {
    expect(person.A).toMatchObject({ catch_rate: 0.25, caught: 1, flawed: 4, false_deny_rate: 0.25, false_denies: 2, legit: 8 });
    expect(person.B).toMatchObject({ catch_rate: 0.75, caught: 3, flawed: 4, false_deny_rate: 0.125, false_denies: 1, legit: 8 });
  });

  it("medians are in seconds, split by legitimate and flawed", () => {
    expect(person.A).toMatchObject({ median_s_legit: 2, median_s_flawed: 3, confidence: 2 });
    expect(person.B).toMatchObject({ median_s_legit: 2.5, median_s_flawed: 9, confidence: 4 });
  });

  it("confidence follows the condition, not the block, whichever order someone saw them in", () => {
    // p03 is group 3: block 1 is condition B.
    const flipped = analyse(syntheticSession("p03", { A: plan({ confidence: 1 }), B: plan({ confidence: 5 }) }), AT).per_participant[0]!;
    expect(flipped.A.confidence).toBe(1);
    expect(flipped.B.confidence).toBe(5);
  });

  it("a failed type-to-confirm counts as not approved, and is counted so a reader can see it", () => {
    const withFailure = events.map((e) => (e.type === "decision" && e.condition === "B" && e.kind === "flawed" && e.decision === "approve" ? { ...e, decision: "confirm_failed" as const } : e));
    const metrics = analyse(withFailure, AT).per_participant[0]!.B;
    expect(metrics.catch_rate).toBe(1);
    expect(metrics.confirm_failed).toBe(1);
  });

  it("counts interrupted cards", () => {
    const interrupted = events.map((e, i) => (e.type === "decision" && i < 6 ? { ...e, interrupted: true } : e));
    expect(analyse(interrupted, AT).per_participant[0]!.A.interrupted).toBeGreaterThan(0);
  });
});

describe("across people", () => {
  it("reports median and IQR per condition", () => {
    const events = [
      ...syntheticSession(id(1), { A: plan({ catches: 0 }), B: plan({ catches: 1 }) }),
      ...syntheticSession(id(2), { A: plan({ catches: 1 }), B: plan({ catches: 2 }) }),
      ...syntheticSession(id(3), { A: plan({ catches: 2 }), B: plan({ catches: 3 }) }),
      ...syntheticSession(id(4), { A: plan({ catches: 3 }), B: plan({ catches: 4 }) }),
    ];
    const { by_condition } = analyse(events, AT);
    expect(by_condition.A.catch_rate).toEqual({ n: 4, median: 0.375, q1: 0.1875, q3: 0.5625, iqr: 0.375 });
    expect(by_condition.B.catch_rate.median).toBe(0.625);
  });

  it("paired differences are Clearance minus Switch, per person", () => {
    const events = [
      ...syntheticSession(id(1), { A: plan({ catches: 1 }), B: plan({ catches: 3 }) }),
      ...syntheticSession(id(2), { A: plan({ catches: 2 }), B: plan({ catches: 1 }) }),
    ];
    const paired = analyse(events, AT).paired_differences.catch_rate;
    expect(paired.per_person).toEqual([
      { participant: "p01", difference: 0.5 },
      { participant: "p02", difference: -0.25 },
    ]);
    expect(paired.mean).toBe(0.125);
    expect(paired.median).toBe(0.125);
    expect(paired.ci95).not.toBeNull();
  });

  it("withholds Wilcoxon below n = 10 and says why", () => {
    const events = Array.from({ length: WILCOXON_MIN_N - 1 }, (_, i) => syntheticSession(id(i + 1), { A: plan({ catches: 1 }), B: plan({ catches: 3 }) })).flat();
    const paired = analyse(events, AT).paired_differences.catch_rate;
    expect(paired.n).toBe(9);
    expect(paired.wilcoxon).toBeNull();
    expect(paired.wilcoxon_note).toContain("n = 9");
    expect(paired.ci95).not.toBeNull();
  });

  it("computes Wilcoxon at n = 10", () => {
    const events = Array.from({ length: WILCOXON_MIN_N }, (_, i) => syntheticSession(id(i + 1), { A: plan({ catches: 1 }), B: plan({ catches: 2 + (i % 3) }) })).flat();
    const paired = analyse(events, AT).paired_differences.catch_rate;
    expect(paired.n).toBe(10);
    expect(paired.wilcoxon!.p).toBe(2 / 1024);
    expect(paired.wilcoxon_note).toBeNull();
  });

  it("every metric gets a paired difference", () => {
    const events = syntheticSession(id(1), { A: plan(), B: plan() });
    expect(Object.keys(analyse(events, AT).paired_differences).sort()).toEqual(["catch_rate", "confidence", "false_deny_rate", "median_s_flawed", "median_s_legit"]);
  });

  it("reports catch rates by flaw type, keeping context-only flaws distinguishable", () => {
    const events = syntheticSession(id(1), { A: plan({ catches: 2 }), B: plan({ catches: 4 }) });
    const { by_flaw_type } = analyse(events, AT);
    expect(by_flaw_type.A.text_call_mismatch).toEqual({ caught: 2, total: 4, rate: 0.5, evidence_in_a: "raw" });
    expect(by_flaw_type.B.text_call_mismatch).toMatchObject({ caught: 4, total: 4, rate: 1 });
  });

  it("the exploratory split covers condition B's flaws by half and says no feedback was involved", () => {
    const events = syntheticSession(id(1), { A: plan(), B: plan({ catches: 2 }) });
    const { exploratory_b_catch_by_half } = analyse(events, AT);
    expect(exploratory_b_catch_by_half.first_half.total).toBe(2);
    expect(exploratory_b_catch_by_half.second_half.total).toBe(2);
    expect(exploratory_b_catch_by_half.first_half.caught).toBe(2);
    expect(exploratory_b_catch_by_half.second_half.caught).toBe(0);
    expect(exploratory_b_catch_by_half.note).toMatch(/no feedback/i);
  });
});

describe("who counts", () => {
  const full = () => syntheticSession(id(1), { A: plan(), B: plan() });
  const stoppedEarly = syntheticSession(id(2), { A: plan(), B: plan() }, { stopAfterCards: 5 });

  it("reports everyone who started, and incomplete sessions separately", () => {
    const { participants } = analyse([...full(), ...stoppedEarly], AT);
    expect(participants).toEqual({ started: 2, completed: 1, incomplete: ["p02"], stopped: ["p02"], by_platform: { "approval-lab": 2 } });
  });

  it("keeps incomplete sessions out of the paired analysis, so a dropout cannot skew it", () => {
    const report = analyse([...full(), ...stoppedEarly], AT);
    expect(report.per_participant.map((p) => p.participant)).toEqual(["p01"]);
    expect(report.paired_differences.catch_rate.n).toBe(1);
  });

  it("a session that ended with cards missing is incomplete, not complete", () => {
    const missing = full().filter((e) => !(e.type === "decision" && e.position === 7));
    expect(analyse(missing, AT).participants).toMatchObject({ completed: 0, incomplete: ["p01"] });
  });
});

describe("no number comes from a fixture", () => {
  const events = syntheticSession(id(1), { A: plan({ catches: 1 }), B: plan({ catches: 4 }) });

  it("marks synthetic data as such, and gives it no headline", () => {
    const report = analyse(events, AT);
    expect(report.synthetic).toBe(true);
    expect(report.headline).toBeNull();
    expect(report.label).toMatch(/SYNTHETIC/);
    expect(report.label).toMatch(/Not a result/);
  });

  it("one synthetic event anywhere taints the whole report", () => {
    const real = events.map(({ synthetic: _synthetic, ...rest }) => rest) as StudyEvent[];
    const realSecond = syntheticSession(id(2), { A: plan(), B: plan() });
    expect(analyse(real, AT).headline).not.toBeNull();
    expect(analyse([...real, ...realSecond], AT).headline).toBeNull();
  });

  it("calls real data a pilot, with its n, and says B adds context", () => {
    const real = events.map(({ synthetic: _synthetic, ...rest }) => rest) as StudyEvent[];
    const report = analyse(real, AT);
    expect(report.label).toContain("Pilot study, n = 1");
    expect(report.label).toMatch(/whole card/);
    expect(report.headline).toMatchObject({ n: 1, catch_rate: { A: 0.25, B: 1 } });
  });

  it("no results at all means n = 0 and a null headline, never a placeholder", () => {
    const report = analyse([], AT);
    expect(report.headline).toBeNull();
    expect(report.participants.started).toBe(0);
    expect(report.by_condition.A.catch_rate.median).toBeNull();
  });
});

describe("eval:study, the runner", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "study-eval-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeSession = (name: string, events: StudyEvent[]) => writeFileSync(join(dir, name), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  it("reads JSONL and writes the report where it is told to", () => {
    writeSession("p01.jsonl", syntheticSession(id(1), { A: plan({ catches: 1 }), B: plan({ catches: 3 }) }));
    writeSession("p02.jsonl", syntheticSession(id(2), { A: plan({ catches: 2 }), B: plan({ catches: 4 }) }));
    const outFile = join(dir, "out/study.json");
    const report = runStudyEval({ resultsDir: dir, outFile, now: () => new Date(AT) });
    expect(report.participants.completed).toBe(2);
    expect(JSON.parse(readFileSync(outFile, "utf8"))).toEqual(report);
  });

  it("the default output path is eval/out/study.json, which is gitignored", () => {
    expect(DEFAULT_OUT_FILE.endsWith("eval/out/study.json")).toBe(true);
    expect(readFileSync(resolve(import.meta.dirname, "../../.gitignore"), "utf8")).toMatch(/^eval\/out\/$/m);
  });

  it("a results directory that does not exist yet is n = 0, not a crash", () => {
    const outFile = join(dir, "out.json");
    expect(runStudyEval({ resultsDir: join(dir, "missing"), outFile }).participants.started).toBe(0);
  });

  it("a corrupt line stops the run and names its file and line, rather than being skipped", () => {
    writeFileSync(join(dir, "p01.jsonl"), '{"type":"session_start"}\n');
    expect(() => readResults(dir)).toThrow(/p01\.jsonl:1/);
  });

  it("ignores other files in the directory", () => {
    writeFileSync(join(dir, "notes.txt"), "not results");
    expect(readResults(dir)).toEqual([]);
  });

  it("reads a rehearsal's folder from STUDY_RESULTS_DIR, and keeps its report out of eval/out", () => {
    writeSession("p01.jsonl", syntheticSession(id(1), { A: plan({ catches: 1 }), B: plan({ catches: 3 }) }));
    const paths = pathsFromEnv({ STUDY_RESULTS_DIR: dir });
    expect(paths).toEqual({ resultsDir: dir, outFile: join(dir, "study-report.json") });
    const report = runStudyEval(paths);
    expect(report.participants.completed).toBe(1);
    expect(report.synthetic).toBe(true);
    expect(report.headline, "a rehearsal reports no number").toBeNull();
    expect(report.label).toMatch(/Not a result/);
    expect(readResults(dir), "its own report is not read back as results").toHaveLength(syntheticSession(id(1), { A: plan(), B: plan() }).length);
  });

  it("without STUDY_RESULTS_DIR, reads the real results and writes eval/out", () => {
    expect(pathsFromEnv({})).toEqual({ resultsDir: DEFAULT_RESULTS_DIR, outFile: DEFAULT_OUT_FILE });
    expect(pathsFromEnv({ STUDY_RESULTS_DIR: DEFAULT_RESULTS_DIR }), "naming the real folder is the same thing").toEqual({ resultsDir: DEFAULT_RESULTS_DIR, outFile: DEFAULT_OUT_FILE });
  });

  it("the real results directory refuses synthetic events and writes no report", () => {
    // `realResultsDir` points the guard at a temp dir, so this never touches study/results.
    writeSession("p01.jsonl", syntheticSession(id(1), { A: plan(), B: plan() }));
    const outFile = join(dir, "out.json");
    expect(() => runStudyEval({ resultsDir: dir, realResultsDir: dir, outFile })).toThrow(/synthetic events found/);
    expect(existsSync(outFile)).toBe(false);
    expect(DEFAULT_RESULTS_DIR.endsWith("study/results")).toBe(true);
  });

  it("real events in the real results directory do produce a headline", () => {
    const real = syntheticSession(id(1), { A: plan({ catches: 1 }), B: plan({ catches: 3 }) }).map(({ synthetic: _synthetic, ...rest }) => rest) as StudyEvent[];
    writeSession("p01.jsonl", real);
    const report = runStudyEval({ resultsDir: dir, realResultsDir: dir, outFile: join(dir, "out.json") });
    expect(report.synthetic).toBe(false);
    expect(report.headline).toMatchObject({ n: 1, catch_rate: { A: 0.25, B: 0.75 } });
  });

  it("the fixtures folder holds a generator, not a results file someone could mistake for data", () => {
    expect(readdirSync(resolve(import.meta.dirname, "fixtures"))).toEqual(["synthetic.ts"]);
  });
});
