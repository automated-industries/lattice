import { concatTagText, decodeUtf8, decodeXmlEntities, eachElement, unzip } from './helpers.js';
import { normalizeName } from '../../../import/infer-core.js';
import { capLabel, isAnonymousName, labelFromFilename } from '../../../import/name-policy.js';

/**
 * Deterministic extraction of EMBEDDED TABLES from Office documents into records —
 * every row, no model involved. Word tables are `<w:tbl>` → rows `<w:tr>` → cells
 * `<w:tc>`; PowerPoint tables are `<a:tbl>` → `<a:tr>` → `<a:tc>`. The first non-empty
 * row of each table is its header (cells become record keys); each later non-empty row
 * is one record.
 *
 * The output shape matches `excelToRecords` / `csvToRecords`
 * (`Record<string, unknown[]>` = `{ [tableName]: records[] }`), so a document's tables
 * flow through the SAME `inferSchema → materializeImport` pipeline as a spreadsheet.
 *
 * NAMING (5.2). The map key IS the table name, so a positional `Table 1` key became a
 * meaningless `table_1` table. Each table is now named FROM THE DOCUMENT via a ladder —
 * caption, then a preceding heading, then (single-table) the document basename — and
 * anything still un-nameable is FOLDED into one basename-named table rather than dropped
 * or minted as `table_N`. Nothing anonymous is ever emitted. Pure + synchronous: same
 * bytes in → same names out, no DB, no LLM.
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

// ── Naming ladder ──────────────────────────────────────────────────────────

/** A raw table extracted from a container XML, with its span so a name lookback
 *  can be bounded to the text that precedes THIS table (not the previous one's cells). */
interface RawTable {
  records: Record<string, unknown>[];
  /** Header keys (deduped raw spelling) of the first data row, in order. */
  headers: string[];
  /** Normalized-header signature (case/spacing-insensitive) for merge decisions. */
  sig: string;
  /** Char offset of the table's open tag in the container XML. */
  start: number;
  /** Char offset just past the table's close tag. */
  end: number;
  /** The table element's inner XML (for the caption rung). */
  innerXml: string;
  /** Ladder-resolved name, or null when nothing was derivable. */
  name: string | null;
}

/** Paragraph styles that qualify a paragraph as a heading usable as a table name. */
const HEADING_STYLE = /^(heading|title|subtitle|caption)/i;

/** Normalized signature of a header set — order-independent, case-insensitive. */
function headerSig(headers: string[]): string {
  return headers
    .map((h) => normalizeName(h))
    .filter(Boolean)
    .sort()
    .join('|');
}

/** A derived name is usable only when it isn't itself a positional/placeholder form
 *  (a real Word caption reading "Table 1" normalizes straight back to `table_1`). */
function acceptable(name: string): boolean {
  return !isAnonymousName(normalizeName(name));
}

/** The rung-4 / fold name: the document's basename via the shared
 *  `labelFromFilename` — capped, and NEVER anonymous ('untitled.docx' or
 *  'table.docx' falls through to the generic 'document' rather than emitting a
 *  key the materialize pre-flight would refuse, which would drop the whole
 *  document's data). */
function documentLabel(originalName: string): string {
  return labelFromFilename(originalName);
}

/** Collected tables plus the span of EVERY table element — including record-less
 *  ones — so the heading lookback can floor on any table's end, not just the last
 *  one that produced records (a header-only banner table would otherwise leave its
 *  cell text inside the next table's lookback span and be mistaken for a heading). */
interface CollectedTables {
  tables: RawTable[];
  /** End offset of every table element seen, in document order. */
  allTableEnds: number[];
}

/** Collect every non-empty table in `xml` with its span + header signature. */
function collectTables(
  xml: string,
  tableTag: string,
  rowTag: string,
  cellTag: string,
  textTag: string,
): CollectedTables {
  const out: RawTable[] = [];
  const allTableEnds: number[] = [];
  const openLen = ('<' + tableTag).length;
  const closeLen = ('</' + tableTag + '>').length;
  eachElement(xml, tableTag, (attrs, inner, start) => {
    // Reconstruct the element's end offset from the callback args: a table element is
    // `<tag` + attrs + `>` + inner + `</tag>` (self-closing tables carry no rows and
    // never get here past gridToRecords anyway).
    const end = start + openLen + attrs.length + 1 + inner.length + closeLen;
    allTableEnds.push(end);
    const grid: string[][] = [];
    eachElement(inner, rowTag, (_b, tr) => {
      const cells: string[] = [];
      eachElement(tr, cellTag, (_c, tc) => {
        cells.push(cellText(tc, textTag));
      });
      grid.push(cells);
    });
    const records = gridToRecords(grid);
    if (records.length === 0) return;
    const headers = Object.keys(records[0] ?? {});
    out.push({
      records,
      headers,
      sig: headerSig(headers),
      start,
      end,
      innerXml: inner,
      name: null,
    });
  });
  return { tables: out, allTableEnds };
}

