/**
 * `pnpm eval:report` rewrites RESULTS.md, and the table in README.md between its markers, from whatever
 * the experiments wrote to eval/out/*.json. Nothing else may put a number in those files.
 *
 * A value no script has produced stays `_`. A result file with a known experiment but the wrong shape
 * stops the report, because a half-right table is worse than an old one. Anything marked `fixture` is
 * refused for the real RESULTS.md, and anything marked `synthetic` says so in its Data cell.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { REPO_ROOT } from "./lib/paths.ts";

const Flags = {
  /** Made-up data that exercises this script. Never allowed into the repo's RESULTS.md. */
  fixture: z.boolean().optional(),
  /** Generated rather than observed. Stays labelled in the table. */
  synthetic: z.boolean().optional(),
};

/** A count, or why there isn't one: "blocked", "not run", "5 of 12". A blocked vendor is never a zero. */
const VendorCell = z.union([z.number(), z.string()]);
const Vendors = z.object({
  claude: VendorCell.optional(),
  codex: VendorCell.optional(),
  opencode: VendorCell.optional(),
  cursor: VendorCell.optional(),
});
type VendorCounts = z.infer<typeof Vendors>;

const Prevented = z.object({
  prevented: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});

const E1 = z.object({
  ...Flags,
  experiment: z.literal("E1"),
  b_auto: Prevented.optional(),
  b_ask: Prevented.optional(),
  clearance: Prevented.optional(),
  cases: z.number().int().positive().optional(),
  /** How the baselines were obtained. Set when they were read from code rather than run. */
  baseline_basis: z.string().optional(),
});

const E2 = z.object({
  ...Flags,
  experiment: z.literal("E2"),
  risky_unapproved: z.object({ baseline: Vendors, clearance: Vendors }).optional(),
  safe_interrupted: z.object({ baseline: Vendors, clearance: Vendors }).optional(),
  runs: z.number().int().nonnegative().optional(),
  claude_model: z.string().optional(),
});

const E3 = z.object({
  ...Flags,
  experiment: z.literal("E3"),
  recall: z
    .object({ approval_required: z.number().optional(), clearance: z.number().optional() })
    .optional(),
  cards_per_100: z
    .object({ approval_required: z.number().optional(), clearance: z.number().optional() })
    .optional(),
  labelled_calls: z.number().int().positive().optional(),
});

const Percentiles = z.object({ p50: z.number(), p95: z.number(), p99: z.number() });

const E4Latency = z.object({
  ...Flags,
  experiment: z.literal("E4-latency"),
  hook: Percentiles.optional(),
  gate: Percentiles.optional(),
  calls_each: z.number().int().positive().optional(),
  /** The Codex hook CLI as a process per call, which is a different cost and is reported apart. */
  codex_cli: z
    .object({
      direct_node: Percentiles.optional(),
      as_configured: Percentiles.optional(),
      calls: z.number().int().positive().optional(),
    })
    .optional(),
});

const E4Soak = z.object({
  ...Flags,
  experiment: z.literal("E4-soak"),
  violations: z.number().int().nonnegative().optional(),
  hours: z.number().positive().optional(),
  calls: z.number().int().positive().optional(),
  restarts: z.number().int().nonnegative().optional(),
  /** A smoke test writes its own experiment id. If one ever says this, it's refused rather than counted. */
  smoke_test: z.literal(false).optional(),
});

const Split = z.object({ legit: z.number().optional(), flawed: z.number().optional() });

const E5 = z.object({
  ...Flags,
  experiment: z.literal("E5"),
  catch_rate: z
    .object({ switch_card: z.number().optional(), clearance_card: z.number().optional() })
    .optional(),
  median_seconds: z
    .object({ switch_card: Split.optional(), clearance_card: Split.optional() })
    .optional(),
  people: z.number().int().positive().optional(),
  flawed_each: z.number().int().positive().optional(),
});

const E6 = z.object({
  ...Flags,
  experiment: z.literal("E6"),
  human_decisions_per_100: z
    .object({ before: z.number().optional(), after: z.number().optional() })
    .optional(),
});

const Negative = z.object({
  ...Flags,
  experiment: z.literal("NEG"),
  /** The place Clearance loses, in plain words. PLAN 10 requires one. */
  text: z.string().min(1),
  source: z.string().optional(),
});

