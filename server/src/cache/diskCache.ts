import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR } from '../config';

interface Entry<T> {
  key: string;
  storedAt: number;
  ttlSeconds: number;
  value: T;
}

function fileFor(key: string): string {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  return path.join(CACHE_DIR, `${safe}.${hash}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

export async function readCache<T>(
  key: string,
  ttlSeconds: number,
): Promise<{ value: T; ageSeconds: number; expired: boolean } | null> {
  try {
    const raw = await fs.readFile(fileFor(key), 'utf8');
    const entry = JSON.parse(raw) as Entry<T>;
    const ageSeconds = (Date.now() - entry.storedAt) / 1000;
    return { value: entry.value, ageSeconds, expired: ageSeconds > ttlSeconds };
  } catch {
    return null;
  }
}

export async function writeCache<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  await ensureDir();
  const entry: Entry<T> = { key, storedAt: Date.now(), ttlSeconds, value };
  const file = fileFor(key);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entry), 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Cache-aside with stale-on-error semantics.
 *
 * If the fetch throws and we hold an expired copy, we return the stale copy and
 * tell the caller how old it is, so the UI can label it rather than showing
 * nothing. A provider outage degrades freshness, not availability — but the
 * staleness is always visible, never hidden.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<{ value: T; fromCache: boolean; ageSeconds: number; stale: boolean }> {
  const hit = await readCache<T>(key, ttlSeconds);
  if (hit && !hit.expired) {
    return { value: hit.value, fromCache: true, ageSeconds: hit.ageSeconds, stale: false };
  }
  try {
    const fresh = await fetcher();
    await writeCache(key, fresh, ttlSeconds);
    return { value: fresh, fromCache: false, ageSeconds: 0, stale: false };
  } catch (err) {
    if (hit) {
      return {
        value: hit.value,
        fromCache: true,
        ageSeconds: hit.ageSeconds,
        stale: true,
      };
    }
    throw err;
  }
}

export async function clearCache(): Promise<void> {
  await fs.rm(CACHE_DIR, { recursive: true, force: true });
}
