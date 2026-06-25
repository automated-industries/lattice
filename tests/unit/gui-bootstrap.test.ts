import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLatticeRoot } from '../../src/framework/lattice-root.js';
import {
  listWorkspaces,
  getActiveWorkspace,
  findWorkspaceByConfigPath,
  registerOrUpdateCloudWorkspace,
  removeWorkspaceByConfigPath,
  renameWorkspaceByConfigPath,
  resolveWorkspacePaths,
} from '../../src/framework/workspace.js';
import {
  adoptConfigAsWorkspace,
  reconcileWorkspaceRegistry,
  ensureRootForGui,
} from '../../src/framework/gui-bootstrap.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

function tmp(): string {
  const base = mkdtempSync(join(tmpdir(), 'lattice-boot-'));
  dirs.push(base);
  return base;
}

/** Create a root anchored at `base` (deterministic via LATTICE_ROOT). */
function rootAt(base: string): string {
  process.env.LATTICE_ROOT = join(base, '.lattice');
  return ensureLatticeRoot(base);
}

function writeConfig(dir: string, name: string, db: string, friendly?: string): string {
  const p = join(dir, name);
  const yaml =
    (friendly ? `name: ${JSON.stringify(friendly)}\n` : '') + `db: ${db}\nentities: {}\n`;
  writeFileSync(p, yaml, 'utf8');
  return p;
}

describe('gui-bootstrap: adoptConfigAsWorkspace', () => {
  it('adopts a local config in place, referencing its db without scaffolding', () => {
    const base = tmp();
    const root = rootAt(base);
    const cfg = writeConfig(base, 'lattice.config.yml', './data/app.db', 'My App');
    const ws = adoptConfigAsWorkspace(root, cfg, { makeActive: true });
    expect(ws).not.toBeNull();
    expect(ws?.kind).toBe('local');
    expect(ws?.displayName).toBe('My App');
    expect(ws?.configPath).toBe(cfg);
    expect(resolveWorkspacePaths(root, ws!).configPath).toBe(cfg);
    // No Workspaces/<dir>/workspace.yml was scaffolded for an adopted config.
    expect(existsSync(join(root, 'Workspaces', ws!.dir, 'workspace.yml'))).toBe(false);
  });

  it('is idempotent — adopting the same config twice yields one record', () => {
    const base = tmp();
    const root = rootAt(base);
    const cfg = writeConfig(base, 'lattice.config.yml', './data/app.db');
    const a = adoptConfigAsWorkspace(root, cfg);
    const b = adoptConfigAsWorkspace(root, cfg);
    expect(a?.id).toBe(b?.id);
    expect(listWorkspaces(root)).toHaveLength(1);
  });

  it('returns null for non-Lattice YAML', () => {
    const base = tmp();
    const root = rootAt(base);
    const p = join(base, 'random.yml');
    writeFileSync(p, 'hello: world\n', 'utf8');
    expect(adoptConfigAsWorkspace(root, p)).toBeNull();
  });

  it('classifies a ${LATTICE_DB:…} / postgres db as cloud', () => {
    const base = tmp();
    const root = rootAt(base);
    const cfg = writeConfig(base, 'team.yml', '${LATTICE_DB:my-team}', 'Team');
    expect(adoptConfigAsWorkspace(root, cfg)?.kind).toBe('cloud');
  });
});

describe('gui-bootstrap: reconcileWorkspaceRegistry', () => {
  it('imports stray sibling configs (a previously-joined team config) as workspaces', () => {
    const base = tmp();
    const root = rootAt(base);
    writeConfig(base, 'lattice.config.yml', './data/app.db');
    const joined = writeConfig(base, 'demo-team.yml', '${LATTICE_DB:demo-team}', 'Demo Team');
    expect(listWorkspaces(root)).toHaveLength(0);
    reconcileWorkspaceRegistry(root, [base]);
    expect(listWorkspaces(root)).toHaveLength(2);
    expect(findWorkspaceByConfigPath(root, joined)?.kind).toBe('cloud');
  });

  it('is idempotent and skips already-registered configs', () => {
    const base = tmp();
    const root = rootAt(base);
    writeConfig(base, 'a.yml', './data/a.db');
    reconcileWorkspaceRegistry(root, [base]);
    reconcileWorkspaceRegistry(root, [base]);
    expect(listWorkspaces(root)).toHaveLength(1);
  });
});

