# Entity Context Directories — Implementation Plan

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-23 (lifecycle expansion: 2026-03-23)
**Scope:** New `defineEntityContext()` API + entity lifecycle management for Lattice OSS

---

## Problem

Lattice OSS has two render primitives:
- `define(table, def)` — one table → one static output file
- `defineMulti(name, def)` — anchor table → one file per entity (dynamic path)

Neither enforces the **parallel file system structure** that secondbrain uses today — the pattern where each entity type gets a directory, a global index file, per-entity subdirectories, and per-entity files for each relationship type.

To replicate `contextGenerator.ts` with Lattice OSS today, a caller would need to wire up N separate `defineMulti()` calls, manually handle index file generation, manually concatenate combined files, and write all the query-and-filter logic inside each render function. This is the reference implementation, not a library.

---

## Reference Implementation (secondbrain)

`~/app/src/lattice/contextGenerator.ts` generates this structure on every sync cycle:

```
agents/
  AGENTS.md                    ← global index: all agents
  {slug}/
    AGENT.md                   ← agent's own data (profile, team, chain)
    PROJECTS.md                ← related projects (via agent_project junction)
    RULES.md                   ← applicable rules
    EVENTS.md                  ← recent activity
    SKILLS.md                  ← capabilities (omit if empty)
    USERS.md                   ← org-wide users (context)
    ORGS.md                    ← org summary
    FILES.md                   ← accessible files (omit if empty)
    CONTEXT.md                 ← combined: AGENT.md + PROJECTS.md + ...

projects/
  PROJECTS.md                  ← global index
  {slug}/
    PROJECT.md
    EVENTS.md                  ← omit if empty
    RULES.md                   ← omit if empty

skills/
  SKILLS.md                    ← global index
  {slug}/
    SKILL.md                   ← only if skill.definition is set

orgs/ · users/ · channels/ · files/  (same pattern)
```

Key behaviors:
- **Index files** at the directory root list all entities
- **Per-entity subdirectories** named by slug
- **Per-entity relationship files** each rendered independently with size budgets
- **Combined file** (`CONTEXT.md`) = concatenation of all per-entity files (minus SESSION.md)
- **Conditional generation**: files omitted if empty (e.g., SKILLS.md with no skills)
- **Size budgets**: each file truncates at N chars with a `[truncated]` marker
- **Atomic writes**: `.tmp` → `rename()` pattern, skip unchanged files (hash comparison)

---

## Proposed API: `defineEntityContext()`

```typescript
db.defineEntityContext(table: string, def: EntityContextDefinition): this;
```

### Core Types

```typescript
interface EntityContextDefinition {
  /**
   * Derive the entity's slug for directory naming.
   * e.g., (row) => row.slug as string
   */
  slug: (row: Row) => string;

  /**
   * Global index file listing all entities of this type.
   * Written once per render cycle (not per entity).
   */
  index?: {
    outputFile: string;               // e.g., 'agents/AGENTS.md'
    render: (rows: Row[]) => string;
  };

  /**
   * Files written inside each entity's directory.
   * Key = filename (e.g., 'AGENT.md', 'PROJECTS.md').
   */
  files: Record<string, EntityFileSpec>;

  /**
   * Optional combined context file inside each entity's directory.
   * Concatenates all per-entity files (in definition order) with --- dividers.
   * Files in `exclude` are omitted from the combined output.
   */
  combined?: {
    outputFile: string;               // e.g., 'CONTEXT.md'
    exclude?: string[];               // e.g., ['SESSION.md']
  };

  /**
   * Directory path for this entity type.
   * Default: derived as '{table}/{slug}/'
   * Can override: (row) => `custom-dir/${row.slug}/`
   */
  directory?: (row: Row) => string;
}

interface EntityFileSpec {
  /**
   * Data source. Determines what rows are passed to render().
   */
  source: EntityFileSource;

  /**
   * Render function. Receives rows from source, returns markdown string.
   * For 'self' sources, rows = [entityRow].
   */
  render: (rows: Row[]) => string;

  /** Max characters before truncation. Default: unlimited. */
  budget?: number;

  /** Skip writing this file if the source returns no rows. Default: false. */
  omitIfEmpty?: boolean;
}

type EntityFileSource =
  | { type: 'self' }
  | {
      type: 'hasMany';
      table: string;
      foreignKey: string;          // Column on related table pointing to this entity
      references?: string;         // Column on this table (default: PK)
    }
  | {
      type: 'manyToMany';
      junctionTable: string;
      localKey: string;            // FK in junction pointing to THIS entity
      remoteKey: string;           // FK in junction pointing to RELATED entity
      remoteTable: string;         // Table to JOIN through junction
    }
  | {
      type: 'belongsTo';
      table: string;
      foreignKey: string;          // Column on THIS table pointing to related
      references?: string;         // Column on related table (default: PK)
    }
  | {
      type: 'custom';
      query: (row: Row, db: Lattice) => Row[];
    };
```

