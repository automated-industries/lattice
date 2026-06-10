import { readFile } from 'node:fs/promises';

/**
 * Native, dependency-light text extraction for document formats. Each extractor
 * lazily resolves its optional parser (so core latticesql users who never ingest
 * documents pay nothing for the parsers) and NEVER throws — on a missing
 * dependency, an invalid file, or any parse error it returns `null`, and the
 * caller degrades to a `skip` result.
 *
 * Coverage, with NO external CLI (this replaced the old `markitdown` subprocess):
 *
 *   .docx               mammoth
 *   .doc                word-extractor (legacy binary Word)
 *   .pdf                unpdf (a serverless pdf.js build; no native/canvas deps —
 *                       scanned/image-only PDFs yield no text and the ingest
 *                       layer falls back to a vision read)
 *   .pptx               native (OOXML zip → slide `<a:t>` text runs)
 *   .xlsx               native (OOXML zip → shared strings + sheet cells)
 *   .odt / .odp         native (ODF zip → `content.xml` paragraph text)
 *   .ods                native (ODF zip → table cells, incl. numeric `office:value`)
 *   .epub               native (zip → spine XHTML, tags stripped)
 *   .rtf                native de-RTF (control words/groups stripped)
 *
 * Legacy binary `.xls` and `.ppt` (pre-2007 BIFF/PPT) have no clean, non-vulnerable
 * pure-JS parser, so they degrade to `skip` (the file is still referenced).
 *
 * Robustness against hostile documents (a doc handed to a trusting user is an
 * untrusted input even though the GUI ingest route is localhost-only):
 *   - all XML tag scanning is LINEAR (no global lazy-quantifier regex, which is
 *     O(n²) on an unclosed-tag flood — the same ReDoS class we avoid in our deps);
 *   - {@link unzip} caps per-entry and aggregate DECOMPRESSED size so a zip bomb
 *     can't OOM the process;
 *   - every extractor stops accumulating once it reaches {@link MAX_TEXT}, so a
 *     huge part never materializes a multi-GB working string before truncation;
 *   - the PDF read is wrapped in a timeout.
 *
 * The optional parsers are resolved through a string-variable specifier so the
 * bundler leaves them as runtime imports (resolved from the consumer's
 * node_modules) and a missing one is just a caught import error.
 */

const MAX_TEXT = 200_000;
/** Per-decompressed-entry ceiling (bomb guard; entries above this abort the unzip). */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Aggregate decompressed ceiling across all admitted entries. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Wall-clock ceiling for a single PDF parse (a pathological PDF can't hang ingest). */
const PDF_TIMEOUT_MS = 30_000;

const textDecoder = new TextDecoder('utf-8');
function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/** Lazily import an optional parser by name; null when it isn't installed. */
async function loadOptional<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as unknown as T;
  } catch {
    return null; // optional dependency not installed
  }
}

function nullIfEmpty(s: string): string | null {
  const t = s.trim();
  return t ? t : null;
}

/** Reject the promise if it doesn't settle within `ms` (timer is unref'd + cleared). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(label));
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([
    p.finally(() => {
      clearTimeout(timer);
    }),
    timeout,
  ]);
}

// ── XML helpers (all LINEAR — see the ReDoS note in the file header) ──

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" stays the literal "&lt;"
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * Strip every XML/HTML tag. LINEAR — a global `/<[^>]+>/g` is O(n²) on a `<`
 * flood (greedy `[^>]+` scans to EOF and backtracks at each unterminated `<`).
 */
function stripTags(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) break; // unterminated tag → drop the rest
    i = gt + 1;
  }
  return out;
}

function isNameBoundary(code: number): boolean {
  // After `<tag` the next char must be whitespace, `>`, or `/` for it to be that
  // element (so `<text:p` doesn't match inside `<text:placeholder`). NaN = EOS.
  return (
    code === 0x20 || // space
    code === 0x09 || // tab
    code === 0x0a || // \n
    code === 0x0d || // \r
    code === 0x3e || // >
    code === 0x2f || // /
    Number.isNaN(code)
  );
}

