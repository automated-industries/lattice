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
      // NOT NULL needs a DEFAULT so ALTER TABLE ADD COLUMN succeeds when this
      // native shape is merged onto a pre-existing table (the adopt + team
      // shared-schema sync paths use ADD COLUMN; SQLite + Postgres both reject
      // a NOT NULL add without a default). Every insert sets `name` explicitly,
      // so the default is never observed in practice.
      name: "TEXT NOT NULL DEFAULT ''",
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
  chat_threads: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      title: 'TEXT',
      created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '.lattice-native/chat-threads.md',
  },
  chat_messages: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      // Soft reference to chat_threads.id. Kept as a plain column (no FK)
      // to match the generic, dialect-agnostic native-entity style.
      thread_id: 'TEXT',
      // user | assistant | tool | feed | system
      role: 'TEXT NOT NULL',
      // JSON payload: text, tool_use / tool_result blocks, attachments, or
      // (for role='feed') the feed-event details.
      content_json: 'TEXT',
      // ai | gui | cli | ingest — meaningful for role='feed'.
      source: 'TEXT',
      created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '.lattice-native/chat-messages.md',
  },
};

/**
 * The canonical set of native-entity table names, derived from
 * {@link NATIVE_ENTITY_DEFS}. This is the single source of truth: any code
 * that needs to know "is this table a framework-shipped native object?"
 * — the GUI's table allowlist, the entity-listing filter, the adopt flow —
 * should consult {@link isNativeEntity} / this set rather than hard-coding
 * `'files'` / `'secrets'`. Add a key to NATIVE_ENTITY_DEFS and it flows
 * everywhere automatically.
 */
export const NATIVE_ENTITY_NAMES: ReadonlySet<string> = new Set(Object.keys(NATIVE_ENTITY_DEFS));

/** True when `name` is a framework-shipped native entity (see {@link NATIVE_ENTITY_DEFS}). */
export function isNativeEntity(name: string): boolean {
  return NATIVE_ENTITY_NAMES.has(name);
}

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

/** Bookkeeping table that records which physical table is bound to each
 * native entity. `__lattice_`-prefixed so it never surfaces in the GUI's
 * entity cards or table allowlist. Stored in-DB so the binding travels with
 * the database (correct for multi-DB / cloud setups), like `__lattice_migrations`. */
export const NATIVE_REGISTRY_TABLE = '__lattice_native_entities';

const NATIVE_REGISTRY_DEF: TableDefinition = {
  columns: {
    entity: 'TEXT PRIMARY KEY',
    table_name: 'TEXT NOT NULL',
    adopted_at: 'TEXT NOT NULL',
    origin: 'TEXT NOT NULL',
  },
  primaryKey: 'entity',
  render: () => '',
  outputFile: '.lattice-native/native-entities.md',
};

export interface AdoptNativeOptions {
  /**
   * How to treat a native entity whose physical table already exists:
   *  - `'adopt'` (default): merge the native column superset onto the existing
   *    table and record the binding. Always non-destructive — backed by
   *    `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`; never drops
   *    or rewrites existing data. Legacy plaintext `secrets.value` rows stay
   *    readable (decrypt passes non-`enc:` values through unchanged).
   *  - `'skip'`: record the binding without touching the schema.
   *  - `'error'`: throw if a physical table already exists.
   */
  onConflict?: 'adopt' | 'skip' | 'error';
}

export interface AdoptResult {
  entity: string;
  tableName: string;
  /** `created` = native just created an empty table; `adopted` = an existing
   * (pre-native) table was merged/bound; `skipped` = bound without schema change. */
  origin: 'created' | 'adopted' | 'skipped';
}

/**
 * Reconcile the framework's native entities against the physical database and
 * record the binding in {@link NATIVE_REGISTRY_TABLE}. Run AFTER `db.init()`
 * (it introspects the live DB; Postgres has no sync introspection).
 *
 * For each entity in {@link NATIVE_ENTITY_DEFS}:
 *  - if the physical table is absent → it was (or will be) created by
 *    {@link registerNativeEntities}; bound as `created`.
 *  - if it already exists → bound as `adopted` (merging the native columns when
 *    `onConflict==='adopt'`), so a consumer's pre-existing `files`/`secrets`
 *    table is labelled THE native one rather than duplicated.
 */
export async function adoptNativeEntities(
  db: Lattice,
  options: AdoptNativeOptions = {},
): Promise<AdoptResult[]> {
  const onConflict = options.onConflict ?? 'adopt';
  await db.defineLate(NATIVE_REGISTRY_TABLE, NATIVE_REGISTRY_DEF);

  const results: AdoptResult[] = [];
  for (const [name, def] of Object.entries(NATIVE_ENTITY_DEFS)) {
    const physicalCols = await db.introspectColumns(name);
    const exists = physicalCols.length > 0;
    const registered = new Set(db.getRegisteredTableNames());

    if (!exists) {
      // Fresh DB. registerNativeEntities()+init() normally create the table;
      // if the caller skipped that, create it now so it's guaranteed present.
      if (!registered.has(name)) await db.defineLate(name, def);
      results.push({ entity: name, tableName: name, origin: 'created' });
      await recordNativeBinding(db, name, 'created');
      continue;
    }

    if (onConflict === 'error') {
      throw new Error(
        `adoptNativeEntities: physical table "${name}" already exists; refusing to adopt with onConflict:'error'`,
      );
    }

    // A table that carries columns the native def doesn't declare, or that
    // already holds rows, predates native registration → "adopted".
    const nativeCols = new Set(Object.keys(def.columns));
    const hadForeignShape = physicalCols.some((c) => !nativeCols.has(c));
    const rowCount = await db.count(name);
    let origin: AdoptResult['origin'] = hadForeignShape || rowCount > 0 ? 'adopted' : 'created';

    if (onConflict === 'skip') {
      origin = 'skipped';
    } else if (!registered.has(name)) {
      // Merge the native superset onto the existing table (idempotent; only
      // adds missing columns, never drops). No-op if already registered.
      await db.defineLate(name, def);
    }

    results.push({ entity: name, tableName: name, origin });
    await recordNativeBinding(db, name, origin);
  }
  return results;
}

/** Read the current native-entity bindings. Empty array if the registry table
 * has not been created yet (no adopt has run on this DB). */
export async function listNativeBindings(db: Lattice): Promise<AdoptResult[]> {
  if (!db.getRegisteredTableNames().includes(NATIVE_REGISTRY_TABLE)) return [];
  const rows = await db.query(NATIVE_REGISTRY_TABLE);
  return rows.map((r) => ({
    entity: String(r.entity),
    tableName: String(r.table_name),
    origin: r.origin as AdoptResult['origin'],
  }));
}

async function recordNativeBinding(
  db: Lattice,
  entity: string,
  origin: AdoptResult['origin'],
): Promise<void> {
  await db.upsert(NATIVE_REGISTRY_TABLE, {
    entity,
    table_name: entity,
    adopted_at: new Date().toISOString(),
    origin,
  });
}
