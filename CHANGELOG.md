# Changelog

All notable changes to `latticesql` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

---

## [1.6.3] — 2026-04-13

### Fixed

- **PostgresAdapter worker now runs.** 1.6.2 emitted `dist/postgres-worker.js` but the published `package.json` has `"type": "module"`, so Node 18+ treats every `.js` file in the package as ESM. The worker is built as CJS (it `require()`s `pg` and `synckit`), so loading it failed with `require is not defined in ES module scope`. The synckit `try/catch` masked this as the misleading "requires 'pg' and 'synckit'" message. Worker now ships as `dist/postgres-worker.cjs`; `PostgresAdapter` constructor resolves the `.cjs` extension. End-to-end Postgres connection now works under Node 18 / 20 / 22 / 24.

### Note

If you tried 1.6.2 and got the same misleading "requires 'pg' and 'synckit'" error, this is the actual fix. 1.6.0 / 1.6.1 / 1.6.2 should not be used with the Postgres backend.

## [1.6.2] — 2026-04-13

### Fixed

- **`PostgresAdapter` worker file now ships in the published tarball.** The 1.6.0 / 1.6.1 dist included the bundled library + CLI but not the `postgres-worker.js` file that `synckit` loads via `new Worker(workerPath)`. Result: any consumer that called `new Lattice('postgres://…').init()` got an immediate `"PostgresAdapter requires 'pg' and 'synckit'"` error even when both were installed — the catch block masked the real `Cannot find module 'postgres-worker.js'` error from synckit. `tsup.config.ts` now emits `dist/postgres-worker.js` as a standalone CJS bundle alongside the main library, with `pg` + `synckit` declared external so they resolve from the consumer app's `node_modules` at runtime.

### Note

If you tried 1.6.0 or 1.6.1 with a Postgres connection string and got the misleading "requires pg and synckit" error, upgrade to 1.6.2 — `pg` and `synckit` were correctly installed; the worker file just wasn't there to load them.

## [1.6.1] — 2026-04-13

### Added — extra `PostgresAdapter` dialect translations

The `PostgresAdapter` rewriter (introduced in 1.6.0) gains four more SQLite → Postgres translations so existing migration code that uses common SQLite idioms keeps working unchanged when pointed at a Postgres connection string:

| SQLite | Postgres translation | Notes |
|---|---|---|
| `INSERT OR IGNORE INTO …` | `INSERT INTO … ON CONFLICT DO NOTHING` | Strips `OR IGNORE`, appends `ON CONFLICT DO NOTHING` to the statement tail. Skipped if the user already wrote an explicit `ON CONFLICT` clause. Requires at least one unique constraint on the target table. |
| `INSERT OR REPLACE INTO …` | (intentionally not translated — throws) | The correct `ON CONFLICT (col) DO UPDATE SET …` form depends on the conflict target, which the translator can't infer. Surface the error so the operator picks the right form. |
| `randomblob(N)` | `gen_random_bytes(N)` | Requires `pgcrypto`. `PostgresAdapter.open()` now runs `CREATE EXTENSION IF NOT EXISTS pgcrypto` idempotently — succeeds on Supabase / Neon / RDS, warns (non-fatally) on hosted Postgres providers that restrict CREATE EXTENSION. |
| `hex(<expr>)` | `encode(<expr>, 'hex')` | Postgres lacks the SQLite `hex()` shorthand. Composite `lower(hex(randomblob(16)))` (a common 32-char hex-id pattern) translates to `lower(encode(gen_random_bytes(16), 'hex'))`. |

`INSERT OR IGNORE` translation is **string-literal aware** — the keywords are not rewritten if they appear inside quoted user data. `randomblob` / `hex` translations are not string-aware (the alternative breaks the common `hex('abc')` literal-argument case); the documented limitation is that storing the literal text `"hex(...)"` inside a single-quoted user data string will get the function name rewritten. Real migrations virtually never store SQL function names inside user data.

### Changed