/** Rung 1 (Word): the explicit `<w:tblCaption w:val="…"/>` in `<w:tblPr>`. Its text is
 *  in the `w:val` attribute of a self-closing element, so neither `firstTagText` nor
 *  `concatTagText` can reach it — read the attribute directly. */
function captionName(innerXml: string): string | null {
  const vals: string[] = [];
  eachElement(innerXml, 'w:tblCaption', (attrs) => {
    if (vals.length > 0) return;
    const m = /\bw:val\s*=\s*"([^"]*)"/.exec(attrs);
    if (m?.[1] != null) vals.push(decodeXmlEntities(m[1]).trim());
  });
  const first = vals[0];
  return first !== undefined && first !== '' ? first : null;
}

/** True when a paragraph carries a heading `<w:pStyle w:val="Heading…|Title|Caption"/>`. */
function hasHeadingStyle(pInner: string): boolean {
  let styled = false;
  eachElement(pInner, 'w:pStyle', (attrs) => {
    const m = /\bw:val\s*=\s*"([^"]*)"/.exec(attrs);
    if (m?.[1] && HEADING_STYLE.test(m[1])) styled = true;
  });
  return styled;
}

/** Title-shaped: short and not sentence-punctuated — a plausible heading even without
 *  an explicit style. Kept conservative so an introductory sentence isn't taken. */
function isTitleShaped(text: string): boolean {
  if (/[.:;,]$/.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 8;
}

/** Rung 2 (Word): the last QUALIFYING heading paragraph strictly within
 *  `(from, to)` — the span between the previous table's end and this table's start.
 *  The bound is load-bearing: `<w:p>` is also the paragraph element inside every table
 *  cell, so an unbounded backward scan would find the PREVIOUS table's last cell text,
 *  not a heading. Returns null when the span holds no qualifying paragraph (so a table
 *  preceded only by a sentence is not named after that sentence). */
function headingBefore(xml: string, from: number, to: number): string | null {
  if (to <= from) return null;
  const span = xml.slice(from, to);
  let best: string | null = null; // last qualifying paragraph = closest to the table
  eachElement(span, 'w:p', (_a, pInner) => {
    const text = decodeXmlEntities(concatTagText(pInner, 'w:t')).replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (hasHeadingStyle(pInner) || isTitleShaped(text)) best = text;
  });
  return best;
}

/** Rung 3 (PowerPoint): the slide's title-placeholder text. The title and cell text both
 *  live in `<a:t>`, so the title must be read from the title SHAPE, never from a table. */
function slideTitle(slideXml: string): string | null {
  const titles: string[] = [];
  eachElement(slideXml, 'p:sp', (_a, spInner) => {
    if (titles.length > 0) return;
    const titleMarks: true[] = [];
    eachElement(spInner, 'p:ph', (phAttrs) => {
      const m = /\btype\s*=\s*"([^"]*)"/.exec(phAttrs);
      if (m?.[1] && /^(ctr)?title$/i.test(m[1])) titleMarks.push(true);
    });
    if (titleMarks.length === 0) return;
    const text = decodeXmlEntities(concatTagText(spInner, 'a:t')).replace(/\s+/g, ' ').trim();
    if (text) titles.push(text);
  });
  return titles[0] ?? null;
}

/** Remap a record's keys to a canonical spelling per normalized key (so `Rate` and
 *  `rate` don't produce half-empty rows when tables are merged/folded). */
function canonicalize(
  rec: Record<string, unknown>,
  canon: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[canon.get(normalizeName(k)) ?? k] = v;
  return out;
}

/** Merge page-break continuations: an adjacent table that shares a header signature,
 *  resolves to the same name, and has no heading between it and its predecessor is one
 *  logical table split across a page break. Runs AFTER naming, so two tables under
 *  different headings are never joined. Records are canonicalized to the first member's
 *  header spelling. `headingBetween` is document-specific (Word only). */
