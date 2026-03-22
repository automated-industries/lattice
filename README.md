# @m-flat/lattice

**SQLite ↔ LLM context bridge.** Keeps a database and a set of text files in sync so AI agents always start a session with accurate, up-to-date state.

## What it does

LLM context windows are ephemeral. Your application state lives in a database. Every agent session starts cold unless something bridges them. Lattice is that bridge — a minimal, generic engine that renders DB state into agent-readable files and ingests agent-written output back into the DB.

Lattice has no opinions about what tables you store, what your agents do, or what your context files look like. You bring your schema. Lattice provides the sync loop.

## Quick start

```typescript
import { Lattice } from '@m-flat/lattice';

const db = new Lattice('./state.db');

db.define('bots', {
  columns: {
    id:      'TEXT PRIMARY KEY',
    name:    'TEXT NOT NULL',
    persona: 'TEXT',
    active:  'INTEGER DEFAULT 1',
  },
  render(rows) {
    return rows
      .filter(r => r.active)
      .map(r => `## ${r.name}\n${r.persona ?? ''}`)
      .join('\n\n');
  },
  outputFile: 'bots.md',
});

await db.init();

// Insert rows
await db.insert('bots', { id: 'bot-1', name: 'Alpha', persona: 'You are Alpha.' });
await db.insert('bots', { id: 'bot-2', name: 'Beta',  persona: 'You are Beta.'  });

// Render DB → files
await db.render('./context');
// Writes: context/bots.md

// Watch for changes (re-renders every 5 seconds when DB content changes)
const stop = await db.watch('./context', { interval: 5000 });

// Later:
stop();
db.close();
```

## The sync loop

```
Your DB (SQLite)
    │  Lattice reads rows
    ▼
Render functions (you define these)
    │  Lattice writes files atomically
    ▼
Context files  ◄──── LLM agents read these

Agent output files  ────► Lattice parses these
    │  Writeback pipeline (optional)
    ▼
Your DB (rows inserted/updated)
```

## Installation

```bash
npm install @m-flat/lattice
```

Requires Node.js 18+. Uses `better-sqlite3` — no external DB process needed.

## API

### `new Lattice(path, options?)`

Opens a SQLite database at `path`.

```typescript
const db = new Lattice('./state.db', {
  wal: true,            // WAL mode (default: true)
  busyTimeout: 5000,    // SQLite busy timeout ms (default: 5000)
  security: {
    sanitize: true,     // sanitize string inputs (default: true)
    auditTables: ['credentials'],  // tables that emit audit events
    fieldLimits: { notes: 10000 }, // per-column char limits
  },
});
```

### `db.define(table, definition)`

Register a table with a render function. Must be called before `init()`.

```typescript
db.define('tasks', {
  columns: {
    id:     'TEXT PRIMARY KEY',
    title:  'TEXT NOT NULL',
    status: 'TEXT DEFAULT "open"',
  },
  render(rows) {
    const open = rows.filter(r => r.status === 'open');
    return `# Open Tasks\n${open.map(r => `- ${r.title}`).join('\n')}`;
  },
  outputFile: 'tasks.md',
});
```

**Custom primary key** — use any column name as the PK (v0.2+):

```typescript
db.define('posts', {
  columns: {
    slug:  'TEXT NOT NULL PRIMARY KEY',
    title: 'TEXT NOT NULL',
    views: 'INTEGER DEFAULT 0',
  },
  primaryKey: 'slug',   // tell Lattice which column is the PK
  render: (rows) => rows.map(r => `- ${r.title}`).join('\n'),
  outputFile: 'posts.md',
});

// Now get/update/delete accept the slug value directly:
const post = await db.get('posts', 'my-post-slug');
await db.update('posts', 'my-post-slug', { views: 42 });
await db.delete('posts', 'my-post-slug');
```

**Composite primary key** — use `tableConstraints` + `primaryKey` array (v0.2+):

```typescript
db.define('seats', {
  columns: {
    event_id: 'TEXT NOT NULL',
    seat_no:  'INTEGER NOT NULL',
    holder:   'TEXT',
  },
  tableConstraints: ['PRIMARY KEY (event_id, seat_no)'],
  primaryKey: ['event_id', 'seat_no'],
  render: (rows) => rows.map(r => `${r.event_id}:${r.seat_no} → ${r.holder}`).join('\n'),
  outputFile: 'seats.md',
});

