/**
 * PRE-PUBLISH CONSISTENCY GATE — `npm run check:snapshot`.
 *
 * Runs in CI between `npm run snapshot` and the static build. The site's
 * cardinal rule is that numbers agree across the page; this gate makes a
 * contradictory build unpublishable rather than merely regrettable.
 *
 * Severity follows the deploy policy already encoded in deploy.yml:
 *
 *  - FAIL (exit 1, the site keeps its last good version) is reserved for
 *    internal contradictions — states no amount of provider throttling can
 *    legitimately produce, which therefore mean the build itself is wrong.
 *  - WARN is labeled degradation (live view down, summary off). Those ship:
 *    stale-but-labeled beats nothing, and the page says so on its face.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionState, lastCompletedTradingDate } from '../domain/session';

/** Files the one-page site actually fetches; absence of any is a broken page. */
const REQUIRED = ['live', 'overview', 'holdings', 'series-3M', 'summary', 'health'] as const;

export interface CheckResult {
  failures: string[];
  warnings: string[];
}

/* Loosely-typed views of the snapshot payloads: the checker validates real
 * files at the trust boundary, so it must not assume the shapes it is there
 * to verify. */
interface Dict { [k: string]: unknown }
const dict = (v: unknown): Dict => (typeof v === 'object' && v !== null ? (v as Dict) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function checkSnapshot(files: Record<string, unknown>, now: Date): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const name of REQUIRED) {
    if (files[name] === undefined) failures.push(`${name}.json is missing`);
  }
  if (failures.length > 0) return { failures, warnings }; // nothing else is meaningful

  for (const name of REQUIRED) {
    if (dict(files[name]).__synthetic === true) {
      failures.push(`${name}.json is synthetic fixture data — must never be published`);
    }
  }

  const session = sessionState(now);
  const lastClose = lastCompletedTradingDate(now);
  const tradingDate = session.open ? session.etDate : lastClose;

  /* ------------------------------------------------------------ holdings */

  const holdings = dict(files['holdings']);
  const holdingRows = arr(holdings.holdings).map(dict);
  const equities = holdingRows.filter((h) => h.assetClass === 'Equity');
  const tickers = new Set(holdingRows.map((h) => String(h.ticker).toUpperCase()));

  if (equities.length < 30) {
    failures.push(
      `holdings.json has ${equities.length} equity rows — a fund of ~45 stocks ` +
        `cannot have this few; the issuer file is truncated or misparsed`,
    );
  }
  const asOfDate = String(holdings.asOfDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    failures.push(`holdings.json asOfDate "${asOfDate}" is not a date`);
  } else if (weekdaysBetween(asOfDate, lastClose) > 3) {
    failures.push(
      `holdings.json is dated ${asOfDate}, more than 3 business days before ` +
        `${lastClose} — the issuer publishes daily, so the fetch pipeline is broken`,
    );
  }

  /* ------------------------------------------------------------- series */

  const series = dict(files['series-3M']);
  const bars = arr(series.bars).map(dict);
  const lastBar = bars.at(-1);
  if (!lastBar) {
    failures.push('series-3M.json has no bars');
  } else if (String(lastBar.date) !== lastClose) {
    failures.push(
      `series-3M.json ends at ${String(lastBar.date)} but the last completed ` +
        `trading day is ${lastClose} — the chart and returns describe the wrong day`,
    );
  }

  /* -------------------------------------------------------------- live */

  const live = dict(dict(files['live']).live);
  if (live.available !== true) {
    warnings.push(`live view unavailable (labeled): ${String(live.reason ?? 'no reason given')}`);
  } else {
    const movers = dict(live.movers);
    const named = [
      ...arr(movers.up).map(dict),
      ...arr(movers.down).map(dict),
      ...arr(live.closedMarkets).map(dict),
    ];
    for (const m of named) {
      const t = String(m.ticker).toUpperCase();
      if (!tickers.has(t)) {
        failures.push(
          `live.json shows mover ${t} that holdings.json does not contain — ` +
            `the two files were built from different holdings`,
        );
      }
    }
  }

  /* ------------------------------------------------------------ overview */

  const overview = dict(files['overview']);
  const returns = arr(overview.returns).map(dict);
  if (returns.length === 0) {
    failures.push('overview.json has no returns rows');
  } else {
    const broken = returns.filter((r) => dict(r.marketReturnPct).ok !== true);
    if (broken.length > 0) {
      warnings.push(
        `${broken.length}/${returns.length} return figures unavailable (labeled degradation)`,
      );
    }
  }

  /* ------------------------------------------------------------- summary */

  const summary = dict(dict(files['summary']).summary);
  if (summary.available !== true) {
    warnings.push(`AI overview unavailable (labeled): ${String(summary.reason ?? '')}`);
  } else {
    if (String(summary.forDate) !== tradingDate) {
      failures.push(
        `summary.json is for ${String(summary.forDate)} but this build describes ` +
          `${tradingDate} — the overview text would contradict the numbers beside it`,
      );
    }
    const generatedAt = new Date(String(summary.generatedAt ?? ''));
    const ageMin = (now.getTime() - generatedAt.getTime()) / 60000;
    if (!Number.isFinite(ageMin) || ageMin < 0 || ageMin > 30) {
      failures.push(
        `summary.json was generated ${Number.isFinite(ageMin) ? `${Math.round(ageMin)} min` : 'at an unreadable time'} ` +
          `before this check — snapshot forces regeneration, so a stale text means the force path broke`,
      );
    }
  }

  return { failures, warnings };
}

/** Whole weekdays strictly between two ISO dates (a <= b). Holidays are not
 *  subtracted — the 3-day allowance already absorbs them. */
export function weekdaysBetween(a: string, b: string): number {
  const from = new Date(`${a}T12:00:00Z`);
  const to = new Date(`${b}T12:00:00Z`);
  let n = 0;
  for (let d = new Date(from); d < to; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, '../../../web/public/api');

  const files: Record<string, unknown> = {};
  for (const name of REQUIRED) {
    try {
      files[name] = JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), 'utf8'));
    } catch {
      /* leave undefined — reported as missing */
    }
  }

  const { failures, warnings } = checkSnapshot(files, new Date());
  for (const w of warnings) console.log(`  WARN  ${w}`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  if (failures.length > 0) {
    console.error(
      `[check-snapshot] ${failures.length} contradiction(s) — refusing to publish. ` +
        'The deployed site keeps its previous version.',
    );
    process.exitCode = 1;
  } else {
    console.log(`[check-snapshot] consistent (${warnings.length} labeled degradation(s))`);
  }
}

// Import-safe: tests import the pure functions without triggering a run.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('[check-snapshot] fatal:', err);
    process.exitCode = 1;
  });
}
