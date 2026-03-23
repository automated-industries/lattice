# Architecture Overview

How `@m-flat/lattice` is structured internally and the design decisions behind it.

---

## Table of Contents

- [High-level picture](#high-level-picture)
- [Module breakdown](#module-breakdown)
- [Data flow](#data-flow)
- [Design decisions](#design-decisions)
- [Package structure](#package-structure)

> **v0.5 additions** are called out inline below. They cover entity context directories, lifecycle management, the manifest, and the `reconcile()` method.

---

## High-level picture

```
                    ┌─────────────────────────────────────┐
                    │              Lattice                 │
                    │          (public facade)             │
                    │                                      │
                    │  defineEntityContext()  reconcile()  │  ← v0.5
                    └──────────────────┬──────────────────┘
                                       │
          ┌────────────────────────────┼──────────────────────────┐
          │                            │                          │
┌─────────▼──────────┐   ┌────────────▼──────────┐  ┌───────────▼──────────┐
│   SchemaManager     │   │    SQLiteAdapter       │  │   WritebackPipeline  │
│                     │   │                        │  │                      │
│ • define(table)     │   │ • open() / close()     │  │ • define(def)        │
│ • defineEntityCtx() │   │ • run() / all() / get()│  │ • process()          │
│ • getPrimaryKey()   │   │ • WAL mode             │  │ • file watching      │
│ • getRelations()    │   │ • busy timeout         │  │ • dedup              │
│ • applySchema()     │   └────────────────────────┘  └──────────────────────┘
│ • applyMigrations() │
└─────────────────────┘
          │
┌─────────▼──────────┐   ┌────────────────────────┐
│   RenderEngine      │   │      SyncLoop           │
│                     │   │                         │
│ • render(outputDir) │◄──│ • watch(outputDir)      │
│ • resolveRelations()│   │ • setInterval polling   │
│ • writeFiles()      │   │ • cleanup on each tick  │  ← v0.5
│ • _renderEntityCtxs │   │ • StopFn returned       │
│ • writeManifest()   │   └─────────────────────────┘
│ • cleanup()         │   ← v0.5
└─────────────────────┘
          │
┌─────────▼──────────┐   ┌────────────────────────┐   ┌──────────────────────┐
│   RenderTemplates   │   │      Sanitizer          │   │  Lifecycle (v0.5)    │
│                     │   │                         │   │                      │
│ • compileRender()   │   │ • sanitizeRow()         │   │ • readManifest()     │
│ • default-list      │   │ • null-byte strip       │   │ • writeManifest()    │
│ • default-table     │   │ • field length limits   │   │ • manifestPath()     │
│ • default-detail    │   │ • audit event emission  │   │ • cleanupEntityCtxs()│
│ • default-json      │   └─────────────────────────┘   └──────────────────────┘
│ • interpolate()     │
└─────────────────────┘
          │
┌─────────▼──────────┐
│  EntityQuery (v0.5) │
│                     │
│ • resolveSource()   │
│ • self / hasMany    │
│ • manyToMany        │
│ • belongsTo         │
│ • custom            │
│ • truncateContent() │
└─────────────────────┘
```

---

## Module breakdown

### `Lattice` — public facade (`src/lattice.ts`)

The single public class. It wires together all internal modules and exposes the public API. Key responsibilities:

- Accepts `string | LatticeConfigInput` in the constructor, normalising both forms to a `dbPath` + table definitions
- Enforces the `define → init → CRUD/sync` lifecycle (throws if called out of order)
- Owns the event handler arrays and dispatches to them
- Delegates every operation to an internal module

### `SQLiteAdapter` — database layer (`src/db/sqlite.ts`)

A thin wrapper around `better-sqlite3`. Responsibilities:

- `open()` — opens the connection, optionally enabling WAL mode and setting busy timeout
- `close()` — closes the connection
- `run(sql, params)` — executes a DML statement (INSERT, UPDATE, DELETE)
- `all(sql, params)` — returns `Row[]`
- `get(sql, params)` — returns one `Row | undefined`
- Exposes `.db` for the escape hatch

The adapter is synchronous — `better-sqlite3` is a synchronous binding. All Lattice methods return Promises for a consistent async API surface, but they resolve synchronously.

### `SchemaManager` — schema registry (`src/schema/manager.ts`)

Holds all registered table and multi-table definitions. Responsibilities:

- `define(table, compiledDef)` — stores a `CompiledTableDef` (render is always a function)
- `defineMulti(name, def)` — stores a multi-table view definition
- `getPrimaryKey(table)` — returns the PK column array for a table
- `getRelations(table)` — returns the relations map for a table
- `applySchema(adapter)` — emits `CREATE TABLE IF NOT EXISTS` for every registered table
- `applyMigrations(adapter, migrations)` — creates `_lattice_migrations` and runs pending versions

`CompiledTableDef` differs from `TableDefinition` in that the `render` field is always a compiled `(rows: Row[]) => string` function. The compilation happens once in `Lattice.define()` via `compileRender()`.

### `RenderEngine` — sync to files (`src/render/engine.ts`)

Executes the render cycle. Responsibilities:

- `render(outputDir)` — iterates all registered tables, multi-table views, and entity context definitions; renders each to a string; writes to the appropriate output file (skipping unchanged content)
- `resolveRelations(table, rows)` — for `belongsTo` relations referenced in template strings, joins to the related table in-process
- `_renderEntityContexts(outputDir)` — (v0.5) renders all `defineEntityContext()` definitions; returns `Record<string, EntityContextManifestEntry>` and writes the manifest
- `cleanup(outputDir, prevManifest, options, newManifest?)` — (v0.5) builds current slug sets from the DB and calls `cleanupEntityContexts()`
- Returns `RenderResult` with file paths and timing

File writes are skipped when the new content equals the existing file content — important for keeping LLM context file mtimes stable.

### `EntityQuery` — entity source resolver (`src/render/entity-query.ts`) _(v0.5)_

Contains the synchronous row-resolution logic for entity context directories. Responsibilities:

- `resolveEntitySource(source, entityRow, entityPk, adapter)` — dispatches to the correct SQL query based on the source type (`self`, `hasMany`, `manyToMany`, `belongsTo`, `custom`)
- `truncateContent(content, budget?)` — applies the per-file character budget and appends the truncation notice

### `Lifecycle` — manifest and cleanup (`src/lifecycle/`) _(v0.5)_

Two modules:

- `manifest.ts` — `readManifest()`, `writeManifest()`, `manifestPath()` and the `LatticeManifest` / `EntityContextManifestEntry` types
- `cleanup.ts` — `cleanupEntityContexts()` and the `CleanupOptions` / `CleanupResult` types

The manifest (`{outputDir}/.lattice/manifest.json`) is the single source of truth for what Lattice generated. It is written atomically after every render cycle that includes entity contexts and read by the cleanup step to determine orphans.

### `SyncLoop` — polling loop (`src/sync/loop.ts`)

Wraps `RenderEngine` in a `setInterval` polling loop. Responsibilities:

- `watch(outputDir, opts)` — starts the loop, returns a `StopFn`
- Reads the previous manifest before each render cycle when `opts.cleanup` is set (v0.5)
- Calls `engine.cleanup()` after each render cycle when `opts.cleanup` is set (v0.5)
- Calls `onRender`, `onError`, and `onCleanup` callbacks per cycle

### `WritebackPipeline` — agent-to-db writes (`src/writeback/pipeline.ts`)

Monitors agent-written files and ingests new entries into the database. Responsibilities:

- `define(def)` — registers a writeback definition
- `process()` — reads registered files from their last-read offset, calls `parse()`, deduplicates, and calls `persist()` for each new entry

### `RenderTemplates` — built-in templates (`src/render/templates.ts`)

Contains the four built-in template implementations and the template compilation logic. Responsibilities:

- `compileRender(def, table, schema, adapter)` — converts a `RenderSpec` into a `(rows: Row[]) => string` function. Called once at `define()` time
- `interpolate(template, row, relations)` — replaces `{{field}}` and `{{rel.field}}` tokens
- `renderList`, `renderTable`, `renderDetail`, `renderJson` — the four built-in renderers

### `Sanitizer` — input safety (`src/security/sanitize.ts`)

Applied to every row before it reaches the database. Responsibilities:

- Strip null bytes from string values
- Apply field length limits (`SecurityOptions.fieldLimits`)
- Emit `AuditEvent` on each write operation

### Config layer (`src/config/`)

Two modules:

- `types.ts` — TypeScript types for `LatticeConfig`, `LatticeEntityDef`, `LatticeFieldDef`, `LatticeEntityRenderSpec`
- `parser.ts` — `parseConfigFile()` and `parseConfigString()`: read YAML, validate, convert to `ParsedConfig` (array of `{ name, TableDefinition }`)

### Codegen layer (`src/codegen/`)

- `generate.ts` — `generateTypes()`, `generateMigration()`, `generateAll()`: string generators for `types.ts` and `migration.sql`

### CLI (`src/cli.ts`)

Standalone entry point compiled to `dist/cli.js` with a `#!/usr/bin/env node` shebang. Uses no external CLI framework — just manual `process.argv` parsing. Calls `generateAll()` and logs results.

---

## Data flow

### Insert flow

```
db.insert(table, row)
  → Sanitizer.sanitizeRow(row)
  → resolve PK (auto-UUID if default 'id' and absent)
  → SQLiteAdapter.run(INSERT INTO ...)
  → Sanitizer.emitAudit(table, 'insert', id)
  → emit 'audit' event to handlers
  → return Promise.resolve(pkValue)
```

### Render flow

```
db.render(outputDir) / SyncLoop (watch)
  → RenderEngine.render(outputDir)
    → for each registered table:
        → SQLiteAdapter.all(SELECT * FROM table)
        → apply table.filter (if defined)
        → apply hooks.beforeRender (if defined)
        → resolve belongsTo relations (for template interpolation)
        → call compiled render function(rows)
        → compare output to existing file content
        → write file if changed
    → for each multi-table view:
        → call def.keys() for anchor rows
        → for each anchor: query tables, call def.render(key, tables)
        → write files
    → _renderEntityContexts(outputDir):        ← v0.5
        → for each entity context definition:
            → render index file (if defined)
            → for each entity row:
                → derive slug → entity subdirectory
                → for each EntityFileSpec:
                    → resolveEntitySource(source, row, pk, adapter)
                    → call spec.render(rows)
                    → apply budget truncation (if defined)
                    → skip write if omitIfEmpty and rows empty
                    → write file if content changed
                → write combined file (if defined)
        → writeManifest(outputDir, manifest)
  → return RenderResult
```

### Reconcile flow _(v0.5)_

```
db.reconcile(outputDir, options)
  → prevManifest = readManifest(outputDir)   ← read BEFORE render
  → RenderEngine.render(outputDir)           ← writes new manifest
  → newManifest = readManifest(outputDir)
  → cleanupEntityContexts(
      outputDir,
      entityContexts,
      currentSlugsByTable,       ← fresh DB query
      prevManifest,
      options,
      newManifest                ← used to detect omitIfEmpty-skipped files
    )
  → return ReconcileResult { ...renderResult, cleanup: CleanupResult }
```

### Sync flow

```
db.sync(outputDir)
  → RenderEngine.render(outputDir)     ← same as render()
  → WritebackPipeline.process()        ← read agent files, ingest entries
  → return SyncResult
```

---

## Design decisions

**Synchronous SQLite, async API surface.** `better-sqlite3` is synchronous. All Lattice methods still return `Promise<T>` — this allows callers to use `await` and keeps the API contract stable if an async adapter is ever added. The promises resolve in the same tick.

**Compile at define-time, not render-time.** `compileRender()` converts a `RenderSpec` (which can be a string, object, or function) into a single `(rows: Row[]) => string` function when `define()` is called. This ensures zero per-cycle overhead for template dispatch.

**No ORM, no query builder.** Lattice does not attempt to abstract SQL. The `columns` spec is a raw SQLite type string. Advanced queries use `db.db` (escape hatch). This keeps the library small and avoids the impedance mismatch that plagues ORMs.

**Config form is a thin wrapper over `define()`.** `new Lattice({ config })` calls `parseConfigFile()` then loops over the result calling `this.define()`. The config form is not a separate code path — it just automates the manual `define()` calls.

**Files are skipped when content is unchanged.** `RenderEngine` compares the rendered string to the file's current content before writing. This prevents unnecessary filesystem writes and keeps file modification times stable (important for LLM context systems that watch mtimes).

**Relation resolution happens in-process.** When a `belongsTo` relation is referenced in a `{{rel.field}}` token, Lattice issues a `SELECT` for each row via the adapter. This is intentionally simple — N+1 for N rows. For tables with thousands of rows this could be slow, but Lattice is designed for small-to-medium context tables (dozens to hundreds of rows), not analytics workloads.

**Manifest-driven cleanup.** Lattice never scans the output directory for files it does not recognise. Instead it only removes files and directories it previously recorded in the manifest. This means files created by agents or other tools in entity directories are never touched — unless they happen to match a filename Lattice manages, which is why `protectedFiles` exists as an escape valve.

**Render before cleanup.** `reconcile()` always runs the render cycle first, writing a new manifest, before running cleanup. This ensures the cleanup step has both the previous state (what to remove) and the current state (what is still being written) and can correctly detect `omitIfEmpty` files that were skipped this cycle but existed before.

---

## Package structure

```
src/
├── index.ts              # Public exports
├── lattice.ts            # Lattice class (public facade)
├── types.ts              # All public TypeScript types
├── cli.ts                # CLI entry point
├── config/
│   ├── types.ts          # YAML config schema types
│   └── parser.ts         # parseConfigFile / parseConfigString
├── codegen/
│   └── generate.ts       # generateTypes / generateMigration / generateAll
├── db/
│   └── sqlite.ts         # SQLiteAdapter
├── schema/
│   └── manager.ts        # SchemaManager
├── render/
│   ├── engine.ts         # RenderEngine (+ entity context rendering, v0.5)
│   ├── templates.ts      # Built-in templates + compileRender + interpolate
│   └── entity-query.ts   # resolveEntitySource + truncateContent (v0.5)
├── lifecycle/             # v0.5
│   ├── index.ts          # Barrel export
│   ├── manifest.ts       # readManifest / writeManifest / manifestPath
│   └── cleanup.ts        # cleanupEntityContexts + CleanupOptions/Result
├── sync/
│   └── loop.ts           # SyncLoop (+ cleanup integration, v0.5)
├── writeback/
│   └── pipeline.ts       # WritebackPipeline
└── security/
    └── sanitize.ts       # Sanitizer

tests/
├── unit/
│   ├── config.test.ts        # parseConfigFile / parseConfigString
│   ├── codegen.test.ts       # generateTypes / generateMigration + integration
│   ├── lattice.test.ts       # Core CRUD / query / render tests
│   └── entity-query.test.ts  # resolveEntitySource unit tests (v0.5)
├── integration/
│   ├── entity-context.test.ts # defineEntityContext() flow (v0.5)
│   └── lifecycle.test.ts      # reconcile() + cleanup (v0.5)
└── fixtures/
    └── lattice.config.yml
```
