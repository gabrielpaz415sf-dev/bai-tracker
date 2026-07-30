import { fmt, signClass, type Sourced } from '../api';
import { Missing, Panel, Show, Stat } from './Common';

interface ContributionRow {
  ticker: string;
  name: string;
  sector: string;
  country: string;
  subTheme: string;
  startWeight: number;
  endWeight: number | null;
  returnPct: number;
  contributionPct: number;
  priceStale: boolean;
  priceAsOf: string;
}

interface RollupRow {
  key: string;
  label: string;
  startWeight: number;
  contributionPct: number;
  groupReturnPct: number;
  memberCount: number;
}

interface Beta {
  benchmarkSymbol: string;
  beta: number;
  rSquared: number;
  estimationWindowDays: number;
  benchmarkReturnPct: number;
  systematicPct: number;
  idiosyncraticPct: number;
  reliable: boolean;
}

interface ManagerEffect {
  frozenPortfolioReturnPct: number;
  actualReturnPct: number;
  tradingEffectPct: number;
  turnoverPct: number;
  notableChanges: Array<{ ticker: string; kind: string; deltaPct: number }>;
  computable: boolean;
}

interface WeightBasis {
  asOfDate: string;
  isWindowStart: boolean;
  driftDays: number;
  reliable: boolean;
  reason: string;
}

export interface AttributionData {
  weightBasis: WeightBasis;
  newsWindow: { from: string; to: string; cappedFromWindow: boolean };
  timeframe: { key: string; label: string; startDate: string; endDate: string; tradingDays: number; clippedToInception: boolean };
  fundReturnPct: Sourced<number>;
  contributions: ContributionRow[];
  topContributors: ContributionRow[];
  topDetractors: ContributionRow[];
  bySector: RollupRow[];
  bySubTheme: RollupRow[];
  byCountry: RollupRow[];
  residualPct: number;
  coveragePct: number;
  staleHoldingsCount: number;
  beta: Sourced<Beta>;
  managerEffect: Sourced<ManagerEffect>;
  narrative: {
    headline: string;
    claims: Array<{ text: string; citations: Array<{ kind: string; label: string; url?: string; asOf: string }> }>;
    noClearDriver: boolean;
    caveats: string[];
    generatedAt: string;
  };
}

/** Horizontal diverging bar. Scale is shared across rows so lengths compare. */
function ContribBar({ row, scale }: { row: ContributionRow; scale: number }) {
  // Sized by the stock's own move, matching the number printed beside it.
  const pct = (Math.abs(row.returnPct) / scale) * 50;
  const positive = row.returnPct >= 0;
  return (
    <div className="contrib-row">
      <div className="contrib-name" title={`${row.name} · ${row.sector}`}>
        <strong>{row.ticker}</strong>{' '}
        {row.priceStale && (
          <span
            className="chip stale"
            title={`This is its home market's ${row.priceAsOf.slice(0, 10)} close, struck hours before the US close. A live quote may already show a newer session.`}
          >
            {row.priceAsOf.slice(5, 10)} CLOSE
          </span>
        )}
      </div>
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
      <div className={`contrib-val ${signClass(row.returnPct)}`}>
        {fmt.pct(row.returnPct)}
      </div>
      <div className="contrib-weight">{row.startWeight.toFixed(2)}%</div>
    </div>
  );
}

/** Same column labels as the live panel, for the same reason. */
function ContribHead() {
  return (
    <div className="contrib-head">
      <span>Stock</span>
      <span>How much it moved</span>
      <span title="How much of BAI this holding was at the start of the period">% of fund</span>
    </div>
  );
}