/** What eval/study writes. `headline` is null for synthetic data or no participants, so no number reaches E5. */
const Study = z.object({
  experiment: z.literal("E5 human study"),
  synthetic: z.boolean().optional(),
  headline: z
    .object({
      n: z.number(),
      catch_rate: z.object({ A: z.number().nullable(), B: z.number().nullable() }),
      median_s_legit: z.object({ A: z.number().nullable(), B: z.number().nullable() }),
      median_s_flawed: z.object({ A: z.number().nullable(), B: z.number().nullable() }),
    })
    .nullable(),
});

/** Condition A is Switch's card and B is Clearance's. */
function studyToE5(study: z.infer<typeof Study>): z.infer<typeof E5> {
  const { headline } = study;
  if (!headline) return { experiment: "E5" };
  const present = (value: number | null): number | undefined => value ?? undefined;
  return {
    experiment: "E5",
    catch_rate: {
      switch_card: present(headline.catch_rate.A),
      clearance_card: present(headline.catch_rate.B),
    },
    median_seconds: {
      switch_card: {
        legit: present(headline.median_s_legit.A),
        flawed: present(headline.median_s_flawed.A),
      },
      clearance_card: {
        legit: present(headline.median_s_legit.B),
        flawed: present(headline.median_s_flawed.B),
      },
    },
    people: headline.n,
    ...(study.synthetic ? { synthetic: true } : {}),
  };
}

/** Real output that isn't a result for this table, and why, so it can't look like it was lost. */
const NOT_FOR_THIS_TABLE: Record<string, string> = {
  "E4-soak-smoke": "it's a smoke test of the soak, not the 2 hour result",
  "E1-live": "the table reports the isolated run; live results are read separately",
};

const SCHEMAS = {
  E1,
  E2,
  E3,
  "E4-latency": E4Latency,
  "E4-soak": E4Soak,
  E5,
  E6,
  NEG: Negative,
} as const;
type ExperimentId = keyof typeof SCHEMAS;

export interface Inputs {
  E1?: z.infer<typeof E1>;
  E2?: z.infer<typeof E2>;
  E3?: z.infer<typeof E3>;
  "E4-latency"?: z.infer<typeof E4Latency>;
  "E4-soak"?: z.infer<typeof E4Soak>;
  E5?: z.infer<typeof E5>;
  E6?: z.infer<typeof E6>;
  NEG?: z.infer<typeof Negative>;
}

const BLANK = "_";

/** Formats a number the way the table writes it, or `_` for one that doesn't exist yet. */
function num(value: number | undefined, unit = ""): string {
  if (value === undefined) return BLANK;
  const text = Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : String(Math.round(value * 100) / 100);
  return `${text}${unit}`;
}

/** A fraction (0.75) as a percentage (75%), or `_`. */
function pct(value: number | undefined): string {
  return value === undefined ? BLANK : `${Math.round(value * 1000) / 10}%`;
}

function vendorCell(value: number | string | undefined): string {
  return typeof value === "string" ? value : num(value);
}

function vendors(counts: VendorCounts | undefined): string {
  return `Claude ${vendorCell(counts?.claude)}, Codex ${vendorCell(counts?.codex)}, OpenCode ${vendorCell(counts?.opencode)}, Cursor ${vendorCell(counts?.cursor)}`;
}

function vendorsOrBlank(counts: VendorCounts | undefined): string {
  return counts ? vendors(counts) : BLANK;
}

function prevented(value: z.infer<typeof Prevented> | undefined): string {
  return value ? num(value.prevented) : BLANK;
}

function triple(value: z.infer<typeof Percentiles> | undefined): string {
  return `${num(value?.p50)} / ${num(value?.p95)} / ${num(value?.p99)}`;
}

function synthetic(input: { synthetic?: boolean } | undefined, data: string): string {
  return input?.synthetic && !/synthetic/i.test(data) ? `${data} (synthetic)` : data;
}

const HEADER = "| ID | Metric | Baseline | Clearance | Data | Script |";

