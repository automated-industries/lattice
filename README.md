# latticesql

**SQLite ↔ LLM context bridge.** Keeps a database and a set of text files in sync so AI agents always start a session with accurate, up-to-date state.

[![npm version](https://img.shields.io/npm/v/latticesql.svg)](https://www.npmjs.com/package/latticesql)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**[latticeSQL.com](https://latticeSQL.com)** — docs, examples, and guides

---

## What it does

LLM context windows are ephemeral. Your application state lives in a database. Every agent session starts cold unless something bridges them. Lattice is that bridge — a minimal, generic engine that:

1. **Renders** DB rows into agent-readable text files (Markdown, JSON, or any format you define)
2. **Watches** for DB changes and re-renders automatically
3. **Ingests** agent-written output back into the DB via the writeback pipeline

Lattice has no opinions about your schema, your agents, or your file format. You define the tables. You control the rendering. Lattice runs the sync loop.

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
  - [CRUD operations](#crud-operations)
  - [Query operators](#query-operators)
  - [Render, sync, watch, and reconcile](#render-sync-watch-and-reconcile)
  - [Events](#events)
  - [Raw DB access](#raw-db-access)
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
- [Schema migrations](#schema-migrations)
- [Security](#security)
- [Architecture](#architecture)
- [Examples](#examples)
- [Contributing](#contributing)
- [Changelog](#changelog)

---

## Installation

```bash
npm install latticesql
```

Requires **Node.js 18+**. Uses `better-sqlite3` — no external database process needed.

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

Lattice never modifies your existing rows — it only reads for rendering and appends via the writeback pipeline.

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
   */
  render: RenderSpec;

  /** Output file path, relative to the outputDir passed to render()/watch() */
  outputFile: string;

  /** Optional row filter applied before rendering */
  filter?: (rows: Row[]) => Row[];

  /**
   * Primary key column name or [col1, col2] for composite PKs.
   * Defaults to 'id'. When 'id' is the PK and the field is absent on insert,
   * a UUID v4 is generated automatically.
   */
  primaryKey?: string | string[];

  /** Additional SQL constraints (required for composite PKs) */
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

**Composite primary key:**

```typescript
db.define('event_seats', {
  columns: {
    event_id: 'TEXT NOT NULL',
    seat_no: 'INTEGER NOT NULL',
    holder: 'TEXT',
  },
  tableConstraints: ['PRIMARY KEY (event_id, seat_no)'],
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
      source: { type: 'self' },                        // entity's own row
      render: ([r]) => `# ${r.name as string}\n\n${r.bio as string ?? ''}`,
    },
    'TASKS.md': {
      source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id',
                orderBy: 'created_at', orderDir: 'desc', limit: 20 },
      render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
      omitIfEmpty: true,                               // skip if no tasks
      budget: 4000,                                    // truncate at 4 000 chars
    },
    'SKILLS.md': {
      source: {
        type: 'manyToMany',
        junctionTable: 'agent_skills',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skills',
        orderBy: 'name',                               // softDelete inherited from sourceDefaults
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

| Type | What it queries |
|---|---|
| `{ type: 'self' }` | The entity row itself |
| `{ type: 'hasMany', table, foreignKey, ... }` | Rows in `table` where `foreignKey = entityPk` |
| `{ type: 'manyToMany', junctionTable, localKey, remoteKey, remoteTable, ... }` | Remote rows via a junction table |
| `{ type: 'belongsTo', table, foreignKey, ... }` | Single parent row via FK on this entity (`null` FK → empty) |
| `{ type: 'enriched', include: { ... } }` | Entity row + related data attached as `_key` JSON fields (v0.7+) |
| `{ type: 'custom', query: (row, adapter) => Row[] }` | Fully custom synchronous query |

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

#### sourceDefaults (v0.6+)

Set default query options for all relationship sources in an entity context:

```typescript
db.defineEntityContext('agents', {
  slug: (row) => row.slug as string,
  sourceDefaults: { softDelete: true },  // applied to all hasMany/manyToMany/belongsTo
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

See [docs/entity-context.md](./docs/entity-context.md) for the complete guide.

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
    removeOrphanedDirectories: true,  // delete dirs for deleted entities
    removeOrphanedFiles: true,        // delete stale relationship files
    protectedFiles: ['SESSION.md'],   // never delete these
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

One-shot render + orphan cleanup. Reads the previous manifest, renders all tables and entity contexts (writing a new manifest), then removes orphaned directories and files.

```typescript
const result = await db.reconcile('./context', {
  removeOrphanedDirectories: true,
  removeOrphanedFiles: true,
  protectedFiles: ['SESSION.md'],
  dryRun: false,                        // set true to preview without deleting
  onOrphan: (path, kind) => console.log(`would remove ${kind}: ${path}`),
});

console.log(result.filesWritten);           // files written this cycle
console.log(result.cleanup.directoriesRemoved);  // orphaned dirs removed
console.log(result.cleanup.warnings);            // dirs left in place (user files)
```

`ReconcileResult` extends `RenderResult` with a `cleanup: CleanupResult` field:

```typescript
interface ReconcileResult {
  filesWritten: string[];
  filesSkipped: number;
  durationMs: number;
  cleanup: {
    directoriesRemoved: string[];   // absolute paths
    filesRemoved: string[];
    directoriesSkipped: string[];   // had user files — left in place
    warnings: string[];
  };
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
  { key: 'name',   header: 'Name' },
  { key: 'status', header: 'Status', format: (v) => String(v || '—') },
  { key: 'name',   header: 'Detail', format: (v, row) => `[view](${row.slug}/DETAIL.md)` },
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

slugify('My Agent Name');  // 'my-agent-name'
slugify('Jose Garcia');    // 'jose-garcia'
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
      render: ([r]) => `# ${r.name as string}\n\n${r.description as string ?? ''}`,
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
  protectedFiles: ['NOTES.md'],   // agents wrote these — keep them
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
  files: { /* ... */ },
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
last_task: my-project-deploy
===
```

| Header | Required | Description |
|--------|----------|-------------|
| `type` | Yes | Must be `write` |
| `timestamp` | Yes | ISO 8601 |
| `op` | Yes | `create`, `update`, or `delete` |
| `table` | Yes | Target table name |
| `target` | For update/delete | Record primary key |
| `reason` | Encouraged | Human-readable reason (audit trail) |

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
  id: string;                       // content-addressed ID
  timestamp: string;                // ISO 8601
  op: 'create' | 'update' | 'delete';
  table: string;
  target?: string;                  // required for update/delete
  reason?: string;
  fields: Record<string, string>;  // empty for delete
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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, test commands, and contribution guidelines.

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full history.

---

## License

[Apache 2.0](./LICENSE) — includes explicit patent grant (Section 3).
