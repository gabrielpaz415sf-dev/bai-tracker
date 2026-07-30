import { config } from '../config';
import {
  FUND,
  type AttributionResult,
  type BenchmarkReturn,
  type Concentration,
  type HoldingsSnapshot,
  type PriceBar,
  type ReturnRow,
  type TimeframeKey,
  type NavData,
  type Quote,
} from '../types';
import { ok, missing, derive, type Sourced, type Provenance } from '../util/provenance';
import { getHoldingsSnapshot, fundFactsLinks } from '../providers/ishares';
import { getDailyBars, getQuote, getQuotes, providerStatus } from '../providers/market';
import { getNewsFor } from '../providers/news';
import { syntheticWorld } from '../fixtures/synthetic';
import { resolveTimeframe, today, daysBetween, TIMEFRAME_LABELS } from '../util/dates';
import { windowReturnPct } from '../analytics/returns';
import { estimateBeta } from '../analytics/beta';
import { computeConcentration, equityHoldings } from '../analytics/concentration';
import {
  computeContributions,
  rollupContributions,
  computeManagerEffect,
  coveragePct,
  subThemeLabel,
  symbolsFor,
  stalenessSummary,
  type PricedHolding,
} from '../analytics/attribution';
import { buildNarrative } from '../narrative/narrative';
import {
  saveSnapshot,
  snapshotAtOrBefore,
  diffSnapshots,
  listSnapshotDates,
} from '../store/holdingsHistory';

const ALL_TIMEFRAMES: TimeframeKey[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'SI'];

/** Bound concurrency so a 54-name refresh doesn't trip provider rate limits. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      const item = items[i];
      if (item !== undefined) out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function loadHoldings(): Promise<Sourced<HoldingsSnapshot>> {
  if (config.fixtures.enabled) {
    const w = syntheticWorld(today());
    const snap: HoldingsSnapshot = {
      asOfDate: w.tradingDays.at(-1) ?? today(),
      holdings: w.holdings,
      provenance: {
        source: 'synthetic.fixture',
        asOf: `${w.tradingDays.at(-1) ?? today()}T21:00:00.000Z`,
        retrievedAt: new Date().toISOString(),
        reliability: 'synthetic',
        label: 'SYNTHETIC FIXTURE — holdings roster',
        note:
          'Roster and weights are modelled on BAI\'s published portfolio so the ' +
          'sector/geography logic is exercised realistically. All prices and ' +
          'returns attached to them are invented.',
      },
    };
    return ok(snap, snap.provenance);
  }

  const snap = await getHoldingsSnapshot();
  if (snap.ok) {
    // Archive silently; this is what makes weight-change diffing possible.
    await saveSnapshot(snap.value);
  }
  return snap;
}

async function fundBars(): Promise<Sourced<PriceBar[]>> {
  const s = await getDailyBars('BAI', FUND.inceptionDate, today());
  return s.ok ? ok(s.value.bars, s.provenance) : s;
}

export async function getOverview(): Promise<Record<string, unknown>> {
  const [holdings, bars, rawQuote] = await Promise.all([
    loadHoldings(),
    fundBars(),
    getQuote('BAI'),
  ]);

  // Intraday quote endpoints go quiet outside the session. Rather than showing
  // an empty quote block all weekend, fall back to the last two daily closes —
  // explicitly labelled as a closed-market quote, never passed off as live.
  // When a live quote IS present, still fill the 52-week range and average
  // volume from the daily series, since the intraday feed doesn't carry them.
  const quote = enrichQuote(rawQuote, bars);

  const concentration: Sourced<Concentration> = holdings.ok
    ? ok(computeConcentration(holdings.value.holdings), holdings.provenance)
    : holdings;

  const returns = bars.ok ? buildReturnsTable(bars.value) : [];
  const benchmarks = bars.ok ? await buildBenchmarks(bars.value, 'YTD') : [];

  /*
   * NAV, computed from the issuer's own file rather than bought from a vendor.
   *
   * The holdings CSV preamble publishes `Shares Outstanding`, and every row
   * carries `Market Value`. NAV per share is definitionally the total market
   * value of the portfolio divided by shares outstanding, so both halves are
   * already on hand — no entitled ETF feed required, which previously left this
   * panel permanently empty.
   *
   * This is still not the issuer's *official* struck NAV, and it is as of the
   * holdings date rather than right now, so the premium/discount is compared
   * against the close on that same date instead of against a live intraday
   * price. Comparing today's price to a stale NAV would inflate the gap and
   * report fund flows as mispricing.
   */
  const nav: Sourced<NavData> =
    config.fixtures.enabled && quote.ok && bars.ok
      ? syntheticNav(quote.value, bars.value)
      : holdings.ok && bars.ok
        ? computeNavFromHoldings(holdings.value, bars.value, holdings.provenance)
        : missing(
            'not-yet-published',
            'NAV needs the issuer holdings file (for total market value and ' +
              'shares outstanding) plus a price history to compare against.',
          );

  const dates = await listSnapshotDates();

  return {
    fund: FUND,
    quote: quote,
    nav,
    holdings: holdings.ok
      ? { asOfDate: holdings.value.asOfDate, count: equityHoldings(holdings.value.holdings).length }
      : holdings,
    concentration,
    returns,
    benchmarks,
    facts: {
      ...fundFactsLinks(),
      expenseRatioPct: 0.55,
      inceptionDate: FUND.inceptionDate,
      note:
        'Expense ratio and inception are static prospectus facts. AUM, P/E and ' +
        'distribution schedule change over time and are only shown when a ' +
        'source supplies them — they are not hardcoded here.',
    },
    dataSources: providerStatus(),
    snapshotArchive: { dates, count: dates.length },
    synthetic: config.fixtures.enabled,
  };
}

