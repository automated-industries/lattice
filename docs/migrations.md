# Migration Guide

How to evolve your database schema over time with Lattice.

---

## Table of Contents

- [Overview](#overview)
- [How migrations work](#how-migrations-work)
- [Writing your first migration](#writing-your-first-migration)
- [Workflow: YAML config + codegen](#workflow-yaml-config--codegen)
- [Migration best practices](#migration-best-practices)
- [Common migration patterns](#common-migration-patterns)
- [Rollback strategy](#rollback-strategy)

---

## Overview

Lattice uses a version-tracked migration system. You provide an array of `Migration` objects when calling `init()`. Each migration runs exactly once and is tracked in a `_lattice_migrations` table inside your database.

```ts
await db.init({
  migrations: [
    { version: 1, sql: 'ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 1' },
    { version: 2, sql: 'CREATE INDEX idx_tasks_status ON tasks (status)' },
  ],
});
```

---

## How migrations work

1. On `init()`, Lattice creates `_lattice_migrations (version INTEGER PRIMARY KEY)` if it doesn't exist.
2. For each migration in the array, Lattice checks whether its `version` is already in `_lattice_migrations`.
3. If not present, the migration's SQL is executed and the version is recorded.
4. Migrations are run in the order they appear in the array, not necessarily by version number — but using ascending version numbers is strongly recommended.

**Key properties:**

- Each migration runs at most once per database (idempotent across restarts)
- Migrations run inside implicit transactions (SQLite auto-commit per statement)
- If a migration fails, the error is thrown and the version is not recorded — the migration will be retried on the next startup
- `CREATE TABLE IF NOT EXISTS` in `init()` always runs (not a migration) — `columns` specs are for initial schema creation

---

## Writing your first migration

**Before (initial schema — `define()`):**

```ts
db.define('tasks', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    title: 'TEXT NOT NULL',
    status: "TEXT DEFAULT 'open'",
  },
  render: 'default-list',
  outputFile: 'context/TASKS.md',
});
await db.init();
```

**After (add a column in v0.2 of your app):**

```ts
db.define('tasks', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    title: 'TEXT NOT NULL',
    status: "TEXT DEFAULT 'open'",
    priority: 'INTEGER DEFAULT 1', // New column
  },
  render: 'default-list',
  outputFile: 'context/TASKS.md',
});

await db.init({
  migrations: [
    {
      version: 1,
      sql: 'ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 1',
    },
  ],
});
```

The `columns` spec reflects the _current_ desired schema (used for new databases). The migration handles the _delta_ for existing databases. Both code paths result in the same final schema.

---

## Workflow: YAML config + codegen

When using `lattice.config.yml`, the recommended workflow is:

### Step 1: Update the YAML config

Add the new field to your entity:

```yaml
# lattice.config.yml
entities:
  task:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
      status: { type: text, default: open }
      priority: { type: integer, default: 1 } # ← added
    render: default-list
    outputFile: context/TASKS.md
```

### Step 2: Regenerate

```sh
lattice generate
```

This regenerates `generated/types.ts` (with `priority?: number` on the `Task` interface) and `generated/migration.sql` (with `"priority" INTEGER DEFAULT 1` in the `CREATE TABLE` statement).

### Step 3: Write the migration

The generated `migration.sql` is for fresh databases. For existing databases, write a numbered migration in your application startup code:

```ts
await db.init({
  migrations: [{ version: 1, sql: 'ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 1' }],
});
```

Keep migrations in a dedicated file so they accumulate over time:

```ts
// src/migrations.ts
import type { Migration } from 'latticesql';

export const migrations: Migration[] = [
  {
    version: 1,
    sql: 'ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 1',
  },
  {
    version: 2,
    sql: "ALTER TABLE tasks ADD COLUMN tags TEXT DEFAULT '[]'",
  },
  {
    version: 3,
    sql: 'CREATE INDEX idx_tasks_priority ON tasks (priority DESC)',
  },
];
```

```ts
import { migrations } from './migrations.js';

await db.init({ migrations });
```

---

## Migration best practices

**Number migrations sequentially.** Use `1, 2, 3...` — never skip numbers. If two developers add migrations simultaneously, coordinate version numbers before merging.

**Never change a committed migration.** Once a migration is deployed and has run on any database, treat it as immutable. If you need to fix it, write a new migration that corrects the previous one.

**Keep migrations small.** One change per migration. This makes failures easy to diagnose and rollbacks straightforward.

**Test migrations.** Run your full migration sequence against a copy of production data in CI. Lattice's test utilities (`':memory:'` db) are useful for unit tests, but test against real data for confidence.

**Document each migration.** Use a comment in the SQL or the `migrations.ts` file explaining why the change was made:

```ts
{
  version: 4,
  // Add soft-delete support — marketing wants to recover deleted tasks
  sql: 'ALTER TABLE tasks ADD COLUMN deleted_at TEXT',
},
```

---

## Common migration patterns

### Add a nullable column

```ts
{ version: 5, sql: 'ALTER TABLE tasks ADD COLUMN notes TEXT' }
```

SQLite `ALTER TABLE ADD COLUMN` supports nullable columns with no default. All existing rows get `NULL`.

### Add a column with a default

```ts
{ version: 6, sql: "ALTER TABLE tasks ADD COLUMN status TEXT DEFAULT 'open'" }
```

### Add an index

```ts
{ version: 7, sql: 'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)' }
```

Use `IF NOT EXISTS` to make the migration idempotent even if manually applied.

### Rename a column (SQLite limitation)

SQLite does not support `ALTER TABLE RENAME COLUMN` in older versions. The standard approach is a table copy:

```ts
{
  version: 8,
  sql: `
    CREATE TABLE tasks_new AS SELECT
      id, title, status, priority,
      due_at AS deadline,
      created_at
    FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
  `.trim(),
}
```

> **Warning:** This drops and recreates the table. All indexes are lost and must be recreated in a subsequent migration.

### Add a NOT NULL column to an existing table

SQLite requires a `DEFAULT` on `ALTER TABLE ADD COLUMN` when `NOT NULL` is specified:

```ts
{
  version: 9,
  sql: "ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT 'general'",
}
```

### Backfill data after adding a column

```ts
{
  version: 10,
  sql: `
    ALTER TABLE tasks ADD COLUMN slug TEXT;
    UPDATE tasks SET slug = LOWER(REPLACE(title, ' ', '-')) WHERE slug IS NULL;
  `.trim(),
}
```

---

## Rollback strategy

SQLite does not support transactional DDL (Data Definition Language) across multiple statements in the same way Postgres does. In practice, this means:

- **Test first.** Run migrations against a staging database before production.
- **Back up before migrating.** Lattice does not snapshot your database — do it yourself:
  ```sh
  cp data/app.db data/app.db.bak-$(date +%Y%m%d%H%M%S)
  ```
- **Simple column additions are safe.** `ALTER TABLE ADD COLUMN` is non-destructive. Rollback = add nothing.
- **Table rebuilds are risky.** If a rename migration fails halfway, the database may be in an inconsistent state. Restore from backup.

For production deployments, always:

1. Back up the database
2. Run migrations in a pre-start hook before the app opens the connection
3. Have a tested restore procedure
