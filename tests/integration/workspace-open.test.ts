import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Lattice,
  addWorkspace,
  ensureLatticeRoot,
  resolveWorkspacePaths,
  getActiveWorkspace,
  configDir,
  rootConfigDir,
} from '../../src/index.js';

const dirs: string[] = [];
let savedConfigDir: string | undefined;
beforeEach(() => {
  // configDir() gives LATTICE_CONFIG_DIR top priority; these tests assert its
  // root-resolution path, so clear the worker-level override (see tests/setup).
  savedConfigDir = process.env.LATTICE_CONFIG_DIR;
  delete process.env.LATTICE_CONFIG_DIR;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
  if (savedConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedConfigDir;
});

function setupRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'lattice-open-'));
  dirs.push(base);
  process.env.LATTICE_ROOT = join(base, '.lattice');
  return ensureLatticeRoot(base);
}

/**
 * Point the machine-local config store at a throwaway dir. Opening a workspace
 * resolves this machine's encryption key, and a test must never read (or create)
 * the one belonging to the person running it. Restored by the afterEach above.
 */
function isolateConfigDir(): void {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-open-cfg-'));
  dirs.push(dir);
  process.env.LATTICE_CONFIG_DIR = dir;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Lattice.openWorkspace', () => {
  it('renders a Context manifest immediately for an empty workspace', async () => {
    isolateConfigDir();
    const root = setupRoot();
    addWorkspace(root, { displayName: 'Empty' });
    const db = await Lattice.openWorkspace({ root });
    const ws = getActiveWorkspace(root)!;
    const p = resolveWorkspacePaths(root, ws);
    expect(existsSync(join(p.contextDir, '.lattice', 'manifest.json'))).toBe(true);
    db.close();
  });

  it('renders the canonical, DB-aligned Context/ tree for related tables', async () => {
    isolateConfigDir();
    const root = setupRoot();
    const ws = addWorkspace(root, { displayName: 'KB' });
    const p = resolveWorkspacePaths(root, ws);
    writeFileSync(
      p.configPath,
      [
        'name: "KB"',
        'db: ./Data/database.db',
        'entities:',
        '  files:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      project_id: { type: text }',
        '    relations:',
        '      project: { type: belongsTo, table: projects, foreignKey: project_id }',
        '  projects:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '',
      ].join('\n'),
    );

    const db = await Lattice.openWorkspace({ root });
    const projId = await db.insert('projects', { name: 'Apollo' });
    await db.insert('files', { name: 'Spec', project_id: projId });
    await wait(450); // let the auto-render debounce fire

    expect(existsSync(join(p.contextDir, 'Files'))).toBe(true);
    expect(existsSync(join(p.contextDir, 'Projects'))).toBe(true);

    const fileDirs = readdirSync(join(p.contextDir, 'Files'));
    expect(fileDirs.length).toBe(1);
    const fileSlug = fileDirs[0]!;
    expect(existsSync(join(p.contextDir, 'Files', fileSlug, 'FILE.md'))).toBe(true);
    expect(existsSync(join(p.contextDir, 'Files', fileSlug, 'PROJECTS.md'))).toBe(true);

    const projDirs = readdirSync(join(p.contextDir, 'Projects'));
    const projSlug = projDirs[0]!;
    expect(existsSync(join(p.contextDir, 'Projects', projSlug, 'PROJECT.md'))).toBe(true);
    expect(existsSync(join(p.contextDir, 'Projects', projSlug, 'FILES.md'))).toBe(true);

    db.close();
  });

  it('registers the framework tables, so a headless open sees what the browser sees', async () => {
    isolateConfigDir();
    const root = setupRoot();
    addWorkspace(root, { displayName: 'Native' });
    const db = await Lattice.openWorkspace({ root, autoRender: false });
    const registered = db.getRegisteredTableNames();
    // The file index and the secret store are the two that matter: anything
    // walking "every table in this workspace" (securing it, indexing it,
    // listing it) skips them entirely when they were never registered.
    expect(registered).toContain('files');
    expect(registered).toContain('secrets');
    db.close();
  });

  it('a workspace that declares its own version of a framework table keeps it', async () => {
    isolateConfigDir();
    const root = setupRoot();
    const ws = addWorkspace(root, { displayName: 'OwnFiles' });
    const p = resolveWorkspacePaths(root, ws);
    writeFileSync(
      p.configPath,
      [
        'name: "OwnFiles"',
        'db: ./Data/database.db',
        'entities:',
        '  files:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      headline: { type: text }',
        '',
      ].join('\n'),
    );
    const db = await Lattice.openWorkspace({ root, autoRender: false });
    // Registered once, with the workspace's own columns — never re-registered
    // underneath the declaration or duplicated alongside it.
    expect(db.getRegisteredTableNames().filter((t) => t === 'files')).toEqual(['files']);
    expect(Object.keys(db.getRegisteredColumns('files') ?? {})).toContain('headline');
    const id = await db.insert('files', { headline: 'declared shape wins' });
    expect((await db.get('files', id))?.headline).toBe('declared shape wins');
    db.close();
  });

  it('configDir() resolves into the root .config once the root holds a key', () => {
    const root = setupRoot();
    // The gate only adopts the root for config once it actually holds a key
    // (or for a fresh install with no legacy key); write one to make this
    // assertion independent of the test machine's ~/.lattice state.
    writeFileSync(join(rootConfigDir(root), 'master.key'), 'test-key');
    expect(configDir()).toBe(rootConfigDir(root));
  });
});