function Rollup({ rows, title }: { rows: RollupRow[]; title: string }) {
  const scale = Math.max(...rows.map((r) => Math.abs(r.contributionPct)), 0.01);
  return (
    <Panel title={title}>
      <div className="rollup-row dimmer" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        <span>Group</span><span>How this group did</span><span style={{ textAlign: 'right' }}>Avg move</span><span style={{ textAlign: 'right' }}>Size</span>
      </div>
      {rows.map((r) => {
        const pct = (Math.abs(r.contributionPct) / scale) * 50;
        const positive = r.contributionPct >= 0;
        return (
          <div className="rollup-row" key={r.key}>
            <span title={`${r.memberCount} holdings · avg move ${fmt.pct(r.groupReturnPct)}`}>
              {r.label} <span className="dimmer">({r.memberCount})</span>
            </span>
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
            <span className={signClass(r.groupReturnPct)} style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
              {fmt.pct(r.groupReturnPct)}
            </span>
            <span className="dimmer" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
              {r.startWeight.toFixed(1)}%
            </span>
          </div>
        );
      })}
    </Panel>
  );
}

/**
 * The at-a-glance answer, before any methodology.
 *
 * Everything below this panel is a decomposition of one number, so that number
 * — and how much to trust the split of it — belongs first. The quality badge is
 * deliberately loud: the same table of contributions means something quite
 * different at 1D (weights are real) than at 1Y (weights are a stand-in).
 */
function Overview({ data }: { data: AttributionData }) {
  const wb = data.weightBasis;
  const ret = data.fundReturnPct;
  const top = data.topContributors[0];
  const bottom = data.topDetractors[0];
  const themes = [...data.bySubTheme].sort((a, b) => b.contributionPct - a.contributionPct);
  const bestTheme = themes[0];
  const worstTheme = themes[themes.length - 1];

  return (
    <section>
      <h2>Overview — {data.timeframe.label}</h2>
      <Panel>
        <div className="quote-row">
          <span className={`quote-price ${ret.ok ? signClass(ret.value) : ''}`}>
            {ret.ok ? fmt.pct(ret.value) : '—'}
          </span>
          <span className="muted">
            {data.timeframe.startDate} → {data.timeframe.endDate} ·{' '}
            {data.timeframe.tradingDays} trading days
          </span>
          <span className={`chip ${wb.reliable ? 'added' : 'stale'}`}>
            {wb.reliable ? 'NUMBERS ADD UP' : 'ROUGH GUIDE ONLY'}
          </span>
        </div>

        <div className="stat-grid">
          <Stat
            label="Biggest contributor"
            value={top ? `${top.ticker} ${fmt.pp(top.contributionPct)}` : '—'}
            cls={top ? 'up' : ''}
            hint={top ? `${top.name} · ${top.startWeight.toFixed(2)}% weight · ${fmt.pct(top.returnPct)}` : undefined}
          />
          <Stat
            label="Biggest drag"
            value={bottom ? `${bottom.ticker} ${fmt.pp(bottom.contributionPct)}` : '—'}
            cls={bottom ? 'down' : ''}
            hint={bottom ? `${bottom.name} · ${bottom.startWeight.toFixed(2)}% weight · ${fmt.pct(bottom.returnPct)}` : undefined}
          />
          <Stat
            label="Strongest theme"
            value={bestTheme ? `${bestTheme.label} ${fmt.pp(bestTheme.contributionPct)}` : '—'}
            cls={bestTheme ? signClass(bestTheme.contributionPct) : ''}
          />
          <Stat
            label="Weakest theme"
            value={worstTheme ? `${worstTheme.label} ${fmt.pp(worstTheme.contributionPct)}` : '—'}
            cls={worstTheme ? signClass(worstTheme.contributionPct) : ''}
          />
          <Stat
            label="Beat/lagged the market by"
            value={data.beta.ok ? fmt.pp(data.beta.value.idiosyncraticPct) : '—'}
            cls={data.beta.ok ? signClass(data.beta.value.idiosyncraticPct) : ''}
            hint="How much of the move was BAI's own doing rather than the whole market moving"
          />
          <Stat label="Share of fund we could price" value={`${data.coveragePct.toFixed(1)}%`} hint="Some holdings (private companies, or markets with no data feed) have no price, so they are left out rather than guessed at" />
        </div>

        {/*
          The single most important disclosure on this page. Without it the 1Y
          table looks exactly as authoritative as the 1D one, and it is not.
        */}
        <div className={wb.reliable ? 'note-box' : 'no-driver'} style={{ marginTop: 14 }}>
          <strong>
            {wb.reliable
              ? 'Start weights are from this window.'
              : `Start weights are from ${wb.asOfDate}, not ${data.timeframe.startDate}.`}
          </strong>{' '}
          {wb.reason}
        </div>
      </Panel>
    </section>
  );
}

