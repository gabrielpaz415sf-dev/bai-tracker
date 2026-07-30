import { config } from '../config';
import { FUND, type PriceBar } from '../types';
import { ok, missing, type Sourced } from '../util/provenance';
import { getDailyBars, getQuote } from '../providers/market';
import { today } from '../util/dates';
import { loadHoldings } from './fundService';
import {
  HORIZONS,
  horizonDispersion,
  lumpSumVsDca,
  computeGauges,
  estimateExecutionCosts,
  concentrationScenarios,
} from '../analytics/entryPrice';

/**
 * BAI's own history is short — inception 2024-10-21 — so long horizons are
 * genuinely not computable from it. Rather than silently truncating the
 * horizon table at what BAI supports (which would hide the very trend the
 * feature exists to show), we compute short horizons from BAI and clearly
 * labelled long horizons from a proxy index, and mark every proxy row.
 */
async function proxyBars(end: string): Promise<PriceBar[] | null> {
  if (config.fixtures.enabled) {
    const { syntheticWorld } = await import('../fixtures/synthetic');
    return syntheticWorld(today()).series.get('QQQ__LONG') ?? null;
  }
  const s = await getDailyBars(config.longHorizonProxy.symbol, '2005-01-01', end);
  return s.ok ? s.value.bars : null;
}

export async function getEntryPriceAnalysis(params: {
  contributionUsd: number;
  dcaPeriods: number;
}): Promise<Record<string, unknown>> {
  const end = today();
  const baiSeries = await getDailyBars('BAI', FUND.inceptionDate, end);
  const quote = await getQuote('BAI');
  const holdings = await loadHoldings();

  if (!baiSeries.ok) {
    return {
      error: baiSeries,
      message:
        'BAI price history is unavailable from the configured provider, so no ' +
        'entry-price analysis can be produced. Nothing is estimated in its place.',
    };
  }

  const bai = baiSeries.value.bars;
  const proxy = await proxyBars(end);

  /* ------------------------------------------- horizon dispersion table */

  const horizons = HORIZONS.map((h) => {
    const fromBai = horizonDispersion(bai, h.days, h.label, 'BAI', false);
    if (fromBai) return fromBai;
    const fromProxy = proxy
      ? horizonDispersion(proxy, h.days, h.label, config.longHorizonProxy.symbol, true)
      : null;
    return (
      fromProxy ?? {
        horizonLabel: h.label,
        horizonTradingDays: h.days,
        sampleCount: 0,
        bestPct: NaN,
        worstPct: NaN,
        medianPct: NaN,
        p25Pct: NaN,
        p75Pct: NaN,
        spreadPct: NaN,
        spreadPerSqrtYearPct: NaN,
        iqrPct: NaN,
        shareNegativePct: NaN,
        spreadVsMedianRatio: NaN,
        seriesSymbol: 'unavailable',
        isProxy: false,
      }
    );
  });

  /* ------------------------------------------------- lump sum vs DCA */

  const periods = Math.max(2, Math.min(36, Math.round(params.dcaPeriods)));
  const dcaFromBai = lumpSumVsDca(
    bai, params.contributionUsd, periods, 21, 'monthly', 'BAI', false,
  );
  const dca =
    dcaFromBai ??
    (proxy
      ? lumpSumVsDca(
          proxy, params.contributionUsd, periods, 21, 'monthly',
          config.longHorizonProxy.symbol, true,
        )
      : null);

  /* ----------------------------------------------------- context gauges */

  const gauges = computeGauges(bai, null);

  /* -------------------------------------------------- execution costs */
  // No configured provider exposes NBBO bid/ask, so this returns the honest
  // "measure it at your broker" form rather than a fabricated spread.
  const execution = estimateExecutionCosts(null, null, quote.ok ? quote.value.last : null, null);

  /* ------------------------------------------------ concentration risk */

  const scenarios: Sourced<ReturnType<typeof concentrationScenarios>> = holdings.ok
    ? ok(concentrationScenarios(holdings.value.holdings), holdings.provenance)
    : missing('provider-error', 'Holdings unavailable, so concentration shocks cannot be computed.');

  return {
    horizons,
    dca,
    gauges,
    execution,
    scenarios,
    proxyNote: config.longHorizonProxy.rationale,
    inceptionDate: FUND.inceptionDate,
    historyTradingDays: bai.length,
    synthetic: config.fixtures.enabled,
    disclaimer:
      'Educational analysis only. This is not investment advice, not a ' +
      'recommendation to buy or sell, and contains no price targets. Past ' +
      'performance does not predict future results. All figures are historical ' +
      'dispersion, not forecasts.',
  };
}
