import type { SubTheme } from '../types';

/**
 * Sub-theme classification for AI-stack attribution.
 *
 * Deliberately rule-based and inspectable rather than learned or LLM-assigned:
 * a user reading "memory contributed +1.8pp" needs to be able to check which
 * names were counted as memory. Ticker rules win over name/sector heuristics
 * because they are exact.
 *
 * Ambiguity is real here — NVDA is both a semiconductor and, increasingly, an
 * infrastructure vendor; MSFT is both hyperscaler and software. We pick one
 * bucket per name so the rollups sum to the fund return exactly, and expose the
 * mapping in the API so the choice is auditable rather than hidden.
 */

const BY_TICKER: Record<string, SubTheme> = {
  // Memory / storage — the cycle the fund is most exposed to.
  '000660': 'memory', // SK hynix (KRX)
  MU: 'memory',
  '005930': 'memory', // Samsung Electronics (KRX)
  WDC: 'memory',
  STX: 'memory',
  SNDK: 'memory',

  // Semiconductors: logic, foundry, equipment, EDA.
  NVDA: 'semiconductors',
  AMD: 'semiconductors',
  AVGO: 'semiconductors',
  TSM: 'semiconductors',
  '2330': 'semiconductors', // TSMC (TWSE)
  ASML: 'semiconductors',
  AMAT: 'semiconductors',
  LRCX: 'semiconductors',
  KLAC: 'semiconductors',
  MRVL: 'semiconductors',
  INTC: 'semiconductors',
  QCOM: 'semiconductors',
  TXN: 'semiconductors',
  ARM: 'semiconductors',
  SNPS: 'semiconductors',
  CDNS: 'semiconductors',
  NXPI: 'semiconductors',
  ADI: 'semiconductors',
  MPWR: 'semiconductors',
  TER: 'semiconductors',
  ONTO: 'semiconductors',
  '6857': 'semiconductors', // Advantest (TSE)
  '8035': 'semiconductors', // Tokyo Electron (TSE)
  TSEM: 'semiconductors', // Tower Semiconductor — analog foundry
  LSCC: 'semiconductors', // Lattice — FPGA
  MTSI: 'semiconductors', // MACOM — RF/analog
  CBRS: 'semiconductors', // Cerebras — wafer-scale AI silicon
  '3711': 'semiconductors', // ASE Technology (TWSE) — OSAT assembly & test
  '3661': 'semiconductors', // Alchip (TWSE) — custom ASIC design
  '3037': 'semiconductors', // Unimicron (TWSE) — ABF/IC substrates
  '6920': 'semiconductors', // Lasertec (TSE) — EUV mask inspection
  '2360': 'semiconductors', // Chroma ATE (TWSE) — test & measurement

  // Hyperscalers / large-cap platforms that buy the compute.
  MSFT: 'hyperscalers',
  GOOGL: 'hyperscalers',
  GOOG: 'hyperscalers',
  AMZN: 'hyperscalers',
  META: 'hyperscalers',
  ORCL: 'hyperscalers',
  BABA: 'hyperscalers',
  '700': 'hyperscalers', // Tencent (HKEX)

  // Software / applications layer.
  CRM: 'software',
  NOW: 'software',
  PLTR: 'software',
  SNOW: 'software',
  DDOG: 'software',
  MDB: 'software',
  ADBE: 'software',
  CRWD: 'software',
  PANW: 'software',
  APP: 'software',
  TEAM: 'software',
  HUBS: 'software',
  INTU: 'software',
  SAP: 'software',

  // Physical infrastructure: networking, power, cooling, data centres.
  ANET: 'infrastructure',
  VRT: 'infrastructure',
  DELL: 'infrastructure',
  SMCI: 'infrastructure',
  CIEN: 'infrastructure',
  COHR: 'infrastructure',
  CRDO: 'infrastructure',
  ALAB: 'infrastructure',
  EQIX: 'infrastructure',
  DLR: 'infrastructure',
  GEV: 'infrastructure',
  ETN: 'infrastructure',
  PWR: 'infrastructure',
  NBIS: 'infrastructure',
  CRWV: 'infrastructure',
  LITE: 'infrastructure', // Lumentum — optical components
  AAOI: 'infrastructure', // Applied Optoelectronics — transceivers
  FN: 'infrastructure', // Fabrinet — optical/photonic manufacturing
  FLEX: 'infrastructure', // Flex — data-centre EMS
  GLW: 'infrastructure', // Corning — optical fibre & glass
  '2308': 'infrastructure', // Delta Electronics (TWSE) — DC power & cooling
  '3017': 'infrastructure', // Asia Vital Components (TWSE) — thermal
  '2345': 'infrastructure', // Accton (TWSE) — networking switches
  '2383': 'infrastructure', // Elite Material (TWSE) — copper-clad laminate
  QNT: 'infrastructure', // Quantinuum — quantum compute hardware

  // Model developers. Held as private preferred stock, so they are unpriceable
  // by any market feed — they sit in the rollup by weight and drop out of any
  // return calculation, which the coverage figure reports.
  ANTHC: 'software', // Anthropic (private)
  OPNAI: 'software', // OpenAI (private)
  AKAM: 'software', // Akamai — CDN / edge compute
};

const NAME_RULES: Array<[RegExp, SubTheme]> = [
  [/\b(hynix|micron|memory|dram|nand|flash)\b/i, 'memory'],
  [
    /\b(semiconduct|foundry|microelectronic|lithograph|wafer|chip)\b/i,
    'semiconductors',
  ],
  [/\b(data cent(er|re)|power|electric|cooling|thermal|networking|optical)\b/i, 'infrastructure'],
  [/\b(software|cloud|platform|cyber|analytics|database)\b/i, 'software'],
];

const SECTOR_RULES: Array<[RegExp, SubTheme]> = [
  [/semiconductor/i, 'semiconductors'],
  [/software|information technology services|it services/i, 'software'],
  [/utilit|electrical equipment|industrial|real estate/i, 'infrastructure'],
  [/media|interactive|communication|retailing|consumer/i, 'hyperscalers'],
  [/technology hardware|electronic equipment/i, 'infrastructure'],
];

export function classifySubTheme(
  ticker: string,
  name: string,
  sector: string,
): SubTheme {
  const t = ticker.trim().toUpperCase();
  const direct = BY_TICKER[t];
  if (direct) return direct;

  for (const [re, theme] of NAME_RULES) if (re.test(name)) return theme;
  for (const [re, theme] of SECTOR_RULES) if (re.test(sector)) return theme;
  return 'other';
}

export const SUB_THEME_LABELS: Record<SubTheme, string> = {
  semiconductors: 'Semiconductors',
  memory: 'Memory & Storage',
  hyperscalers: 'Hyperscalers & Platforms',
  software: 'Software & Applications',
  infrastructure: 'Infrastructure & Power',
  other: 'Other / Unclassified',
};

/** Exposed via the API so users can audit which names sit in which bucket. */
export function subThemeRuleCount(): number {
  return Object.keys(BY_TICKER).length;
}