function enrichQuote(
  quote: Sourced<Quote>,
  bars: Sourced<PriceBar[]>,
): Sourced<Quote> {
  if (!bars.ok || bars.value.length < 2) return quote;
  const b = bars.value;
  const last = b.at(-1)!;
  const prev = b.at(-2)!;
  const w52 = b.slice(-252);
  const week52High = Math.max(...w52.map((x) => x.high));
  const week52Low = Math.min(...w52.map((x) => x.low));
  const avgVolume30d =
    b.slice(-30).reduce((a, x) => a + x.volume, 0) / Math.min(30, b.length);

  if (quote.ok) {
    return ok(
      {
        ...quote.value,
        week52High: quote.value.week52High ?? week52High,
        week52Low: quote.value.week52Low ?? week52Low,
        avgVolume30d: quote.value.avgVolume30d ?? avgVolume30d,
      },
      quote.provenance,
    );
  }

  // No intraday quote at all — derive one from the two most recent closes.
  return ok(
    {
      symbol: 'BAI',
      last: last.close,
      change: last.close - prev.close,
      changePct: prev.close === 0 ? 0 : ((last.close - prev.close) / prev.close) * 100,
      dayHigh: last.high,
      dayLow: last.low,
      volume: last.volume,
      avgVolume30d,
      week52High,
      week52Low,
      previousClose: prev.close,
      marketClosed: true,
    },
    {
      ...bars.provenance,
      reliability:
        bars.provenance.reliability === 'synthetic' ? 'synthetic' : 'closed-market',
      label: `${bars.provenance.label} — derived from daily closes`,
      note:
        `Intraday quote unavailable (market closed or feed not entitled). ` +
        `Showing the ${last.date} close vs the prior close — not a live price.`,
    },
  );
}

/**
 * NAV per share = Σ market value / shares outstanding, both from the issuer's
 * published holdings file.
 *
 * Compared against the closing price on the *holdings date*, not the latest
 * price: the two must be struck at the same moment or the difference measures
 * elapsed time rather than premium/discount.
 */