export function AttributionView({ data }: { data: AttributionData }) {
  const scale = Math.max(
    ...[...data.topContributors, ...data.topDetractors].map((r) => Math.abs(r.returnPct)),
    1,
  );

  return (
    <>
      <Overview data={data} />

      {/* ------------------------------------------------- narrative --- */}
      <section>
        <h2>Why is it {data.fundReturnPct.ok && data.fundReturnPct.value >= 0 ? 'up' : 'down'}? — {data.timeframe.label}</h2>
        <div className="panel narrative">
          <div className="headline">{data.narrative.headline}</div>

          {data.narrative.noClearDriver && (
            <div className="no-driver">
              <strong>No clear driver identified.</strong> The ranking below shows what moved,
              but no news covering the largest movers was returned for this window. The move is
              unexplained by the data available here — which is not the same as unexplained.
            </div>
          )}

          {/*
            A long window cannot be "explained" by a bounded page of articles.
            Saying which days were actually searched stops the citations below
            from implying coverage they do not have.
          */}
          {data.newsWindow.cappedFromWindow && (
            <div className="note-box" style={{ marginTop: 0, marginBottom: 10 }}>
              News was searched over <strong>{data.newsWindow.from} → {data.newsWindow.to}</strong>,
              not the full {data.timeframe.label} window. Providers return a bounded page of
              articles, so a multi-month query yields recent items regardless — these are what is
              being written about the top movers lately, not a history of the whole period.
            </div>
          )}

          {data.narrative.claims.map((c, i) => (
            <div className="claim" key={i}>
              <div className="text">{c.text}</div>
              <div className="cites">
                {c.citations.map((cite, j) => (
                  <div className="cite" key={j}>
                    <span className="kind">{cite.kind}</span>
                    {cite.url ? (
                      <a href={cite.url} target="_blank" rel="noreferrer noopener">{cite.label}</a>
                    ) : (
                      cite.label
                    )}
                    <span className="dimmer"> · {fmt.date(cite.asOf)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {data.narrative.caveats.length > 0 && (
            <div className="caveats">
              {data.narrative.caveats.map((c, i) => (
                <div className="caveat" key={i}>{c}</div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------- reconciliation --- */}
      <section>
        <h2>Do the numbers add up?</h2>
        <div className="grid cols-2">
          <Panel title="Adding up the pieces">
            <div className="stat-grid">
              <Stat
                label="What the fund actually did"
                value={data.fundReturnPct.ok ? fmt.pct(data.fundReturnPct.value) : '—'}
                cls={data.fundReturnPct.ok ? signClass(data.fundReturnPct.value) : ''}
              />
              <Stat
                label="All holdings added up"
                value={fmt.pp(data.contributions.reduce((a, r) => a + r.contributionPct, 0))}
              />
              <Stat
                label="Gap left over"
                value={fmt.pp(data.residualPct)}
                hint="The fund's real return minus the sum of its holdings. It is not zero because we hold each position at its starting size, while in reality the managers bought and sold during the period."
              />
              <Stat label="Share of fund priced" value={`${data.coveragePct.toFixed(1)}%`} />
            </div>
            <div className="note-box">
              A holding's effect on the fund is <strong>how big it was × how much it moved</strong>. So a
              stock that is 6% of the fund and falls 10% drags the whole fund down about 0.6%. We
              use its size at the <em>start</em> of the period, because using the end size would
              give a winner credit for growing into a bigger position. Any leftover gap is shown
              rather than hidden — it tells you how much trading happened in between.
            </div>
            {/* When the residual is bigger than the return, the bridge is not a bridge. */}
            {data.fundReturnPct.ok &&
              Math.abs(data.residualPct) > Math.abs(data.fundReturnPct.value) && (
                <div className="no-driver" style={{ marginTop: 10 }}>
                  <strong>These numbers don't add up, and that's the honest answer.</strong> The
                  leftover gap ({fmt.pp(data.residualPct)}) is bigger than the fund's whole move (
                  {fmt.pct(data.fundReturnPct.value)}), so the per-holding figures below can't be
                  read as an explanation of it. Over a stretch this long the managers bought and
                  sold a lot, and{' '}
                  {data.weightBasis.isWindowStart
                    ? "holding every position at its starting size stops describing what the fund actually owned."
                    : `the position sizes we have are from ${data.weightBasis.asOfDate} — long after this period began.`}
                </div>
              )}
          </Panel>

          <Panel title="Was it the whole market, or BAI's own picks?">
            <Show data={data.beta}>
              {(b) => (
                <>
                  <div className="stat-grid">
                    <Stat label={`${b.benchmarkSymbol} (the benchmark)`} value={fmt.pct(b.benchmarkReturnPct)} cls={signClass(b.benchmarkReturnPct)} />
                    <Stat label="How amplified vs the market" value={`${b.beta.toFixed(2)}x`} hint={`When the benchmark moves 1%, BAI has historically moved about ${b.beta.toFixed(2)}% — measured over the last ${b.estimationWindowDays} trading days`} />
                    <Stat label="How well that pattern fits" value={`${(b.rSquared * 100).toFixed(0)}%`} cls={b.reliable ? '' : 'down'} hint="How much of BAI's day-to-day movement the benchmark explains. Below 50% and we refuse to split the move." />
                    <Stat label="Due to the market" value={fmt.pp(b.systematicPct)} cls={signClass(b.systematicPct)} hint="The part of the move you would expect just from the broad tech market doing what it did" />
                    <Stat label="Due to BAI's own holdings" value={fmt.pp(b.idiosyncraticPct)} cls={signClass(b.idiosyncraticPct)} hint="What is left after removing the market's influence — this is the part that is genuinely about this fund" />
                  </div>
                  {!b.reliable && (
                    <div className="no-driver" style={{ marginTop: 10 }}>
                      <strong>Not splitting this one.</strong> {b.benchmarkSymbol} only explains{' '}
                      {(b.rSquared * 100).toFixed(0)}% of BAI's day-to-day movement, and this app
                      requires at least 50% before it will claim how much of a move was "the
                      market" versus "this fund". The numbers above are shown so you can see them,
                      but don't lean on them.
                    </div>
                  )}
                </>
              )}
            </Show>
          </Panel>
        </div>
      </section>

      {/* ----------------------------------------- manager decisions --- */}
      <section>
        <h2>What the managers changed</h2>
        <Panel>
          <Show data={data.managerEffect}>
            {(m) =>
              m.computable ? (
                <>
                  <div className="stat-grid">
                    <Stat label="If they had never traded" value={fmt.pct(m.frozenPortfolioReturnPct)} cls={signClass(m.frozenPortfolioReturnPct)} hint="What the starting lineup would have returned if left completely alone" />
                    <Stat label="What actually happened" value={fmt.pct(m.actualReturnPct)} cls={signClass(m.actualReturnPct)} />
                    <Stat label="Difference their trades made" value={fmt.pp(m.tradingEffectPct)} cls={signClass(m.tradingEffectPct)} hint="The gap between the two numbers on the left — positive means their buying and selling helped" />
                    <Stat label="How much they reshuffled" value={`${m.turnoverPct.toFixed(1)}%`} hint="Share of the portfolio that changed hands between the two published holdings files" />
                  </div>
                  {m.notableChanges.length > 0 && (
                    <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {m.notableChanges.map((c) => (
                        <span key={c.ticker} className={`chip ${c.kind}`}>
                          {c.ticker} {c.kind} {c.deltaPct >= 0 ? '+' : '−'}
                          {Math.abs(c.deltaPct).toFixed(2)}pp
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="missing">
                  <div className="reason-tag">Needs two archived holdings files</div>
                  <div className="why">
                    The issuer only serves today's holdings file, so manager activity is only
                    visible as the difference between two published dates. This archive does not
                    yet span the selected window. It fills in automatically as the app runs daily.
                  </div>
                </div>
              )
            }
          </Show>
        </Panel>
      </section>

      {/* --------------------------------------------- contributors --- */}
      <section>
        <h2>What helped and what hurt — {data.timeframe.label}</h2>
        <div className="grid cols-2">
          <Panel title="Helped the most">
            <ContribHead />
            {data.topContributors.length === 0 ? (
              <div className="missing"><div className="why">No positive contributors in this window.</div></div>
            ) : (
              data.topContributors.map((r) => <ContribBar key={r.ticker} row={r} scale={scale} />)
            )}
          </Panel>
          <Panel title="Hurt the most">
            <ContribHead />
            {data.topDetractors.length === 0 ? (
              <div className="missing"><div className="why">No detractors in this window.</div></div>
            ) : (
              data.topDetractors.map((r) => <ContribBar key={r.ticker} row={r} scale={scale} />)
            )}
          </Panel>
        </div>
      </section>

      {/* -------------------------------------------------- rollups --- */}
      <section>
        <h2>Grouped by theme, industry and country</h2>
        <div className="grid cols-3">
          <Rollup rows={data.bySubTheme} title="By theme" />
          <Rollup rows={data.bySector} title="By industry" />
          <Rollup rows={data.byCountry} title="By country" />
        </div>
      </section>

      {/* ------------------------------------------ full contribution --- */}
      <section>
        <h2>Every holding, one row each</h2>
        <Panel>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th className="left">Ticker</th>
                  <th className="left">Name</th>
                  <th>Size at start</th>
                  <th>How it moved</th>
                  <th className="left">Theme</th>
                  <th className="left">Price date</th>
                </tr>
              </thead>
              <tbody>
                {data.contributions.map((r) => (
                  <tr key={r.ticker}>
                    <td className="left"><strong>{r.ticker}</strong></td>
                    <td className="left muted" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</td>
                    <td>{r.startWeight.toFixed(2)}%</td>
                    <td className={signClass(r.returnPct)}>{fmt.pct(r.returnPct)}</td>
                    <td className="left muted">{r.subTheme}</td>
                    <td className="left dimmer">
                      {fmt.date(r.priceAsOf)}{' '}
                      {r.priceStale && <span className="chip stale" title="Home market closed before the US did, so this is an earlier session than the US names above">HOME MKT</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.staleHoldingsCount > 0 && (
            <div className="note-box">
              <strong>{data.staleHoldingsCount} of these holdings trade in Asia</strong>, where the
              market closes before the US one opens. Korea shuts at 2:30am ET and Taiwan at 1:30am
              ET, so their "same day" as a US stock ended roughly 14 hours earlier. The dates in the
              last column are the sessions we actually used.
              <br />
              <br />
              This is why a live quote can disagree with this page. If you look up SK hynix on a US
              evening, Korea has already <em>started the next day</em> — you'd be seeing tomorrow's
              session, not the one measured here. Both numbers are right; they're different days.
            </div>
          )}
        </Panel>
      </section>
    </>
  );
}

export function AttributionPanel({ data }: { data: Sourced<AttributionData> | null }) {
  if (!data) return <div className="spinner">Computing attribution…</div>;
  if (!data.ok) return <Missing of={data} />;
  return <AttributionView data={data.value} />;
}
