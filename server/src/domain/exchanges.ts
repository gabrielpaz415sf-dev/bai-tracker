/**
 * Foreign-market timing.
 *
 * BAI holds non-US names (SK hynix on KRX is its largest position). Those
 * markets close many hours before the US session does, so on any given US
 * trading day their "latest close" is genuinely older than the fund's own
 * closing price.
 *
 * This matters for same-day attribution specifically. If SK hynix is ~6.7% of
 * the fund and we attribute today's fund move using a Korean close struck
 * ~14 hours before the US close, that 6.7% of the portfolio contributes a
 * return from *yesterday's* information. The number is not wrong, but it does
 * not mean what a reader assumes it means, so the engine marks these rows and
 * the UI says so out loud.
 */

export interface ExchangeInfo {
  code: string;
  name: string;
  country: string;
  ianaTz: string;
  /** Local close time, 24h. */
  closeLocal: string;
  /** UTC hour of close (standard time; DST shifts this by an hour). */
  approxCloseUtcHour: number;
  /** True when this venue closes before the 21:00 UTC US equity close. */
  closesBeforeUsClose: boolean;
  /** Suffix used by most vendors for this venue. */
  vendorSuffix: string;
}

const EXCHANGES: Record<string, ExchangeInfo> = {
  XKRX: {
    code: 'XKRX',
    name: 'Korea Exchange',
    country: 'South Korea',
    ianaTz: 'Asia/Seoul',
    closeLocal: '15:30',
    approxCloseUtcHour: 6.5,
    closesBeforeUsClose: true,
    vendorSuffix: '.KS',
  },
  XTAI: {
    code: 'XTAI',
    name: 'Taiwan Stock Exchange',
    country: 'Taiwan',
    ianaTz: 'Asia/Taipei',
    closeLocal: '13:30',
    approxCloseUtcHour: 5.5,
    closesBeforeUsClose: true,
    vendorSuffix: '.TW',
  },
  XTKS: {
    code: 'XTKS',
    name: 'Tokyo Stock Exchange',
    country: 'Japan',
    ianaTz: 'Asia/Tokyo',
    closeLocal: '15:00',
    approxCloseUtcHour: 6,
    closesBeforeUsClose: true,
    vendorSuffix: '.T',
  },
  XHKG: {
    code: 'XHKG',
    name: 'Hong Kong Stock Exchange',
    country: 'Hong Kong',
    ianaTz: 'Asia/Hong_Kong',
    closeLocal: '16:00',
    approxCloseUtcHour: 8,
    closesBeforeUsClose: true,
    vendorSuffix: '.HK',
  },
  XAMS: {
    code: 'XAMS',
    name: 'Euronext Amsterdam',
    country: 'Netherlands',
    ianaTz: 'Europe/Amsterdam',
    closeLocal: '17:30',
    approxCloseUtcHour: 16.5,
    closesBeforeUsClose: true,
    vendorSuffix: '.AS',
  },
  XETR: {
    code: 'XETR',
    name: 'Deutsche Börse Xetra',
    country: 'Germany',
    ianaTz: 'Europe/Berlin',
    closeLocal: '17:30',
    approxCloseUtcHour: 16.5,
    closesBeforeUsClose: true,
    vendorSuffix: '.DE',
  },
  XLON: {
    code: 'XLON',
    name: 'London Stock Exchange',
    country: 'United Kingdom',
    ianaTz: 'Europe/London',
    closeLocal: '16:30',
    approxCloseUtcHour: 16.5,
    closesBeforeUsClose: true,
    vendorSuffix: '.L',
  },
  XNAS: {
    code: 'XNAS',
    name: 'Nasdaq',
    country: 'United States',
    ianaTz: 'America/New_York',
    closeLocal: '16:00',
    approxCloseUtcHour: 21,
    closesBeforeUsClose: false,
    vendorSuffix: '',
  },
  XNYS: {
    code: 'XNYS',
    name: 'New York Stock Exchange',
    country: 'United States',
    ianaTz: 'America/New_York',
    closeLocal: '16:00',
    approxCloseUtcHour: 21,
    closesBeforeUsClose: false,
    vendorSuffix: '',
  },
};

/** Issuer files use free-text venue names; map them onto MICs. */
const ALIASES: Array<[RegExp, string]> = [
  [/korea/i, 'XKRX'],
  [/taiwan/i, 'XTAI'],
  [/tokyo|japan/i, 'XTKS'],
  [/hong ?kong|hkex/i, 'XHKG'],
  [/amsterdam|euronext/i, 'XAMS'],
  [/xetra|deutsche|frankfurt|german/i, 'XETR'],
  [/london|lse/i, 'XLON'],
  [/nasdaq/i, 'XNAS'],
  [/new york stock exchange|nyse|arca|bats|cboe/i, 'XNYS'],
];

export function normalizeExchange(raw: string): string {
  const s = raw.trim();
  if (s === '') return 'UNKNOWN';
  const upper = s.toUpperCase();
  if (EXCHANGES[upper]) return upper;
  for (const [re, mic] of ALIASES) if (re.test(s)) return mic;
  return upper;
}

export function exchangeInfo(code: string): ExchangeInfo | null {
  return EXCHANGES[normalizeExchange(code)] ?? null;
}

export function isNonUsVenue(code: string): boolean {
  const info = exchangeInfo(code);
  return info ? info.closesBeforeUsClose : false;
}

/**
 * Approximate hours between a venue's close and the US close on the same date.
 * Used to quantify, not merely flag, how stale a foreign price is.
 */
export function hoursBeforeUsClose(code: string): number {
  const info = exchangeInfo(code);
  if (!info) return 0;
  return Math.max(0, 21 - info.approxCloseUtcHour);
}

/**
 * Build the vendor symbol for a holding. Issuer files carry local codes
 * ("000660"), which no US-centric market API resolves without a venue suffix.
 */
export function vendorSymbol(ticker: string, exchange: string): string {
  const info = exchangeInfo(exchange);
  const t = ticker.trim().toUpperCase();
  if (!info || info.vendorSuffix === '') return t;
  return `${t}${info.vendorSuffix}`;
}

export function stalenessNote(code: string): string | null {
  const info = exchangeInfo(code);
  if (!info || !info.closesBeforeUsClose) return null;
  const h = hoursBeforeUsClose(code);
  return (
    `${info.name} closes at ${info.closeLocal} ${info.ianaTz} — roughly ` +
    `${h.toFixed(1)}h before the US close. Same-day contribution for this ` +
    `holding reflects its last local close, not US-session trading.`
  );
}