// Pass a Record for get/update/delete on composite-keyed tables:
const seat = await db.get('seats', { event_id: 'evt-1', seat_no: 5 });
await db.update('seats', { event_id: 'evt-1', seat_no: 5 }, { holder: 'Alice' });
```

**Relationship declarations** — metadata for context rendering (v0.2+):

```typescript
db.define('comments', {
  columns: { id: 'TEXT PRIMARY KEY', post_id: 'TEXT', body: 'TEXT' },
  relations: {
    post:    { type: 'belongsTo', table: 'posts',    foreignKey: 'post_id'   },
    replies: { type: 'hasMany',   table: 'replies',  foreignKey: 'comment_id'},
  },
  render: (rows) => rows.map(r => `- ${r.body}`).join('\n'),
  outputFile: 'comments.md',
});
```

### Built-in render templates (v0.3+)

Instead of a render function, pass a template name or spec:

```typescript
// Shortest form — pick a built-in template
db.define('tasks', {
  columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT' },
  render: 'default-list',   // or 'default-table' | 'default-detail' | 'default-json'
  outputFile: 'tasks.md',
});
```

The four built-in templates:

| Name | Output |
| --- | --- |
| `default-list` | One bullet per row: `- key: value, ...` |
| `default-table` | GitHub-flavoured Markdown table |
| `default-detail` | One `## <pk>` section per row with all fields |
| `default-json` | `JSON.stringify(rows, null, 2)` |

**Lifecycle hooks** — customise any built-in template:

```typescript
db.define('tasks', {
  columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT', priority: 'INTEGER' },
  render: {
    template: 'default-list',
    hooks: {
      // Filter or transform rows before rendering
      beforeRender: (rows) => rows.filter(r => r.status !== 'done'),
      // Control how each row becomes a string.
      // Can be a function or a {{field}} interpolation template.
      formatRow: '{{title}} ({{status}})',
    },
  },
  outputFile: 'tasks.md',
  // Writes: "- Write docs (open)\n- Fix bug (open)"
});
```

**`{{field}}` interpolation** — `formatRow` supports dot-notation for `belongsTo` relations:

```typescript
db.define('users', {
  columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
  render: 'default-list',
  outputFile: 'users.md',
});

db.define('tasks', {
  columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', author_id: 'TEXT' },
  relations: {
    author: { type: 'belongsTo', table: 'users', foreignKey: 'author_id' },
  },
  render: {
    template: 'default-list',
    hooks: { formatRow: '{{title}} by {{author.name}}' },
  },
  outputFile: 'tasks.md',
  // Writes: "- Write docs by Alice\n- Fix bug by Bob"
});
```

Hooks are also supported for `default-detail` (controls the section body) and `default-json` (`beforeRender` only — `formatRow` has no effect on JSON output).

### `db.defineMulti(name, definition)`

Register a multi-entity render — produces one file per anchor entity.

```typescript
db.defineMulti('agent-context', {
  keys: () => db.query('agents', { where: { active: 1 } }),
  outputFile: (agent) => `agents/${agent.slug}/CONTEXT.md`,
  tables: ['tasks'],
  render(agent, { tasks }) {
    const mine = tasks.filter(t => t.assigned_to === agent.id);
    return `# ${agent.name}\n\n## Tasks\n${mine.map(t => `- ${t.title}`).join('\n')}`;
  },
});
```

### `await db.init(options?)`

Opens the connection, creates tables, runs migrations.

```typescript
await db.init({
  migrations: [
    { version: 2, sql: 'ALTER TABLE tasks ADD COLUMN due_date TEXT' },
  ],
});
```

### CRUD

```typescript
const id = await db.insert('tasks', { title: 'Write docs' });
await db.upsert('tasks', { id, title: 'Write docs', status: 'done' });
await db.update('tasks', id, { status: 'done' });
await db.delete('tasks', id);

const tasks = await db.query('tasks', { where: { status: 'open' }, orderBy: 'title' });
const task  = await db.get('tasks', id);
const n     = await db.count('tasks', { where: { status: 'open' } });
```

**Expanded query operators** (v0.2+) — use `filters` for anything beyond equality:

```typescript
// Comparison: gt, gte, lt, lte
const recent = await db.query('tasks', {
  filters: [{ col: 'priority', op: 'gte', val: 3 }],
});

// Pattern matching
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

