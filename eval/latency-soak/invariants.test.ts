import { describe, expect, it } from "vitest";
import {
  botChoice,
  CALL_MIX,
  chaosTimes,
  checkAcmeExplained,
  checkApprovals,
  checkGrantsOnce,
  checkNoDoubles,
  checkNoStuckTimers,
  dedupe,
  pickCall,
  type RequestFacts,
  seededRandom,
  type SoakLedgerRow,
} from "./invariants.ts";
import { isReportRun, parseSoakArgs } from "./soak.ts";

/** Hand-built ledgers: each invariant has to catch the violation it exists for. */
const row = (
  seq: number,
  type: string,
  request_id: string,
  payload: Record<string, unknown> = {},
): SoakLedgerRow => ({
  seq,
  type,
  request_id,
  payload,
});
const refund: RequestFacts = {
  id: "CLR-1",
  cls: "refund",
  requesterIds: ["priya"],
  agentOwnerId: "priya",
};
const facts = new Map([["CLR-1", refund]]);

describe("no execution without an eligible approval", () => {
  it("passes an approval by an approver, then an execution", () => {
    const rows = [
      row(1, "approved", "CLR-1", { approved_by: ["sam"] }),
      row(2, "executed", "CLR-1", { ok: true }),
    ];
    expect(checkApprovals(rows, facts)).toEqual([]);
  });

  it("catches an execution with no approval", () => {
    const found = checkApprovals([row(1, "executed", "CLR-1", { ok: true })], facts);
    expect(found[0]?.detail).toContain("no approval before it");
  });

  it("catches an execution before its approval", () => {
    const rows = [
      row(1, "executed", "CLR-1", { ok: true }),
      row(2, "approved", "CLR-1", { approved_by: ["sam"] }),
    ];
    expect(checkApprovals(rows, facts)).toHaveLength(1);
  });

  it("catches a requester approving", () => {
    const rows = [
      row(1, "approved", "CLR-1", { approved_by: ["priya"] }),
      row(2, "executed", "CLR-1", { ok: true }),
    ];
    expect(
      checkApprovals(rows, facts)
        .map((one) => one.detail)
        .join(" "),
    ).toContain("approved by its requester");
  });

  it("catches someone who isn't an approver", () => {
    const rows = [
      row(1, "approved", "CLR-1", { approved_by: ["alex"] }),
      row(2, "executed", "CLR-1", { ok: true }),
    ];
    expect(checkApprovals(rows, facts)[0]?.detail).toContain("isn't an approver");
  });

  it("ignores a failed execution, which moved nothing", () => {
    expect(checkApprovals([row(1, "executed", "CLR-1", { ok: false })], facts)).toEqual([]);
  });

  it("catches refunds the ledger can't explain", () => {
    expect(checkAcmeExplained([], 1)[0]?.detail).toContain("explains 0");
    expect(checkAcmeExplained([row(1, "executed", "CLR-1", { ok: true })], 1)).toEqual([]);
  });
});

describe("no double execution", () => {
  it("passes one execution, and an already-executed reply isn't a second one", () => {
    const rows = [
      row(1, "executed", "CLR-1", { ok: true }),
      row(2, "executed", "CLR-1", { ok: true, already_executed: true }),
    ];
    expect(checkNoDoubles(rows, [40001])).toEqual([]);
  });

  it("catches two executions in the ledger", () => {
    const rows = [
      row(1, "executed", "CLR-1", { ok: true }),
      row(2, "executed", "CLR-1", { ok: true }),
    ];
    expect(checkNoDoubles(rows, [])[0]?.detail).toContain("executed 2 times");
  });

  it("catches the same refund twice in Acme, even if the ledger looks clean", () => {
    expect(checkNoDoubles([], [40001, 40001])[0]?.detail).toContain("₹40001 2 times");
  });
});

