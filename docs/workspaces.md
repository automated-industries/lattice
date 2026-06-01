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

## Auto-render (SQL → markdown)

`enableAutoRender(outputDir)` debounces a re-render on every
insert/update/delete, coalescing bursts into one render and skipping unchanged
files via the manifest hash-diff. Workspaces enable it by default, so the
`Context/` tree is always current and there is never a "no rendered context"
state.

A bare `new Lattice(path)` does **not** auto-render (`_scheduleAutoRender`
early-returns when no output dir is set) — call `render(dir)` / `reconcile(dir)`
manually, or opt in with `enableAutoRender(dir)`.

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
