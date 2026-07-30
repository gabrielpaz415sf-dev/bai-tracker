import type {
  ConcentrationRiskScenario,
  ContextGauges,
  DcaComparison,
  ExecutionCosts,
  Holding,
  HorizonDispersion,
  OutcomeDistribution,
  PriceBar,
} from '../types';
import { percentile, realizedVolPct, sma, high52w } from './returns';
import { equityHoldings } from './concentration';

/**
 * ENTRY-PRICE EDUCATION.
 *
 * Everything in this module is descriptive and historical. Nothing here
 * produces a signal, a target, or a recommendation, and that is a deliberate
 * design constraint rather than a disclaimer bolted on afterwards: none of
 * these functions take a "should I buy" question as input or return an action
 * as output. They answer "how much did entry timing have mattered, historically,
 * at this horizon" — which is a question about dispersion, not about direction.
 */

/**
 * The core demonstration: for a given holding period, evaluate *every*
 * historical entry day and report the spread of outcomes.
 *
 * Read it as: "had you bought on the single best day versus the single worst
 * day and held for H, your outcomes differed by `spreadPct`." As H grows, that
 * spread shrinks relative to the total return — which is the point being
 * taught, and it is shown rather than asserted.
 */
export function horizonDispersion(
  bars: PriceBar[],
  horizonTradingDays: number,
  horizonLabel: string,
  symbol: string,
  isProxy: boolean,
): HorizonDispersion | null {
  if (bars.length <= horizonTradingDays + 1) return null;

  const outcomes: number[] = [];
  for (let i = 0; i + horizonTradingDays < bars.length; i++) {
    const entry = bars[i]?.adjClose;
    const exit = bars[i + horizonTradingDays]?.adjClose;
    if (entry === undefined || exit === undefined || entry === 0) continue;
    outcomes.push(((exit - entry) / entry) * 100);
  }
  if (outcomes.length < 5) return null;

  const sorted = [...outcomes].sort((a, b) => a - b);
  const best = sorted.at(-1) as number;
  const worst = sorted[0] as number;
  const spread = best - worst;
  const median = percentile(sorted, 0.5);
  const years = horizonTradingDays / 252;

  return {
    horizonLabel,
    horizonTradingDays,
    sampleCount: outcomes.length,
    bestPct: best,
    worstPct: worst,
    medianPct: median,
    p25Pct: percentile(sorted, 0.25),
    p75Pct: percentile(sorted, 0.75),
    spreadPct: spread,
    /*
     * Raw spread *widens* with horizon — more time means more accumulated
     * divergence — so a normalised figure is needed to support the claim that
     * entry timing matters less the longer you hold.
     *
     * That normalisation must divide by √years, not years. Dispersion grows
     * like √t, so `spread / years` (the previous implementation) divided a
     * √t numerator by t and produced a decline that was pure artifact: 1570 →
     * 713 → 407 → 189 → 98, halving on every doubling of horizon. Dividing by
     * √t is dimensionally consistent; what remains (≈221 → 98) is the genuine
     * effect, smaller but real.
     */
    spreadPerSqrtYearPct: years > 0 ? spread / Math.sqrt(years) : spread,
    iqrPct: percentile(sorted, 0.75) - percentile(sorted, 0.25),
    shareNegativePct: (outcomes.filter((o) => o < 0).length / outcomes.length) * 100,
    // Suppressed when the median outcome is near zero: dividing by a number
    // that small produces an enormous ratio that reads as a finding when it is
    // just an artefact of the denominator.
    spreadVsMedianRatio: Math.abs(median) >= 1 ? spread / Math.abs(median) : NaN,
    seriesSymbol: symbol,
    isProxy,
  };
}

/**
 * Lump sum vs dollar-cost averaging, run over every historical start date.
 *
 * We report the full distribution, not the average, because the average hides
 * the thing that actually matters to someone deciding: DCA usually gives up
 * some upside in exchange for a tighter spread of outcomes. An average makes
 * that trade-off invisible.
 *
 * Both arms deploy the same total capital. The DCA arm holds its
 * not-yet-invested cash at zero return, which slightly understates DCA in a
 * high-rate environment — a real effect, noted in the UI rather than modelled,
 * since the cash rate is not something this app has a source for.
 */
