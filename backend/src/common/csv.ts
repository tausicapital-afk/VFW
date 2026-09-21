/**
 * A conservative RFC 4180 reader for the bulk-import feature (see csv-import.ts).
 * This is the mirror image of ExportService's `csv` writer: that method
 * prepends a UTF-8 BOM and quotes any field containing a comma, quote or
 * newline; this reader strips the BOM back off and understands those same
 * quoted fields, including a comma or a newline embedded inside one and `""`
 * as an escaped quote. No third-party CSV dependency exists in this project
 * (see backend/package.json) and hand-rolling a *writer* is one thing — a
 * *reader* has to cope with whatever a spreadsheet program actually emits, so
 * this sticks to the RFC rather than a naive `split(',')`.
 */
export function parseCsv(text: string): string[][] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = clean.length;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      i++; // swallowed; \n (or end of input) is what actually ends the row
      continue;
    }
    if (c === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // A file that doesn't end with a trailing newline still has one more row to close.
  if (field.length || row.length) pushRow();

  // A blank line (including a lone trailing "\r\n") reads as a one-empty-field
  // row — drop rows where every field is blank rather than treating them as data.
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/**
 * The first row as (trimmed, lower-cased) headers, everything after as records
 * keyed by them — so callers can look up `rec['taxcode']` regardless of whether
 * the file spells it "taxCode", "TaxCode" or "taxcode". A cell with no matching
 * header is dropped; a missing cell reads as ''.
 */
export function csvToRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h) rec[h] = (r[idx] ?? '').trim();
    });
    return rec;
  });
}
