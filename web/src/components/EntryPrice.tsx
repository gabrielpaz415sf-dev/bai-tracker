import { useEffect, useState } from 'react';
import { fmt, get, signClass, type Sourced } from '../api';
import { Missing, NoteBox, Panel, Stat } from './Common';

interface Horizon {
  horizonLabel: string;
  horizonTradingDays: number;
  sampleCount: number;
  bestPct: number;
  worstPct: number;
  medianPct: number;
  p25Pct: number;
  p75Pct: number;
  spreadPct: number;
  spreadPerSqrtYearPct: number;
  iqrPct: number;
  shareNegativePct: number;
  spreadVsMedianRatio: number;
  seriesSymbol: string;
  isProxy: boolean;
}

interface Dist {
  medianFinalUsd: number; p5FinalUsd: number; p25FinalUsd: number;
  p75FinalUsd: number; p95FinalUsd: number; bestFinalUsd: number; worstFinalUsd: number;
}

interface EntryData {
  horizons: Horizon[];
  dca: {
    contributionTotalUsd: number; periods: number; intervalLabel: string;
    lumpSum: Dist; dca: Dist; lumpSumWinRatePct: number; sampleCount: number;
    seriesSymbol: string; isProxy: boolean;
  } | null;
  gauges: {
    price: number; sma50: number | null; sma200: number | null;
    pctVsSma50: number | null; pctVsSma200: number | null;
    realizedVol30dPct: number | null; realizedVol90dPct: number | null;
    drawdownFrom52wHighPct: number | null; premiumDiscountPct: number | null;
  } | null;
  execution: {
    spreadUsd: number | null; spreadPctOfPrice: number | null;
    premiumDiscountPct: number | null; estimatedRoundTripPct: number | null;
    notes: string[];
  };
  scenarios: Sourced<Array<{
    label: string; description: string; exposureWeightPct: number;
    shockPct: number; fundImpactPct: number; basis: string;
  }>>;
  proxyNote: string;
  inceptionDate: string;
  historyTradingDays: number;
  disclaimer: string;
  error?: { reason: string; detail: string };
  message?: string;
}

const ok = (h: Horizon): boolean => !Number.isNaN(h.spreadPct);

/**
 * Box plot: whiskers span worst→best, the box spans p25→p75, the tick is the
 * median. A single bar can only show the extremes, which are exactly the part
 * driven by one lucky and one unlucky day; the box is where entries actually
 * landed, so it carries most of the meaning.
 */
function BoxPlot({
  worst, best, p25, p75, median, min, max,
}: {
  worst: number; best: number; p25: number; p75: number; median: number;
  min: number; max: number;
}) {
  const span = max - min || 1;
  const at = (v: number): number => ((v - min) / span) * 100;
  const clamp = (v: number): number => Math.max(0, Math.min(100, v));

  const wl = clamp(at(worst));
  const wr = clamp(at(best));
  const bl = clamp(at(p25));
  const br = clamp(at(p75));
  const md = clamp(at(median));
  const zero = clamp(at(0));

  return (
    <div className="boxplot" title={`worst buy date ${worst.toFixed(1)}% · middle half ran ${p25.toFixed(1)}% to ${p75.toFixed(1)}% · typical ${median.toFixed(1)}% · best buy date ${best.toFixed(1)}%`}>
      {min < 0 && max > 0 && <div className="bp-zero" style={{ left: `${zero}%` }} />}
      <div className="bp-whisker" style={{ left: `${wl}%`, width: `${Math.max(0.5, wr - wl)}%` }} />
      <div className="bp-box" style={{ left: `${bl}%`, width: `${Math.max(0.8, br - bl)}%` }} />
      <div className="bp-median" style={{ left: `${md}%` }} />
    </div>
  );
}