function computeNavFromHoldings(
  snap: HoldingsSnapshot,
  bars: PriceBar[],
  prov: Provenance,
): Sourced<NavData> {
  const shares = snap.sharesOutstanding;
  if (!shares) {
    return missing(
      'not-yet-published',
      'The issuer holdings file did not include a "Shares Outstanding" line, ' +
        'which is the denominator for NAV per share.',
    );
  }

  // Every row counts, including the cash and FX sleeves — they are part of net
  // assets. Rows without a market value are the problem case: silently omitting
  // them would understate NAV, so refuse instead.
  const missingValue = snap.holdings.filter((h) => h.marketValue === undefined);
  if (missingValue.length > 0) {
    return missing(
      'not-yet-published',
      `${missingValue.length} of ${snap.holdings.length} holdings have no ` +
        'market value in the issuer file, so total net assets cannot be summed ' +
        'exactly. NAV is withheld rather than computed from a partial total.',
    );
  }

  const totalValue = snap.holdings.reduce((a, h) => a + (h.marketValue ?? 0), 0);
  const nav = totalValue / shares;

  // The price struck on the same date as the holdings file.
  const sameDay = bars.find((b) => b.date === snap.asOfDate) ?? bars.at(-1);
  if (!sameDay) {
    return missing('insufficient-history', 'No price bar to compare NAV against.');
  }

  return ok(
    {
      nav,
      navDate: snap.asOfDate,
      marketPrice: sameDay.close,
      premiumDiscountPct: ((sameDay.close - nav) / nav) * 100,
    },
    {
      ...prov,
      label: 'Computed from the iShares holdings file (Σ market value ÷ shares outstanding)',
      note:
        `Total net assets $${(totalValue / 1e9).toFixed(2)}B ÷ ` +
        `${(shares / 1e6).toFixed(1)}M shares. This is derived from the issuer's ` +
        `published file, not BlackRock's official struck NAV, and is as of ` +
        `${snap.asOfDate} — so it is compared with that day's close rather than ` +
        `the latest price.`,
    },
  );
}

function syntheticNav(quote: Quote, bars: PriceBar[]): Sourced<NavData> {
  const last = bars.at(-1);
  if (!last) return missing('insufficient-history', 'No bars.');
  // Small synthetic premium so the UI element is exercised.
  const nav = last.adjClose * 0.9993;
  return ok(
    {
      nav,
      navDate: last.date,
      marketPrice: quote.last,
      premiumDiscountPct: ((quote.last - nav) / nav) * 100,
    },
    {
      source: 'synthetic.fixture',
      asOf: `${last.date}T21:00:00.000Z`,
      retrievedAt: new Date().toISOString(),
      reliability: 'synthetic',
      label: 'SYNTHETIC FIXTURE — NAV',
    },
  );
}

function buildReturnsTable(bars: PriceBar[]): ReturnRow[] {
  const dates = bars.map((b) => b.date);
  const end = dates.at(-1) ?? today();

  return ALL_TIMEFRAMES.map((key) => {
    const tf = resolveTimeframe(key, end, dates);
    const r = windowReturnPct(bars, tf.startDate, tf.endDate);
    const prov = derive([], `${TIMEFRAME_LABELS[key]} market-price return`);

    const market: Sourced<number> =
      r === null
        ? missing('insufficient-history', `No data for ${TIMEFRAME_LABELS[key]}.`)
        : ok(r, prov);

    return {
      key,
      label: TIMEFRAME_LABELS[key],
      marketReturnPct: market,
      // NAV-based returns need a NAV time series, which no configured provider
      // supplies. Shown as unavailable rather than silently reusing price.
      navReturnPct: missing(
        'no-provider-configured',
        'NAV return series requires an ETF NAV history source.',
      ),
    };
  });
}

