import { FUND, type TimeframeKey } from '../types';
import { config } from '../config';
import { getAttribution, getHoldingsTable, loadHoldings } from './fundService';
import { getQuote, getDailyBars } from '../providers/market';
import { windowReturnPct } from '../analytics/returns';
import { today, addDays } from '../util/dates';

/**
 * The daily brief: "what exactly happened to BAI and its stocks today",
 * composed from the same attribution engine the dashboard uses — same numbers,
 * same honesty rules (cited news or an explicit "no driver identified"; no
 * invented explanations), packaged as one readable digest.
 */

export interface DailyBrief {
  date: string;
  generatedAt: string;
  headline: string;
  fundLine: string;
  vsMarketLine: string | null;
  movers: {
    up: Array<{ line: string; newsLines: string[] }>;
    down: Array<{ line: string; newsLines: string[] }>;
  };
  themeLine: string | null;
  managerLines: string[];
  caveats: string[];
  synthetic: boolean;
}

const fmtPct = (v: number): string =>
  `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
const fmtPp = (v: number): string =>
  `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;

export async function buildDailyBrief(
  timeframe: TimeframeKey = '1D',
): Promise<DailyBrief> {
  const { getLiveToday } = await import('./liveService');
  const [attr, holdingsTable, quote, live] = await Promise.all([
    getAttribution(timeframe),
    getHoldingsTable(),
    getQuote('BAI'),
    getLiveToday(),
  ]);

  const date = today();
  const caveats: string[] = [];

  if (!attr.ok) {
    return {
      date,
      generatedAt: new Date().toISOString(),
      headline: `BAI daily brief — ${date}`,
      fundLine:
        `Attribution could not be computed: ${attr.detail} ` +
        `Nothing is shown in its place.`,
      vsMarketLine: null,
      movers: { up: [], down: [] },
      themeLine: null,
      managerLines: [],
      caveats: [],
      synthetic: config.fixtures.enabled,
    };
  }

  const a = attr.value;
  const ret = a.fundReturnPct.ok ? a.fundReturnPct.value : null;

  /* ------------------------------------------------------------- fund --- */

  let fundLine: string;
  if (ret === null) {
    fundLine = 'The fund return for the window could not be computed.';
  } else {
    const dir = ret >= 0 ? 'rose' : 'fell';
    fundLine =
      `BAI ${dir} ${Math.abs(ret).toFixed(2)}% ` +
      `(${a.timeframe.startDate} → ${a.timeframe.endDate}).` +
      (quote.ok
        ? ` Last price ${quote.value.last.toFixed(2)}, ` +
          `${fmtPct(quote.value.changePct)} on the day` +
          (quote.value.marketClosed ? ' (market closed)' : ' (delayed)') +
          '.'
        : '');
  }

  /* -------------------------------------------------------- beta line --- */

  let vsMarketLine: string | null = null;
  if (a.beta.ok && a.beta.value.reliable && ret !== null) {
    const b = a.beta.value;
    vsMarketLine =
      `${b.benchmarkSymbol} returned ${fmtPct(b.benchmarkReturnPct)} over the same ` +
      `window; at BAI's fitted beta of ${b.beta.toFixed(2)}, roughly ` +
      `${fmtPp(b.systematicPct)} of the move is the broad tech tape and ` +
      `${fmtPp(b.idiosyncraticPct)} is specific to this portfolio.`;
  }

  /* ----------------------------------------------------------- movers --- */

  const newsFor = (ticker: string): string[] => {
    const claim = a.narrative.claims.find((c) =>
      c.citations.some((x) => x.kind === 'news') && c.text.includes(`(${ticker})`),
    );
    if (!claim) return [];
    return claim.citations
      .filter((c) => c.kind === 'news')
      .map((c) => `${c.label} (${c.asOf.slice(0, 10)})${c.url ? ` — ${c.url}` : ''}`);
  };

  /*
   * Foreign holdings get the date of the move spelled out, not a footnote.
   *
   * "SK HYNIX fell 9.61%" was accurate but read as "fell 9.61% today", and for a
   * Korean listing that is a different day from the US one: KRX closes at 06:30
   * UTC, roughly 14 hours before the US close, and by the time a US reader is
   * looking at an evening dashboard Korea has already opened its *next* session.
   * Looking the stock up then shows a different number and the page looks wrong.
   * Naming the session date removes the ambiguity instead of explaining it.
   */
  /*
   * Spelled out as cause and effect rather than "fell 9.61% → −0.61% at a 6.33%
   * weight". That arrow shorthand put three numbers in a row with no stated
   * relationship between them, so the middle one read like a second,
   * contradictory price move instead of the fund-level consequence of the first.
   */
  const moverLine = (r: (typeof a.topContributors)[number]): string => {
    const dir = r.returnPct >= 0 ? 'rose' : 'fell';
    return (
      `${r.name} (${r.ticker}) ${dir} ${Math.abs(r.returnPct).toFixed(2)}%, ` +
      `and it makes up ${r.startWeight.toFixed(2)}% of the fund.` +
      (r.priceStale
        ? ` (Measured over its home market's ${r.priceAsOf.slice(0, 10)} session, ` +
          `which ended hours before the US close — a live quote may already show ` +
          `a newer day.)`
        : '')
    );
  };

  let movers = {
    up: a.topContributors.slice(0, 3).map((r) => ({
      line: moverLine(r),
      newsLines: newsFor(r.ticker),
    })),
    down: a.topDetractors.slice(0, 3).map((r) => ({
      line: moverLine(r),
      newsLines: newsFor(r.ticker),
    })),
  };

  /*
   * TODAY-FIRST WHILE THE MARKET IS OPEN.
   *
   * Until the 4pm ET close there is no daily bar for today, so the attribution
   * window necessarily ends at yesterday — but a page called "today's summary"
   * that talks about yesterday while the dashboard shows today's move reads as
   * broken, and that reading is fair. When the session is live, lead with the
   * intraday picture (same quotes and cited news the dashboard uses) and demote
   * the completed session to a clearly dated recap line.
   */
  let headline = ret === null
    ? `BAI daily brief — ${date}`
    : a.narrative.headline;

  if (live.available && live.marketOpen && live.fund) {
    const f = live.fund;
    headline =
      `BAI is ${f.changePct >= 0 ? 'up' : 'down'} ` +
      `${Math.abs(f.changePct).toFixed(2)}% so far today (${live.session.etTime}).`;
    const recap = ret === null
      ? ''
      : ` Yesterday's completed session (${a.timeframe.startDate} → ` +
        `${a.timeframe.endDate}): ${ret >= 0 ? 'up' : 'down'} ` +
        `${Math.abs(ret).toFixed(2)}%.`;
    fundLine =
      `Trading at ${f.last.toFixed(2)} (quotes ~15 min delayed; the session ` +
      `runs until 4pm ET).` + recap;

    const liveLine = (m: (typeof live.movers.up)[number]): string =>
      `${m.name} (${m.ticker}) is ${m.changePct >= 0 ? 'up' : 'down'} ` +
      `${Math.abs(m.changePct).toFixed(2)}% today, at ${m.weight.toFixed(2)}% of the fund.`;
    const liveNews = (m: (typeof live.movers.up)[number]): string[] =>
      m.news.map((n) => `${n.headline} — ${n.source}${n.url ? ` — ${n.url}` : ''}`);

    if (live.movers.up.length + live.movers.down.length > 0) {
      movers = {
        up: live.movers.up.slice(0, 3).map((m) => ({ line: liveLine(m), newsLines: liveNews(m) })),
        down: live.movers.down.slice(0, 3).map((m) => ({ line: liveLine(m), newsLines: liveNews(m) })),
      };
    }
    caveats.unshift(
      'The market is open: the movers above are today-so-far and will change ' +
        'until the 4pm ET close. Manager activity and the market-vs-fund split ' +
        'still describe the last completed session.',
    );
  }

  /* ------------------------------------------------------------ theme --- */

  let themeLine: string | null = null;
  const lead = a.bySubTheme[0];
  const lag = a.bySubTheme.at(-1);
  if (lead && lag && lead !== lag) {
    themeLine =
      `${lead.label} contributed most (${fmtPp(lead.contributionPct)}); ` +
      `${lag.label} the least (${fmtPp(lag.contributionPct)}).`;
  }

  /* -------------------------------------------------- manager activity --- */

  const managerLines: string[] = [];
  const diff = (holdingsTable as { diff?: unknown }).diff;
  if (diff && typeof diff === 'object' && 'changes' in diff) {
    const d = diff as {
      fromDate: string;
      toDate: string;
      turnoverPct: number;
      changes: Array<{
        ticker: string; name: string; kind: string; deltaPct: number;
        priorWeight: number | null; currentWeight: number | null;
      }>;
    };
    const real = d.changes.filter((c) => c.kind !== 'unchanged');

    /** "6.94% → 6.33%" is far more use than a bare "−0.61%". */
    const fromTo = (c: (typeof real)[number]): string => {
      const p = c.priorWeight;
      const n = c.currentWeight;
      if (p !== null && n !== null) return `${p.toFixed(2)}% → ${n.toFixed(2)}% of the fund`;
      if (p === null && n !== null) return `now ${n.toFixed(2)}% of the fund`;
      if (p !== null && n === null) return `was ${p.toFixed(2)}% of the fund, now gone`;
      return '';
    };

    const dayName = (iso: string): string =>
      new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      });

    if (real.length === 0) {
      managerLines.push(
        `The managers made no meaningful changes between ${dayName(d.fromDate)} ` +
          `and ${dayName(d.toDate)}.`,
      );
    } else {
      managerLines.push(
        `BlackRock publishes BAI's holdings once each trading day. Comparing ` +
          `${dayName(d.fromDate)} with ${dayName(d.toDate)} shows they reshuffled ` +
          `${d.turnoverPct.toFixed(2)}% of the fund:`,
      );
      for (const c of real.slice(0, 8)) {
        const verb =
          c.kind === 'added' ? 'bought — a brand new position,' :
          c.kind === 'removed' ? 'sold off completely,' :
          c.kind === 'increased' ? 'bought more,' : 'sold some,';
        managerLines.push(
          `  • ${c.name} (${c.ticker}): ${verb} ${fromTo(c)} (${fmtPp(c.deltaPct)})`,
        );
      }
    }
  } else {
    managerLines.push(
      "We can only see what the managers changed by comparing two days' " +
        'holdings lists, and BlackRock only publishes the current one — so this ' +
        'app saves a copy each day and compares them. There is not a second day ' +
        'saved yet; this fills in on its own.',
    );
  }

  /* ---------------------------------------------------------- caveats --- */

  caveats.push(...a.narrative.caveats);
  if (a.narrative.noClearDriver) {
    caveats.unshift(
      'No news was found for the largest movers — the ranking shows what ' +
        'moved, not why. Unexplained here does not mean unexplainable.',
    );
  }

  return {
    date,
    generatedAt: new Date().toISOString(),
    headline,
    fundLine,
    vsMarketLine,
    movers,
    themeLine,
    managerLines,
    caveats,
    synthetic: config.fixtures.enabled,
  };
}

