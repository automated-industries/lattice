/**
 * Read the Lattice-rendered context files for a single row — the organized,
 * pre-joined markdown a row's entity-context directory holds. Shared between the
 * GUI's `/api/.../context` route (serves it to the browser) and the AI
 * assistant's `get_row_context` tool (so it can reason over the rendered context
 * instead of re-deriving everything from raw DB reads).
 */
import { resolve, join, sep } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { EntityContextDefinition } from '../schema/entity-context.js';
import type { Lattice } from '../lattice.js';
import { entityFileNames, type LatticeManifest } from '../lifecycle/manifest.js';

/** Same value as `SECRET_MASK` in gui/ai/handlers/read.ts — kept local here to
 *  avoid a circular import (read.ts imports {@link readRowContext} from this file). */
const SECRET_MASK = '••••••••';

/** Per-file source metadata: what kind of data and table the file represents. */
export interface ContextFileSource {
  type: 'self' | 'hasMany' | 'manyToMany' | 'belongsTo' | 'custom' | 'enriched';
  table?: string; // source table for hasMany/manyToMany/belongsTo; null for self/custom/enriched
  count?: number | null; // row count for the source; null/omitted for custom/enriched or when count is unbounded
}

export interface ContextFile {
  name: string;
  path: string;
  content: string;
  source?: ContextFileSource; // source metadata (added in 5.0.0+)
}

/**
 * A row-context locator describes the on-disk shape of a single rendered entity
 * directory — independent of whether the directory was produced by a YAML-declared
 * {@link EntityContextDefinition}, a programmatic `db.defineEntityContext()` call,
 * or (manifest-only path) just by `lattice render` writing a manifest.
 */
export interface RowContextLocator {
  /** Directory (relative to outputDir) that holds this row's files. */
  directoryRoot: string;
  /** Slug derived from the row — appended to directoryRoot. */
  slug: string;
  /** Filenames inside the entity directory to surface. */
  fileNames: string[];
  /** Optional mapping of filename to its source metadata (added in 5.0.0+). */
  fileSources?: Record<string, ContextFileSource>;
}

/**
 * Best-effort slug derivation for the manifest-only fallback path. The manifest
 * tells us which slugs were rendered but not the slug formula, so when the schema
 * carries no {@link EntityContextDefinition} we try common fields and pick the
 * first whose value matches a rendered slug. Heuristic, not a guarantee.
 */
function deriveSlugFromManifest(
  row: Record<string, unknown>,
  knownSlugs: ReadonlySet<string>,
): string | null {
  for (const field of ['slug', 'id', 'name']) {
    const value = row[field];
    if (typeof value === 'string' && knownSlugs.has(value)) return value;
  }
  return null;
}

/**
 * Build a {@link RowContextLocator} for `(table, row)` using the layered
 * discovery chain: the live Lattice schema (authoritative slug + file list)
 * first, then the render manifest (slug derived heuristically). Returns `null`
 * when neither yields a locator.
 */
export function buildRowContextLocator(
  table: string,
  row: Record<string, unknown>,
  schemaDef: EntityContextDefinition | undefined,
  manifest: LatticeManifest | null,
): RowContextLocator | null {
  if (schemaDef) {
    // Extract source metadata from the schema definition: each file's source type
    // and table (if applicable). Counts are computed separately and merged in later.
    const fileSources: Record<string, ContextFileSource> = {};
    for (const [filename, fileSpec] of Object.entries(schemaDef.files)) {
      const src = fileSpec.source;
      const source: ContextFileSource = { type: src.type };
      if (src.type === 'hasMany') {
        source.table = src.table;
      } else if (src.type === 'manyToMany') {
        source.table = src.remoteTable;
      } else if (src.type === 'belongsTo') {
        source.table = src.table;
      }
      // count is computed separately when needed (see computeContextFileSourceCounts)
      fileSources[filename] = source;
    }
    return {
      directoryRoot: schemaDef.directoryRoot ?? '',
      slug: schemaDef.slug(row),
      fileNames: Object.keys(schemaDef.files),
      fileSources,
    };
  }
  const manifestEntry = manifest?.entityContexts[table];
  if (!manifestEntry) return null;
  const knownSlugs = new Set(Object.keys(manifestEntry.entities));
  const derivedSlug = deriveSlugFromManifest(row, knownSlugs);
  if (!derivedSlug) return null;
  const entityFiles = manifestEntry.entities[derivedSlug];
  const fileNames = entityFiles ? entityFileNames(entityFiles) : manifestEntry.declaredFiles;
  return { directoryRoot: manifestEntry.directoryRoot, slug: derivedSlug, fileNames };
}

/**
 * Read the rendered context files for one row (relative to `outputDir`), with
 * their content if present on disk. Unrendered files come back with empty
 * content. Secret-column `key: value` lines are redacted so a masked value never
 * leaks through the rendered markdown. Optionally includes source metadata
 * (type, table, count) from the locator's fileSources map.
 */
