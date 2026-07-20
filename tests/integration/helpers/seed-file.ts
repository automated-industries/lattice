import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** The byte-location + metadata columns a test may seed onto a `files` row. */
export interface SeedFileRow {
  id?: string;
  name?: string;
  original_name?: string;
  mime?: string;
  ref_kind?: string;
  ref_uri?: string;
  ref_provider?: string;
  blob_path?: string;
  source_json?: string;
  artifact_type?: string;
}

/**
 * Insert a `files` row DIRECTLY into a workspace's SQLite DB — the way trusted server code
 * (ingest / upload) creates them. The generic HTTP write route deliberately REFUSES the
 * byte-location columns (`ref_kind` / `ref_uri` / `ref_provider` / `blob_path` / `source_json`)
 * so an attacker can't forge a row that streams an arbitrary host path or S3 bucket via the blob
 * route (S1). Tests that need such a row therefore seed it out of band, here. `root` is the
 * workspace dir (the parent of `data/test.db`).
 */
export function seedFileRowDirect(root: string, row: SeedFileRow): string {
  const id = row.id ?? randomUUID();
  // `files` requires only `id`; `original_name` (NOT `name`) is the display label. Insert just
  // the caller-provided columns + id (created_at/updated_at have DB defaults).
  const { name, ...rest } = row;
  const full: Record<string, unknown> = {
    ...rest,
    id,
    original_name: row.original_name ?? name ?? 'file',
  };
  const db = new Database(join(root, 'data', 'test.db'));
  try {
    const cols = Object.keys(full);
    const placeholders = cols.map(() => '?').join(', ');
    const colList = cols.map((c) => `"${c}"`).join(', ');
    db.prepare(`INSERT INTO files (${colList}) VALUES (${placeholders})`).run(
      ...cols.map((c) => full[c] ?? null),
    );
  } finally {
    db.close();
  }
  return id;
}
