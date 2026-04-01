# Entity Context Directories

Entity context directories are a high-level API for generating a parallel file-system tree that mirrors your database — one directory per entity, one file per relationship type. They replace ad-hoc `defineMulti()` patterns for per-entity context generation.

## Overview

When an agent system manages many entities (agents, projects, users, tickets…), each entity often needs its own context directory:

```
context/
├── agents/
│   ├── AGENTS.md           ← index listing all agents
│   ├── forge/
│   │   ├── AGENT.md        ← the agent row itself
│   │   ├── TASKS.md        ← tasks assigned to Forge
│   │   ├── SKILLS.md       ← skills via junction table
│   │   └── CONTEXT.md      ← combined file (all of the above)
│   └── craft/
│       ├── AGENT.md
│       └── CONTEXT.md
└── .lattice/
    └── manifest.json       ← tracks what Lattice generated
```

Without entity context directories, you'd build this with `defineMulti()` — one definition per output file, many definitions per entity type. Entity context directories collapse the entire pattern into a single `defineEntityContext()` call.

## Basic Example

```ts
import { Lattice } from 'latticesql';

const db = new Lattice('./data/app.db');

db.define('agent', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    slug: 'TEXT NOT NULL',
    name: 'TEXT NOT NULL',
    bio: 'TEXT',
  },
  render: 'default-list',
  outputFile: 'agents-flat.md',
});

db.define('task', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    agent_id: 'TEXT',
    title: 'TEXT NOT NULL',
    status: 'TEXT DEFAULT "open"',
  },
  render: 'default-list',
  outputFile: 'tasks-flat.md',
});

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
      render: (rows) => {
        const agent = rows[0]!;
        return `# ${agent.name}\n\n${agent.bio ?? '_No bio._'}`;
      },
    },
    {
      filename: 'TASKS.md',
      source: { type: 'hasMany', table: 'task', foreignKey: 'agent_id' },
      render: (rows) => rows.map((r) => `- [ ] ${r.title}`).join('\n'),
      omitIfEmpty: true,
    },
  ],

  combined: {
    outputFile: 'CONTEXT.md',
  },

  directoryRoot: 'agents',
  protectedFiles: ['SESSION.md'],
});

