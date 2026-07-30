import { parseCsv, parseNumber } from '../util/csv';
import { config } from '../config';
import { cached } from '../cache/diskCache';
import { FUND, type Holding, type HoldingsSnapshot, type FundFacts } from '../types';
import { ok, missing, type Sourced } from '../util/provenance';
import { classifySubTheme } from '../domain/subthemes';
import { normalizeExchange } from '../domain/exchanges';

/**
 * iShares publishes the full holdings file at a stable per-fund CSV URL — this
 * is the href behind the product page's "Download" button (verified in the
 * page DOM). Note it is NOT the widely-cited `.ajax?fileType=csv` endpoint:
 * that one answers with the product page's HTML (served under a text/csv
 * content-type), which is easy to mistake for bot protection.
 */
const HOLDINGS_URL =
  `https://www.ishares.com/us/products/${FUND.isharesProductId}` +
  `/ishares-a-i-innovation-and-tech-active-etf/latest-holdings.csv`;

const ISSUER_LABEL = 'BlackRock / iShares published holdings file';

/**
 * The endpoint is fronted by bot protection. When it fires, the response still
 * arrives as HTTP 200 with `content-type: text/csv` and a
 * `content-disposition: attachment; filename=BAI_holdings.csv` header — but the
 * body is the product web page. Trusting the headers here would hand the CSV
 * parser an HTML document; it would find no recognisable rows and could
 * plausibly yield an empty-but-successful holdings list, which is exactly the
 * silent-fabrication failure this app must not have.
 *
 * So we sniff the body itself, and treat a wall as an explicit, named failure.
 */
function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 2048).toLowerCase();
  return (
    head.includes('<!doctype html') ||
    head.includes('<html') ||
    head.includes('requires javascript')
  );
}

async function fetchHoldingsCsv(): Promise<string> {
  const res = await fetch(HOLDINGS_URL, {
    headers: {
      // A plain fetch UA is rejected outright; these mirror a normal browser
      // navigation from the product page.
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Referer: FUND.productUrl,
      Accept: 'text/csv,application/csv,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new ProviderBlockedError(
      `iShares returned HTTP ${res.status} for the holdings file.`,
    );
  }

  const body = await res.text();

  if (looksLikeHtml(body)) {
    throw new ProviderBlockedError(
      'iShares returned an HTML page (bot protection) instead of the holdings ' +
        'CSV, despite sending a text/csv content-type. No holdings were parsed. ' +
        'This endpoint generally succeeds from a residential or normal server ' +
        'IP; it is blocked from sandboxed/datacenter egress.',
    );
  }
  return body;
}

export class ProviderBlockedError extends Error {}

/**
 * The iShares CSV has a preamble of fund-level key/value lines, then a blank
 * line, then the holdings header row, then rows, then a disclaimer footer.
 * We locate the header by its known first column rather than by line number,
 * because the preamble length changes between funds and over time.
 */
export function parseHoldingsCsv(csv: string): {
  asOfDate: string;
  holdings: Holding[];
  sharesOutstanding: number | null;
} {
  const rows = parseCsv(csv);

  const asOfDate = extractAsOfDate(rows);
  const sharesOutstanding = extractSharesOutstanding(rows);

  const headerIdx = rows.findIndex(
    (r) => (r[0] ?? '').trim().toLowerCase() === 'ticker',
  );
  if (headerIdx === -1) {
    throw new Error(
      'Could not locate the holdings header row (no "Ticker" column found). ' +
        'The issuer file format may have changed.',
    );
  }

  const header = (rows[headerIdx] ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]): number => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };

  const idx = {
    ticker: col('ticker'),
    name: col('name'),
    sector: col('sector'),
    assetClass: col('asset class'),
    weight: col('weight (%)', 'weight'),
    shares: col('shares', 'quantity'),
    marketValue: col('market value', 'market value ($)'),
    country: col('location', 'country'),
    exchange: col('exchange'),
    currency: col('currency', 'market currency'),
  };

  const holdings: Holding[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const ticker = (r[idx.ticker] ?? '').trim();
    const name = (r[idx.name] ?? '').trim();
    // Footer disclaimer lines and blank separators land here; both fail this.
    if (ticker === '' || name === '') continue;

    const weight = parseNumber(r[idx.weight]);
    if (weight === null) continue;

    const assetClass = (r[idx.assetClass] ?? 'Equity').trim();
    // Cash, FX forwards and futures margin appear as rows but are not holdings
    // in the sense the attribution engine means; keep them out of contribution
    // math while still counting them toward total weight reconciliation.
    const sector = (r[idx.sector] ?? '').trim() || 'Unclassified';
    const country = (r[idx.country] ?? '').trim() || 'Unknown';
    const exchange = normalizeExchange((r[idx.exchange] ?? '').trim());

    const shares = idx.shares === -1 ? null : parseNumber(r[idx.shares]);
    const marketValue =
      idx.marketValue === -1 ? null : parseNumber(r[idx.marketValue]);

    const h: Holding = {
      ticker,
      name,
      weight,
      sector,
      country,
      exchange,
      currency: (r[idx.currency] ?? 'USD').trim() || 'USD',
      assetClass,
      subTheme: classifySubTheme(ticker, name, sector),
    };
    if (shares !== null) h.shares = shares;
    if (marketValue !== null) h.marketValue = marketValue;
    holdings.push(h);
  }

  if (holdings.length === 0) {
    throw new Error('Holdings file parsed but contained zero rows.');
  }
  return { asOfDate, holdings, sharesOutstanding };
}

