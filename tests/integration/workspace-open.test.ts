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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Lattice.openWorkspace', () => {
  it('renders a Context manifest immediately for an empty workspace', async () => {
    const root = setupRoot();
    addWorkspace(root, { displayName: 'Empty' });
    const db = await Lattice.openWorkspace({ root });
    const ws = getActiveWorkspace(root)!;
    const p = resolveWorkspacePaths(root, ws);
    expect(existsSync(join(p.contextDir, '.lattice', 'manifest.json'))).toBe(true);
    db.close();
  });

  it('renders the canonical, DB-aligned Context/ tree for related tables', async () => {
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

  it('configDir() resolves into the root .config once the root holds a key', () => {
    const root = setupRoot();
    // The gate only adopts the root for config once it actually holds a key
    // (or for a fresh install with no legacy key); write one to make this
    // assertion independent of the test machine's ~/.lattice state.
    writeFileSync(join(rootConfigDir(root), 'master.key'), 'test-key');
    expect(configDir()).toBe(rootConfigDir(root));
  });
});
