export type Reliability = 'live' | 'stale' | 'closed-market' | 'synthetic';

export interface Provenance {
  source: string;
  asOf: string;
  retrievedAt: string;
  reliability: Reliability;
  label: string;
  url?: string;
  note?: string;
}

export type Sourced<T> =
  | { ok: true; value: T; provenance: Provenance }
  | { ok: false; reason: string; detail: string; attempted?: string };

export type TimeframeKey = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'SI';

export const TIMEFRAMES: TimeframeKey[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'SI'];

const BASE = '/api';

/**
 * Static-build mode, for publishing to GitHub Pages.
 *
 * Every endpoint in this app is read-only JSON, so the server does not need to
 * exist at request time: a scheduled job can fetch the data, write it to files,
 * and the site becomes plain static hosting. That removes the dependency on a
 * always-on laptop AND removes the free-tier rate-limit problem entirely, since
 * provider calls then happen once per build rather than once per visitor.
 *
 * Set at build time by `VITE_STATIC=1`. The dev server and the local always-on
 * Express build are unaffected.
 */
const STATIC_MODE = import.meta.env.VITE_STATIC === '1';

/**
 * Map an API path to its pre-rendered filename.
 * `/series?timeframe=1M` → `/api/series-1M.json`
 */
function resolveUrl(path: string): string {
  if (!STATIC_MODE) return `${BASE}${path}`;
  const [p = '', q] = path.split('?');
  const name = p.replace(/^\//, '');
  if (!q) return `${BASE}/${name}.json`;
  const values = [...new URLSearchParams(q).values()];
  return `${BASE}/${[name, ...values].join('-')}.json`;
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(resolveUrl(path));
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* body was not JSON; keep the status line */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const fmt = {
  pct(v: number | null | undefined, digits = 2): string {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`;
  },
  /**
   * Contributions and other percentage-point quantities.
   *
   * Rendered with "%" rather than "pp" by explicit request. These values really
   * are percentage points — a holding's contribution to the fund's return, not
   * a return itself — so the unit is technically imprecise. The surrounding
   * labels ("contribution", "explained by tape") carry that meaning instead.
   * Kept as a distinct function from pct() so the distinction survives in code
   * and can be restored in one edit.
   */
  pp(v: number | null | undefined, digits = 2): string {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`;
  },
  num(v: number | null | undefined, digits = 2): string {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return v.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  },
  usd(v: number | null | undefined, digits = 0): string {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return `$${v.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`;
  },
  compact(v: number | null | undefined): string {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return v.toFixed(0);
  },
  date(iso: string | null | undefined): string {
    if (!iso) return '—';
    return iso.slice(0, 10);
  },
  time(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toUTCString().replace('GMT', 'UTC');
  },
};

export function signClass(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return 'muted';
  return v >= 0 ? 'up' : 'down';
}
