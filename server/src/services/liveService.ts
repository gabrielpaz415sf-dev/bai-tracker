import { config } from '../config';
import { loadHoldings } from './fundService';
import { getQuote, getQuotes, getDailyBars } from '../providers/market';
import { equityHoldings } from '../analytics/concentration';
import { SUB_THEME_LABELS } from '../domain/subthemes';
import { vendorSymbol, isNonUsVenue } from '../domain/exchanges';
import { sessionState } from '../domain/session';
import { getNewsFor } from '../providers/news';
import { addDays, today } from '../util/dates';
import { ok, type Sourced } from '../util/provenance';
import type { SubTheme, NewsItem, Quote } from '../types';

/** The fund itself, priced in the same batch as its holdings. */
const FUND_SYMBOL = 'BAI';

/**
 * LIVE INTRADAY VIEW — "what is going on with BAI right now".
 *
 * Built entirely from one batched (delayed ~15 min) quote request against
 * today's holdings weights:
 *
 *   live contribution_i = weight_i × today's intraday change_i
 *
 * Two honesty rules specific to intraday:
 *
 * 1. The fund's own quoted change is the ground truth for "what BAI is doing";
 *    the holdings-implied sum is the *explanation*, and the two are shown side
 *    by side rather than blended. They differ because of the delay, foreign
 *    holdings, and the premium/discount moving intraday.
 * 2. Non-US holdings (≈a quarter of the fund) finished their local session
 *    hours before the US open — SK hynix's Korean close happened overnight US
 *    time. They are listed separately as "already closed", never mixed into
 *    the US-session movers as if they were trading now.
 */

/**
 * A coincident article, not an explanation. `published` is surfaced so a reader
 * can judge for themselves whether the story plausibly precedes the move — a
 * headline timestamped after the move is a report of it, not a cause.
 */
export interface MoverNews {
  headline: string;
  url: string;
  source: string;
  publishedAt: string;
}

export interface LiveMover {
  ticker: string;
  name: string;
  weight: number;
  changePct: number;
  contributionPct: number;
  subTheme: string;
  /** Coincident, cited, timestamped. Empty means "nothing found", not "no reason". */
  news: MoverNews[];
}

export interface LiveToday {
  asOf: string;
  delayed: boolean;
  marketOpen: boolean;
  /** Clock-derived session state, so the UI never has to infer it from a price. */
  session: { phase: string; label: string; etTime: string };
  fund: {
    last: number;
    changePct: number;
    dayLow: number;
    dayHigh: number;
    volume: number;
  } | null;
  fundNote: string | null;
  /** Σ weight × intraday change over priced US names. */
  impliedFromHoldingsPct: number | null;
  coveragePct: number;
  movers: { up: LiveMover[]; down: LiveMover[] };
  bySubTheme: Array<{ label: string; contributionPct: number; weight: number }>;
  /**
   * Holdings whose home market has already shut for the day, WITH their last
   * completed session's move.
   *
   * Previously this carried only ticker/name/weight, so the fund's single
   * largest position — SK hynix at 6.3% — could fall 9.6% and be entirely
   * invisible on the dashboard, folded into an anonymous "21.3% in markets that
   * are closed" total. Excluding foreign names from the *live US* mover list is
   * correct; excluding their moves from the page altogether is not.
   */
  closedMarkets: Array<{
    ticker: string;
    name: string;
    weight: number;
    changePct: number | null;
    contributionPct: number | null;
    asOf: string | null;
  }>;
  unpriced: Array<{ ticker: string; weight: number }>;
  /** Where the "why" came from, or why there is none. Always populated. */
  newsSource: { label: string; available: boolean; note: string };
  notes: string[];
  available: boolean;
  reason: string | null;
  synthetic: boolean;
}

