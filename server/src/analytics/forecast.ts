import type { PriceBar } from '../types';
import { dailyReturns, percentile } from './returns';

/**
 * FORWARD OUTCOME DISTRIBUTION — deliberately not a price prediction.
 *
 * There is no model here that claims to know which way BAI is going, because no
 * such model exists. What is computable, and genuinely useful, is the *shape of
 * the uncertainty*: given how this fund has actually behaved day to day, where
 * could it plausibly be in a week, a month, a year, and with what probability.
 *
 * Two independent methods are produced side by side so they can be compared,
 * and so a disagreement between them is visible rather than averaged away:
 *
 * 1. EMPIRICAL — every actual N-day window in BAI's own history. No model, no
 *    assumptions, just what happened. Limited by having <2 years of history:
 *    a 252-day horizon has very few non-overlapping samples.
 * 2. BOOTSTRAP — resample BAI's real daily moves to build many synthetic paths.
 *    This gets far more samples out of the same history, at the cost of assuming
 *    the future is drawn from the same distribution as the past.
 *
 * Both are centred on the fund's realised drift, which for a 21-month-old
 * leveraged-beta tech fund is an unreliable estimate of anything. That is
 * reported, not hidden — see `driftWarning`.
 */

/** Mulberry32 — small, fast, seedable. Determinism matters: the same page load
 *  must not produce different probabilities on refresh. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HorizonOutlook {
  label: string;
  tradingDays: number;
  /** Calendar days, for the "by <date>" line. */
  calendarDays: number;
  /** Percentile outcomes as % change from today, from the bootstrap. */
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  /** Same percentiles converted to prices. */
  price5: number;
  price25: number;
  price50: number;
  price75: number;
  price95: number;
  /** Probability the outcome is above today's price. */
  probUpPct: number;
  /** Probability of a drawdown worse than 10% / 20% at the horizon. */
  probDown10Pct: number;
  probDown20Pct: number;
  /** Chance of at least one 20%+ peak-to-trough dip *along the way*. */
  probMaxDrawdown20Pct: number;
  /** From actual history: share of real N-day windows that were positive. */
  empiricalUpPct: number | null;
  /** From actual history: median real N-day outcome. */
  empiricalMedianPct: number | null;
  /** How many real, non-overlapping windows that empirical figure rests on. */
  empiricalIndependentSamples: number;
}

export interface Outlook {
  asOfDate: string;
  spotPrice: number;
  /** Annualised volatility from the last 120 sessions, in %. */
  annualisedVolPct: number;
  /** Annualised drift implied by the full history, in %. */
  annualisedDriftPct: number;
  /** Trading days of history the model was fitted on. */
  historyDays: number;
  simulations: number;
  horizons: HorizonOutlook[];
  /** Non-negotiable caveats, surfaced by the UI as first-class content. */
  driftWarning: string;
  method: string;
}

export const OUTLOOK_HORIZONS: Array<{ label: string; days: number; calendar: number }> = [
  { label: '1 week', days: 5, calendar: 7 },
  { label: '1 month', days: 21, calendar: 30 },
  { label: '3 months', days: 63, calendar: 91 },
  { label: '6 months', days: 126, calendar: 182 },
  { label: '1 year', days: 252, calendar: 365 },
];

/**
 * Overlapping-block bootstrap.
 *
 * Sampling individual days independently would destroy volatility clustering —
 * the real tendency of turbulent days to arrive together — and that
 * systematically understates the tails, which is the one region a risk view
 * exists to describe. Drawing contiguous blocks of ~10 sessions preserves it.
 */
function blockBootstrapPath(
  returns: number[],
  days: number,
  rand: () => number,
  blockLen = 10,
): { total: number; maxDrawdown: number } {
  let logSum = 0;
  let peak = 0;
  let maxDd = 0;
  let placed = 0;

  while (placed < days) {
    const start = Math.floor(rand() * returns.length);
    const take = Math.min(blockLen, days - placed);
    for (let i = 0; i < take; i++) {
      logSum += returns[(start + i) % returns.length] as number;
      if (logSum > peak) peak = logSum;
      // Drawdown in log space converts cleanly to a percentage below the peak.
      const dd = 1 - Math.exp(logSum - peak);
      if (dd > maxDd) maxDd = dd;
      placed++;
    }
  }
  return { total: Math.exp(logSum) - 1, maxDrawdown: maxDd };
}

