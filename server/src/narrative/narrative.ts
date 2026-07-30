import type {
  BetaDecomposition,
  Citation,
  ContributionRow,
  ManagerEffect,
  Narrative,
  NarrativeClaim,
  NewsItem,
  RollupRow,
  Timeframe,
} from '../types';
import type { Sourced } from '../util/provenance';

/**
 * NARRATIVE GENERATION
 *
 * The ordering rule from the spec — do the maths, *then* attach explanation —
 * is enforced structurally: this module receives only already-computed results
 * and already-fetched articles. It cannot reach for a data source, so it cannot
 * go looking for a story to fit a number.
 *
 * Three rules govern every sentence produced here:
 *
 * 1. Magnitude claims come from our own arithmetic and cite it.
 * 2. Causal language is never generated. When an article exists in the window
 *    for a mover, we say the move "coincided with" it and link it. The reader
 *    draws the causal inference; we supply the adjacency and the timestamp.
 *    This is the difference between "NVDA fell because of the export ruling"
 *    (which we cannot know) and "NVDA fell 8.2%; over the same window Reuters
 *    reported an export ruling" (which we can show).
 * 3. Absence is stated, not filled. No news for a top mover produces an
 *    explicit "no driver identified in available sources", never silence and
 *    never a plausible guess.
 */

const NO_DRIVER =
  'No article covering this name was returned by the configured news source ' +
  'for this window. The move is unexplained by the data available here — not ' +
  'necessarily unexplained in reality.';

