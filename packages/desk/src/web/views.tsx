/**
 * The six tabs as plain functions of API data and the time, so tests can check every number without a
 * browser. Nothing here fetches, and nothing here decides: all approving and denying happens in Switch.
 */
import { useMemo, useState, type FormEvent } from "react";
import type {
  AutonomyView,
  CoverageRow,
  CoverageView,
  LedgerEntry,
  LedgerVerification,
  LedgerView,
  PeopleView,
  PolicyView,
  QueueItem,
  QueueView,
  SimulationResult,
} from "../shared/api";
import {
  formatAge,
  formatCount,
  formatDateTime,
  formatLatency,
  formatUntil,
  sentenceCase,
  shortHash,
  stateName,
  summariseEntry,
} from "./format";
import { Empty, NotAvailable, PageHead, Section, Stat, Status, TierMark } from "./parts";

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
      <td>
        <TierMark tier={item.tier} />
        <div className="muted small" data-testid={`queue-score-${item.id}`}>
          Score {item.score}
        </div>
      </td>
      <td data-testid={`queue-waiting-${item.id}`}>
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
      <td className="num" data-testid={`queue-age-${item.id}`}>
        {formatAge(item.created_at, nowMs)}
      </td>
      <td>
        <div data-testid={`queue-escalation-${item.id}`}>{escalationText(item)}</div>
        {escalationNote(item) ? <div className="muted small">{escalationNote(item)}</div> : null}
      </td>
      <td className="num" data-testid={`queue-expires-${item.id}`}>
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
      <PageHead title="Queue" note="Requests waiting on a person. Each one is answered on its card in Switch, using the handle shown here." />
      <div className="stats">
        <Stat label="Open requests" value={data.open_count} id="queue-open" />
        <Stat label="Oldest waiting" value={oldest ? formatAge(oldest, nowMs) : "–"} id="queue-oldest" />
        <Stat label="Escalated" value={data.requests.filter((item) => item.escalation.fired > 0).length} id="queue-escalated" />
        <Stat label="Critical tier" value={data.requests.filter((item) => item.tier === "critical").length} id="queue-critical" />
      </div>
      {data.disagreement ? (
        <p className="warning-line" data-testid="queue-disagreement">
          <span aria-hidden="true">⚠</span> {data.disagreement}
        </p>
      ) : null}
      {sorted.length === 0 ? (
        <Empty title="Nothing is waiting on a person.">Held requests appear here as soon as an agent is stopped.</Empty>
      ) : (
        <table data-testid="queue-table">
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
      Chain intact · {formatCount(verify.count)} entries · head {shortHash(verify.head)}
    </Status>
  ) : (
    <Status kind="bad" id="chain-badge">
      Chain broken at entry {verify.firstBad?.seq ?? "?"}: {verify.firstBad?.reason ?? "no reason given"}
    </Status>
  );
}

function matches(entry: LedgerEntry, type: string, request: string, text: string): boolean {
  if (type && entry.type !== type) return false;
  if (request && !(entry.request_id ?? "").toLowerCase().includes(request.toLowerCase())) return false;
  if (text && !JSON.stringify(entry.payload).toLowerCase().includes(text.toLowerCase())) return false;
  return true;
}

