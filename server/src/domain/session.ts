/**
 * US equity session state, computed from the clock rather than inferred from a
 * vendor field.
 *
 * The previous approach read "is the market open?" off whether Tiingo's IEX
 * `last` was null. That field goes null whenever the IEX feed specifically has
 * no recent print — which happens mid-session for thinly-traded names, and did
 * happen for BAI at 14:01 ET on a normal Tuesday. The result was a dashboard
 * labelling an open market "closed" while simultaneously showing live intraday
 * moves, which is worse than showing nothing: it tells the user a fact about
 * the world that is false.
 *
 * Vendor liquidity is not a clock. So we use the clock.
 */

/** Regular session, 09:30–16:00 America/New_York. */
const OPEN_MINUTES = 9 * 60 + 30;
const CLOSE_MINUTES = 16 * 60;

/**
 * Full-day NYSE closures. Half-days (1pm close) are deliberately NOT modelled:
 * treating a half-day as a full session mislabels only the 13:00–16:00 window,
 * and does so in the safe direction — the app says "open" and shows quotes that
 * simply stop updating, rather than claiming a closure that isn't real. Add
 * dates here as the calendar is published.
 */
const HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);

export interface SessionState {
  open: boolean;
  /** 'pre' | 'regular' | 'post' | 'weekend' | 'holiday' */
  phase: 'pre' | 'regular' | 'post' | 'weekend' | 'holiday';
  etDate: string;
  etTime: string;
  label: string;
}

function etParts(now: Date): { date: string; minutes: number; weekday: number } {
  // en-CA gives YYYY-MM-DD; the ET offset is handled by the timeZone option, so
  // this stays correct across DST without hardcoding an offset.
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);

  const hm = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const [h = '0', m = '0'] = hm.split(':');

  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(now);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);

  return { date, minutes: Number(h) * 60 + Number(m), weekday };
}

/**
 * The most recent trading date whose close has already happened.
 *
 * This is the concept a wall-clock cache TTL cannot express, and its absence
 * caused the site's worst data bug: a daily-bar series fetched mid-session is
 * missing that session's bar, and a 6-hour TTL then kept serving it for six more
 * hours *after* the close — so the daily brief described 07-27→07-28 while the
 * live panel correctly showed 07-29. Freshness for end-of-day data is a question
 * about the market calendar, not about elapsed wall time.
 *
 * Walks back day by day (never more than ~5 iterations in practice) skipping
 * weekends and holidays. Today counts only once 16:00 ET has passed.
 */
export function lastCompletedTradingDate(now: Date = new Date()): string {
  const { minutes } = etParts(now);
  // Start from today if the close has passed, otherwise from yesterday.
  let cursor = new Date(now.getTime());
  if (minutes < CLOSE_MINUTES) cursor = new Date(cursor.getTime() - 24 * 3600 * 1000);

  for (let i = 0; i < 10; i++) {
    const p = etParts(cursor);
    const isWeekend = p.weekday === 0 || p.weekday === 6;
    if (!isWeekend && !HOLIDAYS_2026.has(p.date)) return p.date;
    cursor = new Date(cursor.getTime() - 24 * 3600 * 1000);
  }
  // Ten consecutive non-trading days cannot happen; fall back rather than throw.
  return etParts(cursor).date;
}

export function sessionState(now: Date = new Date()): SessionState {
  const { date, minutes, weekday } = etParts(now);
  const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ET`;

  const base = { etDate: date, etTime: time };

  if (weekday === 0 || weekday === 6) {
    return { ...base, open: false, phase: 'weekend', label: 'Weekend — market closed' };
  }
  if (HOLIDAYS_2026.has(date)) {
    return { ...base, open: false, phase: 'holiday', label: 'Market holiday' };
  }
  if (minutes < OPEN_MINUTES) {
    return { ...base, open: false, phase: 'pre', label: `Pre-market — opens 09:30 ET` };
  }
  if (minutes >= CLOSE_MINUTES) {
    return { ...base, open: false, phase: 'post', label: `After hours — closed 16:00 ET` };
  }
  return { ...base, open: true, phase: 'regular', label: `US session open (${time})` };
}
