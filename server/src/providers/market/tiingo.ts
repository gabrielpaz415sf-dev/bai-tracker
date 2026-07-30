import type { PriceBar, Quote } from '../../types';
import {
  getJson,
  pctChange,
  NotCoveredError,
  type MarketDataProvider,
} from './types';
import { spend } from './rateLimit';
import { sessionState } from '../../domain/session';

interface TiingoBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose: number;
  adjOpen: number;
  adjHigh: number;
  adjLow: number;
  adjVolume: number;
}

interface TiingoIex {
  ticker: string;
  last: number | null;
  prevClose: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  tngoLast: number | null;
  timestamp: string;
}

/**
 * Tiingo: good free tier, clean split/dividend-adjusted daily history back far
 * enough for the horizon simulators. US-listed coverage only, so foreign
 * holdings fall through to the next provider in the chain.
 */
export function tiingoProvider(apiKey: string): MarketDataProvider {
  const base = 'https://api.tiingo.com';
  const auth = { Authorization: `Token ${apiKey}` };

  return {
    id: 'tiingo',
    sourceKind: 'market.tiingo',
    label: 'Tiingo (end-of-day, IEX delayed intraday)',
    supportsNonUs: false,
    realtime: false,

    async dailyBars(symbol, start, end): Promise<PriceBar[]> {
      if (symbol.includes('.')) {
        throw new NotCoveredError(
          `Tiingo does not resolve non-US symbol "${symbol}".`,
        );
      }
      spend('tiingo');
      const url =
        `${base}/tiingo/daily/${encodeURIComponent(symbol)}/prices` +
        `?startDate=${start}&endDate=${end}&format=json`;
      const raw = await getJson<TiingoBar[]>(url, { headers: auth });
      return raw.map((b) => ({
        date: b.date.slice(0, 10),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        adjClose: b.adjClose,
        volume: b.volume,
      }));
    },

    async quotes(symbols): Promise<Map<string, Quote>> {
      const us = symbols.filter((s) => !s.includes('.'));
      const out = new Map<string, Quote>();
      if (us.length === 0) return out;
      // Tiingo's IEX endpoint accepts a comma-separated list — the whole
      // holdings table costs one request.
      spend('tiingo');
      const url = `${base}/iex/?tickers=${us.map(encodeURIComponent).join(',')}`;
      const rows = await getJson<TiingoIex[]>(url, { headers: auth });
      for (const q of rows) {
        const last = q.last ?? q.tngoLast;
        if (last === null || q.prevClose === null) continue;
        out.set(q.ticker.toUpperCase(), {
          symbol: q.ticker.toUpperCase(),
          last,
          change: last - q.prevClose,
          changePct: pctChange(q.prevClose, last),
          dayHigh: q.high ?? last,
          dayLow: q.low ?? last,
          volume: q.volume ?? 0,
          avgVolume30d: null,
          week52High: null,
          week52Low: null,
          previousClose: q.prevClose,
          // Clock, not liquidity: IEX's `last` is null whenever this venue has
          // had no recent print, which is routine mid-session for thin names.
          marketClosed: !sessionState().open,
        });
      }
      return out;
    },

    async quote(symbol): Promise<Quote> {
      spend('tiingo');
      const url = `${base}/iex/${encodeURIComponent(symbol)}`;
      const rows = await getJson<TiingoIex[]>(url, { headers: auth });
      const q = rows[0];
      // Outside the session `last` is null but `tngoLast` (Tiingo's own last
      // computed price) usually survives. Only give up when both are absent.
      const last = q ? (q.last ?? q.tngoLast) : null;
      if (!q || last === null || q.prevClose === null) {
        throw new NotCoveredError(`Tiingo returned no live quote for ${symbol}.`);
      }
      return {
        symbol,
        last,
        change: last - q.prevClose,
        changePct: pctChange(q.prevClose, last),
        dayHigh: q.high ?? last,
        dayLow: q.low ?? last,
        volume: q.volume ?? 0,
        avgVolume30d: null,
        week52High: null,
        week52Low: null,
        previousClose: q.prevClose,
        marketClosed: !sessionState().open,
      };
    },
  };
}
