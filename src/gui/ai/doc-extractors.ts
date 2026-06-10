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
 *   .odt / .odp / .ods  native (ODF zip → `content.xml` paragraph/cell text)
 *   .epub               native (zip → spine XHTML, tags stripped)
 *   .rtf                native de-RTF (control words/groups stripped)
 *
 * Legacy binary `.xls` and `.ppt` (pre-2007 BIFF/PPT) have no clean, non-vulnerable
 * pure-JS parser, so they degrade to `skip` (the file is still referenced).
 *
 * The optional parsers are resolved through a string-variable specifier so the
 * bundler leaves them as runtime imports (resolved from the consumer's
 * node_modules) and a missing one is just a caught import error, not a build
 * dependency.
 */

const MAX_TEXT = 200_000;

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

// ── Entity decoding + tag text collection (shared by the zip-based formats) ──

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
 * Inner text of every `<tag …>…</tag>` occurrence (nested tags stripped,
 * entities decoded). Used to pull `<a:t>`, `<w:t>`, `<t>` runs out of the
 * relevant XML part. The tag name is taken literally (callers pass fixed names).
 */
function collectTagText(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const inner = (m[1] ?? '').replace(/<[^>]+>/g, '');
    out.push(decodeXmlEntities(inner));
  }
  return out;
}

function stripHtml(html: string): string {
  const noScript = html.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ');
  const text = decodeXmlEntities(noScript.replace(/<[^>]+>/g, ' '));
  return text
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Zip container helper (OOXML / ODF / EPUB are all zip archives) ──

interface FflateLib {
  unzipSync(data: Uint8Array): Record<string, Uint8Array>;
}

async function unzip(path: string): Promise<Record<string, Uint8Array> | null> {
  const fflate = await loadOptional<FflateLib>('fflate');
  if (!fflate || typeof fflate.unzipSync !== 'function') return null;
  try {
    const buf = await readFile(path);
    return fflate.unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } catch {
    return null; // not a valid zip / read error
  }
}

function nullIfEmpty(s: string): string | null {
  const t = s.trim();
  return t ? t : null;
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
    const pdf = await unpdf.getDocumentProxy(data);
    const { text } = await unpdf.extractText(pdf, { mergePages: true });
    return nullIfEmpty(text);
  } catch {
    return null; // not a valid PDF / no text layer → caller may try a vision read
  }
}

// ── PowerPoint (.pptx → slide text runs) ──

function slideNumber(name: string): number {
  const m = /(\d+)\.xml$/.exec(name);
  return m?.[1] ? parseInt(m[1], 10) : 0;
}

async function extractPptx(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;
  const slides = Object.keys(entries)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (slides.length === 0) return null;
  const parts: string[] = [];
  for (const n of slides) {
    const bytes = entries[n];
    if (!bytes) continue;
    const runs = collectTagText(decodeUtf8(bytes), 'a:t');
    const slideText = runs
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (slideText) parts.push(slideText);
  }
  return nullIfEmpty(parts.join('\n\n'));
}

// ── Excel (.xlsx → shared strings + sheet cells) ──

async function extractXlsx(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;

  // Shared strings: each <si> can hold several <t> runs (rich text).
  const shared: string[] = [];
  const ssBytes = entries['xl/sharedStrings.xml'];
  if (ssBytes) {
    const ssXml = decodeUtf8(ssBytes);
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(ssXml)) !== null) {
      shared.push(collectTagText(m[1] ?? '', 't').join(''));
    }
  }

  const sheetNames = Object.keys(entries)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const rowsOut: string[] = [];
  for (const n of sheetNames) {
    const bytes = entries[n];
    if (!bytes) continue;
    const xml = decodeUtf8(bytes);
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let r: RegExpExecArray | null;
    while ((r = rowRe.exec(xml)) !== null) {
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let c: RegExpExecArray | null;
      const rowXml = r[1] ?? '';
      while ((c = cellRe.exec(rowXml)) !== null) {
        const attrs = c[1] ?? '';
        const body = c[2] ?? '';
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        let val = '';
        if (type === 's') {
          const idx = parseInt(collectTagText(body, 'v')[0] ?? '', 10);
          val = Number.isInteger(idx) ? (shared[idx] ?? '') : '';
        } else if (type === 'inlineStr') {
          val = collectTagText(body, 't').join('');
        } else {
          val = collectTagText(body, 'v')[0] ?? '';
        }
        if (val) cells.push(val);
      }
      if (cells.length) rowsOut.push(cells.join('\t'));
    }
  }

  return nullIfEmpty(rowsOut.join('\n') || shared.join('\n'));
}

