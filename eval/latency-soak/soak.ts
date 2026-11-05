/**
 * `pnpm eval:soak`, E4 (PLAN 10.5): mixed calls at one a second against isolated Acme, gate and core, a bot
 * answering cards at random, invariants checked as it goes, and three SIGKILLs of core along the way.
 * Everything is synthetic: the calls come from this script and no agent is involved.
 *
 *   pnpm eval:soak                  2 hours, for the report: writes eval/out/e4-soak.json
 *   pnpm eval:soak --smoke          5 minutes, to prove the soak itself works. Writes eval/out/e4-soak-smoke.json
 *                                   and is marked so the report can't take it for the 2 h result.
 *   --minutes 30                    any other length, also not the report's result
 *
 * The clock runs at 10x (CLEARANCE_TIME_SCALE), so expiries and escalations really fire within the run. Every
 * refund has a unique amount, so a double execution is visible in Acme whatever the ledger says.
 *
 * Exit status: 0 with no violations, 1 with any, and the violations are all in the output.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type ChatRecord, IsolatedWorld } from "../harness/world.ts";
import { readHost } from "../lib/host.ts";
import { REPO_ROOT } from "../lib/paths.ts";
import {
  botChoice,
  chaosTimes,
  checkAcmeExplained,
  checkApprovals,
  checkGrantsOnce,
  checkNoDoubles,
  checkNoStuckTimers,
  dedupe,
  type OpenTimer,
  type OverdueRequest,
  pickCall,
  type RequestFacts,
  seededRandom,
  type SoakLedgerRow,
  type Violation,
} from "./invariants.ts";

const REPORT_MINUTES = 120;
const SMOKE_MINUTES = 5;
const CHAOS_KILLS = 3;
const CHAOS_DOWN_MS = 8_000;
const CHECK_EVERY_MS = 15_000;
const TIME_SCALE = 10;
const SEED = 20261106;
/** How far past due a timer may be before it counts as stuck. The tick is 1 s and a restart takes a few. */
const STUCK_SLACK_MS = 30_000;

const print = (line: string): void => void process.stdout.write(`${line}\n`);
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export interface SoakOptions {
  minutes: number;
  smoke: boolean;
}

export function parseSoakArgs(argv: string[]): SoakOptions {
  const smoke = argv.includes("--smoke");
  const index = argv.indexOf("--minutes");
  const minutes = index >= 0 ? Number(argv[index + 1]) : smoke ? SMOKE_MINUTES : REPORT_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw new Error("--minutes takes a positive number");
  return { minutes, smoke };
}

/** Only an unflagged run of the full length may feed the report. */
export function isReportRun(options: SoakOptions): boolean {
  return !options.smoke && options.minutes >= REPORT_MINUTES;
}

interface Counters {
  calls: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  /** Calls that need a decision, made while core was down. Reads don't, and are counted apart. */
  riskyWhileDown: number;
  /** Of those, how many were refused. Anything less than all of them is a violation. */
  refusedWhileDown: number;
  readsWhileDown: number;
  answers: Record<string, number>;
  refusedAnswersTried: number;
  /** Calls that couldn't be delivered at all, while core was up. */
  transportErrors: number;
}

class Soak {
  private readonly random = seededRandom(SEED);
  private readonly ledger: SoakLedgerRow[] = [];
  private ledgerSeq = 0;
  private readonly facts = new Map<string, RequestFacts>();
  private readonly handled = new Set<string>();
  private readonly allowedRetries = new Map<string, number>();
  private readonly violations: Violation[] = [];
  private readonly pendingPushes = new Map<string, string>();
  private coreUp = true;
  private upSinceMs = Date.now();
  private counter = 0;
  readonly counters: Counters = {
    calls: 0,
    byKind: {},
    byStatus: {},
    riskyWhileDown: 0,
    refusedWhileDown: 0,
    readsWhileDown: 0,
    answers: {},
    refusedAnswersTried: 0,
    transportErrors: 0,
  };
  readonly restarts: { killed_at_s: number; back_at_s: number }[] = [];
  private readonly started = Date.now();

  constructor(private readonly world: IsolatedWorld) {}

  private count(bucket: Record<string, number>, key: string): void {
    bucket[key] = (bucket[key] ?? 0) + 1;
  }

