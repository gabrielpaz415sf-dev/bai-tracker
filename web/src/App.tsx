import { useEffect, useState } from 'react';
import { get, fmt, signClass, type Sourced } from './api';
import { Panel } from './components/Common';
import { Chart, type ChartSeries, type SeriesPoint } from './components/Chart';
import { HoldingsTable } from './components/Holdings';
import { LiveTodayPanel } from './components/LiveToday';
import { DailySummaryCard } from './components/Summary';
import { ErrorBoundary } from './components/ErrorBoundary';

/**
 * ONE PAGE, ESSENTIALS ONLY.
 *
 * This site grew five tabs of analysis and collected exactly the complaint it
 * deserved: too much, and sections disagreeing with each other because each
 * computed similar things from different sources over different windows. The
 * cure is structural: one page, one source per fact, one visible timestamp.
 *
 *   1. What BAI is doing today: the AI-written overview, then the numbers
 *   2. How it has performed (returns + a 3-month chart vs benchmarks)
 *   3. What it holds
 *
 * Manager activity was cut from the page by request (2026-07-30); the per-row
 * Δ-weight chips in the holdings table still carry the information.
 *
 * Everything else this codebase can compute still exists server-side; it just
 * is not this page's job.
 */

interface SeriesResponse {
  timeframe: { label: string; startDate: string; endDate: string; tradingDays: number };
  bars: SeriesPoint[];
  benchmarks: ChartSeries[];
}

interface OverviewData {
  returns: Array<{ key: string; label: string; marketReturnPct: Sourced<number> }>;
  __synthetic: boolean;
}

export default function App() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [series, setSeries] = useState<SeriesResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<OverviewData>('/overview').then(setOverview).catch((e: Error) => setErr(e.message));
    get<SeriesResponse>('/series?timeframe=3M').then(setSeries).catch(() => setSeries(null));
  }, []);

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>BAI Tracker</h1>
          <div className="sub">
            iShares A.I. Innovation and Tech Active ETF · NYSE Arca · 0.55% annual fee
          </div>
        </div>
      </header>

      {err && (
        <div className="missing" style={{ marginTop: 16 }}>
          <div className="reason-tag">Data failed to load</div>
          <div className="why">{err}</div>
        </div>
      )}

      {/* 1 ─ today: the AI-written why, then BAI's move and the stocks moving it */}
      <section>
        <h2>Today</h2>
        <ErrorBoundary label="Daily summary"><DailySummaryCard /></ErrorBoundary>
        <ErrorBoundary label="Live today"><LiveTodayPanel /></ErrorBoundary>
      </section>

      {/* 2 ─ performance */}
      <section>
        <h2>Performance</h2>
        <div className="grid attribution">
          <Panel title="Last 3 months vs similar funds">
            {series ? (
              <ErrorBoundary label="Chart">
                <Chart fundSymbol="BAI" fund={series.bars} benchmarks={series.benchmarks} />
              </ErrorBoundary>
            ) : (
              <div className="spinner">Loading chart…</div>
            )}
          </Panel>
          <Panel title={`Returns${series ? ` — through ${series.timeframe.endDate}` : ''}`}>
            {overview ? (
              <table>
                <thead>
                  <tr>
                    <th className="left">Period</th>
                    <th>Return</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.returns.map((r) => (
                    <tr key={r.key}>
                      <td className="left">{r.label}</td>
                      <td className={r.marketReturnPct.ok ? signClass(r.marketReturnPct.value) : 'dimmer'}>
                        {r.marketReturnPct.ok ? fmt.pct(r.marketReturnPct.value) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="spinner">Loading…</div>
            )}
            <div className="dimmer" style={{ fontSize: 11, marginTop: 8 }}>
              Returns use closing prices, so they run through the last finished trading day.
              Today-so-far is in the panel at the top.
            </div>
          </Panel>
        </div>
      </section>

      {/* 3 ─ holdings */}
      <section>
        <h2>Every stock it owns</h2>
        <ErrorBoundary label="Holdings"><HoldingsTable /></ErrorBoundary>
      </section>

      <div className="disclaimer-bar">
        Educational tool — not investment advice. Quotes are delayed; verify anything you act
        on with your broker or the issuer.
      </div>
    </div>
  );
}
