import type { PriceBar, Quote } from '../../types';
import type { SourceKind } from '../../util/provenance';

/**
 * The contract every market-data vendor must satisfy. Adding a vendor means
 * writing one of these and registering it — no analytics code changes.
 */
export interface MarketDataProvider {
  readonly id: string;
  readonly sourceKind: SourceKind;
  readonly label: string;
  /** Whether this vendor resolves non-US venues (matters for SK hynix etc.). */
  readonly supportsNonUs: boolean;
  /** Real-time vs delayed, for honest UI labelling. */
  readonly realtime: boolean;

  dailyBars(symbol: string, start: string, end: string): Promise<PriceBar[]>;
  quote(symbol: string): Promise<Quote>;
  /**
   * Batched intraday quotes, when the vendor supports it. One HTTP request for
   * N symbols instead of N requests — the difference between living inside a
   * free tier and exhausting it on a single holdings-table render.
   */
  quotes?(symbols: string[]): Promise<Map<string, Quote>>;
}

export class NotCoveredError extends Error {}
export class ProviderError extends Error {}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 404) throw new NotCoveredError(`404 for ${redact(url)}`);
  if (res.status === 429) {
    throw new ProviderError(`Rate limited (429) by ${new URL(url).host}`);
  }
  if (!res.ok) {
    throw new ProviderError(`HTTP ${res.status} from ${new URL(url).host}`);
  }
  return (await res.json()) as T;
}

/** Strip API keys before any error text can reach a log or the UI. */
export function redact(url: string): string {
  return url
    .replace(/([?&](token|apikey|api_token|apiKey)=)[^&]+/gi, '$1***')
    .replace(/\/v\d\/[a-f0-9]{32,}/gi, '/***');
}

export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}