  /** One call of the mix. While core is down, anything risky must come back refused. */
  async oneCall(): Promise<void> {
    const kind = pickCall(this.random());
    this.counter += 1;
    this.counters.calls += 1;
    this.count(this.counters.byKind, kind);
    const down = !this.coreUp;
    // A plain read goes straight through the gate by design, so it isn't a call that could fail closed.
    const needsDecision = kind !== "gate_read";
    if (down && needsDecision) this.counters.riskyWhileDown += 1;
    if (down && !needsDecision) this.counters.readsWhileDown += 1;
    try {
      const refused = await this.perform(kind);
      if (down && needsDecision) {
        if (refused) this.counters.refusedWhileDown += 1;
        else {
          this.violations.push({
            invariant: "fails closed while core is down",
            detail: `${kind} was not refused with core down`,
          });
        }
      }
    } catch (error) {
      // A hook call to a dead core is a refused connection, which every vendor is configured to block on.
      if (down && needsDecision) this.counters.refusedWhileDown += 1;
      else if (!down) {
        this.counters.transportErrors += 1;
        this.violations.push({
          invariant: "the system stays up",
          detail: `${kind}: ${(error as Error).message}`,
        });
      }
    }
  }

  /** Returns whether a risky call was refused. */
  private async perform(kind: ReturnType<typeof pickCall>): Promise<boolean> {
    const world = this.world;
    switch (kind) {
      case "hook_safe": {
        const result = await world.claudeHook("coder", "Read", { file_path: "src/index.ts" });
        this.count(this.counters.byStatus, result.allow ? "hook allow" : "hook deny");
        return !result.allow;
      }
      case "gate_read": {
        const res = await world.gate("refunds-agent", "GET", "/acme/orders/A-1931");
        this.count(this.counters.byStatus, `gate read ${res.status}`);
        return true;
      }
      case "gate_refund_small":
      case "gate_refund_large": {
        await world.say("priya", "priya", "@refunds-agent refund it").catch(() => undefined);
        // Unique amounts, so a double execution shows up in Acme whatever the ledger says.
        const base = kind === "gate_refund_large" ? 40_000 : 100;
        const amount = base + this.counter;
        const order = kind === "gate_refund_large" ? "A-2004" : "A-1931";
        const res = await world.gate("refunds-agent", "POST", "/acme/refunds", {
          order_id: order,
          amount,
        });
        this.count(this.counters.byStatus, `gate refund ${res.status}`);
        return res.status === 503;
      }
      case "gate_deploy": {
        await world.say("priya", "priya", "@ops-agent ship it", "room-eng").catch(() => undefined);
        const res = await world.gate(
          "ops-agent",
          "POST",
          "/acme/deploys",
          { service: "checkout", env: "prod", version: `v2.14.${this.counter}` },
          "room-eng",
        );
        this.count(this.counters.byStatus, `gate deploy ${res.status}`);
        return res.status === 503;
      }
      case "hook_push": {
        await world.say("alex", "alex", "@coder push it", "room-eng").catch(() => undefined);
        const command = `git push origin soak-${this.counter}:main`;
        const result = await world.claudeHook("coder", "Bash", { command });
        this.count(this.counters.byStatus, result.allow ? "hook push allow" : "hook push held");
        const id = result.reason.match(/CLR-\d+/)?.[0];
        if (id) this.pendingPushes.set(id, command);
        return !result.allow;
      }
      case "hook_curl": {
        const result = await world.claudeHook("refunds-agent", "Bash", {
          command: "curl -X POST http://127.0.0.1:7800/refunds -d x",
        });
        this.count(this.counters.byStatus, result.allow ? "curl allowed" : "curl denied");
        if (result.allow) {
          this.violations.push({
            invariant: "no execution without approval",
            detail: "the hook allowed a curl to Acme",
          });
        }
        return !result.allow;
      }
    }
  }

  /** The bot, answering any card it hasn't seen: approve, deny or ignore, and sometimes an answer that must fail. */
  async answerCards(): Promise<void> {
    if (!this.coreUp) return;
    for (const card of this.world.chat()) {
      if (card.kind !== "card" || !card.switchRequestId || this.handled.has(card.switchRequestId))
        continue;
      this.handled.add(card.switchRequestId);
      await this.answerOne(card).catch(() => undefined);
    }
  }

  private async answerOne(card: ChatRecord): Promise<void> {
    const id = card.title?.match(/CLR-\d+/)?.[0];
    if (!id) return;
    const person = card.roomId?.startsWith("dm-") ? card.roomId.slice(3) : null;
    if (!person) {
      // A copy in the origin room. It's where someone who shouldn't approve would try.
      if (this.random() < 0.3) {
        const asker = card.roomId === "room-eng" ? "alex" : "priya";
        this.counters.refusedAnswersTried += 1;
        await this.world.answer(card, asker, "allow");
      }
      return;
    }
    const choice = botChoice(this.random());
    this.count(this.counters.answers, choice);
    if (choice === "ignore") return;
    await this.world.answer(card, person as "sam", choice === "approve" ? "allow" : "deny");
    const command = this.pendingPushes.get(id);
    if (command && choice === "approve") await this.retryPush(id, command);
  }

