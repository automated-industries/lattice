import { readFile } from 'node:fs/promises';

/**
 * Native, dependency-light text extraction for document formats. The parsers are
 * regular dependencies (present on every `npm install`), lazily resolved so the
 * bundler keeps them external. Each extractor NEVER throws — on an invalid file or
 * any parse error it returns `null` and the caller degrades to a `skip`. A parser
 * that fails to *load*, by contrast, means a broken/partial install, not an
 * expected state, so it is logged loudly (see {@link loadParser}) rather than
 * silently swallowed — silent swallowing is exactly what made dragged documents
 * extract nothing on installs that dropped the (then-optional) parsers.
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
 * The parsers are lazy-loaded through a LITERAL `import('<name>')` thunk (see
 * {@link loadParser}), never a runtime variable specifier. A variable specifier
 * is invisible to the packaged desktop app's static bundler (`deno desktop`),
 * which silently drops every parser from the app and makes dragged Office
 * documents extract nothing; a literal specifier is discovered and bundled while
 * staying lazy (the thunk only runs when that format is actually parsed). They
 * ship as regular dependencies, so a load failure means a corrupted install and
 * is surfaced loudly rather than degraded into a silent empty extraction.
 */

export const MAX_TEXT = 200_000;
/** Per-decompressed-entry ceiling (bomb guard; entries above this abort the unzip). */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Aggregate decompressed ceiling across all admitted entries. */
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Wall-clock ceiling for a single PDF parse (a pathological PDF can't hang ingest). */
export const PDF_TIMEOUT_MS = 30_000;

const textDecoder = new TextDecoder('utf-8');
export function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/**
 * Import a document parser by name. The parsers are regular dependencies, so a
 * failure here means a broken/partial install (e.g. `--omit=optional` carried over
 * from when these were optional, or a corrupted `node_modules`). Surface it loudly
 * rather than silently degrading every document to an empty `skip` — that silent
 * path is precisely what made dropped documents extract nothing. Still returns
 * `null` so the extractor degrades gracefully (never throws), but the cause is now
 * on the record.
 */
export async function loadParser<T>(load: () => Promise<unknown>, name: string): Promise<T | null> {
  try {
    return (await load()) as T;
  } catch (err) {
    console.error(
      `[latticesql] document parser "${name}" failed to load — document ` +
        `extraction is degraded (likely a broken/partial install or incompatible ` +
        `build). Reinstall dependencies (\`npm install\`). Cause:`,
      err,
    );
    return null;
  }
}

export function nullIfEmpty(s: string): string | null {
  const t = s.trim();
  return t ? t : null;
}

/** Reject the promise if it doesn't settle within `ms` (timer is unref'd + cleared). */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
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

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" stays the literal "&lt;"
}

export function safeCodePoint(n: number): string {
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
export function stripTags(s: string): string {
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
export function eachElement(
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
export function stripElement(xml: string, tag: string): string {
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
export function concatTagText(xml: string, tag: string): string {
  let out = '';
  eachElement(xml, tag, (_, inner) => {
    out += decodeXmlEntities(stripTags(inner));
  });
  return out;
}

/** Inner text of the FIRST `<tag>` element (or ''). */
export function firstTagText(xml: string, tag: string): string {
  let found = '';
  let done = false;
  eachElement(xml, tag, (_, inner) => {
    if (done) return;
    found = inner;
    done = true;
  });
  return found;
}

export function stripHtml(html: string): string {
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
export async function unzip(path: string): Promise<Record<string, Uint8Array> | null> {
  const fflate = await loadParser<FflateLib>(() => import('fflate'), 'fflate');
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
