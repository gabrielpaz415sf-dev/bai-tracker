import type { PriceBar, Quote } from '../../types';
import {
  getJson,
  pctChange,
  ProviderError,
  NotCoveredError,
  type MarketDataProvider,
} from './types';

interface AvDailyResp {
  'Time Series (Daily)'?: Record<
    string,
    {
      '1. open': string;
      '2. high': string;
      '3. low': string;
      '4. close': string;
      '5. adjusted close'?: string;
      '6. volume'?: string;
      '5. volume'?: string;
    }
  >;
  Note?: string;
  Information?: string;
  'Error Message'?: string;
}

interface AvQuoteResp {
  'Global Quote'?: Record<string, string>;
  Note?: string;
  Information?: string;
}

/**
 * Alpha Vantage. Included because the free key is trivial to obtain, but it is
 * last in the default order for a reason: the free tier allows ~25 requests per
 * day, which one full holdings refresh (54 names + 5 benchmarks) blows through
 * immediately. Fine as a backstop for the fund's own series; not viable as the
 * per-holding source.
 *
 * It also signals throttling with HTTP 200 plus a `Note`/`Information` body,
 * so success has to be checked in the payload rather than the status code.
 */
export function alphaVantageProvider(apiKey: string): MarketDataProvider {
  const base = 'https://www.alphavantage.co/query';

  const assertNotThrottled = (r: {
    Note?: string;
    Information?: string;
    'Error Message'?: string;
  }): void => {
    const msg = r.Note ?? r.Information;
    if (msg) throw new ProviderError(`Alpha Vantage throttled: ${msg}`);
    if (r['Error Message']) throw new NotCoveredError(r['Error Message']);
  };

  return {
    id: 'alphavantage',
    sourceKind: 'market.alphavantage',
    label: 'Alpha Vantage (end-of-day, heavily rate-limited free tier)',
    supportsNonUs: false,
    realtime: false,

    async dailyBars(symbol, start, end): Promise<PriceBar[]> {
      const url =
        `${base}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=` +
        `${encodeURIComponent(symbol)}&outputsize=full&apikey=${apiKey}`;
      const raw = await getJson<AvDailyResp>(url);
      assertNotThrottled(raw);
      const series = raw['Time Series (Daily)'];
      if (!series) throw new NotCoveredError(`No daily series for ${symbol}.`);

      return Object.entries(series)
        .filter(([d]) => d >= start && d <= end)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => {
          const close = Number(v['4. close']);
          return {
            date,
            open: Number(v['1. open']),
            high: Number(v['2. high']),
            low: Number(v['3. low']),
            close,
            adjClose: Number(v['5. adjusted close'] ?? close),
            volume: Number(v['6. volume'] ?? v['5. volume'] ?? 0),
          };
        });
    },

    async quote(symbol): Promise<Quote> {
      const url =
        `${base}?function=GLOBAL_QUOTE&symbol=` +
        `${encodeURIComponent(symbol)}&apikey=${apiKey}`;
      const raw = await getJson<AvQuoteResp>(url);
      assertNotThrottled(raw);
      const g = raw['Global Quote'];
      if (!g || !g['05. price']) {
        throw new NotCoveredError(`No quote for ${symbol}.`);
      }
      const last = Number(g['05. price']);
      const prev = Number(g['08. previous close']);
      return {
        symbol,
        last,
        change: Number(g['09. change'] ?? last - prev),
        changePct: pctChange(prev, last),
        dayHigh: Number(g['03. high'] ?? last),
        dayLow: Number(g['04. low'] ?? last),
        volume: Number(g['06. volume'] ?? 0),
        avgVolume30d: null,
        week52High: null,
        week52Low: null,
        previousClose: prev,
        marketClosed: true,
      };
    },
  };
}
