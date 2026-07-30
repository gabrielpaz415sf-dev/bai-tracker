/**
 * Brief delivery fan-out.
 *
 * Contract: the brief markdown is already written to disk before anything here
 * runs. Every channel is best-effort and reports its outcome; none of them can
 * throw into the caller. A silent delivery failure is worse than a noisy one —
 * you would simply stop receiving briefs and have no way to notice — so
 * failures are logged, and a failed *run* notifies too (see notifyFailure).
 */
import { config } from '../config';
import type { DailyBrief } from '../services/briefService';
import { notifyMacOS } from './notify';
import { emailBrief } from './email';

/** Strip the markdown emphasis the headline carries for the .md file. */
const plain = (s: string): string => s.replace(/\*\*/g, '').trim();

export async function deliverBrief(
  brief: DailyBrief,
  markdown: string,
): Promise<void> {
  const tasks: Array<Promise<void>> = [];

  if (config.delivery.notify) {
    tasks.push(
      notifyMacOS(
        `BAI — ${brief.date}`,
        plain(brief.headline),
        brief.synthetic ? 'SYNTHETIC DATA' : 'Daily brief ready',
      ).then((ok) => {
        console.log(ok ? '[deliver] notification posted' : '[deliver] notification skipped');
      }),
    );
  } else {
    console.log('[deliver] notification off (set BAI_NOTIFY=1)');
  }

  tasks.push(
    emailBrief(brief, markdown).then((r) => {
      console.log(
        r.sent
          ? `[deliver] emailed to ${config.delivery.email.to}`
          : `[deliver] email not sent — ${r.reason}`,
      );
    }),
  );

  await Promise.allSettled(tasks);
}

/**
 * Announce that the job itself died. Without this a broken cron is invisible:
 * the absence of a brief looks identical to a quiet market day.
 */
export async function notifyFailure(err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[deliver] run failed:', msg);
  if (config.delivery.notify) {
    await notifyMacOS('BAI brief FAILED', msg.slice(0, 200), 'No brief was written');
  }
}
