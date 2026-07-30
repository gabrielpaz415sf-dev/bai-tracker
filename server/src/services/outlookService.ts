import { config } from '../config';
import { cached } from '../cache/diskCache';
import { getDailyBars } from '../providers/market';
import {
  buildOutlook,
  buildProxyOutlook,
  conditionalStudy,
  type Outlook,
  type HorizonOutlook,
  type ConditionalStudy,
} from '../analytics/forecast';
import { FUND, type PriceBar } from '../types';
import { ok, missing, type Sourced } from '../util/provenance';
import { today } from '../util/dates';

export interface ProxyOutlook {
  label: string;
  historyDays: number;
  /** Factor the proxy's daily moves were multiplied by to match BAI's vol. */
  volScale: number;
  proxyVolPct: number;
  horizons: HorizonOutlook[];
}

export interface OutlookResponse extends Outlook {
  /** A second opinion from a decade+ of history, never merged into the primary. */
  proxy: ProxyOutlook | null;
  /** "Every past time it looked like this…" */
  conditional: ConditionalStudy | null;
}

const PROXY_SYMBOL = 'SOXX';
const PROXY_NAME = 'SOXX (iShares Semiconductor ETF)';

/**
 * Forward outcome distribution for BAI.
 *
 * Every input here is already cached by the market layer, so this endpoint costs
 * no provider requests — it is pure computation over bars that the dashboard and
 * attribution engine have already fetched. The simulation itself is the only
 * cost (~100k paths), which is why the result is cached per as-of date rather
 * than recomputed per request.
 */
export async function getOutlook(): Promise<Sourced<OutlookResponse>> {
  if (config.fixtures.enabled) {
    return missing(
      'no-provider-configured',
      'The outlook model needs real price history; fixture mode has none.',
    );
  }

  const start = '2004-01-01';
  const [fund, proxyBars] = await Promise.all([
    getDailyBars(FUND.ticker, start, today()),
    getDailyBars(PROXY_SYMBOL, start, today()),
  ]);

  if (!fund.ok) return fund;
  const bars: PriceBar[] = fund.value.bars;
  const asOf = bars.at(-1)?.date ?? today();

  try {
    const res = await cached(
      // Keyed on the as-of date: a new session's bar is a new answer, and
      // nothing else changes the result because the RNG is seeded.
      `outlook:${asOf}:${PROXY_SYMBOL}`,
      config.ttl.dailyBars,
      async (): Promise<OutlookResponse> => {
        const base = buildOutlook(bars);
        if (!base) {
          throw new Error(
            `BAI has ${bars.length} trading days; the model needs at least 260 ` +
              `before it will project a one-year horizon.`,
          );
        }

        let proxy: ProxyOutlook | null = null;
        let conditional: ConditionalStudy | null = null;

        if (proxyBars.ok && proxyBars.value.bars.length >= 800) {
          const pb = proxyBars.value.bars;
          // Beta measured over the fund's own history, then used to re-lever the
          // proxy's returns. Falls back to 1 rather than inventing a number.
          // Scaled to match BAI's measured volatility — see buildProxyOutlook
          // for why volatility, not beta, is the right scalar for a risk range.
          proxy = buildProxyOutlook(
            pb,
            base.spotPrice,
            base.annualisedVolPct,
            PROXY_NAME,
          );
          conditional = conditionalStudy(bars, pb, PROXY_NAME);
        }

        return { ...base, proxy, conditional };
      },
    );

    return ok(res.value, {
      source: 'computed',
      asOf: `${asOf}T21:00:00.000Z`,
      retrievedAt: new Date().toISOString(),
      reliability: res.stale ? 'stale' : 'live',
      label: 'Simulated from BAI’s own daily price history',
      note:
        'Not a forecast of direction. These are the outcomes BAI’s own past ' +
        'behaviour makes plausible, with the odds attached.',
    });
  } catch (err) {
    return missing(
      'insufficient-history',
      err instanceof Error ? err.message : String(err),
    );
  }
}
