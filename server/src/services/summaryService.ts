import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { cached, writeCache } from '../cache/diskCache';
import { sessionState, lastCompletedTradingDate } from '../domain/session';
import { getLiveToday, type LiveToday } from './liveService';

/**
 * DAILY AI SUMMARY
 *
 * The mover lists used to carry per-stock headline lists, which pushed the
 * reading work onto the reader. This service replaces them: the numbers and
 * headlines the live view already gathered are compacted into a fact sheet,
 * and Claude writes the two short paragraphs a person would actually want.
 *
 * Honesty rules carried over from the old narrative engine, now enforced in
 * the prompt instead of in templates: only the supplied facts may be used,
 * headlines are coincident rather than proven causes, and no advice or
 * predictions ever.
 *
 * Freshness: every snapshot publish regenerates the text (`force`), so the
 * words on the page always describe the numbers beside them — text describing
 * an earlier refresh's numbers is the site's cardinal sin. The date+bucket
 * cache only serves the local Express server between publishes, and a new day
 * gets a fresh key either way, so yesterday's text can never leak onto
 * today's page.
 */

export interface DailySummary {
  available: boolean;
  reason: string | null;
  /** Plain-text prose; paragraphs separated by blank lines. */
  text: string | null;
  generatedAt: string | null;
  /** The ET trading date the summary describes. */
  forDate: string;
  session: 'during-market' | 'after-close';
  model: string | null;
}

/** What the model is allowed to know. Compact, deterministic, numbers pre-rounded. */
export interface SummaryFacts {
  fund: { last: number; changePct: number } | null;
  sessionLabel: string;
  etDate: string;
  coveragePct: number;
  helping: FactMover[];
  hurting: FactMover[];
  asia: Array<{ ticker: string; name: string; changePct: number; weightPct: number; sessionDate: string | null }>;
}

interface FactMover {
  ticker: string;
  name: string;
  changePct: number;
  weightPct: number;
  headlines: Array<{ headline: string; source: string; publishedAt: string }>;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function summaryFacts(live: LiveToday): SummaryFacts {
  const mover = (m: LiveToday['movers']['up'][number]): FactMover => ({
    ticker: m.ticker,
    name: m.name,
    changePct: round1(m.changePct),
    weightPct: round1(m.weight),
    headlines: m.news.slice(0, 2).map((n) => ({
      headline: n.headline,
      source: n.source,
      publishedAt: n.publishedAt,
    })),
  });

  return {
    fund: live.fund
      ? { last: Math.round(live.fund.last * 100) / 100, changePct: round1(live.fund.changePct) }
      : null,
    sessionLabel: live.session.label,
    etDate: sessionState().etDate,
    coveragePct: round1(live.coveragePct),
    helping: live.movers.up.slice(0, 5).map(mover),
    hurting: live.movers.down.slice(0, 5).map(mover),
    asia: live.closedMarkets
      .filter((h) => h.changePct !== null)
      .map((h) => ({
        ticker: h.ticker,
        name: h.name,
        changePct: round1(h.changePct ?? 0),
        weightPct: round1(h.weight),
        sessionDate: h.asOf,
      })),
  };
}

export const SUMMARY_SYSTEM = `You write the daily summary for a small dashboard tracking BAI, \
the iShares A.I. Innovation and Tech Active ETF. Your reader is smart but not a finance person.

Rules:
- Two short paragraphs of plain prose, at most ~110 words total. No headings, \
bullets, emojis, or markdown.
- Paragraph 1: what BAI did and WHY — name the stocks that drove the move and \
their day moves, and when a supplied headline plainly explains one of them, \
fold that reason in ("after news that ..."). The reader's one question is \
"why is it up/down today"; answer it in the first sentence when the facts allow.
- Paragraph 2: the most interesting remaining thing — an Asian holding's move, \
a notable headline, or a pattern across the movers. If nothing else is \
interesting, keep it to one sentence.
- Plain English a college freshman gets. Never use jargon like "basis points", \
"alpha", "beta", "risk-on", "tape", or "premium/discount". Company names over \
tickers on first mention.
- Use only the facts provided. Headlines were published near the move but are \
not proven causes: say "after news that ..." only when a headline plainly \
concerns that company's move; otherwise just report the move.
- Never give advice, predictions, price targets, or "what to watch". Never \
address the reader with "you should".
- Percentages with a % sign and one decimal, as given.`;

export function buildSummaryPrompt(facts: SummaryFacts): string {
  return (
    `Write today's summary from this fact sheet (JSON). ` +
    `"helping"/"hurting" are today's biggest US-listed movers in the fund with their ` +
    `day moves and their share of the fund; "asia" holdings finished their home ` +
    `sessions before the US market opened.\n\n` +
    JSON.stringify(facts, null, 2)
  );
}

type Generate = (system: string, prompt: string) => Promise<{ text: string; model: string }>;

/**
 * One non-streaming call. Thinking is on by default on this model and counts
 * against max_tokens, so the cap is far above the ~110-word output.
 * A refusal fallback is configured server-side so a classifier false-positive
 * degrades to Opus 4.8 instead of an empty summary.
 */
const generateWithClaude: Generate = async (system, prompt) => {
  const client = new Anthropic({ apiKey: config.providers.anthropic });
  const response = await client.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-06-01'],
    fallbacks: [{ model: 'claude-opus-4-8' }],
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('The summary model declined this request.');
  }
  const text = response.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('The summary model returned no text.');
  return { text, model: response.model };
};

export async function getDailySummary(opts?: {
  live?: LiveToday;
  generate?: Generate;
  apiKey?: string | null;
  /** Regenerate even when a cached copy exists — used by every snapshot publish. */
  force?: boolean;
}): Promise<DailySummary> {
  const session = sessionState();
  const bucket: DailySummary['session'] = session.open ? 'during-market' : 'after-close';
  const forDate = session.open ? session.etDate : lastCompletedTradingDate();

  const unavailable = (reason: string): DailySummary => ({
    available: false,
    reason,
    text: null,
    generatedAt: null,
    forDate,
    session: bucket,
    model: null,
  });

  const apiKey = opts?.apiKey !== undefined ? opts.apiKey : (config.providers.anthropic ?? null);
  if (!apiKey) {
    return unavailable(
      'No ANTHROPIC_API_KEY is configured, so the written summary is off. ' +
        'Every number on the page is unaffected.',
    );
  }

  const live = opts?.live ?? (await getLiveToday());
  if (!live.available || !live.fund) {
    return unavailable(`No live data to summarize: ${live.reason ?? 'fund quote unavailable'}.`);
  }

  const generate = opts?.generate ?? generateWithClaude;
  const facts = summaryFacts(live);

  const build = async (): Promise<DailySummary> => {
    const { text, model } = await generate(SUMMARY_SYSTEM, buildSummaryPrompt(facts));
    return {
      available: true,
      reason: null,
      text,
      generatedAt: new Date().toISOString(),
      forDate,
      session: bucket,
      model,
    };
  };

  // An injected generator means a test is running: stay deterministic and off
  // the shared on-disk cache.
  if (opts?.generate) return build();

  const key = `summary_${forDate}_${bucket}`;
  try {
    if (opts?.force) {
      const fresh = await build();
      await writeCache(key, fresh, config.ttl.summary);
      return fresh;
    }
    const { value } = await cached(key, config.ttl.summary, build);
    return value;
  } catch (err) {
    // The page must never lose its numbers because the writer had a bad day.
    return unavailable(`Summary generation failed: ${(err as Error).message}`);
  }
}