/** Actual historical N-day outcomes, overlapping windows. */
function empiricalWindows(closes: number[], days: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + days < closes.length; i++) {
    const a = closes[i] as number;
    const b = closes[i + days] as number;
    if (a > 0) out.push(((b - a) / a) * 100);
  }
  return out;
}

/* ------------------------------------------------ conditional base rates --- */

/** Minimum matching historical days before a conditional figure is reportable. */
const MIN_MATCHES = 30;

export interface SetupState {
  /** How far below the 52-week high, as a positive number of percent. */
  pctBelowHigh: number;
  /** True when the last close sits above the 200-day average. */
  aboveSma200: boolean;
  /** Bucket label the UI shows, e.g. "15–30% below its high, below trend". */
  label: string;
}

export interface ConditionalOutcome {
  label: string;
  tradingDays: number;
  /** Null when fewer than MIN_MATCHES historical days matched. */
  upPct: number | null;
  medianPct: number | null;
  p25Pct: number | null;
  p75Pct: number | null;
  matchCount: number;
  /** The same horizon computed over ALL days, for comparison. */
  baselineUpPct: number | null;
  baselineMedianPct: number | null;
}

export interface ConditionalStudy {
  state: SetupState;
  /** Which series the matching was done on, and how long it is. */
  seriesLabel: string;
  seriesDays: number;
  outcomes: ConditionalOutcome[];
  note: string;
}

function drawdownBucket(pctBelowHigh: number): [number, number, string] {
  if (pctBelowHigh < 5) return [0, 5, 'near its high'];
  if (pctBelowHigh < 15) return [5, 15, '5–15% below its high'];
  if (pctBelowHigh < 30) return [15, 30, '15–30% below its high'];
  return [30, 1000, 'more than 30% below its high'];
}

/** Rolling 252-day high and 200-day average at index i, computed forward-safely. */
function stateAt(
  closes: number[],
  highs: number[],
  i: number,
): { pctBelowHigh: number; aboveSma200: boolean } | null {
  if (i < 252) return null;
  let hi = -Infinity;
  for (let k = i - 251; k <= i; k++) hi = Math.max(hi, highs[k] as number);
  let sum = 0;
  for (let k = i - 199; k <= i; k++) sum += closes[k] as number;
  const sma200 = sum / 200;
  const c = closes[i] as number;
  return {
    pctBelowHigh: hi > 0 ? ((hi - c) / hi) * 100 : 0,
    aboveSma200: c > sma200,
  };
}

/**
 * "Every past time it looked like this, what happened next?"
 *
 * Matched on a long proxy series rather than BAI's own 442 days, because the
 * conditional question needs *matching* days and BAI simply has too few. The
 * comparison that matters is each conditional figure against the unconditional
 * baseline directly beside it: if being 26% below the high changes nothing, the
 * two numbers are the same, and saying so is the honest result.
 */