/**
 * Invoke `cb(attrs, inner, start)` for each `<tag …>…</tag>` (and self-closing
 * `<tag …/>`, with `inner=''`) in document order. LINEAR: each `indexOf` only
 * advances forward, so an unclosed tag stops the scan instead of triggering the
 * O(n²) rescans a global lazy `<tag>([\s\S]*?)</tag>` regex would.
 */
function eachElement(
  xml: string,
  tag: string,
  cb: (attrs: string, inner: string, start: number) => void,
): void {
  const open = '<' + tag;
  const close = '</' + tag + '>';
  let i = 0;
  while (i < xml.length) {
    const s = xml.indexOf(open, i);
    if (s < 0) break;
    const ne = s + open.length;
    if (!isNameBoundary(xml.charCodeAt(ne))) {
      i = ne;
      continue;
    }
    const gt = xml.indexOf('>', ne);
    if (gt < 0) break;
    const selfClose = xml.charCodeAt(gt - 1) === 0x2f; // '/'
    const attrs = xml.slice(ne, selfClose ? gt - 1 : gt);
    if (selfClose) {
      cb(attrs, '', s);
      i = gt + 1;
      continue;
    }
    const e = xml.indexOf(close, gt + 1);
    if (e < 0) break; // unclosed → stop (linear)
    cb(attrs, xml.slice(gt + 1, e), s);
    i = e + close.length;
  }
}

/** Remove every `<tag …>…</tag>` / `<tag …/>` element (content included). Linear. */
function stripElement(xml: string, tag: string): string {
  const open = '<' + tag;
  const close = '</' + tag + '>';
  let out = '';
  let i = 0;
  while (i < xml.length) {
    const s = xml.indexOf(open, i);
    if (s < 0) {
      out += xml.slice(i);
      break;
    }
    const ne = s + open.length;
    if (!isNameBoundary(xml.charCodeAt(ne))) {
      out += xml.slice(i, ne);
      i = ne;
      continue;
    }
    const gt = xml.indexOf('>', ne);
    if (gt < 0) {
      out += xml.slice(i);
      break;
    }
    out += xml.slice(i, s);
    if (xml.charCodeAt(gt - 1) === 0x2f) {
      i = gt + 1; // self-closing
      continue;
    }
    const e = xml.indexOf(close, gt + 1);
    if (e < 0) break; // unclosed → drop from the open tag to EOF (linear; no rescan)
    i = e + close.length;
  }
  return out;
}

/** Concatenated text of every `<tag>` in `xml` (no inter-run separator). */
function concatTagText(xml: string, tag: string): string {
  let out = '';
  eachElement(xml, tag, (_, inner) => {
    out += decodeXmlEntities(stripTags(inner));
  });
  return out;
}

/** Inner text of the FIRST `<tag>` element (or ''). */
function firstTagText(xml: string, tag: string): string {
  let found = '';
  let done = false;
  eachElement(xml, tag, (_, inner) => {
    if (done) return;
    found = inner;
    done = true;
  });
  return found;
}

function stripHtml(html: string): string {
  const noScript = stripElement(stripElement(html, 'script'), 'style');
  const text = decodeXmlEntities(stripTags(noScript));
  return text
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Zip container helper (OOXML / ODF / EPUB are all zip archives) ──

interface UnzipFileInfo {
  name: string;
  /** Uncompressed (original) size declared in the entry header. */
  originalSize: number;
  /** Compressed size declared in the entry header. */
  size: number;
}
interface FflateLib {
  unzipSync(
    data: Uint8Array,
    opts?: { filter?: (file: UnzipFileInfo) => boolean },
  ): Record<string, Uint8Array>;
}

/**
 * Unzip an archive with decompressed-size guards. The `filter` runs BEFORE each
 * entry is inflated, so an entry whose declared size exceeds the per-entry cap —
 * or that would push the running total past the aggregate cap — aborts the unzip
 * (thrown → caught → null → caller skips). This bounds the bomb a tiny archive
 * can inflate to. (A header that lies about its size is the residual case; the
 * upstream byte cap on the ingest routes plus the linear parsers keep that
 * bounded in practice.)
 */
async function unzip(path: string): Promise<Record<string, Uint8Array> | null> {
  const fflate = await loadOptional<FflateLib>('fflate');
  if (!fflate || typeof fflate.unzipSync !== 'function') return null;
  try {
    const buf = await readFile(path);
    let total = 0;
    return fflate.unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
      filter: (file) => {
        const size = file.originalSize || 0;
        if (size > MAX_ENTRY_BYTES) throw new Error('zip entry exceeds size cap');
        total += size;
        if (total > MAX_TOTAL_BYTES) throw new Error('zip total exceeds size cap');
        return true;
      },
    });
  } catch {
    return null; // not a valid zip / read error / over the size cap
  }
}

