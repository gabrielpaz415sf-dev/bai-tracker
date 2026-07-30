/**
 * Pre-render every API response to a JSON file — `npm run snapshot`.
 *
 * This is what makes the site publishable as static hosting. All endpoints are
 * read-only, so the server only needs to run at *build* time: this writes
 * web/public/api/*.json, Vite copies them into the bundle, and the deployed page
 * fetches files instead of an origin.
 *
 * Consequences worth stating plainly:
 *  - No laptop needed. The published site is up whether this Mac is or not.
 *  - Provider requests happen once per build, not once per visitor, so traffic
 *    costs nothing against the free tiers.
 *  - The data is as fresh as the last build. A scheduled job is what keeps it
 *    current; the page cannot fetch anything newer on its own.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import {
  getOverview,
  getAttribution,
  getHoldingsTable,
  getFundSeries,
} from '../services/fundService';
import { getLiveToday } from '../services/liveService';
import { buildDailyBrief, briefToMarkdown } from '../services/briefService';
import { getOutlook } from '../services/outlookService';
import { providerStatus } from '../providers/market';
import { ISHARES_HOLDINGS_URL } from '../providers/ishares';
import { budgetStatus } from '../providers/market/rateLimit';
import type { TimeframeKey } from '../types';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../../web/public/api');

const TIMEFRAMES: TimeframeKey[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'SI'];

/**
 * Fold the committed seed series into the runtime cache before fetching.
 *
 * The seed (server/data-seed/cache) carries the long price histories a CI
 * runner cannot obtain on its own: when Tiingo rate-limits, the fallback
 * provider's free tier returns only one year, and one bad run once cut BAI's
 * cached series from 442 bars to 251 — the outlook model refused to run and
 * long-window numbers quietly measured the wrong span. Union by date, with the
 * existing cache winning on overlaps: the seed is a floor of history, never a
 * source of fresher prices.
 */
async function mergeSeedIntoCache(): Promise<void> {
  const seedDir = path.resolve(here, '../../data-seed/cache');
  const cacheDir = path.resolve(here, '../../data/cache');
  let names: string[] = [];
  try {
    names = (await fs.readdir(seedDir)).filter((n) => n.startsWith('bars-full_'));
  } catch {
    return; // no seed shipped — nothing to do
  }
  await fs.mkdir(cacheDir, { recursive: true });

  interface Entry {
    key: string; storedAt: number; ttlSeconds: number;
    value: { bars: Array<{ date: string }> } & Record<string, unknown>;
  }

  for (const name of names) {
    const seed = JSON.parse(await fs.readFile(path.join(seedDir, name), 'utf8')) as Entry;
    const target = path.join(cacheDir, name);
    let out = seed;
    try {
      const cur = JSON.parse(await fs.readFile(target, 'utf8')) as Entry;
      const merged = new Map(seed.value.bars.map((b) => [b.date, b]));
      for (const b of cur.value.bars) merged.set(b.date, b);
      cur.value.bars = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
      out = cur;
    } catch {
      /* no cached copy — the seed itself becomes the starting cache, but aged
         so the TTL machinery treats it as due for refresh, not fresh data. */
      out = { ...seed, storedAt: 0 };
    }
    await fs.writeFile(target, JSON.stringify(out), 'utf8');
    console.log(`  [seed] ${name.replace(/\.[a-f0-9]+\.json$/, '')} → ${out.value.bars.length} bars`);
  }
}

/** Same envelope the Express layer adds, so the client cannot tell the difference. */
function envelope(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, __synthetic: config.fixtures.enabled };
}

async function write(name: string, body: Record<string, unknown>): Promise<void> {
  const file = path.join(OUT, `${name}.json`);
  await fs.writeFile(file, JSON.stringify(envelope(body)), 'utf8');
  const { size } = await fs.stat(file);
  console.log(`  ${name}.json`.padEnd(34) + `${(size / 1024).toFixed(1)} kB`);
}

async function main(): Promise<void> {
  if (config.fixtures.enabled) {
    // Publishing generated demo data to a public URL would be indistinguishable
    // from publishing real data to anyone reading it. Refuse.
    console.error(
      '[snapshot] refusing to build: no market-data key is configured, so every ' +
        'number would be synthetic. Set TIINGO_API_KEY (and ideally EODHD/MARKETAUX).',
    );
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(OUT, { recursive: true });
  await mergeSeedIntoCache();
  console.log(`[snapshot] writing to ${OUT}`);

  // The Transparency panel fetches this for the real refresh cadence; without it
  // the panel silently reads "Refresh cadence unavailable" on the static build.
  await write('sources', {
    ttlSeconds: {
      holdings: config.ttl.holdings,
      dailyBars: config.ttl.dailyBars,
      dailyBarsForeign: config.ttl.dailyBarsForeign,
      quote: config.ttl.quote,
      news: config.ttl.news,
    },
    holdings: { source: 'issuer.ishares', url: ISHARES_HOLDINGS_URL },
    news: {
      source: config.providers.marketaux ? 'news.marketaux' : 'none configured',
    },
  });

  /*
   * Order is budget priority, not logical grouping. A cold runner starts with
   * an empty cache, and the ~50 per-holding bar fetches inside the holdings
   * table can exhaust an hourly provider budget by themselves — on the first
   * deploy they starved the live-quote batch, and the published dashboard
   * carried a baked-in "live view unavailable". Quotes and the fund's own
   * series are the cheapest and most visible data; they go first.
   */
  await write('live', { live: await getLiveToday() });
  await write('overview', await getOverview());
  await write('outlook', { outlook: await getOutlook() });
  await write('holdings', await getHoldingsTable());
  const brief = await buildDailyBrief('1D');
  await write('brief', { brief, markdown: briefToMarkdown(brief) });

  // The timeframe picker drives these, so every option needs a file.
  // Envelopes MUST match the Express routes byte-for-byte in shape: the first
  // deploy wrote attribution as the raw Sourced wrapper while the live route
  // unwraps it, and the entire breakdown tab broke only on the published site.
  for (const tf of TIMEFRAMES) {
    await write(`series-${tf}`, await getFundSeries(tf));
    const r = await getAttribution(tf);
    await write(
      `attribution-${tf}`,
      r.ok ? { attribution: r.value, provenance: r.provenance } : { attribution: r },
    );
  }

  // Written last on purpose: the budget numbers then record what this run
  // actually spent, which is the first thing to look at when a deploy degrades.
  await write('health', {
    ok: true,
    providers: providerStatus(),
    fixturesEnabled: config.fixtures.enabled,
    requestBudget: budgetStatus(),
  });

  console.log('[snapshot] done');
}

main().catch((err) => {
  console.error('[snapshot] fatal:', err);
  process.exitCode = 1;
});
