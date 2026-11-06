/** The small pieces every tab shares. Status colour always comes with a word, never on its own. */
import type { ReactNode } from "react";
import type { Tier } from "../shared/api";
import { sentenceCase } from "./format";

export function PageHead({ title, note, aside }: { title: string; note: string; aside?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p className="muted">{note}</p>
      </div>
      {aside}
    </div>
  );
}

export function Stat({ label, value, id }: { label: string; value: string | number; id: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" data-testid={id}>
        {value}
      </div>
    </div>
  );
}

export function TierMark({ tier }: { tier: Tier | string }) {
  return (
    <span className={`tier tier-${tier}`}>
      <span className="tier-dot" aria-hidden="true" />
      {sentenceCase(tier)}
    </span>
  );
}

/** A status with its icon and its word. */
export function Status({ kind, children, id }: { kind: "good" | "bad" | "idle"; children: ReactNode; id?: string }) {
  const icon = kind === "good" ? "✓" : kind === "bad" ? "✕" : "–";
  return (
    <span className={`status status-${kind}`} data-testid={id}>
      <span aria-hidden="true">{icon}</span> {children}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}

export function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="error-panel" role="alert" data-testid="error-panel">
      <div className="error-title">
        <span aria-hidden="true">✕</span> The Desk can't show this right now
      </div>
      <div>{message}</div>
      <div className="muted">Nothing on this page is stale: it shows no numbers rather than old ones. It retries by itself.</div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
