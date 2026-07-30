import type { Sourced, Provenance } from './util/provenance';

/** Canonical fund identity. These are static facts, not fetched data. */
export const FUND = {
  ticker: 'BAI',
  name: 'iShares A.I. Innovation and Tech Active ETF',
  listingExchange: 'NYSE Arca',
  isharesProductId: '339081',
  productUrl:
    'https://www.ishares.com/us/products/339081/ishares-a-i-innovation-and-tech-active-etf',
  /** Fund inception. Bounds every historical calculation in the app. */
  inceptionDate: '2024-10-21',
  managementStyle: 'active' as const,
} as const;

export type SubTheme =
  | 'semiconductors'
  | 'memory'
  | 'hyperscalers'
  | 'software'
  | 'infrastructure'
  | 'other';

export interface Holding {
  ticker: string;
  name: string;
  /** Percent of fund NAV, 0-100. */
  weight: number;
  sector: string;
  country: string;
  /** ISO MIC or issuer-reported exchange string. */
  exchange: string;
  currency: string;
  /** Shares held, when the issuer publishes it. */
  shares?: number;
  marketValue?: number;
  assetClass: string;
  subTheme: SubTheme;
}

/** One published holdings file from the issuer, keyed by its as-of date. */
export interface HoldingsSnapshot {
  /** Issuer's stated portfolio date (YYYY-MM-DD), NOT our fetch date. */
  asOfDate: string;
  holdings: Holding[];
  /** From the file preamble. Denominator for NAV per share. */
  sharesOutstanding?: number;
  provenance: Provenance;
}

/** Change in a holding between two published snapshots — manager activity. */
export interface WeightChange {
  ticker: string;
  name: string;
  kind: 'added' | 'removed' | 'increased' | 'decreased' | 'unchanged';
  priorWeight: number | null;
  currentWeight: number | null;
  /** Percentage points, current − prior. */
  deltaPct: number;
  subTheme: SubTheme;
  sector: string;
}

export interface HoldingsDiff {
  fromDate: string;
  toDate: string;
  changes: WeightChange[];
  /** Sum of absolute weight deltas / 2 — one-way turnover between publishes. */
  turnoverPct: number;
  provenance: Provenance;
}

export interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Split/dividend-adjusted close. Used for every return calculation. */
  adjClose: number;
  volume: number;
}

export interface PriceSeries {
  symbol: string;
  bars: PriceBar[];
  currency: string;
  provenance: Provenance;
}

export interface Quote {
  symbol: string;
  last: number;
  change: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  avgVolume30d: number | null;
  week52High: number | null;
  week52Low: number | null;
  previousClose: number;
  /** True when the venue for this symbol is currently closed. */
  marketClosed: boolean;
}

/** ETF-specific: NAV and the market price's premium/discount to it. */
export interface NavData {
  nav: number;
  navDate: string;
  marketPrice: number;
  /** (marketPrice − nav) / nav * 100. Positive = premium. */
  premiumDiscountPct: number;
}

export interface FundFacts {
  expenseRatioPct: number;
  inceptionDate: string;
  aumUsd: number;
  peRatio: number | null;
  numberOfHoldings: number;
  distributionSchedule: string;
  prospectusUrl: string;
  factSheetUrl: string;
}

export type TimeframeKey = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'SI';

export interface Timeframe {
  key: TimeframeKey;
  label: string;
  startDate: string;
  endDate: string;
  /** Trading days actually covered by data. */
  tradingDays: number;
  /** True when the window was clipped because it predates fund inception. */
  clippedToInception: boolean;
}

export interface ReturnRow {
  key: TimeframeKey;
  label: string;
  navReturnPct: Sourced<number>;
  marketReturnPct: Sourced<number>;
}

export interface BenchmarkReturn {
  symbol: string;
  name: string;
  returnPct: Sourced<number>;
  /** BAI market return − benchmark return, in percentage points. */
  relativePct: Sourced<number>;
}

/* ---------------------------------------------------------------- news --- */

