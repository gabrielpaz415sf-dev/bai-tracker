import { fmt } from '../api';
import { Panel } from './Common';

/**
 * What the managers actually did — the one thing on this site no price feed
 * can tell you. Reads the diff between the issuer's last two published
 * holdings files, already computed server-side.
 */

export interface HoldingsDiff {
  fromDate: string;
  toDate: string;
  turnoverPct: number;
  changes: Array<{
    ticker: string;
    name: string;
    kind: 'added' | 'removed' | 'increased' | 'decreased' | 'unchanged';
    deltaPct: number;
    priorWeight: number | null;
    currentWeight: number | null;
  }>;
}

const dayName = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });

export function ManagerChanges({ diff }: { diff: HoldingsDiff | null | undefined }) {
  if (!diff) {
    return (
      <Panel title="What the managers changed">
        <div className="dimmer" style={{ fontSize: 12 }}>
          BlackRock publishes the holdings once per trading day; changes show up
          here as soon as two days can be compared.
        </div>
      </Panel>
    );
  }
  const real = diff.changes.filter((c) => c.kind !== 'unchanged');

  return (
    <Panel title={`What the managers changed — ${dayName(diff.fromDate)} vs ${dayName(diff.toDate)}`}>
      {real.length === 0 ? (
        <div className="dimmer" style={{ fontSize: 12 }}>No meaningful changes between the two days.</div>
      ) : (
        <>
          {real.slice(0, 8).map((c) => {
            const verb =
              c.kind === 'added' ? 'New position' :
              c.kind === 'removed' ? 'Sold out' :
              c.kind === 'increased' ? 'Bought more' : 'Sold some';
            const span =
              c.priorWeight !== null && c.currentWeight !== null
                ? `${c.priorWeight.toFixed(2)}% → ${c.currentWeight.toFixed(2)}%`
                : c.currentWeight !== null
                  ? `now ${c.currentWeight.toFixed(2)}%`
                  : c.priorWeight !== null
                    ? `was ${c.priorWeight.toFixed(2)}%, now 0`
                    : '';
            return (
              <div className="kv" key={c.ticker}>
                <span className="k">
                  <span className={`chip ${c.kind}`}>{verb}</span>{' '}
                  <strong>{c.ticker}</strong>{' '}
                  <span className="dimmer">{c.name.slice(0, 30)}</span>
                </span>
                <span className={`v ${c.deltaPct >= 0 ? 'up' : 'down'}`}>
                  {span} ({fmt.pp(c.deltaPct)})
                </span>
              </div>
            );
          })}
          <div className="dimmer" style={{ fontSize: 11, marginTop: 8 }}>
            They reshuffled {diff.turnoverPct.toFixed(2)}% of the fund between these two
            published holdings files.
          </div>
        </>
      )}
    </Panel>
  );
}
