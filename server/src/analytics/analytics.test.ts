import test from 'node:test';
import assert from 'node:assert/strict';

import { windowReturnPct, realizedVolPct, percentile } from './returns';
import { estimateBeta } from './beta';
import { computeConcentration } from './concentration';
import { computeContributions, rollupContributions } from './attribution';
import { horizonDispersion, lumpSumVsDca, concentrationScenarios } from './entryPrice';
import { parseHoldingsCsv, ProviderBlockedError } from '../providers/ishares';
import { parseCsv, parseNumber } from '../util/csv';
import { classifySubTheme } from '../domain/subthemes';
import { vendorSymbol, isNonUsVenue, hoursBeforeUsClose } from '../domain/exchanges';
import type { Holding, PriceBar, Timeframe } from '../types';

function bars(closes: number[], startDate = '2026-01-01'): PriceBar[] {
  const out: PriceBar[] = [];
  const d = new Date(`${startDate}T00:00:00Z`);
  for (const c of closes) {
    // Skip weekends so the series looks like real trading days.
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    out.push({
      date: d.toISOString().slice(0, 10),
      open: c, high: c * 1.01, low: c * 0.99, close: c, adjClose: c, volume: 1000,
    });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* ------------------------------------------------------------ returns --- */

test('windowReturnPct anchors on the last bar at or before the window start', () => {
  const b = bars([100, 110, 121]);
  // Window starting on a date with no bar must anchor to the prior close, not
  // skip forward to the first bar inside the window. This is the bug that
  // silently zeroed out every holding contribution during development.
  const startBeforeSeries = windowReturnPct(b, b[0]!.date, b[2]!.date);
  assert.equal(startBeforeSeries, 21);

  const weekendStart = windowReturnPct(b, b[1]!.date, b[2]!.date);
  assert.ok(Math.abs((weekendStart as number) - 10) < 1e-9);
});

test('windowReturnPct returns null rather than guessing when data is absent', () => {
  assert.equal(windowReturnPct([], '2026-01-01', '2026-02-01'), null);
  assert.equal(windowReturnPct(bars([100]), '2026-01-01', '2026-02-01'), null);
  // Window entirely before the series starts.
  assert.equal(windowReturnPct(bars([100, 101]), '2020-01-01', '2020-02-01'), null);
});

test('percentile interpolates and handles degenerate input', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([10], 0.9), 10);
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

test('realizedVolPct requires a minimum sample before reporting', () => {
  assert.equal(realizedVolPct(bars([100, 101, 102]), 30), null);
  const many = bars(Array.from({ length: 60 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i))));
  assert.ok((realizedVolPct(many, 30) as number) > 0);
});

/* --------------------------------------------------------- attribution --- */

const TF: Timeframe = {
  key: '1M', label: '1 Month', startDate: '2026-01-01',
  endDate: '2026-01-09', tradingDays: 6, clippedToInception: false,
};

function holding(over: Partial<Holding>): Holding {
  return {
    ticker: 'X', name: 'X Corp', weight: 10, sector: 'Semiconductors',
    country: 'United States', exchange: 'XNAS', currency: 'USD',
    assetClass: 'Equity', subTheme: 'semiconductors', ...over,
  };
}

test('contribution equals start weight times holding return', () => {
  const priced = [
    { holding: holding({ ticker: 'A', weight: 20 }), bars: bars([100, 110]), provenance: prov() },
    { holding: holding({ ticker: 'B', weight: 5 }), bars: bars([50, 45]), provenance: prov() },
  ];
  const rows = computeContributions(priced, TF, new Map());
  const a = rows.find((r) => r.ticker === 'A')!;
  const b = rows.find((r) => r.ticker === 'B')!;

  assert.ok(Math.abs(a.returnPct - 10) < 1e-9);
  assert.ok(Math.abs(a.contributionPct - 2) < 1e-9); // 20% × 10%
  assert.ok(Math.abs(b.returnPct + 10) < 1e-9);
  assert.ok(Math.abs(b.contributionPct + 0.5) < 1e-9); // 5% × −10%

  // Sorted best-first.
  assert.equal(rows[0]!.ticker, 'A');
});

test('rollups partition contributions without loss', () => {
  const priced = [
    { holding: holding({ ticker: 'A', weight: 20, subTheme: 'memory' }), bars: bars([100, 110]), provenance: prov() },
    { holding: holding({ ticker: 'B', weight: 30, subTheme: 'memory' }), bars: bars([100, 105]), provenance: prov() },
    { holding: holding({ ticker: 'C', weight: 50, subTheme: 'software' }), bars: bars([100, 90]), provenance: prov() },
  ];
  const rows = computeContributions(priced, TF, new Map());
  const total = rows.reduce((a, r) => a + r.contributionPct, 0);
  const roll = rollupContributions(rows, (r) => r.subTheme, (k) => k);
  const rolled = roll.reduce((a, r) => a + r.contributionPct, 0);

  assert.ok(Math.abs(total - rolled) < 1e-9, 'rollup must preserve the total exactly');

  const memory = roll.find((r) => r.key === 'memory')!;
  assert.equal(memory.memberCount, 2);
  assert.ok(Math.abs(memory.startWeight - 50) < 1e-9);
  // Group return = contribution ÷ weight: (2.0 + 1.5) / 50 × 100 = 7%
  assert.ok(Math.abs(memory.groupReturnPct - 7) < 1e-9);
});

test('non-US holdings are flagged stale only on same-day windows', () => {
  const h = holding({ ticker: '000660', exchange: 'XKRX', country: 'South Korea' });
  const priced = [{ holding: h, bars: bars([100, 105]), provenance: prov() }];

  const sameDay = computeContributions(priced, { ...TF, tradingDays: 1 }, new Map());
  assert.equal(sameDay[0]!.priceStale, true);

  const monthLong = computeContributions(priced, { ...TF, tradingDays: 20 }, new Map());
  assert.equal(monthLong[0]!.priceStale, false);
});

/* ---------------------------------------------------------------- beta --- */

test('beta decomposition reconciles exactly to the fund window return', () => {
  // Fund is a deterministic 1.5× the benchmark, so beta must recover ≈1.5.
  const n = 140;
  const benchCloses: number[] = [100];
  const fundCloses: number[] = [50];
  for (let i = 1; i < n; i++) {
    const r = Math.sin(i * 1.7) * 0.01;
    benchCloses.push(benchCloses[i - 1]! * (1 + r));
    fundCloses.push(fundCloses[i - 1]! * (1 + 1.5 * r));
  }
  const fb = bars(fundCloses);
  const bb = bars(benchCloses);
  const start = fb[100]!.date;
  const end = fb[n - 1]!.date;

  const d = estimateBeta(fb, bb, start, end)!;
  assert.ok(d !== null);
  assert.ok(Math.abs(d.beta - 1.5) < 0.02, `beta was ${d.beta}`);
  assert.ok(d.rSquared > 0.99);

  const fundReturn = windowReturnPct(fb, start, end)!;
  assert.ok(
    Math.abs(d.systematicPct + d.idiosyncraticPct - fundReturn) < 1e-9,
    'systematic + idiosyncratic must equal the same fund return shown in the UI',
  );
});

test('beta is refused rather than fitted on too little data', () => {
  assert.equal(estimateBeta(bars([1, 2, 3]), bars([1, 2, 3]), '2026-01-01', '2026-01-03'), null);
});

/* ------------------------------------------------------- concentration --- */

test('effective holdings is the inverse Herfindahl and excludes cash', () => {
  const hs: Holding[] = [
    holding({ ticker: 'A', weight: 25 }),
    holding({ ticker: 'B', weight: 25 }),
    holding({ ticker: 'C', weight: 25 }),
    holding({ ticker: 'D', weight: 25 }),
    holding({ ticker: 'USD', weight: 5, assetClass: 'Cash', sector: 'Cash and/or Derivatives' }),
  ];
  const c = computeConcentration(hs);
  assert.equal(c.totalHoldings, 4, 'cash sleeve must not count as a holding');
  assert.ok(Math.abs(c.effectiveHoldings - 4) < 1e-9, 'four equal weights behave like 4 names');
  assert.equal(c.top1WeightPct, 25);
});

test('concentration scenarios are arithmetic on real weights', () => {
  const hs = [
    holding({ ticker: 'MU', weight: 10, subTheme: 'memory' }),
    holding({ ticker: 'HYNIX', weight: 20, subTheme: 'memory' }),
  ];
  const s = concentrationScenarios(hs);
  const memory = s.find((x) => x.label.includes('Memory cycle'))!;
  assert.ok(Math.abs(memory.exposureWeightPct - 30) < 1e-9);
  // 30% of NAV × −40% = −12pp
  assert.ok(Math.abs(memory.fundImpactPct + 12) < 1e-9);
});

/* ------------------------------------------------------- entry price ---- */

test('horizon dispersion normalises spread by sqrt(time), not time', () => {
  const closes = Array.from({ length: 800 }, (_, i) => 100 * Math.pow(1.0005, i) * (1 + 0.03 * Math.sin(i / 9)));
  const b = bars(closes);
  const short = horizonDispersion(b, 5, '1 week', 'BAI', false)!;
  const long = horizonDispersion(b, 252, '1 year', 'BAI', false)!;

  assert.ok(short.sampleCount > 100 && long.sampleCount > 100);
  assert.ok(short.bestPct >= short.medianPct && short.medianPct >= short.worstPct);

  // The normaliser must be sqrt(years). Guard the exact denominator, because
  // the previous `spread / years` version was dimensionally wrong: dispersion
  // accumulates with sqrt(t), so dividing by t invented most of the decline it
  // then reported as a finding.
  for (const h of [short, long]) {
    const years = h.horizonTradingDays / 252;
    assert.ok(
      Math.abs(h.spreadPerSqrtYearPct - h.spreadPct / Math.sqrt(years)) < 1e-9,
      'spread must be divided by sqrt(years)',
    );
  }

  // A 5-day horizon is 1/50th of a year, so the wrong denominator inflates it
  // by ~7x relative to the right one. Pin that the inflation is gone.
  const wrong = short.spreadPct / (5 / 252);
  assert.ok(
    short.spreadPerSqrtYearPct < wrong / 5,
    'sqrt normalisation must not reproduce the linear-annualisation blow-up',
  );

  // The middle-50% band is inside the full range by construction.
  assert.ok(long.iqrPct <= long.spreadPct);
});

test('horizon dispersion refuses horizons longer than the series', () => {
  assert.equal(horizonDispersion(bars([1, 2, 3]), 252, '1 year', 'BAI', false), null);
});

test('spreadVsMedianRatio is suppressed when the median is near zero', () => {
  // Oscillating series with a median outcome ≈ 0.
  const closes = Array.from({ length: 400 }, (_, i) => 100 + 5 * Math.sin(i / 3));
  const h = horizonDispersion(bars(closes), 21, '1 month', 'BAI', false)!;
  if (Math.abs(h.medianPct) < 1) {
    assert.ok(Number.isNaN(h.spreadVsMedianRatio), 'ratio must not explode on a ~0 denominator');
  }
});

test('lump sum and DCA deploy identical capital', () => {
  const closes = Array.from({ length: 600 }, (_, i) => 100 * Math.pow(1.0004, i));
  const r = lumpSumVsDca(bars(closes), 12000, 12, 21, 'monthly', 'BAI', false)!;
  assert.ok(r !== null);
  assert.equal(r.contributionTotalUsd, 12000);
  assert.equal(r.periods, 12);
  // In a monotonically rising market, lump sum must win every single start date.
  assert.ok(r.lumpSumWinRatePct > 99.9);
  assert.ok(r.lumpSum.medianFinalUsd > r.dca.medianFinalUsd);
});

/* ---------------------------------------------------------- providers --- */

test('iShares adapter rejects an HTML body served with a text/csv content-type', () => {
  // The observed bot-wall response: HTTP 200, content-type text/csv,
  // content-disposition attachment — and the product page as the body.
  const html = '<!DOCTYPE html>\n<html lang="en-US"><head><title>iShares</title></head></html>';
  // Which guard fires first (missing as-of date vs missing header row) is an
  // implementation detail; what matters is that HTML can never parse into an
  // empty-but-successful holdings list.
  assert.throws(() => parseHoldingsCsv(html));
});

test('holdings CSV parses the issuer format including quoted commas', () => {
  const csv = [
    'Fund Holdings as of,"Jul 24, 2026"',
    'Inception Date,"Oct 21, 2024"',
    '',
    'Ticker,Name,Sector,Asset Class,Weight (%),Shares,Market Value,Location,Exchange,Currency',
    'NVDA,"NVIDIA CORP",Semiconductors,Equity,4.90,"1,234,567","98,765,432.10",United States,NASDAQ,USD',
    '000660,"SK HYNIX INC",Semiconductors,Equity,6.75,"234,567","87,654,321.00",South Korea,Korea Exchange,KRW',
    'GOOGL,"ALPHABET INC, CLASS A",Interactive Media,Equity,3.88,"345,678","76,543,210.00",United States,NASDAQ,USD',
    '',
    'The information contained herein is provided for informational purposes.',
  ].join('\n');

  const { asOfDate, holdings } = parseHoldingsCsv(csv);
  assert.equal(asOfDate, '2026-07-24');
  assert.equal(holdings.length, 3);

  const nvda = holdings[0]!;
  assert.equal(nvda.ticker, 'NVDA');
  assert.equal(nvda.weight, 4.9);
  assert.equal(nvda.shares, 1234567);
  assert.equal(nvda.exchange, 'XNAS');

  const hynix = holdings[1]!;
  assert.equal(hynix.exchange, 'XKRX');
  assert.equal(hynix.subTheme, 'memory');
  assert.equal(hynix.country, 'South Korea');

  // The comma inside the quoted company name must not split the row.
  assert.equal(holdings[2]!.name, 'ALPHABET INC, CLASS A');
  assert.equal(holdings[2]!.weight, 3.88);
});

test('holdings parser refuses a file with no as-of date rather than guessing', () => {
  const csv = ['Ticker,Name,Weight (%)', 'NVDA,NVIDIA CORP,4.90'].join('\n');
  assert.throws(() => parseHoldingsCsv(csv), /as of/i);
});

test('CSV number parsing handles issuer formatting', () => {
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('(12.3)'), -12.3);
  assert.equal(parseNumber('-'), null);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber(undefined), null);
});

