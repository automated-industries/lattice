# Changelog

All notable changes to `@automated-industries/lattice` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

---

## [0.5.0] — 2026-03-23

### Added

**Entity Context Directories**

A new high-level API for generating parallel file-system trees that mirror your database schema — one directory per entity, one file per relationship type, and an optional combined context file per entity. Replaces ad-hoc `defineMulti()` patterns for per-entity context generation.

- `defineEntityContext(table, def)` — new `Lattice` method, must be called before `init()`. Returns `this` for chaining.
- `EntityContextDefinition` — top-level config type: `slug`, `index?`, `files`, `combined?`, `directory?`, `directoryRoot?`, `protectedFiles?`
- `EntityFileSpec` — per-file spec: `source`, `render`, `budget?`, `omitIfEmpty?`
- Five source types for per-file row resolution:
  - `SelfSource` (`{ type: 'self' }`) — entity row itself
  - `HasManySource` (`{ type: 'hasMany', table, foreignKey, references? }`) — rows on a related table pointing back
  - `ManyToManySource` (`{ type: 'manyToMany', junctionTable, localKey, remoteKey, remoteTable, references? }`) — rows from a remote table via a junction table
  - `BelongsToSource` (`{ type: 'belongsTo', table, foreignKey, references? }`) — single parent row via FK on this entity
  - `CustomSource` (`{ type: 'custom', query: (row, adapter) => Row[] }`) — fully custom query
- `resolveEntitySource(source, entityRow, entityPk, adapter)` — internal resolver (exported for testing)
- `truncateContent(content, budget?)` — truncates at `budget` characters with a `*[truncated — context budget exceeded]*` notice
- `combined` option — concatenates all rendered files with `\n\n---\n\n` dividers into a single combined file per entity, respecting an `exclude` list
- `omitIfEmpty` flag — skip writing a file when the source returns zero rows
- `budget` — per-file character limit with truncation notice
- `directoryRoot` — top-level directory owned by the entity context (defaults to table name); used by orphan cleanup
- `protectedFiles` — filenames Lattice must never delete during cleanup (e.g. `SESSION.md`)
- `directory(row)` — optional custom directory path function (overrides default `{directoryRoot}/{slug}` pattern)

**Lifecycle Management**

Tracks what Lattice has generated and removes orphaned files/directories when entities are deleted or definitions change.

- `reconcile(outputDir, options?)` — new `Lattice` method: runs a full render cycle then cleans up orphans. Returns `ReconcileResult` (`RenderResult` + `CleanupResult`)
- `ReconcileOptions` / `ReconcileResult` — new types
- `WatchOptions.cleanup?: CleanupOptions` — if set, the watch loop reads the previous manifest before each render and runs orphan cleanup after
- `WatchOptions.onCleanup?: (result: CleanupResult) => void` — callback fired after each cleanup cycle in watch mode
- `CleanupOptions` — `{ removeOrphanedDirectories?, removeOrphanedFiles?, protectedFiles?, dryRun?, onOrphan? }`
- `CleanupResult` — `{ directoriesRemoved, filesRemoved, directoriesSkipped, warnings }`
- `cleanupEntityContexts(outputDir, entityContexts, currentSlugsByTable, manifest, options, newManifest?)` — internal cleanup function (exported)

**Manifest**

After every render cycle that includes entity contexts, Lattice writes `.lattice/manifest.json` inside `outputDir`. The manifest is the authoritative record of what Lattice generated — it is what enables safe orphan cleanup.

- `readManifest(outputDir)` — read `.lattice/manifest.json`; returns `LatticeManifest | null`
- `writeManifest(outputDir, manifest)` — write the manifest atomically
- `manifestPath(outputDir)` — return the path to the manifest file
- `LatticeManifest` — `{ version: 1, generated_at, entityContexts: Record<string, EntityContextManifestEntry> }`
- `EntityContextManifestEntry` — `{ directoryRoot, indexFile?, declaredFiles, protectedFiles, entities: Record<slug, string[]> }`

**Documentation**

- `docs/entity-context.md` — complete guide to entity context directories
- Updated `docs/api-reference.md` — all v0.5 types and methods
- Updated `docs/architecture.md` — lifecycle module, manifest, cleanup
- Updated `README.md` — entity context and lifecycle sections

### Changed

- `package.json` version → `0.5.0`
- `RenderEngine._renderEntityContexts()` now returns `Record<string, EntityContextManifestEntry>` and manifests are written after each render cycle that includes entity contexts
- `SyncLoop.watch()` reads the previous manifest before render and calls `RenderEngine.cleanup()` after render when `WatchOptions.cleanup` is set
- `Lattice.reconcile()` reads previous manifest, renders (writing new manifest), then compares old vs new manifest to detect orphans

