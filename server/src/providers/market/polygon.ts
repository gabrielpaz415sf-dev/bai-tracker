import type { PriceBar, Quote } from '../../types';
import {
  getJson,
  pctChange,
  NotCoveredError,
  type MarketDataProvider,
} from './types';

interface PolyAggResp {
  results?: Array<{
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
  }>;
  resultsCount?: number;
}

interface PolySnapResp {
  ticker?: {
    day: { o: number; h: number; l: number; c: number; v: number };
    prevDay: { o: number; h: number; l: number; c: number; v: number };
    lastTrade?: { p: number };
    todaysChange: number;
    todaysChangePerc: number;
  };
}

/**
 * Polygon.io. Best intraday/real-time coverage of the four, so it is the one
 * to reach for if you want a genuinely live quote block rather than a delayed
 * one. US venues only.
 *
 * Note the `adjusted=true` aggregate: Polygon returns split-adjusted closes but
 * does not fold dividends in, so `adjClose` here is split-adjusted only. For a
 * ~0%-yield AI fund the difference is immaterial; for the QQQ long-horizon
 * proxy it is not, which is why Tiingo/EODHD sort ahead of it by default.
 */
export function polygonProvider(apiKey: string): MarketDataProvider {
  const base = 'https://api.polygon.io';

  return {
    id: 'polygon',
    sourceKind: 'market.polygon',
    label: 'Polygon.io (split-adjusted daily, real-time on entitled tiers)',
    supportsNonUs: false,
    realtime: true,

    async dailyBars(symbol, start, end): Promise<PriceBar[]> {
      if (symbol.includes('.')) {
        throw new NotCoveredError(
          `Polygon does not resolve non-US symbol "${symbol}".`,
        );
      }
      const url =
        `${base}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/` +
        `${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
      const raw = await getJson<PolyAggResp>(url);
      return (raw.results ?? []).map((b) => ({
        date: new Date(b.t).toISOString().slice(0, 10),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        adjClose: b.c,
        volume: b.v,
      }));
    },

    async quote(symbol): Promise<Quote> {
      const url =
        `${base}/v2/snapshot/locale/us/markets/stocks/tickers/` +
        `${encodeURIComponent(symbol)}?apiKey=${apiKey}`;
      const raw = await getJson<PolySnapResp>(url);
      const t = raw.ticker;
      if (!t) throw new NotCoveredError(`Polygon has no snapshot for ${symbol}.`);
      const last = t.lastTrade?.p ?? t.day.c;
      return {
        symbol,
        last,
        change: t.todaysChange,
        changePct: t.todaysChangePerc ?? pctChange(t.prevDay.c, last),
        dayHigh: t.day.h,
        dayLow: t.day.l,
        volume: t.day.v,
        avgVolume30d: null,
        week52High: null,
        week52Low: null,
        previousClose: t.prevDay.c,
        marketClosed: t.day.v === 0,
      };
    },
  };
}