describe('gui-bootstrap: registerOrUpdateCloudWorkspace + remove + rename', () => {
  it('flips an existing local workspace to cloud in place (same id)', () => {
    const base = tmp();
    const root = rootAt(base);
    const cfg = writeConfig(base, 'lattice.config.yml', './data/app.db', 'App');
    const local = adoptConfigAsWorkspace(root, cfg, { makeActive: true })!;
    expect(local.kind).toBe('local');
    const cloud = registerOrUpdateCloudWorkspace(root, {
      configPath: cfg,
      contextDir: join(base, 'context'),
      displayName: 'App',
      db: '${LATTICE_DB:app}',
      makeActive: true,
    });
    expect(cloud.id).toBe(local.id);
    expect(cloud.kind).toBe('cloud');
    expect(listWorkspaces(root)).toHaveLength(1);
  });

  it('adopts a new cloud workspace when none references the config', () => {
    const base = tmp();
    const root = rootAt(base);
    const cfg = writeConfig(base, 'team.yml', '${LATTICE_DB:team}', 'Team');
    const ws = registerOrUpdateCloudWorkspace(root, {
      configPath: cfg,
      contextDir: join(base, 'context'),
      displayName: 'Team',
      db: '${LATTICE_DB:team}',
    });
    expect(ws.kind).toBe('cloud');
    expect(findWorkspaceByConfigPath(root, cfg)?.id).toBe(ws.id);
  });

  it('removeWorkspaceByConfigPath drops the matching record', () => {
    const base = tmp();
    const root = rootAt(base);
    const cfg = writeConfig(base, 'team.yml', '${LATTICE_DB:team}', 'Team');
    adoptConfigAsWorkspace(root, cfg);
    expect(listWorkspaces(root)).toHaveLength(1);
    removeWorkspaceByConfigPath(root, cfg);
    expect(listWorkspaces(root)).toHaveLength(0);
  });

  it('renameWorkspaceByConfigPath updates the display name (the switcher source)', () => {
    const base = tmp();
    const root = rootAt(base);
    const cfg = writeConfig(base, 'lattice.config.yml', './data/app.db', 'Old');
    adoptConfigAsWorkspace(root, cfg);
    renameWorkspaceByConfigPath(root, cfg, 'New Name');
    expect(findWorkspaceByConfigPath(root, cfg)?.displayName).toBe('New Name');
  });
});

describe('gui-bootstrap: ensureRootForGui', () => {
  it('creates a root and adopts the launch config as the active workspace', () => {
    const base = tmp();
    const cfg = writeConfig(base, 'lattice.config.yml', './data/app.db', 'My App');
    const boot = ensureRootForGui({ startDir: base, configPath: cfg, explicitConfig: false });
    expect(existsSync(boot.root)).toBe(true);
    expect(boot.displayName).toBe('My App');
    expect(boot.configPath).toBe(cfg);
    expect(getActiveWorkspace(boot.root)?.id).toBe(boot.workspaceId);
  });

  it('reuses the existing root + active workspace on a plain re-launch', () => {
    const base = tmp();
    const cfg = writeConfig(base, 'lattice.config.yml', './data/app.db', 'My App');
    const first = ensureRootForGui({ startDir: base, configPath: cfg, explicitConfig: false });
    const second = ensureRootForGui({ startDir: base, configPath: cfg, explicitConfig: false });
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(listWorkspaces(first.root)).toHaveLength(1);
  });

  it('reconciles a stray joined config into the registry on launch (joined-workspace bug fix)', () => {
    const base = tmp();
    const cfg = writeConfig(base, 'lattice.config.yml', './data/app.db', 'My App');
    const joined = writeConfig(base, 'demo-team.yml', '${LATTICE_DB:demo-team}', 'Demo Team');
    const boot = ensureRootForGui({ startDir: base, configPath: cfg, explicitConfig: false });
    const labels = listWorkspaces(boot.root).map((w) => w.displayName);
    expect(labels).toContain('Demo Team');
    expect(findWorkspaceByConfigPath(boot.root, joined)?.kind).toBe('cloud');
  });

  it('returns a virgin (zero-workspace) bootstrap in an empty dir with no config (3.3)', () => {
    // 3.3 Feature B: no more force-created "My Workspace". A first launch with
    // nothing to adopt yields a virgin bootstrap so the GUI shows its welcome
    // screen; the registry stays empty until the user creates or joins one.
    const base = tmp();
    const boot = ensureRootForGui({
      startDir: base,
      configPath: join(base, 'lattice.config.yml'),
      explicitConfig: false,
    });
    expect(boot.root).toBeTruthy();
    expect(boot.workspaceId).toBeNull();
    expect(boot.configPath).toBeNull();
    expect(boot.contextDir).toBeNull();
    expect(listWorkspaces(boot.root)).toHaveLength(0);
    expect(getActiveWorkspace(boot.root)).toBeNull();
  });

  it('opens the existing workspace when launched with NO config file (desktop boot)', () => {
    // Desktop regression: the app boots with no launch config (it passes a path
    // that doesn't exist), so it must resolve the active workspace from the root
    // and open it — NOT fall through to the welcome screen when workspaces exist.
    const base = tmp();
    const cfg = writeConfig(base, 'lattice.config.yml', './data/app.db', 'My App');
    const first = ensureRootForGui({ startDir: base, configPath: cfg, explicitConfig: false });
    expect(first.workspaceId).not.toBeNull();
    // Re-launch with a non-existent config (the desktop case): still opens it.
    const boot = ensureRootForGui({
      startDir: base,
      configPath: join(base, 'does-not-exist.yml'),
      explicitConfig: false,
    });
    expect(boot.workspaceId).toBe(first.workspaceId);
    expect(boot.configPath).not.toBeNull();
    expect(boot.contextDir).not.toBeNull();
  });

  it('still adopts + activates an explicit config (no virgin state when a config exists)', () => {
    const base = tmp();
    const cfg = writeConfig(base, 'lattice.config.yml', './data/app.db', 'My App');
    const boot = ensureRootForGui({ startDir: base, configPath: cfg, explicitConfig: true });
    expect(boot.workspaceId).not.toBeNull();
    expect(boot.configPath).not.toBeNull();
    expect(listWorkspaces(boot.root).length).toBeGreaterThanOrEqual(1);
  });
});
