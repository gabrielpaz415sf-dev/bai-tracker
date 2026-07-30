import type { Concentration, Holding, RollupRow, SubTheme } from '../types';
import { SUB_THEME_LABELS } from '../domain/subthemes';

/** Cash/derivative sleeves are not equity exposure; exclude from stock stats. */
export function equityHoldings(holdings: Holding[]): Holding[] {
  return holdings.filter(
    (h) => h.assetClass !== 'Cash' && !/cash|derivative/i.test(h.sector),
  );
}

export function computeConcentration(holdings: Holding[]): Concentration {
  const eq = equityHoldings(holdings);
  const sorted = [...eq].sort((a, b) => b.weight - a.weight);

  const top10 = sorted.slice(0, 10).reduce((a, h) => a + h.weight, 0);

  // Herfindahl on weight fractions. Effective N = 1/HHI is the standard read:
  // "this 54-stock portfolio behaves like an equally-weighted N-stock one".
  const hhi = eq.reduce((a, h) => a + (h.weight / 100) ** 2, 0);

  return {
    top10WeightPct: top10,
    top1WeightPct: sorted[0]?.weight ?? 0,
    effectiveHoldings: hhi > 0 ? 1 / hhi : 0,
    herfindahl: hhi,
    totalHoldings: eq.length,
    bySector: rollupWeights(eq, (h) => h.sector, (k) => k),
    bySubTheme: rollupWeights(
      eq,
      (h) => h.subTheme,
      (k) => SUB_THEME_LABELS[k as SubTheme] ?? k,
    ),
    byCountry: rollupWeights(eq, (h) => h.country, (k) => k),
  };
}

export function rollupWeights(
  holdings: Holding[],
  keyOf: (h: Holding) => string,
  labelOf: (k: string) => string,
): RollupRow[] {
  const map = new Map<string, { weight: number; count: number }>();
  for (const h of holdings) {
    const k = keyOf(h);
    const cur = map.get(k) ?? { weight: 0, count: 0 };
    cur.weight += h.weight;
    cur.count += 1;
    map.set(k, cur);
  }
  return [...map.entries()]
    .map(([key, v]) => ({
      key,
      label: labelOf(key),
      startWeight: v.weight,
      contributionPct: 0,
      groupReturnPct: 0,
      memberCount: v.count,
    }))
    .sort((a, b) => b.startWeight - a.startWeight);
}