// Combine with where (equality shorthand) — ANDed together
const results = await db.query('tasks', {
  where:   { project_id: 'proj-1' },
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

For queries not covered by the API (JOINs, GROUP BY, etc.), use `db.db` — the raw `better-sqlite3` `Database` instance.

### Render / sync

```typescript
// Render once
const result = await db.render('./context');
// { filesWritten: ['context/tasks.md'], filesSkipped: 0, durationMs: 8 }

// Render + writeback in one call
const result = await db.sync('./context');

// Watch for changes
const stop = await db.watch('./context', {
  interval: 5000,
  onRender: (r) => console.log('rendered', r.filesWritten),
  onError:  (e) => console.error(e),
});
stop(); // cancel the loop
```

### Writeback pipeline

```typescript
db.defineWriteback({
  file: './context/agents/*/SESSION.md',
  parse(content, fromOffset) {
    // Parse new content since fromOffset; return entries + next offset
    // Lattice handles offset tracking and file rotation automatically
    return { entries: parseYourFormat(content.slice(fromOffset)), nextOffset: content.length };
  },
  async persist(entry, filePath) {
    await db.insert('events', entry as Row);
  },
  dedupeKey: (entry) => (entry as { id: string }).id,
});
```

### Events

```typescript
db.on('audit',     ({ table, operation, id }) => { /* ... */ });
db.on('render',    (result) => { /* ... */ });
db.on('writeback', ({ filePath, entriesProcessed }) => { /* ... */ });
db.on('error',     (err) => { /* ... */ });
```

## YAML config + CLI (v0.4+)

Define your schema once in `lattice.config.yml` and let Lattice wire everything up for you.

### `lattice.config.yml` reference

```yaml
# Path to the SQLite database (relative to this config file)
db: ./data/app.db

entities:
  # Entity name becomes the table name
  user:
    fields:
      id:    { type: uuid,    primaryKey: true }
      name:  { type: text,    required: true   }
      email: { type: text }
    render: default-table          # BuiltinTemplateName
    outputFile: context/USERS.md  # where to write the context file

  ticket:
    fields:
      id:          { type: uuid,    primaryKey: true }
      title:       { type: text,    required: true   }
      status:      { type: text,    default: open    }
      priority:    { type: integer, default: 1       }
      assignee_id: { type: uuid,    ref: user        }  # creates belongsTo relation
    render:
      template: default-list
      formatRow: "{{title}} ({{status}}) → {{assignee.name}}"
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

| Option       | Type               | Description                                         |
| ------------ | ------------------ | --------------------------------------------------- |
| `primaryKey` | boolean            | Marks this column as the table's primary key        |
| `required`   | boolean            | Adds `NOT NULL` constraint                          |
| `default`    | string/number/bool | Sets a SQL `DEFAULT` value                          |
| `ref`        | string (tableName) | Creates a `belongsTo` relation; `_id` suffix stripped from relation name |

### Init from config

```typescript
import { Lattice } from '@m-flat/lattice';

const db = new Lattice({ config: './lattice.config.yml' });
await db.init();

// All entities from the config are now available
await db.insert('ticket', { title: 'Fix login bug', assignee_id: 'u-1' });
```

The `{ config }` form reads the YAML, creates all tables on `init()`, and wires render functions automatically. Fully equivalent to calling `new Lattice('./path/to/db')` + `define(...)` for each entity.

### `lattice generate` CLI

Generate TypeScript interfaces, an initial SQL migration, and (optionally) empty scaffold render files:

```sh
npx lattice generate --config lattice.config.yml --out generated/

# Or after installing globally / as a project script:
lattice generate
```

```
Options for generate:
  --config, -c <path>    Path to config file    (default: ./lattice.config.yml)
  --out, -o <dir>        Output directory        (default: ./generated)
  --scaffold             Create empty render output files at each entity's outputFile path
```

**Output**

```
generated/
├── types.ts               # TypeScript interfaces — one per entity
└── migrations/
    └── 0001_initial.sql   # CREATE TABLE IF NOT EXISTS statements
```

Example `generated/types.ts`:

```typescript
// Auto-generated by `lattice generate`. Do not edit manually.

export interface User {
  id: string;
  name: string;
  email?: string;
}

export interface Ticket {
  id: string;
  title: string;
  status?: string;
  priority?: number;
  assignee_id?: string;  // → user
}
```

### Config API (programmatic)

Parse a config file or string directly:

```typescript
import { parseConfigFile, parseConfigString } from '@m-flat/lattice';

// From a file (throws on missing/invalid file)
const { dbPath, tables } = parseConfigFile('./lattice.config.yml');

// From a YAML string (useful for testing)
const { tables } = parseConfigString(yamlString, '/base/dir');

// Wire tables into any Lattice instance
const db = new Lattice(':memory:');
for (const { name, definition } of tables) {
  db.define(name, definition);
}
await db.init();
```

## License

[Apache 2.0](./LICENSE) — includes explicit patent grant (Section 3).
