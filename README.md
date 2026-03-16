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

For complex queries, use `db.db` — the raw `better-sqlite3` `Database` instance.

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
