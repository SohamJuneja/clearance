/**
 * Runs one scenario and says what happened, step by step. A scenario scripts people's actions and
 * states what should then be true. It waits for whatever the agent really says, and fails with a clear
 * reason when that doesn't come. Agents' words are never written here.
 */
import { Persona } from "../../eval/lib/persona.ts";
import {
  AcmeClient,
  CoreClient,
  defaultUrls,
  probe,
  type ProbeResult,
  type ServiceName,
  type WorldUrls,
} from "../../eval/lib/world.ts";
import { Person, type PersonaWindow } from "./person.ts";

export const CAST = ["priya", "sam", "neha", "alex", "dev", "guest"] as const;
export type PersonName = (typeof CAST)[number];

export type StepOutcome = "pass" | "fail" | "skip" | "note";
export interface StepResult {
  name: string;
  outcome: StepOutcome;
  durationMs: number;
  detail?: string;
}
export type Verdict = "pass" | "fail" | "blocked";
export interface ScenarioResult {
  id: string;
  verdict: Verdict;
  preflight: ProbeResult[];
  blockedBecause?: string;
  steps: StepResult[];
  capture?: CaptureOutput;
}

/** Starts and stops the world's processes, for the scenarios that take a service down on purpose. */
export interface ServiceControl {
  stop(service: ServiceName): Promise<void>;
  start(service: ServiceName): Promise<void>;
}

export interface DemoContext {
  people: Record<PersonName, Person>;
  acme: AcmeClient;
  core: CoreClient;
  services: ServiceControl;
  /** How long to wait for an agent, which is a model thinking. */
  agentTimeoutMs: number;
  /** How long to wait for Clearance itself, which is deterministic code. */
  clearanceTimeoutMs: number;
  /** CLEARANCE_TIME_SCALE: at 10, a 3 minute escalation takes 18 s. */
  timeScale: number;
}

export interface Step<S> {
  name: string;
  /**
   * Failure is reported but doesn't fail the scenario. Only for what PLAN 8.7 itself calls conditional
   * on how the agent behaves, such as whether it happens to describe ₹4,000 in the thread.
   */
  conditional?: boolean;
  run(ctx: DemoContext, state: S): Promise<string | void>;
}

export interface Prompt {
  by: PersonName;
  room: string;
  text: string;
}

/** Text the recorder watches for in a persona's page. It notes when that text is really visible, in `seen.json`. */
export interface WatchSpec {
  label: string;
  persona: PersonName;
  /** A regular expression, as text, for what the page shows. */
  text: string;
}

export interface CaptureSpec {
  /** Whose windows to record. Default: the whole cast. */
  personas?: PersonName[];
  /** `half` records at 960x1080 for a split screen, so text stays legible once composed. */
  layout?: "full" | "half";
  watch?: WatchSpec[];
}

export interface ScenarioDefinition<S> {
  id: string;
  title: string;
  /** ★ in PLAN 8.7. */
  inVideo: boolean;
  prompt?: Prompt;
  /** The room whose agent the take starts fresh. Defaults to the prompt's. */
  room?: string;
  needs: ServiceName[];
  cast: PersonName[];
  /** Things the runner can't arrange itself and a person must know about. Printed before the steps. */
  preconditions?: string[];
  /** Environment the world's services restart with on the reset, such as CLEARANCE_DRILL_RATE. */
  worldEnv?: Record<string, string>;
  /** `pnpm` scripts to run right after the reset, such as seed:history. */
  afterReset?: string[];
  capture?: CaptureSpec;
  state: () => S;
  steps: Step<S>[];
  /** Always runs, pass or fail, to put the world back (a stopped service, say). */
  cleanup?: (ctx: DemoContext, state: S) => Promise<void>;
}

/** A scenario with its state type sealed inside, so all of them fit in one registry. */
export interface Scenario {
  id: string;
  title: string;
  inVideo: boolean;
  prompt?: Prompt;
  room?: string;
  needs: ServiceName[];
  cast: PersonName[];
  preconditions: string[];
  world: WorldSetup;
  capture: CaptureSpec;
  stepNames: string[];
  execute(ctx: DemoContext, hooks: StepHooks): Promise<StepResult[]>;
}

/** What a scene asks of the reset. A run with --no-reset gets neither, and its preconditions say so. */
export interface WorldSetup {
  env: Record<string, string>;
  afterReset: string[];
}

export interface StepHooks {
  beforeStep?(name: string): void;
  afterStep(result: StepResult): void;
}