export function buildNarrative(params: {
  timeframe: Timeframe;
  fundReturnPct: number | null;
  contributions: ContributionRow[];
  topContributors: ContributionRow[];
  topDetractors: ContributionRow[];
  bySubTheme: RollupRow[];
  news: Sourced<NewsItem[]>;
  beta: Sourced<BetaDecomposition>;
  managerEffect: Sourced<ManagerEffect>;
  staleCount: number;
  staleWeight: number;
  coveragePct: number;
  isSynthetic: boolean;
}): Narrative {
  const {
    timeframe,
    fundReturnPct,
    topContributors,
    topDetractors,
    bySubTheme,
    news,
    beta,
    managerEffect,
    staleCount,
    staleWeight,
    coveragePct,
    isSynthetic,
  } = params;

  const claims: NarrativeClaim[] = [];
  const caveats: string[] = [];
  const asOf = timeframe.endDate;

  const computed = (label: string): Citation => ({
    kind: 'computed',
    label,
    asOf,
  });

  if (fundReturnPct === null) {
    return {
      headline: `Return for ${timeframe.label} could not be computed.`,
      claims: [
        {
          text:
            'The fund price series required for this window is unavailable from ' +
            'the configured data provider, so no attribution was produced.',
          citations: [computed('Data availability check')],
        },
      ],
      noClearDriver: true,
      caveats: ['No figures are shown because none could be computed.'],
      generatedAt: new Date().toISOString(),
    };
  }

  const dir = fundReturnPct >= 0 ? 'up' : 'down';
  const headline =
    `BAI is ${dir} ${Math.abs(fundReturnPct).toFixed(2)}% over ${timeframe.label.toLowerCase()}.`;

  /* ---------------------------------------------------- sub-theme drivers */

  const leadTheme = bySubTheme[0];
  const lagTheme = bySubTheme.at(-1);

  if (leadTheme && Math.abs(leadTheme.contributionPct) > 0.01) {
    claims.push({
      text:
        `${leadTheme.label} added the most, contributing ` +
        `${fmtPp(leadTheme.contributionPct)} from ` +
        `${leadTheme.startWeight.toFixed(1)}% of the portfolio ` +
        `(${leadTheme.memberCount} holdings, average move ` +
        `${fmtPct(leadTheme.groupReturnPct)}).`,
      citations: [computed('Grouped by theme')],
    });
  }
  if (lagTheme && lagTheme.contributionPct < -0.01 && lagTheme !== leadTheme) {
    claims.push({
      text:
        `${lagTheme.label} weighed most heavily, taking off ` +
        `${fmtPp(lagTheme.contributionPct)} from ` +
        `${lagTheme.startWeight.toFixed(1)}% of the portfolio.`,
      citations: [computed('Grouped by theme')],
    });
  }

  /* ------------------------------------------------ named movers + news */

  const newsItems = news.ok ? news.value : [];
  const movers = [...topContributors.slice(0, 3), ...topDetractors.slice(0, 3)];

  for (const m of movers) {
    const related = newsFor(m.ticker, newsItems);
    const base =
      `${m.name} (${m.ticker}) ${m.returnPct >= 0 ? 'rose' : 'fell'} ` +
      `${Math.abs(m.returnPct).toFixed(2)}%, contributing ` +
      `${fmtPp(m.contributionPct)} at a ${m.startWeight.toFixed(2)}% weight.`;

    const citations: Citation[] = [computed('Contribution = start weight × holding return')];

    if (related.length === 0) {
      claims.push({
        text: `${base} ${NO_DRIVER}`,
        citations,
      });
      continue;
    }

    // "Coincided with" — adjacency, not causation.
    const top = related.slice(0, 2);
    for (const a of top) {
      citations.push({
        kind: 'news',
        label: `${a.source}: ${a.headline}`,
        url: a.url,
        asOf: a.publishedAt,
      });
    }
    claims.push({
      text:
        `${base} Over the same window, ${top.length === 1 ? 'one article' : `${top.length} articles`} ` +
        `mentioning ${m.ticker} was published: ${top
          .map((a) => `"${a.headline}" (${a.source}, ${a.publishedAt.slice(0, 10)})`)
          .join('; ')}. ` +
        `This is reported as coincident, not causal — the attribution engine ` +
        `does not establish that the article explains the move.`,
      citations,
    });
  }

  /* --------------------------------------------------- beta vs idio split */

  if (beta.ok) {
    const b = beta.value;
    if (b.reliable) {
      claims.push({
        text:
          `Roughly ${fmtPp(b.systematicPct)} of the move tracks the broad tech ` +
          `tape (${b.benchmarkSymbol} returned ${fmtPct(b.benchmarkReturnPct)} ` +
          `and BAI's fitted beta to it is ${b.beta.toFixed(2)}). The remaining ` +
          `${fmtPp(b.idiosyncraticPct)} is specific to this fund's holdings.`,
        citations: [
          computed(
            `Measured against ${b.benchmarkSymbol} over ${b.estimationWindowDays} trading days; the pattern explains ${(b.rSquared * 100).toFixed(0)}% of BAI's daily moves`,
          ),
        ],
      });
    } else {
      caveats.push(
        `We are not splitting this move into "the market" versus "this fund's ` +
          `own holdings". Doing that requires BAI to track ${b.benchmarkSymbol} ` +
          `closely enough to be predictable from it, and over this period it ` +
          `only explains ${(b.rSquared * 100).toFixed(0)}% of BAI's daily ` +
          `movement — under the 50% we require. Splitting it anyway would ` +
          `produce a precise-looking number with nothing behind it.`,
      );
    }
  } else {
    caveats.push(
      `Market-beta decomposition unavailable: ${beta.detail}`,
    );
  }

  /* ------------------------------------------------------ manager effect */

  if (managerEffect.ok && managerEffect.value.computable) {
    const m = managerEffect.value;
    const verb = m.tradingEffectPct >= 0 ? 'added' : 'cost';
    claims.push({
      text:
        `Holding the start-of-window portfolio untouched would have returned ` +
        `${fmtPct(m.frozenPortfolioReturnPct)}; the fund actually returned ` +
        `${fmtPct(m.actualReturnPct)}. The ${fmtPp(Math.abs(m.tradingEffectPct))} ` +
        `difference ${verb} by the manager's trading over the window ` +
        `(${m.turnoverPct.toFixed(1)}% one-way turnover between published files).`,
      citations: [
        computed('Frozen start-weight portfolio vs realised fund return'),
        { kind: 'issuer', label: 'iShares published holdings files', asOf },
      ],
    });
  } else if (timeframe.tradingDays > 5) {
    caveats.push(
      'Manager-decision attribution needs two archived holdings files spanning ' +
        'this window. The archive does not yet hold both, so the split between ' +
        'price moves and trading is not shown. It fills in as the app runs ' +
        'daily.',
    );
  }

  /* ------------------------------------------------------------ caveats */

  if (staleCount > 0) {
    caveats.push(
      `${staleCount} non-US holding${staleCount === 1 ? '' : 's'} ` +
        `(${staleWeight.toFixed(1)}% of the fund) last traded on a market that ` +
        `closed before the US session. For a same-day window their contribution ` +
        `reflects the previous local close, so the day's attribution is ` +
        `genuinely incomplete for that slice of the portfolio.`,
    );
  }

  if (coveragePct < 98) {
    caveats.push(
      `Prices were resolved for ${coveragePct.toFixed(1)}% of the fund's equity ` +
        `weight. The remainder is excluded from the ranking rather than ` +
        `estimated.`,
    );
  }

  if (timeframe.clippedToInception) {
    caveats.push(
      `This window was shortened to begin at the fund's inception ` +
        `(${'2024-10-21'}). It covers less time than its label suggests.`,
    );
  }

  if (!news.ok) {
    caveats.push(
      `Explanations are unavailable for this window: ${news.detail} ` +
        `Contribution rankings above are unaffected — they are computed from ` +
        `prices and weights, not from news.`,
    );
  }

  if (isSynthetic) {
    caveats.push(
      'DEMO MODE — every figure above is generated synthetic data, not real ' +
        'market data. Nothing here describes the actual BAI fund.',
    );
  }

  const noClearDriver =
    movers.length > 0 && movers.every((m) => newsFor(m.ticker, newsItems).length === 0);

  if (noClearDriver) {
    caveats.push(
      'No news was found for any of the largest movers in this window. The ' +
        'ranking shows what moved; the reason is not established by the data ' +
        'available here.',
    );
  }

  return {
    headline,
    claims,
    noClearDriver,
    caveats,
    generatedAt: new Date().toISOString(),
  };
}

function newsFor(ticker: string, items: NewsItem[]): NewsItem[] {
  const t = ticker.toUpperCase();
  return items.filter((n) => n.tickers.some((s) => s.toUpperCase() === t));
}

/** Percentage points (a contribution), signed. */
function fmtPp(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
}

/** A percentage return, signed. */
function fmtPct(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
}
