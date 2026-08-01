import test from 'node:test';
import assert from 'node:assert/strict';

import { checkSnapshot, weekdaysBetween } from './checkSnapshot';
import { lastCompletedTradingDate, sessionState } from '../domain/session';

/*
 * The gate's contract: contradictions FAIL, labeled degradation only WARNS.
 * Fixtures are built around a fixed "now" so results never depend on when the
 * suite happens to run.
 */

// A Wednesday 18:00 ET (22:00 UTC, market closed) in a week with no holidays.
const NOW = new Date('2026-07-29T22:00:00Z');
const LAST_CLOSE = lastCompletedTradingDate(NOW);
const TRADING_DATE = sessionState(NOW).open ? sessionState(NOW).etDate : LAST_CLOSE;

function goodFiles(): Record<string, unknown> {
  return {
    live: {
      live: {
        available: true,
        movers: {
          up: [{ ticker: 'MU' }],
          down: [{ ticker: 'GOOGL' }],
        },
        closedMarkets: [{ ticker: '000660' }],
      },
      __synthetic: false,
    },
    overview: {
      returns: [{ key: '1D', marketReturnPct: { ok: true, value: 1.2 } }],
      __synthetic: false,
    },
    holdings: {
      asOfDate: LAST_CLOSE,
      holdings: [
        ...['MU', 'GOOGL', '000660'].map((t) => ({ ticker: t, assetClass: 'Equity' })),
        ...Array.from({ length: 40 }, (_, i) => ({ ticker: `EQ${i}`, assetClass: 'Equity' })),
        { ticker: 'USD', assetClass: 'Cash' },
      ],
      __synthetic: false,
    },
    'series-3M': { bars: [{ date: '2026-06-01' }, { date: LAST_CLOSE }], __synthetic: false },
    summary: {
      summary: {
        available: true,
        forDate: TRADING_DATE,
        generatedAt: new Date(NOW.getTime() - 5 * 60000).toISOString(),
        text: 'BAI rose.',
      },
      __synthetic: false,
    },
    health: { ok: true, __synthetic: false },
  };
}

test('a consistent build passes with no failures', () => {
  const r = checkSnapshot(goodFiles(), NOW);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings, []);
});

test('a series ending on the wrong trading day is a contradiction', () => {
  const files = goodFiles();
  (files['series-3M'] as { bars: Array<{ date: string }> }).bars.pop();
  const r = checkSnapshot(files, NOW);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0]!, /ends at 2026-06-01/);
});

test('a mover missing from holdings means the files disagree — fail', () => {
  const files = goodFiles();
  (files['holdings'] as { holdings: Array<{ ticker: string }> }).holdings =
    (files['holdings'] as { holdings: Array<{ ticker: string; assetClass: string }> }).holdings
      .filter((h) => h.ticker !== 'MU');
  const r = checkSnapshot(files, NOW);
  assert.ok(r.failures.some((f) => f.includes('mover MU')));
});

test('synthetic data anywhere is unpublishable', () => {
  const files = goodFiles();
  (files['overview'] as { __synthetic: boolean }).__synthetic = true;
  const r = checkSnapshot(files, NOW);
  assert.ok(r.failures.some((f) => f.includes('synthetic')));
});

test('labeled degradation warns without failing', () => {
  const files = goodFiles();
  (files['live'] as { live: { available: boolean; reason?: string } }).live = {
    available: false,
    reason: 'provider throttled',
  };
  (files['summary'] as { summary: { available: boolean } }).summary = { available: false };
  const r = checkSnapshot(files, NOW);
  assert.deepEqual(r.failures, []);
  assert.equal(r.warnings.length, 2);
});

test('a summary for the wrong day or from an earlier run is a contradiction', () => {
  const wrongDay = goodFiles();
  (wrongDay['summary'] as { summary: { forDate: string } }).summary.forDate = '2026-07-01';
  assert.ok(checkSnapshot(wrongDay, NOW).failures.some((f) => f.includes('2026-07-01')));

  const staleGen = goodFiles();
  (staleGen['summary'] as { summary: { generatedAt: string } }).summary.generatedAt =
    new Date(NOW.getTime() - 3 * 3600_000).toISOString();
  assert.ok(checkSnapshot(staleGen, NOW).failures.some((f) => f.includes('force path')));
});

test('a missing file fails before shape checks can throw', () => {
  const files = goodFiles();
  delete files['holdings'];
  const r = checkSnapshot(files, NOW);
  assert.deepEqual(r.failures, ['holdings.json is missing']);
});

test('weekdaysBetween counts business days only', () => {
  assert.equal(weekdaysBetween('2026-07-24', '2026-07-29'), 3); // Fri→Wed: Fri,Mon,Tue
  assert.equal(weekdaysBetween('2026-07-29', '2026-07-29'), 0);
});
