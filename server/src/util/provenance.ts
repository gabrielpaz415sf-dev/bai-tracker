/**
 * Provenance envelope.
 *
 * Design rule for this codebase: no number reaches the UI naked. Every value
 * that originated outside our own arithmetic is wrapped in `Sourced<T>`, which
 * carries where it came from, when it was true, and whether it is real.
 *
 * This is the mechanism behind the product requirement "never fabricate a
 * holding, price, or reason". A missing value is representable (`ok: false`)
 * and renders as an explicit gap in the UI. There is no code path that
 * substitutes a plausible-looking default for an absent one.
 */

export type SourceKind =
  | 'issuer.ishares'
  | 'market.tiingo'
  | 'market.polygon'
  | 'market.alphavantage'
  | 'market.eodhd'
  | 'news.marketaux'
  | 'computed'
  | 'synthetic.fixture';

export type Reliability =
  /** Real data, fetched inside its freshness budget. */
  | 'live'
  /** Real data, but older than its refresh cadence. Usable, flagged in UI. */
  | 'stale'
  /** Real data from a market that has already closed for the day. */
  | 'closed-market'
  /** Not real. Generated for demo/testing. Must be visibly marked. */
  | 'synthetic';

export interface Provenance {
  source: SourceKind;
  /** Instant the underlying value was true (not when we fetched it). */
  asOf: string;
  /** Instant we retrieved it. */
  retrievedAt: string;
  reliability: Reliability;
  /** Human-readable origin, shown in tooltips. */
  label: string;
  /** Deep link to the source document/endpoint, when one exists. */
  url?: string;
  /** Free-text caveat surfaced next to the value. */
  note?: string;
}

export interface Ok<T> {
  ok: true;
  value: T;
  provenance: Provenance;
}

export interface Missing {
  ok: false;
  /** Machine-readable cause, drives UI empty-state copy. */
  reason:
    | 'no-provider-configured'
    | 'provider-error'
    | 'provider-blocked'
    | 'not-covered'
    | 'insufficient-history'
    | 'not-yet-published';
  /** Operator-facing detail. Safe to show; contains no secrets. */
  detail: string;
  /** Which source we tried, if any. */
  attempted?: SourceKind;
}

export type Sourced<T> = Ok<T> | Missing;

export function ok<T>(value: T, provenance: Provenance): Ok<T> {
  return { ok: true, value, provenance };
}

export function missing(
  reason: Missing['reason'],
  detail: string,
  attempted?: SourceKind,
): Missing {
  return attempted === undefined
    ? { ok: false, reason, detail }
    : { ok: false, reason, detail, attempted };
}

/** Map over a present value, propagating absence unchanged. */
export function mapSourced<A, B>(s: Sourced<A>, f: (a: A) => B): Sourced<B> {
  return s.ok ? ok(f(s.value), s.provenance) : s;
}

/** Unwrap with an explicit fallback. Use only where absence is truly benign. */
export function orElse<T>(s: Sourced<T>, fallback: T): T {
  return s.ok ? s.value : fallback;
}

/**
 * Combine provenances for a computed value. The result is only as fresh as its
 * stalest input and only as real as its least-real input — synthetic infects
 * everything downstream, which is what stops fixture data from being laundered
 * into something that looks real.
 */
export function derive(
  inputs: Provenance[],
  label: string,
  note?: string,
): Provenance {
  const rank: Record<Reliability, number> = {
    live: 0,
    'closed-market': 1,
    stale: 2,
    synthetic: 3,
  };
  let worst: Reliability = 'live';
  let oldest = '9999-12-31T00:00:00.000Z';
  for (const p of inputs) {
    if (rank[p.reliability] > rank[worst]) worst = p.reliability;
    if (p.asOf < oldest) oldest = p.asOf;
  }
  const base: Provenance = {
    source: 'computed',
    asOf: inputs.length > 0 ? oldest : new Date().toISOString(),
    retrievedAt: new Date().toISOString(),
    reliability: worst,
    label,
  };
  return note === undefined ? base : { ...base, note };
}

/** True if any input anywhere in the tree is synthetic. */
export function anySynthetic(...provs: (Provenance | undefined)[]): boolean {
  return provs.some((p) => p?.reliability === 'synthetic');
}
