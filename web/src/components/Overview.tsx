import { useEffect, useState } from 'react';
import { fmt, get, signClass, type Sourced, type Provenance } from '../api';
import { KV, Missing, NoteBox, Panel, RangeBar, Show, Stat } from './Common';

interface Quote {
  symbol: string; last: number; change: number; changePct: number;
  dayHigh: number; dayLow: number; volume: number; avgVolume30d: number | null;
  week52High: number | null; week52Low: number | null; previousClose: number;
  marketClosed: boolean;
}

interface Nav { nav: number; navDate: string; marketPrice: number; premiumDiscountPct: number }

interface RollupRow { key: string; label: string; startWeight: number; memberCount: number }

interface Concentration {
  top10WeightPct: number; top1WeightPct: number; effectiveHoldings: number;
  herfindahl: number; totalHoldings: number;
  bySector: RollupRow[]; bySubTheme: RollupRow[]; byCountry: RollupRow[];
}

export interface OverviewData {
  fund: { ticker: string; name: string; listingExchange: string; inceptionDate: string; productUrl: string };
  quote: Sourced<Quote>;
  nav: Sourced<Nav>;
  holdings: Sourced<{ asOfDate: string; count: number }> | { asOfDate: string; count: number };
  concentration: Sourced<Concentration>;
  returns: Array<{ key: string; label: string; navReturnPct: Sourced<number>; marketReturnPct: Sourced<number> }>;
  benchmarks: Array<{ symbol: string; name: string; returnPct: Sourced<number>; relativePct: Sourced<number> }>;
  facts: { expenseRatioPct: number; inceptionDate: string; prospectusUrl: string; factSheetUrl: string; note: string };
  dataSources: { configured: string[]; fixturesActive: boolean; nonUsCapable: boolean; realtime: boolean };
  snapshotArchive: { dates: string[]; count: number };
}

export function QuoteBlock({ data }: { data: OverviewData }) {
  return (
    <div className="grid cols-3">
      <Panel title="Price right now">
        <Show data={data.quote}>
          {(q, p) => (
            <>
              <div className="quote-row">
                <span className="quote-price">{fmt.num(q.last)}</span>
                <span className={`quote-change ${signClass(q.change)}`}>
                  {q.change >= 0 ? '+' : '−'}{Math.abs(q.change).toFixed(2)} ({fmt.pct(q.changePct)})
                </span>
                {!p.reliability.includes('live') || p.note?.includes('Delayed') ? (
                  <span className="chip delayed">DELAYED</span>
                ) : null}
              </div>
              <div className="stat-grid">
                <Stat label="Yesterday's close" value={fmt.num(q.previousClose)} />
                <Stat label="Volume" value={fmt.compact(q.volume)} />
                <Stat
                  label="vs normal trading"
                  value={q.avgVolume30d ? `${(q.volume / q.avgVolume30d).toFixed(2)}×` : '—'}
                  hint={q.avgVolume30d ? `30-day average ${fmt.compact(q.avgVolume30d)}` : undefined}
                />
              </div>
              <div style={{ marginTop: 14 }}>
                <div className="stat"><div className="label">Day range</div></div>
                <RangeBar low={q.dayLow} high={q.dayHigh} current={q.last} />
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="stat"><div className="label">52-week range</div></div>
                <RangeBar low={q.week52Low} high={q.week52High} current={q.last} />
              </div>
            </>
          )}
        </Show>
      </Panel>

      {/*
        Plain language on purpose. This panel used to read "NAV and
        premium/discount require an ETF-aware data source … entitled vendor
        feed", which is jargon describing a missing feature. It now computes the
        real figure from the issuer's own holdings file, so it can just say what
        the number means.
      */}
      <Panel title="What the fund is actually worth">
        <Show data={data.nav}>
          {(n) => (
            <>
              <div className="stat-grid">
                <Stat
                  label="Holdings worth per share"
                  value={fmt.num(n.nav)}
                  hint="Total market value of everything the fund owns, divided by its shares outstanding"
                />
                <Stat
                  label="Price it traded at"
                  value={fmt.num(n.marketPrice)}
                  hint={`Closing price on ${n.navDate}, the same day the holdings were published`}
                />
                <Stat
                  label={n.premiumDiscountPct >= 0 ? 'Traded ABOVE its holdings' : 'Traded BELOW its holdings'}
                  value={fmt.pct(Math.abs(n.premiumDiscountPct), 2)}
                  cls={signClass(n.premiumDiscountPct)}
                />
                <Stat label="As of" value={fmt.date(n.navDate)} />
              </div>
              <NoteBox>
                You buy and sell at the <strong>market price</strong>, not at what the holdings
                are worth. When the price sits above that value you are paying a little extra for
                the same basket; below, you are getting a small discount. It is usually a fraction
                of a percent — and unlike most worries at purchase time, this one you can actually
                check before you trade.
              </NoteBox>
            </>
          )}
        </Show>
      </Panel>

      <Panel title="The basics">
        <KV k="Ticker" v={`${data.fund.ticker} · ${data.fund.listingExchange}`} />
        <KV k="Annual fee" v={`${data.facts.expenseRatioPct.toFixed(2)}%`} />
        <KV k="Inception" v={data.facts.inceptionDate} />
        <KV k="Management" v="Active" />
        <KV
          k="Holdings"
          v={'ok' in data.holdings ? (data.holdings.ok ? data.holdings.value.count : '—') : data.holdings.count}
        />
        <KV
          k="Holdings as of"
          v={'ok' in data.holdings ? (data.holdings.ok ? data.holdings.value.asOfDate : '—') : data.holdings.asOfDate}
        />
        <KV k="Archived files" v={`${data.snapshotArchive.count}`} />
        <div style={{ marginTop: 10, display: 'flex', gap: 12 }}>
          <a href={data.facts.prospectusUrl} target="_blank" rel="noreferrer noopener">Prospectus</a>
          <a href={data.facts.factSheetUrl} target="_blank" rel="noreferrer noopener">Fact sheet</a>
          <a href={data.fund.productUrl} target="_blank" rel="noreferrer noopener">iShares page</a>
        </div>
        <div className="prov">{data.facts.note}</div>
      </Panel>
    </div>
  );
}