/** The preamble carries `Fund Holdings as of,"Jul 24, 2026"`. */
function extractAsOfDate(rows: string[][]): string {
  for (const r of rows.slice(0, 30)) {
    const k = (r[0] ?? '').toLowerCase();
    if (k.includes('holdings as of') || k.includes('as of')) {
      const parsed = parseLooseDate(r[1] ?? '');
      if (parsed) return parsed;
    }
  }
  throw new Error(
    'Holdings file did not contain a recognisable "as of" date. Refusing to ' +
      'guess: an unknown portfolio date makes weight-change diffing unsound.',
  );
}

/**
 * The preamble also carries `Shares Outstanding,"303,440,000.00"`.
 *
 * This is what makes real NAV computable without a paid ETF feed: NAV per share
 * is the fund's total market value divided by shares outstanding, and the issuer
 * publishes both halves in this one file. Returns null rather than throwing —
 * holdings are still perfectly usable without it, so a missing line degrades
 * the NAV panel alone instead of the whole app.
 */
function extractSharesOutstanding(rows: string[][]): number | null {
  for (const r of rows.slice(0, 30)) {
    if ((r[0] ?? '').toLowerCase().includes('shares outstanding')) {
      const n = parseNumber(r[1] ?? '');
      if (n !== null && n > 0) return n;
    }
  }
  return null;
}

function parseLooseDate(s: string): string | null {
  const t = s.trim().replace(/"/g, '');
  if (t === '') return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export async function getHoldingsSnapshot(): Promise<Sourced<HoldingsSnapshot>> {
  try {
    const res = await cached('ishares-holdings-csv', config.ttl.holdings, () =>
      fetchHoldingsCsv(),
    );
    const { asOfDate, holdings, sharesOutstanding } = parseHoldingsCsv(res.value);
    const snapshot: HoldingsSnapshot = {
      asOfDate,
      holdings,
      ...(sharesOutstanding !== null ? { sharesOutstanding } : {}),
      provenance: {
        source: 'issuer.ishares',
        asOf: `${asOfDate}T21:00:00.000Z`,
        retrievedAt: new Date().toISOString(),
        reliability: res.stale ? 'stale' : 'live',
        label: ISSUER_LABEL,
        url: FUND.productUrl,
        ...(res.stale
          ? {
              note:
                `Served from cache (${Math.round(res.ageSeconds / 3600)}h old); ` +
                `the issuer endpoint failed on the last attempt.`,
            }
          : {}),
      },
    };
    return ok(snapshot, snapshot.provenance);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return missing(
      err instanceof ProviderBlockedError ? 'provider-blocked' : 'provider-error',
      detail,
      'issuer.ishares',
    );
  }
}

/**
 * Fund facts. iShares exposes these on the product page rather than in the
 * holdings CSV, and scraping them is brittle, so only the values the CSV
 * preamble genuinely carries are treated as fetched. The rest are marked
 * unavailable unless supplied — we do not hardcode an AUM that will silently
 * rot.
 */
export function fundFactsLinks(): Pick<FundFacts, 'prospectusUrl' | 'factSheetUrl'> {
  return {
    prospectusUrl: `${FUND.productUrl}#/?literatureTab=prospectus`,
    factSheetUrl: `${FUND.productUrl}#/?literatureTab=factsheet`,
  };
}

export const ISHARES_HOLDINGS_URL = HOLDINGS_URL;