### Usage Example

```typescript
const db = new Lattice('./data/app.db');

db.define('agents', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    slug: 'TEXT NOT NULL',
    name: 'TEXT NOT NULL',
    bio: 'TEXT',
    team_id: 'TEXT',
  },
  render: () => '',       // Still required for single-table render compatibility
  outputFile: '.lattice/agents-raw.md',
});

db.define('agent_skills', {
  columns: { agent_id: 'TEXT', skill_id: 'TEXT' },
  render: () => '',
  outputFile: '.lattice/agent-skills-raw.md',
});

db.defineEntityContext('agents', {
  slug: (row) => row.slug as string,

  index: {
    outputFile: 'agents/AGENTS.md',
    render: (rows) =>
      `# Agents\n\n${rows.map((r) => `- **${r.name as string}** — [context](${r.slug as string}/CONTEXT.md)`).join('\n')}`,
  },

  files: {
    'AGENT.md': {
      source: { type: 'self' },
      render: ([row]) => `# ${row.name as string}\n\n${row.bio as string ?? ''}`,
      budget: 8000,
    },
    'SKILLS.md': {
      source: {
        type: 'manyToMany',
        junctionTable: 'agent_skills',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skills',
      },
      render: (rows) => `# Skills\n\n${rows.map((r) => `- ${r.name as string}`).join('\n')}`,
      omitIfEmpty: true,
      budget: 2000,
    },
    'PROJECTS.md': {
      source: {
        type: 'manyToMany',
        junctionTable: 'agent_projects',
        localKey: 'agent_id',
        remoteKey: 'project_id',
        remoteTable: 'projects',
      },
      render: (rows) => `# Projects\n\n${rows.map((r) => `- ${r.name as string}`).join('\n')}`,
      omitIfEmpty: true,
      budget: 3000,
    },
  },

  combined: {
    outputFile: 'CONTEXT.md',
    exclude: [],
  },
});

await db.init();
await db.watch('./context-output/', { interval: 5000 });
```

This generates:
```
context-output/
  agents/
    AGENTS.md
    cortex/
      AGENT.md
      SKILLS.md      ← omitted if no skills
      PROJECTS.md    ← omitted if no projects
      CONTEXT.md     ← AGENT.md + SKILLS.md + PROJECTS.md
    toonie/
      ...
```

---

## Implementation Plan

### Phase 1: Core Types + SchemaManager Extension

**New file: `src/schema/entity-context.ts`**
- `EntityContextDefinition` interface
- `EntityFileSpec` interface
- `EntityFileSource` union type (self | hasMany | manyToMany | belongsTo | custom)
- `CompiledEntityContextDef` = resolved/compiled version stored in SchemaManager

**Modify: `src/schema/manager.ts`**
- Add `private readonly _entityContexts = new Map<string, CompiledEntityContextDef>();`
- Add `defineEntityContext(table, def): void`
- Add `getEntityContexts(): Map<string, CompiledEntityContextDef>`

**Modify: `src/types.ts`**
- Export `EntityContextDefinition`, `EntityFileSpec`, `EntityFileSource` from public API

### Phase 2: Render Engine — Entity Context Support

**Modify: `src/render/engine.ts`**

Add `_renderEntityContexts(outputDir: string): Promise<RenderResult>`

Logic per entity context definition:
1. Load all entity rows: `schema.queryTable(adapter, table)` → entity rows
2. If `index` is defined: render index and write to `index.outputFile`
3. For each entity row:
   a. Compute `entityDir = join(outputDir, def.directory ? def.directory(row) : '{table}/{slug}')`
   b. `mkdirSync(entityDir, { recursive: true })`
   c. For each file spec:
      - Resolve source rows (SQL query based on source type)
      - Skip if `omitIfEmpty && rows.length === 0`
      - Apply `render(rows)` → content string
      - Apply budget truncation if set
      - `atomicWrite(join(entityDir, filename), content)`
   d. If `combined` is set:
      - Read all generated files in order (excluding those in `combined.exclude`)
      - Join with `\n\n---\n\n`
      - `atomicWrite(join(entityDir, combined.outputFile), joined)`

Modify `render(outputDir)` to call `_renderEntityContexts()` after existing single + multi renders.

**New file: `src/render/entity-query.ts`**

Helper that resolves `EntityFileSource` → `Row[]` given an entity row:

```typescript
export function resolveEntitySource(
  source: EntityFileSource,
  entityRow: Row,
  entityPk: string,
  adapter: StorageAdapter,
  db: Lattice,
): Row[] {
  switch (source.type) {
    case 'self':
      return [entityRow];
    case 'hasMany':
      const pkVal = entityRow[source.references ?? entityPk];
      return adapter.all(
        `SELECT * FROM "${source.table}" WHERE "${source.foreignKey}" = ?`,
        [pkVal],
      );
    case 'manyToMany':
      const pk = entityRow[entityPk];
      return adapter.all(
        `SELECT r.* FROM "${source.remoteTable}" r
         JOIN "${source.junctionTable}" j ON j."${source.remoteKey}" = r.id
         WHERE j."${source.localKey}" = ?`,
        [pk],
      );
    case 'belongsTo':
      const fkVal = entityRow[source.foreignKey];
      if (fkVal == null) return [];
      const related = adapter.get(
        `SELECT * FROM "${source.table}" WHERE "${source.references ?? 'id'}" = ?`,
        [fkVal],
      );
      return related ? [related] : [];
    case 'custom':
      return source.query(entityRow, db);
  }
}
```

### Phase 3: Public API — `Lattice.defineEntityContext()`

**Modify: `src/lattice.ts`**

```typescript
defineEntityContext(table: string, def: EntityContextDefinition): this {
  this._assertNotInit('defineEntityContext');
  this._schema.defineEntityContext(table, def);
  return this;
}
```

### Phase 4: YAML Config Support (Optional, Phase 2 milestone)

Add `entityContexts` key to YAML config:

```yaml
entityContexts:
  agents:
    slug: "{{slug}}"
    index:
      outputFile: agents/AGENTS.md
      render: default-list  # or custom function
    files:
      AGENT.md:
        source: self
        template: default-detail
        budget: 8000
      SKILLS.md:
        source:
          type: manyToMany
          junctionTable: agent_skills
          localKey: agent_id
          remoteKey: skill_id
          remoteTable: skills
        template: default-list
        omitIfEmpty: true
        budget: 2000
    combined:
      outputFile: CONTEXT.md