/** Render the brief as markdown — for the CLI, the saved file, and email-ish use. */
export function briefToMarkdown(b: DailyBrief): string {
  const lines: string[] = [];
  lines.push(`# BAI daily brief — ${b.date}`);
  if (b.synthetic) {
    lines.push('');
    lines.push('> **SYNTHETIC DATA — this brief describes generated demo data, not the real fund.**');
  }
  lines.push('');
  lines.push(`**${b.headline}**`);
  lines.push('');
  lines.push(b.fundLine);
  if (b.vsMarketLine) {
    lines.push('');
    lines.push(b.vsMarketLine);
  }
  if (b.themeLine) {
    lines.push('');
    lines.push(b.themeLine);
  }

  if (b.movers.up.length > 0) {
    lines.push('');
    lines.push('## What pulled it up');
    for (const m of b.movers.up) {
      lines.push(`- ${m.line}`);
      for (const n of m.newsLines) lines.push(`    - ${n}`);
    }
  }
  if (b.movers.down.length > 0) {
    lines.push('');
    lines.push('## What dragged it down');
    for (const m of b.movers.down) {
      lines.push(`- ${m.line}`);
      for (const n of m.newsLines) lines.push(`    - ${n}`);
    }
  }

  lines.push('');
  lines.push('## Manager activity');
  for (const l of b.managerLines) lines.push(l.startsWith('  •') ? `- ${l.slice(4)}` : l);

  if (b.caveats.length > 0) {
    lines.push('');
    lines.push('## Data caveats');
    for (const c of b.caveats) lines.push(`- ${c}`);
  }

  lines.push('');
  lines.push('---');
  lines.push(
    `*Generated ${b.generatedAt}. Educational only — not investment advice. ` +
      `Past performance does not predict future results.*`,
  );
  return lines.join('\n');
}

/** Ensure history keeps accruing even if the brief runs before the dashboard. */
export async function archiveToday(): Promise<string> {
  const h = await loadHoldings();
  if (!h.ok) return `holdings archive failed: ${h.detail}`;
  return `holdings archived for ${h.value.asOfDate}`;
}

export function priorTradingContext(): { yesterday: string } {
  return { yesterday: addDays(today(), -1) };
}

export { getDailyBars, windowReturnPct, FUND };
