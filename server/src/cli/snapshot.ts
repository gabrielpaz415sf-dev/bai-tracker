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
import { buildDailyBrief } from '../services/briefService';
import { getOutlook } from '../services/outlookService';
import { providerStatus } from '../providers/market';
import { ISHARES_HOLDINGS_URL } from '../providers/ishares';
import { budgetStatus } from '../providers/market/rateLimit';
import type { TimeframeKey } from '../types';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../../web/public/api');

const TIMEFRAMES: TimeframeKey[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'SI'];

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
  console.log(`[snapshot] writing to ${OUT}`);

  await write('health', {
    ok: true,
    providers: providerStatus(),
    fixturesEnabled: config.fixtures.enabled,
    requestBudget: budgetStatus(),
  });

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

  await write('overview', await getOverview());
  await write('holdings', await getHoldingsTable());
  await write('live', { live: await getLiveToday() });
  await write('brief', { brief: await buildDailyBrief('1D') });
  await write('outlook', { outlook: await getOutlook() });

  // The timeframe picker drives these, so every option needs a file.
  for (const tf of TIMEFRAMES) {
    await write(`series-${tf}`, await getFundSeries(tf));
    await write(`attribution-${tf}`, { attribution: await getAttribution(tf) });
  }

  console.log('[snapshot] done');
}

main().catch((err) => {
  console.error('[snapshot] fatal:', err);
  process.exitCode = 1;
});