  /** An approved push is retried twice. The second must not get through. */
  private async retryPush(id: string, command: string): Promise<void> {
    this.pendingPushes.delete(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.world.claudeHook("coder", "Bash", { command });
      if (result.allow)
        this.allowedRetries.set(command, (this.allowedRetries.get(command) ?? 0) + 1);
    }
  }

  async killCore(): Promise<void> {
    const killedAt = Date.now();
    this.coreUp = false;
    await this.world.killService("core");
    print(`  chaos: core killed at ${Math.round((killedAt - this.started) / 1000)} s`);
    await sleep(CHAOS_DOWN_MS);
    await this.world.startService("core");
    this.coreUp = true;
    this.upSinceMs = Date.now();
    this.restarts.push({
      killed_at_s: Math.round((killedAt - this.started) / 1000),
      back_at_s: Math.round((Date.now() - this.started) / 1000),
    });
    print("  chaos: core back");
  }

  private readDatabase(): { timers: OpenTimer[]; overdue: OverdueRequest[]; nowMs: number } {
    const db = new DatabaseSync(join(this.world.directory, "clearance.sqlite"), { readOnly: true });
    try {
      const nowMs = Date.now();
      const timers = db
        .prepare(
          `SELECT t.request_id, t.fire_at FROM timers t JOIN requests r ON r.id = t.request_id
           WHERE t.fired_at IS NULL AND t.fire_at < ? AND r.state IN ('HELD', 'ROUTED')`,
        )
        .all(nowMs) as unknown as OpenTimer[];
      const overdue = db
        .prepare(
          `SELECT id, state, expires_at FROM requests WHERE state IN ('HELD', 'ROUTED') AND expires_at < ?`,
        )
        .all(nowMs) as unknown as OverdueRequest[];
      return { timers, overdue, nowMs };
    } finally {
      db.close();
    }
  }

  /** Reads what's new and checks every invariant. Does nothing while core is down. */
  async check(): Promise<void> {
    if (!this.coreUp) return;
    const { json, status } = await this.world.coreGet(`/v1/ledger?after=${this.ledgerSeq}`);
    if (status !== 200) return;
    const rows = (json.entries ?? []) as SoakLedgerRow[];
    for (const row of rows) {
      this.ledger.push(row);
      this.ledgerSeq = Math.max(this.ledgerSeq, row.seq);
      if (
        row.request_id &&
        (row.type === "executed" || row.type === "approved") &&
        !this.facts.has(row.request_id)
      ) {
        const request = await this.world.request(row.request_id);
        this.facts.set(row.request_id, {
          id: row.request_id,
          cls: String(request.class ?? ""),
          requesterIds: (request.requester_ids ?? []) as string[],
          agentOwnerId: (request.agent_owner_id ?? null) as string | null,
        });
      }
    }
    const acme = await this.world.acmeState();
    const database = this.readDatabase();
    const found = [
      ...checkApprovals(this.ledger, this.facts),
      ...checkNoDoubles(
        this.ledger,
        acme.refunds.map((refund) => refund.amount),
      ),
      ...checkAcmeExplained(this.ledger, acme.refunds.length),
      ...checkGrantsOnce(this.ledger, this.allowedRetries),
      ...checkNoStuckTimers(
        database.timers,
        database.overdue,
        database.nowMs,
        this.upSinceMs,
        STUCK_SLACK_MS,
      ),
    ];
    for (const violation of found) {
      if (
        !this.violations.some(
          (known) => known.invariant === violation.invariant && known.detail === violation.detail,
        )
      ) {
        this.violations.push(violation);
        print(`  VIOLATION ${violation.invariant}: ${violation.detail}`);
      }
    }
  }

  async finish(): Promise<void> {
    await this.answerCards();
    await this.check();
    if (!(await this.world.ledgerVerifies())) {
      this.violations.push({
        invariant: "the ledger chain verifies",
        detail: "/v1/ledger/verify says it doesn't",
      });
    }
  }

  summary(): {
    violations: Violation[];
    ledgerEntries: number;
    ledgerTypes: Record<string, number>;
  } {
    const ledgerTypes: Record<string, number> = {};
    for (const row of this.ledger) ledgerTypes[row.type] = (ledgerTypes[row.type] ?? 0) + 1;
    return { violations: dedupe(this.violations), ledgerEntries: this.ledger.length, ledgerTypes };
  }
}

