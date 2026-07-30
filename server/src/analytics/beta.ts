import type { BetaDecomposition, PriceBar } from '../types';
import { config } from '../config';
import { dailyReturns, windowReturnPct } from './returns';

/**
 * Split a fund move into "the whole tech tape moved" and "something happened to
 * this fund specifically".
 *
 * Method: OLS of daily fund returns on daily benchmark returns over a trailing
 * estimation window, then apply the fitted beta to the benchmark's return over
 * the window being analysed.
 *
 *   systematic    = β × r_benchmark
 *   idiosyncratic = r_fund − systematic
 *
 * The honesty guard is R². A beta fitted on a relationship that does not hold
 * produces a systematic/idiosyncratic split that is arithmetic noise dressed as
 * insight. Below `config.beta.minRSquared` we still return the numbers, but
 * flag `reliable: false`, and the narrative layer refuses to talk about the
 * split at all.
 */
export function estimateBeta(
  fundBars: PriceBar[],
  benchBars: PriceBar[],
  windowStart: string,
  windowEnd: string,
): BetaDecomposition | null {
  const fundRets = dailyReturns(fundBars);
  const benchRets = dailyReturns(benchBars);
  if (fundRets.length < 20 || benchRets.length < 20) return null;

  // Align on dates: a US holiday or a missing vendor bar must not shift the two
  // series relative to each other, which would bias beta toward zero.
  const benchByDate = new Map(benchRets.map((d) => [d.date, d.r]));
  const paired: Array<[number, number]> = [];
  for (const f of fundRets) {
    const b = benchByDate.get(f.date);
    if (b !== undefined) paired.push([b, f.r]);
  }

  const est = paired.slice(-config.beta.estimationWindowDays);
  if (est.length < 20) return null;

  const n = est.length;
  const meanX = est.reduce((a, [x]) => a + x, 0) / n;
  const meanY = est.reduce((a, [, y]) => a + y, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of est) {
    sxy += (x - meanX) * (y - meanY);
    sxx += (x - meanX) ** 2;
    syy += (y - meanY) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;

  const beta = sxy / sxx;
  const rSquared = (sxy * sxy) / (sxx * syy);

  // These must use exactly the same anchoring rule as the headline return, or
  // systematic + idiosyncratic will not add up to the number displayed beside
  // them. Anchoring on the first bar *inside* the window instead of the last
  // bar at-or-before it silently drops the first day's move, and the split
  // then reconciles to a fund return the user is never shown.
  const benchWindow = windowReturnPct(benchBars, windowStart, windowEnd);
  const fundWindow = windowReturnPct(fundBars, windowStart, windowEnd);
  if (benchWindow === null || fundWindow === null) return null;

  const systematic = beta * benchWindow;

  return {
    benchmarkSymbol: config.beta.defaultBenchmark,
    beta,
    rSquared,
    estimationWindowDays: n,
    benchmarkReturnPct: benchWindow,
    systematicPct: systematic,
    idiosyncraticPct: fundWindow - systematic,
    reliable: rSquared >= config.beta.minRSquared,
  };
}
