# Configuration Guide

Complete reference for `lattice.config.yml` — the YAML schema config format introduced in v0.4.

---

## Table of Contents

- [Overview](#overview)
- [Top-level structure](#top-level-structure)
- [Field types](#field-types)
- [Field options](#field-options)
- [Relationships (`ref`)](#relationships-ref)
- [Render specs](#render-specs)
- [Primary keys](#primary-keys)
- [Output file paths](#output-file-paths)
- [Multiple entities](#multiple-entities)
- [Programmatic config API](#programmatic-config-api)
- [Complete example](#complete-example)

---

## Overview

`lattice.config.yml` is a declarative schema file. It defines:

- Where the SQLite database lives
- What tables exist and what columns they have
- How each table's rows are rendered into LLM context files
- Where those context files are written

Place it at the root of your project (or anywhere — pass `--config` to override):

```
my-project/
├── lattice.config.yml
├── data/
│   └── app.db
└── context/
    ├── AGENTS.md
    └── TASKS.md
```

---

## Top-level structure

```yaml
db: ./data/app.db # Required — path to SQLite file
entities: # Required — one key per table
  table_name:
    fields: ...
    render: ...
    outputFile: ...
```

| Key        | Type   | Required | Description                                               |
| ---------- | ------ | -------- | --------------------------------------------------------- |
| `db`       | string | yes      | Path to the SQLite database, relative to this config file |
| `entities` | object | yes      | Map of entity (table) name → entity definition            |

The `db` path is resolved relative to the directory containing `lattice.config.yml`, not `process.cwd()`. Using `:memory:` for `db` is valid for testing.

---

## Field types

Each field in an entity's `fields` map must have a `type`. The supported types and their mappings:

| YAML type  | SQLite column type | TypeScript type |
| ---------- | ------------------ | --------------- |
| `uuid`     | `TEXT`             | `string`        |
| `text`     | `TEXT`             | `string`        |
| `integer`  | `INTEGER`          | `number`        |
| `int`      | `INTEGER`          | `number`        |
| `real`     | `REAL`             | `number`        |
| `float`    | `REAL`             | `number`        |
| `boolean`  | `INTEGER`          | `boolean`       |
| `bool`     | `INTEGER`          | `boolean`       |
| `datetime` | `TEXT`             | `string`        |
| `date`     | `TEXT`             | `string`        |
| `blob`     | `BLOB`             | `Buffer`        |

`uuid` and `text` are both stored as `TEXT` — the distinction is semantic: use `uuid` for ID columns, `text` for everything else. Use `boolean`/`bool` for true/false values stored as SQLite integers.

---

## Field options

Every field accepts these options in addition to `type`:

```yaml
entities:
  task:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
      status: { type: text, default: open }
      priority: { type: integer, default: 1 }
      assignee_id: { type: uuid, ref: user }
      deleted_at: { type: datetime }
```

| Option       | Type                      | Description                                                                       |
| ------------ | ------------------------- | --------------------------------------------------------------------------------- |
| `type`       | `LatticeFieldType`        | **Required.** Column data type (see table above)                                  |
| `primaryKey` | `boolean`                 | Mark this field as the primary key. Generates `TEXT PRIMARY KEY` (for uuid/text)  |
| `required`   | `boolean`                 | Column is `NOT NULL`. Cannot be used together with `primaryKey`                   |
| `default`    | string / number / boolean | SQL `DEFAULT` value. Strings are quoted; numbers are unquoted                     |
| `ref`        | string                    | Foreign-key reference to another entity (see [Relationships](#relationships-ref)) |

### Generated SQL

```yaml
id:       { type: uuid,    primaryKey: true }   → "id" TEXT PRIMARY KEY
title:    { type: text,    required: true }      → "title" TEXT NOT NULL
status:   { type: text,    default: open }       → "status" TEXT DEFAULT 'open'
priority: { type: integer, default: 1 }          → "priority" INTEGER DEFAULT 1
notes:    { type: text }                         → "notes" TEXT
```

---

## Relationships (`ref`)

Adding `ref: <entity>` to a field automatically creates a `belongsTo` relationship in the compiled `TableDefinition`.

```yaml
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      assignee_id: { type: uuid, ref: user }
```

This generates:

- Column: `"assignee_id" TEXT`
- Relation: `assignee: { type: 'belongsTo', table: 'user', foreignKey: 'assignee_id' }`

**Relation name derivation:** If the field name ends with `_id`, the suffix is stripped to form the relation name. Otherwise the full field name is used:

| Field name    | Relation name |
| ------------- | ------------- |
| `assignee_id` | `assignee`    |
| `project_id`  | `project`     |
| `parent_id`   | `parent`      |
| `author`      | `author`      |

The relation name is used in `{{relationName.field}}` interpolation strings inside render templates.

SQLite does not enforce foreign key constraints by default. Lattice stores `ref` as metadata for template rendering — no `FOREIGN KEY` constraint is added to the SQL schema.

---

## Render specs

The `render` key controls how rows are turned into context file content. It accepts three forms:

### Form 1 — Built-in template name (string)

```yaml
entities:
  agent:
    render: default-table
```

Available built-in templates: `default-list`, `default-table`, `default-detail`, `default-json`.

### Form 2 — Template with formatRow hook (object)

```yaml
entities:
  ticket:
    render:
      template: default-list
      formatRow: '{{title}} ({{status}}) — assigned to {{assignee.name}}'
```

The `formatRow` string uses `{{field}}` interpolation. Use `{{relationName.field}}` to pull in a field from a `belongsTo` related row.

### Form 3 — Default (omitted)

If `render` is omitted, it defaults to `default-list`.

```yaml
entities:
  note:
    fields:
      id: { type: uuid, primaryKey: true }
      body: { type: text }
    outputFile: context/NOTES.md
    # render defaults to 'default-list'
```

See [Template Rendering](./templates.md) for the full guide.

---

## Primary keys

### Field-level `primaryKey`

The simplest form — mark one field with `primaryKey: true`:

```yaml
entities:
  user:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text }
```

This sets the table's primary key to `id`. When inserting without an `id`, a UUID v4 is auto-generated.

### Custom single PK

Use a non-`id` field as the primary key:

```yaml
entities:
  setting:
    fields:
      key: { type: text, primaryKey: true }
      value: { type: text }
```

Callers must supply `key` on every insert. No UUID is auto-generated.

### Entity-level `primaryKey` override

For composite keys or when you want to separate the PK declaration from field definitions:

```yaml
entities:
  line_item:
    fields:
      order_id: { type: uuid }
      seq: { type: integer }
      qty: { type: integer }
    primaryKey: [order_id, seq]
```

When entity-level `primaryKey` is set, it overrides any field-level `primaryKey: true`. The caller must supply all PK columns on every insert.

---

## Output file paths

The `outputFile` path is resolved relative to the **config file's directory** (not `process.cwd()`).

```yaml
# lattice.config.yml lives at /project/lattice.config.yml
entities:
  agent:
    outputFile: context/AGENTS.md # → /project/context/AGENTS.md
```

This means the context files are co-located with the config file, regardless of where you run commands from.

When you call `db.render(outputDir)` or `db.watch(outputDir)` programmatically, the `outputFile` is resolved relative to `outputDir` — not the config file directory. The config file form resolves differently (see below).

> **Note:** When using `new Lattice({ config: '...' })`, the `outputFile` paths in the YAML are pre-resolved to absolute paths at parse time. `render()` / `watch()` receive these absolute paths and write there directly, ignoring `outputDir`.

---

## Multiple entities

Define as many entities as needed. They are parsed and registered in the order they appear in the YAML:

```yaml
db: ./data/app.db
entities:
  user:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text, required: true }
      email: { type: text }
    render: default-table
    outputFile: context/USERS.md

  project:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text, required: true }
      owner_id: { type: uuid, ref: user }
    render:
      template: default-list
      formatRow: '{{name}} (owner: {{owner.name}})'
    outputFile: context/PROJECTS.md

  task:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
      status: { type: text, default: open }
      priority: { type: integer, default: 1 }
      project_id: { type: uuid, ref: project }
      assignee_id: { type: uuid, ref: user }
    render:
      template: default-list
      formatRow: '{{title}} [{{status}}] → {{assignee.name}}'
    outputFile: context/TASKS.md
```

---

## Programmatic config API

You can use the parser directly without going through the `Lattice` constructor:

```ts
import { parseConfigFile, parseConfigString } from 'latticesql';

// From a file:
const { dbPath, tables } = parseConfigFile('./lattice.config.yml');

// From a string (useful in tests):
const { dbPath, tables } = parseConfigString(yamlContent, '/path/to/config/dir');

// tables is: ReadonlyArray<{ name: string; definition: TableDefinition }>
for (const { name, definition } of tables) {
  db.define(name, definition);
}
```

Both functions throw with descriptive messages on validation errors.

---

## Complete example

```yaml
# lattice.config.yml
db: ./data/app.db

entities:
  # --- Users ---
  user:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text, required: true }
      email: { type: text, required: true }
      role: { type: text, default: member }
      created_at: { type: datetime }
    render: default-table
    outputFile: context/USERS.md

  # --- Projects ---
  project:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text, required: true }
      status: { type: text, default: active }
      owner_id: { type: uuid, ref: user }
    render:
      template: default-list
      formatRow: '**{{name}}** [{{status}}] — {{owner.name}}'
    outputFile: context/PROJECTS.md

  # --- Tasks ---
  task:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
      description: { type: text }
      status: { type: text, default: open }
      priority: { type: integer, default: 1 }
      project_id: { type: uuid, ref: project }
      assignee_id: { type: uuid, ref: user }
      created_at: { type: datetime }
      due_at: { type: datetime }
    render:
      template: default-list
      formatRow: '{{title}} [P{{priority}}/{{status}}] → {{assignee.name}}'
    outputFile: context/TASKS.md

  # --- Comments ---
  comment:
    fields:
      id: { type: uuid, primaryKey: true }
      body: { type: text, required: true }
      task_id: { type: uuid, ref: task }
      author_id: { type: uuid, ref: user }
      created_at: { type: datetime }
    render:
      template: default-list
      formatRow: '{{author.name}}: {{body}}'
    outputFile: context/COMMENTS.md
```

Run `lattice generate` to produce TypeScript interfaces and a SQL migration file from this config. Then use `new Lattice({ config: './lattice.config.yml' })` at runtime to connect, define tables, and start syncing.
