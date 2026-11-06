/**
 * The six tabs as plain functions of API data and the time, so tests can check every number without a
 * browser. Nothing here fetches, and nothing here decides: all approving and denying happens in Switch.
 */
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  AutonomyView,
  BucketReplay,
  CoverageRow,
  CoverageView,
  LedgerEntry,
  LedgerVerification,
  LedgerView,
  PeopleView,
  PersonDetail,
  PolicyView,
  QueueItem,
  QueueView,
  SimulationResult,
  TeamDrills,
} from "../shared/api";
import {
  formatAge,
  formatCount,
  formatDateTime,
  formatLatency,
  formatPercent,
  formatRate,
  formatUntil,
  frictionWords,
  joinNames,
  sentenceCase,
  shortHash,
  stateName,
  summariseEntry,
} from "./format";
import { Empty, PageHead, Section, Stat, Status, TierMark } from "./parts";

// ── Queue ────────────────────────────────────────────────────────────────────

function escalationText(item: QueueItem): string {
  const { fired, of } = item.escalation;
  if (of === 0) return "No ladder";
  if (fired === 0) return "Not escalated";
  return of === null ? `Step ${fired}` : `Step ${fired} of ${of}`;
}

function escalationNote(item: QueueItem): string | null {
  const { fired, of, last } = item.escalation;
  if (last) return last;
  return fired === 0 && of ? `Ladder has ${of} step${of === 1 ? "" : "s"}` : null;
}

function QueueRow({ item, nowMs }: { item: QueueItem; nowMs: number }) {
  const context = [item.agent, item.vendor, item.asked_by.length > 0 ? `asked by ${item.asked_by.join(" and ")}` : "requester unknown", item.room].filter(Boolean).join(" · ");
  return (
    <tr data-testid={`queue-row-${item.id}`}>
      <td className="cell-id">
        <div className="strong">{item.id}</div>
        <div className="muted small">{stateName(item.state)}</div>
      </td>
      <td className="cell-wide">
        <div className="strong" data-testid={`queue-headline-${item.id}`}>
          {item.headline}
        </div>
        <div className="muted small">{context}</div>
        {item.flags.length > 0 ? (
          <ul className="flags">
            {item.flags.map((flag) => (
              <li key={flag.code + flag.text}>
                <span className="flag-mark" aria-hidden="true">
                  ⚠
                </span>{" "}
                {flag.text}
              </li>
            ))}
          </ul>
        ) : null}
      </td>
      <td data-label="Tier">
        <TierMark tier={item.tier} />
        <div className="muted small" data-testid={`queue-score-${item.id}`}>
          Score {item.score}
        </div>
      </td>
      <td data-label="Waiting on" data-testid={`queue-waiting-${item.id}`}>
        {item.waiting_on.length > 0 ? (
          item.waiting_on.map((holder) => (
            <div key={holder.person}>
              {holder.person} {holder.handle ? <code>{holder.handle}</code> : null}
            </div>
          ))
        ) : item.fallback ? (
          <div>
            {sentenceCase(item.fallback.group)} in {item.fallback.room}
          </div>
        ) : (
          <div className="muted">Nobody yet</div>
        )}
        {item.quorum_required > 1 ? (
          <div className="muted small">
            {item.approvals} of {item.quorum_required} approvals
          </div>
        ) : null}
      </td>
      <td className="num" data-label="Age" data-testid={`queue-age-${item.id}`}>
        {formatAge(item.created_at, nowMs)}
      </td>
      <td data-label="Escalation">
        <div data-testid={`queue-escalation-${item.id}`}>{escalationText(item)}</div>
        {escalationNote(item) ? <div className="muted small">{escalationNote(item)}</div> : null}
      </td>
      <td className="num" data-label="Expires" data-testid={`queue-expires-${item.id}`}>
        {formatUntil(item.expires_at, nowMs)}
      </td>
    </tr>
  );
}

