import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// Load provider keys from the repo-root .env (gitignored) so a plain
// `npm run dev` works without exporting variables each time. Real env vars
// win over the file: process.loadEnvFile never overwrites existing entries.
try {
  // here = server/src (tsx) or server/dist (built) — both one level under
  // server/, so the repo root is two levels up either way.
  process.loadEnvFile(path.resolve(here, '../../.env'));
} catch {
  /* no .env file — fixture mode will engage */
}
export const DATA_DIR = process.env.BAI_DATA_DIR ?? path.resolve(here, '../data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),

  /**
   * Fixture mode. ON when explicitly requested, and also the automatic
   * fallback when no market-data provider key exists — otherwise a first-run
   * user sees a dashboard of empty states and cannot evaluate anything.
   * Whenever it is on, every payload is stamped so the UI can shout about it.
   */
  fixtures: {
    enabled:
      env('BAI_FIXTURES') === '1' ||
      (env('BAI_FIXTURES') !== '0' && !hasAnyMarketKey()),
    /** Seed keeps generated series reproducible across restarts. */
    seed: Number(env('BAI_FIXTURE_SEED') ?? 20241021),
  },

  providers: {
    tiingo: env('TIINGO_API_KEY'),
    polygon: env('POLYGON_API_KEY'),
    alphavantage: env('ALPHAVANTAGE_API_KEY'),
    eodhd: env('EODHD_API_KEY'),
    marketaux: env('MARKETAUX_API_KEY'),
    /** Writes the daily plain-English summary. Not a market-data provider:
     *  its absence never triggers fixture mode, only hides the summary. */
    anthropic: env('ANTHROPIC_API_KEY'),
  },

  /** Preference order; first configured provider wins, rest are fallbacks. */
  marketProviderOrder: (env('BAI_MARKET_PROVIDER_ORDER') ??
    'tiingo,eodhd,polygon,alphavantage')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Refresh cadence per field class, in seconds. Everything is cached to disk
   * with these TTLs. See README "Data sources & refresh cadence".
   */
  ttl: {
    /** Issuer publishes holdings once per business day, after the close. */
    holdings: 6 * 60 * 60,
    /** NAV struck once daily at 4pm ET. */
    nav: 6 * 60 * 60,
    /**
     * Delayed quotes. Real-time requires an entitled provider tier.
     * 120s keeps the live panel's auto-refresh at ~30 requests/hour, inside
     * the free-tier hourly budget with room for the daily-bar backfill.
     */
    quote: 120,
    /**
     * Quotes while the US session is shut. The value cannot change until the
     * next open, so a short TTL only spends free-tier budget to re-receive the
     * same close. See getQuotes in providers/market/index.ts.
     */
    quoteClosed: 30 * 60,
    /**
     * Daily bars: once per day.
     *
     * A bar is final the moment its session closes, so re-asking within the
     * same day can only ever return the identical row. The old 6h TTL therefore
     * bought nothing and cost everything: ~50 cached symbols x 4 refreshes =
     * ~200 Tiingo calls/day, and a single refresh cycle (50 calls) could not
     * even fit inside the 45/hour cap, so it perpetually half-completed and
     * retried.
     *
     * Freshness is not lost by lengthening this, because
     * missesCompletedSession() in providers/market/index.ts forces a refetch as
     * soon as a session closes that the series is missing — the calendar, not
     * the clock, decides when new data exists.
     */
    dailyBars: 24 * 60 * 60,
    /**
     * Foreign daily bars refresh once a day, not four times.
     *
     * Two reasons. Correctness: KRX/TWSE/TSE all close before the US session
     * opens, so re-asking during the US day can only ever return the same bar.
     * Budget: only EODHD resolves these venues and its free tier allows ~20
     * requests/day, while the fund holds ~11 foreign equities — at the 6h TTL
     * a couple of refresh cycles would exhaust the day's allocation and the
     * largest holding (SK hynix) would start dropping out of attribution.
     */
    dailyBarsForeign: 24 * 60 * 60,
    /**
     * News: 4h rather than 15m. A headline explaining a move stays the
     * explanation all day, and the 15m TTL was re-billing the ~100/day
     * Marketaux allowance roughly 16x more often than the content changed.
     */
    news: 4 * 60 * 60,
    fundFacts: 24 * 60 * 60,
    /**
     * The AI-written daily summary. The cache key already carries the ET date
     * and the market-open/closed bucket, so this TTL only guards against
     * regenerating within the same bucket — 12h means at most two generations
     * per trading day (the mid-session refresh and the after-close one).
     */
    summary: 12 * 60 * 60,
  },

  /** Beta estimation. */
  beta: {
    estimationWindowDays: 120,
    /** Below this R², we show the number but refuse to narrate a causal split. */
    minRSquared: 0.5,
    defaultBenchmark: 'QQQ',
  },

  benchmarks: [
    { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
    { symbol: 'SOXX', name: 'iShares Semiconductor ETF' },
    { symbol: 'ARTY', name: 'iShares Future AI & Tech ETF' },
    { symbol: 'IGPT', name: 'Invesco AI and Next Gen Software ETF' },
  ],

  /**
   * Long-horizon proxy. BAI launched 2024-10-21, so a 5- or 10-year holding
   * period is not computable from its own history. We fall back to this series
   * strictly for the shape of the dispersion-vs-horizon relationship, and the
   * UI labels every proxy figure as not-BAI.
   */
  longHorizonProxy: {
    symbol: 'QQQ',
    rationale:
      'BAI has less than two years of history, so the 3-, 5- and 10-year rows ' +
      'use QQQ instead. They show how results spread out over long holding ' +
      'periods in a broad tech fund — not what BAI would have done. QQQ holds ' +
      'far more companies, is far less concentrated, and moves less sharply.',
  },

  /** US session close in ET, used for foreign-price staleness detection. */
  usSessionCloseHourET: 16,

  /**
   * HTTP basic auth for tunnel-exposed traffic. See requireAuthForTunnel in
   * index.ts for why local requests are exempt.
   */
  auth: {
    user: env('BAI_AUTH_USER') ?? 'bai',
    pass: env('BAI_AUTH_PASS'),
    /**
     * Shared link token. Preferred over basic auth for the tunnel: a browser
     * hitting a 401 renders a bare "Authentication required." page rather than
     * reliably prompting, so the link simply looks broken. A token in the query
     * string makes the URL itself the credential — one click, no dialog — and
     * still keeps crawlers off the free-tier request budget, which is the
     * actual thing being protected.
     */
    token: env('BAI_ACCESS_TOKEN'),
    /** Force auth on every request, including direct localhost. */
    always: env('BAI_AUTH_ALWAYS') === '1',
  },

  /**
   * Daily-brief delivery. Each channel is independently gated on its own
   * config being present, so an unconfigured or broken channel degrades to a
   * log line — the brief file itself is written before delivery is attempted
   * and never depends on it.
   */
  delivery: {
    /** macOS notification centre banner. Off unless explicitly enabled. */
    notify: env('BAI_NOTIFY') === '1',
    email: {
      to: env('BRIEF_EMAIL_TO'),
      host: env('SMTP_HOST') ?? 'smtp.gmail.com',
      port: Number(env('SMTP_PORT') ?? 465),
      user: env('SMTP_USER'),
      /**
       * Supplied by the operator in .env — for Gmail this must be an App
       * Password (Google account → Security → App passwords), not the account
       * password. Never logged; redacted from any error surface.
       */
      pass: env('SMTP_PASS'),
    },
  },
} as const;

function hasAnyMarketKey(): boolean {
  return Boolean(
    env('TIINGO_API_KEY') ??
      env('POLYGON_API_KEY') ??
      env('ALPHAVANTAGE_API_KEY') ??
      env('EODHD_API_KEY'),
  );
}

export function configuredMarketProviders(): string[] {
  const keys: Record<string, string | undefined> = {
    tiingo: config.providers.tiingo,
    polygon: config.providers.polygon,
    alphavantage: config.providers.alphavantage,
    eodhd: config.providers.eodhd,
  };
  return config.marketProviderOrder.filter((p) => Boolean(keys[p]));
}