```

Config parser extension in `src/config/parser.ts`.

### Phase 5: CLI Support

Extend `src/cli.ts` with `lattice generate` command:

```
lattice generate --config ./lattice.config.yml --output ./context/
```

Runs one-shot context generation (no watch loop).

### Phase 6: Tests

New test files:
- `tests/unit/entity-query.test.ts` — unit test `resolveEntitySource()` for all 5 source types
- `tests/integration/entity-context.test.ts` — integration test for full `defineEntityContext()` flow:
  - Index file generated
  - Per-entity directories created
  - Files written correctly for each source type
  - `omitIfEmpty` behavior
  - Budget truncation
  - Combined file content and order
  - File skipped if content unchanged (hash comparison)

---

## Lifecycle Management

> Covers schema evolution, entity deletion, entity creation, relationship changes, and
> reconciliation between the database state and the file system.

### The Core Problem

The render system described in Phases 1–6 is **additive-only**: it writes and updates files
every cycle, but it never removes anything. This is safe but creates drift:

| Event | Current behaviour | Desired behaviour |
|---|---|---|
| Entity deleted from DB | Directory stays forever | Directory cleaned up |
| Entity slug renamed | Old dir orphaned, new dir created | Old dir removed |
| Relationship file added to definition | File appears on next cycle | ✓ (already works) |
| Relationship file removed from definition | Old file stays forever | Old file removed |
| Table renamed in definition | Old root dir orphaned | Old root dir removed |
| Column dropped, render fn updated | File content updates | ✓ (already works) |

Without cleanup, a long-running system accumulates orphaned directories and files that LLMs
read as if they still represent real entities — silently injecting stale, incorrect context.

### Design Principles

1. **Never delete files the library didn't create.** Protected files (e.g. `SESSION.md` written
   by agents) must be declared and are never touched by cleanup.
2. **Cleanup is opt-in.** The default render cycle is still additive-only. Orphan removal
   requires either the `cleanup` option in `watch()` or an explicit `reconcile()` call.
3. **No content-loss on non-empty directories.** If an orphaned entity directory still contains
   user files after Lattice-managed files are removed, the directory is left in place with a
   warning rather than force-deleted.
4. **The manifest is the source of truth.** Lattice writes a small JSON manifest after every
   render cycle recording what it owns. Cleanup diffs the manifest against the current DB state
   — it never makes assumptions about what it created in previous sessions.

---

### Phase 7: Manifest + Orphan Cleanup

#### 7a — `EntityContextDefinition` Additions

Add two new fields:

```typescript
interface EntityContextDefinition {
  // ... existing fields ...

  /**
   * The top-level directory that this entity context "owns".
   * Cleanup scans this directory for orphaned entity subdirectories.
   * Defaults to the table name (e.g. 'agents').
   *
   * Must be unique across all defineEntityContext() calls on a single Lattice instance.
   */
  directoryRoot?: string;

