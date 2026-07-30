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
    - [Which root gets opened](#which-root-gets-opened)
    - [Serving on a network](#serving-on-a-network---host----allow-remote)
- [Cloud](#cloud)
  - [`lattice cloud`](#lattice-cloud)
  - [From the library](#from-the-library)
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

| Option            | Short | Default                | Description                                                   |
| ----------------- | ----- | ---------------------- | ------------------------------------------------------------- |
| `--config <path>` | `-c`  | `./lattice.config.yml` | Path to the YAML config file                                  |
| `--output <dir>`  | –     | `./context`            | Output directory (used by the relationship graph)             |
| `--port <number>` | –     | `4317`                 | Localhost port; auto-increments when the port is busy         |
| `--no-open`       | –     | off                    | Print the URL without opening a browser                       |
| `--root <dir>`    | –     | `~/.lattice`           | The `.lattice` root to open (see _Which root gets opened_)    |
| `--host <addr>`   | –     | `127.0.0.1`            | Bind address. Anything non-loopback is a network exposure     |
| `--allow-remote`  | –     | off                    | Permit a non-loopback bind (also requires `--root` + a `y`)   |
| `--yes`           | `-y`  | off                    | Accept the exposure disclosure without being asked (scripted) |

**Example:**

```sh
lattice gui --config ./lattice.config.yml
```

```
Lattice GUI listening at http://127.0.0.1:4317
Press Ctrl+C to stop.
```

#### Which root gets opened

A session opens the root you **name** — `--root <dir>`, or the `LATTICE_ROOT`
environment variable — and otherwise `~/.lattice`. It does **not** search upward
from the current directory for a `.lattice/.config`.

That search used to be the default, and it meant the workspace you got depended
on where your shell happened to be: run the GUI inside a checkout that still held
a `.lattice` from some earlier experiment and you would open _that_ registry's
workspaces, including any cloud workspace and its stored credentials, without
having asked for it.

A root inside a project still works — name it:

```sh
lattice gui --root ./.lattice
```

If a root does exist above your current directory, Lattice says so once at
startup and names it, so a habit built on the old behaviour doesn't quietly land
you in an empty workspace. It is a notice, not a prompt.

#### Serving on a network (`--host` / `--allow-remote`)

The GUI's data routes are **unauthenticated**. On the loopback that is a
reasonable trade; on any other address it publishes read, write and delete access
to everything in the open workspace. So a non-loopback bind requires all three of:

1. `--allow-remote`,
2. an explicitly named `--root` (Lattice will not guess which data to publish),
3. a typed `y` at the confirmation.

Before asking, it prints exactly what is about to be served — the resolved root,
the workspace name and kind, its config path, the address, and the fact that
there is no login. If the workspace is a **cloud** workspace it says so
prominently: the data at risk then belongs to everyone on that shared database,
not only to you.

```
About to serve Lattice on a NON-LOOPBACK address.
  Address:   http://0.0.0.0:4317/
  Root:      /home/you/.lattice
  Workspace: "Field Notes" (local)
  Config:    /home/you/.lattice/Workspaces/Field Notes/workspace.yml

This server is UNAUTHENTICATED. There is no login: anyone who can reach
0.0.0.0:4317 can read, change and delete everything in that workspace.

Serve this workspace on the network? [y/N]
```

`--yes` skips the question for scripted use. It never skips the disclosure, and
it is never the default — a piped invocation with no terminal is refused rather
than treated as consent.

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

**HTTP surface** (all routes scoped to `http://<host>:<port>/api`, where `<host>`
is `127.0.0.1` unless you deliberately bind elsewhere — see _Serving on a
network_ above):

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
page. **These routes implement no authentication at all.** The server binds to
`127.0.0.1` by default, which is what makes that acceptable: it's intended for
local development against a config you trust. Binding anywhere else publishes
read, write and delete access to everyone who can reach the address, which is why
`--host` requires `--allow-remote`, a named `--root`, and a typed confirmation
(see _Serving on a network_ above, and [security.md](security.md)).

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

## Cloud

A Lattice cloud is a shared Postgres database secured by Postgres Row-Level
Security. There is **no server process to run** — no `lattice serve` — and
nothing to bootstrap: members connect straight to the database as the scoped
role the owner provisioned for them.

Running one is a command, a click in `lattice gui`, or a function call, and all
three do the same thing. **You never need to start the GUI, and you never need
to bind it to a network address, to administer a cloud.**

### `lattice cloud`

```sh
lattice cloud <verb> [options]
```

| Verb                       | What it does                                                                 |
| -------------------------- | ---------------------------------------------------------------------------- |
| `status`                   | Owner or member, whether row security is installed, and anything unprotected |
| `members`                  | Who is on this cloud — the owner, joined members, and pending invites        |
| `secure`                   | Turn this Postgres into a cloud (owner only). Idempotent                     |
| `invite --email <address>` | Provision a scoped role and print its invite token, once                     |
| `join --token <token>`     | Redeem an invite and land in a NEW workspace                                 |
| `revoke <member>`          | Remove somebody, named by role, email, or display name                       |
| `share --table … --pk … …` | Change who can see one row                                                   |
| `migrate --url-stdin`      | Move this local workspace onto a shared database                             |
| `probe --url-stdin`        | Check a database before pointing a workspace at it                           |

`status` is the one to reach for first, and the reason the group exists: the
answer to "why is this workspace broken" used to live only in the browser app,
which is the thing that stops working when the answer is bad. It changes
nothing, so a damaged cloud can be inspected without also being altered.

**Options:**

| Option             | Short | Default              | Description                                                 |
| ------------------ | ----- | -------------------- | ----------------------------------------------------------- |
| `--config <path>`  | `-c`  | the active workspace | Which workspace to operate on                               |
| `--root <dir>`     | –     | `~/.lattice`         | The `.lattice` root holding it                              |
| `--json`           | –     | off                  | Machine-readable output (`status`, `members`, `probe`)      |
| `--email <addr>`   | –     | –                    | The invitee (`invite`); who the invite was sent to (`join`) |
| `--token <token>`  | –     | –                    | The invite being redeemed, for `join`                       |
| `--name <label>`   | –     | –                    | Name for the workspace, for `join` and `migrate`            |
| `--table <name>`   | –     | –                    | The row's table, for `share`                                |
| `--pk <value>`     | –     | –                    | The row's primary key, for `share`                          |
| `--visibility <v>` | –     | –                    | `private` or `everyone`, for `share`                        |
| `--to <member>`    | –     | –                    | Share with one person instead of setting a visibility       |
| `--revoke`         | –     | off                  | With `--to`, take the access away instead of giving it      |
| `--url-stdin`      | –     | off                  | Read the connection string from stdin (`migrate`, `probe`)  |

**Example:**

```sh
# The owner, on the machine that has the workspace today:
lattice cloud migrate --url-stdin < db-url.txt   # or: ... | lattice cloud migrate -
lattice cloud invite --email bob@example.com     # prints the token once
lattice cloud members
lattice cloud share --table notes --pk n-42 --to bob@example.com
lattice cloud revoke bob@example.com

# Bob, on a machine that has never seen this database:
lattice cloud join --token <the-token> --email bob@example.com
lattice cloud status
```

**Never put the connection string in the command itself.** It contains the owner
password — the role that can create members — and an argument is public on the
machine it runs on: any other user can read it out of the process list while the
command runs, and your shell writes it into its history file afterwards. That is
the same class of exposure this whole command group exists to remove, so `migrate`
and `probe` take the URL three ways: `--url-stdin` (or `-` in place of the URL)
reads it from standard input, the `LATTICE_CLOUD_URL` environment variable is read
when nothing was typed, and the plain argument still works but prints a warning,
because a password that has been in a process list has to be treated as exposed.

Two things about `invite`: the token IS the credential — it is bound to that
email address, it expires in about a week, and it is never stored, so the single
printing is the only one there will be. And `share --visibility` (who can see the
row at all) and `share --to` (one named person) are separate operations; passing
both is refused rather than resolved, because silently picking one is how a row
ends up shared with everybody.

`join` needs no workspace to already exist — it makes one, creating the
`.lattice` root if the machine has none. It never repoints the workspace you
already have open, and `--email` defaults to this machine's identity, because
the address is half of what decrypts the token rather than a lookup. A token
that has already been spent, was revoked, or has expired is refused _before_ any
workspace is created, so there is nothing half-made to clean up.

`migrate` moves the workspace you are in: it copies every row into the target,
builds its search indexes, installs row security, publishes the layout members
render with, and only then repoints this workspace's config, updates the
registry, and renames the local database file to `<db>.local-bak`. Those last
three are one reversible sequence — if any of them fails, all of them are undone
and you are left exactly where you started, with a loud error rather than a
half-moved workspace. It refuses a target that is already somebody's cloud
(join it instead), and it keeps the local file rather than deleting it. The
connection is stored under the name you pass to `--name`, or the target database's
own name when you do not — and if that name is already stored for a DIFFERENT
database it is given a numbered variant instead, because reusing it would point
whichever workspace already read that name at this database. The name actually
used is printed.

### From the library

Every verb above is a plain function call:

```ts
import {
  Lattice,
  // Where do I stand on this cloud? Is anything left unprotected? Read-only.
  cloudStatus,
  // Secure a Postgres database as a cloud — and keep it secured as it grows.
  // secureNewCloudTable covers a table created after the fact; without it that
  // table has row security off. publishSharedSchema hands members the layout
  // their own workspace renders with.
  secureCloud,
  secureNewCloudTable,
  reconcileCloudMemberAccess,
  publishSharedSchema,
  // Move a local workspace in. migrateWorkspaceToCloud is the whole move: copy
  // the rows into the target and secure it — then repoint the config and update
  // the registry and retire the local file as one reversible sequence. Any
  // failure in that last part undoes all of it. cutOverWorkspaceToCloud is that
  // last part on its own for data copied some other way.
  probeCloud,
  migrateWorkspaceToCloud,
  cutOverWorkspaceToCloud,
  openTargetLatticeForMigration,
  migrateLatticeData,
  archiveLocalSqlite,
  // Invite someone: provision a scoped role and mint the single email-bound
  // token that carries its credential. Then see who is on the cloud — and take
  // someone off it.
  inviteMember,
  listCloudMembers,
  removeMember,
  // Join. redeemCloudInvite takes an email and a token and leaves you with a
  // working workspace; joinCloud is the same path for credentials handed over
  // directly. Pass your own createCloudWorkspace to hook the new workspace into
  // a session that already has a database open.
  redeemCloudInvite,
  joinCloud,
  createCloudWorkspace,
  // Decide who sees which rows. shareRow sets a row's audience; grantRowAccess
  // gives (or takes back) one person's access to it; batchRowAccess settles a
  // whole audience in one call. Use these — a shared dashboard has to drag the
  // data it reads along with it, and these are the versions that do. The raw
  // database calls underneath do not, so a dashboard shared with them opens to
  // an empty page for the recipient.
  shareRow,
  grantRowAccess,
  batchRowAccess,
} from 'latticesql';
```

The steps each of those is built from are exported too, for a caller assembling
its own variant: `mintInviteToken` / `redeemInviteToken` / `claimMemberInvite`
for the token itself, `memberRoleName` / `generateMemberPassword` /
`provisionMemberRole` / `assertScopedMemberRole` / `revokeMemberRole` for the
role behind it, and `setRowVisibility` / `grantRow` / `revokeRow` /
`batchRowGrants` for the bare row-access calls. Those last four are single
database calls and nothing more: they change who may read the named row and stop
there. Reach for one only when you are handling the follow-on yourself.

**None of this grants authority the GUI does not.** Permission is the Postgres
role you connect as, not a session the caller can set: the owner checks read
`rolcreaterole` for the live role, and every mutating step is a `SECURITY
DEFINER` function that raises for a member. A member running `lattice cloud
invite` — or calling `inviteMember` — is refused by the database, whether the
call came from a browser, a script, or a command line.

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