export function lumpSumVsDca(
  bars: PriceBar[],
  totalUsd: number,
  periods: number,
  intervalTradingDays: number,
  intervalLabel: string,
  symbol: string,
  isProxy: boolean,
): DcaComparison | null {
  const span = periods * intervalTradingDays;
  if (bars.length <= span + 1) return null;

  const lump: number[] = [];
  const dca: number[] = [];
  let lumpWins = 0;

  for (let start = 0; start + span < bars.length; start++) {
    const exitPrice = bars[start + span]?.adjClose;
    const entryPrice = bars[start]?.adjClose;
    if (exitPrice === undefined || entryPrice === undefined || entryPrice === 0) {
      continue;
    }

    const lumpFinal = (totalUsd / entryPrice) * exitPrice;

    let shares = 0;
    const perPeriod = totalUsd / periods;
    for (let k = 0; k < periods; k++) {
      const px = bars[start + k * intervalTradingDays]?.adjClose;
      if (px === undefined || px === 0) continue;
      shares += perPeriod / px;
    }
    const dcaFinal = shares * exitPrice;

    lump.push(lumpFinal);
    dca.push(dcaFinal);
    if (lumpFinal > dcaFinal) lumpWins++;
  }

  if (lump.length < 5) return null;

  return {
    contributionTotalUsd: totalUsd,
    periods,
    intervalLabel,
    lumpSum: distribution(lump),
    dca: distribution(dca),
    lumpSumWinRatePct: (lumpWins / lump.length) * 100,
    sampleCount: lump.length,
    seriesSymbol: symbol,
    isProxy,
  };
}

function distribution(values: number[]): OutcomeDistribution {
  const s = [...values].sort((a, b) => a - b);
  return {
    medianFinalUsd: percentile(s, 0.5),
    p5FinalUsd: percentile(s, 0.05),
    p25FinalUsd: percentile(s, 0.25),
    p75FinalUsd: percentile(s, 0.75),
    p95FinalUsd: percentile(s, 0.95),
    bestFinalUsd: s.at(-1) as number,
    worstFinalUsd: s[0] as number,
  };
}

export function computeGauges(
  bars: PriceBar[],
  premiumDiscountPct: number | null,
): ContextGauges | null {
  const last = bars.at(-1);
  if (!last) return null;

  const s50 = sma(bars, 50);
  const s200 = sma(bars, 200);
  const hi52 = high52w(bars);

  return {
    price: last.adjClose,
    sma50: s50,
    sma200: s200,
    pctVsSma50: s50 ? ((last.adjClose - s50) / s50) * 100 : null,
    pctVsSma200: s200 ? ((last.adjClose - s200) / s200) * 100 : null,
    realizedVol30dPct: realizedVolPct(bars, 30),
    realizedVol90dPct: realizedVolPct(bars, 90),
    drawdownFrom52wHighPct: hi52 ? ((last.adjClose - hi52) / hi52) * 100 : null,
    premiumDiscountPct,
  };
}

/**
 * Execution costs — the part of "does my entry price matter" that is actually
 * actionable, and the honest answer for most buyers.
 *
 * A horizon of years washes out a 1% difference in entry price. It does not
 * wash out a spread you pay on the way in *and* on the way out, or a premium to
 * NAV you hand over at purchase. These are small, certain and controllable,
 * which is the opposite of the thing most people worry about.
 */
export function estimateExecutionCosts(
  bid: number | null,
  ask: number | null,
  last: number | null,
  premiumDiscountPct: number | null,
): ExecutionCosts {
  const notes = [
    'ETF spreads are widest in the first and last few minutes of the session, ' +
      'when market makers price the most uncertainty. Mid-session quotes are ' +
      'typically tightest.',
    'A limit order caps the price you pay; a market order accepts whatever is ' +
      'quoted when it arrives. The difference is largest exactly when spreads ' +
      'are widest.',
    'BAI holds non-US names whose home markets are closed during the US ' +
      'session. Market makers hedge that exposure with proxies, which tends to ' +
      'widen the quoted spread relative to a purely US-listed fund.',
  ];

  if (bid === null || ask === null || bid <= 0 || ask <= 0) {
    return {
      spreadUsd: null,
      spreadPctOfPrice: null,
      premiumDiscountPct,
      estimatedRoundTripPct: null,
      notes: [
        'Live bid/ask is not available from the configured data provider, so ' +
          'the spread cannot be measured here. Your broker shows it at the ' +
          'moment of trading — that is the number that applies to you.',
        ...notes,
      ],
    };
  }

  const spread = ask - bid;
  const mid = (ask + bid) / 2;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : null;
  const pd = premiumDiscountPct ?? 0;

  return {
    spreadUsd: spread,
    spreadPctOfPrice: spreadPct,
    premiumDiscountPct,
    // Half-spread each way (you cross at the touch) plus whatever premium you
    // pay on entry. Deliberately a rough, stated-assumption estimate.
    estimatedRoundTripPct: spreadPct !== null ? spreadPct + Math.abs(pd) : null,
    notes,
  };
}

