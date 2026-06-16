import type { Lattice } from '../lattice.js';
import type { Row } from '../types.js';
import { allAsyncOrSync } from '../db/adapter.js';
import { slugify } from '../render/markdown.js';

/**
 * Helpers for constructing valid `files` rows, shared by the ingest routes and
 * the assistant's `create_artifact` tool.
 *
 * This is deliberately a LEAF module: it imports only the DB adapter and the
 * markdown slugify util, never the chat/AI layer. That lets `ai/dispatch` reuse
 * it without an import cycle — `ai/dispatch → file-row` is safe, whereas
 * `ai/dispatch → ingest-routes → ai/chat → ai/dispatch` (where these helpers
 * used to live) was a cycle.
 */

/** Columns Lattice manages structurally; never a free-text default target. */
export const STRUCTURAL = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);

const TEXT_COL_RE = /\b(TEXT|VARCHAR|CHAR|CLOB|CHARACTER|STRING|NAME|CITEXT)\b/i;

export function fileSlug(name: string, id: string): string {
  const base = slugify(name.replace(/\.[^./\\]+$/, '')) || 'file';
  return `${base}-${id.slice(0, 8)}`;
}

/**
 * Display identity for a `files` row (slug + name + title). Customized/cloud
 * `files` schemas often carry NOT-NULL identity columns; populate them up front
 * so a write never trips on one. `_filterToSchemaColumns` drops any the live
 * schema lacks.
 */
export function fileIdentity(displayName: string, id: string): Record<string, string> {
  const label = displayName.trim() || 'file';
  return { slug: fileSlug(displayName, id), name: label, title: label };
}

/**
 * Names of the NOT-NULL, no-default, text-typed columns on the LIVE `files`
 * table, by PHYSICAL introspection — so it reflects the actual table (a legacy
 * schema, a raw-SQL table, or a cloud-synced one), not just Lattice's declared
 * definition, which can diverge. Dialect-aware; best-effort (returns empty on any
 * introspection error so ingest still proceeds). Primary-key columns are excluded
 * (`id` is always supplied), as are non-text columns (a filename can't satisfy a
 * NOT NULL integer/blob; the known numeric columns are set explicitly).
 */
async function requiredTextFileColumns(db: Lattice): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    if (db.getDialect() === 'postgres') {
      const rows = await allAsyncOrSync(
        db.adapter,
        `SELECT column_name AS name, data_type AS type, is_nullable, column_default AS dflt
           FROM information_schema.columns
          WHERE table_name = 'files' AND table_schema = current_schema()`,
      );
      for (const r of rows) {
        if (
          String(r.is_nullable).toUpperCase() === 'NO' &&
          r.dflt == null &&
          TEXT_COL_RE.test(String(r.type))
        ) {
          out.add(String(r.name));
        }
      }
    } else {
      const rows = await allAsyncOrSync(db.adapter, `PRAGMA table_info("files")`);
      for (const r of rows) {
        if (
          Number(r.notnull) === 1 &&
          r.dflt_value == null &&
          Number(r.pk) === 0 &&
          TEXT_COL_RE.test(String(r.type))
        ) {
          out.add(String(r.name));
        }
      }
    }
  } catch {
    /* best-effort — leave the set empty and let the insert proceed */
  }
  return out;
}

/**
 * Fill any required text column on the live `files` table that the insert
 * doesn't already set, with a filename-derived value — so a write NEVER fails
 * on a required column, whatever the (customized/legacy/cloud-synced) `files`
 * schema declares NOT NULL, including `path`. Slug-like columns get a filename
 * slug; everything else gets the display name. The native `files` entity declares
 * these all nullable, so this is a no-op there: it only fires on a schema that
 * genuinely requires the column (the "NOT NULL constraint failed: files.<col>"
 * case) and never writes a bogus `path` onto a nullable schema (which would
 * shadow the blob/ref the file is actually served from).
 */
export async function requiredFileDefaults(
  db: Lattice,
  displayName: string,
  id: string,
  provided: Record<string, unknown>,
): Promise<Record<string, string>> {
  const required = await requiredTextFileColumns(db);
  const label = displayName.trim() || 'file';
  const out: Record<string, string> = {};
  for (const col of required) {
    if (STRUCTURAL.has(col)) continue;
    if (provided[col] != null) continue;
    out[col] = /slug/i.test(col) ? fileSlug(displayName, id) : label;
  }
  return out;
}

/**
 * Build a complete `files` row for an assistant-authored markdown ARTIFACT: the
 * markdown lives inline in `extracted_text` (so the viewer renders it via the
 * existing markdown file preview), flagged `artifact_type='markdown'`, with a
 * `.md` display name + slug/name/title and any NOT-NULL defaults a customized
 * files schema requires. The caller persists it via `createRow`, which applies
 * sharing/visibility (private mode → private) like any other file.
 */
export async function artifactFileRow(
  db: Lattice,
  title: string,
  content: string,
): Promise<{ row: Row; id: string }> {
  const id = crypto.randomUUID();
  const trimmed = title.trim() || 'Untitled';
  const name = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  const draft: Row = {
    id,
    ...fileIdentity(trimmed, id),
    original_name: name,
    mime: 'text/markdown',
    size_bytes: Buffer.byteLength(content, 'utf8'),
    extracted_text: content,
    extraction_status: 'extracted',
    artifact_type: 'markdown',
  };
  const row: Row = { ...(await requiredFileDefaults(db, name, id, draft)), ...draft };
  return { row, id };
}