/** One horizon per row: label, box plot, and the numbers that matter. */
function HorizonRows({ rows }: { rows: Horizon[] }) {
  const usable = rows.filter(ok);
  if (usable.length === 0) {
    return <div className="dimmer" style={{ fontSize: 12 }}>No horizons computable from this history.</div>;
  }
  // Shared scale within a group so the rows are comparable to each other.
  const min = Math.min(...usable.map((h) => h.worstPct), 0);
  const max = Math.max(...usable.map((h) => h.bestPct), 0);

  return (
    <>
      <div className="hz-row hz-head">
        <span>If you held</span>
        <span>Worst result ← → best result</span>
        <span title="The middle result — half of all buy dates did better, half did worse">Typical result</span>
        <span title="How far apart the middle half of results were. A small number means most buy dates ended up similar.">Spread of typical results</span>
        <span title="Out of every buy date we tested, the share that were still down after holding this long">Ended down</span>
        <span title="Number of different buy dates tested">Dates tested</span>
      </div>
      {usable.map((h) => (
        <div className="hz-row" key={h.horizonLabel}>
          <span className="hz-label">{h.horizonLabel}</span>
          <BoxPlot
            worst={h.worstPct} best={h.bestPct} p25={h.p25Pct} p75={h.p75Pct}
            median={h.medianPct} min={min} max={max}
          />
          <span className={`mono ${signClass(h.medianPct)}`}>{fmt.pct(h.medianPct, 1)}</span>
          <span className="mono"><strong>{h.iqrPct.toFixed(1)}%</strong></span>
          <span className={`mono ${h.shareNegativePct > 0 ? 'down' : 'dimmer'}`}>
            {h.shareNegativePct.toFixed(0)}%
          </span>
          <span className="mono dimmer">{h.sampleCount}</span>
        </div>
      ))}
    </>
  );
}

/** Two outcome distributions on one shared dollar scale. */
function DcaCompare({ lump, dca, invested }: { lump: Dist; dca: Dist; invested: number }) {
  const min = Math.min(lump.worstFinalUsd, dca.worstFinalUsd, invested);
  const max = Math.max(lump.bestFinalUsd, dca.bestFinalUsd);
  const span = max - min || 1;
  const at = (v: number): number => ((v - min) / span) * 100;

  const Row = ({ label, d }: { label: string; d: Dist }) => (
    <div className="hz-row dca-row">
      <span className="hz-label">{label}</span>
      <div className="boxplot">
        <div className="bp-breakeven" style={{ left: `${at(invested)}%` }} title={`break-even ${fmt.usd(invested)}`} />
        <div className="bp-whisker" style={{ left: `${at(d.worstFinalUsd)}%`, width: `${Math.max(0.5, at(d.bestFinalUsd) - at(d.worstFinalUsd))}%` }} />
        <div className="bp-box" style={{ left: `${at(d.p25FinalUsd)}%`, width: `${Math.max(0.8, at(d.p75FinalUsd) - at(d.p25FinalUsd))}%` }} />
        <div className="bp-median" style={{ left: `${at(d.medianFinalUsd)}%` }} />
      </div>
      <span className="mono"><strong>{fmt.usd(d.medianFinalUsd)}</strong></span>
      <span className="mono down">{fmt.usd(d.worstFinalUsd)}</span>
      <span className="mono up">{fmt.usd(d.bestFinalUsd)}</span>
    </div>
  );

  return (
    <>
      <div className="hz-row dca-row hz-head">
        <span>Approach</span>
        <span>Worst ← what you ended up with → best</span>
        <span>Typical</span>
        <span>Worst case</span>
        <span>Best case</span>
      </div>
      <Row label="All at once" d={lump} />
      <Row label="Spread out" d={dca} />
      <div className="dimmer" style={{ fontSize: 10.5, marginTop: 6, fontFamily: 'var(--mono)' }}>
        the shaded box covers the middle half of all start dates · the white line is the typical result · the dotted line is the {fmt.usd(invested)} you put in
      </div>
    </>
  );
}