export function defineScenario<S>(definition: ScenarioDefinition<S>): Scenario {
  return {
    id: definition.id,
    title: definition.title,
    inVideo: definition.inVideo,
    prompt: definition.prompt,
    room: definition.room ?? definition.prompt?.room,
    needs: definition.needs,
    cast: definition.cast,
    preconditions: definition.preconditions ?? [],
    world: { env: definition.worldEnv ?? {}, afterReset: definition.afterReset ?? [] },
    capture: definition.capture ?? {},
    stepNames: definition.steps.map((step) => step.name),
    async execute(ctx, hooks) {
      const state = definition.state();
      const results: StepResult[] = [];
      let stopped = false;
      try {
        for (const step of definition.steps) {
          if (stopped) {
            const skipped: StepResult = { name: step.name, outcome: "skip", durationMs: 0 };
            results.push(skipped);
            hooks.afterStep(skipped);
            continue;
          }
          hooks.beforeStep?.(step.name);
          const started = Date.now();
          let result: StepResult;
          try {
            const detail = await step.run(ctx, state);
            result = {
              name: step.name,
              outcome: "pass",
              durationMs: Date.now() - started,
              ...(detail ? { detail } : {}),
            };
          } catch (error) {
            const detail = errorText(error);
            result = {
              name: step.name,
              outcome: step.conditional ? "note" : "fail",
              durationMs: Date.now() - started,
              detail,
            };
            if (!step.conditional) stopped = true;
          }
          results.push(result);
          hooks.afterStep(result);
        }
      } finally {
        if (definition.cleanup) {
          try {
            await definition.cleanup(ctx, state);
          } catch (error) {
            const failure: StepResult = {
              name: "cleanup",
              outcome: "fail",
              durationMs: 0,
              detail: errorText(error),
            };
            results.push(failure);
            hooks.afterStep(failure);
          }
        }
      }
      return results;
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An assertion a step can throw from. The message is what gets printed, so write it for a person. */
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ── Capture ──────────────────────────────────────────────────────────────────

export interface CaptureOutput {
  directory: string;
  files: Record<string, string>;
}

/** One running capture. `end` closes the browser, so it always runs as soon as a scene is over. */
export interface CaptureSession {
  window(persona: PersonName): PersonaWindow | undefined;
  mark(label: string): void;
  /** `passed` says whether the scene worked, which decides if this take can become `latest`. */
  end(passed: boolean): Promise<CaptureOutput>;
}

export interface Recorder {
  begin(spec: {
    scenarioId: string;
    personas: PersonName[];
    layout: "full" | "half";
    baseUrl: string;
    watch?: WatchSpec[];
  }): Promise<CaptureSession>;
}

// ── Running ──────────────────────────────────────────────────────────────────

export interface RunOptions {
  urls?: WorldUrls;
  print?: (line: string) => void;
  recorder?: Recorder;
  /** Records in this layout whatever the scene asks. */
  layout?: "full" | "half";
  /** Puts the world in its starting state, as this scene asks. Absent means don't reset. */
  reset?: (setup: WorldSetup) => Promise<void>;
  services?: ServiceControl;
  agentTimeoutMs?: number;
  clearanceTimeoutMs?: number;
  timeScale?: number;
  secretsPath?: string;
  pollMs?: number;
}

const refusedControl: ServiceControl = {
  stop: async (service) => {
    throw new Error(`no way to stop ${service}: no service control was given to this run`);
  },
  start: async (service) => {
    throw new Error(`no way to start ${service}: no service control was given to this run`);
  },
};

const OUTCOME_WORD: Record<StepOutcome, string> = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIP",
  note: "NOTE",
};

export async function runScenario(
  scenario: Scenario,
  options: RunOptions = {},
): Promise<ScenarioResult> {
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const urls = options.urls ?? defaultUrls();
  const notRun = (): StepResult[] =>
    scenario.stepNames.map((name) => ({ name, outcome: "skip", durationMs: 0 }));

  print("");
  print(`${scenario.id}: ${scenario.title}`);
  if (scenario.prompt) {
    const { by, room, text } = scenario.prompt;
    print(`  ${by} in #${room}: "${text}"`);
  }
  for (const precondition of scenario.preconditions) print(`  needs: ${precondition}`);

  print("  preflight");
  const preflight: ProbeResult[] = [];
  for (const service of scenario.needs) {
    const result = await probe(service, urls[service]);
    preflight.push(result);
    print(`    ${result.reachable ? "PASS" : "FAIL"}  ${result.message}`);
  }
  const blockedBy = preflight.filter((result) => !result.reachable);
  if (blockedBy.length > 0) {
    return block(scenario, preflight, blockedBy.map((result) => result.message).join("; "), print);
  }

  const makePersona = (name: PersonName): Persona =>
    Persona.fromSecrets(name, {
      baseUrl: urls.mattermost,
      secretsPath: options.secretsPath,
      pollMs: options.pollMs,
    });

  for (const name of scenario.cast) {
    try {
      await makePersona(name).me();
      print(`    PASS  ${name} can sign in to Mattermost`);
    } catch (error) {
      const why = `${name} can't sign in to Mattermost: ${errorText(error)}`;
      print(`    FAIL  ${why}`);
      return block(scenario, preflight, why, print);
    }
  }

  if (options.reset) {
    try {
      await options.reset(scenario.world);
      print("    PASS  world reset");
    } catch (error) {
      const why = `reset failed: ${errorText(error)}`;
      print(`    FAIL  ${why}`);
      return block(scenario, preflight, why, print);
    }
  }

  let session: CaptureSession | undefined;
  if (options.recorder) {
    try {
      session = await options.recorder.begin({
        scenarioId: scenario.id,
        personas: scenario.capture.personas ?? scenario.cast,
        layout: options.layout ?? scenario.capture.layout ?? "full",
        baseUrl: urls.mattermost,
        watch: scenario.capture.watch,
      });
      print("    PASS  capture running");
    } catch (error) {
      const why = `capture failed to start: ${errorText(error)}`;
      print(`    FAIL  ${why}`);
      return block(scenario, preflight, why, print);
    }
  }

  const people = Object.fromEntries(
    CAST.map((name) => [name, new Person(makePersona(name), session?.window(name))]),
  ) as Record<PersonName, Person>;
  const ctx: DemoContext = {
    people,
    acme: new AcmeClient(urls.acme),
    core: new CoreClient(urls.core),
    services: options.services ?? refusedControl,
    agentTimeoutMs: options.agentTimeoutMs ?? 180_000,
    clearanceTimeoutMs: options.clearanceTimeoutMs ?? 30_000,
    timeScale: options.timeScale ?? 1,
  };

  // A take that didn't save is a failed take, however well the scene itself went.
  let captureLost = false;
  const endCapture = async (passed: boolean): Promise<CaptureOutput | undefined> => {
    try {
      return await session?.end(passed);
    } catch (error) {
      captureLost = true;
      print(`    FAIL  the capture didn't save: ${errorText(error)}`);
      return undefined;
    }
  };

  print("  steps");
  let steps: StepResult[];
  let capture: CaptureOutput | undefined;
  try {
    steps = await scenario.execute(ctx, {
      beforeStep: (name) => session?.mark(name),
      afterStep: (result) => {
        const time =
          result.outcome === "skip" ? "" : ` (${(result.durationMs / 1000).toFixed(1)} s)`;
        print(`    ${OUTCOME_WORD[result.outcome]}  ${result.name}${time}`);
        if (result.detail) print(`          ${result.detail}`);
      },
    });
  } catch (error) {
    // execute() catches every step's failure, so only a bug in the runner gets here. Still not a crash.
    steps = notRun();
    print(`    FAIL  the runner itself failed: ${errorText(error)}`);
    session?.mark("runner failed");
    capture = await endCapture(false);
    print(`  ${scenario.id} FAIL`);
    return { id: scenario.id, verdict: "fail", preflight, steps, capture };
  }
  const stepFailed = steps.some((step) => step.outcome === "fail");
  capture = await endCapture(!stepFailed);
  if (capture) print(`  capture: ${capture.directory}`);

  const failed = captureLost || stepFailed;
  const passed = steps.filter((step) => step.outcome === "pass").length;
  const verdict: Verdict = failed ? "fail" : "pass";
  print(`  ${scenario.id} ${verdict.toUpperCase()}: ${passed} of ${steps.length} steps passed`);
  return { id: scenario.id, verdict, preflight, steps, capture };
}

function block(
  scenario: Scenario,
  preflight: ProbeResult[],
  why: string,
  print: (line: string) => void,
): ScenarioResult {
  print("  steps not run (nothing was posted):");
  for (const name of scenario.stepNames) print(`    SKIP  ${name}`);
  print(`  ${scenario.id} BLOCKED: ${why}`);
  return {
    id: scenario.id,
    verdict: "blocked",
    preflight,
    blockedBecause: why,
    steps: scenario.stepNames.map((name) => ({ name, outcome: "skip", durationMs: 0 })),
  };
}
