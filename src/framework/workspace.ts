import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import {
  registryPath,
  rootConfigDir,
  workspaceConfigPath,
  workspaceContextDir,
  workspaceDataDir,
  workspaceDir,
  workspacesDir,
} from './lattice-root.js';

/**
 * A workspace = one database + its config + its rendered context, living under
 * a single `.lattice` root. Multiple workspaces coexist under one root; the
 * registry tracks them and which one is active.
 */
export interface WorkspaceRecord {
  /** Stable id (never shown to users; survives renames). */
  id: string;
  /** Friendly name shown in the UI, e.g. "Owner's Workspace". */
  displayName: string;
  /**
   * Filesystem-safe folder name under `Workspaces/`. Derived from
   * {@link displayName} but kept human-legible (spaces/apostrophes preserved
   * where the OS allows). The registry is the source of truth for the
   * displayName↔dir↔id mapping, so a rename never breaks paths.
   */
  dir: string;
  /**
   * The `db:` target as written in `workspace.yml`. A relative path
   * (`./Data/database.db`) for local workspaces, or a `postgres://…` URL /
   * `${LATTICE_DB:label}` reference for cloud workspaces.
   */
  db: string;
  /** `'local'` (SQLite under Data/) or `'cloud'` (rows live in a remote DB). */
  kind: 'local' | 'cloud';
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /**
   * Absolute path to this workspace's config file when it was *adopted in
   * place* rather than scaffolded under `Workspaces/<dir>/`. Set when the GUI
   * adopts an existing `lattice.config.yml` or a joined-team sibling config so
   * the workspace references the user's existing file/db where it already lives
   * (non-destructive). Absent for scaffolded workspaces (the default), whose
   * config path is derived from {@link dir}.
   */
  configPath?: string;
  /**
   * Absolute render output dir for an adopted-in-place workspace (where its
   * Context/ tree already lives). Absent for scaffolded workspaces.
   */
  contextDir?: string;
}

export interface WorkspaceRegistry {
  version: 1;
  activeWorkspaceId: string | null;
  workspaces: WorkspaceRecord[];
}

const EMPTY_REGISTRY: WorkspaceRegistry = {
  version: 1,
  activeWorkspaceId: null,
  workspaces: [],
};

/** Default relative `db:` for a local workspace. */
export const LOCAL_DB_RELPATH = './Data/database.db';

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

const ILLEGAL_DIR_CHARS = '<>:"/\\|?*';

/**
 * Turn a friendly display name into a filesystem-safe folder name while
 * keeping it legible: spaces and apostrophes survive; control characters and
 * characters that are illegal on common filesystems (path separators, the
 * reserved set `<>:"/\|?*`) are stripped, and reserved Windows names are
 * suffixed. Never returns an empty string.
 */
export function toSafeDirName(displayName: string): string {
  let name = '';
  for (const ch of displayName) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) continue; // strip control characters
    if (ILLEGAL_DIR_CHARS.includes(ch)) continue; // strip filesystem-illegal characters
    name += ch;
  }
  name = name
    .replace(/\s+/g, ' ') // collapse whitespace runs
    .trim()
    .replace(/[.\s]+$/u, ''); // no trailing dots/spaces (Windows)
  if (name.length === 0) name = 'Workspace';
  if (WINDOWS_RESERVED.has(name.toLowerCase())) name = `${name}-ws`;
  return name;
}

