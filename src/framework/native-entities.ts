import type { Lattice } from '../lattice.js';
import type { TableDefinition } from '../types.js';

/**
 * Framework-shipped tables that every Lattice can opt into via
 * {@link registerNativeEntities}. These tables are intentionally generic —
 * they're the building blocks for app-level features (an API-key store, a
 * file repository) that should not require every consumer to re-derive
 * the column shape from scratch.
 *
 * Columns are deliberately a *superset* of any earlier ad-hoc shapes
 * (e.g. older fixtures defined `files` with `path` + `kind` only). New
 * code should prefer the content-addressed columns (`sha256`, `blob_path`)
 * for files; legacy columns remain for backwards-compatibility.
 *
 * `secrets.value` is encrypted at rest. Registering native entities on a
 * Lattice without an `encryptionKey` configured will throw at init time
 * — callers must supply one (env, options, or a derived master key).
 */
export const NATIVE_ENTITY_DEFS: Readonly<Record<string, TableDefinition>> = {
  secrets: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      kind: 'TEXT',
      value: 'TEXT',
      description: 'TEXT',
      created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      deleted_at: 'TEXT',
    },
    encrypted: { columns: ['value'] },
    render: () => '',
    outputFile: '.lattice-native/secrets.md',
  },
  files: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      // Legacy columns — older fixtures and seeds populate these. Either
      // legacy or content-addressed columns may be used per row.
      path: 'TEXT',
      kind: 'TEXT',
      // Content-addressed storage. `sha256` is the canonical content
      // identifier; `blob_path` is the relative path under
      // `<lattice-root>/data/blobs/` written by attachBlob().
      original_name: 'TEXT',
      mime: 'TEXT',
      size_bytes: 'INTEGER',
      sha256: 'TEXT',
      blob_path: 'TEXT',
      extraction_status: 'TEXT',
      extracted_text: 'TEXT',
      description: 'TEXT',
      created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '.lattice-native/files.md',
  },
};

/**
 * Register every native entity on the given Lattice. Must be called
 * BEFORE `db.init()` — uses `define()` so the tables are created as part
 * of schema application alongside any user-declared tables. Subsequent
 * calls on the same Lattice are a no-op (SchemaManager.define throws on
 * re-registration, so we guard).
 *
 * The Lattice must be configured with an `encryptionKey` (or
 * `LATTICE_ENCRYPTION_KEY` env var) because `secrets.value` is encrypted
 * at rest.
 */
export function registerNativeEntities(db: Lattice): void {
  const existing = new Set(db.getRegisteredTableNames());
  for (const [name, def] of Object.entries(NATIVE_ENTITY_DEFS)) {
    if (existing.has(name)) continue;
    db.define(name, def);
  }
}