async function buildBenchmarks(
  fundBarsArr: PriceBar[],
  key: TimeframeKey,
): Promise<BenchmarkReturn[]> {
  const dates = fundBarsArr.map((b) => b.date);
  const end = dates.at(-1) ?? today();
  const tf = resolveTimeframe(key, end, dates);
  const fundR = windowReturnPct(fundBarsArr, tf.startDate, tf.endDate);

  return Promise.all(
    config.benchmarks.map(async (b) => {
      const s = await getDailyBars(b.symbol, FUND.inceptionDate, end);
      if (!s.ok) {
        return {
          symbol: b.symbol,
          name: b.name,
          returnPct: s,
          relativePct: s,
        };
      }
      const r = windowReturnPct(s.value.bars, tf.startDate, tf.endDate);
      if (r === null || fundR === null) {
        const m = missing('insufficient-history', `No overlapping data for ${b.symbol}.`);
        return { symbol: b.symbol, name: b.name, returnPct: m, relativePct: m };
      }
      return {
        symbol: b.symbol,
        name: b.name,
        returnPct: ok(r, s.provenance),
        relativePct: ok(fundR - r, s.provenance),
      };
    }),
  );
}

export async function getAttribution(
  key: TimeframeKey,
): Promise<Sourced<AttributionResult>> {
  const [snapshot, bars] = await Promise.all([loadHoldings(), fundBars()]);
  if (!snapshot.ok) return snapshot;
  if (!bars.ok) return bars;

  const dates = bars.value.map((b) => b.date);
  const end = dates.at(-1) ?? today();
  const tf = resolveTimeframe(key, end, dates);

  const fundR = windowReturnPct(bars.value, tf.startDate, tf.endDate);

  // Prefer the archived snapshot from the *start* of the window: attribution
  // must use the weights the fund actually held going in, not today's.
  const startSnap = await snapshotAtOrBefore(tf.startDate);
  const basisSnap = startSnap ?? snapshot.value;

  const targets = symbolsFor(basisSnap);

  // Fetch with a lookback buffer, not from the window start exactly. A window
  // beginning on a weekend or holiday has no bar on its first day, and a series
  // sliced to start there loses the prior close that the return must anchor to
  // — which silently zeroes out every holding's contribution.
  const anchorStart = addDaysBack(tf.startDate, 10);

  const priced = await mapLimit(targets, 6, async ({ holding, symbol }) => {
    const s = await getDailyBars(symbol, anchorStart, tf.endDate);
    return s.ok
      ? ({ holding, bars: s.value.bars, provenance: s.provenance } as PricedHolding)
      : null;
  });
  const pricedOk = priced.filter((p): p is PricedHolding => p !== null);

  const endWeights = new Map(
    equityHoldings(snapshot.value.holdings).map((h) => [h.ticker, h.weight]),
  );
  const contributions = computeContributions(pricedOk, tf, endWeights);
  const sumContrib = contributions.reduce((a, r) => a + r.contributionPct, 0);

  const topContributors = contributions.filter((r) => r.contributionPct > 0).slice(0, 5);
  const topDetractors = [...contributions]
    .filter((r) => r.contributionPct < 0)
    .sort((a, b) => a.contributionPct - b.contributionPct)
    .slice(0, 5);

  // Beta split against the configured broad-tech benchmark.
  const benchBars = await getDailyBars(config.beta.defaultBenchmark, FUND.inceptionDate, end);
  const betaVal =
    benchBars.ok
      ? estimateBeta(bars.value, benchBars.value.bars, tf.startDate, tf.endDate)
      : null;
  const beta: Sourced<typeof betaVal extends null ? never : NonNullable<typeof betaVal>> =
    betaVal
      ? ok(betaVal, derive([bars.provenance, benchBars.ok ? benchBars.provenance : bars.provenance],
          `OLS beta vs ${config.beta.defaultBenchmark}`))
      : missing('insufficient-history',
          'Not enough overlapping daily observations to fit a beta for this window.');

  // Manager effect needs a prior snapshot distinct from the current one.
  const priorSnap = startSnap && startSnap.asOfDate !== snapshot.value.asOfDate ? startSnap : null;
  const diff = priorSnap ? diffSnapshots(priorSnap, snapshot.value) : null;
  const managerEffect = ok(
    computeManagerEffect(
      contributions,
      fundR ?? 0,
      diff ? { turnoverPct: diff.turnoverPct, changes: diff.changes } : null,
    ),
    derive([snapshot.provenance], 'Frozen-portfolio counterfactual'),
  );

  const stale = stalenessSummary(contributions);
  const cov = coveragePct(contributions, basisSnap.holdings);

  const movers = [...topContributors.slice(0, 3), ...topDetractors.slice(0, 3)];

  /*
   * Cap the news lookback.
   *
   * The provider returns a bounded page of articles, so asking it for a
   * 21-month window (SI) does not return 21 months of coverage — it returns
   * roughly the same handful of recent items, while the UI implies they
   * explain the whole period. Capping the search to a recent slice and saying
   * so is the honest version of the same request: for long windows these are
   * "what is being written about these names lately", not "why the fund moved
   * since inception". Short windows are unaffected.
   */
  const NEWS_MAX_DAYS = 14;
  const cappedFrom = addDaysBack(tf.endDate, NEWS_MAX_DAYS);
  const newsFrom = tf.startDate > cappedFrom ? tf.startDate : cappedFrom;
  const newsWindow = {
    from: newsFrom,
    to: tf.endDate,
    cappedFromWindow: newsFrom !== tf.startDate,
  };

  const news = await getNewsFor(movers.map((m) => m.ticker), newsFrom, tf.endDate);

  /*
   * Establish what the start weights really are. `basisSnap` above silently
   * falls back to the newest file when the archive does not reach the window
   * start; from here on that substitution is a reported fact, not a hidden one.
   */
  const driftDays = Math.max(0, daysBetween(tf.startDate, basisSnap.asOfDate));
  const isWindowStart = startSnap !== null && driftDays <= 3;
  const residualDominates =
    fundR !== null && Math.abs(sumContrib - fundR) > Math.abs(fundR);

  const weightBasis = {
    asOfDate: basisSnap.asOfDate,
    isWindowStart,
    driftDays,
    reliable: isWindowStart && !residualDominates,
    reason: isWindowStart
      ? residualDominates
        ? 'Start weights are correct for this window, but the residual exceeds the fund return — intra-window trading dominates, so the per-holding split is indicative rather than a reconciliation.'
        : 'Start weights come from the holdings file published at the start of this window.'
      : `No archived holdings file exists for ${tf.startDate}. The issuer publishes only the current day's file, and this archive begins ${basisSnap.asOfDate} — so weights from ${basisSnap.asOfDate} (${driftDays} days after the window opened) were applied across the whole window. BAI is actively managed, so those are not the weights it actually held going in. Treat the ranking as indicative of today's portfolio, not as a reconciliation of this window's return.`,
  };

  const bySubTheme = rollupContributions(contributions, (r) => r.subTheme, subThemeLabel);

  const result: AttributionResult = {
    timeframe: tf,
    fundReturnPct:
      fundR === null
        ? missing('insufficient-history', `No fund return for ${tf.label}.`)
        : ok(fundR, bars.provenance),
    contributions,
    topContributors,
    topDetractors,
    bySector: rollupContributions(contributions, (r) => r.sector, (k) => k),
    bySubTheme,
    byCountry: rollupContributions(contributions, (r) => r.country, (k) => k),
    residualPct: (fundR ?? 0) - sumContrib,
    coveragePct: cov,
    staleHoldingsCount: stale.count,
    beta,
    managerEffect,
    weightBasis,
    newsWindow,
    narrative: buildNarrative({
      timeframe: tf,
      fundReturnPct: fundR,
      contributions,
      topContributors,
      topDetractors,
      bySubTheme,
      news,
      beta,
      managerEffect,
      staleCount: stale.count,
      staleWeight: stale.weight,
      coveragePct: cov,
      isSynthetic: config.fixtures.enabled,
    }),
  };

  return ok(result, derive([snapshot.provenance, bars.provenance], `Attribution ${tf.label}`));
}