test('CSV reader handles escaped quotes', () => {
  const rows = parseCsv('a,"He said ""hi""",c');
  assert.deepEqual(rows[0], ['a', 'He said "hi"', 'c']);
});

/* ------------------------------------------------------------ domain --- */

test('sub-theme classification is exact by ticker before falling back', () => {
  assert.equal(classifySubTheme('MU', 'MICRON TECHNOLOGY INC', 'Semiconductors'), 'memory');
  assert.equal(classifySubTheme('000660', 'SK HYNIX INC', 'Semiconductors'), 'memory');
  assert.equal(classifySubTheme('NVDA', 'NVIDIA CORP', 'Semiconductors'), 'semiconductors');
  assert.equal(classifySubTheme('MSFT', 'MICROSOFT CORP', 'Software'), 'hyperscalers');
  assert.equal(classifySubTheme('VRT', 'VERTIV HOLDINGS CO', 'Electrical Equipment'), 'infrastructure');
  // Unknown ticker falls through to name, then sector.
  assert.equal(classifySubTheme('ZZZZ', 'SOME MEMORY CORP', 'Unknown'), 'memory');
  assert.equal(classifySubTheme('ZZZZ', 'MYSTERY CO', 'Semiconductors'), 'semiconductors');
  assert.equal(classifySubTheme('ZZZZ', 'MYSTERY CO', 'Pharmaceuticals'), 'other');
});

test('vendor symbols carry the venue suffix foreign listings need', () => {
  assert.equal(vendorSymbol('000660', 'XKRX'), '000660.KS');
  assert.equal(vendorSymbol('2330', 'XTAI'), '2330.TW');
  assert.equal(vendorSymbol('8035', 'XTKS'), '8035.T');
  assert.equal(vendorSymbol('NVDA', 'XNAS'), 'NVDA');
});

test('foreign venue staleness is quantified, not just flagged', () => {
  assert.equal(isNonUsVenue('XKRX'), true);
  assert.equal(isNonUsVenue('XNAS'), false);
  // KRX closes 15:30 KST = 06:30 UTC; US closes 21:00 UTC.
  assert.ok(Math.abs(hoursBeforeUsClose('XKRX') - 14.5) < 1e-9);
  assert.equal(hoursBeforeUsClose('XNAS'), 0);
});

function prov() {
  return {
    source: 'computed' as const,
    asOf: '2026-01-09T21:00:00.000Z',
    retrievedAt: new Date().toISOString(),
    reliability: 'live' as const,
    label: 'test',
  };
}

void ProviderBlockedError;
