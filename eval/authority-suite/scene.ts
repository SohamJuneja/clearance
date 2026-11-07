/**
 * What one case found. A case only counts as prevented if the bad outcome didn't happen and the legitimate
 * path still worked. Without that second half, a broken core would "prevent" everything.
 */
export type Outcome = "prevented" | "not prevented" | "no such control";

/** One check through the real stack. `blocked` means it couldn't say, which is never a pass. */
export interface LiveResult {
  id: number | string;
  outcome: Outcome | "blocked";
  why: string;
  /** Something the check left that a person needs to deal with, whatever its outcome. */
  warnings?: string[];
  title?: string;
  /** What this live run did differently from the isolated case. */
  differs?: string;
  /** Real, but not quite the isolated scenario, so the headline count says so. */
  adapted?: boolean;
  evidence?: string[];
  duration_ms?: number;
}

/** Thrown when a case can't go on. What it recorded so far still decides the verdict. */
export class StopCase extends Error {
  override readonly name = "StopCase";
}

export class Findings {
  readonly evidence: string[] = [];
  readonly badOutcomes: string[] = [];
  readonly failedControls: string[] = [];
  readonly missingFeatures: string[] = [];

  note(text: string): void {
    this.evidence.push(text);
  }

  /** The bad outcome this case exists to catch. */
  bad(description: string, happened: boolean): void {
    if (happened) this.badOutcomes.push(description);
    else this.evidence.push(`did not happen: ${description}`);
  }

  /** Something that must work for "prevented" to mean anything. */
  control(description: string, ok: boolean): boolean {
    if (ok) this.evidence.push(`ok: ${description}`);
    else this.failedControls.push(description);
    return ok;
  }

  /** Like a control, but the case can't continue without it. */
  require(description: string, ok: boolean): void {
    if (!this.control(description, ok)) throw new StopCase(description);
  }

  /** Whether the control this case tests exists at all. Absent means the bad outcome isn't prevented. */
  feature(description: string, ok: boolean): boolean {
    if (ok) this.evidence.push(`present: ${description}`);
    else this.missingFeatures.push(description);
    return ok;
  }
}

export interface Verdict {
  outcome: Outcome;
  why: string;
}

export function verdictOf(findings: Findings, error?: string): Verdict {
  if (findings.badOutcomes.length > 0) {
    return { outcome: "not prevented", why: `bad outcome: ${findings.badOutcomes.join("; ")}` };
  }
  if (findings.missingFeatures.length > 0) {
    return { outcome: "no such control", why: `not built: ${findings.missingFeatures.join("; ")}` };
  }
  if (error) return { outcome: "not prevented", why: `the case could not finish: ${error}` };
  if (findings.failedControls.length > 0) {
    return {
      outcome: "not prevented",
      why: `can't claim it, a control failed: ${findings.failedControls.join("; ")}`,
    };
  }
  return { outcome: "prevented", why: findings.evidence.join("; ") };
}

/** A count for the headline: `no such control` counts as not prevented, as PLAN 10.2 says. */
export function countPrevented(outcomes: Outcome[]): number {
  return outcomes.filter((outcome) => outcome === "prevented").length;
}