export function conditionalStudy(
  fundBars: PriceBar[],
  proxyBars: PriceBar[],
  proxyLabel: string,
): ConditionalStudy | null {
  if (fundBars.length < 252 || proxyBars.length < 800) return null;

  const fCloses = fundBars.map((b) => b.adjClose);
  const fHighs = fundBars.map((b) => b.high);
  const now = stateAt(fCloses, fHighs, fCloses.length - 1);
  if (!now) return null;

  const [lo, hi, ddLabel] = drawdownBucket(now.pctBelowHigh);
  const state: SetupState = {
    pctBelowHigh: now.pctBelowHigh,
    aboveSma200: now.aboveSma200,
    label: `${ddLabel}, ${now.aboveSma200 ? 'above' : 'below'} its 200-day average`,
  };

  const pCloses = proxyBars.map((b) => b.adjClose);
  const pHighs = proxyBars.map((b) => b.high);

  const outcomes: ConditionalOutcome[] = OUTLOOK_HORIZONS.map((h) => {
    const matched: number[] = [];
    const all: number[] = [];
    for (let i = 252; i + h.days < pCloses.length; i++) {
      const a = pCloses[i] as number;
      const b = pCloses[i + h.days] as number;
      if (a <= 0) continue;
      const fwd = ((b - a) / a) * 100;
      all.push(fwd);
      const st = stateAt(pCloses, pHighs, i);
      if (!st) continue;
      if (
        st.pctBelowHigh >= lo &&
        st.pctBelowHigh < hi &&
        st.aboveSma200 === now.aboveSma200
      ) {
        matched.push(fwd);
      }
    }

    const enough = matched.length >= MIN_MATCHES;
    const ms = [...matched].sort((x, y) => x - y);
    const as_ = [...all].sort((x, y) => x - y);

    return {
      label: h.label,
      tradingDays: h.days,
      upPct: enough ? (matched.filter((x) => x > 0).length / matched.length) * 100 : null,
      medianPct: enough ? percentile(ms, 0.5) : null,
      p25Pct: enough ? percentile(ms, 0.25) : null,
      p75Pct: enough ? percentile(ms, 0.75) : null,
      matchCount: matched.length,
      baselineUpPct: all.length > 0 ? (all.filter((x) => x > 0).length / all.length) * 100 : null,
      baselineMedianPct: as_.length > 0 ? percentile(as_, 0.5) : null,
    };
  });

  return {
    state,
    seriesLabel: proxyLabel,
    seriesDays: proxyBars.length,
    outcomes,
    note:
      `Matched on ${proxyLabel} rather than BAI itself: the question needs many ` +
      `past days that looked like today, and BAI has only ${fundBars.length} ` +
      `trading days of history. ${proxyLabel} is not BAI — it is less ` +
      `concentrated and moves less — so read this as how this *kind* of setup has ` +
      `tended to resolve, not as a statement about this fund. Any horizon with ` +
      `fewer than ${MIN_MATCHES} matching days is left blank rather than ` +
      `reported from a handful of examples.`,
  };
}

/** Run the bootstrap for every horizon over one set of daily log returns. */
function simulateHorizons(
  rets: number[],
  spot: number,
  closes: number[],
  simulations: number,
  seed: number,
  scale = 1,
): HorizonOutlook[] {
  const rand = rng(seed);
  // `scale` re-levers a proxy's returns to BAI's measured beta. Applied to log
  // returns, which is an approximation: it matches the volatility ratio well and
  // deliberately does not try to reproduce path-dependent leverage effects.
  const scaled = scale === 1 ? rets : rets.map((r) => r * scale);

  return OUTLOOK_HORIZONS.map((h) => {
    const totals: number[] = [];
    let up = 0, down10 = 0, down20 = 0, dd20 = 0;

    for (let s = 0; s < simulations; s++) {
      const { total, maxDrawdown } = blockBootstrapPath(scaled, h.days, rand);
      const pct = total * 100;
      totals.push(pct);
      if (pct > 0) up++;
      if (pct <= -10) down10++;
      if (pct <= -20) down20++;
      if (maxDrawdown >= 0.2) dd20++;
    }
    totals.sort((a, b) => a - b);

    const emp = empiricalWindows(closes, h.days);
    const empSorted = [...emp].sort((a, b) => a - b);
    const q = (p: number): number => percentile(totals, p);

    return {
      label: h.label,
      tradingDays: h.days,
      calendarDays: h.calendar,
      p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95),
      price5: spot * (1 + q(0.05) / 100),
      price25: spot * (1 + q(0.25) / 100),
      price50: spot * (1 + q(0.5) / 100),
      price75: spot * (1 + q(0.75) / 100),
      price95: spot * (1 + q(0.95) / 100),
      probUpPct: (up / simulations) * 100,
      probDown10Pct: (down10 / simulations) * 100,
      probDown20Pct: (down20 / simulations) * 100,
      probMaxDrawdown20Pct: (dd20 / simulations) * 100,
      empiricalUpPct:
        emp.length > 0 ? (emp.filter((x) => x > 0).length / emp.length) * 100 : null,
      empiricalMedianPct: empSorted.length > 0 ? percentile(empSorted, 0.5) : null,
      empiricalIndependentSamples: Math.floor(closes.length / h.days),
    };
  });
}

