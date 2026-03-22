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

**Relationship declarations** — metadata for context rendering (v0.2+, used by templates in v0.3+):

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

## License

[Apache 2.0](./LICENSE) — includes explicit patent grant (Section 3).
