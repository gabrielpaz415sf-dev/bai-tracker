import type { PriceBar } from '../types';
import { indexAtOrBefore } from '../util/dates';

/**
 * Total return between two dates, using split/dividend-adjusted closes.
 *
 * Returns null rather than a number when the window cannot be honoured — the
 * series starts after `start`, or there is only one observation. A caller that
 * wants a fallback must ask for one explicitly.
 */
export function windowReturnPct(
  bars: PriceBar[],
  start: string,
  end: string,
): number | null {
  if (bars.length < 2) return null;
  const dates = bars.map((b) => b.date);

  // The bar *at or before* the window start is the correct base: a window
  // beginning on a weekend or holiday must anchor to the prior close, not skip
  // forward, or the first day's move is silently dropped from the return.
  //
  // When the series itself starts *after* the window start (si === -1) — a
  // since-inception window on a fund whose first trade printed a day after the
  // official inception date, or a holding that IPO'd mid-window — the only
  // computable answer is the return since data began, so we anchor at the
  // first bar. Callers that care about the distinction (resolveTimeframe's
  // clippedToInception, attribution's coverage figures) already surface it.
  let si = indexAtOrBefore(dates, start);
  if (si === -1 && (dates[0] ?? '') <= end) si = 0;
  const ei = indexAtOrBefore(dates, end);
  if (si === -1 || ei === -1 || ei <= si) return null;

  const from = bars[si]?.adjClose;
  const to = bars[ei]?.adjClose;
  if (from === undefined || to === undefined || from === 0) return null;
  return ((to - from) / from) * 100;
}

/** Daily simple returns, aligned to bars[1..n-1]. */
export function dailyReturns(bars: PriceBar[]): { date: string; r: number }[] {
  const out: { date: string; r: number }[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]?.adjClose;
    const cur = bars[i];
    if (prev === undefined || cur === undefined || prev === 0) continue;
    out.push({ date: cur.date, r: (cur.adjClose - prev) / prev });
  }
  return out;
}

/** Annualised stdev of daily returns over the trailing `n` observations. */
export function realizedVolPct(bars: PriceBar[], n: number): number | null {
  const rets = dailyReturns(bars).slice(-n).map((d) => d.r);
  if (rets.length < Math.min(20, n)) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

export function sma(bars: PriceBar[], n: number): number | null {
  if (bars.length < n) return null;
  const slice = bars.slice(-n);
  return slice.reduce((a, b) => a + b.adjClose, 0) / slice.length;
}

export function high52w(bars: PriceBar[]): number | null {
  const slice = bars.slice(-252);
  if (slice.length === 0) return null;
  return Math.max(...slice.map((b) => b.high));
}

export function low52w(bars: PriceBar[]): number | null {
  const slice = bars.slice(-252);
  if (slice.length === 0) return null;
  return Math.min(...slice.map((b) => b.low));
}

/** Max peak-to-trough decline over the series, as a negative percent. */
export function maxDrawdownPct(bars: PriceBar[]): number | null {
  if (bars.length < 2) return null;
  let peak = -Infinity;
  let worst = 0;
  for (const b of bars) {
    if (b.adjClose > peak) peak = b.adjClose;
    if (peak > 0) {
      const dd = ((b.adjClose - peak) / peak) * 100;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0] as number;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return lo === hi ? a : a + (b - a) * (idx - lo);
}