export interface NewsItem {
  headline: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
  tickers: string[];
  /** Provider-supplied sentiment, when available. Never inferred by us. */
  sentiment: number | null;
}

/* --------------------------------------------------------- attribution --- */

export interface ContributionRow {
  ticker: string;
  name: string;
  sector: string;
  country: string;
  subTheme: SubTheme;
  /** Weight at the START of the window — the basis for contribution. */
  startWeight: number;
  endWeight: number | null;
  /** Holding's own total return over the window, percent. */
  returnPct: number;
  /** startWeight/100 × returnPct — the holding's share of fund return, in pp. */
  contributionPct: number;
  /** True when this holding's last price predates the US session close. */
  priceStale: boolean;
  priceAsOf: string;
  provenance: Provenance;
}

export interface RollupRow {
  key: string;
  label: string;
  startWeight: number;
  contributionPct: number;
  /** Weighted average return of the group. */
  groupReturnPct: number;
  memberCount: number;
}

/** Decomposition of the fund's move into market beta vs stock-specific news. */
export interface BetaDecomposition {
  benchmarkSymbol: string;
  beta: number;
  rSquared: number;
  /** Days used to estimate beta. */
  estimationWindowDays: number;
  benchmarkReturnPct: number;
  /** beta × benchmarkReturn — the part explained by the broad tape. */
  systematicPct: number;
  /** Actual − systematic — the part that is BAI-specific. */
  idiosyncraticPct: number;
  /** Guardrail: below this R², we refuse to narrate a beta split. */
  reliable: boolean;
}

/**
 * Splits realised return into "the stocks moved" vs "the manager traded".
 * Computed by pricing a frozen start-date portfolio through the window and
 * comparing it to the fund's actual return.
 */
export interface ManagerEffect {
  /** Return a portfolio frozen at start-date weights would have produced. */
  frozenPortfolioReturnPct: number;
  actualReturnPct: number;
  /** actual − frozen. Positive = trading added value over doing nothing. */
  tradingEffectPct: number;
  turnoverPct: number;
  notableChanges: WeightChange[];
  /** False when we lack two holdings snapshots to compare. */
  computable: boolean;
}

export interface AttributionResult {
  timeframe: Timeframe;
  fundReturnPct: Sourced<number>;
  contributions: ContributionRow[];
  topContributors: ContributionRow[];
  topDetractors: ContributionRow[];
  bySector: RollupRow[];
  bySubTheme: RollupRow[];
  byCountry: RollupRow[];
  /** Sum of contributions − fund return. Non-zero from intra-window trading. */
  residualPct: number;
  coveragePct: number;
  staleHoldingsCount: number;
  beta: Sourced<BetaDecomposition>;
  managerEffect: Sourced<ManagerEffect>;
  narrative: Narrative;
  /**
   * Which holdings file the "start weight" actually came from.
   *
   * The issuer publishes only today's file, so the archive can never reach
   * back before the day this app first ran. For any window starting earlier,
   * attribution falls back to the newest weights — and applying today's weights
   * across a year of an actively-managed fund does not reconcile. This makes
   * that substitution visible instead of letting it hide inside the residual.
   */
  weightBasis: WeightBasis;
  /** The window actually searched for news, which is capped for long ranges. */
  newsWindow: { from: string; to: string; cappedFromWindow: boolean };
}

export interface WeightBasis {
  /** as-of date of the holdings file used for start weights. */
  asOfDate: string;
  /** True when that file really is from the window start. */
  isWindowStart: boolean;
  /** Days between the window start and the file actually used. */
  driftDays: number;
  /**
   * Whether the decomposition should be read as a reconciliation at all.
   * False once the weights are materially newer than the window, or once the
   * residual is larger than the return it purports to explain.
   */
  reliable: boolean;
  reason: string;
}

export interface NarrativeClaim {
  text: string;
  /** Every claim points at the numbers or articles that license it. */
  citations: Citation[];
}

export interface Citation {
  kind: 'computed' | 'news' | 'issuer' | 'market';
  label: string;
  url?: string;
  asOf: string;
}

