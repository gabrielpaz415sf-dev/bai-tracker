import { useEffect, useMemo, useState } from 'react';
import { fmt, get, signClass, type Provenance } from '../api';
import { Missing, NoteBox, Panel } from './Common';

interface Holding {
  ticker: string; name: string; weight: number; sector: string;
  country: string; exchange: string; currency: string; assetClass: string; subTheme: string;
}

interface WeightChange {
  ticker: string; name: string; kind: string;
  priorWeight: number | null; currentWeight: number | null; deltaPct: number;
}

type DayChange = { pct: number; intraday: boolean } | number | null;

interface HoldingsData {
  asOfDate: string;
  provenance: Provenance;
  holdings: Holding[];
  dayChange: Record<string, DayChange>;
  dayChangeNote?: string;
  diff: { fromDate: string; toDate: string; changes: WeightChange[]; turnoverPct: number } | { unavailable: string };
  synthetic: boolean;
}

/** Server sends {pct, intraday}; fixture mode historically sent bare numbers. */
function dayChangePct(v: DayChange | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : v.pct;
}

function isIntraday(v: DayChange | undefined): boolean {
  return typeof v === 'object' && v !== null && v.intraday;
}

type SortKey = 'weight' | 'ticker' | 'name' | 'sector' | 'country' | 'dayChange' | 'delta';

