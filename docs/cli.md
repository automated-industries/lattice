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
- [Global options](#global-options)
- [Generated files](#generated-files)
- [Examples](#examples)

---

## Installation

The CLI is bundled with the `@automated-industries/lattice` package:

```sh
npm install @automated-industries/lattice
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
npm install -g @automated-industries/lattice
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

| Option            | Short | Default                | Description                                          |
| ----------------- | ----- | ---------------------- | ---------------------------------------------------- |
| `--config <path>` | `-c`  | `./lattice.config.yml` | Path to the YAML config file                         |
| `--output <dir>`  | –     | `./context`            | Output directory for rendered entity context files   |

**Exit codes:**

| Code | Meaning                               |
| ---- | ------------------------------------- |
| `0`  | Success                               |
| `1`  | Config error or render failure        |

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

| Option               | Short | Default                | Description                                              |
| -------------------- | ----- | ---------------------- | -------------------------------------------------------- |
| `--config <path>`    | `-c`  | `./lattice.config.yml` | Path to the YAML config file                             |
| `--output <dir>`     | –     | `./context`            | Output directory for rendered entity context files       |
| `--dry-run`          | –     | off                    | Report orphans but do not delete anything                |
| `--no-orphan-dirs`   | –     | off                    | Skip removal of orphaned entity directories              |
| `--no-orphan-files`  | –     | off                    | Skip removal of orphaned files inside entity directories |
| `--protected <csv>`  | –     | –                      | Comma-separated list of protected filenames              |

**Exit codes:**

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| `0`  | Success                                    |
| `1`  | Config error, render failure, or warnings  |

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

| Option              | Short | Default                | Description                                                          |
| ------------------- | ----- | ---------------------- | -------------------------------------------------------------------- |
| `--config <path>`   | `-c`  | `./lattice.config.yml` | Path to the YAML config file                                         |
| `--output <dir>`    | –     | `./context`            | Output directory for rendered entity context files                   |
| `--interval <ms>`   | –     | `5000`                 | Poll interval in milliseconds                                        |
| `--cleanup`         | –     | off                    | Enable orphan cleanup after each render cycle                        |
| `--no-orphan-dirs`  | –     | off                    | Skip removal of orphaned entity directories (requires `--cleanup`)   |
| `--no-orphan-files` | –     | off                    | Skip removal of orphaned files inside entity dirs (requires `--cleanup`) |
| `--protected <csv>` | –     | –                      | Comma-separated list of protected filenames (requires `--cleanup`)   |

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

## Global options

| Option      | Short | Description                        |
| ----------- | ----- | ---------------------------------- |
| `--help`    | `-h`  | Show help message                  |
| `--version` | `-v`  | Print the installed version number |

```sh
lattice --version   # → 0.4.0
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
      task_id: { type: uuid, ref: task }
      score: { type: integer, default: 0 }
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
# 0.4.0
```
