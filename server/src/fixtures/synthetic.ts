import { config } from '../config';
import { FUND, type Holding, type PriceBar, type SubTheme } from '../types';
import { classifySubTheme } from '../domain/subthemes';
import { normalizeExchange } from '../domain/exchanges';

/**
 * SYNTHETIC DATA GENERATOR — NOT REAL MARKET DATA.
 *
 * Purpose: make the dashboard and, more importantly, the attribution engine
 * reviewable without paid API keys. Everything produced here is stamped
 * `reliability: 'synthetic'`, which the provenance combinator propagates into
 * every derived number, and the UI renders a permanent banner whenever any
 * synthetic value is present.
 *
 * Design choice worth understanding: the fund's price series is *constructed
 * from* its holdings' series rather than generated independently. Each day,
 * BAI's return is the weight-weighted sum of its constituents' returns. That
 * means contribution analysis genuinely reconciles to the fund return, betas
 * are internally consistent, and sector rollups add up — so the demo exercises
 * the real maths instead of showing numbers that happen to look plausible.
 *
 * The holdings roster and weights below are modelled on BAI's published
 * portfolio so that sector/sub-theme/geography logic is exercised realistically
 * (including the KRX names that drive the staleness handling). The PRICES,
 * RETURNS, NAV, VOLUMES AND NEWS ARE INVENTED.
 */