export async function getHoldingsTable(): Promise<Record<string, unknown>> {
  const snapshot = await loadHoldings();
  if (!snapshot.ok) return { holdings: snapshot };

  const dates = await listSnapshotDates();
  const priorDate = dates.filter((d) => d < snapshot.value.asOfDate).at(-1);
  const prior = priorDate ? await snapshotAtOrBefore(priorDate) : null;
  const diff = prior ? diffSnapshots(prior, snapshot.value) : null;

  // Day change per holding. During US market hours the batched intraday quote
  // gives today's (delayed) move in a single vendor request; holdings the
  // batch can't price — foreign listings, mainly — fall back to the last two
  // daily closes, which is yesterday's change, and are labelled as such.
  const targets = symbolsFor(snapshot.value);
  const batch = await getQuotes(targets.map((t) => t.symbol));

  const changes = await mapLimit(targets, 6, async ({ holding, symbol }) => {
    const q = batch?.quotes.get(symbol.toUpperCase());
    if (q) {
      return [holding.ticker, { pct: q.changePct, intraday: true }] as const;
    }
    const s = await getDailyBars(symbol, addDaysBack(today(), 10), today());
    if (!s.ok || s.value.bars.length < 2) return [holding.ticker, null] as const;
    const b = s.value.bars;
    const last = b.at(-1);
    const prev = b.at(-2);
    if (!last || !prev || prev.adjClose === 0) return [holding.ticker, null] as const;
    return [
      holding.ticker,
      { pct: ((last.adjClose - prev.adjClose) / prev.adjClose) * 100, intraday: false },
    ] as const;
  });

  return {
    asOfDate: snapshot.value.asOfDate,
    provenance: snapshot.provenance,
    holdings: snapshot.value.holdings,
    dayChange: Object.fromEntries(changes),
    dayChangeNote: batch
      ? 'US-listed holdings show today\'s intraday change (delayed). Foreign ' +
        'listings show the change to their last local close.'
      : 'Intraday quotes unavailable — day changes are between the last two ' +
        'daily closes.',
    diff: diff ?? {
      unavailable:
        'Weight-change flagging needs at least two archived issuer files. The ' +
        'archive currently holds ' + dates.length + '. It fills in as the app ' +
        'runs daily.',
    },
    synthetic: config.fixtures.enabled,
  };
}

