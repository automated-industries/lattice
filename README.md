# latticesql

**Persistent memory for AI agents.** Keeps a SQLite **or Postgres** database and a set of context files in sync — so every agent session starts with accurate state, and agent output becomes permanent data.

[![npm version](https://img.shields.io/npm/v/latticesql.svg)](https://www.npmjs.com/package/latticesql)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**[latticeSQL.com](https://latticeSQL.com)** — docs, examples, and guides

---

## What it does

Every AI agent session starts cold — no memory of what happened yesterday, what state the system is in, or what other agents have done. Lattice solves this with a minimal, generic engine that:

1. **Renders** DB rows into agent-readable text files (Markdown, JSON, or any format you define)
2. **Watches** for DB changes and re-renders automatically
3. **Ingests** agent-written output back into the DB via the writeback pipeline
4. **Manages** state with full CRUD, natural-key operations, seeding, and soft-delete
5. **Optimizes** context with token budgets, relevance filtering, enrichment pipelines, and reward-scored memory
6. **Searches** full-text (FTS5 / `tsvector`, with a LIKE fallback) and semantically (bring-your-own embeddings + cosine similarity)
7. **Organizes** everything into `.lattice` workspaces with a local browser GUI, a workspace dashboard, changelog/version history, and a SQL↔markdown context bridge that auto-renders on every write

Lattice has no opinions about your schema, your agents, or your file format. You define the tables. You control the rendering. Lattice runs the sync loop.

**New in 1.16:** the `.lattice` workspace model + auto-render, full-text search, sources/references, a workspace dashboard, a **multiplayer cloud-editing** experience (live share/de-share, "last edited by", change-flash + counts, and an offline edit queue that replays on reconnect), and a much richer **Data Model editor** in the GUI — a force-directed schema graph, bidirectional many-to-many links, and a soft-delete model where every schema change (create/rename/delete a table, column, or link) is tracked in version history and **reversible** (deletes never destroy data; revert restores it), with session-scoped undo/redo. All with no AI dependency. See [docs/workspaces.md](docs/workspaces.md) and [docs/collaboration.md](docs/collaboration.md). The AI assistant, chat, and ingest summarization are exclusive to the 2.0 line (2.0 = the 1.16 feature set plus that AI layer).

---

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [The sync loop](#the-sync-loop)
- [API reference](#api-reference)
  - [Constructor](#constructor)
  - [define()](#definedefine)
  - [defineMulti()](#definemulti)
  - [defineEntityContext()](#defineentitycontext-v05)
  - [defineWriteback()](#definewriteback)
  - [init() / close()](#init--close)
  - [migrate()](#migrate-v017)
  - [CRUD operations](#crud-operations)
  - [Query operators](#query-operators)
  - [Render, sync, watch, and reconcile](#render-sync-watch-and-reconcile)
  - [Events](#events)
  - [Raw DB access](#raw-db-access)
  - [Context optimization](#context-optimization-v13)
  - [Semantic search](#semantic-search-v13)
  - [Writeback validation](#writeback-validation-v13)
- [Template rendering](#template-rendering)
  - [Built-in templates](#built-in-templates)
  - [Lifecycle hooks](#lifecycle-hooks)
  - [Field interpolation](#field-interpolation)
- [Entity context directories (v0.5+)](#entity-context-directories-v05)
- [SESSION.md write pattern](#sessionmd-write-pattern)
- [YAML config (v0.4+)](#yaml-config-v04)
  - [lattice.config.yml reference](#latticeconfigyml-reference)
  - [Init from config](#init-from-config)
  - [Config API](#config-api-programmatic)
- [CLI — lattice generate](#cli--lattice-generate)
- [CLI — lattice gui (v1.11+)](#cli--lattice-gui-v111)
- [Schema migrations](#schema-migrations)
- [Security](#security)
- [Pluggable backends (v1.6+)](#pluggable-backends-v16)
- [Architecture](#architecture)
- [Examples](#examples)
- [Staying up to date](#staying-up-to-date)
  - [Auto-update](#auto-update-v11)
- [Telemetry](#telemetry)
- [Contributing](#contributing)
- [Changelog](#changelog)

---

## Installation

```bash
npm install latticesql
```

Requires **Node.js 18+**. The default backend is SQLite (`better-sqlite3`) — no external database process needed.

To use the Postgres backend (for Supabase, Neon, RDS, or any other Postgres-compatible database), install the optional dependency:

```bash
npm install latticesql pg
```

Then pass a connection string instead of a file path:

```ts
import { Lattice } from 'latticesql';

const lattice = new Lattice('postgres://user:pass@host:5432/db');
// rest of your setup is identical to the SQLite path
```

See [Pluggable backends](#pluggable-backends-v16) below for full details.

---

## Quick start

```typescript
import { Lattice } from 'latticesql';

const db = new Lattice('./state.db');

db.define('agents', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    name: 'TEXT NOT NULL',
    persona: 'TEXT',
    active: 'INTEGER DEFAULT 1',
  },
  render(rows) {
    return rows
      .filter((r) => r.active)
      .map((r) => `## ${r.name}\n\n${r.persona ?? ''}`)
      .join('\n\n---\n\n');
  },
  outputFile: 'AGENTS.md',
});

await db.init();

await db.insert('agents', { name: 'Alpha', persona: 'You are Alpha, a research assistant.' });
await db.insert('agents', { name: 'Beta', persona: 'You are Beta, a code reviewer.' });

// Render DB → context files
await db.render('./context');
// Writes: context/AGENTS.md

// Watch for changes, re-render every 5 seconds
const stop = await db.watch('./context', { interval: 5000 });

// Later:
stop();
db.close();
```

**YAML config form** (v0.4+) — declare your schema in a file instead:

```typescript
const db = new Lattice({ config: './lattice.config.yml' });
await db.init();
// Tables and render functions are wired automatically from the config
```

---

## The sync loop

```
Your DB (SQLite)
     │  Lattice reads rows → render functions → text
     ▼
Context files (Markdown, JSON, etc.)
     │  LLM agents read these at session start
     ▼
Agent output files
     │  Lattice writeback pipeline parses these
     ▼
Your DB (rows inserted/updated)
```

Lattice reads your database for rendering, provides a full CRUD API for managing state, and persists agent output back to the DB via the writeback pipeline.

---

## API reference

### Constructor

```typescript
new Lattice(path: string, options?: LatticeOptions)
new Lattice(config: LatticeConfigInput, options?: LatticeOptions)
```

| Overload                                          | Description                                   |
| ------------------------------------------------- | --------------------------------------------- |
| `new Lattice('./app.db')`                         | Open a SQLite file at the given path          |
| `new Lattice(':memory:')`                         | In-memory database (useful for tests)         |
| `new Lattice({ config: './lattice.config.yml' })` | Read schema + DB path from a YAML config file |

**`LatticeOptions`**

```typescript
interface LatticeOptions {
  wal?: boolean; // WAL journal mode (default: true — recommended for concurrent reads)
  busyTimeout?: number; // SQLite busy_timeout in ms (default: 5000)
  security?: {
    sanitize?: boolean; // Strip control characters from string inputs (default: true)
    auditTables?: string[]; // Tables that emit 'audit' events on write
    fieldLimits?: Record<string, number>; // Max characters per named column
  };
}
```

```typescript
const db = new Lattice('./app.db', {
  wal: true,
  busyTimeout: 10_000,
  security: {
    sanitize: true,
    auditTables: ['users', 'credentials'],
    fieldLimits: { notes: 50_000, bio: 2_000 },
  },
});
```

---

### `define()`

```typescript
db.define(table: string, definition: TableDefinition): this
```

Register a table. Must be called before `init()`. Returns `this` for chaining.

**`TableDefinition`**

```typescript
interface TableDefinition {
  /** Column name → SQLite type spec */
  columns: Record<string, string>;

  /**
   * How rows become context text.
   * - A render function: (rows: Row[]) => string
   * - A built-in template name: 'default-list' | 'default-table' | 'default-detail' | 'default-json'
   * - A template spec with hooks: { template: BuiltinTemplateName, hooks?: RenderHooks }
   * Optional (v0.17+) — omit render and outputFile for schema-only tables.
   */
  render?: RenderSpec;

  /** Output file path, relative to the outputDir passed to render()/watch(). Optional (v0.17+). */
  outputFile?: string;

  /** Optional row filter applied before rendering */
  filter?: (rows: Row[]) => Row[];

  /**
   * Primary key column name or [col1, col2] for composite PKs.
   * Defaults to 'id'. When 'id' is the PK and the field is absent on insert,
   * a UUID v4 is generated automatically.
   * Composite PKs (v0.17+): auto-generates a PRIMARY KEY(...) constraint —
   * no need to add it manually via tableConstraints.
   */
  primaryKey?: string | string[];

  /** Additional SQL constraints (e.g., UNIQUE, CHECK). No longer required for composite PKs (v0.17+). */
  tableConstraints?: string[];

  /** Declared relationships used by template rendering */
  relations?: Record<string, Relation>;
}
```

**Basic example:**

```typescript
db.define('tasks', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    title: 'TEXT NOT NULL',
    status: 'TEXT DEFAULT "open"',
    due: 'TEXT',
  },
  render(rows) {
    const open = rows.filter((r) => r.status === 'open');
    return (
      `# Open Tasks (${open.length})\n\n` +
      open.map((r) => `- [ ] ${r.title}${r.due ? ` — due ${r.due}` : ''}`).join('\n')
    );
  },
  outputFile: 'TASKS.md',
});
```

**Custom primary key:**

```typescript
db.define('pages', {
  columns: {
    slug: 'TEXT NOT NULL',
    title: 'TEXT NOT NULL',
    content: 'TEXT',
  },
  primaryKey: 'slug', // <-- tell Lattice which column is the PK
  render: 'default-list',
  outputFile: 'pages.md',
});

// get/update/delete now use the slug value directly
const page = await db.get('pages', 'about-us');
await db.update('pages', 'about-us', { title: 'About' });
await db.delete('pages', 'about-us');
```

**Schema-only table (v0.17+):**

Tables without `render` and `outputFile` get full schema support (columns, indexes, constraints, CRUD) but produce no output files during `render()` or `watch()`. Useful for junction tables, internal tracking tables, or any table that doesn't need a context file.

```typescript
db.define('agent_skills', {
  columns: {
    agent_id: 'TEXT NOT NULL',
    skill_id: 'TEXT NOT NULL',
    proficiency: 'TEXT DEFAULT "basic"',
  },
  primaryKey: ['agent_id', 'skill_id'],
  // No render, no outputFile — schema-only
});
```

**Composite primary key:**

```typescript
db.define('event_seats', {
  columns: {
    event_id: 'TEXT NOT NULL',
    seat_no: 'INTEGER NOT NULL',
    holder: 'TEXT',
  },
  primaryKey: ['event_id', 'seat_no'],
  render: 'default-table',
  outputFile: 'seats.md',
});

// Pass a Record for get/update/delete
const seat = await db.get('event_seats', { event_id: 'evt-1', seat_no: 12 });
await db.update('event_seats', { event_id: 'evt-1', seat_no: 12 }, { holder: 'Alice' });
await db.delete('event_seats', { event_id: 'evt-1', seat_no: 12 });
```

**Relationship declarations:**

```typescript
db.define('comments', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    post_id: 'TEXT NOT NULL',
    author_id: 'TEXT NOT NULL',
    body: 'TEXT',
  },
  relations: {
    post: { type: 'belongsTo', table: 'posts', foreignKey: 'post_id' },
    author: { type: 'belongsTo', table: 'users', foreignKey: 'author_id' },
    // hasMany: the other table holds the FK
    likes: { type: 'hasMany', table: 'comment_likes', foreignKey: 'comment_id' },
  },
  render: {
    template: 'default-detail',
    hooks: { formatRow: '{{author.name}}: {{body}}' },
  },
  outputFile: 'comments.md',
});
```

---

### `defineMulti()`

```typescript
db.defineMulti(name: string, definition: MultiTableDefinition): this
```

Produces one output file per _anchor entity_ — useful for per-agent or per-project context files.

```typescript
db.defineMulti('agent-context', {
  // Returns the anchor entities (one file will be created per agent)
  keys: () => db.query('agents', { where: { active: 1 } }),

  // Derive the output file path from the anchor entity
  outputFile: (agent) => `agents/${agent.slug as string}/CONTEXT.md`,

  // Extra tables to query and pass into render
  tables: ['tasks', 'notes'],

  render(agent, { tasks, notes }) {
    const myTasks = tasks.filter((t) => t.assigned_to === agent.id);
    const myNotes = notes.filter((n) => n.agent_id === agent.id);
    return [
      `# ${agent.name} — context`,
      '',
      '## Pending tasks',
      myTasks.map((t) => `- ${t.title}`).join('\n') || '_none_',
      '',
      '## Notes',
      myNotes.map((n) => `- ${n.body}`).join('\n') || '_none_',
    ].join('\n');
  },
});
```

---

### `defineEntityContext()` (v0.5+)

```typescript
db.defineEntityContext(table: string, def: EntityContextDefinition): this
```

Generate a **parallel file-system tree** for an entity type — one subdirectory per row, one file per declared relationship, and an optional combined context file. Can be called before or after `init()`.

```typescript
db.defineEntityContext('agents', {
  // Derive the subdirectory name for each entity
  slug: (row) => row.slug as string,

  // Default query options for all relationship sources (v0.6+)
  sourceDefaults: { softDelete: true },

  // Global index file listing all entities
  index: {
    outputFile: 'agents/AGENTS.md',
    render: (rows) => `# Agents\n\n${rows.map((r) => `- ${r.name as string}`).join('\n')}`,
  },

  // Files inside each entity's directory
  files: {
    'AGENT.md': {
      source: { type: 'self' }, // entity's own row
      render: ([r]) => `# ${r.name as string}\n\n${(r.bio as string) ?? ''}`,
    },
    'TASKS.md': {
      source: {
        type: 'hasMany',
        table: 'tasks',
        foreignKey: 'agent_id',
        orderBy: 'created_at',
        orderDir: 'desc',
        limit: 20,
      },
      render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
      omitIfEmpty: true, // skip if no tasks
      budget: 4000, // truncate at 4 000 chars
    },
    'SKILLS.md': {
      source: {
        type: 'manyToMany',
        junctionTable: 'agent_skills',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skills',
        orderBy: 'name', // softDelete inherited from sourceDefaults
      },
      render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
      omitIfEmpty: true,
    },
  },

  // Concatenate all files into one combined context file per entity
  combined: { outputFile: 'CONTEXT.md', exclude: [] },

  // Files agents may write — Lattice never deletes these during cleanup
  protectedFiles: ['SESSION.md'],
});
```

**On each `render()` / `reconcile()` call this produces:**

```
context/
├── agents/
│   └── AGENTS.md               ← global index
├── agents/alpha/
│   ├── AGENT.md
│   ├── TASKS.md                ← omitted when empty
│   ├── SKILLS.md               ← omitted when empty
│   └── CONTEXT.md              ← AGENT.md + TASKS.md + SKILLS.md combined
└── agents/beta/
    ├── AGENT.md
    └── CONTEXT.md
```

**Source types:**

| Type                                                                           | What it queries                                                  |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `{ type: 'self' }`                                                             | The entity row itself                                            |
| `{ type: 'hasMany', table, foreignKey, ... }`                                  | Rows in `table` where `foreignKey = entityPk`                    |
| `{ type: 'manyToMany', junctionTable, localKey, remoteKey, remoteTable, ... }` | Remote rows via a junction table                                 |
| `{ type: 'belongsTo', table, foreignKey, ... }`                                | Single parent row via FK on this entity (`null` FK → empty)      |
| `{ type: 'enriched', include: { ... } }`                                       | Entity row + related data attached as `_key` JSON fields (v0.7+) |
| `{ type: 'custom', query: (row, adapter) => Row[] }`                           | Fully custom synchronous query                                   |

#### Source query options (v0.6+)

`hasMany`, `manyToMany`, and `belongsTo` sources accept optional query refinements:

```typescript
{
  type: 'hasMany',
  table: 'tasks',
  foreignKey: 'agent_id',
  // Query options (all optional):
  softDelete: true,          // exclude rows where deleted_at IS NULL
  filters: [                 // additional WHERE clauses (uses existing Filter type)
    { col: 'status', op: 'eq', val: 'active' },
  ],
  orderBy: 'created_at',    // ORDER BY column
  orderDir: 'desc',         // 'asc' (default) or 'desc'
  limit: 20,                // LIMIT N
}
```

The `softDelete: true` shorthand is equivalent to `filters: [{ col: 'deleted_at', op: 'isNull' }]`.

#### Junction column projection (v0.8+)

`manyToMany` sources can include columns from the junction table in results:

```typescript
{
  type: 'manyToMany',
  junctionTable: 'agent_projects',
  localKey: 'agent_id',
  remoteKey: 'project_id',
  remoteTable: 'projects',
  junctionColumns: [
    'source',                            // included as-is
    { col: 'role', as: 'agent_role' },   // aliased
  ],
}
// Each result row includes both remote table columns AND junction columns
```

#### Multi-column ORDER BY (v0.8+)

`orderBy` accepts an array for multi-column sorting:

```typescript
{
  type: 'hasMany',
  table: 'events',
  foreignKey: 'project_id',
  orderBy: [
    { col: 'severity' },                  // ASC by default
    { col: 'timestamp', dir: 'desc' },    // DESC
  ],
  limit: 20,
}
```

The string form (`orderBy: 'name'`) still works for single-column sorting.

#### sourceDefaults (v0.6+)

Set default query options for all relationship sources in an entity context:

```typescript
db.defineEntityContext('agents', {
  slug: (row) => row.slug as string,
  sourceDefaults: { softDelete: true }, // applied to all hasMany/manyToMany/belongsTo
  files: {
    'TASKS.md': {
      // softDelete: true is inherited from sourceDefaults
      source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id', orderBy: 'created_at' },
      render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
    },
  },
});
```

Per-file source options override defaults. `custom`, `self`, and `enriched` sources are unaffected.

#### Enriched source (v0.7+)

Starts with the entity's own row and attaches related data as JSON string fields. Each key in `include` becomes a `_key` field containing `JSON.stringify(resolvedRows)`.

```typescript
'PROFILE.md': {
  source: {
    type: 'enriched',
    include: {
      // Declarative sub-lookups (support all query options)
      skills:   { type: 'manyToMany', junctionTable: 'agent_skills',
                  localKey: 'agent_id', remoteKey: 'skill_id',
                  remoteTable: 'skills', softDelete: true },
      projects: { type: 'hasMany', table: 'projects', foreignKey: 'org_id',
                  softDelete: true, orderBy: 'name' },
      // Custom sub-lookup for complex queries
      stats:    { type: 'custom', query: (row, adapter) =>
                    adapter.all('SELECT COUNT(*) as cnt FROM events WHERE actor_id = ?', [row.id]) },
    },
  },
  render: ([row]) => {
    const skills = JSON.parse(row._skills as string);
    const projects = JSON.parse(row._projects as string);
    return `# ${row.name}\n\nSkills: ${skills.length}\nProjects: ${projects.length}`;
  },
}
```

#### Entity render templates (v0.9+)

`EntityFileSpec.render` accepts declarative template objects in addition to functions. Three built-in templates:

**entity-table** — heading + GFM table:

```typescript
render: {
  template: 'entity-table',
  heading: 'Skills',
  columns: [
    { key: 'name', header: 'Name' },
    { key: 'level', header: 'Level', format: (v) => String(v || '—') },
  ],
  emptyMessage: '*No skills assigned.*',
  beforeRender: (rows) => rows.filter(r => r.active),  // optional
}
```

**entity-profile** — heading + field-value pairs + enriched JSON sections:

```typescript
render: {
  template: 'entity-profile',
  heading: (r) => r.name as string,
  fields: [
    { key: 'status', label: 'Status' },
    { key: 'role', label: 'Role' },
  ],
  sections: [
    { key: 'skills', heading: 'Skills', render: 'table',
      columns: [{ key: 'name', header: 'Name' }] },
    { key: 'projects', heading: 'Projects', render: 'list',
      formatItem: (p) => `${p.name} (${p.status})` },
  ],
  frontmatter: (r) => ({ agent: r.name as string }),
}
```

**entity-sections** — per-row sections with metadata + body:

```typescript
render: {
  template: 'entity-sections',
  heading: 'Rules',
  perRow: {
    heading: (r) => r.title as string,
    metadata: [
      { key: 'scope', label: 'Scope' },
      { key: 'category', label: 'Category' },
    ],
    body: (r) => r.rule_text as string,
  },
  emptyMessage: '*No rules defined.*',
}
```

All templates auto-prepend a read-only header and YAML frontmatter. Functions still work — the union type is backward compatible.

See [docs/entity-context.md](./docs/entity-context.md) for the complete guide.

---

### `defineWriteHook()` (v0.10+)

```typescript
db.defineWriteHook(hook: WriteHook): this
```

Register a post-write lifecycle hook that fires after `insert()`, `update()`, or `delete()` operations. Useful for denormalization, fan-out, computed fields, and audit logging.

```typescript
db.defineWriteHook({
  table: 'agents',
  on: ['insert', 'update'],
  watchColumns: ['team_id', 'division'], // only fire when these change
  handler: (ctx) => {
    // ctx.table, ctx.op, ctx.row, ctx.pk, ctx.changedColumns
    console.log(`${ctx.op} on ${ctx.table}: ${ctx.pk}`);
    denormalizeRelatedData(ctx.pk, ctx.row);
  },
});
```

**Options:**

| Field          | Type                                      | Description                                    |
| -------------- | ----------------------------------------- | ---------------------------------------------- |
| `table`        | `string`                                  | Table to watch                                 |
| `on`           | `Array<'insert' \| 'update' \| 'delete'>` | Operations that trigger the hook               |
| `watchColumns` | `string[]` (optional)                     | Only fire on update when these columns changed |
| `handler`      | `(ctx: WriteHookContext) => void`         | Synchronous handler                            |

Hook errors are caught and routed to error handlers — they never crash the caller. Multiple hooks per table are supported.

---

### `defineWriteback()`

```typescript
db.defineWriteback(definition: WritebackDefinition): this
```

Register an agent-output file for parsing and DB ingestion. Lattice tracks file offsets and handles rotation (truncation) automatically.

```typescript
db.defineWriteback({
  // Path or glob to agent-written output files
  file: './context/agents/*/SESSION.md',

  parse(content, fromOffset) {
    // Parse new content since last read
    const newContent = content.slice(fromOffset);
    const entries = parseMarkdownItems(newContent);
    return { entries, nextOffset: content.length };
  },

  async persist(entry, filePath) {
    await db.insert('events', {
      source_file: filePath,
      ...(entry as Row),
    });
  },

  // Optional: skip entries with the same dedupeKey seen before
  dedupeKey: (entry) => (entry as { id: string }).id,
});
```

---

### Generic CRUD (v0.11+)

Methods that work on **any table** — including tables created via raw DDL (not `define()`). Uses PRAGMA introspection to discover columns at runtime.

```typescript
// Upsert by natural key (not just UUID). Auto-handles org_id, updated_at, deleted_at.
const id = await db.upsertByNaturalKey(
  'agents',
  'name',
  'Alice',
  {
    role: 'engineer',
    status: 'active',
  },
  { sourceFile: 'agents.md', orgId: 'org-1' },
);

// Sparse update — only writes non-null fields.
await db.enrichByNaturalKey('agents', 'name', 'Alice', { title: 'Senior Engineer' });

// Soft-delete records NOT in a set (reconciliation).
const deleted = await db.softDeleteMissing('agents', 'name', 'agents.md', ['Alice', 'Bob']);

// Query helpers
const agents = await db.getActive('agents', 'name');
const count = await db.countActive('agents');
const alice = await db.getByNaturalKey('agents', 'name', 'Alice');
```

### Junction table helpers (v0.11+)

```typescript
// Link (INSERT OR IGNORE — idempotent)
await db.link('agent_skills', { agent_id: 'a1', skill_id: 's1', proficiency: 'expert' });

// Link with upsert (INSERT OR REPLACE — updates existing)
await db.link(
  'agent_projects',
  { agent_id: 'a1', project_id: 'p1', role: 'lead' },
  { upsert: true },
);

// Unlink (DELETE matching rows)
await db.unlink('agent_projects', { agent_id: 'a1', project_id: 'p1' });
```

### `seed()` (v0.13+)

```typescript
db.seed(config: SeedConfig): Promise<SeedResult>
```

Bulk seed records from structured data (YAML, JSON, etc.). Upserts by natural key, links to related entities via junction tables, and optionally soft-deletes removed entries.

```typescript
import { parse } from 'yaml';
import { readFileSync } from 'fs';

const rules = parse(readFileSync('rules.yaml', 'utf8'));

await db.seed({
  data: rules,
  table: 'rules',
  naturalKey: 'title',
  sourceFile: 'rules.yaml',
  orgId: 'org-1',
  linkTo: {
    targetAgents: {
      junction: 'rule_agents',
      foreignKey: 'agent_id',
      resolveBy: 'name',
      resolveTable: 'agents',
    },
  },
  softDeleteMissing: true,
});
```

A junction link whose target row doesn't resolve is **never silently dropped**. `SeedResult.unresolvedLinks` lists every such link (source record, field, target name, junction). Pass `onUnresolvedLink: 'throw'` to abort with a `SeedReconciliationError` instead — for pipelines that must never leave a record citing a relationship that has no link in the graph:

```typescript
const result = await db.seed({ ...config, onUnresolvedLink: 'collect' });
if (result.unresolvedLinks.length) {
  // create the missing targets, then re-seed
  console.warn('unresolved links:', result.unresolvedLinks);
}
```

### `buildReport()` (v0.14+)

```typescript
db.buildReport(config: ReportConfig): Promise<ReportResult>
```

Declarative report builder — queries data within a time window, groups into sections, formats for output.

```typescript
const report = await db.buildReport({
  since: '8h', // or '24h', '7d', or ISO timestamp
  sections: [
    {
      name: 'tasks',
      query: { table: 'tasks', orderBy: 'created_at', orderDir: 'desc' },
      format: 'count_and_list',
    },
    { name: 'events', query: { table: 'activity', groupBy: 'type' }, format: 'counts' },
    {
      name: 'alerts',
      query: { table: 'activity', filters: [{ col: 'severity', op: 'lte', val: 2 }] },
      format: 'list',
    },
  ],
});

for (const section of report.sections) {
  console.log(`${section.name}: ${section.count} items`);
  console.log(section.formatted);
}
```

### Writeback persistence (v0.12+)

`WritebackDefinition` now accepts an optional `stateStore` for persistent offset/dedup tracking across restarts:

```typescript
import { createSQLiteStateStore } from 'latticesql';

db.defineWriteback({
  file: './agents/*/SESSION.md',
  stateStore: createSQLiteStateStore(db.db), // persists offsets in SQLite
  parse: (content, offset) => myParser(content, offset),
  persist: async (entry, filePath) => {
    /* ... */
  },
  dedupeKey: (entry) => entry.id,
  onArchive: (filePath) => archiveFile(filePath), // lifecycle hook
});
```

Built-in implementations: `InMemoryStateStore` (default), `SQLiteStateStore` (persistent).

---

### `init()` / `close()`

```typescript
await db.init(options?: InitOptions): Promise<void>
db.close(): void
```

`init()` opens the SQLite file, runs `CREATE TABLE IF NOT EXISTS` for all defined tables, and applies any migrations. Must be called once before any CRUD or render operations.

```typescript
await db.init({
  migrations: [
    { version: 1, sql: 'ALTER TABLE tasks ADD COLUMN due_date TEXT' },
    { version: 2, sql: 'ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0' },
  ],
});
```

Migrations are idempotent — each `version` number is applied exactly once, tracked in a `__lattice_migrations` internal table.

`close()` closes the SQLite connection. Call it when the process shuts down.

### `migrate()` (v0.17+)

```typescript
await db.migrate(migrations: Migration[]): Promise<void>
```

Run migrations after `init()`. Works exactly like `init({ migrations })` but callable any time — useful when migrations are loaded dynamically or added by plugins after startup.

```typescript
await db.init();

// Later — e.g., after loading a plugin that needs new columns
await db.migrate([
  { version: 'plugin-v1', sql: 'ALTER TABLE tasks ADD COLUMN tags TEXT' },
  { version: 'plugin-v2', sql: 'CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks (tags)' },
]);
```

`Migration.version` accepts `number | string` — use numbers for sequential migrations, or strings for named/namespaced versions (e.g., `'plugin-v1'`). Each version is applied at most once, tracked in the same `__lattice_migrations` table used by `init()`.

---

### CRUD operations

All CRUD methods return Promises and are safe to `await`.

#### `insert()`

```typescript
await db.insert(table: string, row: Row): Promise<string>
```

Insert a row. Returns the primary key value (as a string). For the default `id` column, a UUID is auto-generated when absent.

```typescript
const id = await db.insert('tasks', { title: 'Write docs', status: 'open' });
// id → 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

// With a custom PK — caller must supply the value
await db.insert('pages', { slug: 'about', title: 'About Us' });

// With explicit id
await db.insert('tasks', { id: 'task-001', title: 'Specific task' });
```

#### `insertReturning()` (v0.17+)

```typescript
await db.insertReturning(table: string, row: Row): Promise<Row>
```

Insert a row and get the full row back — including the auto-generated `id`, defaults, and any other columns. Equivalent to `insert()` + `get()` in a single call.

```typescript
const task = await db.insertReturning('tasks', { title: 'Write docs', status: 'open' });
// task → { id: 'f47ac10b-...', title: 'Write docs', status: 'open', priority: 0, ... }

// Useful when you need the generated id or default values immediately
const agent = await db.insertReturning('agents', { name: 'Gamma' });
console.log(agent.id); // auto-generated UUID
console.log(agent.active); // default value from schema
```

#### `upsert()`

```typescript
await db.upsert(table: string, row: Row): Promise<string>
```

Insert or update a row by primary key (`ON CONFLICT DO UPDATE`). All PK columns must be present in `row`.

```typescript
await db.upsert('tasks', { id: 'task-001', title: 'Updated title', status: 'done' });
```

#### `upsertBy()`

```typescript
await db.upsertBy(table: string, col: string, val: unknown, row: Row): Promise<string>
```

Upsert by an arbitrary column — looks up the row by `col = val`, updates if found, inserts if not. Useful for `email`-keyed users, `slug`-keyed posts, etc.

```typescript
await db.upsertBy('users', 'email', 'alice@example.com', { name: 'Alice' });
```

#### `update()`

```typescript
await db.update(table: string, id: PkLookup, row: Partial<Row>): Promise<void>
```

Update specific columns on an existing row.

```typescript
await db.update('tasks', 'task-001', { status: 'done' });

// Composite PK
await db.update('event_seats', { event_id: 'e-1', seat_no: 3 }, { holder: 'Bob' });
```

#### `updateReturning()` (v0.17+)

```typescript
await db.updateReturning(table: string, id: PkLookup, row: Partial<Row>): Promise<Row>
```

Update specific columns and get the full updated row back. Equivalent to `update()` + `get()` in a single call.

```typescript
const task = await db.updateReturning('tasks', 'task-001', { status: 'done' });
// task → { id: 'task-001', title: 'Write docs', status: 'done', priority: 3, ... }

// Composite PK
const seat = await db.updateReturning(
  'event_seats',
  { event_id: 'e-1', seat_no: 3 },
  { holder: 'Bob' },
);
// seat → { event_id: 'e-1', seat_no: 3, holder: 'Bob' }
```

#### `delete()`

```typescript
await db.delete(table: string, id: PkLookup): Promise<void>
```

```typescript
await db.delete('tasks', 'task-001');
await db.delete('event_seats', { event_id: 'e-1', seat_no: 3 });
```

#### `get()`

```typescript
await db.get(table: string, id: PkLookup): Promise<Row | null>
```

Fetch a single row by PK. Returns `null` if not found.

```typescript
const task = await db.get('tasks', 'task-001');
// { id: 'task-001', title: 'Write docs', status: 'open' } | null
```

#### `query()`

```typescript
await db.query(table: string, opts?: QueryOptions): Promise<Row[]>
```

```typescript
interface QueryOptions {
  where?: Record<string, unknown>; // Equality shorthand
  filters?: Filter[]; // Advanced operators (see below)
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}
```

```typescript
// Simple equality filter
const open = await db.query('tasks', { where: { status: 'open' } });

// Sorted + paginated
const page1 = await db.query('tasks', {
  where: { status: 'open' },
  orderBy: 'created_at',
  orderDir: 'desc',
  limit: 20,
  offset: 0,
});

// All rows
const all = await db.query('tasks');
```

#### `count()`

```typescript
await db.count(table: string, opts?: CountOptions): Promise<number>
```

```typescript
const n = await db.count('tasks', { where: { status: 'open' } });
```

---

### Query operators

The `filters` array supports operators beyond equality. `where` and `filters` are combined with `AND`.

```typescript
interface Filter {
  col: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'isNull' | 'isNotNull';
  val?: unknown; // not needed for isNull / isNotNull
}
```

**Examples:**

```typescript
// Comparison
const highPriority = await db.query('tasks', {
  filters: [{ col: 'priority', op: 'gte', val: 4 }],
});

// Pattern match
const search = await db.query('tasks', {
  filters: [{ col: 'title', op: 'like', val: '%refactor%' }],
});

// IN list
const active = await db.query('tasks', {
  filters: [{ col: 'status', op: 'in', val: ['open', 'in-progress'] }],
});

// NULL checks
const unassigned = await db.query('tasks', {
  filters: [{ col: 'assignee_id', op: 'isNull' }],
});

// Combine where + filters (ANDed)
const results = await db.query('tasks', {
  where: { project_id: 'proj-1' },
  filters: [
    { col: 'priority', op: 'gte', val: 3 },
    { col: 'deleted_at', op: 'isNull' },
  ],
  orderBy: 'priority',
  orderDir: 'desc',
});

// count() supports filters too
const n = await db.count('tasks', {
  filters: [{ col: 'status', op: 'ne', val: 'done' }],
});
```

---

### Render, sync, watch, and reconcile

#### `render()`

```typescript
await db.render(outputDir: string): Promise<RenderResult>
```

Render all tables to text files in `outputDir`. Files are written atomically (write to temp, rename). Files whose content hasn't changed are skipped.

```typescript
const result = await db.render('./context');
// { filesWritten: ['context/TASKS.md'], filesSkipped: 2, durationMs: 12 }
```

#### `sync()`

```typescript
await db.sync(outputDir: string): Promise<SyncResult>
```

`render()` + writeback pipeline in one call.

```typescript
const result = await db.sync('./context');
// { filesWritten: [...], filesSkipped: 0, durationMs: 18, writebackProcessed: 3 }
```

#### `watch()`

```typescript
await db.watch(outputDir: string, opts?: WatchOptions): Promise<StopFn>
```

Poll the DB every `interval` ms and re-render when content changes.

```typescript
const stop = await db.watch('./context', {
  interval: 5_000, // default: 5000 ms
  onRender: (r) => console.log('rendered', r.filesWritten.length, 'files'),
  onError: (e) => console.error('render error:', e.message),
});

// Stop the loop later
stop();
```

**With automatic orphan cleanup (v0.5+):**

```typescript
const stop = await db.watch('./context', {
  interval: 10_000,
  cleanup: {
    removeOrphanedDirectories: true, // delete dirs for deleted entities
    removeOrphanedFiles: true, // delete stale relationship files
    protectedFiles: ['SESSION.md'], // never delete these
    dryRun: false,
  },
  onCleanup: (r) => {
    if (r.directoriesRemoved.length > 0) {
      console.log('removed orphaned dirs:', r.directoriesRemoved);
    }
  },
});
```

#### `reconcile()` (v0.5+)

```typescript
await db.reconcile(outputDir: string, options?: ReconcileOptions): Promise<ReconcileResult>
```

One-shot reverse-sync + render + orphan cleanup. Reads the previous manifest, detects external file edits (reverse-sync), renders all tables and entity contexts (writing a new manifest), then removes orphaned directories and files.

**Reverse-sync (v0.16+):** If any `EntityFileSpec` defines a `reverseSync` function, Lattice detects files modified since the last render (via SHA-256 hashes in the manifest) and sweeps those changes back into the database before re-rendering. See [docs/entity-context.md](./docs/entity-context.md#reverse-sync-v016).

```typescript
const result = await db.reconcile('./context', {
  removeOrphanedDirectories: true,
  removeOrphanedFiles: true,
  protectedFiles: ['SESSION.md'],
  reverseSync: true, // default; set false to skip, 'dry-run' to preview
  dryRun: false, // set true to preview without deleting
  onOrphan: (path, kind) => console.log(`would remove ${kind}: ${path}`),
});

console.log(result.filesWritten); // files written this cycle
console.log(result.cleanup.directoriesRemoved); // orphaned dirs removed
console.log(result.cleanup.warnings); // dirs left in place (user files)
console.log(result.reverseSync); // { filesScanned, filesChanged, updatesApplied, errors }
```

`ReconcileResult` extends `RenderResult` with `cleanup` and `reverseSync` fields:

```typescript
interface ReconcileResult {
  filesWritten: string[];
  filesSkipped: number;
  durationMs: number;
  cleanup: {
    directoriesRemoved: string[];
    filesRemoved: string[];
    directoriesSkipped: string[];
    warnings: string[];
  };
  reverseSync: {
    filesScanned: number;
    filesChanged: number;
    updatesApplied: number;
    errors: Array<{ file: string; error: string }>;
  } | null;
}
```

---

### Events

```typescript
db.on('audit',     ({ table, operation, id, timestamp }) => void)
db.on('render',    ({ filesWritten, filesSkipped, durationMs }) => void)
db.on('writeback', ({ filePath, entriesProcessed }) => void)
db.on('error',     (err: Error) => void)
```

`audit` events fire on every insert/update/delete for tables listed in `security.auditTables`. Use them to build an audit log.

```typescript
db.on('audit', ({ table, operation, id, timestamp }) => {
  console.log(`[AUDIT] ${operation} on ${table}#${id} at ${timestamp}`);
});
```

---

### Raw DB access

```typescript
db.db: Database.Database  // better-sqlite3 instance
```

Escape hatch for queries Lattice doesn't cover (JOINs, aggregates, etc.):

```typescript
const rows = db.db
  .prepare(
    `
  SELECT t.*, u.name AS assignee_name
  FROM tasks t
  LEFT JOIN users u ON u.id = t.assignee_id
  WHERE t.status = ?
`,
  )
  .all('open');
```

---

### Context optimization (v1.3+)

Lattice provides several options on `TableDefinition` to optimize what gets rendered into context files.

#### Token budget

Limit the token count of rendered output. When content exceeds the budget, rows are pruned by priority:

```typescript
db.define('tickets', {
  columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', updated_at: 'TEXT' },
  render: (rows) => rows.map((r) => `- ${r.title}`).join('\n'),
  outputFile: 'TICKETS.md',
  tokenBudget: 4000, // max estimated tokens (~4 chars/token)
  prioritizeBy: 'updated_at', // keep most recent rows when pruning
});
```

A truncation footer is appended: `[truncated: 47 of 123 rows rendered, ~3800 tokens]`

#### Relevance filtering

Dynamically filter rows based on a task context string:

```typescript
db.define('knowledge', {
  columns: { id: 'TEXT PRIMARY KEY', topic: 'TEXT', body: 'TEXT' },
  render: (rows) => rows.map((r) => `## ${r.topic}\n${r.body}`).join('\n\n'),
  outputFile: 'KNOWLEDGE.md',
  relevanceFilter: (row, ctx) =>
    ctx ? String(row.body).toLowerCase().includes(ctx.toLowerCase()) : true,
});

// Set the current task context — only matching rows are rendered
db.setTaskContext('deployment');
await db.render('./context');
```

#### Enrichment pipeline

Transform rows between filtering and rendering — add computed fields, cluster, summarize:

```typescript
db.define('incidents', {
  columns: { id: 'TEXT PRIMARY KEY', severity: 'TEXT', title: 'TEXT', created_at: 'TEXT' },
  render: (rows) => JSON.stringify(rows, null, 2),
  outputFile: 'incidents.json',
  enrich: [
    (rows) =>
      rows.map((r) => ({
        ...r,
        _age_hours: Math.round((Date.now() - new Date(r.created_at as string).getTime()) / 3600000),
      })),
    (rows) => (rows.length > 100 ? [{ _summary: `${rows.length} incidents` }] : rows),
  ],
});
```

#### Reward-scored memory

Track which data is useful. High-reward rows are prioritized in rendering; low-scoring rows can be auto-pruned:

```typescript
db.define('tips', {
  columns: { id: 'TEXT PRIMARY KEY', tip: 'TEXT', deleted_at: 'TEXT' },
  render: (rows) => rows.map((r) => `- ${r.tip}`).join('\n'),
  outputFile: 'TIPS.md',
  rewardTracking: true, // auto-adds _reward_total, _reward_count columns
  pruneBelow: 0.3, // soft-delete rows with reward < 0.3 (requires deleted_at column)
});

await db.init();
const id = await db.insert('tips', { tip: 'Use batch inserts for bulk data' });

// After the agent confirms this tip was useful:
await db.reward('tips', id, { relevance: 0.9, accuracy: 1.0 });
```

### Semantic search (v1.3+)

Enable embedding-based search on any table. Bring your own embedding function:

```typescript
db.define('docs', {
  columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT' },
  render: (rows) => rows.map((r) => `## ${r.title}\n${r.body}`).join('\n\n---\n\n'),
  outputFile: 'DOCS.md',
  embeddings: {
    fields: ['title', 'body'],
    embed: async (text) => {
      const res = await openai.embeddings.create({ input: text, model: 'text-embedding-3-small' });
      return res.data[0].embedding;
    },
  },
});

await db.init();
await db.insert('docs', { title: 'Deploy guide', body: 'How to deploy to production...' });

// Search by meaning, not keywords
const results = await db.search('docs', 'ship to prod', { topK: 5, minScore: 0.7 });
for (const { row, score } of results) {
  console.log(`${score.toFixed(2)} — ${row.title}`);
}
```

Embeddings are stored in a companion SQLite table and cosine similarity is computed in JS — no external vector database required.

### Writeback validation (v1.3+)

Validate agent-written data before persisting. Reject low-quality or hallucinated writes:

```typescript
db.defineWriteback({
  file: './agent-output/*.md',
  parse: (content, offset) => ({ entries: [content.slice(offset)], nextOffset: content.length }),
  persist: async (entry) => {
    /* save to DB */
  },
  validate: async (entry) => {
    const text = entry as string;
    const hasRequiredFields = text.includes('## Title') && text.includes('## Body');
    return {
      pass: hasRequiredFields,
      score: hasRequiredFields ? 0.9 : 0.1,
      reason: hasRequiredFields ? undefined : 'Missing required sections',
    };
  },
  rejectBelow: 0.5,
  onReject: (entry, result) => {
    console.warn(`Rejected write: ${result.reason} (score: ${result.score})`);
  },
});
```

---

## Template rendering

### Built-in templates

Pass a `BuiltinTemplateName` string as `render` to use a built-in template without writing a render function:

```typescript
db.define('users', {
  columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', email: 'TEXT', role: 'TEXT' },
  render: 'default-table', // or 'default-list' | 'default-detail' | 'default-json'
  outputFile: 'USERS.md',
});
```

| Template         | Output                                              |
| ---------------- | --------------------------------------------------- |
| `default-list`   | One bullet per row: `- key: value, key: value, ...` |
| `default-table`  | GitHub-flavoured Markdown table with a header row   |
| `default-detail` | `## <pk>` section per row with `key: value` body    |
| `default-json`   | `JSON.stringify(rows, null, 2)`                     |

All templates return empty string for zero rows.

---

### Lifecycle hooks

Add a `hooks` object to customise any built-in template:

```typescript
db.define('tasks', {
  columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT', priority: 'INTEGER' },
  render: {
    template: 'default-list',
    hooks: {
      // Transform or filter rows before rendering
      beforeRender: (rows) =>
        rows
          .filter((r) => r.status !== 'done')
          .sort((a, b) => (b.priority as number) - (a.priority as number)),

      // Customise how each row becomes a line
      formatRow: '{{title}} [priority {{priority}}]',
    },
  },
  outputFile: 'TASKS.md',
});
```

| Hook                 | Applies to                       | Type                               |
| -------------------- | -------------------------------- | ---------------------------------- |
| `beforeRender(rows)` | All templates                    | `(rows: Row[]) => Row[]`           |
| `formatRow`          | `default-list`, `default-detail` | `((row: Row) => string) \| string` |

`formatRow` can be a function or a `{{field}}` template string. When it's a string, `belongsTo` relation fields are resolved and available as `{{relationName.field}}`.

---

### Field interpolation

Any `formatRow` string supports `{{field}}` tokens with dot-notation for related rows:

```typescript
db.define('users', {
  columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', team: 'TEXT' },
  render: 'default-list',
  outputFile: 'USERS.md',
});

db.define('tickets', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    title: 'TEXT',
    assignee_id: 'TEXT',
    status: 'TEXT',
  },
  relations: {
    assignee: { type: 'belongsTo', table: 'users', foreignKey: 'assignee_id' },
  },
  render: {
    template: 'default-list',
    hooks: {
      formatRow: '{{title}} → {{assignee.name}} ({{status}})',
    },
  },
  outputFile: 'TICKETS.md',
});
// Output line: "- Fix login → Alice (open)"
```

**Rules:**

- `{{field}}` — value of `field` in the current row
- `{{relation.field}}` — value of `field` in the related row (resolved via `belongsTo`)
- Unknown paths, `null`, and `undefined` all render as empty string
- Non-string values are coerced with `String()`
- Leading/trailing whitespace in token names is trimmed: `{{ name }}` works

---

## Markdown utilities (v0.6+)

Composable helper functions for building render functions. Use inside `render: (rows) => ...` callbacks to reduce boilerplate.

### `frontmatter(fields)`

Generate a YAML-style frontmatter block. Automatically includes `generated_at` with the current ISO timestamp.

```typescript
import { frontmatter } from 'latticesql';

const header = frontmatter({ agent: 'Alice', skill_count: 5 });
// ---
// generated_at: "2026-03-27T..."
// agent: "Alice"
// skill_count: 5
// ---
```

### `markdownTable(rows, columns)`

Generate a GitHub-Flavoured Markdown table from rows with explicit column configuration and optional per-cell formatters.

```typescript
import { markdownTable } from 'latticesql';

const md = markdownTable(rows, [
  { key: 'name', header: 'Name' },
  { key: 'status', header: 'Status', format: (v) => String(v || '—') },
  { key: 'name', header: 'Detail', format: (v, row) => `[view](${row.slug}/DETAIL.md)` },
]);
// | Name | Status | Detail |
// | --- | --- | --- |
// | Alice | active | [view](alice/DETAIL.md) |
```

Returns empty string for zero rows. The `format` callback receives `(cellValue, fullRow)`.

### `slugify(name)`

Generate a URL-safe slug from a display name — lowercases, strips diacritics, replaces non-alphanumeric runs with hyphens.

```typescript
import { slugify } from 'latticesql';

slugify('My Agent Name'); // 'my-agent-name'
slugify('Jose Garcia'); // 'jose-garcia'
```

### `truncate(content, maxChars, notice?)`

Truncate content at a character budget. Appends a notice when truncation occurs.

```typescript
import { truncate } from 'latticesql';

const md = truncate(longContent, 4000);
// Appends: "\n\n*[truncated — context budget exceeded]*"

const md2 = truncate(longContent, 4000, '\n\n[...truncated]');
// Custom notice
```

---

## Entity context directories (v0.5+)

`defineEntityContext()` is the high-level API for per-entity file generation — the pattern where each entity type gets its own directory tree, with a separate file for each relationship type.

### Why use it instead of `defineMulti()`?

`defineMulti()` produces one file per anchor entity but you manage queries yourself. `defineEntityContext()` declares the _structure_ — which tables to pull, how to render them, what budget to enforce — and Lattice handles all the querying, directory creation, hash-skip deduplication, and orphan cleanup.

### Minimal example

```typescript
db.defineEntityContext('projects', {
  slug: (r) => r.slug as string,
  files: {
    'PROJECT.md': {
      source: { type: 'self' },
      render: ([r]) => `# ${r.name as string}\n\n${(r.description as string) ?? ''}`,
    },
  },
});
```

After `db.render('./ctx')` this creates:

```
ctx/
└── projects/
    ├── my-project/
    │   └── PROJECT.md
    └── another-project/
        └── PROJECT.md
```

### Lifecycle — orphan cleanup

When you delete an entity from the database the old directory becomes an orphan. Use `reconcile()` to clean it up:

```typescript
await db.delete('projects', 'old-id');

const result = await db.reconcile('./ctx', {
  removeOrphanedDirectories: true,
  protectedFiles: ['NOTES.md'], // agents wrote these — keep them
});
// result.cleanup.directoriesRemoved → ['/.../ctx/projects/old-project']
```

Lattice writes a `.lattice/manifest.json` inside `outputDir` after every render cycle — this is what `reconcile()` uses to know which directories it owns and what it previously wrote in each.

### Protected files

Declare files that agents write inside entity directories. Lattice will never delete them during cleanup:

```typescript
db.defineEntityContext('agents', {
  slug: (r) => r.slug as string,
  protectedFiles: ['SESSION.md', 'NOTES.md'],
  files: {
    /* ... */
  },
});
```

If an entity is deleted and its directory still contains `SESSION.md`, Lattice removes only its own managed files, leaves the directory in place, and adds a warning to `CleanupResult.warnings`.

### Reading the manifest

```typescript
import { readManifest } from 'latticesql';

const manifest = readManifest('./ctx');
// manifest?.entityContexts.agents.entities['alpha']
// → ['AGENT.md', 'TASKS.md', 'CONTEXT.md']  (files written last cycle for agent 'alpha')
```

### Protected entity contexts (v0.18+)

Mark an entity context as `protected: true` to prevent its data from leaking into other entities' context files:

```typescript
db.defineEntityContext('agents', {
  slug: (r) => r.slug,
  protected: true,  // Other entity contexts cannot pull agent data
  files: { ... },
});
```

Protected entities render their own files normally, but sources from other entities referencing a protected table return empty results.

### At-rest encryption (v0.18+)

Enable transparent AES-256-GCM encryption on entity context columns:

```typescript
const db = new Lattice('./secrets.db', { encryptionKey: 'master-key' });

db.defineEntityContext('secrets', {
  slug: (r) => r.name,
  protected: true,
  encrypted: { columns: ['value'] },  // or true for all text columns
  files: { ... },
});
```

See [docs/entity-context.md](./docs/entity-context.md) for the complete reference.

---

## SESSION.md write pattern

When agents run in a directory-based context system (e.g., one directory per agent with generated Markdown files), SESSION.md provides a **safe write interface** that enforces a clean read/write separation:

```
READ:  Lattice DB → render() → object MDs (READ ONLY for agents)
WRITE: Agent → SESSION.md → processor → validates → Lattice DB
```

All generated context files carry a read-only header so agents know not to edit them directly. SESSION.md is the only writable file in the directory.

### Write entry format

```
---
id: 2026-03-25T10:30:00Z-agent-abc123
type: write
timestamp: 2026-03-25T10:30:00Z
op: update
table: agents
target: agent-id-here
reason: Updating status after deployment completed.
---
status: active
last_task: api-deploy
===
```

| Header      | Required          | Description                         |
| ----------- | ----------------- | ----------------------------------- |
| `type`      | Yes               | Must be `write`                     |
| `timestamp` | Yes               | ISO 8601                            |
| `op`        | Yes               | `create`, `update`, or `delete`     |
| `table`     | Yes               | Target table name                   |
| `target`    | For update/delete | Record primary key                  |
| `reason`    | Encouraged        | Human-readable reason (audit trail) |

**Body**: `key: value` pairs — one field per line. Field names are validated against the table schema before any write is applied.

### Library support

`latticesql` exports a parser for the SESSION.md write format:

```ts
import { parseSessionWrites } from 'latticesql';

const result = parseSessionWrites(sessionFileContent);
// result.entries: SessionWriteEntry[]
// result.errors:  Array<{ line: number; message: string }>

for (const entry of result.entries) {
  console.log(entry.op, entry.table, entry.target, entry.fields);
}
```

**`SessionWriteEntry`:**

```ts
interface SessionWriteEntry {
  id: string; // content-addressed ID
  timestamp: string; // ISO 8601
  op: 'create' | 'update' | 'delete';
  table: string;
  target?: string; // required for update/delete
  reason?: string;
  fields: Record<string, string>; // empty for delete
}
```

The processor is responsible for applying the parsed entries to your DB and validating field names against your schema. The `parseSessionWrites` function is pure — no DB access, no side effects.

### Full session parser (v0.5.2+)

For parsing **all** entry types (not just writes), use `parseSessionMD`:

```ts
import { parseSessionMD, parseMarkdownEntries } from 'latticesql';

// Parse YAML-delimited entries (--- header --- body ===)
const result = parseSessionMD(content, startOffset);
// result.entries: SessionEntry[]  — all types: event, learning, status, write, etc.
// result.errors:  ParseError[]
// result.lastOffset: number       — for incremental parsing

// Parse markdown heading entries (## timestamp — description)
const mdResult = parseMarkdownEntries(content, 'agent-name', startOffset);
```

#### Configurable entry types (v0.5.5+)

By default, the parser validates against a built-in set of entry types. Override via `SessionParseOptions`:

```ts
import { parseSessionMD, DEFAULT_ENTRY_TYPES, DEFAULT_TYPE_ALIASES } from 'latticesql';

// Accept any type (no validation)
parseSessionMD(content, 0, { validTypes: null });

// Custom type set
parseSessionMD(content, 0, {
  validTypes: new Set(['alert', 'todo', 'write']),
  typeAliases: { warning: 'alert', task: 'todo' },
});
```

### Read-only header (v0.5.5+)

All generated context files should carry a read-only header. Use the default or create a custom one:

```ts
import { READ_ONLY_HEADER, createReadOnlyHeader } from 'latticesql';

// Default: "generated by Lattice"
const header = READ_ONLY_HEADER;

// Custom generator name and docs reference
const custom = createReadOnlyHeader({
  generator: 'my-sync-tool',
  docsRef: 'https://example.com/docs/sessions',
});
```

### Write applicator (v0.5.2+)

Apply parsed write entries to a better-sqlite3 database with schema validation:

```ts
import { applyWriteEntry } from 'latticesql';

const result = applyWriteEntry(db, writeEntry);
if (result.ok) {
  console.log(`Applied to ${result.table}, record ${result.recordId}`);
} else {
  console.error(result.reason);
}
```

Validates table existence, field names against schema, and uses soft-delete when a `deleted_at` column exists.

---

## YAML config (v0.4+)

Define your entire schema in a YAML file. Lattice reads it at construction time, creates all tables on `init()`, and wires render functions automatically.

### `lattice.config.yml` reference

```yaml
# Path to the SQLite database file (relative to this config file)
db: ./data/app.db

entities:
  # ── Entity name = table name ──────────────────────────────────────────────
  user:
    fields:
      id: { type: uuid, primaryKey: true } # auto-UUID on insert
      name: { type: text, required: true } # NOT NULL
      email: { type: text } # nullable
      score: { type: integer, default: 0 } # DEFAULT 0
    render: default-table
    outputFile: context/USERS.md

  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
      status: { type: text, default: open }
      priority: { type: integer, default: 1 }
      assignee_id: { type: uuid, ref: user } # creates belongsTo relation
    render:
      template: default-list
      formatRow: '{{title}} ({{status}}) — {{assignee.name}}'
    outputFile: context/TICKETS.md
```

**Field types**

| YAML type  | SQLite type | TypeScript type |
| ---------- | ----------- | --------------- |
| `uuid`     | TEXT        | `string`        |
| `text`     | TEXT        | `string`        |
| `integer`  | INTEGER     | `number`        |
| `int`      | INTEGER     | `number`        |
| `real`     | REAL        | `number`        |
| `float`    | REAL        | `number`        |
| `boolean`  | INTEGER     | `boolean`       |
| `bool`     | INTEGER     | `boolean`       |
| `datetime` | TEXT        | `string`        |
| `date`     | TEXT        | `string`        |
| `blob`     | BLOB        | `Buffer`        |

**Field options**

| Option       | Type               | Description                                                                                                                                           |
| ------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`       | `LatticeFieldType` | Column data type (required)                                                                                                                           |
| `primaryKey` | boolean            | Primary key column (`TEXT PRIMARY KEY` for uuid/text)                                                                                                 |
| `required`   | boolean            | `NOT NULL` constraint                                                                                                                                 |
| `default`    | string/number/bool | SQL `DEFAULT` value                                                                                                                                   |
| `ref`        | string             | Foreign-key reference to another entity. Creates a `belongsTo` relation; `_id` suffix is stripped from the relation name (`assignee_id` → `assignee`) |

**Entity-level options**

| Option       | Type                       | Description                                                        |
| ------------ | -------------------------- | ------------------------------------------------------------------ |
| `fields`     | `Record<string, FieldDef>` | Column definitions (required)                                      |
| `render`     | string or object           | Built-in template name, or `{ template, formatRow }`               |
| `outputFile` | string                     | Render output path (relative to config file)                       |
| `primaryKey` | string or string[]         | Override PK — takes precedence over field-level `primaryKey: true` |

**Render spec forms in YAML:**

```yaml
# String form — plain BuiltinTemplateName
render: default-table

# Object form — template + formatRow hook
render:
  template: default-list
  formatRow: "{{title}} ({{status}})"
```

---

### Init from config

```typescript
import { Lattice } from 'latticesql';

const db = new Lattice({ config: './lattice.config.yml' });
await db.init();

// All entities are available immediately
await db.insert('user', { name: 'Alice', email: 'alice@example.com' });
await db.insert('ticket', { title: 'Fix login', assignee_id: 'u-1' });

const tickets = await db.query('ticket', { where: { status: 'open' } });
await db.render('./context');
```

The `{ config }` constructor reads the YAML file synchronously, extracts the `db` path, and calls `define()` for each entity. It is exactly equivalent to:

```typescript
// Equivalent manual setup (no YAML)
const db = new Lattice('./data/app.db');
db.define('user', { columns: { ... }, render: 'default-table', outputFile: '...' });
db.define('ticket', { columns: { ... }, render: { ... }, outputFile: '...' });
await db.init();
```

---

### Config API (programmatic)

Parse a config file or string without constructing a Lattice instance:

```typescript
import { parseConfigFile, parseConfigString } from 'latticesql';

// From a file (throws on missing/invalid file or YAML parse error)
const { dbPath, tables } = parseConfigFile('./lattice.config.yml');

// From a YAML string — configDir is used to resolve relative outputFile paths
const { tables } = parseConfigString(yamlContent, '/project/root');

// Wire into any Lattice instance manually
const db = new Lattice(':memory:');
for (const { name, definition } of tables) {
  db.define(name, definition);
}
await db.init();
```

`ParsedConfig`:

```typescript
interface ParsedConfig {
  dbPath: string; // Absolute path to the SQLite file
  tables: ReadonlyArray<{ name: string; definition: TableDefinition }>;
}
```

---

## CLI — `lattice generate`

Generate TypeScript interfaces, an initial SQL migration file, and optional scaffold files from a YAML config.

```bash
npx lattice generate

# With options
npx lattice generate --config ./lattice.config.yml --out ./generated --scaffold
```

**Options**

| Flag                  | Default                | Description                                                                  |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `--config, -c <path>` | `./lattice.config.yml` | Path to the config file                                                      |
| `--out, -o <dir>`     | `./generated`          | Output directory                                                             |
| `--scaffold`          | off                    | Create empty files at each entity's `outputFile` path (skips existing files) |
| `--help, -h`          | —                      | Show help                                                                    |
| `--version, -v`       | —                      | Print version                                                                |

**Output structure**

```
generated/
├── types.ts               # TypeScript interface per entity
└── migrations/
    └── 0001_initial.sql   # CREATE TABLE IF NOT EXISTS statements
```

**Example output — `generated/types.ts`:**

```typescript
// Auto-generated by `lattice generate`. Do not edit manually.

export interface User {
  id: string;
  name: string; // required: true → no ?
  email?: string;
  score?: number;
}

export interface Ticket {
  id: string;
  title: string;
  status?: string;
  priority?: number;
  assignee_id?: string; // → user
}
```

**Example output — `generated/migrations/0001_initial.sql`:**

```sql
-- Auto-generated by `lattice generate`. Do not edit manually.

CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "score" INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "ticket" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "status" TEXT DEFAULT 'open',
  "priority" INTEGER DEFAULT 1,
  "assignee_id" TEXT
);
```

---

## CLI — `lattice gui` (v1.11+)

Start a local-only browser GUI for exploring and editing the data in a Lattice database. The server binds to `127.0.0.1` and delegates straight to the same `Lattice` CRUD methods you call from code — no separate state, no schema duplication.

```bash
npx lattice gui

# With options
npx lattice gui --config ./lattice.config.yml --output ./context --port 4317
```

### File-system workspace (v2.0+)

By default the GUI is a **file-system-style workspace**. The home dashboard shows
one card per object; clicking in opens that object's rows as a grid of **folder
tiles** rather than a spreadsheet. Click a tile to open an **item view** that
renders the row as a document built from its columns — long-form fields render as
formatted markdown — alongside that row's relationships as **sub-folders** you can
keep opening (e.g. _Authors → a person → Books → a book → Reviews_). A breadcrumb
trail tracks the drill path. **Click any value to edit it in place** — the change
saves immediately via `PATCH` and is undoable. Native `files` rows show the inline
file/markdown preview; their binary metadata stays read-only.

Relationships come from the schema: a `belongsTo` (a field with `ref:`) renders as
a parent link, while the reverse side (other entities that point here) plus
many-to-many junctions become the drill-in sub-folders. Declare `ref:` on your
foreign-key fields to get the nested file tree.

The header carries the logo, undo/redo, the **workspace switcher**, and a
**settings gear** (top-right). The gear opens a slide-over drawer with **Workspace**,
**Lattice**, and **User** settings plus an **Advanced mode** toggle. Turn Advanced
mode on to switch the object/row views back to the classic editable **table + row**
interface (below); turn it off for the file-system workspace. The left sidebar is
slim and collapsible. The assistant rail is unchanged in either mode.

**One workspace model (v1.16.4+).** A workspace _is_ a Lattice DB. The header has a
single workspace switcher listing every database — local or cloud, created or joined —
and its "+ New workspace…" button opens the create/join wizard (New local / New cloud /
Join existing cloud). The GUI always operates inside a `.lattice` root: opening a bare
config adopts it (and its database, referenced in place — nothing is moved) as the
active workspace. There is no separate "database mode". The word "database" is reserved
for a specific workspace's connection details (the connection panel in Workspace
Settings). This applies to the GUI/CLI app only — the `latticesql` library API and the
headless `render`/`generate`/`watch` commands still run against a bare config or
Postgres URL with no root.

### Assistant sidebar (v2.0+)

The GUI has a fixed right sidebar with a live **activity feed** — every change
(yours, the assistant's, or an ingest) streams in as it happens.

Add a Claude API token in **User Settings → Assistant** (or set
`ANTHROPIC_API_KEY`) to enable the **AI assistant**: ask questions about your
data or instruct edits in natural language. The assistant calls the same
operations the UI does, so its changes are audited, shown in the feed, and
undoable. A Claude subscription can be connected instead via OAuth when the
`ANTHROPIC_OAUTH_*` environment variables are configured.

Optional extras, each enabled by its own key/binary:

- **Voice** — set an OpenAI (Whisper) or ElevenLabs key to dictate into the composer.
- **File ingest** — reference a local file or paste text; it becomes a row in the
  native `files` entity with extracted text + (with a Claude key) an
  LLM-written description and links to related records. PDFs/office docs use the
  optional [`markitdown`](https://github.com/microsoft/markitdown) CLI when installed.

Chat threads, files, and secrets are all stored as native Lattice entities.

**Options**

| Flag                  | Default                | Description                                              |
| --------------------- | ---------------------- | -------------------------------------------------------- |
| `--config, -c <path>` | `./lattice.config.yml` | Path to the config file                                  |
| `--output <dir>`      | (auto-detected)        | Output directory containing rendered context — see below |
| `--port <number>`     | `4317`                 | Localhost port; auto-increments when the port is busy    |
| `--no-open`           | off                    | Print the URL without opening a browser                  |

**Output-directory auto-detection (v1.13.1+).** When `--output` is not passed explicitly, the GUI probes `./context`, `.`, and `./generated` in order and uses the first directory containing a `.lattice/manifest.json` (announced via a one-line `auto-detected rendered context at "<dir>"` log on stdout). Projects whose `lattice render` writes into the project root no longer need to pass `--output .` every time. An explicit `--output` is always honoured.

**Entity-context discovery (v1.13.1+).** The Database panel's row-context viewer reads entity contexts from two layered sources so it works regardless of how you register them:

1. **Live Lattice schema** — anything declared in `lattice.config.yml` or added programmatically via `db.defineEntityContext()` against the active Lattice. Exposed via the new public `Lattice.entityContexts()` accessor.
2. **Render manifest fallback** — when a table has no schema-registered entity context but the on-disk `.lattice/manifest.json` names it (typical for projects that register entity contexts in a JS / TS module like `lattice.schema.mjs` that the GUI process never imports), the GUI derives the row → slug mapping heuristically from `row.slug` / `row.id` / `row.name` and surfaces the rendered files anyway.

The convergence means you don't need to duplicate entity-context definitions in YAML for the GUI to find rendered files.

**Database wizard form (v1.13.2+).** The Postgres connection form (used by Migrate to cloud + the Join-a-team invite flow) disables browser autocapitalize, autocorrect, and spellcheck on every text input, and trims whitespace on every read. This avoids silent failure modes where macOS Safari / iOS turned a Supabase tenant user `postgres.<ref>` into `Postgres.<ref>` on submit, and where pasted credentials carrying a trailing newline produced opaque "zero-length delimiter identifier" or SCRAM-mismatch errors. `probeCloud` also folds SQLSTATE + `routine` into `result.error` so the GUI's "Unreachable: …" surface is actionable.

**Migrate vs. join (1.16.4).** The standalone "Connect to existing cloud" wizard (which switched a project's `db:` line to a raw cloud on its own) was removed — the two cloud operations are now **Migrate to cloud** (push your local workspace's data into a fresh cloud Postgres; you become the owner) and **Join a team (invite)** (redeem an invite token to join a workspace someone shared with you). The `connect-existing` endpoint still backs the invite‑redeem path for an active cloud that needs an invite.

**Cloud workspaces initialize automatically (v1.16.3+).** A cloud database _is_ a cloud workspace with members — there is no separate "upgrade to team" step. The moment a database is migrated or connected to Postgres, its member/share machinery is created automatically (the workspace name is used as the identity; an existing un-initialized cloud initializes on open, with the opener as owner). The underlying mechanism is the `registerDirectViaPostgres()` helper, which drives the identity/member INSERT sequence directly against the cloud Postgres (the older HTTP `/api/auth/register` path is still used when the cloud URL is `http(s)://`). The standalone "Upgrade to team cloud" action and its `/api/dbconfig/upgrade-to-team` route were removed in 1.16.3.

**Dashboard renders every entity (v1.13.3+).** Previously the dashboard cards filtered through a hardcoded entity list (`meetings`, `people`, `messages`, `projects`, `repositories`, `files`). Installs whose YAML declared different names saw a blank dashboard. Now every first-class entity gets a card; the hardcoded list survives as an ordering preference only.

**Approximate row counts on Postgres (v1.14.1+).** The dashboard / entity-list view reads row counts from `pg_class.reltuples` (the planner statistic maintained by `ANALYZE` / autovacuum) so that a single query covers every table. Older versions issued one `COUNT(*)` per table in parallel, which exhausted small connection pools (e.g. a 95-table database against Supabase's 15-slot session pooler). The trade is that list-view counts are approximate and include soft-deleted rows for tables that have a `deleted_at` column; per-table drill-in still shows exact filtered counts. SQLite-backed installs are unaffected and continue to show exact, soft-delete-aware counts (no pool to exhaust).

**Views**

- **Dashboard** (`#/`) — one card per first-class entity with live row counts.
- **Workspace / folder grid** (`#/fs/<entity>`, default mode, v2.0+) — the entity's rows as folder/file tiles.
- **Item view** (`#/fs/<entity>/<id>[/<relation>/<id>…]`, default mode, v2.0+) — the row as a click-to-edit document plus its relationships as sub-folders; drill arbitrarily deep, with a clickable breadcrumb.
- **Table view** (`#/objects/<entity>`, Advanced mode) — intrinsic columns, `belongsTo` chips, and a column per junction this entity participates in.
- **Detail view** (`#/objects/<entity>/<id>`, Advanced mode) — read mode by default; `Edit` flips cells into inputs (`Save` PATCHes, `Cancel` reverts).
- **Settings** (v2.0+) — opened from the header gear (Database / Lattice / User tabs + the Advanced-mode toggle); the legacy `#/settings/*` hashes still resolve and open the drawer.
- **Data Model** (inside **Workspace Settings**, v1.14+) — entity-level graph including the native `files`/`secrets` objects, with a per-entity editor. On a cloud workspace each table you own carries a **Share with workspace / Make private** toggle, and graph nodes are colored by share status (yellow = shared, red = private, green = selected) with a legend. (Pre-1.14 this was a separate `#/settings/data-model` nav item; that hash still resolves for back-compat.)

**Internal tables added on first open**

Opening a database with `lattice gui` is **additive** but mutates the schema: on the first run against any given DB, the GUI creates three `_lattice_gui_*` tables for its own bookkeeping:

| Table                      | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `_lattice_gui_meta`        | Per-entity icon overrides edited from the browser           |
| `_lattice_gui_column_meta` | Per-column flags (e.g. mark a column as `secret`)           |
| `_lattice_gui_audit`       | Linear audit log of every GUI mutation — powers undo / redo |

These tables are prefixed with `_lattice_gui_` and are hidden from `/api/entities`, the dashboard, and rendered context output. They are not part of your declared schema and do not affect any `Lattice` API calls. **No fictional / demo rows are ever inserted** — your existing data is what the GUI shows.

**HTTP surface** (all routes scoped to `http://127.0.0.1:<port>/api`):

| Route                          | Method | Lattice call                                                        |
| ------------------------------ | ------ | ------------------------------------------------------------------- |
| `/project`                     | GET    | (config + manifest summary)                                         |
| `/entities`                    | GET    | tables + `db.count` per table                                       |
| `/graph`                       | GET    | (schema graph for Data Model)                                       |
| `/tables/:table/rows`          | GET    | `db.query(table, …)`                                                |
| `/tables/:table/rows`          | POST   | `db.insert(table, body)`                                            |
| `/tables/:table/rows/:id`      | GET    | `db.get(table, id)`                                                 |
| `/tables/:table/rows/:id`      | PATCH  | `db.update(table, id, body)`                                        |
| `/tables/:table/rows/:id`      | DELETE | `db.delete(table, id)`                                              |
| `/tables/:junction/link`       | POST   | `db.link(junction, body)`                                           |
| `/tables/:junction/unlink`     | POST   | `db.unlink(junction, body)`                                         |
| `/schema/entities`             | POST   | create a new entity/table                                           |
| `/schema/entities/:name/share` | POST   | share/unshare a table you own with the cloud workspace (owner-only) |

On a cloud workspace, `/entities` and `/graph` (and the queryable `/tables/*` allowlist) are filtered to the tables you own plus tables shared to the workspace — so the API surface matches exactly what the GUI shows; a table you can't see is not reachable. `/entities` rows carry `shared` / `ownedByMe` flags in that mode.

The server only binds to `127.0.0.1` and has no authentication. See [SECURITY.md](./SECURITY.md) for the threat model — do not expose this port to a non-loopback interface.

**Native `secrets` and `files` entities (v1.12+).** Every Lattice opened by `lattice gui` automatically registers two framework-shipped tables before `init()`:

| Table     | Shape                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secrets` | `id, name, kind, value (encrypted), description, created_at, updated_at, deleted_at`                                                                       |
| `files`   | `id, original_name, mime, size_bytes, sha256, blob_path, extraction_status, extracted_text, description, …` (superset of any legacy `path`/`kind` columns) |

`secrets.value` is encrypted at rest via a new `TableDefinition.encrypted?: { columns: string[] }` field that extends the existing entity-context encryption to plain `define()` tables. The encryption master key resolves from `LATTICE_ENCRYPTION_KEY` (env) or `~/.lattice/master.key` (auto-generated, `chmod 0600` on POSIX). The companion helper `attachBlob(srcPath, latticeRoot)` writes any file into a content-addressed store at `<root>/data/blobs/<sha256>` and returns metadata suitable for a `files` row.

You can also register the native entities programmatically when opening a Lattice outside the GUI:

```ts
import { Lattice } from 'latticesql';
import { registerNativeEntities } from 'latticesql/framework/native-entities';

const db = new Lattice(
  { config: './lattice.config.yml' },
  { encryptionKey: process.env.LATTICE_ENCRYPTION_KEY },
);
registerNativeEntities(db);
await db.init();
```

`isNativeEntity(name)` / `NATIVE_ENTITY_NAMES` are the single source of truth for "is this table a framework-shipped native object?" — adding a key to `NATIVE_ENTITY_DEFS` flows everywhere automatically (table creation, GUI surfacing, recognition).

**Adopting an existing `files`/`secrets` table (v1.14+).** If a database already has its own `files` or `secrets` table — possibly with a different/legacy column shape — `adoptNativeEntities(db)` (run after `init()`) labels that physical table as THE native object instead of duplicating it: it merges the native column superset non-destructively (`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`, never dropping data) and records the binding in an internal `__lattice_native_entities` registry. Legacy plaintext `secrets.value` rows stay readable (decrypt passes non-`enc:` values through) and new writes encrypt. `listNativeBindings(db)` reads the bindings. The GUI runs this automatically on every open and exposes the bindings at `GET /api/native-entities`.

```ts
import { adoptNativeEntities, listNativeBindings } from 'latticesql';

await db.init();
await adoptNativeEntities(db); // merge + label existing files/secrets as native
const bindings = await listNativeBindings(db); // [{ entity, tableName, origin }]
```

**Machine-local user config at `~/.lattice/` (v1.12+).** A small set of files outside any Lattice DB so a user's identity, encrypted master key, saved cloud-DB credentials, and per-team bearer tokens survive switching projects:

| File                            | Purpose                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `~/.lattice/master.key`         | 32-byte AES-256 master key, auto-generated, `chmod 0600` on POSIX                                        |
| `~/.lattice/identity.json`      | `{display_name, email}` — mirrored into the active Lattice's `__lattice_user_identity` row on every open |
| `~/.lattice/keys/<label>.token` | Per-joined-team bearer tokens (`chmod 0600`)                                                             |
| `~/.lattice/db-credentials.enc` | AES-GCM-encrypted Postgres URLs keyed by label                                                           |

The GUI's User Settings view edits `identity.json` directly; the Database Settings page writes saved Postgres URLs into `db-credentials.enc` and rewrites `lattice.config.yml`'s `db:` line to `${LATTICE_DB:<label>}`. The config parser resolves that reference at open time so connection passwords never sit in YAML on disk.

`~/.lattice/preferences.json` (v1.13.8+) holds machine-local UI preferences keyed by name. Currently a single flag `show_system_tables: boolean` (default `false`) — see _Sidebar system-tables toggle (v1.13.8+)_ below.

**Information architecture, v1.13.8+.** The GUI treats every database as either Local (single-user SQLite) or Cloud (Postgres, one or more invited team members), with the database itself as the first-class concept. "Team" describes the set of members on a cloud database — there is no separate "create a team" step, and the verbiage for member management ("Invite Team", "Join Team", "Team Members") stays where it belongs. Concretely:

- **Editable database name** at the top of Database Settings. For cloud DBs the rename writes `__lattice_team_identity.team_name` (and broadcasts to every member via the realtime channel below); for local DBs it writes a `name:` key into the YAML config, parsed by `parseConfigFile()` and surfaced as `ParsedConfig.name`. New endpoint `POST /api/dbconfig/rename`.
- **Three-step Create Database wizard.** Opened from the header dropdown's `+ New database` button and from Lattice Settings → Add new database. Step 1: name + Local|Cloud + cloud credentials. Step 2: starter entities, each with a pre-checked "Share with cloud" checkbox when cloud. Step 3: review + create.
- **Header dropdown** shows the friendly database name + a Local|Cloud kind chip + a connectivity dot per row (green = cloud live, yellow = local SQLite, red = cloud disconnected). The `+ New database` button at the bottom opens the wizard.
- **Settings sidebar** is reorganized into Lattice Settings (catalog of all databases this lattice can reach + Add-new entry), Database Settings (renamed from Project Config — editable name header on top, the existing Database panel and cloud-databases list below), Data Model, and User Settings. The legacy `/settings/project-config` route still resolves for back-compat.
- **Migrate-to-Cloud per-table share checkboxes.** The migrate modal lists every user-defined table with "Share with cloud" pre-checked; uncheck individual tables to keep them cloud-stored but unshared. After the migrate, only checked tables call `shareObject`.
- **New-entity flow** on a cloud-connected database pre-checks a "Share with cloud" box; the share runs best-effort after the entity is created.

**Realtime cloud subscriptions (v1.13.8+).** Cloud Postgres-backed lattices stream changes to every connected GUI in realtime. A Postgres trigger on `__lattice_change_log` emits `pg_notify('lattice_changes', …)` after every insert; the GUI server holds a dedicated `pg.Client` with `LISTEN lattice_changes` and fans payloads out via a new Server-Sent Events endpoint:

| Route                  | Method | Description                                                                      |
| ---------------------- | ------ | -------------------------------------------------------------------------------- |
| `/api/realtime/stream` | GET    | SSE stream; `event: state` on connection transitions, `event: change` per NOTIFY |
| `/api/realtime/status` | GET    | JSON snapshot of `{ mode: 'local'\|'cloud', state, connected }`                  |

The browser's `EventSource` invalidates the entity cache on every `change` event; connection state drives a colored dot in the topbar (green/yellow/red). SQLite databases are unchanged — LISTEN/NOTIFY is Postgres-only and the broker is skipped on those. The trigger installer (`installCloudInternalTriggers`) is exported from `latticesql/teams/internal-tables` for callers that bootstrap cloud schemas outside the GUI.

**Sidebar system-tables toggle (v1.13.8+).** Internal `__lattice_*` and `_lattice_gui_*` tables are hidden from the sidebar by default. Enable the "Show system tables in sidebar" checkbox in User Settings → Preferences to surface them under a "System" section. Persisted to `~/.lattice/preferences.json`; exposed via `GET`/`POST /api/userconfig/preferences`.

---

## CLI — `lattice teams` (v1.12+)

Multi-user cloud-shared Lattice databases on your own Postgres. Bring your own Postgres connection; lattice handles identity (bearer tokens, email-bound invitations), the team membership table, and the sync engine (shared objects + row links + change feed + outbox + replay-guard puller).

**Bootstrap** (on a fresh cloud — no users yet):

```bash
lattice teams register \
  --cloud http://localhost:4317 \
  --email alice@example.com \
  --name "Alice" \
  --team-name "Atlas"
```

Atomic: creates the user, the singleton team, the creator membership, and the bearer token in one HTTP call. Prints the token once — save it locally.

**Invite a teammate by email**:

```bash
lattice teams invite --team Atlas --invitee-email bob@example.com
# → prints `latinv_…` token to share OOB with bob@example.com
```

**Join an existing team**:

```bash
lattice teams join \
  --cloud http://localhost:4317 \
  --token latinv_… \
  --email bob@example.com \
  --name "Bob"
```

The cloud rejects redemption if the caller's claimed email doesn't match the invitation's `invitee_email` (case-insensitive). Sharing an invite token in a public channel is therefore safe — only the addressee can redeem it.

**Other subcommands** (`lattice teams help` for the full list): `list`, `members`, `leave`, `destroy`, `share`, `unshare`, `shared`, `sync`, `link`, `unlink`, `pull`, `push`, `status`, `dlq`.

**Dead-letter queue (v1.15+).** A pulled change envelope that fails to apply (e.g. it arrived before the row/table it depends on), and any non-owner-overwrite divergence notice, lands in `__lattice_team_dlq`. Inspect and recover it instead of losing it behind the pull cursor:

```bash
lattice teams dlq list  --team <name>            # show entries (op, target, error)
lattice teams dlq retry --team <name> [--id <id>] # replay; a late dependency now applies cleanly
lattice teams dlq purge --team <name> [--id <id>] # discard without applying
```

**Per-table ownership + opt-in sharing (v1.14+).** Team members share one physical Postgres, so visibility is enforced at the app layer via a `__lattice_object_owners` table: each table records its creator, and a user sees only the tables they own plus tables explicitly shared to the team. The native `files`/`secrets` objects are owned by the database creator and private by default. Sharing is an explicit, owner-only action (not a side effect of creating a table). The filter gates API access, not just the display.

**Same flows from the GUI (v1.14+).** The local `lattice gui` drives the entire cloud-workspace lifecycle from **Workspace Settings**: rename (owner-only), invite by email (owner-only), the inline Members list with pending invitees (the owner is always shown as `creator`; your own row offers Leave/Destroy; non-owners can't kick), share/unshare from the Data Model, and sync status. Member admin is resolved from `GET /api/dbconfig` against the active cloud DB, so it works even when the cloud workspace itself is the active database. Identity (display name + email) comes from `~/.lattice/identity.json` and is locked in the Join modal. Leaving a workspace removes the local config + credential and switches you to another database.

**Joining via the GUI is one click (v1.13.7+).** When you click "Join via invite" and the redeem succeeds, the team's cloud URL is automatically saved as a switchable database credential and a sibling YAML config is written to your project directory. The new entry shows up in the database dropdown as `<team-name>.config`. Clicking it opens the SPA with the team's shared tables already populated — no YAML editing, no `db.define()` calls.

**Cloud server mode**: `lattice gui --team-cloud` boots the same binary as a cloud server. It exposes the bearer-token-gated `/api/team*` endpoints + the `/objects`/`/changes`/`/rows`/`/links` sync routes, and disables the local dev-tool surface (table viewer, CRUD endpoints, register-and-create modal).

The full architecture, schema, and HTTP surface live in [docs/teams.md](./docs/teams.md).

---

## Cloud migration + connection (v1.13+)

Lattice Teams + the GUI's Database panel now flow through a state machine:

```
LOCAL  →  CLOUD WORKSPACE (owner | member | needs-invite)
       (migrate / connect)
```

Migrating or connecting to Postgres produces a cloud workspace directly — its member/share machinery is initialized automatically, with no separate "upgrade" step (the intermediate `cloud-connected` state was removed in 1.16.3). The transition is one-way: once on cloud, the panel does not surface a revert-to-local button. Disconnecting from the cloud temporarily is a follow-up; the in-place reconnection happens automatically when the GUI reopens.

Public API surface (the GUI's `/api/dbconfig/*` routes are thin wrappers):

```ts
import {
  Lattice,
  migrateLatticeData,
  archiveLocalSqlite,
  openTargetLatticeForMigration,
  probeCloud,
  TeamsClient,
} from 'latticesql';

// 1. Migrate a local SQLite project to a fresh cloud Postgres
const source = new Lattice({ config: './lattice.config.yml' }, { encryptionKey });
await source.init();
const target = await openTargetLatticeForMigration('./lattice.config.yml', cloudUrl, encryptionKey);
const result = await migrateLatticeData(source, target);
// → { tablesCopied: ['files','items','secrets',...], rowsCopied: 42 }
target.close();
archiveLocalSqlite('./data/project.db'); // renames to .db.local-bak

// 2. Probe an arbitrary cloud URL for reachability + team status
const probe = await probeCloud('postgres://u:p@host/db');
// → { reachable: true, dialect: 'postgres', teamEnabled: false }

// 3. Connect a fresh project to an existing cloud (auto-redeems if it's a teams DB)
const client = new TeamsClient(source);
await client.connectToExistingCloud({
  label: 'atlas',
  cloudUrl: 'postgres://u:p@host/db',
  invite_token: 'latinv_...',
  email: 'bob@example.com',
  name: 'Bob',
});

// 4. Initialize the workspace member/share machinery on a cloud DB.
//    The GUI now does this automatically on migrate/connect/open; the
//    helper remains for programmatic use (idempotent — a no-op if the
//    cloud is already a workspace).
await client.ensureCloudWorkspaceIdentity({
  label: 'atlas',
  cloudUrl: 'postgres://u:p@host/db',
  workspaceName: 'Atlas',
  email: 'alice@example.com',
  displayName: 'Alice',
});
```

GUI consumers don't need to call these directly — the Database panel surfaces `Migrate to cloud →`, and joining a shared workspace goes through `Join a team (invite)`; workspace initialization is automatic. (The standalone "Connect to existing cloud" wizard was removed in 1.16.4.)

HTTP surface (all under `/api/dbconfig/*`, localhost-only, same auth model as the rest of `lattice gui`):

| Method | Route                                     | Wraps                                         |
| ------ | ----------------------------------------- | --------------------------------------------- |
| GET    | `/api/dbconfig`                           | returns `{ type, state, label?, host?, ... }` |
| POST   | `/api/dbconfig/probe`                     | `probeCloud(url)`                             |
| POST   | `/api/dbconfig/migrate-to-cloud`          | `migrateLatticeData` + `archiveLocalSqlite`   |
| POST   | `/api/dbconfig/connect-existing`          | `TeamsClient.connectToExistingCloud`          |
| POST   | `/api/dbconfig/save` / `connect` / `test` | unchanged from v1.12                          |

The `state` field on `GET /api/dbconfig` is one of: `local`, `team-cloud-creator`, `team-cloud-member`, `team-cloud-needs-invite` (the `cloud-connected` state was removed in 1.16.3). The SPA badge color-codes them (labeled "CLOUD · OWNER / MEMBER / NEEDS INVITE"); the routes use them only for response shape.

---

## Schema migrations

Lattice auto-creates tables and adds missing columns on every `init()` — you never need to manually write `CREATE TABLE` or `ALTER TABLE ADD COLUMN` for schema evolution.

For changes that require data transformation (renaming a column, dropping a column, changing a type), use the `migrations` option:

```typescript
await db.init({
  migrations: [
    // version 1: rename 'notes' → 'description'
    {
      version: 1,
      sql: `
        ALTER TABLE tasks ADD COLUMN description TEXT;
        UPDATE tasks SET description = notes;
      `,
    },
    // version 2: add index
    {
      version: 2,
      sql: `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)`,
    },
    // version 3: add computed default via UPDATE
    {
      version: 3,
      sql: `UPDATE tasks SET priority = 1 WHERE priority IS NULL`,
    },
  ],
});
```

Migrations are applied in ascending `version` order. Each version is applied at most once, tracked in a `__lattice_migrations` internal table. Safe to call `init()` multiple times across restarts — already-applied migrations are skipped.

For the YAML config workflow, generate the initial migration with `lattice generate` and add subsequent migrations manually to the `migrations/` directory (Lattice doesn't manage multi-file migrations — that's intentionally left to external tools like `flyway` or `dbmate` if you need it).

See [docs/migrations.md](./docs/migrations.md) for a step-by-step migration workflow.

---

## Security

**Input sanitization** — enabled by default. Strips control characters from string columns before storing. Disable per-instance with `security: { sanitize: false }`.

**Audit events** — declare which tables emit audit events:

```typescript
const db = new Lattice('./app.db', {
  security: { auditTables: ['users', 'api_keys'] },
});

db.on('audit', ({ table, operation, id, timestamp }) => {
  auditLog.write({ table, operation, id, timestamp });
});
```

**Field limits** — cap string lengths per column:

```typescript
const db = new Lattice('./app.db', {
  security: { fieldLimits: { notes: 50_000, bio: 500 } },
});
```

**SQL injection** — all values are passed as bound parameters; no user input is ever interpolated into SQL strings.

---

## Pluggable backends (v1.6+)

Lattice ships with two storage adapters and a pluggable interface so you can bring your own.

### Picking a backend by connection string

The `Lattice` constructor inspects the first argument and picks the right adapter:

| First argument                                 | Adapter           | When to use                                               |
| ---------------------------------------------- | ----------------- | --------------------------------------------------------- |
| `'/abs/path/to/db.sqlite'` (or any plain path) | `SQLiteAdapter`   | Default. Local file, no server.                           |
| `':memory:'`                                   | `SQLiteAdapter`   | In-memory SQLite. Great for tests.                        |
| `'file:/abs/path/to/db.sqlite'`                | `SQLiteAdapter`   | Same as the plain path form, with the scheme spelled out. |
| `'postgres://user:pass@host:5432/db'`          | `PostgresAdapter` | Postgres-compatible cloud DB (Supabase, Neon, RDS, …).    |
| `'postgresql://user:pass@host:5432/db'`        | `PostgresAdapter` | Same as `postgres://`.                                    |
| any string + `{ adapter: myAdapter }`          | your adapter      | Bring your own implementation.                            |

```ts
import { Lattice } from 'latticesql';

// SQLite (default)
const local = new Lattice('./data/lattice.db');

// Postgres (Supabase / Neon / RDS / etc.)
const cloud = new Lattice('postgres://postgres:secret@db.example.com:5432/agent');

// Bring your own
const custom = new Lattice('ignored', { adapter: new MyCustomAdapter() });
```

The rest of the API — `define()`, `init()`, `query()`, `insert()`, `render()`, `migrate()`, `watch()`, `reverseSync()`, `reverseSeed()` — is unchanged across both backends.

### Postgres setup

`PostgresAdapter` depends on `pg`, listed as an `optionalDependency` so SQLite-only consumers don't pay the install cost. Install it when you actually use Postgres:

```bash
npm install pg
```

> **Migrating from `<= 1.9.x`?** `synckit` is no longer a dependency. Drop it from your install. The `dist/postgres-worker.cjs` file is also gone (it served the now-removed sync surface).

Then point Lattice at any Postgres-compatible database that speaks the standard wire protocol on port 5432:

```ts
const lattice = new Lattice('postgres://user:pass@host:5432/db');
await lattice.init();
```

**Recommended pooler:** **transaction-mode** (e.g. PgBouncer transaction-mode, Supabase port `6543`). `PostgresAdapter` is native against `pg.Pool` and designed for transaction-mode: server-side prepared statements aren't kept across calls (because the upstream connection returns to the pool at `COMMIT`), and `prepareAsync` re-binds per call. Migrations are wrapped in `withClient(fn)` and acquire a transaction-scoped advisory lock so concurrent app boots serialize cleanly. `pool.max` is configurable via `PostgresAdapterOptions.poolSize` (default 10).

**Async-only on Postgres (since 1.10.0):**

- The async surface (`runAsync` / `getAsync` / `allAsync` / `prepareAsync` / `introspectColumnsAsync` / `addColumnAsync` / `withClient`) is the _only_ path that does work against Postgres. The synchronous methods (`run` / `get` / `all` / `prepare` / `introspectColumns` / `addColumn`) **throw** with a clear error pointing at the async equivalent. `pg.Pool` is fundamentally async; the previous synckit-bridged sync surface was a workaround that blocked the Node main thread on `Atomics.wait`, and it was removed in 1.10.0 once lattice core had migrated to async at every call site (1.9.0).
- `SQLiteAdapter` keeps the sync surface as the authoritative path (better-sqlite3 is sync by design). Its async methods just wrap the sync calls in resolved Promises — the one-microtask cost is negligible relative to having a single cross-dialect code path.
- **Transactional contract**: any code that issues `BEGIN`/`COMMIT` should use `withClient(fn)`. The pool checks out a single connection for the lifetime of `fn` and the `TxClient` handed to `fn` pins every query to that connection. Raw `adapter.runAsync('BEGIN')` is unsafe — different awaited calls land on different upstream connections under transaction-mode pooling.

```ts
// Recommended pattern for transactional writes
await adapter.withClient(async (tx) => {
  await tx.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [50, 'a']);
  await tx.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [50, 'b']);
});
```

**Schema portability:** Lattice's table definitions are mostly portable SQL. The adapter handles the few dialect differences automatically:

- `?` placeholders are translated to `$1, $2, …` for Postgres. Single-quoted strings, double-quoted identifiers, and SQL comments are skipped — `?` characters inside those are left alone.
- `BLOB` column types are translated to `BYTEA` inside `addColumn`. Use `BLOB` in your `TableDefinition` and it works on both backends.
- `datetime('now')` and `RANDOM()` defaults are translated to `NOW()` and `random()` for Postgres.
- Use `TEXT PRIMARY KEY` (UUIDs) for portable primary keys. `INTEGER PRIMARY KEY` auto-increments on SQLite but not Postgres — if you need it on Postgres, use a sequence or `GENERATED ALWAYS AS IDENTITY`.

### Bring your own adapter

The interface is small enough to implement against any backend:

```ts
export interface StorageAdapter {
  // Identifies the dialect for the few cross-dialect branches in lattice
  // core. Most application code never needs to read this.
  readonly dialect: 'sqlite' | 'postgres';

  // Sync surface — required by the interface. Sync-native backends like
  // SQLite implement it; async-native backends like Postgres (since 1.10.0)
  // throw with a helpful error pointing callers at the async equivalents.
  run(sql: string, params?: unknown[]): void;
  get(sql: string, params?: unknown[]): Row | undefined;
  all(sql: string, params?: unknown[]): Row[];
  prepare(sql: string): PreparedStatement;
  open(): void;
  close(): void;
  introspectColumns(table: string): string[];
  addColumn(table: string, column: string, typeSpec: string): void;

  // Async surface — optional, preferred by lattice when present.
  runAsync?(sql: string, params?: unknown[]): Promise<void>;
  getAsync?(sql: string, params?: unknown[]): Promise<Row | undefined>;
  allAsync?(sql: string, params?: unknown[]): Promise<Row[]>;
  prepareAsync?(sql: string): PreparedStatementAsync;
  introspectColumnsAsync?(table: string): Promise<string[]>;
  addColumnAsync?(table: string, column: string, typeSpec: string): Promise<void>;
  withClient?<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
}
```

Pass your implementation via `options.adapter`:

```ts
import { Lattice } from 'latticesql';
import type { StorageAdapter } from 'latticesql';

class MyMySQLAdapter implements StorageAdapter {
  /* … */
}

const lattice = new Lattice('ignored', { adapter: new MyMySQLAdapter() });
```

### Limitations

- `PreparedStatement.run()` returns `lastInsertRowid: 0` on the Postgres path. SQLite consumers that rely on `lastInsertRowid` should switch to `TEXT PRIMARY KEY` (UUIDs) for portability, or write `INSERT … RETURNING id` queries explicitly.
- Two SQLite-only paths remain: `fixSchemaConflicts(db)` (the lifecycle helper that takes a raw `Database.Database` argument) and the writeback session-apply machinery. Postgres consumers shouldn't call them.
- A built-in migration tool (SQLite → Postgres) is not included. Use a generic SQLite → Postgres migration tool, or `INSERT … SELECT` row-by-row.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           Lattice class                              │
│  define() / defineMulti() / defineEntityContext() / defineWriteback()│
│  CRUD: insert / upsert / upsertBy / update / delete                  │
│  Query: get / query / count                                          │
│  Render: render / sync / watch / reconcile                           │
├──────────────────┬──────────────────┬───────────────────────────────┤
│  SchemaManager   │  RenderEngine    │  WritebackPipeline            │
│                  │                  │                               │
│ Stores table,    │ Queries rows →   │ Watches output files for      │
│ multi-table, and │ render → atomic  │ new agent-written content,    │
│ entity context   │ write. Writes    │ calls parse() + persist()     │
│ definitions      │ manifest after   │                               │
│                  │ entity contexts  │                               │
├──────────────────┴──────────────────┴───────────────────────────────┤
│                         SQLiteAdapter                                │
│              (better-sqlite3 — synchronous I/O)                     │
└──────────────────────────────────────────────────────────────────────┘
        │                              │
        │ compileRender()              │ lifecycle/
        │ at define()-time             │ manifest.ts  ← readManifest/writeManifest
        ▼                              │ cleanup.ts   ← cleanupEntityContexts
┌────────────────────────┐            ▼
│  render/templates.ts   │    ┌────────────────────────┐
│  • compileRender(spec) │    │  render/entity-query.ts│
│  • _enrichRow()        │    │  • resolveEntitySource │
│  • renderList/Table/   │    │    (self/hasMany/m2m/  │
│    Detail/Json         │    │     belongsTo/custom)  │
│  • interpolate()       │    │  • truncateContent()   │
└────────────────────────┘    └────────────────────────┘
```

**Key design decisions:**

- **Synchronous SQLite** — `better-sqlite3` gives synchronous reads; all Lattice CRUD methods return Promises for API consistency but resolve synchronously under the hood.
- **Compile-time render** — `RenderSpec` is compiled to a plain `(rows: Row[]) => string` function at `define()`-time, not at render-time. `RenderEngine` stays unchanged.
- **Atomic writes** — files are written to a `.tmp` sibling then renamed. No partial writes, no reader sees incomplete content.
- **Schema-additive only** — Lattice never drops tables or columns automatically; it only adds missing ones.
- **Manifest-driven cleanup** — `reconcile()` compares the previous manifest (what Lattice wrote last cycle) against the current DB state and the new manifest (what was written this cycle) to safely remove orphaned directories and stale files.

See [docs/architecture.md](./docs/architecture.md) for a deeper walkthrough.

---

## Examples

Three complete, commented examples are in [docs/examples/](./docs/examples/):

| Example                                             | Description                                                 |
| --------------------------------------------------- | ----------------------------------------------------------- |
| [Agent system](./docs/examples/agent-system.md)     | Multi-agent context management with per-agent context files |
| [Ticket tracker](./docs/examples/ticket-tracker.md) | Project management system with relationships and templates  |
| [CMS](./docs/examples/cms.md)                       | Content management with writeback pipeline for agent edits  |

---

## Staying up to date

**CLI users:** The `lattice` CLI checks for new versions automatically and prints a notice when an update is available. Run `lattice update` to upgrade in place. Alternatively, use `npx lattice` to always run the latest version without a global install.

**Library consumers:** By default, `npm install latticesql` adds a `^` semver range to your `package.json`, so patch and minor updates are picked up on your next `npm install`. For fully automated dependency updates, set up [Dependabot](https://docs.github.com/en/code-security/dependabot) or [Renovate](https://github.com/renovatebot/renovate) — they'll create PRs in your repo whenever a new version is published.

### Auto-update (v1.1+)

For applications that manage their own updates at runtime, `autoUpdate()` checks npm for a newer version and installs it automatically. Call it once at startup, before initializing Lattice:

```typescript
import { autoUpdate } from 'latticesql';

// Call at app startup — checks npm, installs if outdated
const result = await autoUpdate();
if (result.restartRequired) {
  process.exit(0); // Let process manager restart
}
```

`autoUpdate()` is safe to call on every startup — it skips if already on the latest version. Pass `{ quiet: true }` to suppress console output.

**`AutoUpdateResult`**

```typescript
interface AutoUpdateResult {
  updated: boolean;
  packages: Array<{ name: string; from: string; to: string }>;
  restartRequired: boolean;
}
```

---

## Telemetry

`latticesql` includes [Scarf](https://scarf.sh) install analytics so we can understand how the package is used in the wild — what versions are running, on what platforms, at roughly what scale. This signal is what lets us prioritize fixes, deprecations, and new features against real usage instead of guesswork.

**What is sent — once, at `npm install` time, by the `@scarf/scarf` postinstall hook:**

- Package name + version (e.g. `latticesql@1.13.6`)
- Node.js version, OS, CPU architecture
- A coarse, non-identifying hash derived from the install host (Scarf's default — used for deduplication, not identification)
- The public IP of the install request (visible to any HTTPS endpoint; not stored long-term by Scarf)

**What is NOT sent:**

- No data from your application code, schemas, rows, or query strings
- No environment variables, file paths, hostnames, or usernames
- No runtime telemetry — `latticesql` makes zero outbound telemetry calls after install. The only network requests it makes at runtime are the explicit `checkForUpdate()` / `autoUpdate()` calls to `registry.npmjs.org`, which you opt into by calling them.

**How to opt out** — any one of these suppresses the install ping:

```bash
# Per-install (recommended for CI):
SCARF_ANALYTICS=false npm install latticesql

# Or, project-wide (add to .npmrc):
scarf-analytics=false

# Or, the cross-tool standard:
DO_NOT_TRACK=1 npm install latticesql

# Or, disable all postinstall scripts entirely:
npm install latticesql --ignore-scripts
```

**In-app opt-out (consent preference)** — in the GUI, open **Settings → User → Preferences** and uncheck **"Send anonymous analytics"** (or set `"analytics": false` in `~/.lattice/preferences.json`). This is the single consent for all anonymous analytics Lattice shares via Scarf — the install ping and any Scarf pixel — so in-app updates (`lattice update` / `autoUpdate()`) suppress the Scarf ping and any future runtime telemetry is gated. Analytics is **on by default** (opt-out). The original `npm install` ping is governed at install time by the env-var options above — the preference governs reinstalls, not the install you already ran.

Opting out has no effect on functionality — the package works identically. The Scarf postinstall is a fire-and-forget HTTPS ping with a short timeout; even when enabled it cannot fail your install.

See Scarf's own [privacy documentation](https://docs.scarf.sh) for the upstream policy.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, test commands, and contribution guidelines.

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full history.

---

## License

[Apache 2.0](./LICENSE) — includes explicit patent grant (Section 3).
