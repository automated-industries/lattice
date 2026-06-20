import { resolve } from 'node:path';
import type { CellValue, Worksheet } from 'exceljs';

/**
 * Convert an Excel workbook into the record-array shape the importer consumes
 * (`{ <sheetName>: [ {column: value} ] }`), so each tab flows through the same
 * `inferSchema → materialize` pipeline as JSON.
 *
 * Real financial/CRM workbooks rarely use formal Excel Table objects, so the
 * header row + data region are DETECTED, not read from declared metadata: title
 * / disclaimer preamble rows are skipped, the first sufficiently-dense row is
 * taken as the header, and data runs until the first blank row. Navigation /
 * prose sheets (no detectable table) are omitted. Best-effort by design — the
 * importer's review step is the safety valve.
 *
 * `exceljs` is an OPTIONAL dependency loaded lazily, so installing latticesql
 * without it still works for every non-Excel path.
 */

const HEADER_SCAN_ROWS = 25;

/** Flatten an exceljs cell value into a scalar (or null). */
function cellValue(v: CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return cellValue(o.result as CellValue); // formula → computed result
    if ('text' in o) return o.text; // hyperlink → display text
    if ('richText' in o && Array.isArray(o.richText)) {
      return (o.richText as { text?: string }[]).map((t) => t.text ?? '').join('');
    }
    return null; // error cells, etc.
  }
  return v; // number | string | boolean
}

function isFilled(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '';
}

/** Detect the single primary table in a worksheet and return its rows as records. */
function sheetToRecords(ws: Worksheet): Record<string, unknown>[] {
  const rowCount = ws.rowCount;
  const colCount = ws.columnCount;
  if (rowCount < 2 || colCount < 2) return []; // empty or single-cell nav sheet

  const nonEmpty = (r: number): number => {
    let n = 0;
    for (let c = 1; c <= colCount; c++) if (isFilled(cellValue(ws.getCell(r, c).value))) n++;
    return n;
  };

  // Header = first dense row (after any title preamble) that is followed by data.
  const threshold = Math.max(3, Math.floor(colCount * 0.4));
  let headerRow = -1;
  for (let r = 1; r <= Math.min(HEADER_SCAN_ROWS, rowCount); r++) {
    if (nonEmpty(r) >= threshold && r < rowCount && nonEmpty(r + 1) >= 2) {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) return []; // no table detected (prose / navigation sheet)

  // Column map: only header cells that carry a name; de-dup repeated names.
  const cols: { c: number; name: string }[] = [];
  const seen = new Set<string>();
  for (let c = 1; c <= colCount; c++) {
    const hv = cellValue(ws.getCell(headerRow, c).value);
    if (!isFilled(hv)) continue;
    const base = String(hv).replace(/\s+/g, ' ').trim();
    if (!base) continue;
    let name = base;
    let i = 2;
    while (seen.has(name)) name = base + ' ' + String(i++);
    seen.add(name);
    cols.push({ c, name });
  }
  if (cols.length === 0) return [];

  // Data rows until the first fully-blank row (table boundary); drop totals rows.
  const records: Record<string, unknown>[] = [];
  for (let r = headerRow + 1; r <= rowCount; r++) {
    const row: Record<string, unknown> = {};
    let any = false;
    for (const { c, name } of cols) {
      const v = cellValue(ws.getCell(r, c).value);
      if (isFilled(v)) {
        row[name] = v;
        any = true;
      }
    }
    if (!any) break; // blank row ends the table
    const first = cols[0] ? row[cols[0].name] : undefined;
    if (typeof first === 'string' && /^total\b/i.test(first.trim())) continue; // totals row
    records.push(row);
  }
  return records;
}

// The dropped title/preamble text of the last-parsed workbook, keyed by absolute
// path. Captured during the single read so the as-of detector can scan it (the
// "as of <date>" line lives in those preamble rows) without re-opening the file.
const preambleCache = new Map<string, string>();

/** The title/preamble text (sheet titles + the first rows above each header) of a
 *  workbook last read by {@link excelToRecords}, for as-of date detection. */
export function excelPreambleText(absPath: string): string {
  return preambleCache.get(resolve(absPath)) ?? '';
}

/** First few rows of a sheet as text, for preamble/title scanning. */
function sheetPreamble(ws: Worksheet): string {
  const lines: string[] = [];
  const rowCount = Math.min(10, ws.rowCount);
  const colCount = Math.min(8, ws.columnCount);
  for (let r = 1; r <= rowCount; r++) {
    const cells: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      const v = cellValue(ws.getCell(r, c).value);
      if (isFilled(v)) cells.push(String(v));
    }
    if (cells.length) lines.push(cells.join(' '));
  }
  return lines.join('\n');
}

export async function excelToRecords(absPath: string): Promise<Record<string, unknown[]>> {
  let mod: typeof import('exceljs') & { default?: typeof import('exceljs') };
  try {
    mod = await import('exceljs');
  } catch {
    throw new Error('Reading Excel files needs the "exceljs" package — install it with: npm install exceljs');
  }
  // exceljs is CJS: under native ESM the export lands on `.default`, but bundlers
  // expose it on the namespace — accept either.
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(absPath);
  const out: Record<string, unknown[]> = {};
  const preamble: string[] = [];
  const props = wb.properties as { title?: string } | undefined;
  if (props?.title) preamble.push(props.title);
  for (const ws of wb.worksheets) {
    preamble.push(ws.name, sheetPreamble(ws));
    const records = sheetToRecords(ws);
    if (records.length > 0) out[ws.name] = records;
  }
  preambleCache.set(resolve(absPath), preamble.filter(Boolean).join('\n'));
  return out;
}

/** Exposed for tests: detect + extract one sheet's records (pure, no file I/O). */
export const __test = { sheetToRecords, cellValue };