/** Derive a dir name unique among `existing` by appending ` (2)`, ` (3)`, … */
function uniqueDirName(displayName: string, existing: ReadonlySet<string>): string {
  const base = toSafeDirName(displayName);
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${String(n)})`;
    if (!existing.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Registry I/O — crash-safe write (temp + rename).
// ---------------------------------------------------------------------------

export function readRegistry(root: string): WorkspaceRegistry {
  const path = registryPath(root);
  if (!existsSync(path)) return { ...EMPTY_REGISTRY, workspaces: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`Lattice: corrupt workspace registry at "${path}": ${(e as Error).message}`);
  }
  const reg = parsed as Partial<WorkspaceRegistry>;
  return {
    version: 1,
    activeWorkspaceId: reg.activeWorkspaceId ?? null,
    workspaces: Array.isArray(reg.workspaces) ? reg.workspaces : [],
  };
}

export function writeRegistry(root: string, registry: WorkspaceRegistry): void {
  const path = registryPath(root);
  const tmp = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

export function listWorkspaces(root: string): WorkspaceRecord[] {
  return readRegistry(root).workspaces;
}

export function getWorkspace(root: string, id: string): WorkspaceRecord | null {
  return listWorkspaces(root).find((w) => w.id === id) ?? null;
}

export function getActiveWorkspace(root: string): WorkspaceRecord | null {
  const reg = readRegistry(root);
  if (!reg.activeWorkspaceId) return reg.workspaces[0] ?? null;
  return reg.workspaces.find((w) => w.id === reg.activeWorkspaceId) ?? reg.workspaces[0] ?? null;
}

export function setActiveWorkspace(root: string, id: string): void {
  const reg = readRegistry(root);
  if (!reg.workspaces.some((w) => w.id === id)) {
    throw new Error(`Lattice: no workspace with id "${id}" in registry`);
  }
  reg.activeWorkspaceId = id;
  writeRegistry(root, reg);
}

// ---------------------------------------------------------------------------
// Resolved paths
// ---------------------------------------------------------------------------

export interface WorkspacePaths {
  /** `<root>/Workspaces/<dir>` */
  dir: string;
  /** `<root>/Workspaces/<dir>/workspace.yml` */
  configPath: string;
  /** `<root>/Workspaces/<dir>/Data` */
  dataDir: string;
  /** `<root>/Workspaces/<dir>/Context` — the render outputDir for this workspace. */
  contextDir: string;
}

export function resolveWorkspacePaths(root: string, ws: WorkspaceRecord): WorkspacePaths {
  // Adopted-in-place workspaces reference the user's existing config + db where
  // they already live; their paths come from the record, not the scaffold layout.
  if (ws.configPath) {
    const dir = dirname(ws.configPath);
    return {
      dir,
      configPath: ws.configPath,
      dataDir: join(dir, 'Data'),
      contextDir: ws.contextDir ?? resolve(dir, 'context'),
    };
  }
  return {
    dir: workspaceDir(root, ws.dir),
    configPath: workspaceConfigPath(root, ws.dir),
    dataDir: workspaceDataDir(root, ws.dir),
    contextDir: workspaceContextDir(root, ws.dir),
  };
}

/** The effective config path for a record (in-place override or scaffold path). */
export function effectiveConfigPath(root: string, ws: WorkspaceRecord): string {
  return ws.configPath ?? workspaceConfigPath(root, ws.dir);
}

/** Find a registry record whose effective config path resolves to `configPath`. */
export function findWorkspaceByConfigPath(
  root: string,
  configPath: string,
): WorkspaceRecord | null {
  const target = resolve(configPath);
  return (
    listWorkspaces(root).find((w) => resolve(effectiveConfigPath(root, w)) === target) ?? null
  );
}

// ---------------------------------------------------------------------------
// Config scaffolding
// ---------------------------------------------------------------------------

export function isCloudDb(db: string): boolean {
  const trimmed = db.trim();
  return /^postgres(ql)?:\/\//i.test(trimmed) || trimmed.startsWith('${LATTICE_DB:');
}

/** A minimal, valid starter `workspace.yml` (same schema as `lattice.config.yml`). */
export function defaultWorkspaceYaml(displayName: string, db: string): string {
  // entities is required by the config parser; an empty object is valid and
  // means "no user tables yet" — the workspace still renders a valid (empty)
  // Context/ tree so there is never a "no rendered context" state.
  const safeName = displayName.replace(/"/g, '\\"');
  return `name: "${safeName}"\ndb: ${db}\nentities: {}\n`;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface AddWorkspaceOptions {
  /** Friendly name. Required. */
  displayName: string;
  /**
   * The `db:` target. Defaults to a local SQLite db under the workspace's
   * `Data/` directory. Pass a `postgres://…` URL or `${LATTICE_DB:label}`
   * reference for a cloud workspace.
   */
  db?: string;
  /** Make this the active workspace (default: true when it is the first one). */
  makeActive?: boolean;
}