function mergeAdjacent(
  raw: RawTable[],
  headingBetween: (from: number, to: number) => boolean,
): RawTable[] {
  const out: RawTable[] = [];
  for (const t of raw) {
    const prev = out[out.length - 1];
    // A continuation either resolved to the SAME name, or resolved to NO name at
    // all — a page-break continuation has no caption and no heading of its own,
    // so a null-named same-signature neighbor of a named table with nothing in
    // between is that table's continuation and adopts its name. The reverse
    // (a named t after an unnamed prev) is NOT merged: t's name came from its own
    // caption, which is its identity.
    const nameMatches =
      prev != null && (prev.name === t.name || (t.name == null && prev.name != null));
    if (
      prev &&
      prev.sig !== '' &&
      prev.sig === t.sig &&
      nameMatches &&
      !headingBetween(prev.end, t.start)
    ) {
      const canon = new Map(prev.headers.map((h) => [normalizeName(h), h]));
      for (const rec of t.records) prev.records.push(canonicalize(rec, canon));
      prev.end = t.end;
      continue;
    }
    out.push({ ...t, records: [...t.records] });
  }
  return out;
}

/** Fold (D1): append every still-un-nameable fragment into ONE table named from the
 *  basename, emitting the explicit column union (missing cells → null) so a fragment's
 *  unique column survives even past the inferrer's first-300-row discovery window. */
function foldUnnamed(tables: RawTable[], docLabel: string): RawTable[] {
  const named = tables.filter((t) => t.name != null);
  const unnamed = tables.filter((t) => t.name == null);
  if (unnamed.length === 0) return named;
  const canon = new Map<string, string>();
  const union: string[] = [];
  for (const t of unnamed) {
    for (const h of t.headers) {
      const nn = normalizeName(h);
      if (!canon.has(nn)) {
        canon.set(nn, h);
        union.push(h);
      }
    }
  }
  const folded: Record<string, unknown>[] = [];
  for (const t of unnamed) {
    for (const rec of t.records) {
      const row: Record<string, unknown> = {};
      for (const h of union) row[h] = null; // explicit nulls for the full union
      Object.assign(row, canonicalize(rec, canon));
      folded.push(row);
    }
  }
  return [
    ...named,
    {
      records: folded,
      headers: union,
      sig: headerSig(union),
      start: unnamed[0]?.start ?? 0,
      end: unnamed[unnamed.length - 1]?.end ?? 0,
      innerXml: '',
      name: docLabel,
    },
  ];
}

/** The existing key of `out` that collides with `key` under the DOWNSTREAM identity
 *  (normalizeName) — raw-key uniqueness is not enough, because two raw-distinct keys
 *  like `Rate Table` and `rate table` become one `rate_table` entity at inference
 *  and would silently merge there. */
function collidingKey(out: Record<string, unknown[]>, key: string): string | undefined {
  const nn = normalizeName(key);
  return Object.keys(out).find((k) => normalizeName(k) === nn);
}

/** A `key` variant whose NORMALIZED form is free in `out` (`_2`, `_3`, …). */
function freeKey(out: Record<string, unknown[]>, key: string): string {
  if (!collidingKey(out, key)) return key;
  let n = 2;
  while (collidingKey(out, `${key}_${String(n)}`)) n++;
  return `${key}_${String(n)}`;
}

/** Emit `records` under `key`, suffixing on (normalized) collision and NEVER
 *  concatenating — so the no-combine path can't silently merge two fragments into one. */
function emitUnique(out: Record<string, unknown[]>, key: string, records: unknown[]): void {
  out[freeKey(out, key)] = records;
}

/** Emit a table into `out` under `key`, uniquifying on (normalized) collision: same
 *  header signature ⇒ concatenate (canonicalized), else suffix `_2`, `_3`. Replaces the
 *  old positional counter that was the only thing making keys unique (a silent
 *  overwrite otherwise). Used only on the combine path, where a substantive table
 *  already exists so a same-signature concat cannot change the import decision. */
function insertUnique(out: Record<string, unknown[]>, key: string, t: RawTable): void {
  const hit = collidingKey(out, key);
  if (hit === undefined) {
    out[key] = t.records;
    return;
  }
  const existing = out[hit] ?? [];
  const existingHeaders = Object.keys(existing[0] ?? {});
  if (headerSig(existingHeaders) === t.sig && t.sig !== '') {
    const canon = new Map(existingHeaders.map((h) => [normalizeName(h), h]));
    for (const rec of t.records) existing.push(canonicalize(rec, canon));
    return;
  }
  emitUnique(out, key, t.records);
}

