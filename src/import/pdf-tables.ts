import { readFile } from 'node:fs/promises';
import { capLabel, isAnonymousName, labelFromFilename } from './name-policy.js';
import { normalizeName } from './infer-core.js';

/**
 * Deterministic extraction of RULED TABLES from a PDF into records — every row, no
 * model involved.
 *
 * A PDF has no table structure to read: it is glyphs at coordinates. The table is
 * therefore recovered from geometry, which is what a ruled table IS visually —
 * text sharing a baseline is one row, and text sharing an x position DOWN the page
 * is one column. Columns are only treated as columns when they REPEAT across rows,
 * which is precisely what separates a table from a paragraph that happens to have
 * spaces in it. A page with no repeating alignment yields nothing, rather than a
 * table invented out of prose.
 *
 * The output shape matches `excelToRecords` / `csvToRecords` / `docxToRecords`
 * (`Record<string, unknown[]>` = `{ [tableName]: records[] }`), so a PDF's tables
 * flow through the SAME infer → shape gate → materialize pipeline as a spreadsheet.
 *
 * Reads through the PDF text layer that already ships with the document readers —
 * no new dependency, and no image/OCR path: a scanned PDF has no text layer, so it
 * yields nothing here and continues to fall through to the existing document read.
 */

/** One positioned text run from a PDF page's text layer. */
export interface PdfTextItem {
  /** The run's text. */
  str: string;
  /** Horizontal position of the run's start, in PDF user space. */
  x: number;
  /** Baseline position, in PDF user space (larger y is HIGHER on the page). */
  y: number;
  /** Rendered width of the run. */
  width: number;
  /** Rendered height (font size) of the run. */
  height: number;
}

/** The pdf.js surface used here, kept local so this module type-checks without
 *  depending on the reader's own types. */
interface PdfLib {
  getDocumentProxy(data: Uint8Array): Promise<PdfDocument>;
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfPage {
  getTextContent(): Promise<{ items: RawTextItem[] }>;
}
interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
}

/** Pages beyond this are ignored — a bound on a pathological document. */
const MAX_PDF_PAGES = 100;
/** Give up on a PDF that takes longer than this to open/read. */
const PDF_TABLE_TIMEOUT_MS = 20_000;
/** A column must appear on at least this many rows to count as a column. */
const MIN_ROWS_PER_COLUMN = 2;
/** Fewer rows than this is not a table (a header alone proves nothing). */
const MIN_TABLE_ROWS = 2;
/** Fewer columns than this is a list, not a table. */
const MIN_TABLE_COLUMNS = 2;
/** Longest line still considered a possible table heading. */
const MAX_HEADING_CHARS = 80;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Text runs grouped onto one visual baseline, left to right. */
interface PdfLine {
  y: number;
  items: PdfTextItem[];
}

/**
 * Group runs into visual lines. Two runs are on the same line when their baselines
 * differ by less than a fraction of the text height — a typeset baseline wobbles by
 * a fraction of a point, so an exact-equality grouping would split real rows.
 */
function groupIntoLines(items: PdfTextItem[]): PdfLine[] {
  const real = items.filter((i) => i.str.trim() !== '');
  if (real.length === 0) return [];
  const heights = real.map((i) => i.height).filter((h) => h > 0);
  const tol = Math.min(6, Math.max(1.5, median(heights) * 0.5));
  const sorted = [...real].sort((a, b) => b.y - a.y); // top of the page first
  const lines: PdfLine[] = [];
  for (const it of sorted) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(current.y - it.y) <= tol) current.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** A candidate column: an x band that recurs down the page. */
interface Column {
  min: number;
  max: number;
}

/**
 * Cluster every run's x position into bands. `minLines` filters to the bands that
 * RECUR down the page: that recurrence is the whole table gate, because in prose
 * word positions differ on every line, so no band survives it. Pass `minLines: 1`
 * to take every band, which is only correct once the input is already known to be
 * table lines.
 */
