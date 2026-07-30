import { useEffect, useState } from 'react';
import { get, TIMEFRAMES, type Sourced, type TimeframeKey } from './api';
import { Panel } from './components/Common';
import { Chart, type ChartSeries, type SeriesPoint } from './components/Chart';
import {
  QuoteBlock, ReturnsTable, ConcentrationPanel, DataSources, MissingOverview,
  type OverviewData,
} from './components/Overview';
import { AttributionPanel, type AttributionData } from './components/Attribution';
import { HoldingsTable } from './components/Holdings';
import { LiveTodayPanel } from './components/LiveToday';
import { OutlookPanel } from './components/Outlook';
import { BriefPanel } from './components/Brief';
import { ErrorBoundary } from './components/ErrorBoundary';

type Tab = 'dashboard' | 'brief' | 'attribution' | 'holdings' | 'outlook';

interface SeriesResponse {
  timeframe: { label: string; startDate: string; endDate: string; tradingDays: number; clippedToInception: boolean };
  bars: SeriesPoint[];
  benchmarks: ChartSeries[];
}

export default function App() {
  /**
   * A single timeframe drives the chart, the attribution ranking and the
   * narrative together — switching to 1M must not leave one panel showing 3M.
   * Holding it here, above every consumer, is what guarantees that.
   */
  const [timeframe, setTimeframe] = useState<TimeframeKey>('1M');
  const [tab, setTab] = useState<Tab>('dashboard');

  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [overviewErr, setOverviewErr] = useState<string | null>(null);
  const [series, setSeries] = useState<SeriesResponse | null>(null);
  const [attribution, setAttribution] = useState<Sourced<AttributionData> | null>(null);
  const [synthetic, setSynthetic] = useState(false);

  useEffect(() => {
    get<OverviewData & { __synthetic: boolean }>('/overview')
      .then((d) => { setOverview(d); setSynthetic(d.__synthetic); })
      .catch((e: Error) => setOverviewErr(e.message));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSeries(null);
    setAttribution(null);
    get<SeriesResponse>(`/series?timeframe=${timeframe}`)
      .then((d) => { if (!cancelled) setSeries(d); })
      .catch(() => { if (!cancelled) setSeries(null); });
    get<{ attribution: Sourced<AttributionData> | AttributionData; provenance?: unknown }>(
      `/attribution?timeframe=${timeframe}`,
    )
      .then((d) => {
        if (cancelled) return;
        const a = d.attribution as AttributionData & { ok?: boolean };
        setAttribution(a.ok === false ? (d.attribution as Sourced<AttributionData>) : { ok: true, value: a, provenance: { source: 'computed', asOf: '', retrievedAt: '', reliability: 'live', label: 'computed' } });
      })
      .catch((e: Error) => {
        if (!cancelled) setAttribution({ ok: false, reason: 'provider-error', detail: e.message });
      });
    return () => { cancelled = true; };
  }, [timeframe]);

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>BAI — iShares A.I. Innovation and Tech Active ETF</h1>
          <div className="sub">
            NYSE Arca · actively managed · inception 21 Oct 2024 · 0.55% expense ratio
          </div>
        </div>
        <div className="sub">
          {series?.timeframe && (
            <>
              window {series.timeframe.startDate} → {series.timeframe.endDate} ·{' '}
              {series.timeframe.tradingDays} trading days
              {series.timeframe.clippedToInception && (
                <span className="chip stale" style={{ marginLeft: 8 }}>CLIPPED TO INCEPTION</span>
              )}
            </>
          )}
        </div>
      </header>

      {synthetic && (
        <div className="synthetic-banner">
          <span className="tag">SYNTHETIC DATA</span>
          <span className="body">
            No market-data provider key is configured, so this dashboard is running on
            <strong> generated demo data</strong>. Prices, returns, NAV and news are invented and
            describe nothing about the real BAI fund. The holdings roster is modelled on BAI's
            published portfolio so the sector and geography logic is exercised realistically —
            but every number attached to it is fictional. Set <code>TIINGO_API_KEY</code> (or
            another provider) and restart for real data.
          </span>
        </div>
      )}

      {/* The timeframe picker lives inside the breakdown tab — the only place it
          changes anything. It used to sit here, above the tabs, where it looked
          global and did nothing on three of the four tabs. */}
      <div className="tabs" style={{ marginTop: 16 }}>
        {([
          ['dashboard', 'Dashboard'],
          ['brief', "Today's summary"],
          ['attribution', 'What drove performance'],
          ['holdings', 'Holdings'],
          ['outlook', 'What could happen next?'],
        ] as Array<[Tab, string]>).map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && (
        <>
          {overviewErr && <MissingOverview error={overviewErr} />}
          {overview && (
            <>
              {!synthetic && (
                <section>
                  <h2>What's moving BAI right now</h2>
                  <ErrorBoundary label="Live today"><LiveTodayPanel /></ErrorBoundary>
                </section>
              )}
              <ErrorBoundary label="Quote"><QuoteBlock data={overview} /></ErrorBoundary>
              <section>
                <h2>BAI vs similar funds — {timeframe}</h2>
                <Panel>
                  {series ? (
                    <ErrorBoundary label="Chart">
                      <Chart fundSymbol="BAI" fund={series.bars} benchmarks={series.benchmarks} />
                    </ErrorBoundary>
                  ) : (
                    <div className="spinner">Loading series…</div>
                  )}
                  {/*
                    Without this the chart looks broken during a live session:
                    it ends at yesterday while the panel above shows today's
                    move, and the reader concludes the whole page is stale.
                  */}
                  <div className="note-box">
                    This chart and the tables below use <strong>closing prices</strong>, so they stop at
                    the end of the last finished trading day. Today gets a closing price only after
                    the market shuts at 4pm ET — so nothing here is broken or behind.{' '}
                    <strong>For today's move, look at the live panel at the top.</strong>
                  </div>
                </Panel>
              </section>
              <section>
                <h2>How it has performed</h2>
                <ErrorBoundary label="Returns"><ReturnsTable data={overview} /></ErrorBoundary>
              </section>
              <section>
                <h2>How concentrated it is</h2>
                <ErrorBoundary label="Concentration"><ConcentrationPanel data={overview} /></ErrorBoundary>
              </section>
              <section>
                <h2>Where the data comes from</h2>
                <DataSources data={overview} />
              </section>
            </>
          )}
          {!overview && !overviewErr && <div className="spinner">Loading fund data…</div>}
        </>
      )}

      {tab === 'brief' && <ErrorBoundary label="Daily brief"><BriefPanel /></ErrorBoundary>}

      {tab === 'attribution' && (
        <>
          <div className="timeframe-bar">
            {TIMEFRAMES.map((t) => (
              <button
                key={t}
                className={`tf-btn ${timeframe === t ? 'active' : ''}`}
                onClick={() => setTimeframe(t)}
              >
                {t}
              </button>
            ))}
            <span className="tf-note">
              pick how far back to look — everything below updates
            </span>
          </div>
          <ErrorBoundary label="Attribution"><AttributionPanel data={attribution} /></ErrorBoundary>
        </>
      )}

      {tab === 'outlook' && (
        <section><ErrorBoundary label="Outlook"><OutlookPanel /></ErrorBoundary></section>
      )}

      {tab === 'holdings' && (
        <section><ErrorBoundary label="Holdings"><HoldingsTable /></ErrorBoundary></section>
      )}


      <div className="disclaimer-bar">
        <strong>Educational tool — not investment advice.</strong> No content here is a
        recommendation to buy or sell any security, and nothing is a price target or forecast.
        Past performance does not predict future results. Market data may be delayed; verify
        anything you act on with your broker or the issuer.
        {synthetic && (
          <strong style={{ color: 'var(--synthetic)' }}> · CURRENTLY SHOWING SYNTHETIC DEMO DATA</strong>
        )}
      </div>
    </div>
  );
}
