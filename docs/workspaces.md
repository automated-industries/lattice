# Workspaces & auto-render

Lattice 1.16 introduces a single, discoverable on-disk home — the **`.lattice`
root** — that holds machine-local config, a workspace registry, each
workspace's database, and the rendered SQL→markdown context. It's entirely
opt-in: a bare `new Lattice(path)` is unaffected and pays no overhead.

## The `.lattice` root

A root is a directory containing a `.lattice/.config/` marker. Layout:

```
.lattice/
├── .config/                 # machine-local: registry, keys, preferences
│   └── registry.json        # the workspace registry (see below)
└── Workspaces/
    └── <Workspace Name>/
        ├── Data/            # database.db (local) + content-addressed blobs
        ├── Context/         # rendered SQL→markdown bridge output
        └── workspace.yml    # this workspace's config
```

- `resolveSessionRoot({ explicitRoot?, startDir? })` — the root a **session** serves.
  This is what `lattice gui`, the CLI, and `Lattice.openWorkspace()` use, so it is
  what you want in almost every case. See _Which root a session uses_ below.
- `ensureLatticeRoot(startDir?)` — resolve (creating if needed) the root that owns
  `startDir`: `LATTICE_ROOT` if it is set, otherwise the nearest root above
  `startDir`, otherwise one proposed beside it. That is a question about a **path**,
  not about a session; unless `LATTICE_ROOT` happens to be set, picking a session's
  root with it gives you a different registry than the one the app is reading.
- The root marker is the `.config/` directory; there is no manifest file.

### Which root a session uses

A **session** — `lattice gui`, `lattice init`, `lattice workspace`, the desktop
app, `Lattice.openWorkspace()` — uses, in order:

1. the root it was given (`--root <dir>`, or `openWorkspace({ root })`),
2. `LATTICE_ROOT`,
3. `~/.lattice`.

It does **not** search upward from the working directory. That search made the
data a session opened a function of where the process happened to start: a
`.lattice` left in a checkout months earlier would be picked up by any later,
unrelated run — along with its registry, its cloud workspaces, and the key
material needed to reach them. A project-local root is still perfectly usable;
it just has to be named:

```sh
lattice gui --root ./.lattice
```

When a root does exist above the working directory but is not the one being
opened, Lattice names it once at startup so the change in behaviour is visible
rather than silent.

In code, that order is `resolveSessionRoot({ explicitRoot?, startDir? })`, which
returns `{ root, source, shadowed }` — `source` being `'explicit' | 'env' | 'home'`,
and `shadowed` the root an upward search would have found instead, when there is
one. Resolve with it whenever you are choosing which data to open.

Searching upward is still the right question when you hold a concrete path (for
example, "which root owns this config file?"). The exported `findLatticeRoot(dir)`
and `ensureLatticeRoot(dir)` answer that; they are not how a session decides what
to serve. They agree with `resolveSessionRoot` when `LATTICE_ROOT` is set, and
diverge whenever it is not — which is how an embedder ends up writing to a registry
no session will ever read.

## Workspaces

A **workspace** is one database plus its rendered context, registered under the
root. Each has a stable UUID `id` (survives renames), a `displayName`, a
filesystem-safe `dir`, a `db` target (`./Data/database.db` or a
`postgres://…` URL), and a `kind` (`local` | `cloud`).

```ts
import { Lattice, resolveSessionRoot, addWorkspace } from 'latticesql';

// The same root the CLI, the GUI and `Lattice.openWorkspace()` serve — so the
// workspace you register here is the one they open.
const { root } = resolveSessionRoot();
const ws = addWorkspace(root, { displayName: 'Research' });
const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
```

`addWorkspace` creates the root (and its `Workspaces/`) if it is not there yet, so
there is nothing to scaffold first.

Registry helpers (all in the package root export):

