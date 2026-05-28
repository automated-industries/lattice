import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Core text extraction for ingested files. Handles the dependency-free cases
 * (plain text, common data formats, source code). PDFs, office docs, and
 * images are flagged `skip: true` for now — the file is still referenced and
 * previewable; richer extraction (pypdfium2 / markitdown / vision) is a
 * follow-up that degrades gracefully when those optional binaries are absent.
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
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.rb': 'ruby', '.go': 'go',
  '.rs': 'rust', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin', '.sh': 'shell',
  '.sql': 'sql', '.css': 'css', '.scss': 'scss', '.vue': 'vue', '.svelte': 'svelte',
  '.lua': 'lua', '.r': 'r',
};

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.rst', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.xml', '.toml', '.ini', '.log', '.html', '.htm',
]);

const TEXT_MIME = /^(text\/|application\/(json|xml|xhtml\+xml|x-yaml|yaml|toml))/;

/** Formats the optional `markitdown` CLI can convert to text when installed. */
const MARKITDOWN_EXT = new Set([
  '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.epub', '.rtf', '.odt', '.ods', '.odp',
]);
const MARKITDOWN_TIMEOUT_MS = 120_000;
const MARKITDOWN_MAX_BYTES = 50_000_000;

/**
 * Try the optional `markitdown` CLI to extract text from PDFs/office docs.
 * Resolves to the text on success, or null when the binary is absent, errors,
 * times out, or produces nothing — callers then fall back to skip. Never
 * throws (graceful degradation when the optional dependency isn't installed).
 */
function runMarkitdown(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const bin = process.env.MARKITDOWN_BIN ?? 'markitdown';
    let child;
    try {
      child = spawn(bin, [path], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let bytes = 0;
    let settled = false;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, MARKITDOWN_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > MARKITDOWN_MAX_BYTES) {
        child.kill();
        finish(null);
      } else {
        out += c.toString('utf8');
      }
    });
    child.on('error', () => finish(null)); // binary not installed
    child.on('close', (code) => finish(code === 0 && out.trim() ? out.trim() : null));
  });
}

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
 * sharpen the routing. Throws only on a genuine read error.
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
  if (MARKITDOWN_EXT.has(ext)) {
    const md = await runMarkitdown(path);
    if (md) return { text: truncate(md) };
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
