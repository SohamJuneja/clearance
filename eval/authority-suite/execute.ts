/**
 * Runs one case or audit check in its own worlds and gives its verdict. A case with variants fails if any of them does,
 * and each variant starts clean, because who asked lingers in core for 10 minutes.
 */
import { IsolatedWorld } from "../harness/world.ts";
import type { AuthorityCase } from "./cases.ts";
import type { AuditCheck } from "./audit.ts";
import { Findings, StopCase, type Outcome, verdictOf } from "./scene.ts";

export interface RunOverrides {
  policy?: (yaml: string) => string;
  team?: (yaml: string) => string;
  coreEntry?: string;
  /** Run only the variant with this name, for a mutation that targets one way in. */
  onlyVariant?: string;
}

export interface CheckResult {
  outcome: Outcome;
  why: string;
  evidence: string[];
  badOutcomes: string[];
  durationMs: number;
}

interface World {
  label: string;
  team?: (yaml: string) => string;
  extraClasses?: Record<string, string[]>;
  run(world: IsolatedWorld, findings: Findings): Promise<void>;
}

function worldsFor(check: AuthorityCase | AuditCheck, overrides: RunOverrides): World[] {
  const authorityCase = check as AuthorityCase;
  const main: World = {
    label: "",
    team: authorityCase.team,
    extraClasses: authorityCase.extraClasses,
    run: check.run,
  };
  const variants: World[] = (authorityCase.variants ?? []).map((variant) => ({
    label: variant.name,
    team: variant.team === null ? undefined : (variant.team ?? authorityCase.team),
    extraClasses: authorityCase.extraClasses,
    run: variant.run,
  }));
  if (overrides.onlyVariant) {
    const chosen = variants.filter((one) => one.label === overrides.onlyVariant);
    if (chosen.length !== 1) {
      throw new Error(`case ${check.id} has no variant named "${overrides.onlyVariant}"`);
    }
    return chosen;
  }
  return [main, ...variants];
}

export async function runCheck(
  check: AuthorityCase | AuditCheck,
  overrides: RunOverrides = {},
): Promise<CheckResult> {
  const started = Date.now();
  const findings = new Findings();
  let error: string | undefined;
  const worlds = worldsFor(check, overrides);
  for (const [index, one] of worlds.entries()) {
    if (one.label) findings.note(`variant: ${one.label}`);
    let world: IsolatedWorld | undefined;
    try {
      world = await IsolatedWorld.start({
        name: `authority-${check.id}${index > 0 ? `-${index}` : ""}`,
        extraClasses: one.extraClasses,
        team: overrides.team ?? one.team,
        policy: overrides.policy,
        coreEntry: overrides.coreEntry,
      });
      await one.run(world, findings);
      if (!(await world.ledgerVerifies())) findings.control("the ledger chain verifies", false);
    } catch (caught) {
      if (!(caught instanceof StopCase)) error ??= (caught as Error).message;
    } finally {
      await world?.stop().catch(() => undefined);
    }
  }
  const verdict = verdictOf(findings, error);
  return {
    outcome: verdict.outcome,
    why: verdict.why,
    evidence: findings.evidence,
    badOutcomes: findings.badOutcomes,
    durationMs: Date.now() - started,
  };
}
