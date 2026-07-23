import { decodeUtf8, eachElement, concatTagText, unzip } from './helpers.js';

/**
 * Deterministic extraction of EMBEDDED TABLES from Office documents into records —
 * every row, no model involved. Word tables are `<w:tbl>` → rows `<w:tr>` → cells
 * `<w:tc>`; PowerPoint tables are `<a:tbl>` → `<a:tr>` → `<a:tc>`. The first non-empty
 * row of each table is its header (cells become record keys); each later non-empty row
 * is one record.
 *
 * The output shape matches `excelToRecords` / `csvToRecords`
 * (`Record<string, unknown[]>` = `{ [tableName]: records[] }`), so a document's tables
 * flow through the SAME `inferSchema → materializeImport` pipeline as a spreadsheet —
 * that is the fix for "a .docx/.pptx of tabular data used to fall to the model
 * hand-authoring a lossy handful of rows". Returns `{}` when the document has no
 * tables; the caller then falls back to text ingest for prose.
 *
 * Flat tables only: the element walk (`eachElement`) matches to the first close tag and
 * does not track same-tag nesting, so a table nested inside a cell isn't split out
 * (rare in data documents). This mirrors the rest of the OOXML readers in `ooxml.ts`.
 */

function slidePartNumber(name: string): number {
  const m = /(\d+)\.xml$/.exec(name);
  return m?.[1] ? parseInt(m[1], 10) : 0;
}

/** One cell's text: all text runs concatenated, internal whitespace collapsed. */
function cellText(tc: string, textTag: string): string {
  return concatTagText(tc, textTag).replace(/\s+/g, ' ').trim();
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

/** A cell grid → records: first non-empty row = header, later non-empty rows = records. */
function gridToRecords(rows: string[][]): Record<string, unknown>[] {
  const hi = rows.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (hi < 0) return [];
  const headers = dedupeHeaders(rows[hi] ?? []);
  if (headers.length === 0) return [];
  const records: Record<string, unknown>[] = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (!r.some((c) => c.trim() !== '')) continue; // skip blank rows
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

/** Walk every `<tableTag>` in `xml`, appending each non-empty table's records to `out`. */
function tablesFromXml(
  xml: string,
  tableTag: string,
  rowTag: string,
  cellTag: string,
  textTag: string,
  out: Record<string, unknown[]>,
): void {
  eachElement(xml, tableTag, (_a, tbl) => {
    const grid: string[][] = [];
    eachElement(tbl, rowTag, (_b, tr) => {
      const cells: string[] = [];
      eachElement(tr, cellTag, (_c, tc) => {
        cells.push(cellText(tc, textTag));
      });
      grid.push(cells);
    });
    const records = gridToRecords(grid);
    if (records.length > 0) out[`Table ${String(Object.keys(out).length + 1)}`] = records;
  });
}

/** Pure Word `document.xml` → table records (exported for unit testing). */
export function docxXmlToRecords(documentXml: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  tablesFromXml(documentXml, 'w:tbl', 'w:tr', 'w:tc', 'w:t', out);
  return out;
}

/** Pure PowerPoint slide XMLs → table records (exported for unit testing). */
export function pptxSlideXmlToRecords(slideXmls: string[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const xml of slideXmls) tablesFromXml(xml, 'a:tbl', 'a:tr', 'a:tc', 'a:t', out);
  return out;
}

/** Every table in a .docx as records (`{}` if the file has none / can't be read). */
export async function docxToRecords(path: string): Promise<Record<string, unknown[]>> {
  const entries = await unzip(path);
  if (!entries) return {};
  const bytes = entries['word/document.xml'];
  if (!bytes) return {};
  return docxXmlToRecords(decodeUtf8(bytes));
}

/** Every table across a .pptx's slides as records (`{}` if none / can't be read). */
export async function pptxToRecords(path: string): Promise<Record<string, unknown[]>> {
  const entries = await unzip(path);
  if (!entries) return {};
  const slides = Object.keys(entries)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slidePartNumber(a) - slidePartNumber(b))
    .map((n) => entries[n])
    .filter((b): b is Uint8Array => b != null)
    .map((b) => decodeUtf8(b));
  return pptxSlideXmlToRecords(slides);
}