export async function getLiveToday(): Promise<LiveToday> {
  const empty = (reason: string): LiveToday => ({
    asOf: new Date().toISOString(),
    delayed: true,
    marketOpen: sessionState().open,
    session: {
      phase: sessionState().phase,
      label: sessionState().label,
      etTime: sessionState().etTime,
    },
    fund: null,
    fundNote: null,
    impliedFromHoldingsPct: null,
    coveragePct: 0,
    movers: { up: [], down: [] },
    bySubTheme: [],
    closedMarkets: [],
    unpriced: [],
    newsSource: { label: 'none', available: false, note: 'No live view to explain.' },
    notes: [],
    available: false,
    reason,
    synthetic: config.fixtures.enabled,
  });

  if (config.fixtures.enabled) {
    return empty(
      'Live view requires a real market-data key; fixture mode has no intraday feed.',
    );
  }

  const holdings = await loadHoldings();
  if (!holdings.ok) return empty(`Holdings unavailable: ${holdings.detail}`);

  const eq = equityHoldings(holdings.value.holdings);
  const us = eq.filter((h) => !isNonUsVenue(h.exchange));
  const foreign = eq.filter((h) => isNonUsVenue(h.exchange));

  /*
   * BAI rides along in the holdings batch rather than being fetched on its own.
   *
   * Tiingo's IEX endpoint prices a comma-separated list for one request, so a
   * separate call for the fund doubled the cost of every refresh: 2 requests ×
   * 30 refreshes/hour = 60 against a 45/hour budget, which exhausted the quota
   * every single hour and left the panel serving stale data for the remainder.
   * One batch is 30/hour and fits.
   */
  const holdingSymbols = us.map((h) => vendorSymbol(h.ticker, h.exchange));
  const batch = await getQuotes([...holdingSymbols, FUND_SYMBOL]);

  if (!batch || batch.quotes.size === 0) {
    return empty(
      'Intraday quotes are unavailable right now (provider rate limit or ' +
        'outage). The end-of-day view remains correct; nothing is estimated.',
    );
  }

  // Fall back to a dedicated request only if the batch could not price the
  // fund — that is one extra call in the rare case, not thirty per hour.
  const batched = batch.quotes.get(FUND_SYMBOL);
  const fundQuote: Sourced<Quote> = batched
    ? ok(batched, batch.provenance)
    : await getQuote(FUND_SYMBOL);

  const movers: LiveMover[] = [];
  const unpriced: Array<{ ticker: string; weight: number }> = [];
  let implied = 0;
  let coveredWeight = 0;
  const totalWeight = eq.reduce((a, h) => a + h.weight, 0);

  for (const h of us) {
    const q = batch.quotes.get(vendorSymbol(h.ticker, h.exchange).toUpperCase());
    if (!q) {
      unpriced.push({ ticker: h.ticker, weight: h.weight });
      continue;
    }
    const contribution = (h.weight / 100) * q.changePct;
    implied += contribution;
    coveredWeight += h.weight;
    movers.push({
      ticker: h.ticker,
      name: h.name,
      weight: h.weight,
      changePct: q.changePct,
      contributionPct: contribution,
      subTheme: SUB_THEME_LABELS[h.subTheme as SubTheme] ?? h.subTheme,
      news: [],
    });
  }

  movers.sort((a, b) => b.contributionPct - a.contributionPct);

  const themeMap = new Map<string, { contribution: number; weight: number }>();
  for (const m of movers) {
    const cur = themeMap.get(m.subTheme) ?? { contribution: 0, weight: 0 };
    cur.contribution += m.contributionPct;
    cur.weight += m.weight;
    themeMap.set(m.subTheme, cur);
  }

  /*
   * Session state comes from the clock, never from the vendor.
   *
   * The old derivation was `!fundQuote.value.marketClosed`, and the adapter set
   * marketClosed from `q.last === null`. But IEX's `last` goes null whenever
   * that venue has had no recent print — routine for a thin ETF like BAI in the
   * middle of an ordinary session. The dashboard then showed live intraday
   * moves under a "US SESSION CLOSED" banner, which reads as stale data and is
   * a false claim about the world. Vendor liquidity is not a clock.
   */
  const session = sessionState();
  const marketOpen = session.open;

  const notes: string[] = [
    'Quotes are delayed ~15 minutes. This panel explains the shape of the ' +
      'move; do not use it for execution timing.',
  ];
  if (foreign.length > 0) {
    const fw = foreign.reduce((a, h) => a + h.weight, 0);
    notes.push(
      `${foreign.length} non-US holdings (${fw.toFixed(1)}% of the fund) ` +
        `finished their home-market sessions before the US open and are not ` +
        `moving now. BAI's price still moves on them — market makers reprice ` +
        `the closed names via proxies — which is one reason the fund's quoted ` +
        `move differs from the holdings-implied sum.`,
    );
  }

  // The panel shows the six largest contributors each way; look for news only
  // on those. One batched request per 15-minute TTL keeps the free news tier
  // (~100 calls/day) intact even with the 2-minute UI auto-refresh.
  const topUp = movers.filter((m) => m.contributionPct > 0).slice(0, 6);
  const topDown = [...movers].reverse().filter((m) => m.contributionPct < 0).slice(0, 6);
  const shown = [...topUp, ...topDown];

  // Window opens yesterday: pre-market and overnight stories are the usual
  // driver of a name that gaps at the open, and a today-only window misses them.
  const news = await getNewsFor(
    shown.map((m) => m.ticker),
    addDays(today(), -1),
    today(),
  );

  if (news.ok) {
    const byTicker = new Map<string, NewsItem[]>();
    for (const item of news.value) {
      for (const t of item.tickers) {
        byTicker.set(t.toUpperCase(), [...(byTicker.get(t.toUpperCase()) ?? []), item]);
      }
    }
    for (const m of shown) {
      m.news = (byTicker.get(m.ticker.toUpperCase()) ?? [])
        // Most recent first: the latest story is the one most likely to bear on
        // the current session's move.
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, 2)
        .map((n) => ({
          headline: n.headline,
          url: n.url,
          source: n.source,
          publishedAt: n.publishedAt,
        }));
    }
  }

  /*
   * Price the already-closed foreign names from their daily bars.
   *
   * These come from the same 24h-TTL cache the attribution engine fills, so in
   * practice this is a cache read and costs no provider requests. The move is
   * the last completed session's close vs the one before it — which for KRX or
   * TWSE is a session that ended hours before the US close, hence the asOf date
   * travelling with every row so the UI can date it rather than call it "today".
   */
  const closedMarkets = await Promise.all(
    foreign.map(async (h) => {
      const base = { ticker: h.ticker, name: h.name, weight: h.weight };
      const series = await getDailyBars(
        vendorSymbol(h.ticker, h.exchange),
        addDays(today(), -14),
        today(),
      );
      if (!series.ok || series.value.bars.length < 2) {
        return { ...base, changePct: null, contributionPct: null, asOf: null };
      }
      const bars = series.value.bars;
      const last = bars[bars.length - 1]!;
      const prev = bars[bars.length - 2]!;
      const changePct = ((last.adjClose - prev.adjClose) / prev.adjClose) * 100;
      return {
        ...base,
        changePct,
        contributionPct: (h.weight / 100) * changePct,
        asOf: last.date,
      };
    }),
  );

  const newsSource = news.ok
    ? {
        label: news.provenance.label,
        available: true,
        note:
          'Headlines are articles published in the same window as the move. ' +
          'They are cited, not asserted as causes — check the timestamp.',
      }
    : {
        label: 'none',
        available: false,
        note: news.detail,
      };

  if (!newsSource.available) {
    notes.push(
      `No "why" is available for these moves: ${news.ok ? '' : news.detail} ` +
        `The contributions above are still exact — they come from prices and ` +
        `weights, not from news.`,
    );
  }

  return {
    asOf: batch.provenance.asOf,
    delayed: true,
    marketOpen,
    session: { phase: session.phase, label: session.label, etTime: session.etTime },
    fund: fundQuote.ok
      ? {
          last: fundQuote.value.last,
          changePct: fundQuote.value.changePct,
          dayLow: fundQuote.value.dayLow,
          dayHigh: fundQuote.value.dayHigh,
          volume: fundQuote.value.volume,
        }
      : null,
    fundNote: fundQuote.ok
      ? (fundQuote.provenance.note ?? null)
      : `Fund quote unavailable: ${fundQuote.detail}`,
    impliedFromHoldingsPct: coveredWeight > 0 ? implied : null,
    coveragePct: totalWeight > 0 ? (coveredWeight / totalWeight) * 100 : 0,
    movers: { up: topUp, down: topDown },
    bySubTheme: [...themeMap.entries()]
      .map(([label, v]) => ({ label, contributionPct: v.contribution, weight: v.weight }))
      .sort((a, b) => b.contributionPct - a.contributionPct),
    closedMarkets,
    unpriced,
    newsSource,
    notes,
    available: true,
    reason: null,
    synthetic: false,
  };
}
