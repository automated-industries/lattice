import type { Lattice } from '../lattice.js';
import { boundedSelfContext } from './canonical-context.js';
import { NOOP_RENDER } from '../render/engine.js';
import type { TableDefinition } from '../types.js';

/**
 * Framework-shipped tables that every Lattice can opt into via
 * {@link registerNativeEntities}. These tables are intentionally generic —
 * they're the building blocks for app-level features (an API-key store, a
 * file repository) that should not require every consumer to re-derive
 * the column shape from scratch.
 *
 * Columns are deliberately a *superset* of any earlier ad-hoc shapes. New
 * code uses the content-addressed columns (`sha256`, `blob_path`) for owned
 * bytes and the reference model (`ref_kind` / `ref_uri`) for files that live
 * elsewhere.
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
    render: NOOP_RENDER,
    outputFile: '.lattice-native/secrets.md',
  },
  files: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      // Content-addressed storage. `sha256` is the canonical content
      // identifier; `blob_path` is the relative path under
      // `<lattice-root>/data/blobs/` written by attachBlob().
      original_name: 'TEXT',
      mime: 'TEXT',
      size_bytes: 'INTEGER',
      sha256: 'TEXT',
      blob_path: 'TEXT',
      // Reference mode (v2.0): a row can INDEX data that lives elsewhere
      // instead of owning a copy. All nullable + additive (back-compat).
      //   ref_kind     discriminator: 'blob' | 'local_ref' | 'cloud_ref'
      //                (NULL ⇒ legacy/owned blob)
      //   ref_uri      durable pointer: absolute local path, remote URL, or
      //                `s3://bucket/key` for an S3-backed cloud blob
      //   ref_provider resolver selector: 'fs' | 'web' | 'gdrive' | 's3'
      //   source_json  provider-specific metadata (etag, availability, …; for
      //                's3' it holds { bucket, key, region, size_bytes })
      ref_kind: 'TEXT',
      ref_uri: 'TEXT',
      ref_provider: 'TEXT',
      source_json: 'TEXT',
      extraction_status: 'TEXT',
      extracted_text: 'TEXT',
      description: 'TEXT',
      // System-created artifact flag (additive, nullable, back-compat).
      //   NULL       ⇒ an ordinary file (uploaded / ingested / referenced)
      //   'markdown' ⇒ a markdown document the assistant generated and saved
      //                here; its content lives inline in `extracted_text` and
      //                renders as formatted markdown in the viewer. Room for
      //                further artifact types later. Governed by the same
      //                sharing/visibility rules as any other file row.
      artifact_type: 'TEXT',
      created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      deleted_at: 'TEXT',
    },
    render: NOOP_RENDER,
    outputFile: '.lattice-native/files.md',
  },
  notes: {
    // A generic knowledge object: a free-form note with a title and body.
    // Ordinary, user-editable rows; `source_file_id` optionally points back at
    // an originating `files` row. Retained as native (1.16.3) because the
    // reference/source-organizer store uses it as the fallback organizer target.
    columns: {
      id: 'TEXT PRIMARY KEY',
      title: 'TEXT',
      body: 'TEXT',
      source_file_id: 'TEXT',
      created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      deleted_at: 'TEXT',
    },
    render: NOOP_RENDER,
    outputFile: '.lattice-native/notes.md',
  },
  chat_threads: {
    // An assistant conversation. Native so chat history survives across
    // sessions and is queryable/renderable like any other Lattice entity.
    columns: {
      id: 'TEXT PRIMARY KEY',
      title: 'TEXT',
      // Cloud user id of the member who started the thread (the operator's
      // `teamContext.myUserId`). A chat is PRIVATE to its author — on a team
      // cloud the chat routes only ever return threads whose owner matches the
      // requesting member. NULL on local single-user databases (no team
      // context) and on pre-2.2.1 threads, which the routes treat as the local
      // operator's own (visible only when there is no team context).
      owner_user_id: 'TEXT',
      created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      deleted_at: 'TEXT',
    },
    render: NOOP_RENDER,
    outputFile: '.lattice-native/chat-threads.md',
  },
  chat_messages: {
    // One turn (or feed entry) within a chat_thread.
    columns: {
      id: 'TEXT PRIMARY KEY',
      // Soft reference to chat_threads.id. Kept as a plain column (no FK)
      // to match the generic, dialect-agnostic native-entity style.
      thread_id: 'TEXT',
      // Cloud user id of the member the message belongs to — mirrors the
      // owning thread's owner_user_id so a message read can be filtered
      // independently of the thread join. NULL on local DBs / pre-2.2.1 rows.
      owner_user_id: 'TEXT',
      // user | assistant | tool | feed | system
      role: "TEXT NOT NULL DEFAULT 'user'",
      // JSON payload: text, tool_use / tool_result blocks, attachments, or
      // (for role='feed') the feed-event details.
      content_json: 'TEXT',
      // ai | gui | cli | ingest — meaningful for role='feed'.
      source: 'TEXT',
      created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      deleted_at: 'TEXT',
    },
    render: NOOP_RENDER,
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
 * Native entities that are INTERNAL conversation storage — the assistant's own
 * chat threads + messages. They are real native tables (queryable + persisted by
 * the chat route), but must NOT show up in the GUI's Objects list / dashboard
 * cards: they're an implementation detail of the chat rail, not user-facing data
 * objects. (Contrast `secrets`/`files`/`notes`, which ARE user-facing and stay
 * visible.) Mirrors {@link ASSISTANT_HIDDEN_TABLES} on the assistant side.
 */
export const NATIVE_INTERNAL_NAMES: ReadonlySet<string> = new Set([
  'chat_threads',
  'chat_messages',
]);

/** True when `name` is an internal native entity hidden from the GUI Objects list. */
export function isInternalNativeEntity(name: string): boolean {
  return NATIVE_INTERNAL_NAMES.has(name);
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
  // The files table gets a REAL rendered per-record context ("all data renders
  // as markdown") — bounded: the multi-megabyte extracted_text and raw
  // source_json never enter the markdown, and the self file is capped. secrets
  // and the chat tables stay unrendered by design (hard-excluded in the
  // canonical derivation). Registered here so owner opens, member opens, and
  // openWorkspace all get it path-independently; never overrides an explicit
  // context.
  const filesDef = NATIVE_ENTITY_DEFS.files;
  if (filesDef && !db.entityContexts().has('files')) {
    db.defineEntityContext(
      'files',
      boundedSelfContext('files', filesDef, {
        excludeColumns: new Set(['extracted_text', 'source_json']),
        budget: 8000,
      }),
    );
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
  render: NOOP_RENDER,
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
