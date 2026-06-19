import { readFile } from 'node:fs/promises';
import {
  MAX_TEXT,
  PDF_TIMEOUT_MS,
  loadParser,
  nullIfEmpty,
  withTimeout,
  decodeUtf8,
  unzip,
  eachElement,
  concatTagText,
  firstTagText,
  stripElement,
  decodeXmlEntities,
} from './helpers.js';

// ── Word (.docx via mammoth, .doc via word-extractor) ──

interface MammothLib {
  extractRawText(opts: { path: string }): Promise<{ value: string }>;
}

export async function extractDocx(path: string): Promise<string | null> {
  const mod = await loadParser<{ default?: MammothLib } & Partial<MammothLib>>('mammoth');
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

export async function extractDoc(path: string): Promise<string | null> {
  const mod = await loadParser<{ default?: WordExtractorCtor } | WordExtractorCtor>(
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

export async function extractPdf(path: string): Promise<string | null> {
  const unpdf = await loadParser<UnpdfLib>('unpdf');
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

export async function extractPptx(path: string): Promise<string | null> {
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

export async function extractXlsx(path: string): Promise<string | null> {
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