| Function                                                | Purpose                                     |
| ------------------------------------------------------- | ------------------------------------------- |
| `resolveSessionRoot({ explicitRoot?, startDir? })`      | The root a session serves.                  |
| `addWorkspace(root, { displayName, db?, makeActive? })` | Scaffold + register a workspace.            |
| `listWorkspaces(root)`                                  | All registered workspaces.                  |
| `getWorkspace(root, id)` / `getActiveWorkspace(root)`   | Look up by id / the active one.             |
| `setActiveWorkspace(root, id)`                          | Change the active workspace.                |
| `resolveWorkspacePaths(root, ws)`                       | `{ dir, configPath, dataDir, contextDir }`. |

`Lattice.openWorkspace({ root?, workspaceId?, autoRender? })` opens the active
(or named) workspace, applies the canonical context layout for tables without
an explicit one, registers the framework's own tables (the file index, the secret
store, and the rest), runs `init()`, and — unless `autoRender: false` — enables
auto-render and writes the initial `Context/` tree. It also resolves the
encryption key from **the root it is opening**, so opening a root by argument and
the same root by `LATTICE_ROOT` read the same encrypted values.

### One workspace, three ways in

A workspace opened by a command, by the library, and by the browser must end up
with the SAME tables and the SAME layout. This is not tidiness: the `Context/`
tree is reconciled against a manifest of what the last render wrote, so an opener
that knows about fewer tables reads the difference as "these were removed" and
deletes them. Two openers that disagree take turns writing and destroying the same
files, and nothing reports it.

`openWorkspace` and the CLI both apply the same schema, so this holds by
construction. If you open a workspace by constructing a `Lattice` yourself —
against a workspace's `configPath` rather than through `openWorkspace` — apply it
yourself before `init()`, or do not reconcile from that handle:

```ts
import { Lattice, parseConfigFile, applyWorkspaceSchema } from 'latticesql';

const db = new Lattice({ config: paths.configPath }, { encryptionKey });
applyWorkspaceSchema(db, parseConfigFile(paths.configPath).tables);
await db.init();
```

As a backstop, a cleanup pass driven by a schema with **no tables at all** is
refused with a warning rather than performed — a schema that never loaded cannot
have dropped anything.

### First run & the zero-workspace state (3.3)

The registry tolerates **zero** workspaces. `lattice gui` no longer force-creates
a default "My Workspace": on a first launch with nothing to adopt (and after you
delete your **last** workspace) the GUI shows a full-screen **"Welcome to
Lattice"** screen with **Create a workspace** and **Join via invite** wizards
(identity-first; local, cloud-via-migrate, or join-by-token). In this state the
server has no active database — it serves the shell plus the workspace-management
and onboarding routes, and every data route answers `409` until you create or
join one. Creating/joining switches into the new workspace; the normal layout
returns on reload. The last workspace can now be deleted (it drops you back to the
welcome screen rather than being refused).

## Seamless GUI auto-update (3.4)

When `lattice gui` is launched from a published install (global or project-local npm install), it runs as a small supervisor that silently installs the latest published version before opening the browser. While you work, the supervisor keeps checking for updates in the background; when a new version lands it installs it and relaunches the server on the same port. The open tab reconnects, notices the version changed, and reloads onto the new build — **no manual refresh, no reinstall**.

A git checkout or `npx` copy is left untouched (auto-update is disabled there); a failed install surfaces in the GUI rather than being swallowed.

**HTTP endpoints** (for polling / UI integration):

| Route                | Method | Returns                   |
| -------------------- | ------ | ------------------------- |
| `/api/version`       | GET    | `{ version: string }`     |
| `/api/update/status` | GET    | Update state and progress |

## Auto-render (SQL → markdown)

`enableAutoRender(outputDir)` debounces a re-render on every
insert/update/delete, coalescing bursts into one render and skipping unchanged
files via the manifest hash-diff. Workspaces enable it by default, so the
`Context/` tree is always current and there is never a "no rendered context"
state.

A bare `new Lattice(path)` does **not** auto-render (`_scheduleAutoRender`
early-returns when no output dir is set) — call `render(dir)` / `reconcile(dir)`
manually, or opt in with `enableAutoRender(dir)`.