/** Shared final assembly: (optional) merge → rung-4 basename → fold → uniquified emit.
 *  Merge + fold run only when at least one PRE-COMBINE table is substantive (>=2 cols
 *  AND >=2 rows). Otherwise combining could turn a prose document of small layout grids
 *  into one substantive table and flip `hasSubstantiveDocTable` from reference-file to
 *  import — a behaviour change the combine must not cause. */
function assemble(
  raw: RawTable[],
  docLabel: string,
  headingBetween: (from: number, to: number) => boolean,
): Record<string, unknown[]> {
  const anySubstantive = raw.some((t) => t.records.length >= 2 && t.headers.length >= 2);
  const out: Record<string, unknown[]> = {};
  if (!anySubstantive) {
    // No combine when nothing is individually substantive: emit each fragment under a
    // unique key WITHOUT concatenating, so a prose document of tiny layout grids is
    // never combined into one substantive table (which would flip the import decision).
    for (const t of raw) emitUnique(out, t.name ?? docLabel, t.records);
    return out;
  }
  let tables = mergeAdjacent(raw, headingBetween);
  if (tables.length === 1 && tables[0] && tables[0].name == null) tables[0].name = docLabel;
  tables = foldUnnamed(tables, docLabel);
  for (const t of tables) insertUnique(out, t.name ?? docLabel, t);
  return out;
}

/** Pure Word `document.xml` → named table records (exported for unit testing). */
export function docxXmlToRecords(
  documentXml: string,
  originalName = 'document',
): Record<string, unknown[]> {
  const { tables: raw, allTableEnds } = collectTables(documentXml, 'w:tbl', 'w:tr', 'w:tc', 'w:t');
  // The heading lookback floors on the end of ANY preceding table element —
  // including record-less ones (a header-only banner) — so no table's cell text
  // can ever be read as the next table's heading.
  const floorFor = (start: number): number => {
    let floor = 0;
    for (const e of allTableEnds) if (e <= start && e > floor) floor = e;
    return floor;
  };
  for (const t of raw) {
    const cap = captionName(t.innerXml);
    if (cap && acceptable(cap)) {
      t.name = capLabel(cap);
    } else {
      const head = headingBefore(documentXml, floorFor(t.start), t.start);
      if (head && acceptable(head)) t.name = capLabel(head);
    }
  }
  return assemble(
    raw,
    documentLabel(originalName),
    (from, to) => headingBefore(documentXml, from, to) != null,
  );
}

/** Pure PowerPoint slide XMLs → named table records (exported for unit testing). */
export function pptxSlideXmlToRecords(
  slideXmls: string[],
  originalName = 'presentation',
): Record<string, unknown[]> {
  const raw: RawTable[] = [];
  for (const xml of slideXmls) {
    const title = slideTitle(xml);
    for (const t of collectTables(xml, 'a:tbl', 'a:tr', 'a:tc', 'a:t').tables) {
      t.name = title && acceptable(title) ? capLabel(title) : null;
      raw.push(t);
    }
  }
  // No positional merge across slides (a page-break split doesn't occur in PowerPoint).
  return assemble(raw, documentLabel(originalName), () => true);
}

/** Every table in a .docx as records (`{}` if the file has none / can't be read). */
export async function docxToRecords(
  path: string,
  originalName = 'document',
): Promise<Record<string, unknown[]>> {
  const entries = await unzip(path);
  if (!entries) return {};
  const bytes = entries['word/document.xml'];
  if (!bytes) return {};
  return docxXmlToRecords(decodeUtf8(bytes), originalName);
}

/** Every table across a .pptx's slides as records (`{}` if none / can't be read). */
export async function pptxToRecords(
  path: string,
  originalName = 'presentation',
): Promise<Record<string, unknown[]>> {
  const entries = await unzip(path);
  if (!entries) return {};
  const slides = Object.keys(entries)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slidePartNumber(a) - slidePartNumber(b))
    .map((n) => entries[n])
    .filter((b): b is Uint8Array => b != null)
    .map((b) => decodeUtf8(b));
  return pptxSlideXmlToRecords(slides, originalName);
}