function findColumns(lines: PdfLine[], tol: number, minLines: number): Column[] {
  const positions: { x: number; line: number }[] = [];
  lines.forEach((line, i) => {
    for (const it of line.items) positions.push({ x: it.x, line: i });
  });
  positions.sort((a, b) => a.x - b.x);
  const bands: { min: number; max: number; lines: Set<number> }[] = [];
  for (const p of positions) {
    const last = bands[bands.length - 1];
    if (last && p.x - last.max <= tol) {
      last.max = p.x;
      last.lines.add(p.line);
    } else {
      bands.push({ min: p.x, max: p.x, lines: new Set([p.line]) });
    }
  }
  return bands.filter((b) => b.lines.size >= minLines).map((b) => ({ min: b.min, max: b.max }));
}

/** How many distinct columns a line puts text into. */
function columnsUsed(line: PdfLine, columns: Column[], tol: number): number {
  const hit = new Set<number>();
  for (const it of line.items) {
    if (!it.str.trim()) continue;
    const c = columnOf(it.x, columns, tol);
    if (c >= 0) hit.add(c);
  }
  return hit.size;
}

/** The column a run belongs to, or -1 when it sits outside every column band. */
function columnOf(x: number, columns: Column[], tol: number): number {
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (c && x >= c.min - tol && x <= c.max + tol) return i;
  }
  return -1;
}

/**
 * Recover a table's cell grid from one page's positioned text.
 *
 * Returns `[]` when the page holds no table: fewer than two aligned columns, or
 * fewer than two rows using them. Pure and synchronous — same items in, same grid
 * out — so the geometry decision is testable without a PDF at all.
 */
export function pdfItemsToGrid(items: PdfTextItem[]): string[][] {
  return pdfItemsToPage(items).grid;
}

/** A page's table plus the line immediately above it (the heading candidate). */
interface PdfPageTable {
  grid: string[][];
  heading: string | null;
}

function pdfItemsToPage(items: PdfTextItem[]): PdfPageTable {
  const lines = groupIntoLines(items);
  if (lines.length < MIN_TABLE_ROWS) return { grid: [], heading: null };
  const heights = lines.flatMap((l) => l.items.map((i) => i.height)).filter((h) => h > 0);
  // Column bands are matched with a tolerance proportional to the text size: a
  // right-aligned or slightly-indented cell still belongs to its column.
  const tol = Math.min(12, Math.max(3, median(heights) * 0.8));
  // Pass 1 — prove a table exists. Only bands that recur down the page count, so
  // prose (whose word positions never line up) produces none.
  const recurring = findColumns(lines, tol, MIN_ROWS_PER_COLUMN);
  if (recurring.length < MIN_TABLE_COLUMNS) return { grid: [], heading: null };
  const tableLineIndexes: number[] = [];
  lines.forEach((line, i) => {
    if (columnsUsed(line, recurring, tol) >= MIN_TABLE_COLUMNS) tableLineIndexes.push(i);
  });
  if (tableLineIndexes.length < MIN_TABLE_ROWS) return { grid: [], heading: null };

  // Pass 2 — now that the table's LINES are known, re-derive its columns from only
  // those lines, with no recurrence filter. A column that appears in the header but
  // in just one data row is still a real column; dropping it would shift every later
  // cell one place left and silently corrupt the row.
  const tableLines = tableLineIndexes
    .map((i) => lines[i])
    .filter((l): l is PdfLine => l !== undefined);
  const columns = findColumns(tableLines, tol, 1);
  if (columns.length < MIN_TABLE_COLUMNS) return { grid: [], heading: null };

  const grid: string[][] = [];
  for (const line of tableLines) {
    const cells: string[] = Array.from({ length: columns.length }, () => '');
    for (const it of line.items) {
      const c = columnOf(it.x, columns, tol);
      if (c < 0) continue; // outside every column — not part of the table
      const text = it.str.trim();
      if (!text) continue;
      const prior = cells[c] ?? '';
      cells[c] = prior ? `${prior} ${text}` : text;
    }
    grid.push(cells);
  }
  if (grid.length < MIN_TABLE_ROWS) return { grid: [], heading: null };
  const firstTableLine = tableLineIndexes[0] ?? -1;

  // The nearest line above the table, when it is short enough to be a title.
  let heading: string | null = null;
  for (let i = firstTableLine - 1; i >= 0; i--) {
    const text = (lines[i]?.items ?? [])
      .map((it) => it.str.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!text) continue;
    if (text.length <= MAX_HEADING_CHARS) heading = text;
    break;
  }
  return { grid, heading };
}

