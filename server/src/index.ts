import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { config } from './config';
import type { TimeframeKey } from './types';
import {
  getOverview,
  getAttribution,
  getHoldingsTable,
  getFundSeries,
} from './services/fundService';
import { getEntryPriceAnalysis } from './services/entryService';
import { getOutlook } from './services/outlookService';
import { providerStatus } from './providers/market';
import { ISHARES_HOLDINGS_URL } from './providers/ishares';
import { budgetStatus } from './providers/market/rateLimit';

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Basic auth for anything arriving through the Cloudflare tunnel.
 *
 * The server binds 127.0.0.1, and cloudflared connects to it over that same
 * loopback — so source IP cannot distinguish "me in a local browser" from "the
 * public internet via the tunnel". Cloudflare stamps CF-Ray on every request it
 * proxies, and nothing else sets it, so its presence is the tunnel marker.
 *
 * That header is trivially forgeable — but only by something that can already
 * reach 127.0.0.1, which means it already has local access to this machine and
 * has no need to bother. Forging it can only *add* an auth requirement, never
 * bypass one. Set BAI_AUTH_ALWAYS=1 to demand credentials locally too.
 *
 * Why bother at all: the free Tiingo tier allows ~45 requests/hour. One crawler
 * on an open URL exhausts that, and the dashboard starts showing coverage gaps
 * instead of data. The password protects the rate limit as much as the content.
 */
/**
 * No WWW-Authenticate header on purpose. Sending it asks the browser for a
 * basic-auth dialog, and browsers increasingly decline to show one — leaving
 * the user staring at a bare "Authentication required." string that reads as a
 * broken site. An explanatory page that names the actual fix is more use than a
 * prompt that may never appear. curl -u still authenticates, because it sends
 * the Authorization header pre-emptively rather than waiting to be challenged.
 */
function unauthorized(res: express.Response): void {
  res.status(401).type('html').send(
    `<!doctype html><meta charset="utf-8">
<title>BAI Tracker — link key required</title>
<style>
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
       background:#070910;color:#e8edf7;display:grid;place-items:center;
       min-height:100vh;margin:0;padding:24px}
  div{max-width:30rem}
  h1{font-size:19px;margin:0 0 12px}
  p{color:#93a0b7;margin:0 0 10px}
  code{background:#171d2b;padding:2px 6px;border-radius:4px;font-size:13px}
</style>
<div>
  <h1>This link needs its access key</h1>
  <p>The dashboard is reachable, but the URL you used is missing the
     <code>?k=</code> key that authorises it.</p>
  <p>Open the full link you were sent — it looks like
     <code>https://&hellip;trycloudflare.com/?k=&hellip;</code> — and the key is
     remembered on this device for 30 days.</p>
  <p>The key exists to keep crawlers from spending this project's
     free-tier market-data allowance, not to hide anything.</p>
</div>`,
  );
}

/**
 * Length-independent constant-time compare. timingSafeEqual throws on unequal
 * lengths, which would itself leak the secret's length, so both sides are
 * hashed to a fixed 32 bytes first.
 */