- `PostgresAdapter.open()` now runs `CREATE EXTENSION IF NOT EXISTS pgcrypto` once per connection. Failures are warned (`console.warn`) but non-fatal — providers that restrict CREATE EXTENSION can still use the adapter as long as `pgcrypto` is enabled out-of-band.
- `_translateDialectForTest` exported from `src/db/postgres.ts` for unit testing of the new translation passes.

### Tests

12 new unit tests in `tests/unit/postgres-rewrite.test.ts` — `INSERT OR IGNORE` (5), `randomblob` / `hex` (5), `INSERT OR REPLACE` rejection (1), composite end-to-end (1). All 551 tests pass.

## [1.6.0] — 2026-04-13

### Added

- **Pluggable database backend.** Lattice now supports either SQLite (the existing default) or any Postgres-compatible database via a new `PostgresAdapter`. Pass a connection string and Lattice picks the right adapter:
  - `new Lattice('/path/to/db.sqlite')` — SQLite (unchanged).
  - `new Lattice(':memory:')` — in-memory SQLite (unchanged).
  - `new Lattice('file:/path/to/db.sqlite')` — explicit SQLite via `file:` scheme.
  - `new Lattice('postgres://user:pass@host:5432/db')` — Postgres.
  - `new Lattice('postgresql://...')` — Postgres (alternate scheme).
  - `new Lattice(anyPath, { adapter: myAdapter })` — bring your own adapter.
- **`StorageAdapter` interface gains two methods:** `introspectColumns(table)` and `addColumn(table, col, typeSpec)`. Implementations dispatch on their own dialect (SQLite uses `PRAGMA table_info`, Postgres uses `information_schema`; SQLite handles non-constant defaults via backfill, Postgres natively).
- **Public exports** for advanced consumers: `StorageAdapter`, `PreparedStatement`, `SQLiteAdapter`, `PostgresAdapter`, `PostgresAdapterOptions`.
- **`Lattice.adapter`** getter — portable accessor for the configured `StorageAdapter`. The existing `Lattice.db` getter still returns the better-sqlite3 handle but throws when the adapter isn't a `SQLiteAdapter`.

### Changed

- `Lattice` constructor signature is unchanged for SQLite users — the same `new Lattice(path)` form continues to work, with the same `wal` / `busyTimeout` options.
- `_addMissingColumns` and the four `PRAGMA table_info(…)` call sites in `Lattice` and `SchemaManager` now go through `adapter.introspectColumns(table)` and `adapter.addColumn(table, col, type)`. Behavior under SQLite is identical; the refactor enables the Postgres path.

### Implementation notes

- `PostgresAdapter` runs `pg` inside a `synckit` worker thread so the synchronous `StorageAdapter` interface can wrap an inherently async client. Each query pays ~1–3 ms of message-passing overhead — fine for Lattice's batch-insert + periodic-render workload, not OLTP-grade. If/when a workload genuinely needs async throughput, an async `StorageAdapter` variant can be added without breaking SQLite consumers.
- `?` placeholders are translated to `$N` automatically. The translator skips over single-quoted strings, double-quoted identifiers, and SQL comments, so `?` characters inside those are left alone.
- `BLOB` column types are translated to `BYTEA` automatically inside `addColumn`. `datetime('now')` and `RANDOM()` are translated to `NOW()` and `random()` respectively.
- `pg` and `synckit` ship as `optionalDependencies` — SQLite-only consumers don't pay the install cost. The `PostgresAdapter` constructor throws a clear error message if either is missing.

### Provider notes

- Any Postgres-compatible database that speaks the standard wire protocol on port 5432 should work — including managed providers like Supabase, Neon, and RDS.
- When using a connection pooler, prefer **session-mode pooling**. Transaction-mode poolers typically do not support prepared statements across transactions, which would break Lattice's `adapter.prepare()` pattern.

### Limitations (out of scope for this release)

