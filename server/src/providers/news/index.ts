import { config } from '../../config';
import { cached } from '../../cache/diskCache';
import type { NewsItem } from '../../types';
import { ok, missing, type Sourced, type Provenance } from '../../util/provenance';
import { getJson, redact } from '../market/types';
import { spend } from '../market/rateLimit';
import { syntheticNews } from '../../fixtures/synthetic';

interface MarketauxResp {
  data?: Array<{
    title: string;
    description: string;
    url: string;
    source: string;
    published_at: string;
    entities?: Array<{ symbol: string; sentiment_score?: number }>;
  }>;
  error?: { message: string };
}

/**
 * News exists here for one purpose: to let the narrative layer *cite* a reason
 * rather than assert one. If no news provider is configured, the attribution
 * still computes and ranks contributors — it simply reports that it cannot
 * explain them, which is the honest outcome. Nothing invents a driver.
 */
export async function getNewsFor(
  symbols: string[],
  from: string,
  to: string,
): Promise<Sourced<NewsItem[]>> {
  if (symbols.length === 0) return ok([], newsProvenance('none', 'live'));

  if (config.fixtures.enabled) {
    const items: NewsItem[] = symbols.flatMap((s) =>
      syntheticNews(s, s).map((n) => ({
        headline: n.headline,
        url: n.url,
        source: n.source,
        publishedAt: `${to}T12:00:00.000Z`,
        summary: n.summary,
        tickers: [s],
        sentiment: null,
      })),
    );
    return ok(items, {
      source: 'synthetic.fixture',
      asOf: `${to}T12:00:00.000Z`,
      retrievedAt: new Date().toISOString(),
      reliability: 'synthetic',
      label: 'SYNTHETIC FIXTURE — placeholder news',
      note:
        'Placeholder items describing no real event. Configure MARKETAUX_API_KEY ' +
        'for genuine, citable articles.',
    });
  }

  const key = config.providers.marketaux;
  if (!key) {
    return missing(
      'no-provider-configured',
      'No news provider configured (set MARKETAUX_API_KEY). Contribution ' +
        'rankings are still computed; they are reported without explanations.',
    );
  }

  // Only US-resolvable symbols are queried; foreign local codes like "000660"
  // are not entity-resolvable by most news vendors and would return noise.
  const queryable = symbols.filter((s) => /^[A-Z.]{1,6}$/.test(s));
  if (queryable.length === 0) {
    return missing(
      'not-covered',
      `None of the requested symbols (${symbols.join(', ')}) are resolvable by ` +
        `the news provider — typically non-US local listing codes.`,
    );
  }

  /*
   * Marketaux free tier is ~100/day, charged against the same ledger the market
   * providers use — an exhausted news quota must report itself rather than look
   * like "no news found", which would read as "nothing happened".
   *
   * The throw MUST be contained here. spend() raises BudgetExhaustedError, and
   * letting that escape propagated it all the way out of getAttribution and
   * turned the entire /api/attribution response into a single error object: the
   * contributions, rollups, beta split and manager activity all vanished
   * because a *supplementary* news lookup ran out of quota. News is an
   * annotation on the numbers, never a precondition for computing them.
   */
  try {
    spend('marketaux');
  } catch (err) {
    return missing(
      'provider-error',
      err instanceof Error
        ? err.message
        : 'News request budget is spent for today.',
      'news.marketaux',
    );
  }

  const url =
    `https://api.marketaux.com/v1/news/all?symbols=${queryable.join(',')}` +
    `&filter_entities=true&language=en&published_after=${from}T00:00` +
    `&published_before=${to}T23:59&limit=50&api_token=${key}`;

  try {
    const res = await cached(`news:${queryable.join(',')}:${from}:${to}`,
      config.ttl.news, () => getJson<MarketauxResp>(url));
    if (res.value.error) throw new Error(res.value.error.message);

    const items: NewsItem[] = (res.value.data ?? []).map((d) => ({
      headline: d.title,
      url: d.url,
      source: d.source,
      publishedAt: d.published_at,
      summary: d.description ?? '',
      tickers: (d.entities ?? []).map((e) => e.symbol),
      sentiment: d.entities?.[0]?.sentiment_score ?? null,
    }));
    return ok(items, newsProvenance('news.marketaux', res.stale ? 'stale' : 'live'));
  } catch (err) {
    return missing(
      'provider-error',
      `News lookup failed: ${redact(err instanceof Error ? err.message : String(err))}`,
      'news.marketaux',
    );
  }
}

function newsProvenance(label: string, reliability: 'live' | 'stale'): Provenance {
  return {
    source: 'news.marketaux',
    asOf: new Date().toISOString(),
    retrievedAt: new Date().toISOString(),
    reliability,
    label: label === 'none' ? 'No news required' : 'Marketaux news API',
  };
}