/**
 * Register a new workspace under `root`: scaffolds `Workspaces/<dir>/{Data,Context}`,
 * writes a starter `workspace.yml`, and records it in the registry. Does NOT
 * open the database or render — callers (init / openWorkspace) do that so the
 * initial auto-render happens against a live Lattice instance.
 */
export function addWorkspace(root: string, opts: AddWorkspaceOptions): WorkspaceRecord {
  if (!existsSync(rootConfigDir(root))) {
    mkdirSync(rootConfigDir(root), { recursive: true });
  }
  if (!existsSync(workspacesDir(root))) {
    mkdirSync(workspacesDir(root), { recursive: true });
  }

  const reg = readRegistry(root);
  const existingDirs = new Set(reg.workspaces.map((w) => w.dir));
  const dir = uniqueDirName(opts.displayName, existingDirs);
  const db = opts.db ?? LOCAL_DB_RELPATH;
  const record: WorkspaceRecord = {
    id: uuidv4(),
    displayName: opts.displayName,
    dir,
    db,
    kind: isCloudDb(db) ? 'cloud' : 'local',
    createdAt: new Date().toISOString(),
  };

  // Scaffold the directory tree.
  const paths = resolveWorkspacePaths(root, record);
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.contextDir, { recursive: true });
  if (!existsSync(paths.configPath)) {
    writeFileSync(paths.configPath, defaultWorkspaceYaml(opts.displayName, db), 'utf-8');
  }

  reg.workspaces.push(record);
  const makeActive = opts.makeActive ?? reg.activeWorkspaceId === null;
  if (makeActive) reg.activeWorkspaceId = record.id;
  writeRegistry(root, reg);

  return record;
}

/** Absolute path to a workspace's local SQLite db (only meaningful for `kind:'local'`). */
export function workspaceDbPath(root: string, ws: WorkspaceRecord): string {
  return join(workspaceDataDir(root, ws.dir), 'database.db');
}

// ---------------------------------------------------------------------------
// Adopt-in-place + cloud registration + remove
//
// These keep the registry the single source of truth for *every* switchable
// database — local or cloud, scaffolded or adopted-in-place — so the header
// workspace switcher and Settings show one consistent list.
// ---------------------------------------------------------------------------

export interface AdoptWorkspaceOptions {
  displayName: string;
  /** The `db:` value as written in the adopted config (path / URL / `${LATTICE_DB:label}`). */
  db: string;
  /** Absolute path to the existing config file to reference in place. */
  configPath: string;
  /** Absolute render output dir for the config (where its Context/ already lives). */
  contextDir: string;
  makeActive?: boolean;
}

/**
 * Register an EXISTING config as a workspace without scaffolding or moving any
 * files — the record points at the config + db where they already live. Used by
 * the GUI bootstrap to make every install a `.lattice` install (decision: the
 * `.lattice`/workspace model is universal for the GUI) and by the join flow to
 * register a joined cloud DB. Idempotent: if a record already references this
 * config path, it is returned unchanged (only re-activated if requested).
 */