  /**
   * Files inside each entity's directory that Lattice must never delete,
   * even during cleanup. Typically agent-writable files like SESSION.md.
   * Default: [].
   */
  protectedFiles?: string[];
}
```

#### 7b — The Manifest

After every render cycle Lattice writes `.lattice/manifest.json` inside `outputDir`.
The manifest is the authoritative record of what Lattice has generated.

```typescript
// src/lifecycle/manifest.ts

interface LatticeManifest {
  /** Semver of the manifest schema. */
  version: number;
  generated_at: string;
  /** Keyed by table name (entity context key). */
  entityContexts: Record<string, EntityContextManifestEntry>;
}

interface EntityContextManifestEntry {
  /** Top-level directory owned by this context (e.g. 'agents'). */
  directoryRoot: string;
  /** Index file path relative to outputDir (e.g. 'agents/AGENTS.md'). */
  indexFile?: string;
  /** Files declared in EntityContextDefinition.files. */
  declaredFiles: string[];
  /** Files that must never be removed (protectedFiles). */
  protectedFiles: string[];
  /**
   * Per-entity record of which files were actually written last cycle.
   * Key = slug, value = filenames written (omitIfEmpty files may be absent).
   */
  entities: Record<string, string[]>;
}
```

**Manifest lifecycle:**
- **Written** atomically (`.tmp` → `rename()`) at the end of every successful render cycle.
- **Read** at the start of cleanup to know what was managed previously.
- If no manifest exists (first run or output dir is new), cleanup skips orphan removal
  and writes the manifest for the first time.
- The manifest directory (`.lattice/`) is excluded from all recursive deletions.

#### 7c — Cleanup Logic

**New file: `src/lifecycle/cleanup.ts`**

```typescript
export interface CleanupOptions {
  /** Remove entity directories whose slug is no longer in the DB. Default: true. */
  removeOrphanedDirectories?: boolean;
  /** Remove files inside entity dirs that are no longer declared. Default: true. */
  removeOrphanedFiles?: boolean;
  /** Additional globally protected files (merged with per-entity protectedFiles). */
  protectedFiles?: string[];
  /** Report orphans but do not delete anything. */
  dryRun?: boolean;
  /** Called for each orphan before removal (or instead of removal in dryRun mode). */
  onOrphan?: (path: string, kind: 'directory' | 'file') => void;
}

export interface CleanupResult {
  directoriesRemoved: string[];
  filesRemoved: string[];
  /** Directories with user files that were left in place. */
  directoriesSkipped: string[];
  warnings: string[];
}

export function cleanupEntityContext(
  outputDir: string,
  table: string,
  def: CompiledEntityContextDef,
  currentSlugs: Set<string>,
  manifest: LatticeManifest | null,
  options: CleanupOptions,
): CleanupResult;
```

**Algorithm:**

```
cleanup(outputDir, entityContextDef, currentSlugs, manifest, options):

  root = join(outputDir, def.directoryRoot)
  protected = new Set([...def.protectedFiles, ...options.protectedFiles])
  result = { directoriesRemoved: [], filesRemoved: [], ... }

  // === Step 1: Remove orphaned entity directories ===
  if options.removeOrphanedDirectories:
    actualDirs = listDirectories(root)
    for dir in actualDirs:
      if dir.name NOT IN currentSlugs:
        entityDir = join(root, dir.name)
        managedFiles = manifest?.entityContexts[table]?.entities[dir.name] ?? []

        // Remove Lattice-managed files from the orphaned directory
        for file in managedFiles:
          filePath = join(entityDir, file)
          if exists(filePath) AND file NOT IN protected:
            if NOT options.dryRun: unlinkSync(filePath)
            options.onOrphan?.(filePath, 'file')
            result.filesRemoved.push(filePath)

        // Remove directory only if now empty (no user files remain)
        remaining = listFiles(entityDir).filter(f => f NOT IN protected)
        if remaining.length === 0:
          if NOT options.dryRun: rmdirSync(entityDir)
          options.onOrphan?.(entityDir, 'directory')
          result.directoriesRemoved.push(entityDir)
        else:
          result.directoriesSkipped.push(entityDir)
          result.warnings.push(`${entityDir}: left in place (contains user files: ${remaining})`)

  // === Step 2: Remove orphaned files within surviving entity directories ===
  if options.removeOrphanedFiles:
    declaredFiles = new Set(Object.keys(def.files))
    if def.combined: declaredFiles.add(def.combined.outputFile)

    for slug in currentSlugs:
      entityDir = join(root, slug)
      if NOT exists(entityDir): continue

      previouslyWritten = manifest?.entityContexts[table]?.entities[slug] ?? []
      for file in previouslyWritten:
        if file NOT IN declaredFiles AND file NOT IN protected:
          filePath = join(entityDir, file)
          if exists(filePath):
            if NOT options.dryRun: unlinkSync(filePath)
            options.onOrphan?.(filePath, 'file')
            result.filesRemoved.push(filePath)

  return result
