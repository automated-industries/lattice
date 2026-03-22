# Template Rendering

How Lattice turns database rows into LLM context files.

---

## Table of Contents

- [Overview](#overview)
- [Built-in templates](#built-in-templates)
  - [`default-list`](#default-list)
  - [`default-table`](#default-table)
  - [`default-detail`](#default-detail)
  - [`default-json`](#default-json)
- [Render hooks](#render-hooks)
  - [`beforeRender`](#beforerender)
  - [`formatRow`](#formatrow)
- [Interpolation syntax](#interpolation-syntax)
- [Relationship data in templates](#relationship-data-in-templates)
- [Custom render functions](#custom-render-functions)
- [Choosing a template](#choosing-a-template)

---

## Overview

Every registered table has a `render` spec that controls how its rows become text. Lattice compiles the spec at `define()` time, so the heavy work happens once — each sync cycle just calls the pre-compiled function.

The three forms of `render`:

```ts
// 1. Built-in template name — simplest
render: 'default-list'

// 2. Template with hooks — add pre-filter or row formatting
render: {
  template: 'default-list',
  hooks: {
    beforeRender: (rows) => rows.filter(r => r.status !== 'archived'),
    formatRow: '{{title}} [{{status}}]',
  },
}

// 3. Custom function — full control
render: (rows) => rows.map(r => `## ${r.title}\n${r.body}`).join('\n\n')
```

In YAML config, the forms map to:

```yaml
render: default-list                   # form 1

render:
  template: default-list
  formatRow: "{{title}} [{{status}}]"  # form 2 (string formatRow only in YAML)
```

---

## Built-in templates

### `default-list`

Renders rows as a Markdown bulleted list. Ideal for compact overviews.

**Default output** (no `formatRow`):

```markdown
# tasks

- id: task-1 | title: Fix login bug | status: open
- id: task-2 | title: Write tests | status: done
```

Fields are joined with `|` separators. Field names and values are shown as `key: value` pairs.

**With `formatRow`:**

```ts
render: {
  template: 'default-list',
  hooks: { formatRow: '{{title}} [{{status}}]' },
}
```

```markdown
# tasks

- Fix login bug [open]
- Write tests [done]
```

---

### `default-table`

Renders rows as a GitHub-flavoured Markdown table. Good for structured data with many fields.

```markdown
# users

| id  | name  | email             | role   |
| --- | ----- | ----------------- | ------ |
| u-1 | Alice | alice@example.com | admin  |
| u-2 | Bob   | bob@example.com   | member |
```

Column headers are derived from the first row's keys. Does not support `formatRow`.

---

### `default-detail`

Renders each row as a separate Markdown section. Best for entities with many fields where table layout would be cramped.

**Default output:**

```markdown
# agents

## agent-1

- id: agent-1
- name: Craft
- role: Software architect

## agent-2

- id: agent-2
- name: Audit
- role: Code reviewer
```

**With `formatRow`:**

Each item in the section's list is rendered using `formatRow` instead of the default `key: value` format.

---

### `default-json`

Renders all rows as a JSON array. Useful when downstream tools consume structured data.

````markdown
# tasks

```json
[
  { "id": "task-1", "title": "Fix login bug", "status": "open" },
  { "id": "task-2", "title": "Write tests", "status": "done" }
]
```
````

````

No formatting hooks apply to `default-json`. If you need to transform the data, use `beforeRender` or a custom render function.

---

## Render hooks

Hooks let you customise built-in template behaviour without writing a full custom render function.

### `beforeRender`

`beforeRender(rows: Row[]): Row[]` — transform or filter the row array **before** any rendering occurs.

```ts
render: {
  template: 'default-list',
  hooks: {
    beforeRender: (rows) => rows
      .filter(r => r.status !== 'archived')
      .sort((a, b) => Number(b.priority) - Number(a.priority)),
  },
}
````

Use cases:

- Exclude archived / deleted rows
- Sort rows by a computed field
- Add computed properties (e.g. format a date)
- Limit to the N most-recent rows

`beforeRender` runs before `formatRow`. The array it returns is what gets formatted.

### `formatRow`

`formatRow` controls how each row is serialised to a string. It is supported by `default-list` and `default-detail`. It is **not** supported by `default-table` or `default-json`.

Two forms:

**Function:**

```ts
hooks: {
  formatRow: (row) => `${row.title} — assigned to ${row.assignee_id ?? 'unassigned'}`,
}
```

**Template string:**

```ts
hooks: {
  formatRow: '{{title}} — {{status}}',
}
```

In YAML config, only the template string form is supported:

```yaml
render:
  template: default-list
  formatRow: '{{title}} — {{status}}'
```

---

## Interpolation syntax

Template strings in `formatRow` (and anywhere Lattice uses `{{...}}` substitution) follow these rules:

- `{{fieldName}}` — replaced with `String(row[fieldName])` or `''` if the field is missing or null
- `{{relationName.fieldName}}` — resolved by joining the current row to a related table via a `belongsTo` relation (see below)
- Delimiters are `{{` and `}}` — no spaces inside
- Unknown tokens are replaced with an empty string (no error thrown)

Examples:

```
"{{title}}"                           → "Fix login bug"
"{{title}} [{{status}}]"              → "Fix login bug [open]"
"{{assignee.name}} → {{title}}"       → "Alice → Fix login bug"
"P{{priority}}: {{title}}"            → "P3: Fix login bug"
```

---

## Relationship data in templates

When a table has a `belongsTo` relation declared (via `relations` or `ref` in YAML config), Lattice can resolve relation fields inside `{{...}}` templates.

To use relation data, the relation must be declared:

```ts
db.define('tickets', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    title: 'TEXT NOT NULL',
    assignee_id: 'TEXT',
  },
  relations: {
    assignee: { type: 'belongsTo', table: 'users', foreignKey: 'assignee_id' },
  },
  render: {
    template: 'default-list',
    hooks: { formatRow: '{{title}} → {{assignee.name}}' },
  },
  outputFile: 'context/TICKETS.md',
});
```

When rendering, Lattice:

1. Executes `SELECT * FROM users WHERE id = assignee_id` for each ticket
2. Makes all `users` columns available as `{{assignee.<column>}}`

In YAML config, `ref: user` automatically creates the `belongsTo` relation:

```yaml
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
      assignee_id: { type: uuid, ref: user }
    render:
      template: default-list
      formatRow: '{{title}} → {{assignee.name}}'
```

**Limitations:**

- Only `belongsTo` relations are resolved in templates (the table holding the FK)
- `hasMany` relations are not resolved in `{{...}}` interpolation; use a custom render function or `defineMulti` instead
- Only one level of nesting is supported (`{{assignee.name}}`, not `{{assignee.org.name}}`)

---

## Custom render functions

For full control, pass a `(rows: Row[]) => string` function directly:

```ts
db.define('changelog', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    version: 'TEXT NOT NULL',
    notes: 'TEXT',
    date: 'TEXT',
  },
  render: (rows) => {
    const sorted = [...rows].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return sorted
      .map((r) => `## v${r.version} — ${r.date}\n\n${r.notes ?? '_No notes_'}`)
      .join('\n\n---\n\n');
  },
  outputFile: 'context/CHANGELOG.md',
});
```

Custom functions:

- Receive the full `Row[]` array (after any `filter` defined on the table)
- Must return a string
- Have no access to relation data (join manually via `db.query()` if needed)
- Are compiled once at `define()` time and called on every sync cycle

---

## Choosing a template

| Template         | Best for                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| `default-list`   | Compact overviews with `formatRow` control; good for lists the LLM reads |
| `default-table`  | Structured data with uniform fields; easy to scan                        |
| `default-detail` | Rich entities with many fields; one section per row                      |
| `default-json`   | Downstream tool consumption; structured data handoff                     |
| Custom function  | Any format not covered above; multi-table joins; complex Markdown        |

General guidance:

- Use `default-list` + `formatRow` for most agent context files — it's compact and readable
- Use `default-table` for reference data (users, tags, config settings)
- Use `default-json` when another system (not a human / LLM) reads the output
- Use a custom function for hierarchical documents or when you need JOIN data
