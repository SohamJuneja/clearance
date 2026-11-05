import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { AutonomyView, CoverageView, Health, LedgerVerification, LedgerView, Meta, PeopleView, PolicyView, QueueView } from "../shared/api";
import { getJson, simulate } from "./api";
import { shortHash } from "./format";
import { ErrorPanel } from "./parts";
import { AutonomyTab, CoverageTab, LedgerTab, PeopleTab, PolicyTab, QueueTab } from "./views";

const TABS = ["queue", "ledger", "people", "autonomy", "coverage", "policy"] as const;
type TabId = (typeof TABS)[number];
const TAB_NAMES: Record<TabId, string> = { queue: "Queue", ledger: "Ledger", people: "People", autonomy: "Autonomy", coverage: "Coverage", policy: "Policy" };

const POLL_MS = 3000;

function tabFromHash(): TabId {
  const name = window.location.hash.replace(/^#\/?/, "");
  return (TABS as readonly string[]).includes(name) ? (name as TabId) : "queue";
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function useApi<T>(path: string, poll = true): UseQueryResult<T> {
  return useQuery<T>({ queryKey: [path], queryFn: () => getJson<T>(path), refetchInterval: poll ? POLL_MS : false });
}

/** Shows data only while it is current. A failed refresh replaces the numbers rather than leaving old ones up. */
function Loaded<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isError) return <ErrorPanel message={query.error.message} />;
  if (query.data === undefined) return <p className="muted loading">Loading…</p>;
  return <>{children(query.data)}</>;
}

function QueuePage({ nowMs }: { nowMs: number }) {
  return <Loaded query={useApi<QueueView>("/api/queue")}>{(data) => <QueueTab data={data} nowMs={nowMs} />}</Loaded>;
}

function LedgerPage() {
  const entries = useApi<LedgerView>("/api/ledger");
  const verify = useApi<LedgerVerification>("/api/ledger/verify");
  return <Loaded query={entries}>{(data) => <Loaded query={verify}>{(chain) => <LedgerTab data={data} verify={chain} />}</Loaded>}</Loaded>;
}

function PeoplePage({ nowMs }: { nowMs: number }) {
  return <Loaded query={useApi<PeopleView>("/api/people")}>{(data) => <PeopleTab data={data} nowMs={nowMs} />}</Loaded>;
}

function AutonomyPage() {
  return <Loaded query={useApi<AutonomyView>("/api/autonomy")}>{(data) => <AutonomyTab data={data} />}</Loaded>;
}

function CoveragePage({ nowMs }: { nowMs: number }) {
  return <Loaded query={useApi<CoverageView>("/api/coverage")}>{(data) => <CoverageTab data={data} nowMs={nowMs} />}</Loaded>;
}

function PolicyPage() {
  return <Loaded query={useApi<PolicyView>("/api/policy")}>{(data) => <PolicyTab data={data} simulate={simulate} />}</Loaded>;
}

function CoreStatus({ synthetic }: { synthetic: boolean }) {
  const health = useApi<Health>("/api/health");
  if (synthetic) {
    return (
      <span className="status status-idle" data-testid="core-status">
        <span aria-hidden="true">–</span> No core: fixture data
      </span>
    );
  }
  if (health.isError) {
    return (
      <span className="status status-bad" data-testid="core-status">
        <span aria-hidden="true">✕</span> Core not reachable
      </span>
    );
  }
  if (!health.data) return <span className="muted">Connecting…</span>;
  return (
    <span className="status status-good" data-testid="core-status">
      <span aria-hidden="true">✓</span> Core connected <span className="muted">· policy {shortHash(health.data.policy_hash)}</span>
    </span>
  );
}

export function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const nowMs = useNow();
  const meta = useApi<Meta>("/api/meta", false);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.title = meta.data?.synthetic ? "SYNTHETIC · Clearance Desk" : "Clearance Desk";
  }, [meta.data?.synthetic]);

  return (
    <>
      {meta.data?.synthetic ? (
        <div className="synthetic-banner" role="alert" data-testid="synthetic-banner">
          SYNTHETIC DATA. Demo fixture for screenshots: none of these requests, people's numbers or ledger entries are real.
        </div>
      ) : null}
      <header className="top">
        <div className="top-inner">
          <div className="brand">Clearance Desk</div>
          <nav className="tabs" aria-label="Desk sections">
            {TABS.map((id) => (
              <a key={id} href={`#/${id}`} className={id === tab ? "tab active" : "tab"} data-label={TAB_NAMES[id]} aria-current={id === tab ? "page" : undefined} data-testid={`tab-${id}`}>
                {TAB_NAMES[id]}
              </a>
            ))}
          </nav>
          <div className="top-end">
            <span className="muted small">Read-only. Decisions happen in Switch.</span>
            <CoreStatus synthetic={meta.data?.synthetic ?? false} />
          </div>
        </div>
      </header>
      <main className="page">
        {tab === "queue" ? <QueuePage nowMs={nowMs} /> : null}
        {tab === "ledger" ? <LedgerPage /> : null}
        {tab === "people" ? <PeoplePage nowMs={nowMs} /> : null}
        {tab === "autonomy" ? <AutonomyPage /> : null}
        {tab === "coverage" ? <CoveragePage nowMs={nowMs} /> : null}
        {tab === "policy" ? <PolicyPage /> : null}
      </main>
    </>
  );
}