export function addAdoptedWorkspace(root: string, opts: AdoptWorkspaceOptions): WorkspaceRecord {
  if (!existsSync(rootConfigDir(root))) {
    mkdirSync(rootConfigDir(root), { recursive: true });
  }
  const existing = findWorkspaceByConfigPath(root, opts.configPath);
  if (existing) {
    if (opts.makeActive) setActiveWorkspace(root, existing.id);
    return existing;
  }
  const reg = readRegistry(root);
  const existingDirs = new Set(reg.workspaces.map((w) => w.dir));
  const record: WorkspaceRecord = {
    id: uuidv4(),
    displayName: opts.displayName,
    dir: uniqueDirName(opts.displayName, existingDirs),
    db: opts.db,
    kind: isCloudDb(opts.db) ? 'cloud' : 'local',
    createdAt: new Date().toISOString(),
    configPath: resolve(opts.configPath),
    contextDir: resolve(opts.contextDir),
  };
  reg.workspaces.push(record);
  const makeActive = opts.makeActive ?? reg.activeWorkspaceId === null;
  if (makeActive) reg.activeWorkspaceId = record.id;
  writeRegistry(root, reg);
  return record;
}

export interface RegisterCloudWorkspaceOptions {
  /** The config the cloud DB lives behind (active workspace.yml or a joined sibling). */
  configPath: string;
  /** Render output dir for the config (used only when adopting a brand-new record). */
  contextDir: string;
  /** Friendly name. Used when creating a new record; falls back to a basename. */
  displayName: string;
  /** The new cloud `db:` value (`${LATTICE_DB:label}` or `postgres://…`). */
  db: string;
  makeActive?: boolean;
}

/**
 * Make a cloud DB appear as a workspace in the registry. If a record already
 * references `configPath` (e.g. the active local workspace that just migrated
 * to cloud), flip it to cloud in place — same id, so the active selection and
 * any UI state survive. Otherwise adopt a fresh cloud record (e.g. a joined
 * team's sibling config). Returns the record.
 */
export function registerOrUpdateCloudWorkspace(
  root: string,
  opts: RegisterCloudWorkspaceOptions,
): WorkspaceRecord {
  const existing = findWorkspaceByConfigPath(root, opts.configPath);
  if (existing) {
    const reg = readRegistry(root);
    const rec = reg.workspaces.find((w) => w.id === existing.id);
    if (rec) {
      rec.db = opts.db;
      rec.kind = 'cloud';
      if (opts.makeActive) reg.activeWorkspaceId = rec.id;
      writeRegistry(root, reg);
      return rec;
    }
  }
  return addAdoptedWorkspace(root, {
    displayName: opts.displayName,
    db: opts.db,
    configPath: opts.configPath,
    contextDir: opts.contextDir,
    makeActive: opts.makeActive ?? false,
  });
}

/** Remove a workspace record from the registry. Clears `activeWorkspaceId` if it pointed here. */
export function removeWorkspace(root: string, id: string): WorkspaceRecord | null {
  const reg = readRegistry(root);
  const idx = reg.workspaces.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  const [removed] = reg.workspaces.splice(idx, 1);
  if (reg.activeWorkspaceId === id) {
    reg.activeWorkspaceId = reg.workspaces[0]?.id ?? null;
  }
  writeRegistry(root, reg);
  return removed ?? null;
}

/** Remove the registry record (if any) whose effective config path matches `configPath`. */
export function removeWorkspaceByConfigPath(root: string, configPath: string): WorkspaceRecord | null {
  const match = findWorkspaceByConfigPath(root, configPath);
  return match ? removeWorkspace(root, match.id) : null;
}

/**
 * Update the display name of the workspace whose effective config path matches
 * `configPath` (the registry is what the header switcher reads, so a rename must
 * land here too). No-op when no record matches.
 */
export function renameWorkspaceByConfigPath(
  root: string,
  configPath: string,
  displayName: string,
): void {
  const match = findWorkspaceByConfigPath(root, configPath);
  if (!match) return;
  const reg = readRegistry(root);
  const rec = reg.workspaces.find((w) => w.id === match.id);
  if (rec) {
    rec.displayName = displayName;
    writeRegistry(root, reg);
  }
}