// ── Word (.docx via mammoth, .doc via word-extractor) ──

interface MammothLib {
  extractRawText(opts: { path: string }): Promise<{ value: string }>;
}

async function extractDocx(path: string): Promise<string | null> {
  const mod = await loadOptional<{ default?: MammothLib } & Partial<MammothLib>>('mammoth');
  const lib = mod?.default ?? (mod as MammothLib | null);
  if (!lib || typeof lib.extractRawText !== 'function') return null;
  try {
    const { value } = await lib.extractRawText({ path });
    return nullIfEmpty(value);
  } catch {
    return null;
  }
}

interface WordExtractorDoc {
  getBody(): string;
}
interface WordExtractorInstance {
  extract(path: string): Promise<WordExtractorDoc>;
}
type WordExtractorCtor = new () => WordExtractorInstance;

async function extractDoc(path: string): Promise<string | null> {
  const mod = await loadOptional<{ default?: WordExtractorCtor } | WordExtractorCtor>(
    'word-extractor',
  );
  const Ctor = (mod && 'default' in mod ? mod.default : mod) as WordExtractorCtor | undefined;
  if (typeof Ctor !== 'function') return null;
  try {
    const doc = await new Ctor().extract(path);
    return nullIfEmpty(doc.getBody());
  } catch {
    return null;
  }
}

// ── PDF (unpdf: serverless pdf.js, no native/canvas deps) ──

interface UnpdfLib {
  getDocumentProxy(data: Uint8Array): Promise<unknown>;
  extractText(
    pdf: unknown,
    opts: { mergePages: boolean },
  ): Promise<{ totalPages: number; text: string }>;
}

async function extractPdf(path: string): Promise<string | null> {
  const unpdf = await loadOptional<UnpdfLib>('unpdf');
  if (!unpdf || typeof unpdf.getDocumentProxy !== 'function') return null;
  try {
    const buf = await readFile(path);
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const text = await withTimeout(
      (async () => {
        const pdf = await unpdf.getDocumentProxy(data);
        const out = await unpdf.extractText(pdf, { mergePages: true });
        return out.text;
      })(),
      PDF_TIMEOUT_MS,
      'pdf extract timeout',
    );
    return nullIfEmpty(text);
  } catch {
    return null; // not a valid PDF / no text layer → caller may try a vision read
  }
}

// ── PowerPoint (.pptx → slide text runs) ──

function partNumber(name: string): number {
  const m = /(\d+)\.xml$/.exec(name);
  return m?.[1] ? parseInt(m[1], 10) : 0;
}

/**
 * Text of one slide. Runs (`<a:t>`) are concatenated WITHIN a paragraph
 * (`<a:p>`) with no separator — PowerPoint splits a single visual run at every
 * formatting boundary, so joining with spaces would inject `Hel lo`. Paragraphs
 * are the real break and join with newlines. A slide with no `<a:p>` (rare)
 * falls back to all runs concatenated.
 */
function slideText(xml: string): string {
  const paras: string[] = [];
  eachElement(xml, 'a:p', (_, inner) => {
    const runs = concatTagText(inner, 'a:t');
    if (runs.trim()) paras.push(runs);
  });
  if (paras.length === 0) {
    const runs = concatTagText(xml, 'a:t');
    if (runs.trim()) paras.push(runs);
  }
  return paras.join('\n');
}