```

#### 7d — `Lattice.reconcile()` Public Method

```typescript
export interface ReconcileOptions extends CleanupOptions {
  // Inherits dryRun, protectedFiles, onOrphan, etc.
}

export interface ReconcileResult extends RenderResult {
  cleanup: CleanupResult;
}

// In lattice.ts:
reconcile(outputDir: string, options: ReconcileOptions = {}): Promise<ReconcileResult>;
```

**Behaviour:** Runs cleanup first (using the existing manifest), then runs a full render cycle
(which writes the updated manifest at the end). The render result reflects what was written;
the cleanup result reflects what was removed.

```typescript
async reconcile(outputDir, options = {}) {
  const manifest = readManifest(outputDir);  // null if first run
  const cleanup = runCleanup(outputDir, manifest, options);
  const render = await this._render.render(outputDir);  // also writes new manifest
  return { ...render, cleanup };
}
```

#### 7e — Cleanup Option in `watch()`

```typescript
export interface WatchOptions {
  interval?: number;
  onRender?: (result: RenderResult) => void;
  onError?: (err: Error) => void;
  /**
   * If set, runs orphan cleanup after each render cycle.
   * Safe to enable in long-running daemons — never removes protectedFiles.
   */
  cleanup?: CleanupOptions;
}
```

When `cleanup` is set, the watch tick becomes:
```
tick():
  1. render(outputDir)           → writes new manifest
  2. cleanupAll(outputDir, ...)  → removes orphans using previous manifest diff
```

**New files:**
- `src/lifecycle/manifest.ts` — manifest read/write + types
- `src/lifecycle/cleanup.ts` — cleanup algorithm
- `src/lifecycle/index.ts` — re-exports

**Modified files:**
- `src/render/engine.ts` — write manifest at end of `render()`
- `src/sync/loop.ts` — accept `cleanup` option, call cleanup after each tick
- `src/lattice.ts` — add `reconcile()` method
- `src/types.ts` — export `ReconcileOptions`, `ReconcileResult`, `CleanupOptions`, `CleanupResult`

---

### Phase 8: CLI Lifecycle Commands

Extend `src/cli.ts` with two new subcommands.

#### `lattice reconcile`

```
lattice reconcile --config ./lattice.config.yml --output ./context/
  [--dry-run]
  [--no-orphan-dirs]
  [--no-orphan-files]
  [--protected SESSION.md,NOTES.md]
```

Prints a structured diff of what was removed and what was written:

```
✓ Rendered 12 files for 4 agents
✓ Rendered 3 files for 2 projects
✗ Removed orphaned directory: agents/old-agent/ (2 files deleted)
✗ Removed orphaned file: agents/cortex/RULES.md (relationship removed from definition)
⚠  Left in place: agents/deprecated-agent/ (contains SESSION.md)
```

Exits with code 1 if any warnings (non-empty orphaned directories) are present.
Exits with code 0 on clean reconcile.

#### `lattice status`

```
lattice status --config ./lattice.config.yml --output ./context/
```

Alias for `lattice reconcile --dry-run`. Reports drift without making any changes.
Useful in CI to detect that context files are out of sync with the DB.

```
DRIFT DETECTED — run `lattice reconcile` to fix:
  MISSING  agents/new-agent/AGENT.md
  MISSING  agents/new-agent/CONTEXT.md
  ORPHAN   agents/deleted-agent/ (directory)
  ORPHAN   agents/cortex/FILES.md (file — relationship removed)
  STALE    agents/toonie/AGENT.md (content hash mismatch)

2 missing, 2 orphans, 1 stale. Exit code: 1
```

---

### Phase 9: Tests — Lifecycle Events

**New file: `tests/integration/lifecycle.test.ts`**

Covers all six lifecycle scenarios from the spec:

#### Scenario 1: Entity Deletion

```typescript
it('removes entity directory when entity is deleted from DB', async () => {
  const db = setupAgentsDb();
  await db.init();
  const outputDir = tmpDir();

  // Render initial state: agents/cortex/, agents/toonie/
  await db.reconcile(outputDir);
  expect(existsSync(join(outputDir, 'agents/cortex'))).toBe(true);

  // Delete 'cortex' from DB
  await db.delete('agents', 'cortex-id');

  // Reconcile removes the orphaned directory
  const result = await db.reconcile(outputDir, { removeOrphanedDirectories: true });
  expect(result.cleanup.directoriesRemoved).toContain(
    join(outputDir, 'agents/cortex'),
  );
  expect(existsSync(join(outputDir, 'agents/cortex'))).toBe(false);

  // 'toonie' directory is untouched
  expect(existsSync(join(outputDir, 'agents/toonie'))).toBe(true);
});