export interface Narrative {
  headline: string;
  claims: NarrativeClaim[];
  /** Set when the data does not support any causal story. */
  noClearDriver: boolean;
  caveats: string[];
  generatedAt: string;
}

/* -------------------------------------------------------- concentration --- */

export interface Concentration {
  top10WeightPct: number;
  top1WeightPct: number;
  /** 1 / Σwᵢ² — how many equally-weighted names this portfolio behaves like. */
  effectiveHoldings: number;
  herfindahl: number;
  totalHoldings: number;
  bySector: RollupRow[];
  bySubTheme: RollupRow[];
  byCountry: RollupRow[];
}

/* --------------------------------------------------- entry-price module --- */

export interface HorizonDispersion {
  horizonLabel: string;
  horizonTradingDays: number;
  /** Number of historical entry days evaluated. */
  sampleCount: number;
  bestPct: number;
  worstPct: number;
  medianPct: number;
  p25Pct: number;
  p75Pct: number;
  /** best − worst, in pp. Raw dispersion of outcomes at this horizon. */
  spreadPct: number;
  /**
   * Spread normalised by the SQUARE ROOT of years held.
   *
   * This replaced a `spread / years` figure that was statistically invalid.
   * Dispersion accumulates with √time under anything random-walk-like, so
   * dividing by t rather than √t inflates short horizons enormously and
   * manufactures a decline that is an artifact of the transform: the old
   * numbers ran 1570 → 713 → 407 → 189 → 98, halving as the horizon doubled,
   * which is the signature of the wrong denominator rather than a property of
   * the fund. Dividing by √t is dimensionally correct, and the decline that
   * survives it (≈221 → 98) is the real effect.
   */
  spreadPerSqrtYearPct: number;
  /**
   * p75 − p25: the width of the middle half of outcomes. Robust to the single
   * luckiest and unluckiest entry day, which is exactly what the raw
   * best-minus-worst spread is most sensitive to.
   */
  iqrPct: number;
  /** Share of historical entry days that ended below break-even. */
  shareNegativePct: number;
  /**
   * Spread ÷ |median outcome|. How large entry timing looms relative to the
   * size of the typical result — the honest form of "entry price matters less
   * over time".
   */
  spreadVsMedianRatio: number;
  /** Series used. May be a labelled proxy when BAI history is too short. */
  seriesSymbol: string;
  isProxy: boolean;
}

export interface DcaComparison {
  contributionTotalUsd: number;
  periods: number;
  intervalLabel: string;
  lumpSum: OutcomeDistribution;
  dca: OutcomeDistribution;
  /** Share of historical start dates where lump sum beat DCA. */
  lumpSumWinRatePct: number;
  sampleCount: number;
  seriesSymbol: string;
  isProxy: boolean;
}

export interface OutcomeDistribution {
  medianFinalUsd: number;
  p5FinalUsd: number;
  p25FinalUsd: number;
  p75FinalUsd: number;
  p95FinalUsd: number;
  bestFinalUsd: number;
  worstFinalUsd: number;
}

export interface ContextGauges {
  price: number;
  sma50: number | null;
  sma200: number | null;
  pctVsSma50: number | null;
  pctVsSma200: number | null;
  /** Annualised stdev of daily log returns over the trailing window. */
  realizedVol30dPct: number | null;
  realizedVol90dPct: number | null;
  drawdownFrom52wHighPct: number | null;
  premiumDiscountPct: number | null;
}

export interface ExecutionCosts {
  /** Quoted spread in cents and as a share of price. */
  spreadUsd: number | null;
  spreadPctOfPrice: number | null;
  premiumDiscountPct: number | null;
  /** Round-trip cost estimate: spread + |premium/discount|. */
  estimatedRoundTripPct: number | null;
  notes: string[];
}

export interface ConcentrationRiskScenario {
  label: string;
  description: string;
  /** Weight of the exposure being shocked. */
  exposureWeightPct: number;
  shockPct: number;
  /** exposureWeight/100 × shock — fund-level impact in pp. */
  fundImpactPct: number;
  basis: string;
}