async function extractPptx(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;
  const slides = Object.keys(entries)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => partNumber(a) - partNumber(b));
  if (slides.length === 0) return null;
  const parts: string[] = [];
  let total = 0;
  for (const n of slides) {
    if (total >= MAX_TEXT) break;
    const bytes = entries[n];
    if (!bytes) continue;
    const text = slideText(decodeUtf8(bytes))
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (text) {
      parts.push(text);
      total += text.length + 2;
    }
  }
  return nullIfEmpty(parts.join('\n\n'));
}

// ── Excel (.xlsx → shared strings + sheet cells) ──

async function extractXlsx(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;

  // Shared strings are POSITIONAL: cell t="s" with <v>k</v> means shared[k], so
  // every <si> (including an empty/self-closing one) must keep its slot. Phonetic
  // guides (<rPh>, CJK furigana) are stripped so only the base text is captured.
  const shared: string[] = [];
  const ssBytes = entries['xl/sharedStrings.xml'];
  if (ssBytes) {
    eachElement(decodeUtf8(ssBytes), 'si', (_, inner) => {
      shared.push(concatTagText(stripElement(inner, 'rPh'), 't'));
    });
  }

  const sheetNames = Object.keys(entries)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => partNumber(a) - partNumber(b));

  const rowsOut: string[] = [];
  let total = 0;
  for (const n of sheetNames) {
    if (total >= MAX_TEXT) break;
    const bytes = entries[n];
    if (!bytes) continue;
    eachElement(decodeUtf8(bytes), 'row', (_, rowInner) => {
      if (total >= MAX_TEXT) return;
      const cells: string[] = [];
      eachElement(rowInner, 'c', (attrs, body) => {
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        let val = '';
        if (type === 's') {
          const idx = parseInt(firstTagText(body, 'v'), 10);
          val = Number.isInteger(idx) ? (shared[idx] ?? '') : '';
        } else if (type === 'inlineStr') {
          val = concatTagText(body, 't');
        } else {
          val = decodeXmlEntities(firstTagText(body, 'v'));
        }
        if (val) cells.push(val);
      });
      if (cells.length) {
        const line = cells.join('\t');
        rowsOut.push(line);
        total += line.length + 1;
      }
    });
  }

  return nullIfEmpty(rowsOut.join('\n'));
}

// ── OpenDocument text/presentation (.odt/.odp → paragraph/heading text) ──

/**
 * Map ODF whitespace elements to literal whitespace before tags are stripped.
 * The `[^>]` attribute runs are length-bounded so an unterminated `<text:s`
 * flood can't drive O(n²) backtracking (a real whitespace element's attributes
 * are a handful of chars; 400 is a safe ceiling).
 */
function odfWhitespace(s: string): string {
  return s
    .replace(/<text:tab\b[^>]{0,400}\/?>/g, '\t')
    .replace(/<text:line-break\b[^>]{0,400}\/?>/g, '\n')
    .replace(/<text:s\b[^>]{0,400}\btext:c="(\d+)"[^>]{0,400}\/?>/g, (_, c: string) =>
      ' '.repeat(Math.min(parseInt(c, 10) || 1, 100)),
    )
    .replace(/<text:s\b[^>]{0,400}\/?>/g, ' ');
}

function odfParagraph(inner: string): string {
  return decodeXmlEntities(stripTags(odfWhitespace(inner))).trim();
}

async function extractOdfText(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;
  const contentBytes = entries['content.xml'];
  if (!contentBytes) return null;
  const xml = decodeUtf8(contentBytes);
  // Paragraphs and headings, in document order.
  const items: [number, string][] = [];
  const collect = (_: string, inner: string, start: number): void => {
    const line = odfParagraph(inner);
    if (line) items.push([start, line]);
  };
  eachElement(xml, 'text:p', collect);
  eachElement(xml, 'text:h', collect);
  items.sort((a, b) => a[0] - b[0]);
  const lines: string[] = [];
  let total = 0;
  for (const [, line] of items) {
    if (total >= MAX_TEXT) break;
    lines.push(line);
    total += line.length + 1;
  }
  return nullIfEmpty(lines.join('\n'));
}

// ── OpenDocument spreadsheet (.ods → table cells, incl. numeric values) ──