await db.init();
await db.render('./context');
```

## Source Types

The `source` field on each `EntityFileSpec` determines how rows are resolved for that file.

### `self`

The entity row itself. Always exactly one row.

```ts
{
  filename: 'AGENT.md',
  source: { type: 'self' },
  render: (rows) => `# ${rows[0]!.name}`,
}
```

### `hasMany`

Rows on a related table where a foreign key points back to this entity.

```ts
{
  filename: 'TASKS.md',
  source: {
    type: 'hasMany',
    table: 'task',
    foreignKey: 'agent_id',      // FK column on the task table
    references: 'id',            // optional — PK on the agent table (default: agent's first PK)
  },
  render: (rows) => rows.map((r) => `- ${r.title}`).join('\n'),
}
```

SQL equivalent: `SELECT * FROM task WHERE agent_id = :entityPk`

### `manyToMany`

Rows from a remote table via a junction table.

```ts
{
  filename: 'SKILLS.md',
  source: {
    type: 'manyToMany',
    junctionTable: 'agent_skill',
    localKey: 'agent_id',        // FK to agent on the junction table
    remoteKey: 'skill_id',       // FK to skill on the junction table
    remoteTable: 'skill',        // table to fetch rows from
    references: 'id',            // optional — PK on the skill table
  },
  render: (rows) => rows.map((r) => `- ${r.name}`).join('\n'),
}
```

SQL equivalent: `SELECT skill.* FROM agent_skill JOIN skill ON skill.id = agent_skill.skill_id WHERE agent_skill.agent_id = :entityPk`

### `belongsTo`

A single parent row accessed via a foreign key on this entity.

```ts
{
  filename: 'ORG.md',
  source: {
    type: 'belongsTo',
    table: 'org',
    foreignKey: 'org_id',        // FK column on THIS entity's table
    references: 'id',            // optional — PK on the org table
  },
  render: (rows) => rows.length ? `Org: ${rows[0]!.name}` : '_No org._',
}
```

SQL equivalent: `SELECT * FROM org WHERE id = :entityRow.org_id`

### `custom`

A fully custom synchronous query using the raw `StorageAdapter`.

```ts
{
  filename: 'RECENT.md',
  source: {
    type: 'custom',
    query: (row, adapter) => {
      return adapter.query('event', {
        where: { agent_id: row.id },
        orderBy: 'created_at',
        orderDir: 'DESC',
        limit: 10,
      });
    },
  },
  render: (rows) => rows.map((r) => `- ${r.description}`).join('\n'),
}
```

## `omitIfEmpty`

When a source resolves zero rows, Lattice normally writes an empty file. Set `omitIfEmpty: true` to skip writing the file entirely.

```ts
{
  filename: 'TASKS.md',
  source: { type: 'hasMany', table: 'task', foreignKey: 'agent_id' },
  render: (rows) => rows.map((r) => `- ${r.title}`).join('\n'),
  omitIfEmpty: true,   // skip file if no tasks
}
```

If the entity previously had tasks and the `TASKS.md` file existed, enabling `omitIfEmpty` alone does not delete it. Pair with lifecycle cleanup to remove stale files — see [Lifecycle Management](#lifecycle-management).

## `budget`

Limit the rendered output of a file to a maximum number of characters. When the content exceeds the budget, it is truncated with a notice:

```
*[truncated — context budget exceeded]*
```

```ts
{
  filename: 'NOTES.md',
  source: { type: 'hasMany', table: 'note', foreignKey: 'agent_id' },
  render: (rows) => rows.map((r) => r.body).join('\n\n'),
  budget: 4000,
}
```

## Combined file

The `combined` option writes a single file per entity that concatenates all rendered files (joined with `\n\n---\n\n`). This is useful for LLM context injection where you want one file per entity.

```ts
db.defineEntityContext('agent', {
  slug: (row) => row.slug as string,
  files: [
    { filename: 'AGENT.md', source: { type: 'self' }, render: renderAgent },
    { filename: 'TASKS.md', source: { type: 'hasMany', ... }, render: renderTasks },
  ],
  combined: {
    outputFile: 'CONTEXT.md',
    exclude: ['TASKS.md'],    // optional — skip TASKS.md from combined output
  },
});
```

Files skipped via `omitIfEmpty` are automatically excluded from the combined output.

## Index file

The `index` option writes one file at the `directoryRoot` level (not inside per-entity subdirectories) with a listing of all entities.

```ts
db.defineEntityContext('agent', {
  slug: (row) => row.slug as string,
  index: {
    outputFile: 'AGENTS.md',
    render: (rows) => rows.map((r) => `- [${r.name}](${r.slug}/CONTEXT.md)`).join('\n'),
  },
  files: [...],
  directoryRoot: 'agents',
});
```

The `render` function receives **all entity rows** for the table — not per-entity rows.

## Custom directory path

By default Lattice writes each entity to `{directoryRoot}/{slug(row)}/`. Override with the `directory` function:

```ts
db.defineEntityContext('project', {
  slug: (row) => row.slug as string,
  directory: (row) => `projects/${row.org_slug}/${row.slug}`,
  files: [...],
});
```

## `protectedFiles`

Files listed in `protectedFiles` are never deleted by Lattice's cleanup, even if they appear to be orphaned. Use this for files that agents write into entity directories:

```ts
db.defineEntityContext('agent', {
  slug: (row) => row.slug as string,
  files: [...],
  protectedFiles: ['SESSION.md', 'NOTES.md'],
});
```

Protected files are recorded in the manifest so the protection survives across restarts.

## Reverse-Sync (v0.15+)

In agentic systems, AI agents frequently edit rendered context files directly. Without reverse-sync, those edits are destroyed on the next render cycle because Lattice overwrites files from DB state.

Reverse-sync solves this by running **before** the render phase inside `reconcile()`:

1. For each entity file with a `reverseSync` function, reads the current file from disk
2. Compares its SHA-256 hash against the last-rendered hash stored in the manifest
3. If the file was modified, calls the `reverseSync` function to parse changes back into DB updates
4. Applies those updates to the database
5. The subsequent render writes from the now-updated DB — preserving the agent's edits

### Defining a reverse-sync function

Add an optional `reverseSync` function to any `EntityFileSpec`:

```ts
db.defineEntityContext('agent', {
  slug: (row) => row.slug as string,
  files: {
    'AGENT.md': {
      source: { type: 'self' },
      render: ([r]) => `# ${r.name}\n**Role:** ${r.role}\n`,
      reverseSync: (content, entityRow) => {
        const updates: ReverseSyncUpdate[] = [];
        const nameMatch = content.match(/^# (.+)$/m);
        if (nameMatch && nameMatch[1] !== entityRow.name) {
          updates.push({
            table: 'agent',
            pk: { id: entityRow.id },
            set: { name: nameMatch[1] },
          });
        }
        return updates;
      },
    },
  },
});
```

Each `ReverseSyncUpdate` describes a single row-level mutation:

| Field | Type | Description |
|-------|------|-------------|
| `table` | `string` | Target table name |
| `pk` | `Record<string, unknown>` | Primary key columns identifying the row |
| `set` | `Record<string, unknown>` | Columns to update |

### Controlling reverse-sync behavior

Pass the `reverseSync` option to `reconcile()`:

```ts
// Default: reverse-sync enabled
await db.reconcile(outputDir);

// Dry-run: detect changes, count updates, but don't modify DB
const result = await db.reconcile(outputDir, { reverseSync: 'dry-run' });
console.log(result.reverseSync);
// { filesScanned: 5, filesChanged: 2, updatesApplied: 3, errors: [] }

// Disabled: skip reverse-sync entirely
await db.reconcile(outputDir, { reverseSync: false });
// result.reverseSync is null
```

### Edge cases

- **File deleted externally**: Skipped (no content to parse).
- **`reverseSync` throws**: Error captured in `result.reverseSync.errors`; other files still processed. DB transaction for that file is rolled back.
- **No manifest yet (first render)**: Reverse-sync has no baseline hashes — all files skipped.
- **v1 manifest (pre-0.15)**: Empty hashes — reverse-sync skips gracefully. After the first v2 render, hashes are populated and reverse-sync activates.
- **Files without `reverseSync`**: Not scanned. Agent edits to those files are still overwritten on render.

## Lifecycle Management

Over time entities are created, renamed, and deleted. Without cleanup, Lattice leaves behind directories and files for entities that no longer exist. The lifecycle system uses a manifest to track what was generated and remove orphans.

### The Manifest

After every render cycle that includes entity contexts, Lattice writes:

```
{outputDir}/.lattice/manifest.json
```

The manifest records which directories and files were generated for each entity. It is the single source of truth for lifecycle management.

### `reconcile()` — one-shot render + cleanup

Use `reconcile()` instead of `render()` when you want lifecycle management in a script or one-off invocation:

```ts
const result = await db.reconcile('./context', {
  removeOrphanedDirectories: true,
  removeOrphanedFiles: true,
});

console.log(`Removed ${result.cleanup.directoriesRemoved} stale directories`);
console.log(`Removed ${result.cleanup.filesRemoved} stale files`);
```

`reconcile()` always renders before cleaning up, so the new manifest is used to determine what is current.

### `watch()` with cleanup

In a long-running process, pass `cleanup` options to `watch()`:

```ts
const stop = await db.watch('./context', {
  interval: 5_000,
  cleanup: {
    removeOrphanedDirectories: true,
    removeOrphanedFiles: true,
  },
  onCleanup: (result) => {
    if (result.directoriesRemoved || result.filesRemoved) {
      console.log(`Cleaned ${result.directoriesRemoved} dirs, ${result.filesRemoved} files`);
    }
  },
});
```

### Dry run

Inspect what would be deleted without modifying anything:

```ts
const result = await db.reconcile('./context', {
  removeOrphanedDirectories: true,
  removeOrphanedFiles: true,
  dryRun: true,
  onOrphan: (path, kind) => console.log(`Would remove ${kind}: ${path}`),
});
```

`dryRun: true` is safe to run in CI or staging to audit cleanup without side effects.

### What gets cleaned up

**Orphaned directories** — subdirectories inside `directoryRoot` that match no current entity slug. On deletion, Lattice removes all non-protected files first; if the directory is then empty it is removed. If protected files remain, the directory is skipped (counted in `directoriesSkipped`).

**Orphaned files** — files inside a surviving entity directory that appear in the previous manifest but were not written in the current render cycle. This catches files that were removed because `omitIfEmpty` now applies or because the file spec was removed from the definition.

Files listed in `protectedFiles` (at the definition level or passed via `CleanupOptions`) are never touched.

## Reading the manifest directly

```ts
import { readManifest, manifestPath } from 'latticesql';

const manifest = readManifest('./context');
if (manifest) {
  console.log('Manifest path:', manifestPath('./context'));
  console.log('Generated at:', manifest.generated_at);

  for (const [table, entry] of Object.entries(manifest.entityContexts)) {
    const slugCount = Object.keys(entry.entities).length;
    console.log(`${table}: ${slugCount} entities in ${entry.directoryRoot}/`);
  }
}
```

## Full API reference

See [API Reference — Entity Context types](./api-reference.md#entity-context-types) for complete type signatures.
