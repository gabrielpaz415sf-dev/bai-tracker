import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config';

/**
 * Persistent per-provider request budget.
 *
 * Free data tiers cap requests, and a cold attribution load wants roughly one
 * request per holding — around 55 — so the naive version trips the cap and
 * every subsequent call fails until the window rolls over. That failure mode is
 * especially bad here because it is silent-ish: the app correctly reports the
 * data as unavailable, but the *user* just sees a dashboard that quietly
 * stopped covering part of the fund.
 *
 * So spend is tracked across process restarts (the budget is the vendor's, not
 * this process's) and refused locally once gone, with an error saying when it
 * resets. Callers surface that as a normal `missing` value, so the dashboard
 * degrades to partial coverage and fills back in, rather than breaking.
 *
 * **Windows differ per vendor and this matters.** Tiingo meters per hour;
 * EODHD and Marketaux meter per *day*. Modelling a daily cap as an hourly one
 * silently authorises 24× the real allowance — for EODHD that means burning the
 * day's quota by mid-morning and losing SK hynix, the fund's largest holding,
 * out of every attribution for the rest of the day.
 */

interface Ledger {
  /** Epoch ms of the start of the current window. */
  windowStart: number;
  count: number;
}

const LEDGER = path.join(DATA_DIR, 'rate-ledger.json');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Quota {
  limit: number;
  windowMs: number;
  /** Shown in the exhaustion message. */
  windowLabel: string;
}

/**
 * Headroom is left below each published cap for retries and the quote batch.
 * Figures are the documented free tiers as of 2026-07.
 */
const QUOTAS: Record<string, Quota> = {
  // ~50/hour published.
  tiingo: { limit: 45, windowMs: HOUR_MS, windowLabel: 'hour' },
  // ~20/day published — NOT hourly. The fund holds 11 foreign equities, so a
  // full cold refresh is ~12 calls; the 24h bar TTL keeps that to once a day.
  eodhd: { limit: 18, windowMs: DAY_MS, windowLabel: 'day' },
  // ~100/day published.
  marketaux: { limit: 90, windowMs: DAY_MS, windowLabel: 'day' },
  // ~25/day published.
  alphavantage: { limit: 20, windowMs: DAY_MS, windowLabel: 'day' },
  // 5/minute published; kept low since it is a fallback of last resort.
  polygon: { limit: 4, windowMs: HOUR_MS, windowLabel: 'hour' },
};

/**
 * Start of the current window on the clock. Vendors reset quotas on the clock,
 * not on a window floating from your first request — anchoring to the clock
 * keeps the local budget resetting at the same moment theirs does. A floating
 * window drifts later than the vendor's and becomes the binding constraint,
 * throttling us when the vendor would have allowed the request.
 */
function windowStartFor(windowMs: number): number {
  return Math.floor(Date.now() / windowMs) * windowMs;
}

function readAll(): Record<string, Ledger> {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, 'utf8')) as Record<string, Ledger>;
  } catch {
    return {};
  }
}

function read(id: string, windowMs: number): Ledger {
  const windowStart = windowStartFor(windowMs);
  const l = readAll()[id];
  if (l && l.windowStart === windowStart) return l;
  return { windowStart, count: 0 };
}

function write(id: string, l: Ledger): void {
  const all = readAll();
  all[id] = l;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify(all), 'utf8');
  } catch {
    /* the ledger is an optimisation; never fail a request over it */
  }
}

export class BudgetExhaustedError extends Error {}

/** Consume one unit of budget, or throw with the reset time. */
export function spend(id: string): void {
  const q = QUOTAS[id];
  if (q === undefined) return;

  const l = read(id, q.windowMs);
  if (l.count >= q.limit) {
    const resetsInMin = Math.ceil((l.windowStart + q.windowMs - Date.now()) / 60000);
    const when =
      resetsInMin > 90 ? `~${Math.round(resetsInMin / 60)}h` : `~${resetsInMin} min`;
    throw new BudgetExhaustedError(
      `Local request budget for ${id} is spent (${q.limit}/${q.windowLabel} on ` +
        `the free tier). Resets in ${when}. Cached data is still served; ` +
        `uncached values show as unavailable rather than being estimated.`,
    );
  }
  write(id, { windowStart: l.windowStart, count: l.count + 1 });
}

export function budgetStatus(): Array<{
  id: string;
  used: number;
  budget: number;
  window: string;
  resetsInMin: number;
}> {
  return Object.entries(QUOTAS).map(([id, q]) => {
    const l = read(id, q.windowMs);
    return {
      id,
      used: l.count,
      budget: q.limit,
      window: q.windowLabel,
      resetsInMin: Math.max(0, Math.ceil((l.windowStart + q.windowMs - Date.now()) / 60000)),
    };
  });
}
