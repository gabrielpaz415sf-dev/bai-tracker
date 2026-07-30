import type {
  AttributionResult,
  ContributionRow,
  Holding,
  HoldingsSnapshot,
  ManagerEffect,
  PriceBar,
  RollupRow,
  SubTheme,
  Timeframe,
} from '../types';
import { SUB_THEME_LABELS } from '../domain/subthemes';
import { isNonUsVenue, hoursBeforeUsClose, vendorSymbol } from '../domain/exchanges';
import { equityHoldings } from './concentration';
import { windowReturnPct } from './returns';
import { ok, missing, derive, type Sourced, type Provenance } from '../util/provenance';

export interface PricedHolding {
  holding: Holding;
  bars: PriceBar[];
  provenance: Provenance;
}

/**
 * Contribution to return.
 *
 *   contributionᵢ = weightᵢ(at window start) × returnᵢ(over window)
 *
 * The weight must be the *starting* weight. Using the ending weight is a
 * common and subtle error: it credits a stock for a rise it partly caused the
 * weight of, double-counting the winner.
 *
 * Because we hold weights fixed at the window start but the fund actually
 * drifts and trades throughout, Σcontributions will not exactly equal the
 * fund's realised return. That gap is real and we surface it as `residualPct`
 * rather than silently scaling the rows to force a reconciliation — the size of
 * the residual is itself information about how much trading happened.
 */
export function computeContributions(
  priced: PricedHolding[],
  timeframe: Timeframe,
  endWeights: Map<string, number>,
): ContributionRow[] {
  const rows: ContributionRow[] = [];

  for (const p of priced) {
    const r = windowReturnPct(p.bars, timeframe.startDate, timeframe.endDate);
    if (r === null) continue;

    const lastBar = p.bars.at(-1);
    const foreign = isNonUsVenue(p.holding.exchange);

    // A foreign holding is "stale" for same-day purposes when its venue closed
    // before the US session did. Over longer windows this washes out to a
    // one-day timing mismatch at each end, so we only flag it as materially
    // stale on short windows.
    const shortWindow = timeframe.tradingDays <= 1;
    const priceStale = foreign && shortWindow;

    rows.push({
      ticker: p.holding.ticker,
      name: p.holding.name,
      sector: p.holding.sector,
      country: p.holding.country,
      subTheme: p.holding.subTheme,
      startWeight: p.holding.weight,
      endWeight: endWeights.get(p.holding.ticker) ?? null,
      returnPct: r,
      contributionPct: (p.holding.weight / 100) * r,
      priceStale,
      priceAsOf: lastBar?.date ?? timeframe.endDate,
      provenance: p.provenance,
    });
  }

  return rows.sort((a, b) => b.contributionPct - a.contributionPct);
}

export function rollupContributions(
  rows: ContributionRow[],
  keyOf: (r: ContributionRow) => string,
  labelOf: (k: string) => string,
): RollupRow[] {
  const map = new Map<
    string,
    { weight: number; contribution: number; count: number }
  >();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = map.get(k) ?? { weight: 0, contribution: 0, count: 0 };
    cur.weight += r.startWeight;
    cur.contribution += r.contributionPct;
    cur.count += 1;
    map.set(k, cur);
  }
  return [...map.entries()]
    .map(([key, v]) => ({
      key,
      label: labelOf(key),
      startWeight: v.weight,
      contributionPct: v.contribution,
      // Weighted average return of the group = its contribution divided by the
      // weight that produced it.
      groupReturnPct: v.weight > 0 ? (v.contribution / v.weight) * 100 : 0,
      memberCount: v.count,
    }))
    .sort((a, b) => b.contributionPct - a.contributionPct);
}

/**
 * How much of the return came from the manager trading rather than from the
 * stocks the fund already held moving?
 *
 * We price a *frozen* portfolio — the start-date weights, held untouched
 * through the window — and compare it to what the fund actually returned. The
 * difference is the trading effect. This is the honest counterfactual for an
 * active fund: "what if the manager had done nothing?"
 *
 * Requires two archived holdings snapshots. With only one, the question is not
 * answerable and we say so rather than guessing.
 */
export function computeManagerEffect(
  frozenRows: ContributionRow[],
  actualReturnPct: number,
  diff: { turnoverPct: number; changes: ManagerEffect['notableChanges'] } | null,
): ManagerEffect {
  const frozen = frozenRows.reduce((a, r) => a + r.contributionPct, 0);
  if (!diff) {
    return {
      frozenPortfolioReturnPct: frozen,
      actualReturnPct,
      tradingEffectPct: 0,
      turnoverPct: 0,
      notableChanges: [],
      computable: false,
    };
  }
  return {
    frozenPortfolioReturnPct: frozen,
    actualReturnPct,
    tradingEffectPct: actualReturnPct - frozen,
    turnoverPct: diff.turnoverPct,
    notableChanges: diff.changes
      .filter((c) => c.kind !== 'unchanged')
      .slice(0, 8),
    computable: true,
  };
}

/** Weight of holdings we actually managed to price, as a share of equity. */
export function coveragePct(rows: ContributionRow[], holdings: Holding[]): number {
  const totalEquityWeight = equityHoldings(holdings).reduce(
    (a, h) => a + h.weight,
    0,
  );
  if (totalEquityWeight === 0) return 0;
  const covered = rows.reduce((a, r) => a + r.startWeight, 0);
  return (covered / totalEquityWeight) * 100;
}

export function subThemeLabel(k: string): string {
  return SUB_THEME_LABELS[k as SubTheme] ?? k;
}

/**
 * Symbols to request from the market provider for a snapshot's holdings,
 * skipping cash sleeves and mapping local codes onto vendor-suffixed symbols.
 */
export function symbolsFor(snapshot: HoldingsSnapshot): Array<{
  holding: Holding;
  symbol: string;
}> {
  return equityHoldings(snapshot.holdings).map((h) => ({
    holding: h,
    symbol: vendorSymbol(h.ticker, h.exchange),
  }));
}

export function stalenessSummary(rows: ContributionRow[]): {
  count: number;
  weight: number;
  maxHours: number;
} {
  const stale = rows.filter((r) => r.priceStale);
  return {
    count: stale.length,
    weight: stale.reduce((a, r) => a + r.startWeight, 0),
    maxHours: stale.reduce(
      (a, r) => Math.max(a, hoursBeforeUsClose(r.ticker)),
      0,
    ),
  };
}

export function buildAttributionProvenance(
  rows: ContributionRow[],
  timeframe: Timeframe,
): Provenance {
  return derive(
    rows.map((r) => r.provenance),
    `Contribution analysis, ${timeframe.label}`,
  );
}

export { ok, missing };
export type { Sourced, AttributionResult };
