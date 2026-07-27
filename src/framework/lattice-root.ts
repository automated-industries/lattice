import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, parse as parsePath, resolve as resolvePath } from 'node:path';

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
 * There are two different questions about roots, and they must not be confused:
 *
 *   - "Which root owns THIS path?" — answered by {@link findLatticeRoot} /
 *     {@link discoverLatticeRootUpward}: search upward from a concrete anchor
 *     (a config file's directory). Correct when you already hold the path.
 *   - "Which root should THIS SESSION serve?" — answered by
 *     {@link resolveSessionRoot}: the named root, or the home root. It never
 *     searches upward, because a session that adopts whatever root happens to
 *     sit above its working directory is one stray leftover away from opening —
 *     and serving — data nobody asked for.
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
 * Search UPWARD from `startDir` for a `.lattice/` whose `.config/` marker
 * exists. Ignores every override — this is the raw filesystem question ("which
 * root owns this path?"), used when the caller already holds a concrete anchor
 * such as a config file's directory.
 *
 * @returns the absolute path to the `.lattice` directory, or `null` if none.
 */
export function discoverLatticeRootUpward(startDir: string = process.cwd()): string | null {
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
 * Discover the `.lattice` root that owns `startDir`, without creating anything.
 *
 *   1. `LATTICE_ROOT` (verbatim) if set and non-empty.
 *   2. {@link discoverLatticeRootUpward} from `startDir` (default `cwd`).
 *
 * NOTE for callers picking a root for a *session*: use {@link resolveSessionRoot}
 * instead. This function answers "which root owns this path", and a session's
 * working directory is not a statement about which data it should serve.
 *
 * @returns the absolute path to the `.lattice` directory, or `null` if none.
 */
export function findLatticeRoot(startDir: string = process.cwd()): string | null {
  const override = process.env.LATTICE_ROOT;
  if (override && override.trim().length > 0) {
    return override;
  }
  return discoverLatticeRootUpward(startDir);
}

/** `<home>/.lattice` — the root every session uses unless another is named. */
export function homeLatticeRoot(): string {
  return join(homedir(), ROOT_DIRNAME);
}

/** How a session's root was chosen. `'home'` means it was inferred, not named. */
export type SessionRootSource = 'explicit' | 'env' | 'home';

export interface SessionRoot {
  /** Absolute path to the `.lattice` directory this session will use. */
  root: string;
  /** Where {@link root} came from. */
  source: SessionRootSource;
  /**
   * A DIFFERENT root that an upward search from the start directory would have
   * adopted, or `null`. Non-null only when the home default was used — i.e. only
   * when the answer actually changed — so callers can say once, out loud, which
   * root is no longer being picked up. Never a reason to block.
   */
  shadowed: string | null;
}

/**
 * Pick the root for a SESSION (a GUI server, a CLI command, an `openWorkspace`).
 *
 *   1. An explicitly named root (`--root`) — used verbatim.
 *   2. `LATTICE_ROOT` — used verbatim.
 *   3. `<home>/.lattice`.
 *
 * Deliberately NOT in that list: searching upward from the working directory. A
 * session picked that way serves whatever root happens to sit above where it was
 * launched, which can be a leftover belonging to entirely different data. A
 * repo-local root is still perfectly reachable — by naming it.
 */
export function resolveSessionRoot(
  opts: { explicitRoot?: string | undefined; startDir?: string | undefined } = {},
): SessionRoot {
  const explicit = opts.explicitRoot;
  if (explicit !== undefined && explicit.trim().length > 0) {
    return { root: explicit, source: 'explicit', shadowed: null };
  }
  const override = process.env.LATTICE_ROOT;
  if (override && override.trim().length > 0) {
    return { root: override, source: 'env', shadowed: null };
  }
  const root = homeLatticeRoot();
  // Only the home fallback changes what an upward search would have produced,
  // so it is the only case that has anything to report.
  const upward = discoverLatticeRootUpward(opts.startDir ?? process.cwd());
  const shadowed = upward !== null && resolvePath(upward) !== resolvePath(root) ? upward : null;
  return { root, source: 'home', shadowed };
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
  return ensureRootAt(resolveLatticeRoot(startDir));
}

/**
 * Ensure the root at EXACTLY `root` exists (with its `.config/` marker and
 * `Workspaces/`). No discovery, no fallback — the caller has already decided
 * which root it means, which is what {@link resolveSessionRoot} produces.
 */
export function ensureRootAt(root: string): string {
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
