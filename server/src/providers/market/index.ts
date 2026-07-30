import { config, configuredMarketProviders } from '../../config';
import { cached, readCache } from '../../cache/diskCache';
import type { PriceSeries, PriceBar, Quote } from '../../types';
import { ok, missing, type Sourced, type Provenance } from '../../util/provenance';
import { tiingoProvider } from './tiingo';
import { eodhdProvider } from './eodhd';
import { polygonProvider } from './polygon';
import { alphaVantageProvider } from './alphavantage';
import { NotCoveredError, type MarketDataProvider } from './types';
import { syntheticWorld } from '../../fixtures/synthetic';
import { today } from '../../util/dates';
import { sessionState, lastCompletedTradingDate } from '../../domain/session';

/**
 * Last time a staleness-triggered refetch was attempted, per symbol.
 *
 * Vendors publish end-of-day bars with a lag, so between 16:00 ET and whenever
 * the bar actually lands, every request would find the series "stale", refetch,
 * and still not get the new bar — burning the 45/hour Tiingo budget in minutes.
 * This throttles those attempts. In-memory is the right scope: it is a
 * politeness timer, and losing it on restart costs one extra request.
 */
/** Shape stored under the `bars-full:<symbol>` key. */
interface CachedBars {
  bars: PriceBar[];
  providerId: string;
  label: string;
  sourceKind: string;
}

const staleRetry = new Map<string, number>();
const STALE_RETRY_MS = 20 * 60 * 1000;

/**
 * True when a cached series is missing a session that has already closed.
 *
 * A flat TTL cannot express this: a series fetched at 14:00 ET legitimately has
 * no bar for that day, and stays "fresh" by TTL well past the close. Callers
 * treat this as authority to refetch even on a TTL hit.
 */
function missesCompletedSession(lastBarDate: string | undefined, symbol: string): boolean {
  if (!lastBarDate) return false;
  if (lastBarDate >= lastCompletedTradingDate()) return false;

  const last = staleRetry.get(symbol) ?? 0;
  if (Date.now() - last < STALE_RETRY_MS) return false;
  staleRetry.set(symbol, Date.now());
  return true;
}

function build(): MarketDataProvider[] {
  const out: MarketDataProvider[] = [];
  for (const id of configuredMarketProviders()) {
    const p = config.providers;
    if (id === 'tiingo' && p.tiingo) out.push(tiingoProvider(p.tiingo));
    if (id === 'eodhd' && p.eodhd) out.push(eodhdProvider(p.eodhd));
    if (id === 'polygon' && p.polygon) out.push(polygonProvider(p.polygon));
    if (id === 'alphavantage' && p.alphavantage) {
      out.push(alphaVantageProvider(p.alphavantage));
    }
  }
  return out;
}

let providers: MarketDataProvider[] | null = null;
function chain(): MarketDataProvider[] {
  providers ??= build();
  return providers;
}

export function providerStatus(): {
  configured: string[];
  fixturesActive: boolean;
  nonUsCapable: boolean;
  realtime: boolean;
} {
  const c = chain();
  return {
    configured: c.map((p) => p.label),
    fixturesActive: config.fixtures.enabled,
    nonUsCapable: c.some((p) => p.supportsNonUs),
    realtime: c.some((p) => p.realtime),
  };
}

function syntheticProvenance(label: string, asOf: string): Provenance {
  return {
    source: 'synthetic.fixture',
    asOf,
    retrievedAt: new Date().toISOString(),
    reliability: 'synthetic',
    label: `SYNTHETIC FIXTURE — ${label}`,
    note:
      'Generated demo data. Not real market data. Configure a market-data ' +
      'provider key to replace it.',
  };
}

/**
 * Ordered fallback across vendors.
 *
 * `NotCoveredError` means "this vendor cannot resolve this symbol" (typically a
 * foreign listing hitting a US-only vendor) and moves to the next in the chain.
 * A genuine outage also falls through, but is recorded so the last error can be
 * reported rather than swallowed into a generic "unavailable".
 */