async function extractOds(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;
  const contentBytes = entries['content.xml'];
  if (!contentBytes) return null;
  const xml = decodeUtf8(contentBytes);
  const rows: string[] = [];
  let total = 0;
  eachElement(xml, 'table:table-row', (_, rowInner) => {
    if (total >= MAX_TEXT) return;
    const cells: string[] = [];
    eachElement(rowInner, 'table:table-cell', (attrs, body) => {
      const parts: string[] = [];
      eachElement(body, 'text:p', (__, p) => {
        const t = odfParagraph(p);
        if (t) parts.push(t);
      });
      let val = parts.join(' ').trim();
      if (!val) {
        // A numeric/date/boolean cell stores its value only in an attribute when
        // the display <text:p> is empty/absent.
        const ov =
          /\boffice:(?:value|date-value|time-value|string-value|boolean-value)="([^"]*)"/.exec(
            attrs,
          )?.[1];
        if (ov) val = decodeXmlEntities(ov);
      }
      if (val) cells.push(val);
    });
    if (cells.length) {
      const line = cells.join('\t');
      rows.push(line);
      total += line.length + 1;
    }
  });
  return nullIfEmpty(rows.join('\n'));
}

// ── EPUB (zip of XHTML, ordered by the OPF spine when present) ──

function normalizeZipPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Resolve an OPF href to a zip entry name: drop #fragment/?query, percent-decode. */
function resolveHref(baseDir: string, href: string): string {
  let h = href.split('#')[0]?.split('?')[0] ?? '';
  try {
    h = decodeURIComponent(h);
  } catch {
    /* malformed escape — keep raw */
  }
  return normalizeZipPath(baseDir + h);
}

