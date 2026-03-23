# API Reference

Complete reference for all public classes, methods, and types exported by `@m-flat/lattice`.

---

## Table of Contents

- [Class: `Lattice`](#class-lattice)
  - [Constructor](#constructor)
  - [Setup Methods](#setup-methods)
  - [CRUD Methods](#crud-methods)
  - [Sync Methods](#sync-methods)
  - [Events](#events)
  - [Escape Hatch](#escape-hatch)
- [Functions](#functions)
  - [`parseConfigFile()`](#parseconfigfile)
  - [`parseConfigString()`](#parseconfigstring)
- [Types](#types)
  - [`Row`](#row)
  - [`LatticeOptions`](#latticeoptions)
  - [`SecurityOptions`](#securityoptions)
  - [`TableDefinition`](#tabledefinition)
  - [`MultiTableDefinition`](#multitabledefinition)
  - [`WritebackDefinition`](#writebackdefinition)
  - [`QueryOptions`](#queryoptions)
  - [`CountOptions`](#countoptions)
  - [`Filter` and `FilterOp`](#filter-and-filterop)
  - [`InitOptions` and `Migration`](#initoptions-and-migration)
  - [`WatchOptions`](#watchoptions)
  - [`RenderResult` and `SyncResult`](#renderresult-and-syncresult)
  - [`AuditEvent`](#auditevent)
  - [`PkLookup`](#pklookup)
  - [`PrimaryKey`](#primarykey)
  - [`Relation` types](#relation-types)
  - [Render types](#render-types)
  - [Config types](#config-types)

---

## Class: `Lattice`

The main entry point. Manages a SQLite database, registered table schemas, sync/render cycle, and optional writeback pipeline.

### Constructor

```ts
new Lattice(path: string, options?: LatticeOptions): Lattice
new Lattice(config: LatticeConfigInput, options?: LatticeOptions): Lattice
```

**Form 1 — explicit path:**

```ts
const db = new Lattice('./data/app.db');
const db = new Lattice(':memory:');
const db = new Lattice('./data/app.db', { wal: true, busyTimeout: 5000 });
```

**Form 2 — YAML config:**

```ts
const db = new Lattice({ config: './lattice.config.yml' });
const db = new Lattice({ config: './lattice.config.yml', options: { wal: true } });
```

When using the config form, Lattice reads the YAML file, resolves the `db` path relative to the config file, and calls `define()` for every entity automatically. No manual `define()` calls are needed.

**Parameters:**

| Parameter | Type                 | Description                                                        |
| --------- | -------------------- | ------------------------------------------------------------------ |
| `path`    | `string`             | Path to the SQLite file, or `':memory:'` for an in-memory database |
| `config`  | `LatticeConfigInput` | Object with a `config` path to a `lattice.config.yml` file         |
| `options` | `LatticeOptions`     | Optional runtime configuration                                     |

**`LatticeOptions`:**

| Option        | Type              | Default | Description                                                     |
| ------------- | ----------------- | ------- | --------------------------------------------------------------- |
| `wal`         | `boolean`         | `false` | Enable WAL journal mode (recommended for concurrent read/write) |
| `busyTimeout` | `number`          | –       | SQLite busy timeout in milliseconds                             |
| `security`    | `SecurityOptions` | –       | Input sanitization and audit options                            |

---

### Setup Methods

#### `define(table, definition): this`

Register a table schema before calling `init()`. Returns `this` for chaining.

```ts
db.define('tasks', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    title: 'TEXT NOT NULL',
    status: "TEXT DEFAULT 'open'",
  },
  render: 'default-list',
  outputFile: 'context/TASKS.md',
});
```

Must be called **before** `init()`. Throws if called after `init()`.

**`TableDefinition`** fields:

| Field              | Type                       | Required | Description                                                        |
| ------------------ | -------------------------- | -------- | ------------------------------------------------------------------ |
| `columns`          | `Record<string, string>`   | yes      | Column name → SQLite column spec                                   |
| `render`           | `RenderSpec`               | yes      | How to render rows into context text                               |
| `outputFile`       | `string`                   | yes      | Output file path (relative to `outputDir` in `render()`/`watch()`) |
| `filter`           | `(rows: Row[]) => Row[]`   | no       | Pre-filter applied before render                                   |
| `primaryKey`       | `PrimaryKey`               | no       | Primary key column(s); defaults to `'id'`                          |
| `tableConstraints` | `string[]`                 | no       | Table-level SQL constraints (e.g. composite PK)                    |
| `relations`        | `Record<string, Relation>` | no       | Declared foreign-key relationships                                 |

---

#### `defineMulti(name, definition): this`

Register a multi-table view that produces one output file per "anchor" row.

```ts
db.defineMulti('agent-context', {
  keys: async () => db.query('agents'),
  outputFile: (agent) => `agents/${agent.slug}/CONTEXT.md`,
  render: (agent, tables) => {
    const tasks = tables.tasks ?? [];
    return `# ${agent.name}\n\n${tasks.map((t) => `- ${t.title}`).join('\n')}`;
  },
  tables: ['tasks'],
});
```

**`MultiTableDefinition`** fields:

| Field        | Type                                                  | Description                                            |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------ |
| `keys`       | `() => Promise<Row[]>`                                | Returns the anchor rows; one output file per row       |
| `outputFile` | `(key: Row) => string`                                | Derive output file path from an anchor row             |
| `render`     | `(key: Row, tables: Record<string, Row[]>) => string` | Produce the file content                               |
| `tables`     | `string[]`                                            | Additional table names to query and pass into `render` |

---

#### `defineEntityContext(table, definition): this`

Register an entity context definition for a table. Must be called **before** `init()`. Returns `this` for chaining.

```ts
db.defineEntityContext('agent', {
  slug: (row) => row.slug as string,
  index: {
    outputFile: 'AGENTS.md',
    render: (rows) => rows.map((r) => `- [${r.name}](${r.slug}/)`).join('\n'),
  },
  files: [
    {
      filename: 'AGENT.md',
      source: { type: 'self' },
      render: (rows) => `# ${rows[0]?.name}\n\n${rows[0]?.bio ?? ''}`,
    },
    {
      filename: 'TASKS.md',
      source: { type: 'hasMany', table: 'task', foreignKey: 'agent_id' },
      render: (rows) => rows.map((r) => `- [ ] ${r.title}`).join('\n'),
      omitIfEmpty: true,
    },
    {
      filename: 'SKILLS.md',
      source: {
        type: 'manyToMany',
        junctionTable: 'agent_skill',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skill',
      },
      render: (rows) => rows.map((r) => `- ${r.name}`).join('\n'),
      omitIfEmpty: true,
    },
  ],
  combined: {
    outputFile: 'CONTEXT.md',
  },
  directoryRoot: 'agents',
  protectedFiles: ['SESSION.md'],
});
```

**`EntityContextDefinition`** fields:

| Field            | Type                                       | Required | Description                                                                        |
| ---------------- | ------------------------------------------ | -------- | ---------------------------------------------------------------------------------- |
| `slug`           | `(row: Row) => string`                     | yes      | Derive the per-entity directory name from the entity row                           |
| `index`          | `{ outputFile, render }`                   | no       | A single index file written at the `directoryRoot` level listing all entities      |
| `files`          | `EntityFileSpec[]`                         | yes      | One or more per-entity files to generate inside each entity's subdirectory         |
| `combined`       | `{ outputFile, exclude? }`                 | no       | Concatenate all rendered files into a single combined file per entity              |
| `directory`      | `(row: Row) => string`                     | no       | Override the default `{directoryRoot}/{slug}` directory path for an entity         |
| `directoryRoot`  | `string`                                   | no       | Root directory Lattice owns; defaults to the table name. Used by orphan cleanup    |
| `protectedFiles` | `string[]`                                 | no       | Filenames Lattice must never delete during orphan cleanup (e.g. `'SESSION.md'`)    |

**`EntityFileSpec`** fields:

| Field         | Type                              | Required | Description                                                          |
| ------------- | --------------------------------- | -------- | -------------------------------------------------------------------- |
| `filename`    | `string`                          | yes      | Output filename within the entity's subdirectory                     |
| `source`      | `EntitySource`                    | yes      | How to query rows for this file (see source types below)             |
| `render`      | `(rows: Row[]) => string`         | yes      | Render resolved rows to a string                                     |
| `budget`      | `number`                          | no       | Max character count; truncated with a notice if exceeded             |
| `omitIfEmpty` | `boolean`                         | no       | Skip writing the file if the source returns zero rows                |

**Source types:**

| Type          | Required fields                                           | Description                                            |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| `self`        | _(none)_                                                  | The entity row itself (always exactly one row)         |
| `hasMany`     | `table`, `foreignKey`                                     | Rows on a related table where `foreignKey = entity.PK` |
| `manyToMany`  | `junctionTable`, `localKey`, `remoteKey`, `remoteTable`   | Rows from a remote table via a junction table          |
| `belongsTo`   | `table`, `foreignKey`                                     | Single parent row: `related.PK = entity.foreignKey`    |
| `custom`      | `query: (row, adapter) => Row[]`                          | Fully custom synchronous query                         |

All source types accept an optional `references` field to override the default primary key column.

---

#### `defineWriteback(definition): this`

Register a writeback pipeline: watch an agent-written file for new entries and persist them to the database.

```ts
db.defineWriteback({
  file: './context/INBOX.md',
  parse: (content, fromOffset) => {
    const newContent = content.slice(fromOffset);
    const entries = newContent
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => ({ text: l.slice(2) }));
    return { entries, nextOffset: content.length };
  },
  persist: async (entry) => {
    await db.insert('notes', { text: (entry as { text: string }).text });
  },
  dedupeKey: (entry) => (entry as { text: string }).text,
});
```

**`WritebackDefinition`** fields:

| Field       | Type                                               | Description                                                           |
| ----------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `file`      | `string`                                           | Path or glob to the agent-written file(s)                             |
| `parse`     | `(content, fromOffset) => { entries, nextOffset }` | Parse new content from the last-read offset                           |
| `persist`   | `(entry, filePath) => Promise<void>`               | Persist one parsed entry                                              |
| `dedupeKey` | `(entry) => string`                                | Optional dedup key; entries with the same key are processed only once |

---

#### `init(options?): Promise<void>`

Open the database, apply schema (`CREATE TABLE IF NOT EXISTS` for all registered tables), and optionally run migrations.

```ts
await db.init();

// With migrations:
await db.init({
  migrations: [
    { version: 1, sql: 'ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 1' },
    { version: 2, sql: 'CREATE INDEX idx_tasks_status ON tasks (status)' },
  ],
});
```

Must be called **once** before any CRUD or sync methods. Throws if called a second time.

---

#### `close(): void`

Close the underlying SQLite connection. After calling `close()`, CRUD and sync methods will reject.

```ts
db.close();
```

---

### CRUD Methods

All CRUD methods return `Promise<T>` but resolve synchronously (better-sqlite3 is synchronous under the hood). Calling any CRUD method before `init()` returns a rejected promise.

---

#### `insert(table, row): Promise<string>`

Insert a new row. Returns the primary key value as a string.

```ts
const id = await db.insert('tasks', { title: 'Fix the bug', status: 'open' });
// → '3f2a1b...' (auto-generated UUID)

// Provide your own ID:
await db.insert('tasks', { id: 'task-1', title: 'Fix the bug' });
```

- If `primaryKey` is the default `'id'` and `id` is absent, a UUID v4 is auto-generated.
- For custom or composite PKs, all PK column values must be provided.

---

#### `upsert(table, row): Promise<string>`

Insert or update using `INSERT ... ON CONFLICT DO UPDATE`. Returns the primary key value.

```ts
await db.upsert('settings', { key: 'theme', value: 'dark' });
// Updates if 'theme' already exists, otherwise inserts.
```

PK columns are excluded from the `UPDATE SET` clause — only non-PK fields are overwritten.

---

#### `upsertBy(table, col, val, row): Promise<string>`

Insert or update based on an arbitrary column (not the PK). Returns the PK value.

```ts
await db.upsertBy('users', 'email', 'alice@example.com', { name: 'Alice', role: 'admin' });
```

Looks up an existing row by `col = val`. If found, calls `update()`; otherwise calls `insert()`.

---

#### `update(table, id, row): Promise<void>`

Update one row identified by its primary key.

```ts
await db.update('tasks', 'task-1', { status: 'done' });

// Composite PK:
await db.update('line_items', { order_id: 'ord-1', seq: 2 }, { qty: 5 });
```

---

#### `delete(table, id): Promise<void>`

Delete one row identified by its primary key.

```ts
await db.delete('tasks', 'task-1');

// Composite PK:
await db.delete('line_items', { order_id: 'ord-1', seq: 2 });
```

---

#### `get(table, id): Promise<Row | null>`

Fetch one row by primary key. Returns `null` if not found.

```ts
const task = await db.get('tasks', 'task-1');
if (task) {
  console.log(task.title);
}
```

---

#### `query(table, options?): Promise<Row[]>`

Query rows with optional filtering, ordering, and pagination.

```ts
// All rows:
const tasks = await db.query('tasks');

// With equality filter:
const open = await db.query('tasks', { where: { status: 'open' } });

// Advanced filters:
const highPriority = await db.query('tasks', {
  filters: [
    { col: 'priority', op: 'gte', val: 3 },
    { col: 'deleted_at', op: 'isNull' },
  ],
  orderBy: 'created_at',
  orderDir: 'desc',
  limit: 20,
  offset: 0,
});
```

**`QueryOptions`:**

| Option     | Type                      | Description                       |
| ---------- | ------------------------- | --------------------------------- |
| `where`    | `Record<string, unknown>` | Equality filter shorthand         |
| `filters`  | `Filter[]`                | Advanced filter clauses           |
| `orderBy`  | `string`                  | Column to sort by                 |
| `orderDir` | `'asc' \| 'desc'`         | Sort direction (default: `'asc'`) |
| `limit`    | `number`                  | Max rows to return                |
| `offset`   | `number`                  | Skip N rows                       |

---

#### `count(table, options?): Promise<number>`

Count rows matching optional filters.

```ts
const total = await db.count('tasks');
const open = await db.count('tasks', { where: { status: 'open' } });
const highPriority = await db.count('tasks', {
  filters: [{ col: 'priority', op: 'gte', val: 3 }],
});
```

Accepts the same `where` and `filters` options as `query()`.

---

### Sync Methods

#### `render(outputDir): Promise<RenderResult>`

Render all registered tables (and multi-table views) to their output files once.

```ts
const result = await db.render('./context');
console.log(`Wrote ${result.filesWritten.length} files in ${result.durationMs}ms`);
```

**`RenderResult`:**

| Field          | Type       | Description                                |
| -------------- | ---------- | ------------------------------------------ |
| `filesWritten` | `string[]` | Absolute paths of files written            |
| `filesSkipped` | `number`   | Count of files skipped (content unchanged) |
| `durationMs`   | `number`   | Render duration in milliseconds            |

---

#### `sync(outputDir): Promise<SyncResult>`

Render all output files **and** process any pending writeback entries.

```ts
const result = await db.sync('./context');
console.log(
  `Wrote ${result.filesWritten.length} files, processed ${result.writebackProcessed} writeback entries`,
);
```

**`SyncResult`** extends `RenderResult` with:

| Field                | Type     | Description                                         |
| -------------------- | -------- | --------------------------------------------------- |
| `writebackProcessed` | `number` | Number of writeback entries processed in this cycle |

---

#### `reconcile(outputDir, options?): Promise<ReconcileResult>`

Run a full render cycle and then clean up orphaned files and directories produced by previous cycles. The recommended one-shot method when you want both rendering and lifecycle management.

```ts
const result = await db.reconcile('./context', {
  removeOrphanedDirectories: true,
  removeOrphanedFiles: true,
});

console.log(`Wrote ${result.filesWritten.length} files`);
console.log(`Removed ${result.cleanup.directoriesRemoved} stale directories`);
console.log(`Removed ${result.cleanup.filesRemoved} stale files`);
```

`reconcile()` reads the manifest written by the **previous** render cycle before rendering, then compares old and new manifests to detect what was generated before but not now. Order of operations:

1. Read previous `.lattice/manifest.json` (if it exists)
2. Run a full render cycle (writes a new manifest)
3. Compare old vs. new manifest to identify orphans
4. Delete orphaned directories / files according to `options`
5. Return `ReconcileResult`

**`ReconcileOptions`** (all optional):

| Option                        | Type                                       | Default | Description                                                        |
| ----------------------------- | ------------------------------------------ | ------- | ------------------------------------------------------------------ |
| `removeOrphanedDirectories`   | `boolean`                                  | `false` | Delete directories for entities no longer in the database          |
| `removeOrphanedFiles`         | `boolean`                                  | `false` | Delete files within surviving directories that were not re-rendered |
| `protectedFiles`              | `string[]`                                 | `[]`    | Filenames to never delete (merged with per-definition protections) |
| `dryRun`                      | `boolean`                                  | `false` | Report what would be deleted without deleting anything             |
| `onOrphan`                    | `(path: string, kind: string) => void`     | –       | Called for each orphaned path before it is deleted                 |

**`ReconcileResult`** extends `RenderResult` with:

| Field     | Type            | Description                        |
| --------- | --------------- | ---------------------------------- |
| `cleanup` | `CleanupResult` | Orphan cleanup summary (see below) |

---

#### `watch(outputDir, options?): Promise<StopFn>`

Start a polling sync loop. Returns a `StopFn` to stop it.

```ts
const stop = await db.watch('./context', {
  interval: 10_000,
  onRender: (result) => console.log('Rendered:', result.filesWritten),
  onError: (err) => console.error('Watch error:', err),
  cleanup: {
    removeOrphanedDirectories: true,
    removeOrphanedFiles: true,
  },
  onCleanup: (result) => {
    if (result.directoriesRemoved > 0 || result.filesRemoved > 0) {
      console.log(`Cleaned up ${result.directoriesRemoved} dirs, ${result.filesRemoved} files`);
    }
  },
});

// Later:
stop();
```

**`WatchOptions`:**

| Option      | Type                                   | Default | Description                                                        |
| ----------- | -------------------------------------- | ------- | ------------------------------------------------------------------ |
| `interval`  | `number`                               | `5000`  | Poll interval in milliseconds                                      |
| `onRender`  | `(result: RenderResult) => void`       | –       | Called after each successful render cycle                          |
| `onError`   | `(err: Error) => void`                 | –       | Called on render errors                                            |
| `cleanup`   | `CleanupOptions`                       | –       | If set, orphan cleanup runs after each render cycle                |
| `onCleanup` | `(result: CleanupResult) => void`      | –       | Called after each cleanup cycle (requires `cleanup` to be set)     |

---

### Events

#### `on(event, handler): this`

Subscribe to lifecycle events. Returns `this` for chaining.

```ts
db.on('audit', (event) => {
  console.log(`${event.operation} on ${event.table} — id: ${event.id}`);
})
  .on('render', (result) => {
    console.log(`Render complete: ${result.filesWritten.length} files`);
  })
  .on('error', (err) => {
    console.error('Lattice error:', err);
  });
```

**Available events:**

| Event         | Handler type                                                     | Fires when                       |
| ------------- | ---------------------------------------------------------------- | -------------------------------- |
| `'audit'`     | `(event: AuditEvent) => void`                                    | Any insert/update/delete         |
| `'render'`    | `(result: RenderResult) => void`                                 | After a render cycle             |
| `'writeback'` | `(data: { filePath: string; entriesProcessed: number }) => void` | After writeback processing       |
| `'error'`     | `(err: Error) => void`                                           | On uncaught errors in watch/sync |

**`AuditEvent`:**

```ts
interface AuditEvent {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  id: string;
  timestamp: string; // ISO 8601
}
```

---

### Escape Hatch

#### `db.db: Database.Database`

Direct access to the underlying `better-sqlite3` database instance for raw SQL queries not covered by the Lattice API.

```ts
const stmt = db.db.prepare('SELECT COUNT(*) FROM tasks WHERE assignee_id = ?');
const result = stmt.get('user-1') as { 'COUNT(*)': number };
```

Use sparingly — raw queries bypass Lattice's sanitization and audit pipeline.

---

## Functions

### `parseConfigFile()`

```ts
function parseConfigFile(configPath: string): ParsedConfig;
```

Read a `lattice.config.yml` file, validate it, and return a `ParsedConfig` with resolved paths and compiled `TableDefinition` objects ready to pass to `define()`.

```ts
import { parseConfigFile } from '@m-flat/lattice';

const { dbPath, tables } = parseConfigFile('./lattice.config.yml');
const db = new Lattice(dbPath);
for (const { name, definition } of tables) {
  db.define(name, definition);
}
await db.init();
```

Throws on:

- File not found or unreadable
- YAML parse error
- Missing `db` key
- Missing `entities` key
- Entity with no `fields` object

---

### `parseConfigString()`

```ts
function parseConfigString(yamlContent: string, configDir: string): ParsedConfig;
```

Parse a raw YAML string instead of reading a file. `configDir` is used to resolve relative paths for `db` and `outputFile`.

```ts
import { parseConfigString } from '@m-flat/lattice';

const yaml = `
db: ./data/app.db
entities:
  note:
    fields:
      id: { type: uuid, primaryKey: true }
      body: { type: text }
    render: default-list
    outputFile: context/NOTES.md
`;

const { dbPath, tables } = parseConfigString(yaml, process.cwd());
```

---

### `readManifest(outputDir)`

```ts
function readManifest(outputDir: string): LatticeManifest | null;
```

Read the Lattice manifest from `{outputDir}/.lattice/manifest.json`. Returns `null` on first run (no manifest yet).

```ts
import { readManifest } from '@m-flat/lattice';

const manifest = readManifest('./context');
if (manifest) {
  console.log('Last generated:', manifest.generated_at);
  for (const [table, entry] of Object.entries(manifest.entityContexts)) {
    console.log(`${table}: ${Object.keys(entry.entities).length} entities`);
  }
}
```

---

### `writeManifest(outputDir, manifest)`

```ts
function writeManifest(outputDir: string, manifest: LatticeManifest): void;
```

Write the manifest atomically. Called automatically by `render()`, `sync()`, and `reconcile()` — you rarely need to call this directly.

---

### `manifestPath(outputDir)`

```ts
function manifestPath(outputDir: string): string;
```

Return the path where Lattice writes its manifest: `{outputDir}/.lattice/manifest.json`.

---

## Types

### `Row`

```ts
type Row = Record<string, unknown>;
```

A generic database row — column name to value.

---

### `LatticeOptions`

```ts
interface LatticeOptions {
  wal?: boolean;
  busyTimeout?: number;
  security?: SecurityOptions;
}
```

---

### `SecurityOptions`

```ts
interface SecurityOptions {
  sanitize?: boolean;
  auditTables?: string[];
  fieldLimits?: Record<string, number>;
}
```

| Option        | Description                                                               |
| ------------- | ------------------------------------------------------------------------- |
| `sanitize`    | Enable input sanitization (strip null bytes, HTML-encode dangerous chars) |
| `auditTables` | Table names to emit `audit` events for (empty = all tables)               |
| `fieldLimits` | Maximum string length per column name                                     |

---

### `TableDefinition`

See [Setup Methods — `define()`](#definetable-definition-this) for the full field reference.

---

### `MultiTableDefinition`

See [Setup Methods — `defineMulti()`](#definemultiname-definition-this).

---

### `WritebackDefinition`

See [Setup Methods — `defineWriteback()`](#definewritebackdefinition-this).

---

### `QueryOptions`

See [CRUD Methods — `query()`](#querytable-options-promiserow).

---

### `CountOptions`

```ts
interface CountOptions {
  where?: Record<string, unknown>;
  filters?: Filter[];
}
```

---

### `Filter` and `FilterOp`

```ts
type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'isNull' | 'isNotNull';

interface Filter {
  col: string;
  op: FilterOp;
  val?: unknown;
}
```

**Operator reference:**

| Operator    | SQL equivalent       | `val` type                |
| ----------- | -------------------- | ------------------------- |
| `eq`        | `col = ?`            | any scalar                |
| `ne`        | `col != ?`           | any scalar                |
| `gt`        | `col > ?`            | number or string          |
| `gte`       | `col >= ?`           | number or string          |
| `lt`        | `col < ?`            | number or string          |
| `lte`       | `col <= ?`           | number or string          |
| `like`      | `col LIKE ?`         | string with `%` wildcards |
| `in`        | `col IN (?, ?, ...)` | `unknown[]`               |
| `isNull`    | `col IS NULL`        | _(not used)_              |
| `isNotNull` | `col IS NOT NULL`    | _(not used)_              |

---

### `InitOptions` and `Migration`

```ts
interface InitOptions {
  migrations?: Migration[];
}

interface Migration {
  version: number;
  sql: string;
}
```

Migrations are applied in order of `version`. Each version is tracked in the `_lattice_migrations` table — a version is only applied once, even across restarts.

---

### `WatchOptions`

```ts
interface WatchOptions {
  interval?: number; // ms, default 5000
  onRender?: (result: RenderResult) => void;
  onError?: (err: Error) => void;
  cleanup?: CleanupOptions;
  onCleanup?: (result: CleanupResult) => void;
}
```

---

### `RenderResult` and `SyncResult`

```ts
interface RenderResult {
  filesWritten: string[];
  filesSkipped: number;
  durationMs: number;
}

interface SyncResult extends RenderResult {
  writebackProcessed: number;
}
```

---

### `AuditEvent`

```ts
interface AuditEvent {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  id: string;
  timestamp: string; // ISO 8601
}
```

---

### `PkLookup`

```ts
type PkLookup = string | Record<string, unknown>;
```

Used by `get()`, `update()`, and `delete()` to identify a row:

- `string` — value of the single PK column
- `Record<string, unknown>` — column-to-value map for composite PKs

---

### `PrimaryKey`

```ts
type PrimaryKey = string | string[];
```

The primary key of a table. A string for single-column PKs; an array for composite PKs.

---

### `Relation` types

```ts
interface BelongsToRelation {
  type: 'belongsTo';
  table: string; // related table name
  foreignKey: string; // FK column on THIS table
  references?: string; // PK column on the related table (default: its first PK)
}

interface HasManyRelation {
  type: 'hasMany';
  table: string; // related table name
  foreignKey: string; // FK column on the RELATED table
  references?: string; // PK column on THIS table (default: its first PK)
}

type Relation = BelongsToRelation | HasManyRelation;
```

---

### Render types

```ts
type BuiltinTemplateName = 'default-list' | 'default-table' | 'default-detail' | 'default-json';

interface RenderHooks {
  beforeRender?: (rows: Row[]) => Row[];
  formatRow?: ((row: Row) => string) | string;
}

interface TemplateRenderSpec {
  template: BuiltinTemplateName;
  hooks?: RenderHooks;
}

type RenderSpec = ((rows: Row[]) => string) | BuiltinTemplateName | TemplateRenderSpec;
```

See [Template Rendering](./templates.md) for the complete guide.

---

### Config types

```ts
type LatticeFieldType =
  | 'uuid'
  | 'text'
  | 'integer'
  | 'int'
  | 'real'
  | 'float'
  | 'boolean'
  | 'bool'
  | 'datetime'
  | 'date'
  | 'blob';

interface LatticeFieldDef {
  type: LatticeFieldType;
  primaryKey?: boolean;
  required?: boolean;
  default?: string | number | boolean;
  ref?: string;
}

interface LatticeEntityRenderSpec {
  template: string;
  formatRow?: string;
}

interface LatticeEntityDef {
  fields: Record<string, LatticeFieldDef>;
  render?: string | LatticeEntityRenderSpec;
  outputFile: string;
  primaryKey?: string | string[];
}

interface LatticeConfig {
  db: string;
  entities: Record<string, LatticeEntityDef>;
}
```

See [Configuration Guide](./configuration.md) for the complete YAML reference.

---

### `ParsedConfig`

```ts
interface ParsedConfig {
  dbPath: string;
  tables: ReadonlyArray<{ name: string; definition: TableDefinition }>;
}
```

Returned by `parseConfigFile()` and `parseConfigString()`.

---

### `LatticeConfigInput`

```ts
interface LatticeConfigInput {
  config: string;
  options?: LatticeOptions;
}
```

The object form of the `Lattice` constructor when initialising from a YAML config file.

---

### `StopFn`

```ts
type StopFn = () => void;
```

Returned by `watch()`. Call it to stop the polling loop.

---

### Entity Context types

#### `EntityContextDefinition`

```ts
interface EntityContextDefinition {
  slug: (row: Row) => string;
  index?: {
    outputFile: string;
    render: (rows: Row[]) => string;
  };
  files: EntityFileSpec[];
  combined?: {
    outputFile: string;
    exclude?: string[];
  };
  directory?: (row: Row) => string;
  directoryRoot?: string;
  protectedFiles?: string[];
}
```

#### `EntityFileSpec`

```ts
interface EntityFileSpec {
  filename: string;
  source: EntitySource;
  render: (rows: Row[]) => string;
  budget?: number;
  omitIfEmpty?: boolean;
}
```

#### `EntitySource`

```ts
type EntitySource =
  | SelfSource
  | HasManySource
  | ManyToManySource
  | BelongsToSource
  | CustomSource;

interface SelfSource {
  type: 'self';
}

interface HasManySource {
  type: 'hasMany';
  table: string;
  foreignKey: string;
  references?: string;
}

interface ManyToManySource {
  type: 'manyToMany';
  junctionTable: string;
  localKey: string;
  remoteKey: string;
  remoteTable: string;
  references?: string;
}

interface BelongsToSource {
  type: 'belongsTo';
  table: string;
  foreignKey: string;
  references?: string;
}

interface CustomSource {
  type: 'custom';
  query: (row: Row, adapter: StorageAdapter) => Row[];
}
```

---

### Lifecycle types

#### `CleanupOptions`

```ts
interface CleanupOptions {
  removeOrphanedDirectories?: boolean;
  removeOrphanedFiles?: boolean;
  protectedFiles?: string[];
  dryRun?: boolean;
  onOrphan?: (path: string, kind: 'directory' | 'file') => void;
}
```

#### `CleanupResult`

```ts
interface CleanupResult {
  directoriesRemoved: number;
  filesRemoved: number;
  directoriesSkipped: number;
  warnings: string[];
}
```

#### `ReconcileOptions`

Identical to `CleanupOptions` — all fields are optional. Passed directly to the cleanup step inside `reconcile()`.

#### `ReconcileResult`

```ts
interface ReconcileResult extends RenderResult {
  cleanup: CleanupResult;
}
```

---

### Manifest types and functions

#### `LatticeManifest`

```ts
interface LatticeManifest {
  version: 1;
  generated_at: string; // ISO 8601
  entityContexts: Record<string, EntityContextManifestEntry>;
}
```

Written to `.lattice/manifest.json` inside `outputDir` after every render cycle that includes entity contexts. The manifest is the authoritative record of what Lattice generated — it enables safe orphan cleanup across restarts.

#### `EntityContextManifestEntry`

```ts
interface EntityContextManifestEntry {
  directoryRoot: string;
  indexFile?: string;
  declaredFiles: string[];
  protectedFiles: string[];
  entities: Record<string, string[]>; // slug → [filenames written]
}
```

#### `readManifest(outputDir)`

```ts
function readManifest(outputDir: string): LatticeManifest | null;
```

Read `.lattice/manifest.json` from `outputDir`. Returns `null` if the file does not exist (first run).

#### `writeManifest(outputDir, manifest)`

```ts
function writeManifest(outputDir: string, manifest: LatticeManifest): void;
```

Write the manifest atomically (`.tmp` → rename). Called automatically by `render()` and `reconcile()` when entity contexts are registered.

#### `manifestPath(outputDir)`

```ts
function manifestPath(outputDir: string): string;
```

Return the path to the manifest file: `{outputDir}/.lattice/manifest.json`.

---

### Internal exports (for testing)

The following are exported from `@m-flat/lattice` to support integration testing but are not part of the stable public API:

```ts
function resolveEntitySource(
  source: EntitySource,
  entityRow: Row,
  entityPk: string | string[],
  adapter: StorageAdapter,
): Row[];

function truncateContent(content: string, budget?: number): string;

function cleanupEntityContexts(
  outputDir: string,
  entityContexts: Record<string, EntityContextDefinition & { table: string }>,
  currentSlugsByTable: Record<string, Set<string>>,
  manifest: LatticeManifest | null,
  options: CleanupOptions,
  newManifest?: LatticeManifest,
): CleanupResult;
```