function secretEq(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

/** Minimal cookie read — avoids adding cookie-parser for one value. */
function cookie(req: express.Request, name: string): string | undefined {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const TOKEN_COOKIE = 'bai_access';

app.use((req, res, next) => {
  const { user, pass, token, always } = config.auth;
  if (!pass && !token) return next(); // nothing configured — local-only posture

  const viaTunnel = Boolean(req.get('cf-ray') ?? req.get('cf-connecting-ip'));
  if (!viaTunnel && !always) return next();

  // 1. Token in the query string — the clickable-link path. Once seen, it is
  //    stored in a cookie so in-app fetches to /api/* carry it automatically
  //    without every link in the UI needing to append it.
  if (token) {
    const supplied = typeof req.query.k === 'string' ? req.query.k : undefined;
    if (supplied && secretEq(supplied, token)) {
      res.cookie(TOKEN_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      /*
       * Deliberately NOT redirecting to strip ?k= from the address bar.
       *
       * That looked tidier and broke the link. Stripping it meant the URL that
       * landed in history and autocomplete was the bare hostname, so opening the
       * site later sent no key — and the cookie could not cover for it, because
       * cookies are scoped per hostname and this tunnel's hostname rotates every
       * time Cloudflare recycles it. The user got the "needs its access key"
       * page on a URL that had worked minutes earlier.
       *
       * Keeping the token in the URL means history, bookmarks and autocomplete
       * all keep something that works. The token guards a free-tier request
       * budget on a personal dashboard, not anything sensitive.
       */
      return next();
    }
    const jar = cookie(req, TOKEN_COOKIE);
    if (jar && secretEq(jar, token)) return next();
  }

  // 2. Basic auth still accepted — keeps curl and scripted checks working.
  const header = req.get('authorization') ?? '';
  if (pass && header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const gotUser = sep === -1 ? decoded : decoded.slice(0, sep);
    const gotPass = sep === -1 ? '' : decoded.slice(sep + 1);
    if (secretEq(gotUser, user) && secretEq(gotPass, pass)) return next();
  }

  return unauthorized(res);
});

const VALID: TimeframeKey[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'SI'];

function timeframeOf(raw: unknown): TimeframeKey {
  const s = String(raw ?? '1M').toUpperCase();
  return (VALID as string[]).includes(s) ? (s as TimeframeKey) : '1M';
}

/** Every response carries the synthetic flag so no client can miss it. */
function send(res: express.Response, body: Record<string, unknown>): void {
  res.json({ ...body, __synthetic: config.fixtures.enabled });
}

const wrap =
  (fn: (req: express.Request) => Promise<Record<string, unknown>>) =>
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      send(res, await fn(req));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Errors are reported, never papered over with a plausible payload.
      res.status(500).json({ error: 'request-failed', detail, __synthetic: config.fixtures.enabled });
    }
  };

app.get('/api/health', (_req, res) => {
  send(res, {
    ok: true,
    providers: providerStatus(),
    fixturesEnabled: config.fixtures.enabled,
    requestBudget: budgetStatus(),
  });
});

app.get('/api/overview', wrap(() => getOverview()));

// Forward outcome distribution. Pure computation over already-cached bars, so
// this costs no provider requests.
app.get('/api/outlook', wrap(async () => ({ outlook: await getOutlook() })));

app.get('/api/holdings', wrap(() => getHoldingsTable()));

app.get(
  '/api/series',
  wrap((req) => getFundSeries(timeframeOf(req.query.timeframe))),
);

app.get(
  '/api/attribution',
  wrap(async (req) => {
    const r = await getAttribution(timeframeOf(req.query.timeframe));
    return r.ok ? { attribution: r.value, provenance: r.provenance } : { attribution: r };
  }),
);

app.get(
  '/api/entry-price',
  wrap((req) =>
    getEntryPriceAnalysis({
      contributionUsd: Number(req.query.amount ?? 10000) || 10000,
      dcaPeriods: Number(req.query.periods ?? 12) || 12,
    }),
  ),
);

app.get(
  '/api/live',
  wrap(async () => {
    const { getLiveToday } = await import('./services/liveService');
    return { live: await getLiveToday() };
  }),
);

app.get(
  '/api/brief',
  wrap(async (req) => {
    const { buildDailyBrief, briefToMarkdown } = await import('./services/briefService');
    const brief = await buildDailyBrief(timeframeOf(req.query.timeframe ?? '1D'));
    return { brief, markdown: briefToMarkdown(brief) };
  }),
);

/** Transparency endpoint: what we pull, from where, how often. */
app.get('/api/sources', (_req, res) => {
  send(res, {
    // Machine-readable so the UI states the *actual* configured cadence rather
    // than a prose copy of it that silently rots when a TTL is retuned.
    ttlSeconds: {
      holdings: config.ttl.holdings,
      dailyBars: config.ttl.dailyBars,
      dailyBarsForeign: config.ttl.dailyBarsForeign,
      quote: config.ttl.quote,
      news: config.ttl.news,
    },
    holdings: {
      source: 'iShares published holdings CSV',
      url: ISHARES_HOLDINGS_URL,
      cadence: 'Once per business day, after issuer publishes (TTL 6h)',
      note:
        'Fronted by bot protection. Returns HTTP 200 with a text/csv ' +
        'content-type but an HTML body when blocked; the adapter sniffs the ' +
        'body and fails loudly rather than parsing zero holdings.',
    },
    prices: {
      source: providerStatus().configured,
      cadence: `Daily bars TTL ${config.ttl.dailyBars}s; quotes TTL ${config.ttl.quote}s`,
      note: providerStatus().realtime
        ? 'A real-time-capable provider is configured.'
        : 'All configured providers are delayed/end-of-day. UI labels quotes as delayed.',
    },
    news: {
      source: config.providers.marketaux ? 'Marketaux' : 'none configured',
      cadence: `TTL ${config.ttl.news}s`,
      note:
        'Used only to cite coincident articles for top movers. Absence of news ' +
        'never produces an invented explanation.',
    },
    nav: {
      source: 'not configured',
      note:
        'NAV and premium/discount require an ETF-aware feed. Not approximated ' +
        'from market price.',
    },
  });
});

/**
 * An unmatched /api path is a client bug, not a page. Answer it as JSON before
 * the SPA fallback below, which would otherwise hand back index.html and let a
 * typo'd endpoint surface as "unexpected token <" deep in the fetch layer.
 */
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'no-such-endpoint', __synthetic: config.fixtures.enabled });
});

/**
 * Serve the built dashboard from the same origin as the API, which is what
 * makes this a website you can just open rather than a dev-server pair.
 * web/src/api.ts fetches a relative `/api`, so same-origin needs no client
 * config. In dev, Vite still serves :5183 and proxies here — unchanged.
 *
 * here = server/src (tsx) or server/dist (built); both sit one level under
 * server/, so the repo root is two levels up either way — same reasoning as
 * config.ts's .env lookup.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.BAI_WEB_DIST ?? path.resolve(here, '../../web/dist');
const hasWebBuild = existsSync(path.join(WEB_DIST, 'index.html'));

if (hasWebBuild) {
  app.use(express.static(WEB_DIST));
  // Single-page app: any non-API path is a client route, not a file.
  app.get('*', (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
}

// Bind to loopback only. This process holds provider API keys and there is no
// reason for it to be reachable from the LAN.
app.listen(config.port, '127.0.0.1', () => {
  const mode = config.fixtures.enabled
    ? 'SYNTHETIC FIXTURE MODE (no real market data)'
    : `live providers: ${providerStatus().configured.join(', ') || 'none'}`;
  console.log(`[bai-tracker] http://localhost:${config.port} — ${mode}`);
  if (!hasWebBuild) {
    console.log(
      `[bai-tracker] API only: no built dashboard at ${WEB_DIST}. ` +
        'Run `npm run build` to serve the UI from this origin.',
    );
  }
  if (config.fixtures.enabled) {
    console.log(
      '[bai-tracker] WARNING: serving synthetic data. Set a provider key ' +
        '(e.g. TIINGO_API_KEY) and BAI_FIXTURES=0 for real data.',
    );
  }
});
