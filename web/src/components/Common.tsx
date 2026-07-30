import type { ReactNode } from 'react';
import { fmt, type Provenance, type Sourced } from '../api';

/**
 * The empty state.
 *
 * This component is the visible half of the app's core data rule: when a value
 * is unavailable we say so, name the reason, and stop. There is deliberately no
 * variant of this that renders a placeholder number, a dash styled to look like
 * data, or an "approximately" figure.
 */
export function Missing({ of }: { of: { reason: string; detail: string; attempted?: string } }) {
  const label: Record<string, string> = {
    'no-provider-configured': 'No data source configured',
    'provider-error': 'Data source failed',
    'provider-blocked': 'Data source blocked',
    'not-covered': 'Not covered by this source',
    'insufficient-history': 'Not enough history',
    'not-yet-published': 'Not yet published',
  };
  return (
    <div className="missing">
      <div className="reason-tag">{label[of.reason] ?? of.reason}</div>
      <div className="why">{of.detail}</div>
      {of.attempted && <div className="why">tried: {of.attempted}</div>}
    </div>
  );
}

/** Render a Sourced<T>: value when present, explicit empty state when not. */
export function Show<T>({
  data,
  children,
}: {
  data: Sourced<T> | undefined | null;
  children: (value: T, provenance: Provenance) => ReactNode;
}) {
  if (!data) return <div className="spinner">Loading…</div>;
  if (!data.ok) return <Missing of={data} />;
  return <>{children(data.value, data.provenance)}</>;
}

export function ProvenanceLine({ p }: { p: Provenance | undefined }) {
  if (!p) return null;
  return (
    <div className="prov">
      {p.reliability === 'synthetic' && <span className="chip synthetic">SYNTHETIC</span>}{' '}
      {p.label} · as of {fmt.date(p.asOf)}
      {p.reliability === 'stale' && ' · STALE'}
      {p.url && (
        <>
          {' · '}
          <a href={p.url} target="_blank" rel="noreferrer noopener">
            source
          </a>
        </>
      )}
      {p.note && <div style={{ marginTop: 3 }}>{p.note}</div>}
    </div>
  );
}

export function Panel({
  title,
  right,
  children,
  provenance,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  provenance?: Provenance;
}) {
  return (
    <div className="panel">
      {title && (
        <h3>
          <span>{title}</span>
          {right}
        </h3>
      )}
      {children}
      <ProvenanceLine p={provenance} />
    </div>
  );
}

export function KV({ k, v, cls }: { k: string; v: ReactNode; cls?: string }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={`v ${cls ?? ''}`}>{v}</span>
    </div>
  );
}

/** A min–max range with a marker showing where the current value sits. */
export function RangeBar({
  low,
  high,
  current,
}: {
  low: number | null;
  high: number | null;
  current: number;
}) {
  if (low === null || high === null || high <= low) {
    return <div className="dimmer" style={{ fontSize: 11 }}>range unavailable</div>;
  }
  const pct = Math.max(0, Math.min(100, ((current - low) / (high - low)) * 100));
  return (
    <>
      <div className="range-bar">
        <div className="fill" style={{ left: `${pct}%` }} />
      </div>
      <div className="range-ends">
        <span>{fmt.num(low)}</span>
        <span>{fmt.num(high)}</span>
      </div>
    </>
  );
}

export function Stat({
  label,
  value,
  cls,
  hint,
}: {
  label: string;
  value: ReactNode;
  cls?: string;
  hint?: string;
}) {
  return (
    <div className="stat" title={hint}>
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ''}`}>{value}</div>
    </div>
  );
}

export function NoteBox({ children }: { children: ReactNode }) {
  return <div className="note-box">{children}</div>;
}
