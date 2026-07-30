/**
 * Daily brief CLI — `npm run brief`.
 *
 * Archives today's holdings file (the step that accumulates the history that
 * manager-activity attribution depends on), builds the daily brief, prints it,
 * and saves it to briefs/YYYY-MM-DD.md.
 *
 * Scheduled by the launchd agent installed via scripts/install-daily.sh so a
 * brief lands automatically every trading day after the close.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config';
import { archiveToday, buildDailyBrief, briefToMarkdown } from '../services/briefService';
import { deliverBrief, notifyFailure } from '../deliver';

async function main(): Promise<void> {
  console.log(await archiveToday());

  const brief = await buildDailyBrief('1D');
  const md = briefToMarkdown(brief);

  // DATA_DIR is <repo>/server/data, so the repo root is two levels up.
  const dir = path.join(DATA_DIR, '..', '..', 'briefs');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${brief.date}.md`);
  await fs.writeFile(file, md, 'utf8');

  console.log('\n' + md + '\n');
  console.log(`saved: ${file}`);

  // Delivery runs last and cannot fail the job — the brief is already on disk.
  await deliverBrief(brief, md);
}

main().catch(async (err) => {
  console.error('[brief] fatal:', err);
  await notifyFailure(err);
  process.exitCode = 1;
});
