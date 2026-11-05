import type { Clock } from "@clearance/contracts";

/** The real clock for main. `CLEARANCE_TIME_SCALE=10` makes policy durations ten times shorter in real time. */
export function systemClock(scale = 1): Clock {
  if (!(scale > 0)) throw new Error(`time scale must be positive, got ${scale}`);
  return {
    nowMs: () => Date.now(),
    scaledMs: (policyMs) => policyMs / scale,
  };
}