- `lastInsertRowid` is `0` on the Postgres path. Use `TEXT PRIMARY KEY` (UUIDs) for portable schemas; if you need a fresh integer ID after insert on Postgres, write your own `INSERT … RETURNING id` query.
- Two SQLite-only paths remain: `fixSchemaConflicts(db)` (lifecycle helper) and the writeback session-apply machinery both take a raw better-sqlite3 handle. Postgres consumers shouldn't call them.
- A migration tool that dumps an existing SQLite Lattice DB into Postgres is not included. Use a generic SQLite → Postgres migration tool, or `INSERT … SELECT` row-by-row.

## [1.5.0] — 2026-04-08

### Note

Published to npm without a corresponding `CHANGELOG.md` entry. Reconstructed from `git log` between v1.3.1 and v1.5.0 — primarily formatting / tooling fixes (incremental changelog writes, Windows path-separator handling, prettier formatting, lint cleanup). No public API changes.

## [1.4.0] — 2026-04-08

### Note

Published to npm without a corresponding `CHANGELOG.md` entry. Reconstructed from `git log` — see notes for 1.5.0.

## [1.3.0] — 2026-04-04

### Added

- **Token-budget-aware rendering** — New `tokenBudget` and `prioritizeBy` options on `TableDefinition`. When rendered output exceeds the token budget, rows are pruned by priority and a truncation footer is appended. Token count estimated at ~4 characters per token.
- **Writeback validation** — New `validate`, `rejectBelow`, and `onReject` options on `WritebackDefinition`. Validate agent-written data before persisting — entries that fail validation or score below threshold are rejected. Supports sync and async validators.
- **Relevance-filtered rendering** — New `relevanceFilter` on `TableDefinition` and `setTaskContext()`/`getTaskContext()` on Lattice. Dynamically filter rows by relevance to the current task context before rendering.
- **Context enrichment pipeline** — New `enrich` option on `TableDefinition`. Array of transform functions applied to rows after filtering but before rendering — use for clustering, annotation, summarization, or cross-referencing.
- **Reward-scored memory** — New `rewardTracking` and `pruneBelow` options on `TableDefinition`, and `reward()` method on Lattice. Auto-adds `_reward_total` and `_reward_count` columns. Rows sorted by reward during render. Low-scoring rows auto-pruned via soft-delete.
- **Semantic search via embeddings** — New `embeddings` option on `TableDefinition` and `search()` method on Lattice. Bring your own embedding function. Embeddings stored in a companion table, cosine similarity computed in JS. Supports `topK` and `minScore` options.
- Exported new types: `WritebackValidationResult`, `RewardScores`, `EmbeddingsConfig`, `SearchOptions`, `SearchResult`.
- Exported new utilities: `estimateTokens()`, `applyTokenBudget()`.

## [1.2.3] — 2026-04-04

### Security

- **CRITICAL**: Fixed command injection in `autoUpdate()` — replaced `execSync` with `execFileSync` + semver validation
- **HIGH**: Fixed path traversal in entity slug rendering — validates slug characters and verifies resolved paths stay within output directory
- **MEDIUM**: Fixed SQL injection in reverse-sync — validates table names with same pattern as column names

## [1.2.0] — 2026-04-04

### Changed

- **Auto-combined entity context** — When an entity has multiple rendered files, the first declared file automatically becomes the combined output containing all connected context. No `combined` config needed — the primary entity file (e.g., PROJECT.md) always includes the full assembled context by default. Explicit `combined` config still works for custom output filenames or exclusions.

## [1.1.1] — 2026-04-04

### Fixed

- **ALTER TABLE with non-constant defaults** — `_addMissingColumns` now handles columns with `DEFAULT CURRENT_TIMESTAMP`, `datetime('now')`, or `RANDOM()` defaults. SQLite rejects non-constant defaults in ALTER TABLE ADD COLUMN. The fix strips the non-constant default for the ALTER statement, then backfills existing rows with `CURRENT_TIMESTAMP`. This resolves crash-on-startup when upgrading to a schema that adds new timestamp columns to existing tables.

## [1.1.0] — 2026-04-04

### Added