export function ReturnsTable({ data }: { data: OverviewData }) {
  return (
    <div className="grid cols-2">
      <Panel title="Returns over different periods">
        <table>
          <thead>
            <tr>
              <th className="left">Period</th>
              <th>Based on share price</th>
              <th>Based on holdings value</th>
            </tr>
          </thead>
          <tbody>
            {data.returns.map((r) => (
              <tr key={r.key}>
                <td className="left">{r.label}</td>
                <td className={r.marketReturnPct.ok ? signClass(r.marketReturnPct.value) : 'dimmer'}>
                  {r.marketReturnPct.ok ? fmt.pct(r.marketReturnPct.value) : '—'}
                </td>
                <td className="dimmer" title={r.navReturnPct.ok ? '' : (r.navReturnPct as { detail: string }).detail}>
                  {r.navReturnPct.ok ? fmt.pct(r.navReturnPct.value) : 'n/a'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="prov">
          The second column needs a day-by-day history of what the holdings were worth, which BlackRock does not publish and no free feed carries. We show
          n/a rather than silently reusing the market price, which would misstate them.
        </div>
      </Panel>

      <Panel title="Benchmark comparison (YTD)">
        <table>
          <thead>
            <tr>
              <th className="left">Benchmark</th>
              <th>Return</th>
              <th>BAI relative</th>
            </tr>
          </thead>
          <tbody>
            {data.benchmarks.map((b) => (
              <tr key={b.symbol}>
                <td className="left">
                  <strong>{b.symbol}</strong> <span className="dimmer">{b.name}</span>
                </td>
                <td className={b.returnPct.ok ? signClass(b.returnPct.value) : 'dimmer'}>
                  {b.returnPct.ok ? fmt.pct(b.returnPct.value) : '—'}
                </td>
                <td className={b.relativePct.ok ? signClass(b.relativePct.value) : 'dimmer'}>
                  {b.relativePct.ok ? fmt.pp(b.relativePct.value) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

export function ConcentrationPanel({ data }: { data: OverviewData }) {
  return (
    <Show data={data.concentration}>
      {(c, p) => (
        <div className="grid cols-4">
          <Panel title="Concentration" provenance={p}>
            <div className="stat-grid">
              <Stat label="Top 10 holdings are" value={`${c.top10WeightPct.toFixed(2)}%`} />
              <Stat label="Biggest single holding" value={`${c.top1WeightPct.toFixed(2)}%`} />
              <Stat
                label="Effective holdings"
                value={c.effectiveHoldings.toFixed(1)}
                hint="How many equal-sized holdings this fund effectively behaves like. It owns more names than this, but the big positions dominate, so it acts like a smaller, more concentrated basket."
              />
              <Stat label="Number of holdings" value={String(c.totalHoldings)} />
            </div>
            <NoteBox>
              {c.totalHoldings} holdings, but it behaves like roughly{' '}
              <strong>{c.effectiveHoldings.toFixed(0)} equally-weighted</strong> ones. That gap is
              the concentration.
            </NoteBox>
          </Panel>
          <WeightPanel title="By sub-theme" rows={c.bySubTheme} />
          <WeightPanel title="By sector" rows={c.bySector} />
          <WeightPanel title="By country" rows={c.byCountry} />
        </div>
      )}
    </Show>
  );
}

function WeightPanel({ title, rows }: { title: string; rows: RollupRow[] }) {
  const max = Math.max(...rows.map((r) => r.startWeight), 1);
  return (
    <Panel title={title}>
      {rows.slice(0, 9).map((r) => (
        <div key={r.key} style={{ marginBottom: 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, gap: 8 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.label} <span className="dimmer">({r.memberCount})</span>
            </span>
            <span style={{ fontFamily: 'var(--mono)' }}>{r.startWeight.toFixed(1)}%</span>
          </div>
          <div style={{ height: 3, background: '#0f1420', borderRadius: 2, marginTop: 2 }}>
            <div style={{ height: '100%', width: `${(r.startWeight / max) * 100}%`, background: 'var(--accent)', borderRadius: 2 }} />
          </div>
        </div>
      ))}
    </Panel>
  );
}

interface SourcesResponse {
  ttlSeconds: {
    holdings: number;
    dailyBars: number;
    dailyBarsForeign: number;
    quote: number;
    news: number;
  };
  news: { source: string };
}

/** "6h" / "15m" / "120s" — whichever unit keeps it a whole number. */
function dur(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function DataSources({ data }: { data: OverviewData }) {
  // Cadence is read back from the server rather than written here, so this
  // panel cannot drift from the TTLs the fetch layer actually enforces.
  const [src, setSrc] = useState<SourcesResponse | null>(null);
  useEffect(() => {
    get<SourcesResponse>('/sources').then(setSrc).catch(() => setSrc(null));
  }, []);

  const t = src?.ttlSeconds;
  return (
    <Panel title="Where these numbers come from">
      <KV k="Price data from" v={data.dataSources.configured.length ? data.dataSources.configured.join(', ') : 'none configured'} />
      <KV k="Live to the second?" v={data.dataSources.realtime ? 'yes' : 'no — prices are about 15 minutes behind'} />
      <KV k="Covers foreign markets?" v={data.dataSources.nonUsCapable ? 'yes' : 'no — foreign holdings would have no price'} />
      <KV k="News source" v={src ? (src.news.source === 'none configured' ? 'none configured — moves are ranked, not explained' : src.news.source) : '…'} />
      <KV k="Days of holdings saved" v={`${data.snapshotArchive.count} published file(s)`} />
      <div className="prov">
        {t ? (
          <>
            Holdings: issuer CSV, once per business day ({dur(t.holdings)} TTL). Daily bars:{' '}
            {dur(t.dailyBars)} TTL ({dur(t.dailyBarsForeign)} for foreign venues, which close
            before the US session). Quotes: {dur(t.quote)} TTL. News: {dur(t.news)} TTL.{' '}
          </>
        ) : (
          'Refresh cadence unavailable. '
        )}
        Full per-field detail at <a href="/api/sources">/api/sources</a>.
      </div>
    </Panel>
  );
}

export function MissingOverview({ error }: { error: string }) {
  return <Missing of={{ reason: 'provider-error', detail: error }} />;
}

export type { Provenance };
