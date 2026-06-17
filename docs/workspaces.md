# Workspaces & auto-render

Lattice 1.16 introduces a single, discoverable on-disk home — the **`.lattice`
root** — that holds machine-local config, a workspace registry, each
workspace's database, and the rendered SQL→markdown context. It's entirely
opt-in: a bare `new Lattice(path)` is unaffected and pays no overhead.

## The `.lattice` root

A root is the first ancestor directory containing `.lattice/.config/`, or the
path in the `LATTICE_ROOT` environment variable. Layout:

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

- `ensureLatticeRoot(startDir?)` — resolve (creating if needed) the root.
- The root marker is the `.config/` directory; there is no manifest file.

## Workspaces

A **workspace** is one database plus its rendered context, registered under the
root. Each has a stable UUID `id` (survives renames), a `displayName`, a
filesystem-safe `dir`, a `db` target (`./Data/database.db` or a
`postgres://…` URL), and a `kind` (`local` | `cloud`).

```ts
import { Lattice, ensureLatticeRoot, addWorkspace } from 'latticesql';

const root = ensureLatticeRoot();
const ws = addWorkspace(root, { displayName: 'Research' });
const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
```

Registry helpers (all in the package root export):

| Function                                                | Purpose                                     |
| ------------------------------------------------------- | ------------------------------------------- |
| `addWorkspace(root, { displayName, db?, makeActive? })` | Scaffold + register a workspace.            |
| `listWorkspaces(root)`                                  | All registered workspaces.                  |
| `getWorkspace(root, id)` / `getActiveWorkspace(root)`   | Look up by id / the active one.             |
| `setActiveWorkspace(root, id)`                          | Change the active workspace.                |
| `resolveWorkspacePaths(root, ws)`                       | `{ dir, configPath, dataDir, contextDir }`. |

`Lattice.openWorkspace({ root?, workspaceId?, autoRender? })` opens the active
(or named) workspace, applies the canonical context layout for tables without
an explicit one, runs `init()`, and — unless `autoRender: false` — enables
auto-render and writes the initial `Context/` tree.

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
lattice workspace list       # list workspaces
lattice workspace create <name>
lattice workspace use <name>
lattice gui                  # opens the active workspace when a root is present
```