it('leaves entity directory in place if protected files exist', async () => {
  const db = setupAgentsDb({ protectedFiles: ['SESSION.md'] });
  await db.init();
  const outputDir = tmpDir();
  await db.reconcile(outputDir);

  // Simulate agent writing to SESSION.md
  writeFileSync(join(outputDir, 'agents/cortex/SESSION.md'), 'session data');

  // Delete 'cortex' from DB
  await db.delete('agents', 'cortex-id');

  const result = await db.reconcile(outputDir, { removeOrphanedDirectories: true });
  expect(result.cleanup.directoriesSkipped).toContain(
    join(outputDir, 'agents/cortex'),
  );
  // SESSION.md survives
  expect(existsSync(join(outputDir, 'agents/cortex/SESSION.md'))).toBe(true);
  // Lattice-managed files removed
  expect(existsSync(join(outputDir, 'agents/cortex/AGENT.md'))).toBe(false);
  expect(result.warnings.length).toBeGreaterThan(0);
});
```

#### Scenario 2: Entity Creation

```typescript
it('creates full directory structure for new entity on next render', async () => {
  const db = setupAgentsDb();
  await db.init();
  const outputDir = tmpDir();
  await db.reconcile(outputDir);

  // Insert a new agent
  await db.insert('agents', { id: 'new-id', slug: 'new-agent', name: 'New Agent' });

  // No reconcile needed — regular render creates the new entity's files
  await db.render(outputDir);

  expect(existsSync(join(outputDir, 'agents/new-agent/AGENT.md'))).toBe(true);
  expect(existsSync(join(outputDir, 'agents/new-agent/CONTEXT.md'))).toBe(true);

  // Index file updated to include new entity
  const index = readFileSync(join(outputDir, 'agents/AGENTS.md'), 'utf-8');
  expect(index).toContain('New Agent');
});
```

#### Scenario 3: Entity Slug Rename (Schema Change Effect)

```typescript
it('removes old directory and creates new one when slug changes', async () => {
  const db = setupAgentsDb();
  await db.init();
  const outputDir = tmpDir();
  await db.reconcile(outputDir);

  // Change agent slug from 'cortex' to 'cortex-v2'
  await db.update('agents', 'cortex-id', { slug: 'cortex-v2' });

  const result = await db.reconcile(outputDir, { removeOrphanedDirectories: true });

  // Old directory removed
  expect(result.cleanup.directoriesRemoved).toContain(
    join(outputDir, 'agents/cortex'),
  );
  expect(existsSync(join(outputDir, 'agents/cortex'))).toBe(false);

  // New directory created
  expect(existsSync(join(outputDir, 'agents/cortex-v2/AGENT.md'))).toBe(true);
});
```

#### Scenario 4: Relationship File Added

```typescript
it('creates new relationship files when relationship added to definition', async () => {
  // Start with agents having no SKILLS.md definition
  const db = setupAgentsDb({ noSkills: true });
  await db.init();
  const outputDir = tmpDir();
  await db.reconcile(outputDir);
  expect(existsSync(join(outputDir, 'agents/cortex/SKILLS.md'))).toBe(false);

  // Re-init with skills definition added
  db.close();
  const db2 = setupAgentsDb({ withSkills: true });
  await db2.init();

  // Skills relationship file appears on next render
  await db2.render(outputDir);
  expect(existsSync(join(outputDir, 'agents/cortex/SKILLS.md'))).toBe(true);
});
```

#### Scenario 5: Relationship File Removed

```typescript
it('removes stale relationship file when removed from definition', async () => {
  // Start with agents having SKILLS.md
  const db = setupAgentsDb({ withSkills: true });
  await db.init();
  const outputDir = tmpDir();
  await db.reconcile(outputDir);
  expect(existsSync(join(outputDir, 'agents/cortex/SKILLS.md'))).toBe(true);

  // Re-init without skills definition
  db.close();
  const db2 = setupAgentsDb({ noSkills: true });
  await db2.init();

  // reconcile removes the orphaned SKILLS.md
  const result = await db2.reconcile(outputDir, { removeOrphanedFiles: true });
  expect(result.cleanup.filesRemoved).toContain(
    join(outputDir, 'agents/cortex/SKILLS.md'),
  );
  expect(existsSync(join(outputDir, 'agents/cortex/SKILLS.md'))).toBe(false);

  // AGENT.md (still declared) is untouched
  expect(existsSync(join(outputDir, 'agents/cortex/AGENT.md'))).toBe(true);
});
```

#### Scenario 6: Stale Relationship File (Related Entity Deleted)

```typescript
it('removes stale manyToMany file after all related entities are deleted', async () => {
  const db = setupAgentsDbWithSkills();
  await db.init();
  const outputDir = tmpDir();
  await db.reconcile(outputDir);

  // cortex has SKILLS.md because it has skills
  expect(existsSync(join(outputDir, 'agents/cortex/SKILLS.md'))).toBe(true);

  // Remove all of cortex's skills from the junction table
  await db.delete('agent_skills', /* all cortex entries */ ...);

  // SKILLS.md has omitIfEmpty: true — next render skips writing it
  await db.render(outputDir);
  // Stale SKILLS.md still on disk (not yet removed by render)
  expect(existsSync(join(outputDir, 'agents/cortex/SKILLS.md'))).toBe(true);

  // reconcile removes it (it's in the manifest as previously written,
  // but render didn't write it this cycle)
  const result = await db.reconcile(outputDir, { removeOrphanedFiles: true });
  expect(existsSync(join(outputDir, 'agents/cortex/SKILLS.md'))).toBe(false);
});
```

#### Scenario 7: Dry Run / Status

```typescript
it('dry run reports orphans without deleting anything', async () => {
  const db = setupAgentsDb();
  await db.init();
  const outputDir = tmpDir();
  await db.reconcile(outputDir);

  await db.delete('agents', 'cortex-id');

  const result = await db.reconcile(outputDir, {
    removeOrphanedDirectories: true,
    dryRun: true,
  });

  // Orphan reported
  expect(result.cleanup.directoriesRemoved).toContain(
    join(outputDir, 'agents/cortex'),
  );
  // But nothing was actually deleted
  expect(existsSync(join(outputDir, 'agents/cortex'))).toBe(true);
});
```

#### Scenario 8: Manifest Continuity

```typescript
it('manifest reflects what was written each cycle', async () => {
  const db = setupAgentsDb({ withSkills: true });
  await db.init();
  const outputDir = tmpDir();
  await db.render(outputDir);

  const manifest = readManifest(outputDir);
  expect(manifest.entityContexts['agents'].entities['cortex']).toContain('SKILLS.md');
  expect(manifest.entityContexts['agents'].entities['cortex']).toContain('AGENT.md');

  // Remove cortex's skills → SKILLS.md omitted next cycle
  await removeAllAgentSkills(db, 'cortex-id');
  await db.render(outputDir);

  const manifest2 = readManifest(outputDir);
  // Manifest updated: SKILLS.md no longer listed for cortex
  expect(manifest2.entityContexts['agents'].entities['cortex']).not.toContain('SKILLS.md');
  // reconcile can now use this diff to clean up the stale file
});
```

---

### Lifecycle Scenarios Reference

| Scenario | Trigger | Detection method | Cleanup action |
|---|---|---|---|
| Entity deleted | `db.delete()` | Slug not in DB query | Remove entity dir (after stripping managed files) |
| Entity slug changed | `db.update()` on slug field | Old slug not in DB query | Remove old dir; new dir created by render |
| Relationship file added to definition | Code change in `defineEntityContext` | N/A — file is written by render | ✓ automatic |
| Relationship file removed from definition | Code change in `defineEntityContext` | File in manifest but not in declared files | Remove orphan file |
| `omitIfEmpty` file becomes empty | Related entities deleted | File in manifest but render skipped it | Remove orphan file |
| Entity context table renamed | Code change (new `defineEntityContext` call) | Old root directory not owned by any context | Manual: `lattice reconcile` after code change |
| New entity added | `db.insert()` | N/A — directory created by render | ✓ automatic |
| Column added to schema | Migration | N/A — render output changes | ✓ automatic |
| Column dropped from schema | Migration | N/A — render function must be updated by caller | ✓ caller's responsibility |

---

### Schema/Model Change Guidelines

These are the cases where the library cannot auto-detect changes without explicit developer
action. Document these in the public API as expected manual steps.

**Renaming an entity context (table renamed in DB + code):**
```bash
# 1. Apply your DB migration (rename the table)
# 2. Update defineEntityContext() call in code (new table name, possibly new directoryRoot)
# 3. Run reconcile to clean up the old root directory
lattice reconcile --output ./context/
```

**Removing an entity context entirely (table dropped):**
```bash
# 1. Apply your DB migration (drop the table)
# 2. Remove the defineEntityContext() call from code
# 3. Run reconcile — old root directory becomes an unowned orphan
lattice reconcile --output ./context/
```

> **Unowned directories**: Reconcile only cleans up directories/files that are in the
> manifest. If a root directory (e.g. `old-agents/`) was generated by a previous version
> of the code but is no longer declared, it appears in the manifest's entity context list
> and gets cleaned up. This is why the manifest is read from disk, not recomputed from
> current definitions.

---

### Updated Type Signatures

Two additions to `EntityContextDefinition`:

```typescript
interface EntityContextDefinition {
  slug: (row: Row) => string;
  index?: { outputFile: string; render: (rows: Row[]) => string };
  files: Record<string, EntityFileSpec>;
  combined?: { outputFile: string; exclude?: string[] };
  directory?: (row: Row) => string;