---

## [0.4.0] — 2026-03-22

### Added

**YAML schema config (`lattice.config.yml`)**

- New `LatticeConfig` / `LatticeEntityDef` / `LatticeFieldDef` types for the YAML config schema
- `parseConfigFile(configPath)` — reads and validates a `lattice.config.yml` file, returns `ParsedConfig`
- `parseConfigString(yaml, configDir)` — parses a raw YAML string (useful in tests and dynamic config)
- Field types: `uuid`, `text`, `integer`, `int`, `real`, `float`, `boolean`, `bool`, `datetime`, `date`, `blob`
- Automatic `belongsTo` relation creation from `ref: <entity>` on a field — `_id` suffix stripped from relation name
- Entity-level `primaryKey` override for composite or custom primary keys
- `render` spec in YAML: accepts a built-in template name string or `{ template, formatRow }` object
- `outputFile` paths resolved relative to the config file directory at parse time

**`lattice generate` CLI**

- New `lattice` binary bundled with the package (`bin.lattice = ./dist/cli.js`)
- `lattice generate` command — reads config, writes `generated/types.ts` and `generated/migration.sql`
- `--config / -c` flag — path to config file (default: `./lattice.config.yml`)
- `--out / -o` flag — output directory (default: `./generated`)
- `--scaffold` flag — also create empty scaffold context files at each entity's `outputFile` path
- `--version / -v` — print installed version
- `--help / -h` — print usage

**`generateTypes(config)`** — TypeScript interface generator

- One `export interface` per entity, PascalCase entity names
- Fields marked `primaryKey: true` or `required: true` are non-optional; all others have `?`
- Inline comment `// → <target>` on `ref` fields
- Type mapping: uuid/text/datetime/date → `string`; integer/int/real/float → `number`; boolean/bool → `boolean`; blob → `Buffer`

**`generateMigration(config)`** — SQL migration generator

- `CREATE TABLE IF NOT EXISTS` per entity
- Full column spec generation: `PRIMARY KEY`, `NOT NULL`, `DEFAULT` (string-quoted or numeric)

**`Lattice({ config })` constructor form**

- New `LatticeConfigInput` type: `{ config: string; options?: LatticeOptions }`
- Constructor overload: `new Lattice({ config: './lattice.config.yml' })` reads the YAML file, resolves `dbPath`, and calls `define()` for each entity automatically

**Exports added to `@automated-industries/lattice`:**

- `parseConfigFile`, `parseConfigString`, `ParsedConfig`
- `LatticeConfigInput`
- `LatticeFieldType`, `LatticeFieldDef`, `LatticeEntityDef`, `LatticeEntityRenderSpec`, `LatticeConfig`

**Documentation**

- `docs/api-reference.md` — complete per-method API reference
- `docs/configuration.md` — full YAML config format guide
- `docs/templates.md` — built-in templates and render hooks
- `docs/migrations.md` — schema migration workflow
- `docs/cli.md` — CLI reference
- `docs/architecture.md` — internals walkthrough
- `docs/examples/agent-system.md` — complete agent system example
- `docs/examples/ticket-tracker.md` — complete ticket tracker example
- `docs/examples/cms.md` — complete CMS example
- `CONTRIBUTING.md` — dev setup and contribution guide

### Changed

- `package.json` version → `0.4.0`
- `better-sqlite3` → `^12.8.0` (Node 25 compatibility; Node 25 requires the updated C++ bindings)
- `tsup.config.ts` refactored to array form: separate library and CLI build entries; CLI entry adds `#!/usr/bin/env node` shebang via `banner`
- `yaml` `^2.8.3` added to runtime dependencies

### Fixed

- TypeScript `exactOptionalPropertyTypes` error in `src/render/templates.ts` — `_NormalizedSpec.hooks` typed as `hooks?: RenderHooks | undefined`
- CLI `ParsedArgs.command` typed as `command?: string | undefined` to satisfy strict optional property checks

---

## [0.3.0] — 2026-03-18

### Added

**Built-in render templates**

- `BuiltinTemplateName` type: `'default-list' | 'default-table' | 'default-detail' | 'default-json'`
- `RenderHooks` interface: `{ beforeRender?, formatRow? }`
- `TemplateRenderSpec` interface: `{ template: BuiltinTemplateName; hooks?: RenderHooks }`
- `RenderSpec` union type: function | `BuiltinTemplateName` | `TemplateRenderSpec`
- `compileRender()` — converts any `RenderSpec` to `(rows: Row[]) => string` at `define()` time (zero per-cycle overhead)
- `interpolate(template, row, relations)` — `{{field}}` and `{{relationName.field}}` substitution engine