describe("every grant used at most once", () => {
  it("passes one use", () => {
    expect(
      checkGrantsOnce([row(1, "grant_consumed", "CLR-1")], new Map([["git push", 1]])),
    ).toEqual([]);
  });

  it("catches a grant consumed twice in the ledger", () => {
    expect(
      checkGrantsOnce(
        [row(1, "grant_consumed", "CLR-1"), row(2, "grant_consumed", "CLR-1")],
        new Map(),
      ),
    ).toHaveLength(1);
  });

  it("catches a command the hook allowed twice on one approval", () => {
    expect(checkGrantsOnce([], new Map([["git push", 2]]))[0]?.detail).toContain("allowed 2 times");
  });
});

describe("no stuck timers", () => {
  const NOW = 1_000_000;

  it("passes when nothing is overdue beyond the slack", () => {
    expect(
      checkNoStuckTimers([{ request_id: "CLR-1", fire_at: NOW - 1000 }], [], NOW, 0, 30_000),
    ).toEqual([]);
  });

  it("catches a timer well past due", () => {
    expect(
      checkNoStuckTimers([{ request_id: "CLR-1", fire_at: NOW - 60_000 }], [], NOW, 0, 30_000)[0]
        ?.detail,
    ).toContain("60 s overdue");
  });

  it("catches a request still open well past expiry", () => {
    const found = checkNoStuckTimers(
      [],
      [{ id: "CLR-1", state: "ROUTED", expires_at: NOW - 60_000 }],
      NOW,
      0,
      30_000,
    );
    expect(found[0]?.detail).toContain("past expiry");
  });

  it("gives a core that has just restarted time to catch up", () => {
    expect(
      checkNoStuckTimers([{ request_id: "CLR-1", fire_at: 0 }], [], NOW, NOW - 1000, 30_000),
    ).toEqual([]);
  });
});

describe("the soak's machinery", () => {
  it("removes repeats from the violations, which it never hides otherwise", () => {
    const one = { invariant: "a", detail: "b" };
    expect(dedupe([one, { ...one }, { invariant: "a", detail: "c" }])).toHaveLength(2);
  });

  it("repeats its choices for a seed", () => {
    const first = seededRandom(1);
    const second = seededRandom(1);
    expect([first(), first()]).toEqual([second(), second()]);
    expect(seededRandom(2)()).not.toBe(seededRandom(1)());
  });

  it("has a mix that adds up, and reaches every kind", () => {
    expect(CALL_MIX.reduce((sum, [, weight]) => sum + weight, 0)).toBeCloseTo(1);
    let upTo = 0;
    for (const [kind, weight] of CALL_MIX) {
      expect(pickCall(upTo + weight / 2)).toBe(kind);
      upTo += weight;
    }
  });

  it("makes all three of the bot's choices", () => {
    expect(botChoice(0.1)).toBe("approve");
    expect(botChoice(0.6)).toBe("deny");
    expect(botChoice(0.9)).toBe("ignore");
  });

  it("spaces the kills evenly inside the run", () => {
    expect(chaosTimes(400, 3)).toEqual([100, 200, 300]);
  });
});

describe("what counts as the report's result", () => {
  it("the default run is the 2 hour one", () => {
    const options = parseSoakArgs([]);
    expect(options.minutes).toBe(120);
    expect(isReportRun(options)).toBe(true);
  });

  it("a smoke test is 5 minutes and never counts", () => {
    const options = parseSoakArgs(["--smoke"]);
    expect(options.minutes).toBe(5);
    expect(isReportRun(options)).toBe(false);
  });

  it("a short run doesn't count, and neither does a long one marked smoke", () => {
    expect(isReportRun(parseSoakArgs(["--minutes", "30"]))).toBe(false);
    expect(isReportRun(parseSoakArgs(["--smoke", "--minutes", "200"]))).toBe(false);
  });

  it("refuses a nonsense length", () => {
    expect(() => parseSoakArgs(["--minutes", "soon"])).toThrow(/positive number/);
  });
});