/**
 * Concentration stress. Not a forecast — a mechanical restatement of what the
 * portfolio's own weights imply. "If X falls by Y%, and X is Z% of the fund,
 * the fund falls Z%×Y% from that alone, before anything else moves."
 *
 * The shocks are labelled as assumptions, and each scenario states the weight
 * it was computed from so the arithmetic is checkable.
 */
export function concentrationScenarios(
  holdings: Holding[],
): ConcentrationRiskScenario[] {
  const eq = equityHoldings(holdings);
  const sorted = [...eq].sort((a, b) => b.weight - a.weight);
  const top1 = sorted[0];
  const top10Weight = sorted.slice(0, 10).reduce((a, h) => a + h.weight, 0);
  const memoryWeight = eq
    .filter((h) => h.subTheme === 'memory')
    .reduce((a, h) => a + h.weight, 0);
  const semiWeight = eq
    .filter((h) => h.subTheme === 'semiconductors' || h.subTheme === 'memory')
    .reduce((a, h) => a + h.weight, 0);

  const scenarios: ConcentrationRiskScenario[] = [];

  if (top1) {
    scenarios.push({
      label: `Largest holding (${top1.ticker}) falls 30%`,
      description:
        'A single-name shock — an earnings miss, a lost design win, a guidance ' +
        'cut. Isolates how much the fund rides on its biggest position.',
      exposureWeightPct: top1.weight,
      shockPct: -30,
      fundImpactPct: (top1.weight / 100) * -30,
      basis: `${top1.name} at ${top1.weight.toFixed(2)}% of NAV.`,
    });
  }

  if (memoryWeight > 0) {
    scenarios.push({
      label: 'Memory cycle turns — memory names fall 40%',
      description:
        'Memory is the most cyclical part of the AI supply chain: pricing has ' +
        'historically fallen far and fast when supply catches up with demand. ' +
        'This fund carries concentrated memory exposure.',
      exposureWeightPct: memoryWeight,
      shockPct: -40,
      fundImpactPct: (memoryWeight / 100) * -40,
      basis: `Memory & storage sub-theme at ${memoryWeight.toFixed(2)}% of NAV.`,
    });
  }

  scenarios.push({
    label: 'Broad semiconductor drawdown — semis and memory fall 25%',
    description:
      'A sector-wide de-rating, of the kind seen when rate expectations shift ' +
      'or AI capex guidance disappoints.',
    exposureWeightPct: semiWeight,
    shockPct: -25,
    fundImpactPct: (semiWeight / 100) * -25,
    basis: `Semiconductors + memory at ${semiWeight.toFixed(2)}% of NAV.`,
  });

  scenarios.push({
    label: 'Top 10 falls 20%',
    description:
      'The concentration question directly: the ten largest positions moving ' +
      'together, as they often do when they share an end-market.',
    exposureWeightPct: top10Weight,
    shockPct: -20,
    fundImpactPct: (top10Weight / 100) * -20,
    basis: `Top 10 holdings at ${top10Weight.toFixed(2)}% of NAV.`,
  });

  return scenarios;
}

/** Standard horizons. ~21 trading days per month, 252 per year. */
export const HORIZONS: Array<{ label: string; days: number }> = [
  { label: '1 week', days: 5 },
  { label: '1 month', days: 21 },
  { label: '3 months', days: 63 },
  { label: '6 months', days: 126 },
  { label: '1 year', days: 252 },
  { label: '3 years', days: 756 },
  { label: '5 years', days: 1260 },
  { label: '10 years', days: 2520 },
];
