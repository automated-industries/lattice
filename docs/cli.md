# CLI Reference

The `lattice` command-line tool for generating TypeScript types, SQL migrations, scaffold files, and entity context directories from a YAML config.

---

## Table of Contents

- [Installation](#installation)
- [Commands](#commands)
  - [`lattice generate`](#lattice-generate)
  - [`lattice render`](#lattice-render)
  - [`lattice reconcile`](#lattice-reconcile)
  - [`lattice status`](#lattice-status)
  - [`lattice watch`](#lattice-watch)
  - [`lattice gui`](#lattice-gui)
  - [`lattice connect`](#lattice-connect)
- [Global options](#global-options)
- [Generated files](#generated-files)
- [Examples](#examples)

---

## Installation

The CLI is bundled with the `latticesql` package:

```sh
npm install latticesql
```

After installation, the `lattice` binary is available via `npx`:

```sh
npx lattice --help
```

Or add it to `package.json` scripts:

```json
{
  "scripts": {
    "codegen": "lattice generate"
  }
}
```

For global access:

```sh
npm install -g latticesql
lattice --help
```

---

## Commands

### `lattice generate`

Generate TypeScript interface types, a SQL migration file, and (optionally) scaffold render output files from a `lattice.config.yml`.

```sh
lattice generate [options]
```

**Options:**

| Option            | Short | Default                | Description                                    |
| ----------------- | ----- | ---------------------- | ---------------------------------------------- |
| `--config <path>` | `-c`  | `./lattice.config.yml` | Path to the YAML config file                   |
| `--out <dir>`     | `-o`  | `./generated`          | Output directory for generated files           |
| `--scaffold`      | –     | off                    | Also create empty scaffold render output files |

**Output files:**

| File                    | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `<out>/types.ts`        | TypeScript interfaces, one per entity                      |
| `<out>/migration.sql`   | `CREATE TABLE IF NOT EXISTS` SQL for all entities          |
| `<outDir>/<outputFile>` | _(only with `--scaffold`)_ Empty placeholder context files |

**Exit codes:**

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| `0`  | Success                                                                 |
| `1`  | Config file not found, YAML parse error, or missing required config key |

---

### `lattice render`

One-shot context generation. Reads the config, connects to the database, and writes all entity context directories to the output directory.

```sh
lattice render [options]
```

**Options:**

| Option            | Short | Default                | Description                                        |
| ----------------- | ----- | ---------------------- | -------------------------------------------------- |
| `--config <path>` | `-c`  | `./lattice.config.yml` | Path to the YAML config file                       |
| `--output <dir>`  | –     | `./context`            | Output directory for rendered entity context files |

**Exit codes:**

| Code | Meaning                        |
| ---- | ------------------------------ |
| `0`  | Success                        |
| `1`  | Config error or render failure |

**Example:**

```sh
lattice render --config ./lattice.config.yml --output ./context
```

```
Rendered 6 files in 42ms
  ✓ /project/context/agents/alpha/AGENT.md
  ✓ /project/context/agents/alpha/SKILLS.md
  ...
```

---

### `lattice reconcile`

Render + orphan cleanup. Writes entity context directories and then removes any orphaned entity directories and files that are no longer present in the database or declared in the config.

```sh
lattice reconcile [options]
```

**Options:**

| Option              | Short | Default                | Description                                              |
| ------------------- | ----- | ---------------------- | -------------------------------------------------------- |
| `--config <path>`   | `-c`  | `./lattice.config.yml` | Path to the YAML config file                             |
| `--output <dir>`    | –     | `./context`            | Output directory for rendered entity context files       |
| `--dry-run`         | –     | off                    | Report orphans but do not delete anything                |
| `--no-orphan-dirs`  | –     | off                    | Skip removal of orphaned entity directories              |
| `--no-orphan-files` | –     | off                    | Skip removal of orphaned files inside entity directories |
| `--protected <csv>` | –     | –                      | Comma-separated list of protected filenames              |

**Exit codes:**

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| `0`  | Success                                   |
| `1`  | Config error, render failure, or warnings |

**Example:**

```sh
lattice reconcile --output ./context --protected SESSION.md
```

```
Rendered 6 files in 38ms
  ✓ /project/context/agents/alpha/AGENT.md
Cleanup: removed 1 directories, 0 files
  ✓ Removed /project/context/agents/beta
```

---

### `lattice status`

Dry-run reconcile — shows what would change without writing or deleting anything. Alias for `lattice reconcile --dry-run`.

```sh
lattice status [options]
```

**Options:**

| Option            | Short | Default                | Description                                        |
| ----------------- | ----- | ---------------------- | -------------------------------------------------- |
| `--config <path>` | `-c`  | `./lattice.config.yml` | Path to the YAML config file                       |
| `--output <dir>`  | –     | `./context`            | Output directory for rendered entity context files |

**Example:**

```sh
lattice status --output ./context
```

```
DRY RUN — no changes made
Rendered 6 files in 35ms
Cleanup: removed 1 directories, 0 files
```

---

### `lattice watch`

Starts a polling loop that re-renders entity context directories on each interval. Optionally runs orphan cleanup after each render cycle.

```sh
lattice watch [options]
```

**Options:**

| Option              | Short | Default                | Description                                                              |
| ------------------- | ----- | ---------------------- | ------------------------------------------------------------------------ |
| `--config <path>`   | `-c`  | `./lattice.config.yml` | Path to the YAML config file                                             |
| `--output <dir>`    | –     | `./context`            | Output directory for rendered entity context files                       |
| `--interval <ms>`   | –     | `5000`                 | Poll interval in milliseconds                                            |
| `--cleanup`         | –     | off                    | Enable orphan cleanup after each render cycle                            |
| `--no-orphan-dirs`  | –     | off                    | Skip removal of orphaned entity directories (requires `--cleanup`)       |
| `--no-orphan-files` | –     | off                    | Skip removal of orphaned files inside entity dirs (requires `--cleanup`) |
| `--protected <csv>` | –     | –                      | Comma-separated list of protected filenames (requires `--cleanup`)       |

Sends `SIGINT` or `SIGTERM` to stop gracefully.

**Example:**

```sh
lattice watch --config ./lattice.config.yml --output ./context --interval 3000 --cleanup --protected SESSION.md
```

```
[10:42:00] Rendered 6 files in 41ms
[10:42:03] Rendered 6 files in 38ms
[10:42:06] Rendered 5 files in 39ms
[10:42:06] Cleanup: removed 0 dirs, 1 files
^C
```

---

### `lattice gui`

Starts a local-only browser GUI for exploring _and editing_ the data in a
Lattice database. The server opens the DB referenced by `db:` in the config
and exposes a small HTTP surface that delegates straight to Lattice's CRUD
methods — no separate state, no schema duplication.

```sh
lattice gui [options]
```

**Options:**

| Option            | Short | Default                | Description                                           |
| ----------------- | ----- | ---------------------- | ----------------------------------------------------- |
| `--config <path>` | `-c`  | `./lattice.config.yml` | Path to the YAML config file                          |
| `--output <dir>`  | –     | `./context`            | Output directory (used by the relationship graph)     |
| `--port <number>` | –     | `4317`                 | Localhost port; auto-increments when the port is busy |
| `--no-open`       | –     | off                    | Print the URL without opening a browser               |

**Example:**

```sh
lattice gui --config ./lattice.config.yml
```

```
Lattice GUI listening at http://127.0.0.1:4317
Press Ctrl+C to stop.
```

**Views:**

- **Dashboard** (`#/`) — one card per first-class entity with live row counts.
- **Workspace / folder grid** (`#/fs/<entity>`, default in v2.0+) — the entity's
  rows as folder/file tiles instead of a table.
- **Item view** (`#/fs/<entity>/<id>[/<relation>/<id>…]`, default in v2.0+) — the
  row rendered as a document built from its columns (long-form fields as
  markdown); **click any value to edit it in place** (saves via `PATCH`,
  undoable). The row's relationships — reverse `belongsTo` children + junctions —
  appear as **sub-folders** you can drill into arbitrarily deep, with a clickable
  breadcrumb. Native `files` rows show the inline file/markdown preview.
- **Table view** (`#/objects/<entity>`, Advanced mode) — a SQL-like table with
  intrinsic columns, belongsTo chips, and a column per junction this entity
  participates in. `+ New` adds a row inline; each row has a delete control and a
  click-through to its detail page.
- **Detail view** (`#/objects/<entity>/<id>`, Advanced mode) — read mode by
  default; `Edit` flips intrinsic + belongsTo cells into inputs (`Save` PATCHes,
  `Cancel` reverts). `Delete` confirms and removes the row.
- **Settings** (v2.0+) — opened from the header **gear** (top-right): a slide-over
  drawer with **Database / Lattice / User** tabs plus an **Advanced mode** toggle
  (switches the object views between the file-system workspace and the classic
  table/row editor). The legacy `#/settings/*` hashes still resolve and open the
  drawer.
- **Data Model** (inside Database Settings) — an entity-level graph plus a side
  panel for adding / removing junction-table links between rows.

**HTTP surface** (all routes scoped to `http://127.0.0.1:<port>/api`):

| Route                      | Method | Lattice call                  |
| -------------------------- | ------ | ----------------------------- |
| `/project`                 | GET    | (config + manifest summary)   |
| `/entities`                | GET    | tables + `db.count` per table |
| `/graph`                   | GET    | (schema graph for Data Model) |
| `/tables/:table/rows`      | GET    | `db.query(table, …)`          |
| `/tables/:table/rows`      | POST   | `db.insert(table, body)`      |
| `/tables/:table/rows/:id`  | GET    | `db.get(table, id)`           |
| `/tables/:table/rows/:id`  | PATCH  | `db.update(table, id, body)`  |
| `/tables/:table/rows/:id`  | DELETE | `db.delete(table, id)`        |
| `/tables/:junction/link`   | POST   | `db.link(junction, body)`     |
| `/tables/:junction/unlink` | POST   | `db.unlink(junction, body)`   |

Junction tables (any table with exactly two `belongsTo` relations) are hidden
from the Objects sidebar and the dashboard; link/unlink lives on the Data Model
page. The server only binds to `127.0.0.1` and does not implement auth — it's
intended for local development against a config you trust.

**Internal tables added on first open.** Opening a database with `lattice gui`
creates three additive bookkeeping tables prefixed with `_lattice_gui_`:

| Table                      | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `_lattice_gui_meta`        | Per-entity icon overrides edited from the browser           |
| `_lattice_gui_column_meta` | Per-column flags (e.g. mark a column as `secret`)           |
| `_lattice_gui_audit`       | Linear audit log of every GUI mutation — powers undo / redo |

These tables are filtered out of `/api/entities`, the dashboard, and rendered
context output. They are not part of your declared schema and do not affect any
`Lattice` API calls. No fictional / demo rows are ever inserted — the GUI only
shows the data already in your database.

---

### `lattice connect`

Puts Lattice _behind your own dashboard_. It serves a local HTML file (or a
folder of static assets) at `/`, with Lattice's data routes available at the same
origin — so plain `fetch()` calls from your page upload files, capture notes, and
list what you've saved with no API key in the page. The built-in Lattice view
moves to `/lattice`. On first run it walks a non-coder through pasting a Claude
API key (stored encrypted on this machine only, never written into the database);
without a key, files are still saved but not auto-categorized.

```sh
lattice connect [options]
```

**Options:**

| Option               | Short | Default                    | Description                                                             |
| -------------------- | ----- | -------------------------- | ----------------------------------------------------------------------- |
| `--dashboard <path>` | –     | (none)                     | A local `.html` file or a folder to serve at `/` (Lattice → `/lattice`) |
| `--root <dir>`       | –     | discovered or `./.lattice` | The `.lattice` root location                                            |
| `--port <number>`    | –     | `4317`                     | Localhost port; auto-increments when the port is busy                   |
| `--no-open`          | –     | off                        | Print the URL without opening a browser                                 |

**Example:**

```sh
lattice connect --dashboard ./my-dashboard.html
```

```
Your dashboard is live at http://127.0.0.1:4317
Lattice's own view is at http://127.0.0.1:4317/lattice
Press Ctrl+C to stop.
```

A connected dashboard can also be set, changed, or disconnected at runtime from
the GUI's **Connect dashboard** top-bar button, which persists the choice to the
machine-local config so it is restored next start. Folders are served **in
place** — your edits show up on refresh, and a symlink inside the folder that
escapes it is refused (no arbitrary host-file read). See
[docs/connect.md](./connect.md) for the full walkthrough.

---

## Cloud

There are **no `lattice teams` (or `lattice serve`) subcommands**. A Lattice cloud
is a shared Postgres database secured by Postgres Row-Level Security — there is no
server process to run and nothing to bootstrap from the CLI. The three cloud flows
(migrate a local Lattice in, join an existing cloud with the scoped credentials the
owner gave you, invite a member) are driven from `lattice gui` or directly from the
library API:

```ts
import {
  Lattice,
  // migrate
  openTargetLatticeForMigration,
  migrateLatticeData,
  installCloudRls,
  backfillOwnership,
  enableRlsForTable,
  archiveLocalSqlite,
  // invite / membership
  memberRoleName,
  generateMemberPassword,
  provisionMemberRole,
  revokeMemberRole,
  // sharing + probe
  setRowVisibility,
  probeCloud,
} from 'latticesql';
```

See [docs/cloud.md](./cloud.md) for the full architecture, the three flows, the
RLS / role model, and how sharing works.

---

## Global options

| Option      | Short | Description                        |
| ----------- | ----- | ---------------------------------- |
| `--help`    | `-h`  | Show help message                  |
| `--version` | `-v`  | Print the installed version number |

```sh
lattice --version   # → 1.11.0
lattice --help
```

---

## Generated files

### `types.ts`

One TypeScript `export interface` per entity. Field names are preserved as-is; entity names are converted to PascalCase.

Given this config:

```yaml
entities:
  task_comment:
    fields:
      id: { type: uuid, primaryKey: true }
      body: { type: text, required: true }
      task_id: { type: uuid }
      score: { type: integer, default: 0 }
    relations:
      task: { type: belongsTo, table: task, foreignKey: task_id }
```

Generates:

```ts
// Auto-generated by `lattice generate`. Do not edit manually.

export interface TaskComment {
  id: string;
  body: string;
  task_id?: string; // → task
  score?: number;
}
```

**Type mapping rules:**

- `uuid`, `text`, `datetime`, `date` → `string`
- `integer`, `int`, `real`, `float` → `number`
- `boolean`, `bool` → `boolean`
- `blob` → `Buffer`
- Fields marked `primaryKey: true` or `required: true` are non-optional (no `?`)
- All other fields are optional (suffixed with `?`)
- Fields with `ref` get an inline comment `// → <target>`

---

### `migration.sql`

A `CREATE TABLE IF NOT EXISTS` statement for every entity. Safe to run on a fresh or existing database — it will not overwrite data.

```sql
-- Auto-generated by `lattice generate`. Do not edit manually.
-- Run this file once against your SQLite database to create the initial schema.
-- For subsequent schema changes, write versioned migrations (see docs/migrations.md).

CREATE TABLE IF NOT EXISTS "task_comment" (
  "id" TEXT PRIMARY KEY,
  "body" TEXT NOT NULL,
  "task_id" TEXT,
  "score" INTEGER DEFAULT 0
);
```

> **Note:** This file is for initial schema setup only. For schema changes to existing databases, write versioned migrations. See the [Migration Guide](./migrations.md).

---

### Scaffold files (with `--scaffold`)

When `--scaffold` is passed, `lattice generate` creates an empty file at each entity's `outputFile` path (resolved relative to `--out`). These serve as placeholders until the first sync populates them.

```sh
lattice generate --scaffold
```

If the file already exists, it is not overwritten.

---

## Examples

### Basic usage

```sh
lattice generate
```

Reads `./lattice.config.yml`, writes to `./generated/`:

```
Generated 2 file(s):
  ✓ /project/generated/types.ts
  ✓ /project/generated/migration.sql
```

---

### Custom config and output directory

```sh
lattice generate --config ./config/lattice.yml --out ./src/generated
```

---

### Generate with scaffold files

```sh
lattice generate --scaffold
```

```
Generated 5 file(s):
  ✓ /project/generated/types.ts
  ✓ /project/generated/migration.sql
  ✓ /project/context/AGENTS.md
  ✓ /project/context/TASKS.md
  ✓ /project/context/USERS.md
```

---

### In a package.json script

```json
{
  "scripts": {
    "codegen": "lattice generate --out src/generated",
    "codegen:scaffold": "lattice generate --out src/generated --scaffold"
  }
}
```

---

### Verify installed version

```sh
npx lattice --version
# 1.11.0
```
