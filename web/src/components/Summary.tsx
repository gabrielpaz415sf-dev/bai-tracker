import { useEffect, useState } from 'react';
import { get } from '../api';
import { Panel } from './Common';

/**
 * The AI-written daily summary — the "why" of the Today section, in two short
 * paragraphs instead of a pile of headline links. Written fresh for each
 * trading day (mid-session, then again after the close) by the snapshot job.
 *
 * When it is unavailable (no key configured, model error) the card disappears
 * entirely rather than showing an apology box: the numbers below carry the
 * page on their own.
 */

interface DailySummary {
  available: boolean;
  reason: string | null;
  text: string | null;
  generatedAt: string | null;
  forDate: string;
  session: 'during-market' | 'after-close';
  model: string | null;
}

export function DailySummaryCard() {
  const [summary, setSummary] = useState<DailySummary | null>(null);

  useEffect(() => {
    get<{ summary: DailySummary }>('/summary')
      .then((d) => setSummary(d.summary))
      .catch(() => setSummary(null));
  }, []);

  if (!summary?.available || !summary.text) return null;

  const when =
    summary.session === 'during-market' ? 'written mid-session' : 'written after the close';

  return (
    <Panel
      title="What happened, in plain English"
      right={
        <span className="dimmer" style={{ fontWeight: 400, textTransform: 'none' }}>
          AI-written · {when} · {summary.forDate}
        </span>
      }
    >
      {summary.text.split(/\n\s*\n/).map((p, i) => (
        <p key={i} style={{ margin: i === 0 ? '0 0 8px' : 0, fontSize: 13.5, lineHeight: 1.65 }}>
          {p}
        </p>
      ))}
      <div className="dimmer" style={{ fontSize: 10.5, marginTop: 8 }}>
        Auto-written from the numbers and headlines this page collects, and reset each trading
        day. It can be wrong about "why" — the numbers below are the ground truth.
      </div>
    </Panel>
  );
}