export function readRowContext(
  outputDir: string,
  locator: RowContextLocator,
  secretCols: Set<string>,
): ContextFile[] {
  const { slug, directoryRoot, fileNames, fileSources } = locator;
  const entityDir = resolve(outputDir, directoryRoot, slug);
  // Defence in depth: the slug must not escape outputDir.
  const resolvedBase = resolve(outputDir);
  if (entityDir !== resolvedBase && !entityDir.startsWith(resolvedBase + sep)) {
    throw new Error(`Path traversal detected: slug "${slug}" escapes output directory`);
  }
  return fileNames.map((filename) => {
    const absPath = join(entityDir, filename);
    const relPath = [directoryRoot, slug, filename].join('/');
    if (!existsSync(absPath)) {
      const file: ContextFile = { name: filename, path: relPath, content: '' };
      if (fileSources?.[filename]) file.source = fileSources[filename];
      return file;
    }
    let content = readFileSync(absPath, 'utf8');
    for (const col of secretCols) {
      // Redact the secret value in EVERY shape the renderer can emit it: the
      // DEFAULT bold bullet `- **col:** value` (renderSelf), an inline
      // `**col:** value`, and a plain/frontmatter `col: value` line. The old
      // `^col:` anchor missed the bold-bullet form and leaked secrets to the
      // browser. The column name is regex-escaped so an unusual name can't alter
      // the pattern. The bold-bullet match also swallows the value's 2-space-indented
      // CONTINUATION lines (the multi-line render encoding — renderFieldBullet),
      // INCLUDING an interior blank line (rendered as an empty line) when another
      // indented line follows it — so a multi-line secret (a PEM key, a
      // multi-paragraph token) is masked whole, not just up to its first blank line.
      // The continuation stops at the next unindented content, so a trailing blank +
      // the next field/section is never swallowed. `\r?` handles a CRLF-rendered file.
      const esc = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      content = content
        .replace(
          new RegExp(
            `^(\\s*(?:[-*]\\s+)?\\*\\*${esc}:\\*\\*\\s*).*(?:\\r?\\n(?: {2,}.*| *(?=\\r?\\n {2,})))*`,
            'gm',
          ),
          `$1${SECRET_MASK}`,
        )
        .replace(new RegExp(`^(${esc}:\\s*).*?\\r?$`, 'gm'), `$1${SECRET_MASK}`);
    }
    const file: ContextFile = { name: filename, path: relPath, content };
    if (fileSources?.[filename]) file.source = fileSources[filename];
    return file;
  });
}

/**
 * Compute row counts for context file sources. For hasMany/manyToMany/belongsTo
 * sources, issues a bounded COUNT(*) query; for custom/self/enriched sources,
 * skips counting. Updates the fileSources map in-place with count values.
 *
 * Bounded by construction: each source specifies its foreign key and table,
 * so the queries stay highly selective (no full-table scans).
 *
 * @param db Lattice instance for running queries
 * @param table The primary table name
 * @param row The row being rendered (needed to resolve FK values for belongs-to)
 * @param schemaDef The entity context definition (contains source specs)
 * @param fileSources Mutable map of filename → source metadata (counts are added here)
 */
export async function computeContextFileSourceCounts(
  db: Lattice,
  table: string,
  row: Record<string, unknown>,
  schemaDef: EntityContextDefinition | undefined,
  fileSources: Record<string, ContextFileSource>,
): Promise<void> {
  if (!schemaDef) return; // manifest-only path: counts unavailable

  // A composite PK falls back to its first column: relation sources reference a
  // single column, so the first PK column is the only usable join key here.
  const pkRaw = db.getPrimaryKey(table);
  const pkCol = Array.isArray(pkRaw) ? pkRaw[0] : pkRaw;

  for (const [filename, fileSpec] of Object.entries(schemaDef.files)) {
    const source = fileSources[filename];
    if (!source || source.type === 'self' || source.type === 'custom' || source.type === 'enriched') {
      continue; // counts not applicable
    }

    try {
      let count: number | null = null;

      if (source.type === 'hasMany' && fileSpec.source.type === 'hasMany') {
        // COUNT(*) FROM <source.table> WHERE <fk> = ?
        const fk = fileSpec.source.foreignKey;
        const refCol = fileSpec.source.references ?? pkCol ?? 'id';
        const pkVal = row[refCol];
        if (pkVal != null) {
          count = await db.count(source.table!, {
            filters: [{ col: fk, op: 'eq', val: pkVal }],
          });
        }
      } else if (source.type === 'manyToMany' && fileSpec.source.type === 'manyToMany') {
        // COUNT(*) FROM <junctionTable> WHERE localKey = ?
        // (junction-row count is the display semantic for m2m rollups)
        const src = fileSpec.source;
        const refCol = src.references ?? pkCol ?? 'id';
        const pkVal = row[refCol];
        if (pkVal != null) {
          // Bounded count: only junction rows matching localKey.
          count = await db.count(src.junctionTable, {
            filters: [{ col: src.localKey, op: 'eq', val: pkVal }],
          });
        }
      } else if (source.type === 'belongsTo' && fileSpec.source.type === 'belongsTo') {
        // belongsTo always returns 0 or 1 row. Check if the FK is populated.
        const fk = fileSpec.source.foreignKey;
        const fkVal = row[fk];
        count = fkVal != null ? 1 : 0;
      }

      if (count !== null) {
        source.count = count;
      }
    } catch {
      // Best-effort: if the count query fails (permissions, schema issues),
      // degrade gracefully and leave count undefined.
    }
  }
}