export function EntryPricePanel() {
  const [amount, setAmount] = useState(10000);
  const [periods, setPeriods] = useState(12);
  const [data, setData] = useState<EntryData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setErr(null);
    get<EntryData>(`/entry-price?amount=${amount}&periods=${periods}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: Error) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [amount, periods]);

  if (err) return <Missing of={{ reason: 'provider-error', detail: err }} />;
  if (!data) return <div className="spinner">Running historical simulations…</div>;
  if (data.error) {
    return (
      <>
        <Missing of={data.error} />
        {data.message && <NoteBox>{data.message}</NoteBox>}
      </>
    );
  }

  const bai = data.horizons.filter((h) => !h.isProxy && ok(h));
  const proxy = data.horizons.filter((h) => h.isProxy && ok(h));
  const shortest = bai[0];
  const longest = bai.at(-1);

  return (
    <>
      {/* ------------------------------------------------- the answer --- */}
      <section>
        <h2>Does entry timing matter?</h2>
        <Panel>
          {shortest && longest ? (
            <>
              {/*
                Leads with the two figures that survive scrutiny: the middle-50%
                band and the share of losing entries. The previous version led
                with a "spread per year held" number that divided a √t quantity
                by t, inflating short horizons ~7x and inventing most of the
                decline it reported.
              */}
              <div className="verdict">
                Across every entry day in BAI's history, the middle half of outcomes spanned{' '}
                <strong>{shortest.iqrPct.toFixed(1)}%</strong> at {shortest.horizonLabel} and{' '}
                <strong>{longest.iqrPct.toFixed(1)}%</strong> at {longest.horizonLabel} — the range
                of results got <em>wider</em>, not narrower. What fell was the chance of being
                behind: <strong>{shortest.shareNegativePct.toFixed(0)}%</strong> of entry days were
                underwater at {shortest.horizonLabel} versus{' '}
                <strong>{longest.shareNegativePct.toFixed(0)}%</strong> at {longest.horizonLabel}.
              </div>

              <div className="stat-grid">
                <Stat
                  label={`Ended down after ${shortest.horizonLabel}`}
                  value={`${shortest.shareNegativePct.toFixed(0)}%`}
                  cls={shortest.shareNegativePct > 0 ? 'down' : 'up'}
                  hint="Share of historical entry days that ended below break-even at this horizon"
                />
                <Stat
                  label={`Ended down after ${longest.horizonLabel}`}
                  value={`${longest.shareNegativePct.toFixed(0)}%`}
                  cls={longest.shareNegativePct > 0 ? 'down' : 'up'}
                />
                <Stat
                  label={`Typical result after ${longest.horizonLabel}`}
                  value={fmt.pct(longest.medianPct, 1)}
                  cls={signClass(longest.medianPct)}
                />
                <Stat
                  label="Range of results"
                  value={longest.spreadPct > shortest.spreadPct ? 'WIDENS' : 'narrows'}
                  hint="The gap between the best and worst buy date gets bigger the longer you hold, not smaller — more time means more room for results to drift apart"
                />
                <Stat label="Buy dates tested" value={String(shortest.sampleCount)} />
                <Stat
                  label="Data we have"
                  value={`${data.historyTradingDays}d`}
                  hint={`Since inception ${data.inceptionDate}`}
                />
              </div>

              <div className="no-driver" style={{ marginTop: 14 }}>
                <strong>Holding longer did not make results more predictable.</strong> The gap between
                the best and worst buy date actually got <em>bigger</em>: {longest.spreadPct.toFixed(0)}%
                at {longest.horizonLabel} versus {shortest.spreadPct.toFixed(0)}% at{' '}
                {shortest.horizonLabel}. That makes sense — more time means more room to drift
                apart. What holding longer <em>did</em> change is how often you were behind at the
                end. So the takeaway is not "timing stops mattering", it is "you were far less
                likely to be down".
              </div>
            </>
          ) : (
            <Missing of={{ reason: 'insufficient-history', detail: 'Not enough BAI history to evaluate any holding period.' }} />
          )}

          <div className="controls" style={{ marginTop: 16, marginBottom: 0 }}>
            <div className="field">
              <label>Amount to invest ($)</label>
              <input type="number" min={100} step={500} value={amount}
                onChange={(e) => setAmount(Math.max(100, Number(e.target.value) || 100))} />
            </div>
            <div className="field">
              <label>Spread over how many months</label>
              <input type="number" min={2} max={36} value={periods}
                onChange={(e) => setPeriods(Math.min(36, Math.max(2, Number(e.target.value) || 2)))} />
            </div>
            <div className="dimmer" style={{ fontSize: 11.5, maxWidth: 420 }}>
              Changes the comparison below. Every possible start date in BAI's history gets tested,
              not just a few.
            </div>
          </div>
        </Panel>
      </section>

      {/* ---------------------------------------------- BAI horizons --- */}
      <section>
        <h2>What happened at each holding length — BAI's real history</h2>
        <Panel>
          <HorizonRows rows={bai} />
          <NoteBox>
            Each row tests <strong>every single day</strong> you could have bought in BAI's history —
            not a handful of samples. The shaded box shows where the middle half of those buy
            dates ended up. The thin line stretching past it reaches the one best and one worst
            day, which is why it swings so much further than the box.
          </NoteBox>
        </Panel>
      </section>

      {/* -------------------------------------------- proxy horizons --- */}
      {proxy.length > 0 && (
        <section>
          <h2>
            Longer periods — using <span className="chip proxy">{proxy[0]?.seriesSymbol}</span> as a stand-in, not BAI
          </h2>
          <Panel>
            {/*
              Deliberately a separate section on its own scale rather than extra
              rows in the table above. Continuous rows would read as one series,
              and the 10-year proxy's range is several times BAI's — merging them
              would both mislead and flatten the BAI rows into slivers.
            */}
            <HorizonRows rows={proxy} />
            <div className="no-driver" style={{ marginTop: 12 }}>
              <strong>These rows are not BAI.</strong> {data.proxyNote}
            </div>
          </Panel>
        </section>
      )}

      {/* ------------------------------------------- lump sum vs DCA --- */}
      <section>
        <h2>Invest it all at once, or spread it out? — {fmt.usd(amount)}</h2>
        <Panel>
          {!data.dca ? (
            <div className="missing">
              <div className="reason-tag">Not enough history</div>
              <div className="why">
                {periods} monthly contributions plus the holding period exceeds BAI's available
                history. Reduce the number of periods.
              </div>
            </div>
          ) : (
            <>
              <DcaCompare
                lump={data.dca.lumpSum}
                dca={data.dca.dca}
                invested={data.dca.contributionTotalUsd}
              />
              <div className="stat-grid" style={{ marginTop: 16 }}>
                <Stat
                  label="Putting it all in at once won"
                  value={`${data.dca.lumpSumWinRatePct.toFixed(1)}%`}
                  hint="Out of every start date tested, how often investing the whole amount immediately beat spreading it out"
                />
                <Stat label="Start dates tested" value={String(data.dca.sampleCount)} />
                <Stat
                  label="All-at-once: best minus worst"
                  value={fmt.usd(data.dca.lumpSum.bestFinalUsd - data.dca.lumpSum.worstFinalUsd)}
                  hint="Best minus worst final value — the width of the outcome band"
                />
                <Stat
                  label="Spread-out: best minus worst"
                  value={fmt.usd(data.dca.dca.bestFinalUsd - data.dca.dca.worstFinalUsd)}
                />
                {data.dca.isProxy && (
                  <Stat label="Series" value={<span className="chip proxy">PROXY {data.dca.seriesSymbol}</span>} />
                )}
              </div>
              <NoteBox>
                Compare the <strong>widths</strong>, not just the medians. DCA gives up some
                upside for a narrower band — that trade-off is the whole point, and an average
                would hide it. Uninvested cash in the DCA arm earns nothing here, which
                understates DCA whenever short-term rates are meaningful.
              </NoteBox>
            </>
          )}
        </Panel>
      </section>

      {/* --------------------------------------------------- gauges --- */}
      <section>
        <h2>Where the price sits today (not a prediction)</h2>
        <div className="grid cols-2">
          <Panel title="Where the price sits">
            {data.gauges ? (
              <div className="stat-grid">
                <Stat label="Last price" value={fmt.num(data.gauges.price)} />
                <Stat label="vs its 50-day average" value={fmt.pct(data.gauges.pctVsSma50)} cls={signClass(data.gauges.pctVsSma50)} />
                <Stat label="vs its 200-day average" value={fmt.pct(data.gauges.pctVsSma200)} cls={signClass(data.gauges.pctVsSma200)} />
                <Stat label="Below its 1-year high by" value={fmt.pct(data.gauges.drawdownFrom52wHighPct)} cls={signClass(data.gauges.drawdownFrom52wHighPct)} />
                <Stat label="How jumpy, last 30 days" value={data.gauges.realizedVol30dPct === null ? '—' : `${data.gauges.realizedVol30dPct.toFixed(1)}%`} />
                <Stat label="How jumpy, last 90 days" value={data.gauges.realizedVol90dPct === null ? '—' : `${data.gauges.realizedVol90dPct.toFixed(1)}%`} />
                <Stat label="Premium / discount" value={data.gauges.premiumDiscountPct === null ? '—' : fmt.pct(data.gauges.premiumDiscountPct)} />
              </div>
            ) : (
              <Missing of={{ reason: 'insufficient-history', detail: 'Not enough price history for moving averages.' }} />
            )}
            <NoteBox>
              These describe where the price has been. They are <strong>not</strong> signals.
              Price above a moving average does not mean expensive, and below does not mean cheap
              — a fund can sit above its 200-day for years, or below it for years. No threshold
              here implies an action.
            </NoteBox>
          </Panel>

          <Panel title="What it costs you to buy and sell">
            <div className="stat-grid">
              <Stat label="Gap between buy and sell price" value={data.execution.spreadUsd === null ? '—' : fmt.usd(data.execution.spreadUsd, 3)} />
              <Stat label="Spread % of price" value={data.execution.spreadPctOfPrice === null ? '—' : `${data.execution.spreadPctOfPrice.toFixed(3)}%`} />
              <Stat label="Premium / discount" value={data.execution.premiumDiscountPct === null ? '—' : fmt.pct(data.execution.premiumDiscountPct)} />
              <Stat label="Cost to buy then sell" value={data.execution.estimatedRoundTripPct === null ? '—' : `${data.execution.estimatedRoundTripPct.toFixed(3)}%`} />
            </div>
            <div style={{ marginTop: 12 }}>
              {data.execution.notes.map((n, i) => (
                <div key={i} className="note-box" style={{ marginTop: 8 }}>{n}</div>
              ))}
            </div>
          </Panel>
        </div>
      </section>

      {/* --------------------------------------------- concentration --- */}
      <section>
        <h2>What a big drop in one area would do</h2>
        <Panel>
          {data.scenarios.ok ? (
            data.scenarios.value.map((s) => (
              <div className="scenario" key={s.label}>
                <div className="head">
                  <span className="label">{s.label}</span>
                  <span className="impact down">{fmt.pp(s.fundImpactPct)}</span>
                </div>
                <div className="desc">{s.description}</div>
                <div className="basis">
                  {s.basis} Shock of {s.shockPct}% applied to {s.exposureWeightPct.toFixed(2)}% of
                  NAV → {s.exposureWeightPct.toFixed(2)}% × {s.shockPct}% ={' '}
                  {s.fundImpactPct.toFixed(2)}%.
                </div>
              </div>
            ))
          ) : (
            <Missing of={data.scenarios} />
          )}
          <NoteBox>
            These are <strong>arithmetic, not forecasts</strong>. Each is the mechanical
            consequence of the fund's own published weights given an assumed shock — shown so the
            concentration is concrete rather than abstract. The shock sizes are assumptions,
            stated on each row, not predictions.
          </NoteBox>
        </Panel>
      </section>

      <div className="no-driver" style={{ background: '#12202e', borderColor: '#24405c', color: '#9ec5ff' }}>
        <strong>This is an education tool, not a buy signal.</strong> Nothing here is a
        recommendation, a forecast, or a price target. Every number here is a record of what
        past buy dates actually produced — not a prediction of what a future one will.
      </div>
    </>
  );
}
