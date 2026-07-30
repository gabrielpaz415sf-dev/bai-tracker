import type { PriceBar, Quote } from '../../types';
import { getJson, pctChange, NotCoveredError, type MarketDataProvider } from './types';
import { spend } from './rateLimit';

interface EodBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjusted_close: number;
  volume: number;
}

interface EodQuote {
  code: string;
  close: number;
  previousClose: number;
  change: number;
  change_p: number;
  high: number;
  low: number;
  volume: number;
  timestamp: number;
}

/**
 * EODHD. The important one for this fund: it resolves foreign venues, so
 * SK hynix (`000660.KS`), TSMC (`2330.TW`) and the Japanese equipment names
 * get real prices instead of dropping out of attribution entirely.
 */
export function eodhdProvider(apiKey: string): MarketDataProvider {
  const base = 'https://eodhd.com/api';

  /**
   * EODHD's venue codes are its own, not the Yahoo-style suffixes that
   * domain/exchanges.ts hands out. Two of them differ, and getting them wrong
   * is expensive here: `000660.KS` is SK hynix, the fund's single largest
   * position at ~6.9%, and it silently dropped out of every attribution.
   *
   * "Silently" is the operative word — EODHD answers a wrong venue code with
   * HTTP 200 and every field set to the string "NA" rather than an error, so
   * an unguarded adapter coerces that to NaN/0 and reports a real-looking
   * zero-return holding. See isNA below.
   */
  const VENUE_FIXUPS: Record<string, string> = {
    '.KS': '.KO', // Korea Exchange — verified against 000660 (SK hynix)
  };

  const resolve = (s: string): string => {
    if (!s.includes('.')) return `${s}.US`; // EODHD wants .US explicitly
    const dot = s.lastIndexOf('.');
    const suffix = s.slice(dot);
    return VENUE_FIXUPS[suffix] ? s.slice(0, dot) + VENUE_FIXUPS[suffix] : s;
  };

  /**
   * EODHD returns "NA" (the string) for an unknown or uncovered symbol, with a
   * 200 status. Treat that as not-covered so the chain falls through and the
   * holding is reported as unpriced, rather than fabricating a price from NaN.
   */
  const isNA = (v: unknown): boolean =>
    v === 'NA' || v === null || v === undefined || Number.isNaN(Number(v));

  return {
    id: 'eodhd',
    sourceKind: 'market.eodhd',
    label: 'EODHD (end-of-day, global venues)',
    supportsNonUs: true,
    realtime: false,

    async dailyBars(symbol, start, end): Promise<PriceBar[]> {
      spend('eodhd');
      const url =
        `${base}/eod/${encodeURIComponent(resolve(symbol))}` +
        `?from=${start}&to=${end}&period=d&fmt=json&api_token=${apiKey}`;
      const raw = await getJson<EodBar[]>(url);
      // Drop "NA" rows rather than letting them become NaN closes — a single
      // NaN propagates through the return calculation and poisons the whole
      // series, which then reads as a real number rather than a gap.
      const bars = raw
        .filter((b) => !isNA(b.close) && !isNA(b.adjusted_close))
        .map((b) => ({
          date: b.date,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          adjClose: b.adjusted_close,
          volume: b.volume,
        }));
      if (bars.length === 0) {
        throw new NotCoveredError(`EODHD has no bars for ${resolve(symbol)}.`);
      }
      return bars;
    },

    async quote(symbol): Promise<Quote> {
      spend('eodhd');
      const url =
        `${base}/real-time/${encodeURIComponent(resolve(symbol))}` +
        `?fmt=json&api_token=${apiKey}`;
      const q = await getJson<EodQuote>(url);
      if (isNA(q.close) || isNA(q.previousClose)) {
        throw new NotCoveredError(
          `EODHD has no price for ${resolve(symbol)} (returned "NA").`,
        );
      }
      return {
        symbol,
        last: q.close,
        change: q.change,
        changePct: q.change_p ?? pctChange(q.previousClose, q.close),
        dayHigh: q.high,
        dayLow: q.low,
        volume: q.volume,
        avgVolume30d: null,
        week52High: null,
        week52Low: null,
        previousClose: q.previousClose,
        // EODHD stamps the last trade; if it is more than ~10 minutes old the
        // venue is closed (or we are outside its session).
        marketClosed: Date.now() / 1000 - q.timestamp > 600,
      };
    },
  };
}