/** The PLAN 10.8 table. With no inputs at all, every cell it doesn't know is `_`. */
export function renderTable(inputs: Inputs): string {
  const { E1: e1, E2: e2, E3: e3, E5: e5, E6: e6, NEG: neg } = inputs;
  const latency = inputs["E4-latency"];
  const soak = inputs["E4-soak"];
  const codexProcess = latency?.codex_cli?.as_configured ?? latency?.codex_cli?.direct_node;
  const latencyParts = [
    latency?.hook ? `hook ${triple(latency.hook)}` : "",
    latency?.gate ? `gate ${triple(latency.gate)}` : "",
    codexProcess ? `Codex hook process ${triple(codexProcess)}` : "",
  ].filter(Boolean);
  const latencyCell = latencyParts.length > 0 ? latencyParts.join(", ") : triple(undefined);
  const rows = [
    HEADER,
    "|---|---|---|---|---|---|",
    `| E1 | Bad outcomes prevented (of ${e1?.clearance?.total ?? e1?.b_auto?.total ?? 25}) | B-auto: ${prevented(e1?.b_auto)} / B-ask: ${prevented(e1?.b_ask)} | ${prevented(e1?.clearance)} | ${synthetic(e1, `${e1?.cases ?? 25} scripted cases${e1?.baseline_basis ? "; baselines read from code, not run" : ""}`)} | \`pnpm eval:authority\` |`,
    `| E2 | Risky actions executed without an eligible human (of 20 per vendor) | ${vendors(e2?.risky_unapproved?.baseline)} | ${vendors(e2?.risky_unapproved?.clearance)} | ${synthetic(e2, `${num(e2?.runs ?? 360)} agent runs${e2?.claude_model ? `, Claude on ${e2.claude_model}` : ""}`)} | \`pnpm eval:vendors\` |`,
    `| E2 | Safe actions interrupted (of 20 per vendor) | ${vendorsOrBlank(e2?.safe_interrupted?.baseline)} | ${vendorsOrBlank(e2?.safe_interrupted?.clearance)} | same | same |`,
    `| E3 | Recall on risky calls, held-out | approval-required: ${pct(e3?.recall?.approval_required)} | ${pct(e3?.recall?.clearance)} | ${synthetic(e3, `${num(e3?.labelled_calls)} labelled calls after Fri 20:00`)} | \`pnpm eval:classifier\` |`,
    `| E3 | Cards per 100 tool calls | approval-required: ${num(e3?.cards_per_100?.approval_required)} | ${num(e3?.cards_per_100?.clearance)} | same | same |`,
    `| E4 | Added latency p50 / p95 / p99 (ms) | n/a | ${latencyCell} | ${synthetic(latency, `${num(latency?.calls_each ?? 1000)} calls each${latency?.codex_cli?.calls ? `; Codex hook ${num(latency.codex_cli.calls)} runs, each a new process` : ""}`)} | \`pnpm eval:latency\` |`,
    `| E4 | Soak invariant violations | n/a | ${num(soak?.violations)} | ${synthetic(soak, `${soak?.hours ?? 2} h, ${num(soak?.calls)} calls, ${soak?.restarts ?? 3} restarts`)} | \`pnpm eval:soak\` |`,
    `| E5 | Catch rate on flawed requests | Switch card: ${pct(e5?.catch_rate?.switch_card)} | Clearance card: ${pct(e5?.catch_rate?.clearance_card)} | ${synthetic(e5, `n = ${num(e5?.people)} people, ${e5?.flawed_each ?? 4} flawed each`)} | \`pnpm eval:study\` |`,
    `| E5 | Median seconds per decision (legit / flawed) | ${num(e5?.median_seconds?.switch_card?.legit)} / ${num(e5?.median_seconds?.switch_card?.flawed)} | ${num(e5?.median_seconds?.clearance_card?.legit)} / ${num(e5?.median_seconds?.clearance_card?.flawed)} | same | same |`,
    `| E6 | Human decisions per 100 agent actions | ${num(e6?.human_decisions_per_100?.before)} | ${num(e6?.human_decisions_per_100?.after)} (after promotion) | synthetic week, labelled | \`pnpm eval:autonomy\` |`,
    negativeRow(neg),
  ];
  return rows.join("\n");
}

function negativeRow(neg: Inputs["NEG"]): string {
  const cells = [
    "NEG",
    "**Negative result**",
    "",
    neg ? neg.text.replace(/\|/g, "\\|").replace(/\n/g, " ") : "",
    neg ? synthetic(neg, neg.source ?? "") : "",
    "",
  ];
  return `|${cells.map((cell) => (cell ? ` ${cell} ` : " ")).join("|")}|`;
}

const PREAMBLE = `# RESULTS

Generated by \`pnpm eval:report\`. Never edit numbers by hand. Blank cells mean the experiment has not produced a number yet.

`;

export function renderResults(inputs: Inputs): string {
  return `${PREAMBLE}${renderTable(inputs)}\n`;
}

export interface LoadedInputs {
  inputs: Inputs;
  files: string[];
  /** Files in the directory that aren't results, named so they can't vanish unnoticed. */
  ignored: string[];
  /** Files left out on purpose, with why. */
  leftOut: { name: string; why: string }[];
  hasFixture: boolean;
}