export interface SoakOutput {
  experiment: "E4-soak" | "E4-soak-smoke";
  smoke_test: boolean;
  /** Only a full-length, unflagged run may stand as the E4 soak result. */
  counts_as_the_report_result: boolean;
  minutes: number;
  hours: number;
  calls: number;
  restarts: number;
  violations: number;
  violation_list: Violation[];
  time_scale: number;
  seed: number;
  counters: Counters;
  chaos: { killed_at_s: number; back_at_s: number }[];
  acme: { refunds: number; deploys: number; money_out: number };
  ledger_entries: number;
  /** What the invariants had to look at. A soak with no expiries or executions would prove little. */
  ledger_types: Record<string, number>;
  host_before: ReturnType<typeof readHost>;
  host_after: ReturnType<typeof readHost>;
  note: string;
  measured_at: string;
}

async function main(): Promise<number> {
  const options = parseSoakArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  const reportRun = isReportRun(options);
  const durationMs = options.minutes * 60_000;
  print(
    `soak: ${options.minutes} minutes${options.smoke ? " (smoke test, not the report's result)" : ""}, ${CHAOS_KILLS} kills of core, clock at ${TIME_SCALE}x`,
  );
  const hostBefore = readHost();
  const world = await IsolatedWorld.start({ name: "soak", timeScale: TIME_SCALE });
  const soak = new Soak(world);
  const started = Date.now();
  const kills = chaosTimes(durationMs, CHAOS_KILLS);
  let nextCheck = started + CHECK_EVERY_MS;
  let nextCall = started;
  let chaos: Promise<void> = Promise.resolve();
  try {
    while (Date.now() - started < durationMs) {
      if (Date.now() >= nextCall) {
        nextCall += 1000;
        await soak.oneCall();
        await soak.answerCards();
      }
      const due = kills[0];
      if (due !== undefined && Date.now() - started >= due) {
        kills.shift();
        chaos = chaos.then(() => soak.killCore());
      }
      if (Date.now() >= nextCheck) {
        nextCheck += CHECK_EVERY_MS;
        await soak
          .check()
          .catch((error: unknown) => print(`  check failed: ${(error as Error).message}`));
        print(
          `  ${Math.round((Date.now() - started) / 1000)} s: ${soak.counters.calls} calls, ${soak.summary().violations.length} violations`,
        );
      }
      await sleep(Math.max(0, Math.min(nextCall - Date.now(), 200)));
    }
    await chaos;
    await soak.finish();
    const acme = await world.acmeState();
    const { violations, ledgerEntries, ledgerTypes } = soak.summary();
    const output: SoakOutput = {
      experiment: reportRun ? "E4-soak" : "E4-soak-smoke",
      smoke_test: !reportRun,
      counts_as_the_report_result: reportRun,
      minutes: options.minutes,
      hours: Math.round((options.minutes / 60) * 100) / 100,
      calls: soak.counters.calls,
      restarts: soak.restarts.length,
      violations: violations.length,
      violation_list: violations,
      time_scale: TIME_SCALE,
      seed: SEED,
      counters: soak.counters,
      chaos: soak.restarts,
      acme: {
        refunds: acme.refunds.length,
        deploys: acme.deploys.length,
        money_out: acme.money_out,
      },
      ledger_entries: ledgerEntries,
      ledger_types: ledgerTypes,
      host_before: hostBefore,
      host_after: readHost(),
      note: "Synthetic driver on isolated processes with a fake ChatPort. No agent is involved.",
      measured_at: new Date().toISOString(),
    };
    const directory = join(REPO_ROOT, "eval/out");
    mkdirSync(directory, { recursive: true });
    const file = reportRun ? "e4-soak.json" : "e4-soak-smoke.json";
    writeFileSync(join(directory, file), `${JSON.stringify(output, null, 2)}\n`);
    print(
      `${output.calls} calls, ${output.restarts} restarts, ${output.ledger_entries} ledger entries, ${output.acme.refunds} refunds, ${output.acme.deploys} deploys`,
    );
    print(`ledger: ${JSON.stringify(ledgerTypes)}`);
    print(
      `while core was down: ${soak.counters.riskyWhileDown} calls needing a decision, ${soak.counters.refusedWhileDown} refused; ${soak.counters.readsWhileDown} plain reads`,
    );
    print(
      `bot: ${JSON.stringify(soak.counters.answers)}, ${soak.counters.refusedAnswersTried} answers that should be refused`,
    );
    print(`${violations.length} invariant violations`);
    for (const violation of violations.slice(0, 40))
      print(`  ${violation.invariant}: ${violation.detail}`);
    print(`wrote eval/out/${file}${reportRun ? "" : " (not the report's result)"}`);
    return violations.length === 0 ? 0 : 1;
  } finally {
    await world.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`eval:soak failed: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
