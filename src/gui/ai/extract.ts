import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { extractDocument } from './doc-extractors.js';

/**
 * Core text extraction for ingested files. Handles the dependency-free cases
 * inline (plain text, common data formats, source code) and delegates document
 * formats (PDF, Word, PowerPoint, Excel, OpenDocument, EPUB, RTF) to the native
 * extractors in {@link extractDocument} — pure-JS parsers, no external CLI.
 * Anything still unreadable here (e.g. a scanned PDF with no text layer, an
 * image, a legacy binary `.xls`/`.ppt`) is flagged `skip: true`; the file stays
 * referenced and previewable, and the ingest layer may try a vision read.
 *
 * "Ingest" here means reference a local file + summarize its contents into
 * context — we never copy bytes into a blob store.
 */

export interface ExtractResult {
  /** Extracted UTF-8 text, or '' when nothing textual was read. */
  text: string;
  /** Source-code language hint, when the file is code. */
  language?: string;
  /** True when no meaningful text was extracted (binary / unsupported here). */
  skip?: boolean;
}

const MAX_TEXT = 200_000;

const CODE_LANGS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.sh': 'shell',
  '.sql': 'sql',
  '.css': 'css',
  '.scss': 'scss',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.lua': 'lua',
  '.r': 'r',
};

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.toml',
  '.ini',
  '.log',
  '.html',
  '.htm',
]);

const TEXT_MIME = /^(text\/|application\/(json|xml|xhtml\+xml|x-yaml|yaml|toml))/;

export function languageOf(name: string): string | null {
  return CODE_LANGS[extname(name).toLowerCase()] ?? null;
}

export function isCodeFile(name: string): boolean {
  return languageOf(name) !== null;
}

function truncate(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

/**
 * Extract text from a local file by path. `mimeHint` and `originalName`
 * sharpen the routing. Throws only on a genuine read error of a plain-text
 * file; document parsers degrade to `skip` rather than throw.
 */
export async function parseFile(
  path: string,
  mimeHint?: string,
  originalName?: string,
): Promise<ExtractResult> {
  const name = originalName ?? basename(path);
  const ext = extname(name).toLowerCase();
  const lang = languageOf(name);
  if (lang) {
    return { text: truncate(await readFile(path, 'utf8')), language: lang };
  }
  if ((mimeHint && TEXT_MIME.test(mimeHint)) || TEXT_EXT.has(ext)) {
    return { text: truncate(await readFile(path, 'utf8')) };
  }
  // Document formats (PDF / Office / OpenDocument / EPUB / RTF) extract natively.
  const doc = await extractDocument(path, ext);
  if (doc != null) {
    return { text: truncate(doc) };
  }
  return { text: '', skip: true };
}

/**
 * A short, non-LLM description for an ingested file: the first slice of its
 * text (whitespace-collapsed), or a binary fallback. An LLM-generated summary
 * can replace this later when a Claude token is configured.
 */
export function describe(text: string, mime: string | null, name: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length > 0) {
    return collapsed.length > 160 ? collapsed.slice(0, 160) + '…' : collapsed;
  }
  return `Binary file: ${name}${mime ? ` (${mime})` : ''}`;
}
