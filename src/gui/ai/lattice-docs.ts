import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read + search LATTICE'S OWN documentation — the SINGLE canonical source: the
 * repo's `docs/*.md` (which are the GitHub docs and ship in the npm package). The
 * chat assistant exposes this through the `lattice_help` tool so it can answer
 * "what is Private mode?", "how does sharing work?" etc. from the same docs the
 * website + npm + GitHub serve — no separate, drift-prone copy.
 *
 * The docs are markdown on disk (not bundled into dist), so we locate the `docs/`
 * directory at runtime relative to this module: in dev it sits at <repo>/docs; in
 * the published package tsup bundles this code into <pkg>/dist, with `docs/`
 * shipped alongside (see package.json "files"). We walk up from the module dir
 * until we find a `docs/` that contains the known guides.
 */

let _docsDir: string | null | undefined; // undefined = not looked up; null = not found

function findDocsDir(): string | null {
  if (_docsDir !== undefined) return _docsDir;
  // Explicit override wins: the packaged desktop app extracts docs/ to a spot the
  // up-walk below can't reach, so desktop/main.ts resolves it and passes the path
  // here. (This file already relies on process.* under Deno, e.g. process.cwd().)
  const envDir = process.env.LATTICE_DOCS_DIR;
  if (envDir && existsSync(join(envDir, 'cloud.md'))) {
    _docsDir = envDir;
    return _docsDir;
  }
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  // Walk up a bounded number of levels looking for a docs/ dir with our guides.
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'docs');
    if (existsSync(join(candidate, 'cloud.md'))) {
      _docsDir = candidate;
      return _docsDir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _docsDir = null;
  return _docsDir;
}

export interface DocSection {
  /** Source doc file (e.g. "cloud.md"). */
  file: string;
  /** The section heading text. */
  heading: string;
  /** The section's markdown body (heading + content, capped). */
  text: string;
}

const MAX_SECTION_CHARS = 2400;
const _cache = new Map<string, DocSection[]>();

/** Parse one markdown doc into heading-delimited sections (## / ### level). */
function sectionsOf(file: string, md: string): DocSection[] {
  const lines = md.split('\n');
  const out: DocSection[] = [];
  let heading = file.replace(/\.md$/, '');
  let buf: string[] = [];
  const flush = (): void => {
    const text = buf.join('\n').trim();
    if (text) out.push({ file, heading, text: text.slice(0, MAX_SECTION_CHARS) });
    buf = [];
  };
  for (const line of lines) {
    const m = /^#{1,3}\s+(.+)$/.exec(line);
    if (m) {
      flush();
      heading = (m[1] ?? heading).trim();
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** All doc sections across the canonical docs (cached). Empty if docs not found. */
function allSections(): DocSection[] {
  const dir = findDocsDir();
  if (!dir) return [];
  const key = dir;
  const cached = _cache.get(key);
  if (cached) return cached;
  const out: DocSection[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    files = [];
  }
  for (const f of files) {
    try {
      out.push(...sectionsOf(f, readFileSync(join(dir, f), 'utf8')));
    } catch {
      // skip an unreadable file
    }
  }
  _cache.set(key, out);
  return out;
}

export interface DocsSearchResult {
  /** Best-matching documentation sections for the query. */
  sections: { source: string; heading: string; text: string }[];
  /** When nothing matched (or docs are unavailable), the list of doc topics. */
  available?: string[];
  note?: string;
}

/**
 * Search the canonical Lattice docs for a free-text query and return the most
 * relevant sections. Scores by heading + body term hits. Returns an availability
 * note + topic index when docs can't be located (e.g. an old package missing the
 * shipped `docs/`), so the assistant degrades gracefully instead of inventing.
 */
export function searchLatticeDocs(query: string, limit = 4): DocsSearchResult {
  const sections = allSections();
  if (sections.length === 0) {
    return {
      sections: [],
      note: 'Lattice documentation is not bundled with this build; answer only from what you reliably know about Lattice, and say if you are unsure.',
    };
  }
  const q = query.toLowerCase().trim();
  const terms = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (terms.length === 0) {
    return { sections: [], available: [...new Set(sections.map((s) => s.heading))].slice(0, 40) };
  }
  const scored = sections
    .map((s) => {
      const head = s.heading.toLowerCase();
      const body = s.text.toLowerCase();
      let score = 0;
      if (body.includes(q)) score += 4;
      for (const t of terms) {
        if (head.includes(t)) score += 3;
        if (body.includes(t)) score += 1;
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) {
    return { sections: [], available: [...new Set(sections.map((s) => s.heading))].slice(0, 40) };
  }
  return {
    sections: scored.slice(0, limit).map((x) => ({
      source: x.s.file,
      heading: x.s.heading,
      text: x.s.text,
    })),
  };
}