/** Deterministic PRNG so restarts don't reshuffle the demo. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, so returns are normal rather than uniform. */
function gaussian(rnd: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface Spec {
  ticker: string;
  name: string;
  weight: number;
  sector: string;
  country: string;
  exchange: string;
  currency: string;
  /** Sensitivity to the common tech factor. */
  beta: number;
  /** Annualised idiosyncratic vol. */
  idioVol: number;
  startPrice: number;
}

const SPECS: Spec[] = [
  ['000660', 'SK HYNIX INC', 6.75, 'Semiconductors', 'South Korea', 'XKRX', 'KRW', 1.55, 0.36, 178000],
  ['MU', 'MICRON TECHNOLOGY INC', 5.89, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.6, 0.38, 96],
  ['AMD', 'ADVANCED MICRO DEVICES INC', 5.25, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.5, 0.34, 142],
  ['NVDA', 'NVIDIA CORP', 4.9, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.45, 0.32, 118],
  ['AVGO', 'BROADCOM INC', 4.72, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.25, 0.26, 172],
  ['MSFT', 'MICROSOFT CORP', 4.31, 'Software', 'United States', 'XNAS', 'USD', 0.95, 0.18, 418],
  ['TSM', 'TAIWAN SEMICONDUCTOR MANUFACTURING', 4.05, 'Semiconductors', 'Taiwan', 'XTAI', 'TWD', 1.3, 0.28, 195],
  ['GOOGL', 'ALPHABET INC CLASS A', 3.88, 'Interactive Media & Services', 'United States', 'XNAS', 'USD', 1.0, 0.2, 168],
  ['AMZN', 'AMAZON COM INC', 3.42, 'Broadline Retail', 'United States', 'XNAS', 'USD', 1.05, 0.22, 186],
  ['META', 'META PLATFORMS INC CLASS A', 3.15, 'Interactive Media & Services', 'United States', 'XNAS', 'USD', 1.15, 0.25, 572],
  ['ANET', 'ARISTA NETWORKS INC', 2.84, 'Communications Equipment', 'United States', 'XNYS', 'USD', 1.35, 0.3, 372],
  ['VRT', 'VERTIV HOLDINGS CO', 2.61, 'Electrical Equipment', 'United States', 'XNYS', 'USD', 1.7, 0.42, 108],
  ['ASML', 'ASML HOLDING NV', 2.48, 'Semiconductors', 'Netherlands', 'XAMS', 'EUR', 1.3, 0.29, 685],
  ['MRVL', 'MARVELL TECHNOLOGY INC', 2.31, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.65, 0.4, 88],
  ['ORCL', 'ORACLE CORP', 2.19, 'Software', 'United States', 'XNYS', 'USD', 1.1, 0.24, 168],
  ['PLTR', 'PALANTIR TECHNOLOGIES INC CLASS A', 2.08, 'Software', 'United States', 'XNAS', 'USD', 1.75, 0.48, 62],
  ['AMAT', 'APPLIED MATERIALS INC', 1.97, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.35, 0.3, 178],
  ['LRCX', 'LAM RESEARCH CORP', 1.86, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.4, 0.32, 74],
  ['CRWV', 'COREWEAVE INC CLASS A', 1.74, 'IT Services', 'United States', 'XNAS', 'USD', 2.0, 0.62, 48],
  ['ARM', 'ARM HOLDINGS PLC ADR', 1.68, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.5, 0.38, 132],
  ['DELL', 'DELL TECHNOLOGIES INC CLASS C', 1.59, 'Technology Hardware', 'United States', 'XNYS', 'USD', 1.3, 0.32, 118],
  ['NOW', 'SERVICENOW INC', 1.52, 'Software', 'United States', 'XNYS', 'USD', 1.05, 0.24, 928],
  ['8035', 'TOKYO ELECTRON LTD', 1.46, 'Semiconductors', 'Japan', 'XTKS', 'JPY', 1.4, 0.33, 23400],
  ['CRDO', 'CREDO TECHNOLOGY GROUP HOLDING', 1.38, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.85, 0.55, 42],
  ['SNPS', 'SYNOPSYS INC', 1.31, 'Software', 'United States', 'XNAS', 'USD', 1.1, 0.26, 512],
  ['KLAC', 'KLA CORP', 1.27, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.35, 0.3, 628],
  ['GEV', 'GE VERNOVA INC', 1.22, 'Electrical Equipment', 'United States', 'XNYS', 'USD', 1.2, 0.3, 328],
  ['CDNS', 'CADENCE DESIGN SYSTEMS INC', 1.18, 'Software', 'United States', 'XNAS', 'USD', 1.1, 0.26, 302],
  ['ALAB', 'ASTERA LABS INC', 1.14, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.9, 0.58, 68],
  ['2330', 'TAIWAN SEMICONDUCTOR MFG LTD', 1.09, 'Semiconductors', 'Taiwan', 'XTAI', 'TWD', 1.3, 0.28, 1020],
  ['COHR', 'COHERENT CORP', 1.05, 'Electronic Equipment', 'United States', 'XNYS', 'USD', 1.6, 0.44, 92],
  ['700', 'TENCENT HOLDINGS LTD', 1.01, 'Interactive Media & Services', 'Hong Kong', 'XHKG', 'HKD', 0.95, 0.28, 412],
  ['SNOW', 'SNOWFLAKE INC CLASS A', 0.97, 'Software', 'United States', 'XNYS', 'USD', 1.4, 0.42, 168],
  ['CRM', 'SALESFORCE INC', 0.94, 'Software', 'United States', 'XNYS', 'USD', 1.0, 0.26, 268],
  ['DDOG', 'DATADOG INC CLASS A', 0.9, 'Software', 'United States', 'XNAS', 'USD', 1.35, 0.38, 128],
  ['EQIX', 'EQUINIX INC REIT', 0.87, 'Real Estate', 'United States', 'XNAS', 'USD', 0.75, 0.2, 872],
  ['6857', 'ADVANTEST CORP', 0.84, 'Semiconductors', 'Japan', 'XTKS', 'JPY', 1.55, 0.4, 8200],
  ['SMCI', 'SUPER MICRO COMPUTER INC', 0.81, 'Technology Hardware', 'United States', 'XNAS', 'USD', 2.1, 0.72, 38],
  ['QCOM', 'QUALCOMM INC', 0.78, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.15, 0.28, 168],
  ['PANW', 'PALO ALTO NETWORKS INC', 0.75, 'Software', 'United States', 'XNAS', 'USD', 1.05, 0.28, 372],
  ['ETN', 'EATON CORP PLC', 0.72, 'Electrical Equipment', 'United States', 'XNYS', 'USD', 1.05, 0.24, 328],
  ['NBIS', 'NEBIUS GROUP NV CLASS A', 0.69, 'IT Services', 'Netherlands', 'XNAS', 'USD', 2.05, 0.68, 32],
  ['005930', 'SAMSUNG ELECTRONICS LTD', 0.66, 'Technology Hardware', 'South Korea', 'XKRX', 'KRW', 1.25, 0.3, 58900],
  ['APP', 'APPLOVIN CORP CLASS A', 0.63, 'Software', 'United States', 'XNAS', 'USD', 1.7, 0.52, 168],
  ['CIEN', 'CIENA CORP', 0.6, 'Communications Equipment', 'United States', 'XNYS', 'USD', 1.45, 0.4, 68],
  ['MDB', 'MONGODB INC CLASS A', 0.57, 'Software', 'United States', 'XNAS', 'USD', 1.4, 0.44, 262],
  ['TER', 'TERADYNE INC', 0.54, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.45, 0.36, 118],
  ['WDC', 'WESTERN DIGITAL CORP', 0.51, 'Technology Hardware', 'United States', 'XNAS', 'USD', 1.6, 0.44, 68],
  ['MPWR', 'MONOLITHIC POWER SYSTEMS INC', 0.48, 'Semiconductors', 'United States', 'XNAS', 'USD', 1.3, 0.34, 622],
  ['CRWD', 'CROWDSTRIKE HOLDINGS INC CLASS A', 0.45, 'Software', 'United States', 'XNAS', 'USD', 1.15, 0.32, 348],
  ['NXPI', 'NXP SEMICONDUCTORS NV', 0.42, 'Semiconductors', 'Netherlands', 'XNAS', 'USD', 1.25, 0.3, 212],
  ['PWR', 'QUANTA SERVICES INC', 0.39, 'Construction & Engineering', 'United States', 'XNYS', 'USD', 1.2, 0.3, 312],
  ['DLR', 'DIGITAL REALTY TRUST INC REIT', 0.36, 'Real Estate', 'United States', 'XNYS', 'USD', 0.8, 0.24, 168],
  ['STX', 'SEAGATE TECHNOLOGY HOLDINGS PLC', 0.33, 'Technology Hardware', 'United States', 'XNAS', 'USD', 1.55, 0.42, 98],
].map(
  ([ticker, name, weight, sector, country, exchange, currency, beta, idioVol, startPrice]) => ({
    ticker: ticker as string,
    name: name as string,
    weight: weight as number,
    sector: sector as string,
    country: country as string,
    exchange: exchange as string,
    currency: currency as string,
    beta: beta as number,
    idioVol: idioVol as number,
    startPrice: startPrice as number,
  }),
);

/** Cash line, so total weight reconciles to ~100% like a real fund file. */
const CASH_WEIGHT = 0.35;

export interface SyntheticWorld {
  asOfDate: string;
  holdings: Holding[];
  /** Keyed by vendor-style symbol. */
  series: Map<string, PriceBar[]>;
  tradingDays: string[];
}

/** US trading days between two dates, skipping weekends (not holidays). */
function tradingDays(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

let cache: SyntheticWorld | null = null;

export function syntheticWorld(endDate: string): SyntheticWorld {
  if (cache && cache.asOfDate === endDate) return cache;

  const rnd = mulberry32(config.fixtures.seed);
  const days = tradingDays(FUND.inceptionDate, endDate);
  const n = days.length;

  // Common tech factor. Mild positive drift with a couple of drawdown regimes
  // so the drawdown/vol gauges and the beta split have something to chew on.
  const factor: number[] = [];
  for (let i = 0; i < n; i++) {
    const phase = i / n;
    // Two synthetic risk-off stretches.
    const regime =
      phase > 0.28 && phase < 0.36 ? -0.0018 : phase > 0.66 && phase < 0.72 ? -0.0024 : 0.0006;
    const vol = phase > 0.28 && phase < 0.36 ? 0.016 : 0.0095;
    factor.push(regime + gaussian(rnd) * vol);
  }

  const series = new Map<string, PriceBar[]>();
  const holdingReturns = new Map<string, number[]>();

  // Share of each name's variance that is stock-specific rather than common.
  // Tuned so the synthetic fund's fitted beta to the synthetic benchmark lands
  // around R² ≈ 0.75, which is roughly where a concentrated tech ETF sits
  // against QQQ in practice. Left too high, every window would trip the
  // narrative layer's R² guard and the beta split would never be exercised in
  // demo mode.
  const IDIO_SCALE = 0.55;

  for (const s of SPECS) {
    const rets: number[] = [];
    const idioDaily = (s.idioVol * IDIO_SCALE) / Math.sqrt(252);
    for (let i = 0; i < n; i++) {
      rets.push(s.beta * (factor[i] ?? 0) + gaussian(rnd) * idioDaily);
    }
    holdingReturns.set(s.ticker, rets);
    series.set(symbolFor(s), barsFrom(days, rets, s.startPrice, rnd));
  }

  // The fund's own series, built from its constituents so attribution
  // reconciles. Daily fund return = Σ wᵢ·rᵢ, less a daily slice of the 0.55%
  // expense ratio, with the cash sleeve earning nothing.
  const fundRets: number[] = [];
  const dailyFee = 0.0055 / 252;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (const s of SPECS) {
      r += (s.weight / 100) * (holdingReturns.get(s.ticker)?.[i] ?? 0);
    }
    fundRets.push(r - dailyFee);
  }
  series.set('BAI', barsFrom(days, fundRets, 25.0, rnd));

  // Benchmarks: same factor, different loadings, plus their own idio noise.
  // Benchmark idiosyncratic vol is deliberately small. These are themselves
  // diversified index funds, so almost all of their movement is the common
  // factor. Giving them large private noise would attenuate the fitted beta
  // toward zero and depress R² — an artefact of the generator, not of the
  // relationship being measured.
  const benchSpecs: Array<[string, number, number, number]> = [
    ['QQQ', 0.85, 0.045, 495],
    ['SOXX', 1.35, 0.11, 228],
    ['ARTY', 1.05, 0.08, 62],
    ['IGPT', 1.0, 0.08, 48],
  ];
  for (const [sym, beta, vol, px] of benchSpecs) {
    const rets: number[] = [];
    for (let i = 0; i < n; i++) {
      rets.push(beta * (factor[i] ?? 0) + gaussian(rnd) * (vol / Math.sqrt(252)));
    }
    series.set(sym, barsFrom(days, rets, px, rnd));
  }

  // Long-horizon proxy needs history predating BAI, for the horizon simulator.
  const proxyDays = tradingDays('2010-01-04', endDate);
  const proxyRets: number[] = [];
  for (let i = 0; i < proxyDays.length; i++) {
    // Two extended bear stretches. A smooth upward-drifting proxy would make
    // every long horizon look risk-free — the worst 10-year entry would still
    // be strongly positive — which is a property of the generator, not of
    // equity markets, and would teach the reader something false about how
    // safe long holding periods are.
    const phase = i / proxyDays.length;
    const bear = (phase > 0.17 && phase < 0.26) || (phase > 0.55 && phase < 0.61);
    const drift = bear ? -0.0022 : 0.00075;
    const vol = bear ? 0.019 : 0.0092;
    proxyRets.push(drift + gaussian(rnd) * vol);
  }
  series.set('QQQ__LONG', barsFrom(proxyDays, proxyRets, 46, rnd));

  const holdings: Holding[] = SPECS.map((s) => ({
    ticker: s.ticker,
    name: s.name,
    weight: s.weight,
    sector: s.sector,
    country: s.country,
    exchange: normalizeExchange(s.exchange),
    currency: s.currency,
    assetClass: 'Equity',
    subTheme: classifySubTheme(s.ticker, s.name, s.sector) as SubTheme,
  }));
  holdings.push({
    ticker: 'USD',
    name: 'USD CASH',
    weight: CASH_WEIGHT,
    sector: 'Cash and/or Derivatives',
    country: 'United States',
    exchange: 'UNKNOWN',
    currency: 'USD',
    assetClass: 'Cash',
    subTheme: 'other',
  });

  cache = { asOfDate: endDate, holdings, series, tradingDays: days };
  return cache;
}

function barsFrom(
  days: string[],
  rets: number[],
  startPrice: number,
  rnd: () => number,
): PriceBar[] {
  const bars: PriceBar[] = [];
  let px = startPrice;
  for (let i = 0; i < days.length; i++) {
    const prev = px;
    px = px * (1 + (rets[i] ?? 0));
    const hi = Math.max(prev, px) * (1 + rnd() * 0.006);
    const lo = Math.min(prev, px) * (1 - rnd() * 0.006);
    bars.push({
      date: days[i] as string,
      open: prev,
      high: hi,
      low: lo,
      close: px,
      adjClose: px,
      volume: Math.round(400_000 + rnd() * 3_500_000),
    });
  }
  return bars;
}

function symbolFor(s: Spec): string {
  const suffix: Record<string, string> = {
    XKRX: '.KS',
    XTAI: '.TW',
    XTKS: '.T',
    XHKG: '.HK',
    XAMS: '.AS',
  };
  return `${s.ticker}${suffix[s.exchange] ?? ''}`;
}

/**
 * Synthetic "news". Deliberately generic and clearly non-factual: it exists to
 * exercise the narrative renderer's citation plumbing, and every item is
 * labelled synthetic in the UI. It never asserts a real-world event.
 */
export function syntheticNews(ticker: string, name: string): {
  headline: string;
  url: string;
  source: string;
  summary: string;
}[] {
  return [
    {
      headline: `[SYNTHETIC] Placeholder market item for ${name} (${ticker})`,
      url: 'https://example.invalid/synthetic-news',
      source: 'SYNTHETIC FIXTURE — not a real publisher',
      summary:
        'This is placeholder text generated for demo mode. It describes no real ' +
        'event and must not be read as news. Configure a news provider key to ' +
        'populate genuine, cited articles.',
    },
  ];
}
