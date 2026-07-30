import { useEffect, useState } from 'react';
import { get } from '../api';
import { Missing, Panel } from './Common';

interface Mover { line: string; newsLines: string[] }

interface BriefData {
  date: string;
  generatedAt: string;
  headline: string;
  fundLine: string;
  vsMarketLine: string | null;
  movers: { up: Mover[]; down: Mover[] };
  themeLine: string | null;
  managerLines: string[];
  caveats: string[];
  synthetic: boolean;
}

function MoverList({ items, empty }: { items: Mover[]; empty: string }) {
  if (items.length === 0) {
    return <div className="dimmer" style={{ fontSize: 12 }}>{empty}</div>;
  }
  return (
    <>
      {items.map((m, i) => (
        <div className="claim" key={i}>
          <div className="text">{m.line}</div>
          {m.newsLines.length > 0 ? (
            <div className="cites">
              {m.newsLines.map((n, j) => (
                <div className="cite" key={j}>
                  <span className="kind">news</span>
                  {n}
                </div>
              ))}
            </div>
          ) : (
            // The `kind` chip and the sentence used to both say "no news",
            // rendering as "no newsno article found…" with no space between.
            <div className="cite" style={{ marginTop: 4 }}>
              <span className="kind">why</span>
              no news story found for this one
            </div>
          )}
        </div>
      ))}
    </>
  );
}

export function BriefPanel() {
  const [data, setData] = useState<{ brief: BriefData; markdown: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    get<{ brief: BriefData; markdown: string }>('/brief?timeframe=1D')
      .then(setData)
      .catch((e: Error) => setErr(e.message));
  }, []);

  if (err) return <Missing of={{ reason: 'provider-error', detail: err }} />;
  if (!data) return <div className="spinner">Building today's brief…</div>;

  const b = data.brief;

  return (
    <>
      <section>
        <h2>Daily brief — {b.date}</h2>
        <Panel
          title="What happened"
          right={
            <button
              className="tf-btn"
              onClick={() => {
                void navigator.clipboard.writeText(data.markdown);
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              }}
            >
              {copied ? 'copied ✓' : 'copy markdown'}
            </button>
          }
        >
          <div className="narrative">
            <div className="headline">{b.headline}</div>
            <div className="claim"><div className="text">{b.fundLine}</div></div>
            {b.vsMarketLine && <div className="claim"><div className="text">{b.vsMarketLine}</div></div>}
            {b.themeLine && <div className="claim"><div className="text">{b.themeLine}</div></div>}
          </div>
        </Panel>
      </section>

      <section>
        <h2>Which stocks did it</h2>
        <div className="grid cols-2">
          <Panel title="Pulled it up">
            <MoverList items={b.movers.up} empty="Nothing contributed positively." />
          </Panel>
          <Panel title="Dragged it down">
            <MoverList items={b.movers.down} empty="Nothing detracted." />
          </Panel>
        </div>
      </section>

      <section>
        <h2>Manager activity</h2>
        <Panel>
          {b.managerLines.map((l, i) => (
            <div
              key={i}
              style={{
                fontSize: 12.5,
                paddingLeft: l.startsWith('  •') ? 14 : 0,
                marginBottom: 4,
                fontFamily: l.startsWith('  •') ? 'var(--mono)' : undefined,
              }}
            >
              {l.trim()}
            </div>
          ))}
        </Panel>
      </section>

      {b.caveats.length > 0 && (
        <section>
          <h2>Data caveats</h2>
          <Panel>
            <div className="caveats" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {b.caveats.map((c, i) => (
                <div className="caveat" key={i}>{c}</div>
              ))}
            </div>
          </Panel>
        </section>
      )}

      <section>
        <Panel title="Saved copy">
          <div className="note-box" style={{ marginTop: 0 }}>
            This brief is written to <code>briefs/{b.date}.md</code> automatically
            each weekday at 17:45 by the scheduled job, along with that day's
            holdings archive. Run <code>npm run brief</code> to regenerate it now.
          </div>
        </Panel>
      </section>
    </>
  );
}
