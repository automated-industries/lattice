# Example: Ticket Tracker

A complete example showing how to build a simple ticket tracker with `latticesql` — users, tickets, comments, and automatic Markdown context generation.

---

## Scenario

A small engineering team wants:

- A SQLite-backed ticket system
- Automatic Markdown snapshots of the ticket board for LLM context
- TypeScript types generated from the schema
- Query support for filtering by status and assignee

---

## Project structure

```
ticket-tracker/
├── lattice.config.yml
├── src/
│   ├── db.ts
│   └── tickets.ts
├── context/
│   ├── USERS.md
│   ├── TICKETS.md
│   └── COMMENTS.md
├── data/
│   └── tickets.db
└── generated/
    ├── types.ts
    └── migration.sql
```

---

## 1. Schema

```yaml
# lattice.config.yml
db: ./data/tickets.db

entities:
  user:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text, required: true }
      email: { type: text, required: true }
      team: { type: text }
    render: default-table
    outputFile: context/USERS.md

  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
      description: { type: text }
      status: { type: text, default: open }
      priority: { type: integer, default: 2 }
      reporter_id: { type: uuid, ref: user }
      assignee_id: { type: uuid, ref: user }
      created_at: { type: datetime }
      closed_at: { type: datetime }
    render:
      template: default-list
      formatRow: '[{{status}}] P{{priority}} {{title}} — {{assignee.name}}'
    outputFile: context/TICKETS.md

  comment:
    fields:
      id: { type: uuid, primaryKey: true }
      body: { type: text, required: true }
      ticket_id: { type: uuid, ref: ticket }
      author_id: { type: uuid, ref: user }
      created_at: { type: datetime }
    render:
      template: default-list
      formatRow: '{{author.name}} ({{created_at}}): {{body}}'
    outputFile: context/COMMENTS.md
```

---

## 2. Generate types and migration

```sh
npx lattice generate --out src/generated
```

`src/generated/types.ts`:

```ts
export interface User {
  id: string;
  name: string;
  email: string;
  team?: string;
}

export interface Ticket {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: number;
  reporter_id?: string; // → user
  assignee_id?: string; // → user
  created_at?: string;
  closed_at?: string;
}

export interface Comment {
  id: string;
  body: string;
  ticket_id?: string; // → ticket
  author_id?: string; // → user
  created_at?: string;
}
```

---

## 3. Database setup

```ts
// src/db.ts
import { Lattice } from 'latticesql';

export const db = new Lattice({
  config: './lattice.config.yml',
  options: { wal: true },
});

await db.init({
  migrations: [
    // v1: add tags column after initial release
    {
      version: 1,
      sql: "ALTER TABLE ticket ADD COLUMN tags TEXT DEFAULT '[]'",
    },
  ],
});
```

---

## 4. Core ticket operations

```ts
// src/tickets.ts
import { db } from './db.js';

// --- Users ---

export async function createUser(name: string, email: string, team?: string) {
  return db.insert('user', {
    name,
    email,
    team: team ?? null,
    id: undefined, // auto-generated
  });
}

// --- Tickets ---

export async function openTicket(opts: {
  title: string;
  description?: string;
  priority?: number;
  reporterId: string;
  assigneeId?: string;
}) {
  return db.insert('ticket', {
    title: opts.title,
    description: opts.description ?? null,
    status: 'open',
    priority: opts.priority ?? 2,
    reporter_id: opts.reporterId,
    assignee_id: opts.assigneeId ?? null,
    created_at: new Date().toISOString(),
  });
}

export async function closeTicket(id: string) {
  await db.update('ticket', id, {
    status: 'closed',
    closed_at: new Date().toISOString(),
  });
}

export async function assignTicket(id: string, assigneeId: string) {
  await db.update('ticket', id, { assignee_id: assigneeId });
}

export async function getOpenTickets(assigneeId?: string) {
  if (assigneeId) {
    return db.query('ticket', {
      where: { status: 'open', assignee_id: assigneeId },
      orderBy: 'priority',
      orderDir: 'desc',
    });
  }
  return db.query('ticket', {
    where: { status: 'open' },
    orderBy: 'priority',
    orderDir: 'desc',
  });
}

export async function searchTickets(titleFragment: string) {
  return db.query('ticket', {
    filters: [
      { col: 'title', op: 'like', val: `%${titleFragment}%` },
      { col: 'status', op: 'ne', val: 'archived' },
    ],
  });
}

export async function getHighPriorityOpen() {
  return db.query('ticket', {
    filters: [
      { col: 'status', op: 'eq', val: 'open' },
      { col: 'priority', op: 'gte', val: 3 },
    ],
    orderBy: 'priority',
    orderDir: 'desc',
  });
}

// --- Comments ---

export async function addComment(ticketId: string, authorId: string, body: string) {
  return db.insert('comment', {
    body,
    ticket_id: ticketId,
    author_id: authorId,
    created_at: new Date().toISOString(),
  });
}

export async function getComments(ticketId: string) {
  return db.query('comment', {
    where: { ticket_id: ticketId },
    orderBy: 'created_at',
  });
}
```

---

## 5. Reports and counts

```ts
// Dashboard stats
const openCount = await db.count('ticket', { where: { status: 'open' } });
const closedCount = await db.count('ticket', { where: { status: 'closed' } });

// Tickets assigned to no-one
const unassigned = await db.query('ticket', {
  filters: [
    { col: 'assignee_id', op: 'isNull' },
    { col: 'status', op: 'eq', val: 'open' },
  ],
});

console.log(`Open: ${openCount}, Closed: ${closedCount}, Unassigned: ${unassigned.length}`);
```

---

## 6. Context sync

```ts
// Keep context files fresh — sync every 30 seconds
const stop = await db.watch('./context', {
  interval: 30_000,
  onRender: (r) => console.log(`[sync] ${r.filesWritten.length} files updated`),
});

process.on('SIGTERM', () => {
  stop();
  db.close();
});
```

---

## 7. Sample context output

**`context/TICKETS.md`:**

```markdown
# ticket

- [open] P3 Auth tokens expire too early — Alice
- [open] P2 Slow search on large datasets — (unassigned)
- [closed] P2 Fix CSV export encoding — Bob
```

**`context/USERS.md`:**

```markdown
# user

| id  | name  | email             | team     |
| --- | ----- | ----------------- | -------- |
| u-1 | Alice | alice@example.com | Backend  |
| u-2 | Bob   | bob@example.com   | Frontend |
```

An LLM reading the ticket context immediately sees what's open, who owns what, and at what priority — without needing to query the database directly.
