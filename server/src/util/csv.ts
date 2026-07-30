/**
 * Minimal RFC4180-ish CSV reader. The iShares holdings file quotes fields
 * containing commas (company names routinely do: "Alphabet Inc, Class A") and
 * uses thousands separators inside quotes, so a naive split(',') corrupts it.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse issuer-formatted numbers: "1,234.56", "(12.3)" negative, "-" null. */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s === '' || s === '-' || s === 'N/A' || s === '--') return null;
  const negative = s.startsWith('(') && s.endsWith(')');
  const cleaned = s.replace(/[(),$%\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}
