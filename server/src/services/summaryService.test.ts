import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summaryFacts,
  buildSummaryPrompt,
  getDailySummary,
  SUMMARY_SYSTEM,
} from './summaryService';
import type { LiveToday, LiveMover } from './liveService';

function mover(over: Partial<LiveMover> & { ticker: string }): LiveMover {
  return {
    name: `${over.ticker} Corp`,
    weight: 5,
    changePct: 1.234,
    contributionPct: 0.06,
    subTheme: 'Semiconductors',
    news: [],
    ...over,
  };
}

function liveFixture(over: Partial<LiveToday> = {}): LiveToday {
  return {
    asOf: '2026-07-30T17:00:00Z',
    delayed: true,
    marketOpen: true,
    session: { phase: 'regular', label: 'US session open', etTime: '13:00 ET' },
    fund: { last: 40.81, changePct: 8.812, dayLow: 39.45, dayHigh: 41.2, volume: 299000 },
    fundNote: null,
    impliedFromHoldingsPct: 6.96,
    coveragePct: 78.64,
    movers: { up: [], down: [] },
    bySubTheme: [],
    closedMarkets: [],
    unpriced: [],
    newsSource: { label: 'news.marketaux', available: true, note: '' },
    notes: [],
    available: true,
    reason: null,
    synthetic: false,
    ...over,
  };
}

test('summary facts cap headlines at two per mover and round for prose', () => {
  const news = [1, 2, 3, 4].map((i) => ({
    headline: `story ${i}`,
    url: `https://x/${i}`,
    source: 'wire',
    publishedAt: `2026-07-30T0${i}:00:00Z`,
  }));
  const facts = summaryFacts(
    liveFixture({
      movers: {
        up: [mover({ ticker: 'MU', changePct: 16.387, weight: 5.916, news })],
        down: [mover({ ticker: 'GOOGL', changePct: -0.514 })],
      },
    }),
  );
  assert.equal(facts.helping[0]!.headlines.length, 2);
  // One decimal: enough for prose, and stops the model echoing false precision.
  assert.equal(facts.helping[0]!.changePct, 16.4);
  assert.equal(facts.helping[0]!.weightPct, 5.9);
  assert.equal(facts.hurting[0]!.changePct, -0.5);
  // URLs are for readers, not the model — the fact sheet must not carry them.
  assert.ok(!JSON.stringify(facts).includes('https://x/'));
});

test('summary facts keep only priced Asia rows, with their session date', () => {
  const facts = summaryFacts(
    liveFixture({
      closedMarkets: [
        { ticker: '000660', name: 'SK hynix', weight: 5.94, changePct: -5.638, contributionPct: -0.33, asOf: '2026-07-30' },
        { ticker: '6857', name: 'Advantest', weight: 1.3, changePct: null, contributionPct: null, asOf: null },
      ],
    }),
  );
  assert.equal(facts.asia.length, 1);
  assert.equal(facts.asia[0]!.changePct, -5.6);
  assert.equal(facts.asia[0]!.sessionDate, '2026-07-30');
});

test('the prompt carries the fact sheet and the system prompt bans the failure modes', () => {
  const prompt = buildSummaryPrompt(
    summaryFacts(liveFixture({ movers: { up: [mover({ ticker: 'AMD' })], down: [] } })),
  );
  assert.ok(prompt.includes('AMD'));
  // The two rules the site exists to uphold: no advice, no invented causes.
  assert.ok(SUMMARY_SYSTEM.includes('Never give advice'));
  assert.ok(SUMMARY_SYSTEM.includes('not proven causes'));
});

test('no API key produces an unavailable summary without calling the model', async () => {
  let called = 0;
  const s = await getDailySummary({
    live: liveFixture(),
    apiKey: null,
    generate: async () => { called++; return { text: 'x', model: 'm' }; },
  });
  assert.equal(s.available, false);
  assert.equal(called, 0);
  assert.match(s.reason ?? '', /ANTHROPIC_API_KEY/);
});

test('a generated summary carries the text, date, and session bucket', async () => {
  const s = await getDailySummary({
    live: liveFixture(),
    apiKey: 'test-key',
    generate: async (system, prompt) => {
      assert.equal(system, SUMMARY_SYSTEM);
      assert.ok(prompt.includes('fact sheet'));
      return { text: 'BAI rose today.\n\nAsia was quiet.', model: 'claude-opus-5' };
    },
  });
  assert.equal(s.available, true);
  assert.equal(s.text, 'BAI rose today.\n\nAsia was quiet.');
  assert.ok(['during-market', 'after-close'].includes(s.session));
  assert.match(s.forDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('unusable live data degrades to unavailable, never to a guess', async () => {
  const s = await getDailySummary({
    live: liveFixture({ available: false, reason: 'quotes down', fund: null }),
    apiKey: 'test-key',
    generate: async () => { throw new Error('must not be called'); },
  });
  assert.equal(s.available, false);
  assert.match(s.reason ?? '', /quotes down/);
});
