import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ensureLatticeRoot, findLatticeRoot } from './lattice-root.js';
import { importLegacyUserConfig } from './migrate-to-root.js';
import {
  addAdoptedWorkspace,
  findWorkspaceByConfigPath,
  getActiveWorkspace,
  listWorkspaces,
  resolveWorkspacePaths,
  type WorkspaceRecord,
} from './workspace.js';

/**
 * GUI bootstrap — the `.lattice` root + workspace model is universal for the
 * GUI/CLI app. Every `lattice gui` launch ensures a root exists and the opened
 * config is registered as a workspace, so there is exactly ONE switchable list
 * (the registry) and no "database mode" fallback. The library API
 * (`new Lattice(config)`) and headless commands deliberately do NOT call this —
 * they keep working on a bare config / URL with no root.
 *
 * Adoption is non-destructive: an existing config + db is referenced where it
 * already lives (see {@link addAdoptedWorkspace}); nothing is moved.
 */

export interface GuiBootstrap {
  root: string;
  /** Active workspace id, or NULL in the zero-workspace "virgin" state. */
  workspaceId: string | null;
  /** Friendly name of the active workspace (empty in the virgin state). */
  displayName: string;
  /** Absolute config path of the active workspace, or NULL when virgin. */
  configPath: string | null;
  /** Absolute render output dir for the active workspace, or NULL when virgin. */
  contextDir: string | null;
}

/**
 * Mirror of the GUI's output-dir convention (kept here to avoid a framework→gui
 * import): prefer an existing rendered tree (`context`/`.`/`generated` holding a
 * `.lattice/manifest.json`), else default to `<configdir>/context`.
 */
export function resolveContextDirForConfig(configPath: string): string {
  const base = dirname(resolve(configPath));
  for (const dir of ['context', '.', 'generated']) {
    const abs = resolve(base, dir);
    if (existsSync(join(abs, '.lattice', 'manifest.json'))) return abs;
  }
  return resolve(base, 'context');
}

/**
 * Read a YAML file and return its `db:` (raw, as written) + optional `name:`
 * when it looks like a Lattice config (a string `db` and an object `entities`).
 * Returns null otherwise so non-config YAML is never adopted.
 */
function readConfigMeta(absPath: string): { db: string; name?: string } | null {
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const cfg = parsed as Record<string, unknown>;
  if (typeof cfg.db !== 'string' || !cfg.db.trim()) return null;
  if (!cfg.entities || typeof cfg.entities !== 'object' || Array.isArray(cfg.entities)) return null;
  const name = typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : undefined;
  return name !== undefined ? { db: cfg.db.trim(), name } : { db: cfg.db.trim() };
}

/** Display name fallback derived from a config filename. */
function nameFromConfigPath(absPath: string): string {
  return basename(absPath).replace(/\.(config\.)?ya?ml$/i, '') || 'Workspace';
}

/**
 * Adopt an existing config as a workspace, referencing its file + db in place.
 * Idempotent (returns the existing record if already adopted). Returns null when
 * the path isn't a readable Lattice config.
 */
export function adoptConfigAsWorkspace(
  root: string,
  configPath: string,
  opts?: { makeActive?: boolean; displayName?: string },
): WorkspaceRecord | null {
  const abs = resolve(configPath);
  const meta = readConfigMeta(abs);
  if (!meta) return null;
  return addAdoptedWorkspace(root, {
    displayName: opts?.displayName ?? meta.name ?? nameFromConfigPath(abs),
    db: meta.db,
    configPath: abs,
    contextDir: resolveContextDirForConfig(abs),
    makeActive: opts?.makeActive ?? false,
  });
}

/**
 * Import any stray sibling configs (e.g. joined-team configs written by an older
 * binary that never registered a workspace) into the registry. Idempotent and
 * non-destructive — it only adds registry records, never moves or deletes files.
 * This is the boot-time fix that makes already-joined cloud workspaces appear in
 * the header switcher.
 */
export function reconcileWorkspaceRegistry(root: string, scanDirs: readonly string[]): void {
  const seen = new Set<string>();
  for (const dir of scanDirs) {
    const abs = resolve(dir);
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const fname of entries) {
      if (!fname.endsWith('.yml') && !fname.endsWith('.yaml')) continue;
      const full = join(abs, fname);
      if (findWorkspaceByConfigPath(root, full)) continue;
      // adoptConfigAsWorkspace validates + is a no-op for non-configs.
      adoptConfigAsWorkspace(root, full, { makeActive: false });
    }
  }
}

/**
 * Ensure a `.lattice` root for the GUI and resolve the active workspace to open.
 * Creates a root if none exists (in the config's directory when a config file is
 * present, else `startDir`), adopts the launch config as a workspace, reconciles
 * stray sibling configs, and guarantees at least one workspace exists.
 */
export function ensureRootForGui(opts: {
  startDir: string;
  configPath: string;
  /** True when the user passed `--config` explicitly (not the default). */
  explicitConfig: boolean;
  displayName?: string;
}): GuiBootstrap {
  const configAbs = resolve(opts.configPath);
  const hasConfigFile = existsSync(configAbs);

  let root = findLatticeRoot(opts.startDir);
  if (!root && hasConfigFile) root = findLatticeRoot(dirname(configAbs));
  let freshRoot = false;
  if (!root) {
    root = ensureLatticeRoot(hasConfigFile ? dirname(configAbs) : opts.startDir);
    freshRoot = true;
  }
  // No-op when the root's `.config` is already initialized.
  importLegacyUserConfig(root);

  // Adopt + activate the launch config when the user explicitly asked for it,
  // when we just created the root, or when there's no active workspace yet.
  if (hasConfigFile && (opts.explicitConfig || freshRoot || getActiveWorkspace(root) === null)) {
    adoptConfigAsWorkspace(root, configAbs, {
      makeActive: true,
      ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
    });
  }

  // Best-effort: pull in stray sibling configs near the launch config + the root.
  reconcileWorkspaceRegistry(root, [dirname(configAbs), dirname(root)]);

  // Resolve the active workspace WITHOUT force-creating one. When there is no
  // config to adopt and no existing workspace, return a virgin (zero-workspace)
  // bootstrap — the GUI then shows its first-run "Welcome to Lattice" screen
  // (create / join) instead of an auto-created "My Workspace". The registry
  // already tolerates zero workspaces (activeWorkspaceId may be null).
  const ws = getActiveWorkspace(root) ?? listWorkspaces(root)[0] ?? null;
  if (!ws) {
    return { root, workspaceId: null, displayName: '', configPath: null, contextDir: null };
  }
  const paths = resolveWorkspacePaths(root, ws);
  return {
    root,
    workspaceId: ws.id,
    displayName: ws.displayName,
    configPath: paths.configPath,
    contextDir: paths.contextDir,
  };
}
