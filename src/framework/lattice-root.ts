import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, parse as parsePath } from 'node:path';

/**
 * The single `.lattice` root: one folder that holds everything Lattice needs
 * regardless of where it was installed — machine-local config, the workspace
 * registry, each workspace's database + owned blobs, and the rendered context
 * tree. Install Lattice anywhere; the root travels with the chosen location.
 *
 * On-disk layout:
 *
 *   .lattice/
 *   ├── .config/                     machine-local config (master.key, identity.json,
 *   │                                preferences.json, db-credentials.enc, keys/,
 *   │                                registry.json). The presence of `.config/` is the
 *   │                                root marker — NOT any `.lattice/manifest.json`, so a
 *   │                                render-output `.lattice/` is never mistaken for a root.
 *   └── Workspaces/
 *       └── <Workspace Name>/
 *           ├── Data/                database.db, backups, blobs/<sha256> (owned bytes)
 *           └── Context/             rendered SQL→markdown bridge (mirrors the DB)
 *
 * Resolution order (see {@link findLatticeRoot}):
 *   1. `LATTICE_ROOT` env override — used verbatim.
 *   2. Walk up from the start directory for a `.lattice/` whose `.config/` exists.
 *   3. No root found → the default *create* location is `<cwd>/.lattice` (NOT homedir);
 *      creation only happens through an explicit `ensureLatticeRoot()` call.
 */

/** Directory name of the root folder. */
export const ROOT_DIRNAME = '.lattice';
/** Config subdirectory inside the root — also the root marker. */
export const CONFIG_SUBDIR = '.config';
/** Workspaces subdirectory inside the root. */
export const WORKSPACES_SUBDIR = 'Workspaces';

/** True when `dir` is a `.lattice` root (i.e. it contains the `.config/` marker). */
function isRoot(dir: string): boolean {
  return existsSync(join(dir, CONFIG_SUBDIR));
}

/**
 * Discover the `.lattice` root without creating anything.
 *
 *   1. `LATTICE_ROOT` (verbatim) if set and non-empty.
 *   2. Walk up from `startDir` (default `cwd`): the first ancestor containing a
 *      `.lattice/` directory whose `.config/` marker exists wins.
 *
 * @returns the absolute path to the `.lattice` directory, or `null` if none.
 */
export function findLatticeRoot(startDir: string = process.cwd()): string | null {
  const override = process.env.LATTICE_ROOT;
  if (override && override.trim().length > 0) {
    return override;
  }

  let dir = startDir;
  const { root: fsRoot } = parsePath(dir);
  // Walk up until the filesystem root, inclusive.
  for (;;) {
    const candidate = join(dir, ROOT_DIRNAME);
    if (isRoot(candidate)) return candidate;
    if (dir === fsRoot) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Discover the root, falling back to the default create location
 * (`<startDir>/.lattice`) when none is found. Performs no writes.
 */
export function resolveLatticeRoot(startDir: string = process.cwd()): string {
  return findLatticeRoot(startDir) ?? join(startDir, ROOT_DIRNAME);
}

function chmod0700(dir: string): void {
  if (platform() === 'win32') return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort — restrictive perms are a hardening nicety, not a requirement
  }
}

/**
 * Resolve the root and ensure it (and its `.config/` marker) exist on disk.
 * Creates `<root>/` and `<root>/.config/` with restrictive permissions on POSIX.
 *
 * @returns the absolute path to the `.lattice` directory.
 */
export function ensureLatticeRoot(startDir: string = process.cwd()): string {
  const root = resolveLatticeRoot(startDir);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
    chmod0700(root);
  }
  const config = join(root, CONFIG_SUBDIR);
  if (!existsSync(config)) {
    mkdirSync(config, { recursive: true });
    chmod0700(config);
  }
  const workspaces = join(root, WORKSPACES_SUBDIR);
  if (!existsSync(workspaces)) {
    mkdirSync(workspaces, { recursive: true });
  }
  return root;
}

// ---------------------------------------------------------------------------
// Path helpers — the single source of truth for where things live in a root.
// ---------------------------------------------------------------------------

/** `<root>/.config` — machine-local config dir (absorbs the legacy `~/.lattice`). */
export function rootConfigDir(root: string): string {
  return join(root, CONFIG_SUBDIR);
}

/** `<root>/Workspaces` — container for all workspaces. */
export function workspacesDir(root: string): string {
  return join(root, WORKSPACES_SUBDIR);
}

/** `<root>/.config/registry.json` — workspace registry. */
export function registryPath(root: string): string {
  return join(rootConfigDir(root), 'registry.json');
}

/** `<root>/Workspaces/<dir>` — one workspace's folder. */
export function workspaceDir(root: string, dir: string): string {
  return join(workspacesDir(root), dir);
}

/** `<root>/Workspaces/<dir>/Data` — a workspace's data (db, backups, blobs). */
export function workspaceDataDir(root: string, dir: string): string {
  return join(workspaceDir(root, dir), 'Data');
}

/** `<root>/Workspaces/<dir>/Context` — a workspace's rendered context (render outputDir). */
export function workspaceContextDir(root: string, dir: string): string {
  return join(workspaceDir(root, dir), 'Context');
}

/** `<root>/Workspaces/<dir>/Data/blobs` — owned content-addressed bytes for a workspace. */
export function workspaceBlobsDir(root: string, dir: string): string {
  return join(workspaceDataDir(root, dir), 'blobs');
}

/** `<root>/Workspaces/<dir>/workspace.yml` — a workspace's config file. */
export function workspaceConfigPath(root: string, dir: string): string {
  return join(workspaceDir(root, dir), 'workspace.yml');
}