/**
 * Same bootstrap, run on a long proxy series re-levered to BAI's beta.
 *
 * BAI's own 442 days give a 1-year horizon roughly ONE non-overlapping
 * observation, so its long-horizon tails are guesswork. QQQ/SOXX carry a decade
 * or more. This is emphatically not BAI and is never merged into the primary
 * model — it is a second opinion from a longer record, shown beside it.
 */
export function buildProxyOutlook(
  proxyBars: PriceBar[],
  spot: number,
  targetAnnualVolPct: number,
  label: string,
  opts: { simulations?: number; seed?: number } = {},
): {
  label: string;
  historyDays: number;
  volScale: number;
  proxyVolPct: number;
  horizons: HorizonOutlook[];
} | null {
  if (proxyBars.length < 800) return null;
  const rets = dailyReturns(proxyBars).map((d) => Math.log(1 + d.r));
  if (rets.length < 700) return null;

  /*
   * Scale by the VOLATILITY RATIO, not beta.
   *
   * Beta measures how much the two move together; this cone is about how wide
   * BAI's own outcomes are. A fund can have a beta near 1 against a benchmark
   * and still be far more turbulent than it, and it is the turbulence that sets
   * the width of the range. So the proxy's daily moves are rescaled until its
   * annualised volatility matches BAI's measured volatility, which is exactly
   * the property being borrowed from the longer record.
   */
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const proxyVolPct = Math.sqrt(variance * 252) * 100;
  const volScale = proxyVolPct > 0 ? targetAnnualVolPct / proxyVolPct : 1;

  return {
    label,
    historyDays: proxyBars.length,
    volScale,
    proxyVolPct,
    horizons: simulateHorizons(
      rets,
      spot,
      proxyBars.map((b) => b.adjClose),
      opts.simulations ?? 10_000,
      opts.seed ?? 20241021,
      volScale,
    ),
  };
}

export function buildOutlook(
  bars: PriceBar[],
  opts: { simulations?: number; seed?: number } = {},
): Outlook | null {
  // A year of sessions is the floor for saying anything about a 1-year horizon
  // without it being an extrapolation of an extrapolation.
  if (bars.length < 260) return null;

  const simulations = opts.simulations ?? 10_000;
  const seed = opts.seed ?? 20241021;

  const closes = bars.map((b) => b.adjClose);
  const spot = closes[closes.length - 1] as number;
  // dailyReturns yields a FRACTION (0.05 = 5%), not a percent.
  const rets = dailyReturns(bars).map((d) => Math.log(1 + d.r));
  if (rets.length < 200) return null;

  // Volatility from the recent 120 sessions — current regime, not the whole
  // history, since a fund's turbulence changes.
  const recent = rets.slice(-120);
  const mean120 = recent.reduce((a, b) => a + b, 0) / recent.length;
  const var120 =
    recent.reduce((a, b) => a + (b - mean120) ** 2, 0) / (recent.length - 1);
  const annVol = Math.sqrt(var120 * 252) * 100;

  const meanAll = rets.reduce((a, b) => a + b, 0) / rets.length;
  const annDrift = (Math.exp(meanAll * 252) - 1) * 100;

  const horizons = simulateHorizons(rets, spot, closes, simulations, seed);

  return {
    asOfDate: bars[bars.length - 1]?.date ?? '',
    spotPrice: spot,
    annualisedVolPct: annVol,
    annualisedDriftPct: annDrift,
    historyDays: bars.length,
    simulations,
    horizons,
    driftWarning:
      `This model is centred on BAI's own past drift of ` +
      `${annDrift >= 0 ? '+' : ''}${annDrift.toFixed(1)}% a year, measured over just ` +
      `${bars.length} trading days. That is far too short a record to treat as the ` +
      `fund's true expected return — it mostly reflects which part of the AI cycle ` +
      `those months happened to cover. Read the width of the range, which volatility ` +
      `estimates reasonably well, not the centre of it, which it does not.`,
    method:
      `${simulations.toLocaleString('en-US')} simulated paths, built by resampling ` +
      `BAI's actual daily moves in contiguous 10-day blocks (so calm and turbulent ` +
      `stretches stay clustered as they really are). Shown beside the outcomes of ` +
      `every real window of the same length in the fund's history.`,
  };
}