/** Header names with blanks/dupes made unique + non-empty, so no column is dropped. */
function dedupeHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let name = h.replace(/\s+/g, ' ').trim() || `Column ${String(i + 1)}`;
    const prior = seen.get(name);
    if (prior != null) {
      seen.set(name, prior + 1);
      name = `${name} ${String(prior + 1)}`;
    } else {
      seen.set(name, 1);
    }
    return name;
  });
}

/** A cell grid → records: first row is the header, later non-empty rows are records. */
function gridToRecords(rows: string[][]): Record<string, unknown>[] {
  const headers = dedupeHeaders(rows[0] ?? []);
  if (headers.length === 0) return [];
  const records: Record<string, unknown>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (!r.some((c) => c.trim() !== '')) continue;
    const rec: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (key === undefined) continue;
      rec[key] = (r[c] ?? '').trim();
    }
    records.push(rec);
  }
  return records;
}

/** A heading is usable as a table name only when it is not an anonymous placeholder. */
function usableName(name: string): boolean {
  return !isAnonymousName(normalizeName(name));
}

/**
 * Every page's table records, keyed by name. Pure and synchronous — exported so the
 * naming + assembly is testable without reading a PDF.
 */
export function pdfPagesToRecords(
  pages: PdfTextItem[][],
  originalName = 'document',
): Record<string, unknown[]> {
  const docLabel = labelFromFilename(originalName);
  const out: Record<string, unknown[]> = {};
  for (const items of pages) {
    const { grid, heading } = pdfItemsToPage(items);
    if (grid.length === 0) continue;
    const records = gridToRecords(grid);
    if (records.length === 0) continue;
    const base = heading && usableName(heading) ? capLabel(heading) : docLabel;
    // A repeated name means the SAME table continued onto another page (a ruled
    // table split by a page break): append rather than mint a second table.
    const existing = out[base];
    if (existing) {
      existing.push(...records);
      continue;
    }
    out[base] = records;
  }
  return out;
}

/**
 * Every ruled table in a `.pdf` as records (`{}` when the file has none, has no
 * text layer, or cannot be read). Never throws: an unreadable PDF is a document
 * with no tables, and the caller keeps it as a plain file.
 */
export async function pdfToRecords(
  path: string,
  originalName = 'document',
): Promise<Record<string, unknown[]>> {
  let lib: PdfLib;
  try {
    // A LITERAL specifier so the packaged app's bundler discovers the reader —
    // a runtime variable specifier is invisible to it and would silently drop
    // PDF support from the build.
    lib = (await import('unpdf')) as unknown as PdfLib;
  } catch {
    return {};
  }
  if (typeof lib.getDocumentProxy !== 'function') return {};
  const deadline = Date.now() + PDF_TABLE_TIMEOUT_MS;
  try {
    const buf = await readFile(path);
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const pdf = await lib.getDocumentProxy(data);
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const pages: PdfTextItem[][] = [];
    for (let n = 1; n <= pageCount; n++) {
      if (Date.now() > deadline) break; // partial read beats hanging the ingest
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items) {
        const str = typeof raw.str === 'string' ? raw.str : '';
        if (!str.trim()) continue; // pdf.js emits synthetic spacing runs
        const t = Array.isArray(raw.transform) ? (raw.transform as unknown[]) : null;
        const x = typeof t?.[4] === 'number' ? t[4] : NaN;
        const y = typeof t?.[5] === 'number' ? t[5] : NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        items.push({
          str,
          x,
          y,
          width: typeof raw.width === 'number' ? raw.width : 0,
          height: typeof raw.height === 'number' ? raw.height : 0,
        });
      }
      pages.push(items);
    }
    return pdfPagesToRecords(pages, originalName);
  } catch {
    return {}; // not a readable PDF / no text layer — the caller keeps the file as-is
  }
}
