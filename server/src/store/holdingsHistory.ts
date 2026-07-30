import fs from 'node:fs/promises';
import path from 'node:path';
import { SNAPSHOT_DIR } from '../config';
import type { HoldingsSnapshot, HoldingsDiff, WeightChange, Holding } from '../types';
import { derive } from '../util/provenance';
import { equityHoldings } from '../analytics/concentration';

/**
 * Append-only archive of published holdings files, one per issuer portfolio
 * date.
 *
 * This exists because the issuer only ever serves *today's* file. Manager
 * activity — what was bought, sold, trimmed or added — is only observable as
 * the difference between two published dates, so unless we keep our own
 * history, that signal is permanently lost. The archive is keyed by the
 * issuer's stated `asOfDate`, never by our fetch date, so re-fetching the same
 * file twice is idempotent.
 */

function fileFor(date: string): string {
  return path.join(SNAPSHOT_DIR, `holdings-${date}.json`);
}

export async function saveSnapshot(snap: HoldingsSnapshot): Promise<boolean> {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  const file = fileFor(snap.asOfDate);
  try {
    await fs.access(file);
    return false; // Already archived; do not overwrite history.
  } catch {
    await fs.writeFile(file, JSON.stringify(snap, null, 2), 'utf8');
    return true;
  }
}

export async function listSnapshotDates(): Promise<string[]> {
  try {
    const files = await fs.readdir(SNAPSHOT_DIR);
    return files
      .filter((f) => f.startsWith('holdings-') && f.endsWith('.json'))
      .map((f) => f.slice('holdings-'.length, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

export async function loadSnapshot(date: string): Promise<HoldingsSnapshot | null> {
  try {
    return JSON.parse(await fs.readFile(fileFor(date), 'utf8')) as HoldingsSnapshot;
  } catch {
    return null;
  }
}

/** Most recent archived snapshot at or before `date`. */
export async function snapshotAtOrBefore(
  date: string,
): Promise<HoldingsSnapshot | null> {
  const dates = await listSnapshotDates();
  const candidates = dates.filter((d) => d <= date);
  const pick = candidates.at(-1);
  return pick ? loadSnapshot(pick) : null;
}

/** Weight movement below this is rounding in the issuer file, not a decision. */
const NOISE_THRESHOLD_PP = 0.02;

export function diffSnapshots(
  prior: HoldingsSnapshot,
  current: HoldingsSnapshot,
): HoldingsDiff {
  const priorMap = new Map(
    equityHoldings(prior.holdings).map((h) => [h.ticker, h]),
  );
  const currentMap = new Map(
    equityHoldings(current.holdings).map((h) => [h.ticker, h]),
  );

  const changes: WeightChange[] = [];
  const seen = new Set<string>();

  for (const [ticker, cur] of currentMap) {
    seen.add(ticker);
    const before = priorMap.get(ticker);
    if (!before) {
      changes.push(change(cur, null, cur.weight, 'added', cur.weight));
      continue;
    }
    const delta = cur.weight - before.weight;
    const kind =
      Math.abs(delta) < NOISE_THRESHOLD_PP
        ? 'unchanged'
        : delta > 0
          ? 'increased'
          : 'decreased';
    changes.push(change(cur, before.weight, cur.weight, kind, delta));
  }

  for (const [ticker, before] of priorMap) {
    if (seen.has(ticker)) continue;
    changes.push(change(before, before.weight, null, 'removed', -before.weight));
  }

  // One-way turnover: half the sum of absolute weight moves. Halved because a
  // switch out of one name into another shows up twice (a sale and a buy) but
  // represents a single round of trading.
  const turnover =
    changes.reduce((a, c) => a + Math.abs(c.deltaPct), 0) / 2;

  return {
    fromDate: prior.asOfDate,
    toDate: current.asOfDate,
    changes: changes.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct)),
    turnoverPct: turnover,
    provenance: derive(
      [prior.provenance, current.provenance],
      `Weight changes between issuer files ${prior.asOfDate} → ${current.asOfDate}`,
    ),
  };
}

function change(
  h: Holding,
  priorWeight: number | null,
  currentWeight: number | null,
  kind: WeightChange['kind'],
  deltaPct: number,
): WeightChange {
  return {
    ticker: h.ticker,
    name: h.name,
    kind,
    priorWeight,
    currentWeight,
    deltaPct,
    subTheme: h.subTheme,
    sector: h.sector,
  };
}