export function LedgerTab({ data, verify }: { data: LedgerView; verify: LedgerVerification }) {
  const [type, setType] = useState("");
  const [request, setRequest] = useState("");
  const [text, setText] = useState("");
  const types = useMemo(() => [...new Set(data.entries.map((entry) => entry.type))].sort(), [data.entries]);
  const filtered = useMemo(() => data.entries.filter((entry) => matches(entry, type, request, text)).reverse(), [data.entries, type, request, text]);
  const shown = filtered.slice(0, ROW_LIMIT);
  const filtering = Boolean(type || request || text);

  return (
    <>
      <PageHead title="Ledger" note="Every decision, in a hash chain. Core recomputes the chain from the first entry for this badge." aside={<ChainBadge verify={verify} />} />
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
        <table data-testid="ledger-table">
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
                <td className="num muted">{entry.seq}</td>
                <td className="nowrap num-left">{formatDateTime(Date.parse(entry.at))}</td>
                <td className="nowrap" data-testid={`ledger-type-${entry.seq}`}>
                  {sentenceCase(entry.type)}
                </td>
                <td className="nowrap">{entry.request_id ?? <span className="muted">–</span>}</td>
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

export function AutonomyTab({ data }: { data: AutonomyView }) {
  const history = [...data.history].reverse();
  return (
    <>
      <PageHead title="Autonomy" note="What each agent has earned, per class and scope. Promotion always takes two people. Demotion is instant." />
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
          <table data-testid="autonomy-table">
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
                <tr key={`${row.agent}/${row.class}/${row.bucket}`} data-testid={`autonomy-row-${row.agent}-${row.class}-${row.bucket}`}>
                  <td className="strong">{row.agent}</td>
                  <td>{sentenceCase(row.class)}</td>
                  <td>{sentenceCase(row.bucket)}</td>
                  <td>
                    <LadderMark level={row.level} /> <span data-testid={`autonomy-level-${row.agent}-${row.class}-${row.bucket}`}>{row.level}</span>
                  </td>
                  <td className="nowrap">{formatDateTime(row.since)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Proposals and history">
        {history.length === 0 ? (
          <Empty title="No promotions or demotions recorded yet." />
        ) : (
          <table data-testid="autonomy-history">
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
                  <td className="nowrap">{formatDateTime(Date.parse(entry.at))}</td>
                  <td className="nowrap">{sentenceCase(entry.type)}</td>
                  <td className="cell-wide">{summariseEntry(entry.type, entry.payload)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Replay and impact">
        <div className="not-available-row">
          <NotAvailable what="Replay of a proposed promotion" needs="Core's POST /v1/autonomy/simulate answers 501." id="na-replay" />
          <NotAvailable what="Human decisions per 100 agent actions" needs="Core has no route for this. pnpm eval:autonomy is its source." id="na-decisions" />
        </div>
      </Section>
    </>
  );
}

// ── People ───────────────────────────────────────────────────────────────────

export function PeopleTab({ data, nowMs }: { data: PeopleView; nowMs: number }) {
  const [viewing, setViewing] = useState("");
  const person = data.people.find((row) => row.id === viewing);
  const rows = person ? [person] : data.people;
  return (
    <>
      <PageHead
        title="People"
        note="Private: visible to each person and the team admin. This Desk has no login, so it runs on the admin's machine and only answers on loopback."
        aside={
          <label className="inline-label">
            Viewing
            <select data-testid="people-view" value={viewing} onChange={(event) => setViewing(event.target.value)}>
              <option value="">Everyone (admin)</option>
              {data.people.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        }
      />
      <table data-testid="people-table">
        <thead>
          <tr>
            <th>Person</th>
            <th className="num">Open cards</th>
            <th className="num">Answers</th>
            <th className="num">Approved</th>
            <th className="num">Denied</th>
            <th className="num">Refused as ineligible</th>
            <th className="num">Median time to answer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid={`people-row-${row.id}`}>
              <td>
                <div className="strong">{row.name}</div>
                <div className="muted small">{[...row.groups, ...row.roles].join(" · ")}</div>
              </td>
              {row.stats ? (
                <>
                  <td className="num" data-testid={`people-${row.id}-open`}>
                    {row.stats.open_cards}
                  </td>
                  <td className="num" data-testid={`people-${row.id}-answers`}>
                    {row.stats.answers}
                  </td>
                  <td className="num" data-testid={`people-${row.id}-approvals`}>
                    {row.stats.approvals}
                  </td>
                  <td className="num" data-testid={`people-${row.id}-denials`}>
                    {row.stats.denials}
                  </td>
                  <td className="num" data-testid={`people-${row.id}-ineligible`}>
                    {row.stats.ineligible}
                  </td>
                  <td className="num" data-testid={`people-${row.id}-latency`}>
                    {formatLatency(row.stats.median_latency_ms)}
                  </td>
                </>
              ) : (
                <td colSpan={6} className="muted" data-testid={`people-${row.id}-unknown`}>
                  Core does not know this person yet.
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {person ? (
        <Section title={`Cards open for ${person.name}`}>
          {person.inbox.length === 0 ? (
            <Empty title={`Nothing is waiting on ${person.name}.`} />
          ) : (
            <table data-testid="people-inbox">
              <thead>
                <tr>
                  <th>Handle</th>
                  <th>Request</th>
                  <th>What</th>
                  <th>Room</th>
                  <th className="num">Expires</th>
                </tr>
              </thead>
              <tbody>
                {person.inbox.map((item) => (
                  <tr key={item.request_id}>
                    <td>{item.handle ? <code>{item.handle}</code> : "–"}</td>
                    <td className="nowrap">{item.request_id}</td>
                    <td className="cell-wide">{item.what}</td>
                    <td>{item.room ?? "–"}</td>
                    <td className="num">{formatUntil(item.expires_at, nowMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      ) : null}
      <Section title="Attention signals">
        <div className="not-available-row">
          <NotAvailable what="Latency against tier" needs="GET /v1/people/:id/stats reports one median across all tiers." id="na-latency-tier" />
          <NotAvailable what="Rubber-stamp signals" needs="The stats route does not report fast approvals or ignored flags." id="na-signals" />
          <NotAvailable what="Drill catch rate" needs="The stats route does not report drill results." id="na-drills" />
        </div>
      </Section>
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

export function PolicyTab({ data, simulate }: { data: PolicyView; simulate: Simulate }) {
  return (
    <>
      <PageHead
        title="Policy"
        note={`The policy file, one view for every agent and vendor. Mode: ${data.mode ?? "not set"}.`}
        aside={
          data.matches ? (
            <Status kind="good" id="policy-hash">
              Core is enforcing this file · version {shortHash(data.core_hash)}
            </Status>
          ) : (
            <Status kind="bad" id="policy-hash">
              Core is enforcing {shortHash(data.core_hash)}, but this file is {shortHash(data.file_hash)}
            </Status>
          )
        }
      />
      {data.policy_error ? (
        <p className="warning-line" data-testid="policy-error">
          <span aria-hidden="true">⚠</span> Core refused its last reload and kept the previous policy: {data.policy_error}
        </p>
      ) : null}
      <Section title="Classes">
        <table data-testid="policy-table">
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
                <td>
                  <div className="strong">{sentenceCase(row.name)}</div>
                </td>
                {row.decision === "deny" ? (
                  <td colSpan={7} className="muted">
                    Always denied, with a reason. Never routed to anyone.
                  </td>
                ) : (
                  <>
                    <td className="num">{row.base ?? "–"}</td>
                    <td className="num">{row.rules}</td>
                    <td>{row.approvers ?? "–"}</td>
                    <td>{row.quorum || "–"}</td>
                    <td>{row.reversible === null ? "–" : row.reversible ? "Yes" : "No"}</td>
                    <td className="num">{row.escalation_steps}</td>
                    <td>{row.max_level ?? "–"}</td>
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
      <Section title="The file">
        <details className="policy-file">
          <summary>
            Show clearance.policy.yaml <span className="muted">(version {shortHash(data.file_hash)})</span>
          </summary>
          <pre data-testid="policy-text">{data.text}</pre>
        </details>
      </Section>
    </>
  );
}