/** Reads every `*.json` directly in the directory. Subdirectories hold other tools' output. */
export function loadInputs(outDir: string): LoadedInputs {
  const loaded: LoadedInputs = {
    inputs: {},
    files: [],
    ignored: [],
    leftOut: [],
    hasFixture: false,
  };
  if (!existsSync(outDir)) return loaded;
  const files = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  for (const name of files) {
    const path = join(outDir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`${path} is not JSON: ${(error as Error).message}`);
    }
    const id = (raw as { experiment?: unknown } | null)?.experiment;
    if (typeof id === "string" && id in NOT_FOR_THIS_TABLE) {
      loaded.leftOut.push({ name, why: NOT_FOR_THIS_TABLE[id] as string });
      continue;
    }
    if (id === "E5 human study") {
      const study = Study.safeParse(raw);
      if (!study.success) {
        const issue = study.error.issues[0];
        throw new Error(
          `${path} has the wrong shape for E5: ${issue?.path.join(".")}: ${issue?.message}`,
        );
      }
      if (loaded.inputs.E5)
        throw new Error(`two result files for E5; keep one in ${outDir}. The second is ${name}`);
      loaded.inputs.E5 = studyToE5(study.data);
      loaded.files.push(name);
      continue;
    }
    if (typeof id !== "string" || !(id in SCHEMAS)) {
      loaded.ignored.push(name);
      continue;
    }
    const schema = SCHEMAS[id as ExperimentId];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${path} has the wrong shape for ${id}: ${issue?.path.join(".")}: ${issue?.message}`,
      );
    }
    if ((loaded.inputs as Record<string, unknown>)[id]) {
      throw new Error(`two result files for ${id}; keep one in ${outDir}. The second is ${name}`);
    }
    (loaded.inputs as Record<string, unknown>)[id] = parsed.data;
    if (parsed.data.fixture) loaded.hasFixture = true;
    loaded.files.push(name);
  }
  return loaded;
}

const START = "<!-- results:start -->";
const END = "<!-- results:end -->";

/** Puts the table between the markers. Returns undefined when there are no markers to fill. */
export function injectIntoReadme(readme: string, table: string): string | undefined {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 && end < 0) return undefined;
  if (start < 0 || end < start) {
    throw new Error(`README has a broken results block: it needs ${START} before ${END}`);
  }
  return `${readme.slice(0, start)}${START}\n${table}\n${readme.slice(end)}`;
}

export interface ReportOptions {
  outDir: string;
  resultsPath: string;
  readmePath: string;
  print?: (line: string) => void;
}

export interface ReportOutcome {
  results: string;
  usedFiles: string[];
  readmeUpdated: boolean;
}

/** The repo's own RESULTS.md never takes fixture data, wherever the fixture came from. */
function isRealResults(path: string): boolean {
  return resolve(path) === resolve(REPO_ROOT, "RESULTS.md");
}

export function writeReport(options: ReportOptions): ReportOutcome {
  const print = options.print ?? (() => undefined);
  const { inputs, files, ignored, leftOut, hasFixture } = loadInputs(options.outDir);
  if (hasFixture && isRealResults(options.resultsPath)) {
    throw new Error(
      `${options.outDir} holds fixture data and ${options.resultsPath} is the real RESULTS.md. Nothing was written.`,
    );
  }
  for (const name of ignored) print(`ignored ${name}: it names no known experiment`);
  for (const { name, why } of leftOut) print(`left out ${name}: ${why}`);
  const results = renderResults(inputs);
  writeFileSync(options.resultsPath, results);
  print(
    `wrote ${options.resultsPath} from ${files.length} result file(s)${files.length ? `: ${files.join(", ")}` : ""}`,
  );

  let readmeUpdated = false;
  if (existsSync(options.readmePath)) {
    const updated = injectIntoReadme(readFileSync(options.readmePath, "utf8"), renderTable(inputs));
    if (updated === undefined) {
      print(`${basename(options.readmePath)} has no results markers, so it was left alone`);
    } else {
      writeFileSync(options.readmePath, updated);
      readmeUpdated = true;
      print(`updated the table in ${options.readmePath}`);
    }
  } else {
    print(`no ${basename(options.readmePath)} yet, so only RESULTS.md was written`);
  }
  return { results, usedFiles: files, readmeUpdated };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    writeReport({
      outDir: join(REPO_ROOT, "eval/out"),
      resultsPath: join(REPO_ROOT, "RESULTS.md"),
      readmePath: join(REPO_ROOT, "README.md"),
      print: (line) => process.stdout.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`eval:report failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
