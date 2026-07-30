/**
 * macOS notification centre delivery.
 *
 * Uses osascript rather than a native binding so there is nothing to compile
 * and nothing to install. The daily job runs as a launchd *user* agent, which
 * is what gives it a GUI session to post into; the same call from a system
 * daemon would silently do nothing.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * AppleScript string literals accept only backslash and double-quote escapes,
 * and a stray newline is a syntax error rather than a rendered line break —
 * so newlines are folded to spaces. Notification bodies are single-line at
 * display time anyway.
 */
function applescriptString(s: string): string {
  return s.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

/**
 * Post a banner. Resolves either way: a notification is a convenience, and
 * failing to show one must never fail the job that produced the content.
 */
export async function notifyMacOS(
  title: string,
  message: string,
  subtitle?: string,
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;

  const parts = [
    `display notification "${applescriptString(message)}"`,
    `with title "${applescriptString(title)}"`,
  ];
  if (subtitle) parts.push(`subtitle "${applescriptString(subtitle)}"`);

  try {
    await run('osascript', ['-e', parts.join(' ')]);
    return true;
  } catch (err) {
    console.error(
      '[deliver] notification failed:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
