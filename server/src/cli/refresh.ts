/**
 * Daily refresh CLI — run this from cron (or launchd) once per business day,
 * after ~18:00 ET, when iShares has published the day's holdings file:
 *
 *   0 18 * * 1-5  cd /path/to/bai-tracker && npm run refresh
 *
 * It archives the day's holdings snapshot (which is what makes weight-change
 * flagging and manager-effect attribution possible) and warms the price cache
 * so the first dashboard load of the day is instant.
 */
import { loadHoldings, getOverview, getAttribution } from '../services/fundService';

async function main(): Promise<void> {
  console.log(`[refresh] ${new Date().toISOString()}`);

  const holdings = await loadHoldings();
  if (holdings.ok) {
    console.log(
      `[refresh] holdings snapshot archived for ${holdings.value.asOfDate} ` +
        `(${holdings.value.holdings.length} rows, ${holdings.provenance.reliability})`,
    );
  } else {
    console.error(`[refresh] holdings FAILED: ${holdings.detail}`);
  }

  await getOverview();
  console.log('[refresh] overview cache warmed');

  const attr = await getAttribution('1D');
  if (attr.ok) {
    console.log('[refresh] 1D attribution computed');
  } else {
    console.error(`[refresh] attribution FAILED: ${attr.detail}`);
  }

  console.log('[refresh] done');
}

main().catch((err) => {
  console.error('[refresh] fatal:', err);
  process.exitCode = 1;
});