export function HoldingsTable() {
  const [data, setData] = useState<HoldingsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('weight');
  const [asc, setAsc] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    get<HoldingsData>('/holdings').then(setData).catch((e: Error) => setErr(e.message));
  }, []);

  const diffMap = useMemo(() => {
    const m = new Map<string, WeightChange>();
    if (data && 'changes' in data.diff) {
      for (const c of data.diff.changes) m.set(c.ticker, c);
    }
    return m;
  }, [data]);

  // The issuer file ends in ~20 rows of 0.00% cash, money-market, and currency
  // forwards (TWD/USD, KRW CASH, …). The section promises "every stock it
  // owns" and those are not stocks — they are plumbing, and they buried the
  // real tail of the portfolio. Include-only on Equity so any new non-stock
  // class the issuer invents stays out; the excluded weight is footnoted.
  const stocks = useMemo(
    () => (data ? data.holdings.filter((h) => h.assetClass === 'Equity') : []),
    [data],
  );
  const cashWeight = useMemo(
    () => (data ? data.holdings.reduce((a, h) => a + h.weight, 0) : 0) - stocks.reduce((a, h) => a + h.weight, 0),
    [data, stocks],
  );

  const rows = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    const filtered = stocks.filter(
      (h) =>
        q === '' ||
        h.ticker.toLowerCase().includes(q) ||
        h.name.toLowerCase().includes(q) ||
        h.sector.toLowerCase().includes(q) ||
        h.country.toLowerCase().includes(q) ||
        h.subTheme.toLowerCase().includes(q),
    );
    const dir = asc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case 'ticker': return dir * a.ticker.localeCompare(b.ticker);
        case 'name': return dir * a.name.localeCompare(b.name);
        case 'sector': return dir * a.sector.localeCompare(b.sector);
        case 'country': return dir * a.country.localeCompare(b.country);
        case 'dayChange': {
          const av = dayChangePct(data.dayChange[a.ticker]) ?? -Infinity;
          const bv = dayChangePct(data.dayChange[b.ticker]) ?? -Infinity;
          return dir * (av - bv);
        }
        case 'delta': {
          const av = diffMap.get(a.ticker)?.deltaPct ?? 0;
          const bv = diffMap.get(b.ticker)?.deltaPct ?? 0;
          return dir * (av - bv);
        }
        default: return dir * (a.weight - b.weight);
      }
    });
  }, [data, stocks, sort, asc, filter, diffMap]);

  if (err) return <Missing of={{ reason: 'provider-error', detail: err }} />;
  if (!data) return <div className="spinner">Loading holdings…</div>;

  const th = (key: SortKey, label: string, left = false) => (
    <th
      className={left ? 'left' : ''}
      onClick={() => { if (sort === key) setAsc(!asc); else { setSort(key); setAsc(false); } }}
    >
      {label}{sort === key ? (asc ? ' ▲' : ' ▼') : ''}
    </th>
  );

  const hasDiff = 'changes' in data.diff;

  return (
    <Panel
      title={`Holdings — ${rows.length} of ${stocks.length}`}
      right={
        <input
          className="field"
          placeholder="filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            background: 'var(--panel-2)', border: '1px solid var(--line)',
            color: 'var(--text)', padding: '4px 9px', borderRadius: 6,
            fontSize: 12, width: 160, fontFamily: 'var(--mono)',
          }}
        />
      }
      provenance={data.provenance}
    >
      {!hasDiff && (
        <NoteBox>
          <strong>Weight-change flagging is not active yet.</strong>{' '}
          {(data.diff as { unavailable: string }).unavailable} Because the issuer only serves the
          current file, manager activity is only observable as the difference between two
          published dates — so the app archives each day's file and the column fills in from the
          second run onward.
        </NoteBox>
      )}

      {data.dayChangeNote && (
        <div className="dimmer" style={{ fontSize: 11, marginBottom: 8 }}>{data.dayChangeNote}</div>
      )}

      {hasDiff && (
        <div style={{ marginBottom: 10, fontSize: 11.5 }} className="dimmer">
          Comparing issuer files {(data.diff as { fromDate: string }).fromDate} →{' '}
          {(data.diff as { toDate: string }).toDate} · one-way turnover{' '}
          <strong>{(data.diff as { turnoverPct: number }).turnoverPct.toFixed(2)}%</strong>
        </div>
      )}

      <div className="scroll">
        <table>
          <thead>
            <tr>
              {th('ticker', 'Ticker', true)}
              {th('name', 'Name', true)}
              {th('weight', 'Weight')}
              {th('delta', 'Δ weight')}
              {th('dayChange', 'Day change')}
              {th('sector', 'Sector', true)}
              {th('country', 'Country', true)}
              <th className="left">Theme</th>
              <th className="left">Venue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => {
              const raw = data.dayChange[h.ticker];
              const chg = dayChangePct(raw);
              const intraday = isIntraday(raw);
              const d = diffMap.get(h.ticker);
              return (
                <tr key={`${h.ticker}-${h.name}`}>
                  <td className="left"><strong>{h.ticker}</strong></td>
                  <td className="left muted" style={{ maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.name}>
                    {h.name}
                  </td>
                  <td>{h.weight.toFixed(2)}%</td>
                  <td>
                    {d && d.kind !== 'unchanged' ? (
                      <span className={`chip ${d.kind}`}>
                        {d.kind === 'added' ? 'NEW' : d.kind === 'removed' ? 'OUT' : `${d.deltaPct >= 0 ? '+' : '−'}${Math.abs(d.deltaPct).toFixed(2)}`}
                      </span>
                    ) : (
                      <span className="dimmer">—</span>
                    )}
                  </td>
                  <td
                    className={chg === null ? 'dimmer' : signClass(chg)}
                    title={intraday ? "Today's intraday change (delayed)" : 'Change to the last daily close'}
                  >
                    {chg === null ? '—' : fmt.pct(chg)}
                    {chg !== null && !intraday && <span className="dimmer"> ᴱᴼᴰ</span>}
                  </td>
                  <td className="left muted">{h.sector}</td>
                  <td className="left muted">{h.country}</td>
                  <td className="left muted">{h.subTheme}</td>
                  <td className="left dimmer">{h.exchange}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {Math.abs(cashWeight) > 0.005 && (
        <div className="dimmer" style={{ fontSize: 11, marginTop: 8 }}>
          Not shown: cash and currency positions, a net {cashWeight.toFixed(2)}% of the fund.
        </div>
      )}
    </Panel>
  );
}
