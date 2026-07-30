import { useEffect, useState } from 'react';
import { fmt, get, signClass, type Sourced } from '../api';
import { Missing, NoteBox, Panel, Show, Stat } from './Common';

interface Horizon {
  label: string;
  tradingDays: number;
  calendarDays: number;
  p5: number; p25: number; p50: number; p75: number; p95: number;
  price5: number; price25: number; price50: number; price75: number; price95: number;
  probUpPct: number;
  probDown10Pct: number;
  probDown20Pct: number;
  probMaxDrawdown20Pct: number;
  empiricalUpPct: number | null;
  empiricalMedianPct: number | null;
  empiricalIndependentSamples: number;
}

interface ConditionalOutcome {
  label: string;
  upPct: number | null;
  medianPct: number | null;
  p25Pct: number | null;
  p75Pct: number | null;
  matchCount: number;
  baselineUpPct: number | null;
  baselineMedianPct: number | null;
}

interface OutlookData {
  asOfDate: string;
  spotPrice: number;
  annualisedVolPct: number;
  annualisedDriftPct: number;
  historyDays: number;
  simulations: number;
  horizons: Horizon[];
  driftWarning: string;
  method: string;
  proxy: {
    label: string;
    historyDays: number;
    volScale: number;
    proxyVolPct: number;
    horizons: Horizon[];
  } | null;
  conditional: {
    state: { pctBelowHigh: number; aboveSma200: boolean; label: string };
    seriesLabel: string;
    seriesDays: number;
    outcomes: ConditionalOutcome[];
    note: string;
  } | null;
}

/**
 * The probability cone. Inline SVG, horizons on the x axis, % outcome on y.
 * The p5–p95 envelope is the faint region, p25–p75 the solid one, the median a
 * line. Drawn from the model's own numbers — nothing in here recomputes.
 */