async function extractEpub(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;

  let order: string[] = [];
  const container = entries['META-INF/container.xml'];
  const opfPath = container ? /full-path="([^"]+)"/.exec(decodeUtf8(container))?.[1] : undefined;
  if (opfPath && entries[opfPath]) {
    const opf = decodeUtf8(entries[opfPath]);
    const manifest: Record<string, string> = {};
    // Tolerant of both `<item .../>` and `<item ...></item>`.
    const itemRe = /<item\b[^>]*?>/g;
    let it: RegExpExecArray | null;
    while ((it = itemRe.exec(opf)) !== null) {
      const id = /\bid="([^"]+)"/.exec(it[0])?.[1];
      const href = /\bhref="([^"]+)"/.exec(it[0])?.[1];
      if (id && href) manifest[id] = href;
    }
    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const spineRe = /<itemref\b[^>]*?>/g;
    let sp: RegExpExecArray | null;
    while ((sp = spineRe.exec(opf)) !== null) {
      const idref = /\bidref="([^"]+)"/.exec(sp[0])?.[1];
      const href = idref ? manifest[idref] : undefined;
      if (href) order.push(resolveHref(baseDir, href));
    }
  }
  // Fallback: every (x)html entry, in numeric-aware name order (chap2 < chap10).
  if (order.length === 0) {
    order = Object.keys(entries)
      .filter((n) => /\.x?html?$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  const parts: string[] = [];
  let total = 0;
  for (const n of order) {
    if (total >= MAX_TEXT) break;
    const bytes = entries[n];
    if (!bytes) continue;
    const body = stripHtml(decodeUtf8(bytes));
    if (body) {
      parts.push(body);
      total += body.length + 2;
    }
  }
  return nullIfEmpty(parts.join('\n\n'));
}

// ── RTF (native de-RTF; no dependency) ──

/**
 * Control destinations whose group contents are never body text. `\*` (custom
 * destinations: hyperlinks, bookmarks, fields) needs no trailing boundary — the
 * char after `*` is the next control word's backslash. The named keywords need a
 * non-letter lookahead so `fonttbl` matches but `fonttblx` doesn't.
 */
const RTF_IGNORED_DESTINATIONS =
  /^\\(?:\*|(?:fonttbl|colortbl|stylesheet|info|pict|themedata|colorschememapping|latentstyles|datastore|listtable|listoverridetable|rsidtbl|generator|operator|xmlnstbl|wgrffmtfilter|mmathPr)(?![a-zA-Z]))/;

/**
 * Remove brace-matched groups that begin with an ignorable/destination control
 * word (font tables, colour tables, pictures, hyperlink/bookmark fields, …), so
 * only body text survives. Brace-aware so nested groups inside a destination are
 * dropped too. Builds output from kept slices (not per-char concat).
 */
function stripRtfDestinations(s: string): string {
  const kept: string[] = [];
  let keepFrom = 0;
  let i = 0;
  while (i < s.length) {
    // Bound the lookahead slice so the .test() stays O(1) per brace.
    if (s[i] === '{' && RTF_IGNORED_DESTINATIONS.test(s.slice(i + 1, i + 40))) {
      // Emit a separator in place of the removed group: a control word right
      // before it (e.g. `\ansi{\*\generator …}Body`) must not fuse with the text
      // right after it, or the greedy control-word stripper eats the first word.
      kept.push(s.slice(keepFrom, i), ' ');
      let depth = 1;
      let j = i + 1;
      for (; j < s.length && depth > 0; j++) {
        const ch = s[j];
        if (ch === '\\')
          j++; // skip the escaped char
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      i = j;
      keepFrom = i;
    } else {
      i++;
    }
  }
  kept.push(s.slice(keepFrom));
  return kept.join('');
}

/**
 * CP1252 mapping for bytes 0x80–0x9F (the range where Windows-1252 diverges from
 * Latin-1). Word writes `\'xx` escapes in the ANSI codepage, so 0x92 is a curly
 * apostrophe (’), 0x97 an em dash (—), 0x85 an ellipsis (…) — not the invisible
 * C1 controls Latin-1 would give. Bytes 0xA0–0xFF agree with Latin-1.
 */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

function cp1252Char(byte: number): string {
  if (byte >= 0x80 && byte <= 0x9f) {
    const cp = CP1252_HIGH[byte];
    return cp ? safeCodePoint(cp) : '';
  }
  return safeCodePoint(byte); // 0x00–0x7F and 0xA0–0xFF agree with Unicode
}

function rtfToText(rtf: string): string {
  let s = stripRtfDestinations(rtf);
  // Hex escapes (\'xx, ANSI/CP1252) and unicode escapes (\uN), before control
  // words are dropped. (\ucN skip-counts > 1 are not tracked — uc1 is the Word
  // default and covers the common case; a higher uc may leak a fallback glyph.)
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h: string) => cp1252Char(parseInt(h, 16)));
  s = s.replace(/\\u(-?\d+)\s?\??/g, (_, d: string) => {
    let n = parseInt(d, 10);
    if (n < 0) n += 65536;
    return safeCodePoint(n);
  });
  // Paragraph / line / tab breaks → whitespace.
  s = s
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\sect\b/g, '\n')
    .replace(/\\page\b/g, '\n')
    .replace(/\\tab\b/g, '\t');
  // Remaining control words and control symbols.
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, '').replace(/\\[^a-zA-Z]/g, '');
  s = s.replace(/[{}]/g, '');
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractRtf(path: string): Promise<string | null> {
  try {
    // RTF is 7-bit ASCII with escapes for everything else; latin1 keeps bytes intact.
    const raw = await readFile(path, 'latin1');
    if (!raw.startsWith('{\\rtf')) return null;
    return nullIfEmpty(rtfToText(raw));
  } catch {
    return null;
  }
}

/**
 * Extract text from a document by extension, natively (no external CLI). Returns
 * the extracted text, or `null` for an unsupported format, a missing parser
 * dependency, or any extraction failure — the caller degrades to a skip. Never
 * throws.
 */
export async function extractDocument(path: string, ext: string): Promise<string | null> {
  switch (ext) {
    case '.docx':
      return extractDocx(path);
    case '.doc':
      return extractDoc(path);
    case '.pdf':
      return extractPdf(path);
    case '.pptx':
      return extractPptx(path);
    case '.xlsx':
      return extractXlsx(path);
    case '.odt':
    case '.odp':
      return extractOdfText(path);
    case '.ods':
      return extractOds(path);
    case '.epub':
      return extractEpub(path);
    case '.rtf':
      return extractRtf(path);
    default:
      // Legacy binary .xls/.ppt (no clean pure-JS parser) and anything else.
      return null;
  }
}