async function tryChain<T>(
  what: string,
  symbol: string,
  run: (p: MarketDataProvider) => Promise<T>,
): Promise<{ value: T; provider: MarketDataProvider } | { error: string }> {
  const c = chain();
  if (c.length === 0) {
    return { error: 'No market-data provider is configured.' };
  }
  const errors: string[] = [];
  for (const p of c) {
    try {
      return { value: await run(p), provider: p };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${p.id}: ${msg}`);
      if (!(err instanceof NotCoveredError)) {
        // Non-coverage failures are worth surfacing even if a later provider
        // succeeds, but we keep trying.
        continue;
      }
    }
  }
  return { error: `${what} for ${symbol} failed — ${errors.join('; ')}` };
}

export async function getDailyBars(
  symbol: string,
  start: string,
  end: string,
): Promise<Sourced<PriceSeries>> {
  if (config.fixtures.enabled) {
    const world = syntheticWorld(today());
    const bars = world.series.get(symbol);
    if (!bars) {
      return missing(
        'not-covered',
        `No synthetic series exists for "${symbol}".`,
        'synthetic.fixture',
      );
    }
    const sliced = bars.filter((b) => b.date >= start && b.date <= end);
    const prov = syntheticProvenance(
      `daily bars for ${symbol}`,
      sliced.at(-1)?.date ?? end,
    );
    return ok({ symbol, bars: sliced, currency: 'USD', provenance: prov }, prov);
  }

  // Cache one FULL series per symbol and slice windows locally, rather than
  // caching per requested window. Window-keyed caching multiplies vendor
  // requests by every distinct timeframe the UI can ask for (7 timeframes ×
  // ~50 holdings exhausted Tiingo's free hourly allocation in one render);
  // symbol-keyed caching makes the whole dashboard cost one request per symbol
  // per TTL, and timeframe switches are free.
  const FULL_START = '2004-01-01';
  const key = `bars-full:${symbol}`;
  // vendorSymbol() suffixes foreign listings (".KS", ".TW", ".T"); a bare
  // ticker is US. Those venues close before the US session, so their bar is
  // already final for the day — see config.ttl.dailyBarsForeign.
  const ttl = symbol.includes('.')
    ? config.ttl.dailyBarsForeign
    : config.ttl.dailyBars;

  /*
   * Peek at the cached series before trusting its TTL.
   *
   * A series fetched mid-session has no bar for that day, so once the close
   * passes it is stale regardless of how much TTL is left. Forcing ttl=0 in that
   * case reuses the existing cache-aside path (including its stale-on-error
   * behaviour) instead of adding a second code path around it.
   */
  const peek = await readCache<CachedBars>(key, ttl);
  const lastBarDate = peek?.value.bars.at(-1)?.date;
  const effectiveTtl = missesCompletedSession(lastBarDate, symbol) ? 0 : ttl;

  try {
    const res = await cached(key, effectiveTtl, async () => {
      const r = await tryChain('Daily bars', symbol, (p) =>
        p.dailyBars(symbol, FULL_START, today()),
      );
      if ('error' in r) throw new Error(r.error);
      /*
       * MERGE with the cached series instead of replacing it.
       *
       * Providers do not all serve the same depth: EODHD's free tier returns
       * only one year. When Tiingo is rate-limited and the chain falls through,
       * a replace-write let a 1-year response overwrite a full-history series —
       * the public deploy shipped with BAI cut from 442 bars to 251 and the
       * outlook model refusing to run. A union by date keeps the accumulated
       * depth; fresh bars win on overlapping dates.
       */
      const prior = peek?.value.bars ?? [];
      const merged = new Map(prior.map((b) => [b.date, b]));
      for (const b of r.value) merged.set(b.date, b);
      const bars = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
      return { bars, providerId: r.provider.id, label: r.provider.label,
        sourceKind: r.provider.sourceKind };
    });

    const { label, sourceKind } = res.value;
    const bars = res.value.bars.filter((b) => b.date >= start && b.date <= end);
    if (bars.length === 0) {
      return missing(
        'not-covered',
        `Provider returned zero bars for ${symbol} between ${start} and ${end}.`,
        sourceKind,
      );
    }
    const prov: Provenance = {
      source: sourceKind,
      asOf: `${bars.at(-1)?.date ?? end}T21:00:00.000Z`,
      retrievedAt: new Date().toISOString(),
      reliability: res.stale ? 'stale' : 'live',
      label,
      ...(res.stale
        ? { note: `Cached copy; provider failed on last refresh.` }
        : {}),
    };
    return ok({ symbol, bars, currency: 'USD', provenance: prov }, prov);
  } catch (err) {
    return missing(
      'provider-error',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Batched intraday quotes for many symbols at once. Returns whatever subset
 * the vendor could price — callers treat absence per-symbol, not all-or-
 * nothing. Cached briefly so a page render with several consumers costs one
 * upstream request.
 */
export async function getQuotes(
  symbols: string[],
): Promise<{ quotes: Map<string, Quote>; provenance: Provenance } | null> {
  if (config.fixtures.enabled || symbols.length === 0) return null;
  const withBatch = chain().find((p) => p.quotes !== undefined);
  if (!withBatch) return null;

  const sorted = [...symbols].sort();
  try {
    /*
     * Outside the US session a "quote" is just the last close, and it cannot
     * change until the next open — so refetching it every 2 minutes spends a
     * scarce free-tier budget to receive an identical answer. Holding it for
     * 30 minutes when the market is shut leaves the whole allowance available
     * for the hours that actually move.
     */
    const ttl = sessionState().open ? config.ttl.quote : config.ttl.quoteClosed;
    const res = await cached(
      `quotes-batch:${sorted.join(',').slice(0, 400)}`,
      ttl,
      async () => {
        const m = await withBatch.quotes!(sorted);
        return [...m.entries()];
      },
    );
    return {
      quotes: new Map(res.value),
      provenance: {
        source: withBatch.sourceKind,
        asOf: new Date(Date.now() - res.ageSeconds * 1000).toISOString(),
        retrievedAt: new Date().toISOString(),
        reliability: res.stale ? 'stale' : 'live',
        label: withBatch.label,
        note: withBatch.realtime
          ? undefined
          : 'Delayed intraday quotes — not real time.',
      },
    };
  } catch {
    return null;
  }
}

export async function getQuote(symbol: string): Promise<Sourced<Quote>> {
  if (config.fixtures.enabled) {
    const world = syntheticWorld(today());
    const bars = world.series.get(symbol);
    const last = bars?.at(-1);
    const prev = bars?.at(-2);
    if (!last || !prev) {
      return missing(
        'not-covered',
        `No synthetic quote for "${symbol}".`,
        'synthetic.fixture',
      );
    }
    const window52 = (bars ?? []).slice(-252);
    const prov = syntheticProvenance(`quote for ${symbol}`, last.date);
    return ok(
      {
        symbol,
        last: last.close,
        change: last.close - prev.close,
        changePct: ((last.close - prev.close) / prev.close) * 100,
        dayHigh: last.high,
        dayLow: last.low,
        volume: last.volume,
        avgVolume30d:
          (bars ?? []).slice(-30).reduce((a, b) => a + b.volume, 0) /
          Math.min(30, bars?.length ?? 1),
        week52High: Math.max(...window52.map((b) => b.high)),
        week52Low: Math.min(...window52.map((b) => b.low)),
        previousClose: prev.close,
        marketClosed: true,
      },
      prov,
    );
  }

  try {
    const res = await cached(`quote:${symbol}`, config.ttl.quote, async () => {
      const r = await tryChain('Quote', symbol, (p) => p.quote(symbol));
      if ('error' in r) throw new Error(r.error);
      return {
        quote: r.value,
        label: r.provider.label,
        sourceKind: r.provider.sourceKind,
        realtime: r.provider.realtime,
      };
    });
    const { quote, label, sourceKind, realtime } = res.value;
    const prov: Provenance = {
      source: sourceKind,
      asOf: new Date(Date.now() - res.ageSeconds * 1000).toISOString(),
      retrievedAt: new Date().toISOString(),
      reliability: res.stale ? 'stale' : 'live',
      label,
      note: realtime
        ? undefined
        : 'Delayed quote — not real time. Do not use for execution decisions.',
    };
    return ok(quote, prov);
  } catch (err) {
    return missing(
      'provider-error',
      err instanceof Error ? err.message : String(err),
    );
  }
}
