import { useEffect, useState } from 'react';
import { fmt, get, signClass } from '../api';
import { Panel, Stat } from './Common';

interface LiveMover {
  ticker: string; name: string; weight: number;
  changePct: number; contributionPct: number; subTheme: string;
}

interface LiveData {
  asOf: string;
  marketOpen: boolean;
  session: { phase: string; label: string; etTime: string };
  fund: { last: number; changePct: number; dayLow: number; dayHigh: number; volume: number } | null;
  fundNote: string | null;
  impliedFromHoldingsPct: number | null;
  coveragePct: number;
  movers: { up: LiveMover[]; down: LiveMover[] };
  bySubTheme: Array<{ label: string; contributionPct: number; weight: number }>;
  closedMarkets: Array<{
    ticker: string; name: string; weight: number;
    changePct: number | null; contributionPct: number | null; asOf: string | null;
  }>;
  unpriced: Array<{ ticker: string; weight: number }>;
  notes: string[];
  available: boolean;
  reason: string | null;
}

/*
 * Poll cadence, driven by the market session rather than fixed.
 *
 * 2 min matches the server's quote cache TTL while the session is live (~30
 * upstream requests/hour, inside the free-tier budget). Outside the session a
 * quote cannot change, so the old fixed 120s spent roughly two thirds of the
 * daily allowance overnight and at weekends re-fetching an identical close.
 */
/*
 * 5 minutes, not 2.
 *
 * The quotes are already ~15 minutes delayed, so polling every 2 minutes
 * re-fetched an identical value up to 7 times before it could possibly change —
 * pure spend against a 45/hour cap. 5 minutes still oversamples a 15-minute
 * feed while cutting the live panel from ~30 requests/hour to ~12.
 */
const REFRESH_OPEN_MS = 300_000;
const REFRESH_CLOSED_MS = 900_000;

/**
 * Column labels. Without these the last two numbers on each row are just two
 * unexplained percentages sitting next to each other.
 */
function MoverHead() {
  return (
    <div className="contrib-head">
      <span>Stock</span>
      <span>How much it moved</span>
      <span title="How much of BAI this holding is">% of fund</span>
    </div>
  );
}

/*
 * Just the bar. The per-stock headline lists that used to hang under each row
 * moved into the AI-written summary card above the panel — one thing to read
 * instead of a dozen links to triage.
 */
function MoverRow({ m, scale }: { m: LiveMover; scale: number }) {
  // Bar length tracks the stock's own price move — the number printed beside it.
  const pct = (Math.abs(m.changePct) / scale) * 50;
  const positive = m.changePct >= 0;
  return (
    <div className="contrib-row" title={`${m.name} · ${m.subTheme} · ${m.weight.toFixed(2)}% weight`}>
      <div className="contrib-name"><strong>{m.ticker}</strong></div>
      <div className="contrib-track">
        <div className="zero" />
        <div
          className="contrib-fill"
          style={{
            background: positive ? 'var(--up)' : 'var(--down)',
            left: positive ? '50%' : `${50 - pct}%`,
            width: `${Math.max(0.4, pct)}%`,
          }}
        />
      </div>
      <div className={`contrib-val ${signClass(m.changePct)}`}>{fmt.pct(m.changePct)}</div>
      <div className="contrib-weight">{m.weight.toFixed(2)}%</div>
    </div>
  );
}