// ── OpenDocument (.odt/.odp/.ods → content.xml paragraph/cell text) ──

async function extractOdf(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;
  const contentBytes = entries['content.xml'];
  if (!contentBytes) return null;
  const xml = decodeUtf8(contentBytes);
  // Paragraphs and headings, in document order (cells store their display text
  // in a <text:p>, so this captures spreadsheet values too).
  const re = /<text:(p|h)(?:\s[^>]*)?>([\s\S]*?)<\/text:\1>/g;
  const lines: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const line = decodeXmlEntities((m[2] ?? '').replace(/<[^>]+>/g, '')).trim();
    if (line) lines.push(line);
  }
  return nullIfEmpty(lines.join('\n'));
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

async function extractEpub(path: string): Promise<string | null> {
  const entries = await unzip(path);
  if (!entries) return null;

  let order: string[] = [];
  const container = entries['META-INF/container.xml'];
  const opfPath = container ? /full-path="([^"]+)"/.exec(decodeUtf8(container))?.[1] : undefined;
  if (opfPath && entries[opfPath]) {
    const opf = decodeUtf8(entries[opfPath]);
    const manifest: Record<string, string> = {};
    const itemRe = /<item\b[^>]*\/>/g;
    let it: RegExpExecArray | null;
    while ((it = itemRe.exec(opf)) !== null) {
      const id = /\bid="([^"]+)"/.exec(it[0])?.[1];
      const href = /\bhref="([^"]+)"/.exec(it[0])?.[1];
      if (id && href) manifest[id] = href;
    }
    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const spineRe = /<itemref\b[^>]*\/>/g;
    let sp: RegExpExecArray | null;
    while ((sp = spineRe.exec(opf)) !== null) {
      const idref = /\bidref="([^"]+)"/.exec(sp[0])?.[1];
      const href = idref ? manifest[idref] : undefined;
      if (href) order.push(normalizeZipPath(baseDir + href));
    }
  }
  // Fallback: every (x)html entry, in name order.
  if (order.length === 0) {
    order = Object.keys(entries)
      .filter((n) => /\.x?html?$/i.test(n))
      .sort();
  }

  const parts: string[] = [];
  for (const n of order) {
    const bytes = entries[n];
    if (!bytes) continue;
    const body = stripHtml(decodeUtf8(bytes));
    if (body) parts.push(body);
    if (parts.join('\n\n').length > MAX_TEXT) break;
  }
  return nullIfEmpty(parts.join('\n\n'));
}

// ── RTF (native de-RTF; no dependency) ──

/** Control destinations whose group contents are never body text. */
const RTF_IGNORED_DESTINATIONS = new RegExp(
  '^\\\\(?:\\*|fonttbl|colortbl|stylesheet|info|pict|themedata|colorschememapping|latentstyles|' +
    'datastore|listtable|listoverridetable|rsidtbl|generator|operator|xmlnstbl|wgrffmtfilter|mmathPr)\\b',
);

/**
 * Remove brace-matched groups that begin with an ignorable/destination control
 * word (font tables, colour tables, pictures, metadata, …), so only body text
 * survives. Brace-aware so nested groups inside a destination are dropped too.
 */
function stripRtfDestinations(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (s[i] === '{' && RTF_IGNORED_DESTINATIONS.test(s.slice(i + 1))) {
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
      continue;
    }
    out += s[i] ?? '';
    i++;
  }
  return out;
}

function rtfToText(rtf: string): string {
  let s = stripRtfDestinations(rtf);
  // Hex escapes (\'xx) and unicode escapes (\uN), before control words are dropped.
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h: string) => safeCodePoint(parseInt(h, 16)));
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
    case '.ods':
      return extractOdf(path);
    case '.epub':
      return extractEpub(path);
    case '.rtf':
      return extractRtf(path);
    default:
      // Legacy binary .xls/.ppt (no clean pure-JS parser) and anything else.
      return null;
  }
}