function addDaysBack(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function getFundSeries(key: TimeframeKey): Promise<Record<string, unknown>> {
  const bars = await fundBars();

  // The failure path must keep the SAME response shape as the success path.
  // Returning a differently-shaped object here previously handed the chart
  // `undefined` for `bars`/`benchmarks`, which threw and — with no error
  // boundary — blanked the entire dashboard. A missing price series should
  // degrade one panel, never the page.
  if (!bars.ok) {
    return {
      timeframe: null,
      bars: [],
      benchmarks: [],
      unavailable: bars,
      synthetic: config.fixtures.enabled,
    };
  }

  const dates = bars.value.map((b) => b.date);
  const end = dates.at(-1) ?? today();
  const tf = resolveTimeframe(key, end, dates);
  const inWindow = bars.value.filter((b) => b.date >= tf.startDate && b.date <= tf.endDate);

  const benchSeries = await Promise.all(
    config.benchmarks.map(async (b) => {
      const s = await getDailyBars(b.symbol, tf.startDate, tf.endDate);
      return {
        symbol: b.symbol,
        name: b.name,
        bars: s.ok ? s.value.bars.map((x) => ({ date: x.date, close: x.adjClose })) : [],
        available: s.ok,
      };
    }),
  );

  return {
    timeframe: tf,
    bars: inWindow.map((b) => ({ date: b.date, close: b.adjClose, volume: b.volume })),
    benchmarks: benchSeries,
    provenance: bars.provenance,
    synthetic: config.fixtures.enabled,
  };
}