On open, a staleness gate decides whether the existing tree can be reused or must
be re-rendered. Alongside the data cursor (has anything the tree depends on
changed?), the manifest records a **render-output format version**. When a
release changes how the tree is derived or templated — i.e. the bytes a clean
render produces for unchanged data — that version is bumped, and the gate treats
any workspace whose manifest records an older version as stale. The result is a
**one-time full re-render on the first open after upgrading**, so a render-logic
fix reaches workspaces rendered by an older version automatically; once the
manifest is re-stamped, subsequent opens skip again when nothing has changed.

## File loopback (3.4)

When the GUI is serving a workspace, editing a rendered `.md` file on disk is automatically captured back into the database through the normal write path — so the change lands in the changelog (versioned/undoable) and appears live in the GUI, exactly as if the edit had been made there. Structured frontmatter and body `key: value` fields round-trip automatically; edits that can't be safely parsed (free-form or custom renders) are surfaced as a notice rather than guessed at, so a lossy render can't corrupt a row. Render echoes are suppressed via the manifest, so there is no write loop.

**For embedders**, `reverseSyncFromFiles()` exposes the same changelog-aware reverse-sync the GUI loopback uses:

```ts
import { Lattice } from 'latticesql';

const db = new Lattice(config);
await db.init();

// Round-trip frontmatter + body `key: value` edits from the rendered tree
// back into the DB. Pass `apply` to route each update through a versioned
// write (so a file edit is recorded exactly like a GUI edit).
const result = await db.reverseSyncFromFiles('./context', { useDefault: true });
```

`reverseSyncFromFiles(outputDir, opts)` compares file hashes against the current manifest (so a render-written file is recognized as an echo and skipped), parses the changed files, applies the updates, and returns a summary of what was applied.

The canonical `Context/` layout is DB-aligned and zero-config: table → folder,
row → subfolder, `<ENTITY>.md` plus relation rollups, derived from the schema
via `deriveCanonicalContexts`.

## CLI

```bash
lattice init                 # scaffold a root + default workspace, render the tree
lattice workspace list       # list workspaces (the active one is marked *)
lattice workspace create <name>          # or: create --name "<display name>"
lattice workspace use <name-or-id>       # the display name, or the stable UUID
lattice workspace rename <name-or-id> --name "<new name>"
lattice workspace delete <name-or-id> --yes   # remove it, and the files it owned
lattice gui                  # opens the active workspace when a root is present
```

`use` takes the display name straight out of `workspace list`, matched
case-insensitively; a name shared by two workspaces is refused with both ids
rather than resolved to one of them. Pass the UUID when you want a reference that
survives a rename — that is the form to use in a script. Every one of these takes
`--root <dir>` to work against a root other than the default.

`rename` writes both places a workspace name lives — the `name:` key in its own
configuration and the display name in the registry the switcher reads. Writing one
without the other is the failure that looks like success, so it does both and says
so when there was no registry record to update (a workspace opened on a plain
configuration outside any root has none, which is fine).

`delete` requires `--yes`. There is no prompt, on purpose: these commands exist so
the work can run unattended, and a prompt in that setting is a hang rather than a
safeguard. What it removes depends on the kind of workspace — a scaffolded one
loses its folder, one whose files you only ever pointed at keeps all of them, and a
shared one loses its local pointer AND the credentials this machine kept in order
to reconnect. The shared database itself is never touched.

## The databases inside a workspace

A workspace holds a set of database configs in one directory and opens one at a
time. `lattice database` manages that set; `lattice workspace` manages the
workspaces themselves.

```bash
lattice database list                          # the set, active one marked *
lattice database create <name>                 # or: create --name "<name>"
lattice database delete <name-or-path> --yes   # its config, and its local store
```

Every verb takes `--config <path>` to name the workspace (the active one by
default) and `--root <dir>` for the root holding it. `delete` accepts the label
printed by `list` as well as a path, refuses anything outside this workspace's own
set rather than unlinking it, and refuses to remove the LAST database — a workspace
that opens into nothing is not a state worth reaching. Remove the workspace instead
if that is what you meant.