**Built-in template implementations**

- `default-list` — bulleted Markdown list, supports `formatRow` hook
- `default-table` — GitHub-flavoured Markdown table, headers from first row keys
- `default-detail` — one Markdown section per row, supports `formatRow` hook
- `default-json` — `JSON.stringify(rows, null, 2)` in a fenced code block

**`beforeRender` hook** — transform or filter rows before rendering; called before `formatRow`

**`formatRow` hook** — accepts a `(row: Row) => string` function or a `{{field}}` template string

**Relation resolution in templates** — `belongsTo` relations declared in `TableDefinition.relations` are joined in-process when `{{rel.field}}` tokens are found in `formatRow` strings

### Changed

- `TableDefinition.render` now accepts `RenderSpec` (function | string | object) instead of only `(rows: Row[]) => string`
- All existing function-form render definitions are fully backward compatible — no changes needed

---

## [0.2.0] — 2026-03-14

### Added

**Configurable primary key**

- `TableDefinition.primaryKey?: PrimaryKey` — single column name (`string`) or composite (`string[]`)
- Default remains `'id'` (UUID auto-generated on insert when absent)
- Custom PK: caller must supply value on every insert; no UUID generated
- Composite PK: `PkLookup` accepts `Record<string, unknown>` in addition to `string`

**Expanded query filters**

- `FilterOp` type: `'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'isNull' | 'isNotNull'`
- `Filter` interface: `{ col: string; op: FilterOp; val?: unknown }`
- `QueryOptions.filters?: Filter[]` — advanced filter clauses combined with `where` using AND
- `CountOptions` — same `where` + `filters` as `QueryOptions`

**Relationship declarations**

- `BelongsToRelation` — `{ type: 'belongsTo', table, foreignKey, references? }`
- `HasManyRelation` — `{ type: 'hasMany', table, foreignKey, references? }`
- `TableDefinition.relations?: Record<string, Relation>` — metadata used by template rendering in v0.3+

**`tableConstraints`**

- `TableDefinition.tableConstraints?: string[]` — SQL table-level constraints appended to `CREATE TABLE`
- Required for composite PKs and multi-column unique constraints

**`upsertBy(table, col, val, row)`** — insert-or-update by an arbitrary column (not the PK)

**`count(table, opts?)`** — count rows with optional where/filters

### Changed

- `SchemaManager.define()` validates that the primary key column is non-empty
- `_pkWhere()` now dispatches on `PkLookup` type to build correct WHERE clause

---

## [0.1.0] — 2026-03-10

### Added

Initial release.

**Core API**

- `Lattice(path, options?)` constructor
- `define(table, def)` — register a table schema
- `defineMulti(name, def)` — register a multi-table view
- `defineWriteback(def)` — register a writeback pipeline
- `init(options?)` — open database, apply schema, run migrations
- `close()` — close database connection
- `insert(table, row)` — insert a row; auto-generate UUID for default `id` PK
- `upsert(table, row)` — `INSERT OR REPLACE` semantics
- `update(table, id, row)` — update one row by PK
- `delete(table, id)` — delete one row by PK
- `get(table, id)` — fetch one row by PK
- `query(table, opts?)` — query rows with `where`, `orderBy`, `orderDir`, `limit`, `offset`
- `render(outputDir)` — render all tables to context files once
- `sync(outputDir)` — render + process writeback entries
- `watch(outputDir, opts?)` — start polling sync loop; returns `StopFn`
- `on(event, handler)` — subscribe to `'audit'`, `'render'`, `'writeback'`, `'error'` events
- `db` escape hatch — direct `better-sqlite3` database access

**Schema**

- `TableDefinition` — `columns`, `render` (function only), `outputFile`, `filter`, `primaryKey` (default `'id'`)
- Migration system — `_lattice_migrations` tracking table, version-based deduplication

**Security**

- `Sanitizer` — null-byte stripping, field length limits, audit event emission
- `SecurityOptions` — `sanitize`, `auditTables`, `fieldLimits`

**Infrastructure**

- `SQLiteAdapter` — `better-sqlite3` wrapper with WAL mode + busy timeout support
- `SchemaManager` — schema registry, `applySchema()`, `applyMigrations()`
- `RenderEngine` — file-write deduplication (skip unchanged content)
- `SyncLoop` — `setInterval`-based polling
- `WritebackPipeline` — offset-based file reading with dedup key support

**Exports**

- All public types exported from `@automated-industries/lattice`
- ESM + CJS dual build via tsup