export function LiveTodayPanel() {
  const [data, setData] = useState<LiveData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // The next poll is scheduled from the response just received, not from
  // component state: `data` is still null on the first pass and stale on every
  // later one, so reading it here would pick the wrong interval every time —
  // notably the slow one during a live session.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const again = (phase: string | undefined): void => {
      const wait = phase === 'regular' ? REFRESH_OPEN_MS : REFRESH_CLOSED_MS;
      timer = setTimeout(() => setTick((x) => x + 1), wait);
    };

    get<{ live: LiveData }>('/live')
      .then((d) => {
        if (cancelled) return;
        setData(d.live);
        setErr(null);
        again(d.live.session?.phase);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setErr(e.message);
        // Back off on failure rather than hammering a provider that is down.
        again(undefined);
      });

    return () => { cancelled = true; clearTimeout(timer); };
  }, [tick]);

  if (err || !data) {
    return (
      <Panel title="Live today">
        <div className="spinner">{err ?? 'Loading live view…'}</div>
      </Panel>
    );
  }

  if (!data.available) {
    return (
      <Panel title="Live today">
        <div className="missing">
          <div className="reason-tag">Live view unavailable</div>
          <div className="why">{data.reason}</div>
        </div>
      </Panel>
    );
  }

  const all = [...data.movers.up, ...data.movers.down];
  const scale = Math.max(...all.map((m) => Math.abs(m.changePct)), 0.5);
  const closedWeight = data.closedMarkets.reduce((a, h) => a + h.weight, 0);
  const closedWithMoves = data.closedMarkets
    .filter((h) => h.changePct !== null)
    .sort((a, b) => (a.contributionPct ?? 0) - (b.contributionPct ?? 0));
  const closedScale = Math.max(
    ...closedWithMoves.map((h) => Math.abs(h.changePct ?? 0)),
    0.5,
  );

  return (
    <Panel
      title={
        <>
          <span className={`live-dot ${data.marketOpen ? '' : 'closed'}`} />
          {data.marketOpen ? `Live now — ${data.session.etTime}` : data.session.label}
        </>
      }
      right={
        <span className="dimmer" style={{ fontWeight: 400, textTransform: 'none' }}>
          {import.meta.env.VITE_STATIC === '1'
            ? 'from the last scheduled site update · '
            : `delayed ~15 min · refreshes every ${
                data.session.phase === 'regular' ? '5 min' : '15 min while closed'
              } · `}
          as of {fmt.time(data.asOf)}
        </span>
      }
    >
      {data.fund && (
        <div className="quote-row" style={{ marginBottom: 6 }}>
          <span className="quote-price">{fmt.num(data.fund.last)}</span>
          <span className={`quote-change ${signClass(data.fund.changePct)}`}>
            {fmt.pct(data.fund.changePct)} today
          </span>
        </div>
      )}

      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <div>
          <h3 style={{ margin: '0 0 6px', fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Helping today
          </h3>
          <MoverHead />
          {data.movers.up.length === 0 ? (
            <div className="dimmer" style={{ fontSize: 12 }}>nothing is up right now</div>
          ) : (
            data.movers.up.map((m) => <MoverRow key={m.ticker} m={m} scale={scale} />)
          )}
        </div>
        <div>
          <h3 style={{ margin: '0 0 6px', fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Hurting today
          </h3>
          <MoverHead />
          {data.movers.down.length === 0 ? (
            <div className="dimmer" style={{ fontSize: 12 }}>nothing is down right now</div>
          ) : (
            data.movers.down.map((m) => <MoverRow key={m.ticker} m={m} scale={scale} />)
          )}
        </div>
      </div>

      {/*
        The already-closed names get their own dated block. Leaving them out of
        the US mover lists is right — they are not trading now — but leaving
        their moves off the page entirely hid the fund's biggest position falling
        9.6%, which reads as the dashboard being broken.
      */}
      {closedWithMoves.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Asia — already finished trading{' '}
            <span className="dimmer" style={{ textTransform: 'none', fontWeight: 400, letterSpacing: 0 }}>
              (their {closedWithMoves[0]?.asOf} session, hours before the US close)
            </span>
          </h3>
          <MoverHead />
          {closedWithMoves.map((h) => (
            <div className="contrib-row" key={h.ticker} title={`${h.name} · ${h.weight.toFixed(2)}% of the fund`}>
              <div className="contrib-name"><strong>{h.ticker}</strong></div>
              <div className="contrib-track">
                <div className="zero" />
                <div
                  className="contrib-fill"
                  style={{
                    background: (h.changePct ?? 0) >= 0 ? 'var(--up)' : 'var(--down)',
                    left: (h.changePct ?? 0) >= 0 ? '50%' : `${50 - (Math.abs(h.changePct ?? 0) / closedScale) * 50}%`,
                    width: `${Math.max(0.4, (Math.abs(h.changePct ?? 0) / closedScale) * 50)}%`,
                  }}
                />
              </div>
              <div className={`contrib-val ${signClass(h.changePct)}`}>{fmt.pct(h.changePct)}</div>
              <div className="contrib-weight">{h.weight.toFixed(2)}%</div>
            </div>
          ))}
          <div className="dimmer" style={{ fontSize: 10.5, marginTop: 5 }}>
            These are already baked into BAI's own price above, but they cannot show up in the
            US-hours numbers — their day was over before the US opened.
          </div>
        </div>
      )}
    </Panel>
  );
}
