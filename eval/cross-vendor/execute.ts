/**
 * Runs an E2 plan through a driver, with the spend cap checked before every run. A driver either plays the
 * run for real (driver.ts) or, in tests, reports what a test scripted.
 */
import { ensureWithinCap, recordCost, SpendCapError, type CostOptions } from "../lib/costs.ts";
import {
  type AvailabilityMap,
  checkParallel,
  type PlannedRun,
  type RunObservation,
  type RunResult,
  scoreRun,
} from "./plan.ts";

export interface Driver {
  run(planned: PlannedRun): Promise<RunObservation>;
}

export interface ExecuteOptions {
  driver: Driver;
  availability: AvailabilityMap;
  usdPerRun: number;
  parallel?: number;
  cost?: CostOptions;
  print?: (line: string) => void;
  /** Called after every finished run, so a crash or a cap stop loses nothing. */
  onResult?: (result: RunResult) => void;
}

export interface ExecuteOutcome {
  results: RunResult[];
  skippedBlocked: number;
  /** Set when the spend cap stopped the run: what to put in HUMAN.md. */
  stoppedByCap?: string;
}

export async function executePlan(
  plan: PlannedRun[],
  options: ExecuteOptions,
): Promise<ExecuteOutcome> {
  const parallel = checkParallel(options.parallel ?? 1);
  const print = options.print ?? (() => undefined);
  const runnable = plan.filter(
    (run) => options.availability[run.vendor][run.condition].status === "ready",
  );
  const results: RunResult[] = [];
  let next = 0;
  let stoppedByCap: string | undefined;

  const worker = async (): Promise<void> => {
    while (!stoppedByCap) {
      const planned = runnable[next];
      next += 1;
      if (!planned) return;
      try {
        ensureWithinCap(options.usdPerRun, options.cost);
      } catch (error) {
        if (!(error instanceof SpendCapError)) throw error;
        stoppedByCap = error.message;
        return;
      }
      const started = Date.now();
      let observation: RunObservation;
      try {
        observation = await options.driver.run(planned);
      } catch (error) {
        observation = {
          effectHappened: false,
          approvedByHuman: false,
          cardShown: false,
          triedAnotherWay: false,
          askedHuman: false,
          held: false,
          answered: false,
          error: (error as Error).message,
        };
      }
      const result = scoreRun(planned, observation, Date.now() - started);
      results.push(result);
      options.onResult?.(result);
      print(
        `${planned.vendor} ${planned.condition} ${planned.intent.id} #${planned.repeat}: ${
          observation.error
            ? `ERROR ${observation.error}`
            : result.unapproved
              ? "UNAPPROVED"
              : result.interrupted
                ? "interrupted"
                : "ok"
        }`,
      );
      try {
        recordCost(
          {
            experiment: "E2",
            usd: options.usdPerRun,
            note: `estimate: ${planned.vendor} ${planned.condition} ${planned.intent.id}`,
          },
          options.cost,
        );
      } catch (error) {
        if (!(error instanceof SpendCapError)) throw error;
        stoppedByCap = error.message;
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  return {
    results,
    skippedBlocked: plan.length - runnable.length,
    ...(stoppedByCap ? { stoppedByCap } : {}),
  };
}
