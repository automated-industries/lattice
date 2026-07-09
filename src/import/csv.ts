import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Parse a CSV / TSV file into the record-array shape the importer consumes
 * (`{ <entityName>: [ { column: value } ] }`), so a delimited file flows through the same
 * `inferSchema → materialize` pipeline as an Excel sheet or a JSON document. The single
 * table is keyed by the file's base name (there are no sheets in a flat file).
 *
 * RFC-4180 aware: quoted fields, `""` escapes, and embedded commas / newlines are handled;
 * the delimiter (comma / semicolon / tab) is auto-detected from the header line, and a
 * leading BOM is stripped. Clean numeric cells are coerced to numbers so the schema
 * inferrer (which types off the JS value type, not the text) types those columns
 * numerically — matching how a typed Excel cell would import; values that look like ids or
 * codes (leading zeros) or dates stay strings, so nothing is silently normalized away.
 */

/** Split delimited text into rows of raw string cells (state machine, quote-aware). */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const delim = delimiter ?? detectDelimiter(s);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false; // any char seen for the current row/field (to trim a trailing newline)
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
      started = true;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else if (ch === '\r') {
      // handled by the following \n (or a lone \r ends the line below)
      if (s[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        started = false;
      }
    } else {
      field += ch;
      started = true;
    }
  }
  if (started || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Pick the delimiter with the most occurrences on the first line (comma default). */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** Coerce a clean numeric string to a number so it types numerically; leave ids
 *  (leading zeros), dates, and other text as strings. */
function coerce(v: string): unknown {
  if (/^-?[1-9]\d*$/.test(v) || v === '0') {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?(?:[1-9]\d*|0)\.\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

/** De-dup blank/repeated header names, mirroring the Excel reader's column mapping. */
function normalizeHeader(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  raw.forEach((h, i) => {
    const base = h.replace(/\s+/g, ' ').trim() || `column_${String(i + 1)}`;
    let name = base;
    let n = 2;
    while (seen.has(name)) name = base + ' ' + String(n++);
    seen.add(name);
    out.push(name);
  });
  return out;
}

/**
 * Read a CSV/TSV file into `{ <entity>: rows[] }`. `originalName` gives the entity its
 * name (the on-disk path is content-addressed/extensionless). Returns `{}` when the file
 * has no header + data rows.
 */
export function csvToRecords(absPath: string, originalName: string): Record<string, unknown[]> {
  const rows = parseDelimited(readFileSync(absPath, 'utf8'));
  if (rows.length < 2) return {}; // need a header row + at least one data row
  const header = normalizeHeader((rows[0] ?? []).map((h) => h.trim()));
  const records: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    const rec: Record<string, unknown> = {};
    header.forEach((name, i) => {
      const raw = cells[i];
      if (raw === undefined) return;
      const v = raw.trim();
      if (v !== '') rec[name] = coerce(v);
    });
    if (Object.keys(rec).length > 0) records.push(rec); // skip a fully-blank row
  }
  if (records.length === 0) return {};
  const entity =
    basename(originalName)
      .replace(/\.[^.]*$/, '')
      .trim() || 'data';
  return { [entity]: records };
}
