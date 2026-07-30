import { FUND, type TimeframeKey, type Timeframe } from '../types';

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

export function addMonths(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const targetMonth = d.getUTCMonth() + n;
  d.setUTCMonth(targetMonth);
  return isoDate(d);
}

export function daysBetween(a: string, b: string): number {
  const ms =
    new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

export const TIMEFRAME_LABELS: Record<TimeframeKey, string> = {
  '1D': '1 Day',
  '1W': '1 Week',
  '1M': '1 Month',
  '3M': '3 Months',
  YTD: 'Year to Date',
  '1Y': '1 Year',
  SI: 'Since Inception',
};

/**
 * Resolve a timeframe key to a concrete date window, clipped to fund
 * inception. Clipping is reported rather than silently applied: asking for
 * "1Y" eight months after launch must not return something labelled as a
 * full year.
 */
export function resolveTimeframe(
  key: TimeframeKey,
  endDate: string,
  availableDates: string[],
): Timeframe {
  let start: string;
  switch (key) {
    case '1D':
      start = addDays(endDate, -1);
      break;
    case '1W':
      start = addDays(endDate, -7);
      break;
    case '1M':
      start = addMonths(endDate, -1);
      break;
    case '3M':
      start = addMonths(endDate, -3);
      break;
    case 'YTD':
      start = `${endDate.slice(0, 4)}-01-01`;
      break;
    case '1Y':
      start = addMonths(endDate, -12);
      break;
    case 'SI':
      start = FUND.inceptionDate;
      break;
  }

  const clipped = start < FUND.inceptionDate;
  if (clipped) start = FUND.inceptionDate;

  const inWindow = availableDates.filter((d) => d >= start && d <= endDate);

  return {
    key,
    label: TIMEFRAME_LABELS[key],
    startDate: start,
    endDate,
    tradingDays: Math.max(0, inWindow.length - 1),
    clippedToInception: clipped,
  };
}

/**
 * Index of the last bar at or before `date`. Returns -1 when the series starts
 * after the date. Assumes ascending order.
 */
export function indexAtOrBefore(dates: string[], date: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = dates[mid];
    if (v !== undefined && v <= date) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