export function QueueTab({ data, nowMs }: { data: QueueView; nowMs: number }) {
  const oldest = data.requests.reduce<string | null>((first, item) => (first === null || item.created_at < first ? item.created_at : first), null);
  const sorted = [...data.requests].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return (
    <>
      <PageHead title="Queue" note="Requests waiting on a person, each answered on its card in Switch with the handle shown here. This list can run behind Switch, so a card you have there still needs your answer, whether or not it is listed." />
      <div className="stats">
        <Stat label="Open requests" value={data.open_count} id="queue-open" />
        <Stat label="Oldest waiting" value={oldest ? formatAge(oldest, nowMs) : "–"} id="queue-oldest" />
        <Stat label="Escalated" value={data.requests.filter((item) => item.escalation.fired > 0).length} id="queue-escalated" />
        <Stat label="Critical tier" value={data.requests.filter((item) => item.tier === "critical").length} id="queue-critical" />
      </div>
      {sorted.length === 0 ? (
        <Empty title="No open requests listed.">Held requests appear here once an agent is stopped.</Empty>
      ) : (
        <table className="stack" data-testid="queue-table">
          <thead>
            <tr>
              <th>Request</th>
              <th>What</th>
              <th>Tier</th>
              <th>Waiting on</th>
              <th className="num">Age</th>
              <th>Escalation</th>
              <th className="num">Expires</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <QueueRow key={item.id} item={item} nowMs={nowMs} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ── Ledger ───────────────────────────────────────────────────────────────────

const ROW_LIMIT = 300;

export function ChainBadge({ verify }: { verify: LedgerVerification }) {
  return verify.ok ? (
    <Status kind="good" id="chain-badge">
      {verify.through_seq === null ? "Chain intact · no entries listed yet" : `Chain intact through entry ${formatCount(verify.through_seq)} · head ${shortHash(verify.head ?? "")}`}
    </Status>
  ) : (
    <Status kind="bad" id="chain-badge">
      Chain broken at entry {verify.firstBad?.seq ?? "?"}: {verify.firstBad?.reason ?? "no reason given"}
    </Status>
  );
}

function matches(entry: LedgerEntry, names: Record<string, string>, type: string, request: string, text: string): boolean {
  if (type && entry.type !== type) return false;
  if (request && !(entry.request_id ?? "").toLowerCase().includes(request.trim().toLowerCase())) return false;
  // What the row says as well as what it holds: someone searches for the words they can see.
  const searched = `${summariseEntry(entry.type, entry.payload, names)} ${JSON.stringify(entry.payload)}`.toLowerCase();
  return !text || searched.includes(text.trim().toLowerCase());
}

export function LedgerTab({ data, verify }: { data: LedgerView; verify: LedgerVerification }) {
  const [type, setType] = useState("");
  const [request, setRequest] = useState("");
  const [text, setText] = useState("");
  const types = useMemo(() => [...new Set(data.entries.map((entry) => entry.type))].sort(), [data.entries]);
  const filtered = useMemo(() => data.entries.filter((entry) => matches(entry, data.names, type, request, text)).reverse(), [data.entries, data.names, type, request, text]);
  const shown = filtered.slice(0, ROW_LIMIT);
  const filtering = Boolean(type || request || text);

  return (
    <>
      <PageHead title="Ledger" note="Every decision, in a hash chain. Core recomputes the whole chain for this badge, drills included. Drills are left out of this list and its export, so the numbers can skip, and the list can run behind Switch." aside={<ChainBadge verify={verify} />} />
      <div className="filters">
        <label>
          Type
          <select data-testid="filter-type" value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">All</option>
            {types.map((name) => (
              <option key={name} value={name}>
                {sentenceCase(name)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Request
          <input data-testid="filter-request" value={request} placeholder="CLR-0042" onChange={(event) => setRequest(event.target.value)} />
        </label>
        <label>
          Contains
          <input data-testid="filter-text" value={text} placeholder="sam, refund, ..." onChange={(event) => setText(event.target.value)} />
        </label>
        {filtering ? (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setType("");
              setRequest("");
              setText("");
            }}
          >
            Clear
          </button>
        ) : null}
        <div className="filters-end">
          <span className="muted" data-testid="ledger-count">
            {shown.length === filtered.length ? `${formatCount(filtered.length)} of ${formatCount(data.entries.length)}` : `Newest ${formatCount(shown.length)} of ${formatCount(filtered.length)} matching`}
          </span>
          <a className="link" href="/api/export.csv" download>
            Export CSV
          </a>
        </div>
      </div>
      {shown.length === 0 ? (
        <Empty title={filtering ? "No entries match these filters." : "The ledger is empty."}>{filtering ? null : "Core writes its first entry when it loads a policy."}</Empty>
      ) : (
        <table className="stack" data-testid="ledger-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Time</th>
              <th>Type</th>
              <th>Request</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.seq} data-testid={`ledger-row-${entry.seq}`}>
                <td className="num muted" data-label="Entry">
                  {entry.seq}
                </td>
                <td className="nowrap num-left" data-label="Time">
                  {formatDateTime(Date.parse(entry.at))}
                </td>
                <td className="nowrap" data-label="Type" data-testid={`ledger-type-${entry.seq}`}>
                  {sentenceCase(entry.type)}
                </td>
                <td className="nowrap" data-label="Request">
                  {entry.request_id ?? <span className="muted">–</span>}
                </td>
                <td className="cell-wide">
                  <details>
                    <summary>{summariseEntry(entry.type, entry.payload, data.names) || "Details"}</summary>
                    <pre>{JSON.stringify(entry.payload, null, 2)}</pre>
                    <div className="muted small">Hash {entry.entry_hash}</div>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ── Coverage ─────────────────────────────────────────────────────────────────

const VENDOR_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", cursor: "Cursor CLI", antigravity: "Antigravity", gate: "Through the gate" };
const EXPECTED_VENDORS = ["claude", "codex", "opencode", "cursor"];
const SOURCES: { id: string; label: string }[] = [
  { id: "hook", label: "Hook" },
  { id: "gate", label: "Gate" },
];
/** Calls this recent count as live. */
const LIVE_WINDOW_MS = 5 * 60 * 1000;

function CoverageCell({ row, vendor, source, nowMs, rowSpan, note }: { row: CoverageRow | undefined; vendor: string; source: string; nowMs: number; rowSpan?: number; note?: string }) {
  const id = `coverage-${vendor}-${source}`;
  if (!row) {
    return (
      <td data-testid={id} rowSpan={rowSpan}>
        <span className="muted">No traffic seen</span>
        {note ? <div className="muted small coverage-note">{note}</div> : null}
      </td>
    );
  }
  const lastMs = row.last_at ? Date.parse(row.last_at) : null;
  const live = lastMs !== null && nowMs - lastMs <= LIVE_WINDOW_MS;
  return (
    <td data-testid={id} rowSpan={rowSpan}>
      <div className="coverage-calls">
        <span className="strong" data-testid={`${id}-calls`}>
          {formatCount(row.calls)}
        </span>{" "}
        {row.calls === 1 ? "call" : "calls"}
      </div>
      <div className="muted small">
        <span data-testid={`${id}-allowed`}>{formatCount(row.allowed)}</span> allowed · <span data-testid={`${id}-held`}>{formatCount(row.held)}</span> held · <span data-testid={`${id}-denied`}>{formatCount(row.denied)}</span> denied
      </div>
      <div className="small" data-testid={`${id}-status`}>
        {live ? <Status kind="good">Live, {formatAge(row.last_at as string, nowMs)} ago</Status> : lastMs !== null ? <Status kind="idle">Last seen {formatAge(row.last_at as string, nowMs)} ago</Status> : <Status kind="idle">Never</Status>}
      </div>
      {note ? <div className="muted small coverage-note">{note}</div> : null}
    </td>
  );
}

const GATE_NOT_SPLIT = "All vendors together. Core records every gate call under vendor \"gate\", so it cannot split these by vendor yet.";

export function CoverageTab({ data, nowMs }: { data: CoverageView; nowMs: number }) {
  // Once core attributes gate calls to a vendor, each vendor gets its own gate cell with no change here.
  const attributed = data.vendors.some((row) => row.source === "gate" && row.vendor !== "gate");
  const sharedGate = data.vendors.find((row) => row.vendor === "gate" && row.source === "gate");
  const vendors = [...new Set([...EXPECTED_VENDORS, ...data.vendors.map((row) => row.vendor)])].filter((vendor) => attributed || vendor !== "gate");
  const sum = (key: "calls" | "held" | "denied") => data.vendors.reduce((total, row) => total + row[key], 0);
  const seen = EXPECTED_VENDORS.filter((vendor) => data.vendors.some((row) => row.vendor === vendor)).length;
  return (
    <>
      <PageHead title="Coverage" note="What each vendor has actually sent through each enforcement point. These counts are real traffic, not configuration." />
      <div className="stats">
        <Stat label="Calls seen" value={formatCount(sum("calls"))} id="coverage-total-calls" />
        <Stat label="Held" value={formatCount(sum("held"))} id="coverage-total-held" />
        <Stat label="Denied" value={formatCount(sum("denied"))} id="coverage-total-denied" />
        <Stat label="Vendors seen" value={`${seen} of ${EXPECTED_VENDORS.length}`} id="coverage-vendors-seen" />
      </div>
      <table data-testid="coverage-table">
        <thead>
          <tr>
            <th>Vendor</th>
            {SOURCES.map((source) => (
              <th key={source.id}>{source.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {vendors.map((vendor, index) => (
            <tr key={vendor}>
              <td className="strong">{VENDOR_LABELS[vendor] ?? vendor}</td>
              <CoverageCell vendor={vendor} source="hook" nowMs={nowMs} row={data.vendors.find((row) => row.vendor === vendor && row.source === "hook")} />
              {attributed ? (
                <CoverageCell vendor={vendor} source="gate" nowMs={nowMs} row={data.vendors.find((row) => row.vendor === vendor && row.source === "gate")} />
              ) : index === 0 ? (
                <CoverageCell vendor="gate" source="gate" nowMs={nowMs} row={sharedGate} rowSpan={vendors.length} note={GATE_NOT_SPLIT} />
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ── Autonomy ─────────────────────────────────────────────────────────────────

const LADDER: { level: string; name: string; meaning: string }[] = [
  { level: "L0", name: "Always ask", meaning: "A person decides every time." },
  { level: "L1", name: "Fast lane", meaning: "One eligible approver, no type-to-confirm." },
  { level: "L2", name: "Auto with review", meaning: "Runs, then a review card can reverse it for 24 h." },
  { level: "L3", name: "Auto within budget", meaning: "Runs silently up to a daily cap." },
];

function LadderMark({ level }: { level: string }) {
  const reached = LADDER.findIndex((step) => step.level === level);
  return (
    <span className="ladder" role="img" aria-label={`Level ${level}`}>
      {LADDER.map((step, index) => (
        <span key={step.level} className={index <= reached ? "ladder-step on" : "ladder-step"} />
      ))}
    </span>
  );
}

const scopeKey = (row: { agent: string; class: string; bucket: string }) => `${row.agent}/${row.class}/${row.bucket}`;
const scopeId = (row: { agent: string; class: string; bucket: string }) => `${row.agent}-${row.class}-${row.bucket}`;

function ReplayTable({ rows }: { rows: BucketReplay[] }) {
  return (
    <table className="stack" data-testid="replay-table">
      <thead>
        <tr>
          <th>Scope</th>
          <th>Level</th>
          <th className="num">Approvals counted</th>
          <th className="num">Too fast to count</th>
          <th className="num">Denied</th>
          <th className="num">Incidents</th>
          <th className="num">Approvers</th>
          <th className="num">Would have run alone</th>
          <th>Bar for promotion</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const id = `replay-${scopeId(row)}`;
          return (
            <tr key={scopeKey(row)} data-testid={id}>
              <td className="stack-full">
                <div className="strong">{row.agent}</div>
                <div className="muted small">
                  {sentenceCase(row.class)} · {row.label}
                </div>
              </td>
              <td className="nowrap" data-label="Level" data-testid={`${id}-level`}>
                {row.proposed_level ? `${row.level} to ${row.proposed_level}` : row.level}
                <div className="muted small">Highest {row.max_level}</div>
              </td>
              <td className="num" data-label="Approvals counted">
                <span data-testid={`${id}-counted`}>
                  {formatCount(row.counted)} of {formatCount(row.needs.approvals)}
                </span>
                <div className="muted small">{row.window_days} days</div>
              </td>
              <td className="num" data-label="Too fast to count" data-testid={`${id}-fast`}>
                {formatCount(row.fast_excluded)}
              </td>
              <td className="num" data-label="Denied" data-testid={`${id}-denied`}>
                {formatCount(row.denied)}
              </td>
              <td className="num" data-label="Incidents" data-testid={`${id}-incidents`}>
                {formatCount(row.incidents)}
              </td>
              <td className="num" data-label="Approvers" data-testid={`${id}-approvers`}>
                {row.approvers} of {row.needs.min_distinct_approvers}
              </td>
              <td className="num" data-label="Would have run alone">
                <span data-testid={`${id}-auto`}>{formatCount(row.would_auto)}</span>
                <div className="muted small" data-testid={`${id}-auto-split`}>
                  {formatCount(row.would_auto_approved)} approved, {formatCount(row.would_auto_denied)} denied
                </div>
              </td>
              <td data-label="Bar for promotion" data-testid={`${id}-meets`}>{row.meets_criteria ? <Status kind="good">Met</Status> : <Status kind="idle">Not yet</Status>}</td>
              <td className="nowrap" data-label="Evidence" data-testid={`${id}-evidence`}>
                {formatCount(row.real_events)} real
                {row.synthetic_events > 0 ? <div className="muted small">{formatCount(row.synthetic_events)} synthetic</div> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export type Replay = (scope: { agent: string; class: string; bucket: string }) => Promise<{ replays: BucketReplay[] }>;

/** All scopes come with the page. Picking one asks core to replay just that scope. Neither records anything. */
function ReplayPanel({ buckets, replay }: { buckets: BucketReplay[]; replay: Replay }) {
  const [scope, setScope] = useState("");
  const [picked, setPicked] = useState<BucketReplay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef("");

  const choose = async (key: string) => {
    latest.current = key;
    setScope(key);
    setPicked(null);
    setError(null);
    const row = buckets.find((bucket) => scopeKey(bucket) === key);
    if (!row) return;
    try {
      const { replays } = await replay({ agent: row.agent, class: row.class, bucket: row.bucket });
      if (latest.current === key) setPicked(replays);
    } catch (failure) {
      if (latest.current === key) setError((failure as Error).message);
    }
  };

  if (buckets.length === 0) return <Empty title="No scope has any recorded history yet." />;
  const rows = scope ? picked : buckets;
  return (
    <>
      <div className="filters">
        <label>
          Scope
          <select data-testid="replay-scope" value={scope} onChange={(event) => void choose(event.target.value)}>
            <option value="">All scopes</option>
            {buckets.map((bucket) => (
              <option key={scopeKey(bucket)} value={scopeKey(bucket)}>
                {bucket.agent} · {sentenceCase(bucket.class)} · {bucket.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? <p className="warning-line">{error}</p> : rows ? <ReplayTable rows={rows} /> : <p className="muted loading">Replaying…</p>}
    </>
  );
}

export function AutonomyTab({ data, replay }: { data: AutonomyView; replay: Replay }) {
  const history = [...data.history].reverse();
  const load = data.human_load;
  return (
    <>
      <PageHead title="Autonomy" note="What each agent has earned, per class and scope. Promotion always takes two people, who sign on its card in Switch. Demotion is instant." />
      <div className="stats">
        <Stat label="Human decisions per 100 agent actions" value={formatRate(load.per_100)} id="load-per-100" />
        <Stat label="Per 100 governed actions" value={formatRate(load.per_100_governed)} id="load-per-100-governed" />
        <Stat label="Agent actions" value={formatCount(load.agent_actions)} id="load-actions" />
        <Stat label="Human decisions" value={formatCount(load.human_decisions)} id="load-decisions" />
      </div>
      <p className="muted small after-stats">Real traffic only. Governed leaves out the work policy lets through without a thought.</p>
      <div className="ladder-legend">
        {LADDER.map((step) => (
          <div key={step.level} className="ladder-legend-item">
            <div className="strong">
              {step.level} {step.name}
            </div>
            <div className="muted small">{step.meaning}</div>
          </div>
        ))}
      </div>
      <Section title="Levels">
        {data.levels.length === 0 ? (
          <Empty title="Every agent is at L0, Always ask.">Core stores a level only once it changes from the default.</Empty>
        ) : (
          <table className="stack" data-testid="autonomy-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Class</th>
                <th>Scope</th>
                <th>Level</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {data.levels.map((row) => (
                <tr key={scopeKey(row)} data-testid={`autonomy-row-${scopeId(row)}`}>
                  <td className="strong stack-full">{row.agent}</td>
                  <td data-label="Class">{sentenceCase(row.class)}</td>
                  <td data-label="Scope">{sentenceCase(row.bucket)}</td>
                  <td data-label="Level">
                    <LadderMark level={row.level} /> <span data-testid={`autonomy-level-${scopeId(row)}`}>{row.level}</span>
                  </td>
                  <td className="nowrap" data-label="Since">
                    {formatDateTime(row.since)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Proposals">
        {data.proposals.length === 0 ? (
          <Empty title="No promotion has been proposed yet.">Core proposes one when a scope clears its bar.</Empty>
        ) : (
          <table className="stack" data-testid="proposal-table">
            <thead>
              <tr>
                <th>Proposal</th>
                <th>State</th>
                <th>Signed</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.proposals.map((proposal) => (
                <tr key={proposal.id} data-testid={`proposal-${proposal.id}`}>
                  <td className="cell-wide">
                    <div className="strong">{proposal.title}</div>
                    <details>
                      <summary>The record behind it</summary>
                      <pre>{proposal.detail}</pre>
                    </details>
                  </td>
                  <td data-label="State" data-testid={`proposal-${proposal.id}-state`}>{sentenceCase(proposal.state)}</td>
                  <td data-label="Signed">
                    <span data-testid={`proposal-${proposal.id}-signed`}>
                      {proposal.signed_by.length} of {proposal.quorum}
                    </span>
                    {proposal.signed_by.length > 0 ? <div className="muted small">{joinNames(proposal.signed_by)}</div> : null}
                  </td>
                  <td className="nowrap stack-full" data-label="When">{proposal.decided_at ? `Decided ${formatDateTime(Date.parse(proposal.decided_at))}` : `Expires ${formatDateTime(Date.parse(proposal.expires_at))}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="What it would have done">
        <p className="muted section-note" data-testid="replay-note">
          Each scope's next level, replayed over its recorded history. This reads the record and changes nothing. On record: {formatCount(data.evidence.real)} real, {formatCount(data.evidence.synthetic)} labelled synthetic.
        </p>
        <ReplayPanel buckets={data.buckets} replay={replay} />
      </Section>
      <Section title="Human decisions by class">
        {load.by_class.length === 0 ? (
          <Empty title="No real traffic yet." />
        ) : (
          <table className="stack" data-testid="load-table">
            <thead>
              <tr>
                <th>Class</th>
                <th className="num">Agent actions</th>
                <th className="num">Human decisions</th>
                <th className="num">Per 100</th>
              </tr>
            </thead>
            <tbody>
              {load.by_class.map((row) => (
                <tr key={row.class}>
                  <td className="strong-on-phone stack-full">{sentenceCase(row.class)}</td>
                  <td className="num" data-label="Agent actions" data-testid={`load-${row.class}-actions`}>
                    {formatCount(row.agent_actions)}
                  </td>
                  <td className="num" data-label="Human decisions" data-testid={`load-${row.class}-decisions`}>
                    {formatCount(row.human_decisions)}
                  </td>
                  <td className="num" data-label="Per 100" data-testid={`load-${row.class}-per-100`}>
                    {formatRate(row.per_100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="History">
        {history.length === 0 ? (
          <Empty title="No promotions or demotions recorded yet." />
        ) : (
          <table className="stack" data-testid="autonomy-history">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.seq}>
                  <td className="nowrap" data-label="Time">
                    {formatDateTime(Date.parse(entry.at))}
                  </td>
                  <td className="nowrap" data-label="Event">
                    {sentenceCase(entry.type)}
                  </td>
                  <td className="cell-wide">{summariseEntry(entry.type, entry.payload, data.names)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

// ── People ───────────────────────────────────────────────────────────────────

/** "eng-leads" is an id in team.yaml. On a page it reads as "Eng leads". */
const plainName = (id: string) => sentenceCase(id.replace(/-/g, " "));

function teamDrillsText(drills: TeamDrills): string {
  const why = "so that nobody's own result can be worked out.";
  if (drills.finished === 0) return `Drill totals appear once ${drills.group} have finished, ${why}`;
  return `${drills.finished} finished: ${drills.caught} caught, ${drills.missed} missed, ${drills.expired} not answered. Totals move in steps of ${drills.group}, ${why}`;
}

function TeamView({ data }: { data: PeopleView }) {
  const { team } = data;
  return (
    <>
      <div className="stats">
        <Stat label="Answers" value={formatCount(team.answers)} id="team-answers" />
        <Stat label="Approved" value={formatCount(team.approvals)} id="team-approvals" />
        <Stat label="Denied" value={formatCount(team.denials)} id="team-denials" />
        <Stat label="Fast approvals" value={formatCount(team.fast_approvals)} id="team-fast" />
        <Stat label="Flags ignored" value={formatCount(team.flags_ignored)} id="team-flags" />
        <Stat label="Batch approvals" value={formatCount(team.batch_approvals)} id="team-batch" />
        <Stat label="Streaks" value={formatCount(team.streaks)} id="team-streaks" />
        <Stat label="Drills finished" value={formatCount(team.drills.finished)} id="team-drills-finished" />
      </div>
      <p className="muted small after-stats" data-testid="team-drills">
        {teamDrillsText(team.drills)}
      </p>
      <p className="muted small after-stats">Time to answer isn't totalled here, because medians don't add up across people.</p>
      <Section title="The team">
        <table className="stack" data-testid="people-table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Groups</th>
              <th>Roles</th>
              <th>Away</th>
            </tr>
          </thead>
          <tbody>
            {data.people.map((row) => (
              <tr key={row.id} data-testid={`people-row-${row.id}`}>
                <td className="strong stack-full">{row.name}</td>
                <td data-label="Groups">{row.groups.map(plainName).join(", ") || "–"}</td>
                <td data-label="Roles">{row.roles.map(plainName).join(", ") || "–"}</td>
                <td className="stack-full" data-label="Away" data-testid={`people-away-${row.id}`}>
                  {row.away ? `Until ${formatDateTime(Date.parse(row.away.until))}${row.away.delegate_to ? `, ${data.people.find((person) => person.id === row.away?.delegate_to)?.name ?? row.away.delegate_to} covering` : ""}` : <span className="muted">–</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

const TIER_ORDER = ["low", "medium", "high", "critical"];

/**
 * Time to answer by tier: careful review takes longer as risk rises, so a flat row of bars is the thing to look for.
 * Bars inside a table, so the numbers are always there to read. One hue and one scale, with the value at each tip.
 */
function TierChart({ byTier }: { byTier: PersonDetail["stats"]["by_tier"] }) {
  const longest = Math.max(0, ...TIER_ORDER.map((tier) => byTier[tier]?.median_latency_ms ?? 0));
  return (
    <table className="tier-chart fits" data-testid="person-tier-chart">
      <thead>
        <tr>
          <th>Tier</th>
          <th>Median time to answer</th>
          <th className="num">Answers</th>
        </tr>
      </thead>
      <tbody>
        {TIER_ORDER.map((tier) => {
          const row = byTier[tier];
          const ms = row?.median_latency_ms ?? null;
          const answers = row?.answers ?? 0;
          return (
            <tr key={tier}>
              <td className="tier-chart-label">
                <TierMark tier={tier} />
              </td>
              <td className="bar-cell">
                {ms === null ? (
                  <span className="muted" data-testid={`person-tier-${tier}-latency`}>
                    No answers
                  </span>
                ) : (
                  <div className="bar-row" title={`${sentenceCase(tier)} tier: median ${formatLatency(ms)} over ${answers} ${answers === 1 ? "answer" : "answers"}`}>
                    <span className="bar" style={{ width: `calc((100% - 96px) * ${longest > 0 ? ms / longest : 0})` }} />
                    <span className="bar-value" data-testid={`person-tier-${tier}-latency`}>
                      {formatLatency(ms)}
                    </span>
                  </div>
                )}
              </td>
              <td className="num" data-testid={`person-tier-${tier}-answers`}>
                {formatCount(answers)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const NAMED_SIGNALS = new Set(["fast", "streak", "batch", "flag_ignored"]);

/** One person's record, for the admin. The Desk has no login, so this says what it is on every view of it. */
export function PersonRecord({ data }: { data: PersonDetail }) {
  const { stats, name } = data;
  const finished = stats.drills.caught + stats.drills.missed + stats.drills.expired;
  const otherSignals = Object.entries(stats.signals).filter(([signal]) => !NAMED_SIGNALS.has(signal));
  const friction = frictionWords(stats.friction);
  return (
    <>
      <p className="admin-banner" role="note" data-testid="people-admin-banner">
        <span className="strong">Admin's view of {name}.</span> Private to {name} and the team admin. This Desk has no login, so don't show this screen to the team.
      </p>
      <div className="stats">
        <Stat label="Answers" value={formatCount(stats.answers)} id="person-answers" />
        <Stat label="Approved" value={formatCount(stats.approvals)} id="person-approvals" />
        <Stat label="Denied" value={formatCount(stats.denials)} id="person-denials" />
        <Stat label="Median time to answer" value={formatLatency(stats.median_latency_ms)} id="person-latency" />
      </div>
      <div className="person-grid">
        <Section title="Time to answer, by risk">
          <TierChart byTier={stats.by_tier} />
          <p className="muted small section-foot">Careful review takes longer as risk rises. Bars that stay flat across tiers can mean cards aren't being read.</p>
        </Section>
        <Section title="Attention signals">
          <table className="fits" data-testid="person-signals">
            <tbody>
              <tr>
                <td>Fast approvals</td>
                <td className="num" data-testid="person-fast">
                  {formatCount(stats.fast_approvals)}
                </td>
              </tr>
              <tr>
                <td>Flags ignored</td>
                <td className="num" data-testid="person-flags">
                  {formatCount(stats.flags_ignored)}
                </td>
              </tr>
              <tr>
                <td>Batch approvals</td>
                <td className="num" data-testid="person-batch">
                  {formatCount(stats.batch_approvals)}
                </td>
              </tr>
              <tr>
                <td>Streaks</td>
                <td className="num" data-testid="person-streaks">
                  {formatCount(stats.streaks)}
                </td>
              </tr>
              {otherSignals.map(([signal, count]) => (
                <tr key={signal}>
                  <td>{sentenceCase(signal)}</td>
                  <td className="num" data-testid={`person-signal-${signal}`}>
                    {formatCount(count)}
                  </td>
                </tr>
              ))}
              <tr>
                <td>Refused as ineligible</td>
                <td className="num" data-testid="person-ineligible">
                  {formatCount(stats.ineligible)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted small section-foot" data-testid="person-friction">
            {friction ? `Extra friction is on, after ${friction}: the next high-tier card asks for a typed value.` : "No extra friction is on."}
          </p>
        </Section>
      </div>
      <Section title="Drills">
        <div className="stats">
          <Stat label="Finished" value={formatCount(finished)} id="person-drills-finished" />
          <Stat label="Caught" value={formatCount(stats.drills.caught)} id="person-drills-caught" />
          <Stat label="Missed" value={formatCount(stats.drills.missed)} id="person-drills-missed" />
          <Stat label="Catch rate" value={formatPercent(stats.drills.catch_rate)} id="person-drills-rate" />
        </div>
        <p className="muted small after-stats" data-testid="person-drills-note">
          {formatCount(stats.drills.expired)} not answered. The catch rate counts caught against missed, so a drill nobody answered counts for neither. Each result goes only to {name}.
        </p>
      </Section>
    </>
  );
}

export function PeopleTab({ data, viewing, onView, children }: { data: PeopleView; viewing: string; onView: (id: string) => void; children?: ReactNode }) {
  const person = data.people.find((row) => row.id === viewing);
  return (
    <>
      <PageHead
        title="People"
        note={person ? `One person's record, as only ${person.name} and the team admin should see it.` : "Totals for the whole team. One person's times, flags and drill results are private to that person and the team admin, so they appear only in the admin's view."}
        aside={
          <label className="inline-label">
            Showing
            <select data-testid="people-view" value={person ? viewing : ""} onChange={(event) => onView(event.target.value)}>
              <option value="">The team</option>
              {data.people.map((row) => (
                <option key={row.id} value={row.id}>
                  Admin's view: {row.name}
                </option>
              ))}
            </select>
          </label>
        }
      />
      {person ? children : <TeamView data={data} />}
    </>
  );
}

// ── Policy ───────────────────────────────────────────────────────────────────

export const SIMULATOR_PRESETS: Record<string, { label: string; agent: string; endpoint: string; args: Record<string, unknown> }> = {
  refund: { label: "Refund ₹40,000 on a ₹4,000 order", agent: "refunds-agent", endpoint: "POST /acme/refunds", args: { order_id: "A-1931", customer_id: "cus_8812", amount: 40000, destination: "meera.k@okaxis" } },
  deploy: { label: "Deploy checkout v2.14.0 to prod", agent: "ops-agent", endpoint: "POST /acme/deploys", args: { service: "checkout", env: "prod", version: "v2.14.0" } },
  email: { label: "Email customers.csv outside the company", agent: "support-agent", endpoint: "POST /acme/emails", args: { to: "auditor@freemail.example", subject: "Customer list", body: "", attachments: ["customers.csv"] } },
};

export function presetAction(key: string): string {
  const preset = SIMULATOR_PRESETS[key]!;
  return JSON.stringify(
    {
      action: {
        id: "desk-simulation",
        at: new Date().toISOString(),
        source: "gate",
        vendor: "gate",
        agent: { name: preset.agent },
        kind: "business",
        raw: null,
        business: { endpoint: preset.endpoint, args: preset.args },
      },
    },
    null,
    2,
  );
}

export type Simulate = (body: string) => Promise<SimulationResult>;

export function Simulator({ simulate }: { simulate: Simulate }) {
  const [preset, setPreset] = useState("refund");
  const [body, setBody] = useState(() => presetAction("refund"));
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await simulate(body));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="simulator" onSubmit={(event) => void run(event)}>
      <div className="simulator-input">
        <label>
          Example
          <select
            data-testid="simulator-preset"
            value={preset}
            onChange={(event) => {
              setPreset(event.target.value);
              setBody(presetAction(event.target.value));
              setResult(null);
            }}
          >
            {Object.entries(SIMULATOR_PRESETS).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          The call
          <textarea data-testid="simulator-body" rows={12} spellCheck={false} value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
        <button type="submit" className="primary" disabled={busy} data-testid="simulator-run">
          {busy ? "Checking…" : "Run the policy on this call"}
        </button>
      </div>
      <div className="simulator-result" data-testid="simulator-result">
        {error ? <p className="warning-line">{error}</p> : null}
        {result ? (
          <dl>
            <dt>Decision</dt>
            <dd className="strong" data-testid="simulator-decision">
              {sentenceCase(result.decision)}
            </dd>
            <dt>Class</dt>
            <dd>{result.class ?? "–"}</dd>
            <dt>Tier</dt>
            <dd>{result.tier ? <TierMark tier={result.tier} /> : "–"}</dd>
            <dt>Score</dt>
            <dd>{result.score ?? "–"}</dd>
            <dt>Flags</dt>
            <dd>{result.flags && result.flags.length > 0 ? result.flags.map((flag) => flag.text).join("; ") : "None"}</dd>
            <dt>Reason</dt>
            <dd>{result.reason}</dd>
          </dl>
        ) : !error ? (
          <p className="muted">Runs the policy core has loaded over this one call. Nothing is recorded and nothing runs.</p>
        ) : null}
      </div>
    </form>
  );
}

/** Only one of these is a match, and none is an alarm: core's version is the one in force either way. */
function policyStanding(data: PolicyView): { status: string; explain: string | null } {
  const version = shortHash(data.core_hash);
  const file = data.file_hash ? shortHash(data.file_hash) : "";
  switch (data.relation) {
    case "same":
      return { status: `Core is enforcing this file · version ${version}`, explain: null };
    case "signed":
      return {
        status: `Core is enforcing a signed version · ${version}`,
        explain: `Signed by ${joinNames(data.signed_by)}. Core keeps a signed policy and doesn't write it back to the file, so the file on disk (${file}) differs. That is expected: core's version is the one in force.`,
      };
    case "file_pending":
      return {
        status: `Core is enforcing version ${version}`,
        explain: `The file on disk (${file}) has been edited, and the edit is waiting for signatures. Core keeps enforcing ${version} until it is signed.`,
      };
    case "differs":
      return {
        status: `Core is enforcing version ${version}`,
        explain: `The file on disk (${file}) isn't what core is enforcing. Core's version is the one in force: an edit to the file takes effect only once it is signed.`,
      };
    case "no_file":
      return { status: `Core is enforcing version ${version}`, explain: "The Desk can't read the policy file to compare, so this page shows core's own copy." };
  }
}

export function PolicyTab({ data, simulate }: { data: PolicyView; simulate: Simulate }) {
  const standing = policyStanding(data);
  return (
    <>
      <PageHead
        title="Policy"
        note={`The policy in force, one view for every agent and vendor. Mode: ${data.mode ?? "not set"}.`}
        aside={
          <Status kind={data.relation === "same" ? "good" : "idle"} id="policy-hash">
            {standing.status}
          </Status>
        }
      />
      {standing.explain ? (
        <p className="note-line" data-testid="policy-relation">
          {standing.explain}
        </p>
      ) : null}
      {data.mode === "shadow" ? (
        <p className="note-line" data-testid="policy-shadow">
          Shadow mode: Clearance holds nothing and records what it would have held. {formatCount(data.shadow_would_hold)} {data.shadow_would_hold === 1 ? "call" : "calls"} so far.
        </p>
      ) : null}
      {data.policy_error ? (
        <p className="warning-line" data-testid="policy-error">
          <span aria-hidden="true">⚠</span> Core refused its last reload and kept the previous policy: {data.policy_error}
        </p>
      ) : null}
      {data.pending ? (
        <Section title="Waiting for signatures">
          <div className="pending" data-testid="policy-pending">
            <div>
              <span className="strong">{data.pending.proposal}</span> <span className="muted">· version {shortHash(data.pending.hash)}</span>
            </div>
            <div data-testid="policy-pending-signed">
              {data.pending.signed_by.length} of {data.pending.quorum} signed{data.pending.signed_by.length > 0 ? `: ${joinNames(data.pending.signed_by)}` : ""}
            </div>
            <details>
              <summary>What it changes</summary>
              <pre data-testid="policy-pending-detail">{data.pending.detail}</pre>
            </details>
            <div className="muted small">Signed on its card in Switch. Nothing changes until then.</div>
          </div>
        </Section>
      ) : null}
      <Section title="Classes">
        <table className="stack" data-testid="policy-table">
          <thead>
            <tr>
              <th>Class</th>
              <th className="num">Base score</th>
              <th className="num">Rules</th>
              <th>Approvers</th>
              <th>Quorum</th>
              <th>Reversible</th>
              <th className="num">Ladder steps</th>
              <th>Highest autonomy</th>
            </tr>
          </thead>
          <tbody>
            {data.classes.map((row) => (
              <tr key={row.name} data-testid={`policy-class-${row.name}`}>
                <td className="stack-full">
                  <div className="strong">{sentenceCase(row.name)}</div>
                </td>
                {row.decision === "deny" ? (
                  <td colSpan={7} className="muted stack-full">
                    Always denied, with a reason. Never routed to anyone.
                  </td>
                ) : (
                  <>
                    <td className="num" data-label="Base score">
                      {row.base ?? "–"}
                    </td>
                    <td className="num" data-label="Rules">
                      {row.rules}
                    </td>
                    <td data-label="Approvers">{row.approvers ?? "–"}</td>
                    <td data-label="Quorum">{row.quorum || "–"}</td>
                    <td data-label="Reversible">{row.reversible === null ? "–" : row.reversible ? "Yes" : "No"}</td>
                    <td className="num" data-label="Ladder steps">
                      {row.escalation_steps}
                    </td>
                    <td data-label="Highest autonomy">{row.max_level ?? "–"}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small tier-line">
          Tiers by score:{" "}
          {data.tiers.map((tier, index) => (
            <span key={tier.name}>
              {index > 0 ? " · " : ""}
              {sentenceCase(tier.name)} from {tier.from}
            </span>
          ))}
        </p>
      </Section>
      <Section title="Try a call">
        <Simulator simulate={simulate} />
      </Section>
      <Section title="The policy in force">
        <details className="policy-file">
          <summary>
            Show it <span className="muted">(version {shortHash(data.core_hash)})</span>
          </summary>
          <pre data-testid="policy-text">{data.text}</pre>
        </details>
      </Section>
    </>
  );
}
