import { useMemo, useState } from 'react';
import { fmt } from '../api';

export interface SeriesPoint { date: string; close: number }
export interface ChartSeries {
  symbol: string;
  name: string;
  bars: SeriesPoint[];
  available: boolean;
}

// Amber (#f5a524) removed from the series palette along with the rest of the
// yellow. Cyan keeps the five lines distinguishable without reintroducing a hue
// the eye now reads as a warning nowhere else on the page.
const COLORS = ['#6ea8ff', '#fb7185', '#34d399', '#22d3ee', '#a78bfa'];

/**
 * Rebased comparison chart. Every series is normalised to 100 at the window's
 * first observation, because comparing a $23 ETF to a $495 one on a shared
 * price axis shows nothing. Rebasing makes relative performance — the actual
 * question — the thing the eye reads.
 */
export function Chart({
  fundSymbol,
  fund,
  benchmarks,
}: {
  fundSymbol: string;
  fund: SeriesPoint[];
  benchmarks: ChartSeries[];
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  const W = 1000;
  const H = 300;
  const P = { t: 14, r: 56, b: 22, l: 8 };

  const all = useMemo(() => {
    // Tolerate absent/short payloads defensively. Callers should send [] on
    // failure, but a chart must not be the thing that decides whether the page
    // renders at all.
    const fundBars = Array.isArray(fund) ? fund : [];
    const benchList = Array.isArray(benchmarks) ? benchmarks : [];
    const list: ChartSeries[] = [
      { symbol: fundSymbol, name: fundSymbol, bars: fundBars, available: fundBars.length > 0 },
      ...benchList,
    ];
    return list
      .filter((s) => s.available && Array.isArray(s.bars) && s.bars.length > 1)
      .map((s) => {
        const base = s.bars[0]?.close ?? 1;
        return {
          ...s,
          norm: s.bars.map((b) => ({ date: b.date, v: (b.close / base) * 100 })),
        };
      });
  }, [fund, benchmarks, fundSymbol]);

  const visible = all.filter((s) => !hidden.has(s.symbol));

  if (all.length === 0) {
    return <div className="missing"><div className="reason-tag">No series</div>
      <div className="why">No price series is available for this window.</div></div>;
  }

  const values = visible.flatMap((s) => s.norm.map((p) => p.v));
  const min = values.length ? Math.min(...values) : 95;
  const max = values.length ? Math.max(...values) : 105;
  const pad = (max - min) * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;

  const n = all[0]?.norm.length ?? 0;
  const x = (i: number) => P.l + (i / Math.max(1, n - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));
  const dates = all[0]?.norm.map((p) => p.date) ?? [];

  return (
    <div className="chart-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - P.l) / (W - P.l - P.r)) * (n - 1));
          setHover(i >= 0 && i < n ? i : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="#1c2433" strokeWidth={1} />
            <text x={W - P.r + 6} y={y(t) + 3.5} fill="#616d80" fontSize={10} fontFamily="ui-monospace, monospace">
              {t.toFixed(1)}
            </text>
          </g>
        ))}
        {/* Rebase line: 100 = start of window. */}
        <line x1={P.l} x2={W - P.r} y1={y(100)} y2={y(100)} stroke="#39465e" strokeWidth={1} strokeDasharray="3 3" />

        {visible.map((s, si) => {
          const color = COLORS[all.findIndex((a) => a.symbol === s.symbol) % COLORS.length];
          const d = s.norm.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
          return (
            <path
              key={s.symbol}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={si === 0 && s.symbol === fundSymbol ? 2.1 : 1.25}
              opacity={s.symbol === fundSymbol ? 1 : 0.78}
            />
          );
        })}

        {hover !== null && hover < n && (
          <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="#4a5a78" strokeWidth={1} />
        )}
        {hover !== null &&
          visible.map((s) => {
            const p = s.norm[hover];
            if (!p) return null;
            const color = COLORS[all.findIndex((a) => a.symbol === s.symbol) % COLORS.length];
            return <circle key={s.symbol} cx={x(hover)} cy={y(p.v)} r={2.6} fill={color} />;
          })}
      </svg>

      <div className="legend">
        {all.map((s) => {
          const color = COLORS[all.findIndex((a) => a.symbol === s.symbol) % COLORS.length];
          const p = hover !== null ? s.norm[hover] : s.norm.at(-1);
          const chg = p ? p.v - 100 : null;
          return (
            <div
              key={s.symbol}
              className={`item ${hidden.has(s.symbol) ? 'off' : ''}`}
              onClick={() => {
                const next = new Set(hidden);
                if (next.has(s.symbol)) next.delete(s.symbol);
                else next.add(s.symbol);
                setHidden(next);
              }}
            >
              <span className="swatch" style={{ background: color }} />
              <span style={{ color: s.symbol === fundSymbol ? 'var(--text)' : undefined }}>
                {s.symbol}
              </span>
              <span className={chg !== null && chg >= 0 ? 'up' : 'down'} style={{ fontFamily: 'var(--mono)' }}>
                {fmt.pct(chg)}
              </span>
            </div>
          );
        })}
        <span className="dimmer" style={{ marginLeft: 'auto' }}>
          rebased to 100 at {fmt.date(dates[0])}
          {hover !== null && dates[hover] ? ` · cursor ${fmt.date(dates[hover])}` : ''}
        </span>
      </div>
    </div>
  );
}