  // NEW:
  /**
   * The directory that this entity context owns.
   * Used by cleanup to know which subdirectories to scan for orphans.
   * Defaults to the table name.
   */
  directoryRoot?: string;

  /**
   * Files that must never be deleted by cleanup or reconcile.
   * Typically agent-writable files (e.g. SESSION.md, NOTES.md).
   * Default: [].
   */
  protectedFiles?: string[];
}
```

No breaking changes to existing `EntityContextDefinition` fields.

---

The following are intentionally NOT built into the library:

- **Schema-specific assembly logic** (agent report chains, deduplication of team vs. direct projects, event categorization, lookup caching) — these require app-specific queries and business logic. The `custom` source type handles these.
- **Rendering templates** (how to render an agent, a project, etc.) — the library provides the structure, the caller provides the markdown.
- **Size budget defaults** — no opinionated defaults; caller specifies per file.
- **Frontmatter injection** — optionally added by the render function; not a framework concern.

---

## What the Library Provides

| Feature | Built-in | Phase |
|---------|----------|-------|
| Directory creation per entity | ✓ | 1–3 |
| Global index file | ✓ | 1–3 |
| Self source (entity's own row) | ✓ | 1–3 |
| hasMany source (FK on other table) | ✓ | 1–3 |
| manyToMany source (junction table) | ✓ | 1–3 |
| belongsTo source (FK on this table) | ✓ | 1–3 |
| Custom query source | ✓ | 1–3 |
| Combined file generation | ✓ | 1–3 |
| omitIfEmpty | ✓ | 1–3 |
| Size budget + truncation | ✓ | 1–3 |
| Atomic writes | ✓ (reuse existing `atomicWrite`) | 1–3 |
| Content-hash skip (unchanged) | ✓ (reuse existing `atomicWrite`) | 1–3 |
| Watch loop integration | ✓ (auto-included in `render()`) | 1–3 |
| Manifest (tracks what was generated) | ✓ | 7 |
| Orphan directory removal on entity delete | ✓ (opt-in via `cleanup`) | 7 |
| Orphan file removal on relationship change | ✓ (opt-in via `cleanup`) | 7 |
| Protected files (never deleted) | ✓ | 7 |
| `reconcile()` method (full diff + fix) | ✓ | 7 |
| Dry-run / status mode | ✓ | 7 |
| `lattice reconcile` CLI command | ✓ | 8 |
| `lattice status` CLI command (dry-run) | ✓ | 8 |
| YAML config support | Phase 4 | 4 |
| CLI `generate` / `watch` commands | Phase 5 | 5 |

---

## Migration Path for secondbrain

Once this ships, `contextGenerator.ts` could be rewritten to use `defineEntityContext()`. The app would:
1. Define entity contexts for agents, projects, orgs, users, skills, channels, files
2. Use `custom` source for complex queries (agent report chain, event categorization)
3. Use `hasMany` / `manyToMany` for simple relationship files
4. Use `combined` for CONTEXT.md
5. Remove ~400 lines of boilerplate and delegate structure management to the library

---

## Estimated Scope

| Phase | Description | Files Added/Modified | Tests |
|-------|-------------|---------------------|-------|
| 1 | Types + SchemaManager extension | 2 new, 2 modified | — |
| 2 | RenderEngine entity context support | 1 new, 1 modified | 15 unit |
| 3 | Public `defineEntityContext()` API | 1 modified | — |
| 4 | YAML config support | 1 modified | 5 unit |
| 5 | CLI `generate` + `watch` commands | 1 modified | 3 integration |
| 6 | Integration tests (render) | 2 new | 25 |
| 7 | Manifest + cleanup + `reconcile()` | 3 new, 3 modified | 15 unit + 8 integration |
| 8 | CLI `reconcile` + `status` commands | 1 modified | 4 integration |
| 9 | Lifecycle integration tests | 1 new | 30 |

**Phase 1–3 + 6:** Core render path. Ship as v0.5.0-alpha.
**Phase 7–9:** Lifecycle management. Ship as v0.5.0 stable.
**Phase 4–5:** YAML + CLI. Ship as v0.5.1.

Total: ~12 new/modified files, ~100 new tests across two PRs.