- **`autoUpdate()` export** — Call at app startup to automatically check npm for a newer version of `latticesql` and install it. Returns `AutoUpdateResult` with `updated`, `packages`, and `restartRequired` fields. Safe to call on every startup — skips if already on latest. Pass `{ quiet: true }` to suppress console output.

## [1.0.0] — 2026-04-04

### Changed

- **Stable release** — latticesql is now 1.0.0. The API is considered stable. Consumers using `^1.0.0` will automatically receive all non-breaking updates.

## [0.18.4] — 2026-04-04

### Added

- **CLI update checker** — `lattice` CLI now checks for new versions in the background and prints a notice when an update is available. Cached for 24 hours.
- **`lattice update` command** — self-update to the latest version from npm.

## [0.18.0] — 2026-04-03

### Added

- **Protected entity contexts** — Set `protected: true` on an entity context to prevent its data from leaking into other entities' rendered context files. Sources referencing a protected table return empty results; within the same protected table, sources return self-only. Access protected data via direct database queries.
- **At-rest encryption** — Set `encrypted: true` (all text columns) or `encrypted: { columns: ['value'] }` (specific columns) on an entity context for transparent AES-256-GCM encryption. Requires `encryptionKey` in `LatticeOptions`. Encrypted values stored as `enc:<base64>`, plaintext values pass through unchanged (migration-safe).
- **`encryptionKey`** option in `LatticeOptions` — master key for deriving AES-256 encryption keys via scrypt.
- **Encryption utilities** — `encrypt()`, `decrypt()`, `deriveKey()`, `isEncrypted()` exported for direct use.

## [0.17.0] — 2026-04-03

### Added

- **`insertReturning(table, row)`** — Insert a row and return the full inserted row (including auto-generated id and default values). Equivalent to `insert()` + `get()` in a single call.
- **`updateReturning(table, id, row)`** — Update a row and return the full updated row. Equivalent to `update()` + `get()`.
- **`migrate(migrations)`** — Run versioned migrations after `init()`. Useful for package-level schema changes applied at runtime. Supports string-based version identifiers (e.g. `"@mypackage:1.0.0"`).
- **Schema-only tables** — `render` and `outputFile` are now optional in `TableDefinition`. Tables defined without rendering produce schema but no output files.
- **Composite primary key auto-constraint** — When `primaryKey` is an array (e.g. `['user_id', 'tag_id']`), a `PRIMARY KEY(...)` table constraint is now automatically generated in the CREATE TABLE statement.

### Changed

- **Migration version type** — `Migration.version` now accepts `number | string` (was `number` only). The `__lattice_migrations` table uses `TEXT PRIMARY KEY` instead of `INTEGER PRIMARY KEY` to support both numeric and string-based versions. Existing integer versions continue to work (backward compatible).
- Migration sort order uses locale-aware numeric comparison (`localeCompare` with `{ numeric: true }`) instead of arithmetic subtraction.

## [0.16.2] — 2026-04-03

### Fixed

- Removed internal build-process file that was accidentally committed to the public repo
- Lint errors: unused `configDir` parameter in `config/parser.ts`, `let` → `const` in integration test
- `outputFile` path doubling when using config-parsed entity tables with relative paths

## [0.16.1] — 2026-04-01

### Fixed

- Export `contentHash()` from package index (documented but previously inaccessible)
- Resolve all 282 ESLint errors blocking CI (floating promises, non-null assertions, template expressions, unused imports)
- Update compatibility matrix for v0.16.0 features

## [0.16.0] — 2026-04-01

### Added

- **Reverse-sync**: Detects external modifications to rendered entity context files and sweeps changes back into the database before re-rendering. Opt-in per file via `reverseSync` function on `EntityFileSpec`. Supports dry-run mode (`reverseSync: 'dry-run'`).
- **Manifest v2**: Per-file SHA-256 content hashes stored in `.lattice/manifest.json` for change detection. v1 manifests are auto-migrated (reverse-sync skips files with no hash baseline).
- New types: `ReverseSyncUpdate`, `ReverseSyncResult`, `ReverseSyncError`, `EntityFileManifestInfo`
- New exports: `entityFileNames()`, `normalizeEntityFiles()`, `isV1EntityFiles()` manifest helpers
- `contentHash()` exported from `render/writer`

