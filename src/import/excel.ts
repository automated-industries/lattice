import { resolve } from 'node:path';
import type { CellValue, Worksheet } from 'exceljs';
import { columnLetter, normalizeRowFormula, type ColumnFormulaStats } from './formula.js';

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

/** Per-sheet formula summary: the header layout plus each column's formula usage. */
export interface SheetFormulaSummary {
  /** Sheet column letter → detected header name (the record key), for mapping
   *  a formula's cell references back onto the imported columns. */
  columnLetters: Record<string, string>;
  /** Header name → formula stats. Only columns with ≥ 1 formula cell appear. */
  columns: Record<string, ColumnFormulaStats>;
}

/** Workbook formula summary: sheet name → per-column formula usage. */
export type WorkbookFormulaSummary = Record<string, SheetFormulaSummary>;

/** One sheet's extraction: the records plus the formula summary gathered
 *  during the same single pass over the cells. */
interface SheetExtract {
  records: Record<string, unknown>[];
  summary: SheetFormulaSummary;
}

/** The parts of an exceljs formula cell value the summary reads. */
interface FormulaCell {
  formula?: unknown;
  /** On a shared-formula slave: the MASTER cell's address (e.g. `"F2"`). */
  sharedFormula?: unknown;
}

/** Detect the single primary table in a worksheet and return its rows as
 *  records, capturing each column's formula usage along the way. Values are
 *  read from the cached formula RESULTS exactly as before — the formula text
 *  feeds only the summary. */
function extractSheet(ws: Worksheet): SheetExtract {
  const empty: SheetExtract = { records: [], summary: { columnLetters: {}, columns: {} } };
  const rowCount = ws.rowCount;
  const colCount = ws.columnCount;
  if (rowCount < 2 || colCount < 2) return empty; // empty or single-cell nav sheet

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
  if (headerRow < 0) return empty; // no table detected (prose / navigation sheet)

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
  if (cols.length === 0) return empty;
  const columnLetters: Record<string, string> = {};
  for (const { c, name } of cols) columnLetters[columnLetter(c)] = name;

  // Formula bookkeeping. Masters of shared formulas are registered by address
  // so a slave (`{ sharedFormula: '<masterAddr>' }`) can reuse the master's
  // pattern — valid only when the slave sits in the SAME COLUMN (a shared
  // formula shifts references by the cell offset, so a same-column slave keeps
  // the master's column tokens; a horizontal share does not and is counted as
  // an unsupported formula row).
  const masters = new Map<string, { c: number; r: number; formula: string }>();
  const stats = new Map<string, ColumnFormulaStats>();
  const MAX_PATTERNS = 8;
  const noteFormula = (name: string, pattern: string | null, example: string | null): void => {
    let st = stats.get(name);
    if (!st) {
      st = { total: 0, formulaRows: 0, patterns: {}, example: '' };
      stats.set(name, st);
    }
    st.formulaRows++;
    if (example && !st.example) st.example = example;
    if (pattern !== null) {
      if (pattern in st.patterns) st.patterns[pattern] = (st.patterns[pattern] ?? 0) + 1;
      else if (Object.keys(st.patterns).length < MAX_PATTERNS) st.patterns[pattern] = 1;
      // Past the cap a new pattern is not tracked — with > 8 distinct patterns
      // no single one can dominate the column anyway.
    }
  };

  // Data rows until the first fully-blank row (table boundary); drop totals rows.
  const records: Record<string, unknown>[] = [];
  const filledRows = new Map<string, number>(); // column → rows carrying anything
  for (let r = headerRow + 1; r <= rowCount; r++) {
    const row: Record<string, unknown> = {};
    const cells: { c: number; name: string; raw: CellValue; v: unknown }[] = [];
    let any = false;
    for (const { c, name } of cols) {
      const raw = ws.getCell(r, c).value;
      const v = cellValue(raw);
      cells.push({ c, name, raw, v });
      if (isFilled(v)) {
        row[name] = v;
        any = true;
      }
    }
    if (!any) break; // blank row ends the table
    const first = cols[0] ? row[cols[0].name] : undefined;
    if (typeof first === 'string' && /^total\b/i.test(first.trim())) continue; // totals row
    for (const { c, name, raw, v } of cells) {
      const cell = raw !== null && typeof raw === 'object' ? (raw as unknown as FormulaCell) : null;
      const formula = typeof cell?.formula === 'string' ? cell.formula : null;
      const sharedRef = typeof cell?.sharedFormula === 'string' ? cell.sharedFormula : null;
      if (formula !== null) {
        masters.set(columnLetter(c) + String(r), { c, r, formula });
        noteFormula(name, normalizeRowFormula(formula, r), formula);
      } else if (sharedRef !== null) {
        const master = masters.get(sharedRef);
        const reusable = master?.c === c ? master : null; // same-column shares only
        noteFormula(
          name,
          reusable ? normalizeRowFormula(reusable.formula, reusable.r) : null,
          reusable ? reusable.formula : null,
        );
      }
      if (isFilled(v) || formula !== null || sharedRef !== null) {
        filledRows.set(name, (filledRows.get(name) ?? 0) + 1);
      }
    }
    records.push(row);
  }

  const columns: Record<string, ColumnFormulaStats> = {};
  for (const { name } of cols) {
    const st = stats.get(name);
    if (st) columns[name] = { ...st, total: filledRows.get(name) ?? 0 };
  }
  return { records, summary: { columnLetters, columns } };
}

/** Detect the single primary table in a worksheet and return its rows as records. */
function sheetToRecords(ws: Worksheet): Record<string, unknown>[] {
  return extractSheet(ws).records;
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

// Per-column formula summaries of the last-parsed workbook, keyed by absolute
// path exactly like the preamble cache — gathered during the single read so the
// computed-table proposer never re-opens the file. Derived purely from the
// bytes, so the proposal-time read (of the upload's temp path) and the
// apply-time read (of the retained blob) produce identical summaries.
const formulaCache = new Map<string, WorkbookFormulaSummary>();

/** The per-sheet, per-column formula summary of a workbook last read by
 *  {@link excelToRecords}, for computed-table (calc field) proposals. */
export function excelFormulaSummary(absPath: string): WorkbookFormulaSummary {
  return formulaCache.get(resolve(absPath)) ?? {};
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
    throw new Error(
      'Reading Excel files needs the "exceljs" package — install it with: npm install exceljs',
    );
  }
  // exceljs is CJS: under native ESM the export lands on `.default`, but bundlers
  // expose it on the namespace — accept either.
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(absPath);
  const out: Record<string, unknown[]> = {};
  const preamble: string[] = [];
  const formulas: WorkbookFormulaSummary = {};
  const props = wb.properties as { title?: string } | undefined;
  if (props?.title) preamble.push(props.title);
  for (const ws of wb.worksheets) {
    preamble.push(ws.name, sheetPreamble(ws));
    const { records, summary } = extractSheet(ws);
    if (records.length > 0) {
      out[ws.name] = records;
      formulas[ws.name] = summary;
    }
  }
  preambleCache.set(resolve(absPath), preamble.filter(Boolean).join('\n'));
  formulaCache.set(resolve(absPath), formulas);
  return out;
}

/** Exposed for tests: detect + extract one sheet's records (pure, no file I/O). */
export const __test = { sheetToRecords, extractSheet, cellValue };