function FanChart({ horizons, spot }: { horizons: Horizon[]; spot: number }) {
  const W = 720;
  const H = 300;
  const P = { l: 52, r: 86, t: 16, b: 28 };

  const lo = Math.min(...horizons.map((h) => h.p5), 0);
  const hi = Math.max(...horizons.map((h) => h.p95), 0);
  const pad = (hi - lo) * 0.06;
  const yMin = lo - pad;
  const yMax = hi + pad;

  const x = (i: number): number =>
    P.l + ((W - P.l - P.r) * i) / Math.max(1, horizons.length - 1);
  const y = (v: number): number =>
    P.t + (H - P.t - P.b) * (1 - (v - yMin) / (yMax - yMin));

  const area = (loKey: keyof Horizon, hiKey: keyof Horizon): string => {
    const up = horizons.map((h, i) => `${x(i)},${y(h[hiKey] as number)}`);
    const dn = [...horizons].reverse().map((h, i) => `${x(horizons.length - 1 - i)},${y(h[loKey] as number)}`);
    return `M${up[0]} L${up.slice(1).join(' L')} L${dn.join(' L')} Z`;
  };
  const line = (key: keyof Horizon): string =>
    horizons.map((h, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(h[key] as number)}`).join(' ');

  const last = horizons[horizons.length - 1];

  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label="Range of plausible outcomes by holding period">
        {/* zero line = today's price */}
        <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="#3a4763" strokeDasharray="4 4" />
        <text x={P.l - 6} y={y(0) + 4} textAnchor="end" fontSize="10" fill="#64708a">
          today
        </text>

        {/* envelopes */}
        <path d={area('p5', 'p95')} fill="#6ea8ff18" />
        <path d={area('p25', 'p75')} fill="#6ea8ff38" />
        <path d={line('p50')} fill="none" stroke="#e8edf7" strokeWidth="2" />

        {/* axis labels */}
        {horizons.map((h, i) => (
          <text key={h.label} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10.5" fill="#93a0b7">
            {h.label}
          </text>
        ))}
        {[yMin + pad, 0, (yMax - pad) / 2, yMax - pad].map((v, i) => (
          <text key={i} x={P.l - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="#64708a">
            {v >= 0 ? '+' : ''}{v.toFixed(0)}%
          </text>
        ))}

        {/* right-edge dollar labels for the last horizon */}
        {last && (
          <>
            <text x={W - P.r + 8} y={y(last.p95) + 4} fontSize="10.5" fill="#34d399">
              {fmt.usd(last.price95, 0)} best 5%
            </text>
            <text x={W - P.r + 8} y={y(last.p50) + 4} fontSize="10.5" fill="#e8edf7">
              {fmt.usd(last.price50, 0)} middle
            </text>
            <text x={W - P.r + 8} y={y(last.p5) + 4} fontSize="10.5" fill="#fb7185">
              {fmt.usd(last.price5, 0)} worst 5%
            </text>
          </>
        )}
      </svg>
      <div className="dimmer" style={{ fontSize: 10.5, fontFamily: 'var(--mono)', marginTop: 4 }}>
        today: {fmt.usd(spot, 2)} · bright band = middle half of outcomes · faint band = 90% of outcomes
      </div>
    </div>
  );
}

function HorizonTable({ horizons, spot }: { horizons: Horizon[]; spot: number }) {
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th className="left">If you hold for</th>
            <th title="90% of simulated outcomes landed between these two prices">Likely price range</th>
            <th title="Share of simulated paths that ended above today's price">Chance it's up</th>
            <th title="Share of paths ending 10% or more below today">Chance down 10%+</th>
            <th title="Share of paths that saw a 20% peak-to-trough drop at some point along the way, even if they recovered">20% dip on the way</th>
            <th className="left" title="From actual history: share of real windows of this length that ended up">Real history said</th>
          </tr>
        </thead>
        <tbody>
          {horizons.map((h) => (
            <tr key={h.label}>
              <td className="left"><strong>{h.label}</strong></td>
              <td>
                <span className="down">{fmt.usd(h.price5, 0)}</span>
                <span className="dimmer"> to </span>
                <span className="up">{fmt.usd(h.price95, 0)}</span>
              </td>
              <td className={h.probUpPct >= 50 ? 'up' : 'down'}>{h.probUpPct.toFixed(0)}%</td>
              <td className="muted">{h.probDown10Pct.toFixed(0)}%</td>
              <td className="muted">{h.probMaxDrawdown20Pct.toFixed(0)}%</td>
              <td className="left dimmer" style={{ fontSize: 11 }}>
                {h.empiricalUpPct === null
                  ? 'too little history'
                  : `up ${h.empiricalUpPct.toFixed(0)}% of the time (${h.empiricalIndependentSamples} independent window${h.empiricalIndependentSamples === 1 ? '' : 's'})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OutlookPanel() {
  const [data, setData] = useState<Sourced<OutlookData> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    get<{ outlook: Sourced<OutlookData> }>('/outlook')
      .then((d) => { if (!cancelled) setData(d.outlook); })
      .catch((e: Error) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, []);

  if (err) return <Missing of={{ reason: 'provider-error', detail: err }} />;
  if (!data) return <div className="spinner">Running 10,000 simulations…</div>;

  return (
    <Show data={data}>
      {(o) => (
        <>
          {/* ------------------------------------------------ the point --- */}
          <div className="no-driver" style={{ background: '#12202e', borderColor: '#24405c', color: '#9ec5ff' }}>
            <strong>Nobody can predict where BAI is going — including this page.</strong> What it
            can do honestly is show the <em>range</em> of outcomes the fund's own behaviour makes
            plausible, with odds attached. Read the width of the ranges. Treat the middle line as
            the centre of a wide cloud, never as a target.
          </div>

          <section>
            <h2>Where BAI could plausibly be — from its own history</h2>
            <Panel>
              <div className="stat-grid" style={{ marginBottom: 14 }}>
                <Stat label="Today's price" value={fmt.usd(o.spotPrice, 2)} />
                <Stat
                  label="How jumpy BAI is"
                  value={`${o.annualisedVolPct.toFixed(0)}%/yr`}
                  hint="Annualised volatility over the last 120 sessions — the single number that sets how wide these ranges are"
                />
                <Stat label="History used" value={`${o.historyDays} days`}
                  hint={`Every trading day since inception, through ${o.asOfDate}`} />
                <Stat label="Simulated paths" value={o.simulations.toLocaleString('en-US')} />
              </div>
              <FanChart horizons={o.horizons} spot={o.spotPrice} />
              <div style={{ marginTop: 14 }}>
                <HorizonTable horizons={o.horizons} spot={o.spotPrice} />
              </div>
              <NoteBox>{o.method}</NoteBox>
              <div className="no-driver" style={{ marginTop: 10 }}>{o.driftWarning}</div>
            </Panel>
          </section>

          {/* -------------------------------------------- second opinion --- */}
          {o.proxy && (
            <section>
              <h2>
                Second opinion from a longer record —{' '}
                <span className="chip proxy">{o.proxy.label}</span>
              </h2>
              <Panel>
                <NoteBox>
                  BAI is only {o.historyDays} trading days old, so its own history says almost
                  nothing about rare events. This model runs the same simulation on{' '}
                  <strong>{o.proxy.historyDays.toLocaleString('en-US')} days</strong> of{' '}
                  {o.proxy.label} — which lived through 2008 and 2020 — rescaled (×
                  {o.proxy.volScale.toFixed(2)}) to match BAI's jumpiness. It is not BAI; it is
                  what two decades of semiconductor-index behaviour would look like at BAI's
                  volatility. Where the two tables disagree, trust neither edge — the truth is
                  probably between them.
                </NoteBox>
                <HorizonTable horizons={o.proxy.horizons} spot={o.spotPrice} />
              </Panel>
            </section>
          )}

          {/* ------------------------------------------ conditional study --- */}
          {o.conditional && (
            <section>
              <h2>Every time it looked like today, what happened next?</h2>
              <Panel>
                <div className="verdict" style={{ fontSize: 15 }}>
                  Right now BAI is <strong>{o.conditional.state.label}</strong> (
                  {o.conditional.state.pctBelowHigh.toFixed(0)}% below its 52-week high). Across{' '}
                  {o.conditional.seriesDays.toLocaleString('en-US')} days of{' '}
                  {o.conditional.seriesLabel}, here is what followed days that looked like this —
                  next to what followed <em>any</em> day:
                </div>
                <div className="scroll-x">
                  <table>
                    <thead>
                      <tr>
                        <th className="left">Looking ahead</th>
                        <th title="Of the historical days matching today's setup, the share where the index was higher this much later">After days like today: up</th>
                        <th>Typical result</th>
                        <th title="The same measure across every day in the record, matching or not">After any day: up</th>
                        <th className="left">Days like today</th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.conditional.outcomes.map((c) => (
                        <tr key={c.label}>
                          <td className="left"><strong>{c.label}</strong></td>
                          <td className={c.upPct !== null && c.upPct >= 50 ? 'up' : 'down'}>
                            {c.upPct === null ? '—' : `${c.upPct.toFixed(0)}%`}
                          </td>
                          <td className={c.medianPct !== null ? signClass(c.medianPct) : 'dimmer'}>
                            {c.medianPct === null ? 'too few matches' : fmt.pct(c.medianPct, 1)}
                          </td>
                          <td className="dimmer">
                            {c.baselineUpPct === null ? '—' : `${c.baselineUpPct.toFixed(0)}%`}
                          </td>
                          <td className="left dimmer">{c.matchCount.toLocaleString('en-US')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <NoteBox>{o.conditional.note}</NoteBox>
              </Panel>
            </section>
          )}

          <div className="no-driver" style={{ background: '#12202e', borderColor: '#24405c', color: '#9ec5ff' }}>
            <strong>Not investment advice.</strong> These are statistical ranges from past
            behaviour. The future can and does leave the range — a fund this concentrated can do
            things its own history has never shown.
          </div>
        </>
      )}
    </Show>
  );
}