### Changed

- `ReconcileResult` now includes `reverseSync: ReverseSyncResult | null`
- `ReconcileOptions` accepts `reverseSync?: boolean | 'dry-run'` (default: `true`)
- Manifest `version` bumped from `1` to `2`; `entities` field changed from `string[]` to `Record<string, EntityFileManifestInfo>`

## [0.14.0] — 2026-03-28

### Added

- **Report framework**: `buildReport()` with time-windowed sections, duration parsing ('8h','24h','7d'), four format types (count_and_list, counts, list, custom)

## [0.13.0] — 2026-03-28

### Added

- **Seeding DSL**: `seed()` method for bulk upsert from structured data (YAML/JSON). Links to entities via junction tables, soft-deletes removed entries. SeedConfig, SeedLinkSpec types.

## [0.12.0] — 2026-03-28

### Added

- **Writeback persistence**: Pluggable `WritebackStateStore` interface. `InMemoryStateStore` (default), `SQLiteStateStore` (persistent across restarts). `createSQLiteStateStore()` factory. `onArchive` lifecycle hook on WritebackDefinition.

## [0.11.0] — 2026-03-28

### Added

- **Generic CRUD layer**: `upsertByNaturalKey()`, `enrichByNaturalKey()`, `softDeleteMissing()`, `getActive()`, `countActive()`, `getByNaturalKey()` — work on ANY table via PRAGMA introspection (no `define()` required)
- **Junction table helpers**: `link()` (INSERT OR IGNORE/REPLACE), `unlink()` (DELETE matching)
- Internal: `_ensureColumnCache()` lazily populates column cache for unregistered tables

## [0.10.0] — 2026-03-27

### Added

- **Write hooks**: `defineWriteHook()` fires after insert/update/delete with table + column filtering. `WriteHook`, `WriteHookContext` types.

## [0.9.0] — 2026-03-27

### Added

- **Entity render templates**: `entity-table`, `entity-profile`, `entity-sections` declarative templates for `EntityFileSpec.render`. Backward compatible with function form. Auto read-only header + frontmatter.

## [0.8.0] — 2026-03-27

### Added

- **Junction column projection**: `junctionColumns` on `ManyToManySource` — include junction table columns in results with optional aliasing
- **Multi-column ORDER BY**: `orderBy` accepts `OrderBySpec[]` array with per-column direction

## [0.7.0] — 2026-03-27

### Added

- **Enriched source type**: `{ type: 'enriched', include: { ... } }` — starts with entity row, attaches related data as `_key` JSON string fields via declarative or custom sub-lookups

## [0.6.0] — 2026-03-27

### Added

- **Source query options**: `filters`, `orderBy`, `orderDir`, `limit`, `softDelete` on `HasManySource`, `ManyToManySource`, `BelongsToSource`
- **sourceDefaults**: `EntityContextDefinition.sourceDefaults` merges into all relationship sources
- **Markdown utilities**: `frontmatter()`, `markdownTable()`, `slugify()`, `truncate()` — composable helpers for render functions

## [0.5.5] — 2026-03-27

### Fixed

- Removed all consumer-specific references from source code and documentation
- `READ_ONLY_HEADER` now uses generic text; `createReadOnlyHeader()` factory for custom headers
- `parseSessionMD` / `parseMarkdownEntries` accept `SessionParseOptions` for configurable entry types/aliases
- Added `scripts/check-generic.sh` guardrail wired into `prepublishOnly`

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

**Exports added to `latticesql`:**

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

- All public types exported from `latticesql`
- ESM + CJS dual build via tsup

## [0.18.2] — 2026-04-03

### Added

- **`fixSchemaConflicts(db, checks)`** — Pre-init utility to resolve legacy schema conflicts. Renames tables with incompatible columns to `_legacy_{name}` so `init()` can create fresh tables. Also handles `__lattice_migrations` INTEGER→TEXT PK migration.
