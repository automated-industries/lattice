/**
 * A workspace opened by a command and a workspace opened by the library must be
 * the SAME workspace.
 *
 * This is not a tidiness point. The rendered `Context/` tree is reconciled
 * against a manifest of what the last render produced, so an opener that knows
 * about fewer tables than the opener that wrote the tree reads the difference as
 * "these contexts were removed" and deletes them from disk. Two openers that
 * disagree therefore do not merely render differently — they take turns writing
 * and destroying the same files, and neither reports anything wrong.
 *
 * That happened twice, at two different seams: once for the tables a shared
 * workspace publishes, and once for the framework's own tables, which the
 * library and the browser registered and the commands did not. These specs pin
 * the agreement itself rather than either half of it.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { openConfiguredLattice } from '../../src/cli-open.js';
import {
  addWorkspace,
  resolveWorkspacePaths,
  getActiveWorkspace,
} from '../../src/framework/workspace.js';
import { ensureLatticeRoot } from '../../src/framework/lattice-root.js';

const dirs: string[] = [];
let savedRoot: string | undefined;
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedRoot = process.env.LATTICE_ROOT;
  savedConfigDir = process.env.LATTICE_CONFIG_DIR;
  // The key store must be a throwaway: opening a workspace resolves this
  // machine's encryption key, and a test must never read or create the one
  // belonging to whoever is running it.
  const cfg = mkdtempSync(join(tmpdir(), 'lattice-agree-cfg-'));
  dirs.push(cfg);
  process.env.LATTICE_CONFIG_DIR = cfg;
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedRoot === undefined) delete process.env.LATTICE_ROOT;
  else process.env.LATTICE_ROOT = savedRoot;
  if (savedConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedConfigDir;
});

/** A workspace under a throwaway root, with `notes` declared. */
function setupWorkspace(): { root: string; configPath: string; contextDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'lattice-agree-'));
  dirs.push(base);
  process.env.LATTICE_ROOT = join(base, '.lattice');
  const root = ensureLatticeRoot(base);
  const ws = addWorkspace(root, { displayName: 'Agree' });
  const paths = resolveWorkspacePaths(root, ws);
  writeFileSync(
    paths.configPath,
    [
      'name: "Agree"',
      'db: ./Data/database.db',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '',
    ].join('\n'),
    'utf8',
  );
  return { root, configPath: paths.configPath, contextDir: paths.contextDir };
}

describe('a command and the library open the same workspace', () => {
  it('reconcile from a command keeps everything the library render wrote', async () => {
    const ws = setupWorkspace();

    // The library open: renders the canonical per-row tree plus the framework's
    // own tables.
    const lib = await Lattice.openWorkspace({ root: ws.root });
    await lib.insert('notes', { title: 'kept' });
    await lib.insert('files', { original_name: 'a.txt' });
    await lib.render(ws.contextDir);
    lib.close();

    const noteSlugs = readdirSync(join(ws.contextDir, 'Notes'));
    expect(noteSlugs.length).toBe(1);
    const fileSlugs = readdirSync(join(ws.contextDir, 'Files'));
    expect(fileSlugs.length).toBe(1);

    // The command open, doing exactly what `reconcile` does.
    const cli = await openConfiguredLattice({ config: ws.configPath });
    let result;
    try {
      await cli.init();
      result = await cli.reconcile(ws.contextDir, {
        removeOrphanedDirectories: true,
        removeOrphanedFiles: true,
      });
    } finally {
      cli.close();
    }

    expect(result.cleanup.filesRemoved).toEqual([]);
    expect(result.cleanup.directoriesRemoved).toEqual([]);
    expect(existsSync(join(ws.contextDir, 'Notes', noteSlugs[0]!, 'NOTE.md'))).toBe(true);
    expect(existsSync(join(ws.contextDir, 'Files', fileSlugs[0]!, 'FILE.md'))).toBe(true);
  });

  it('a command sees the framework tables, so it can read and write them headlessly', async () => {
    const ws = setupWorkspace();
    const lib = await Lattice.openWorkspace({ root: ws.root, autoRender: false });
    lib.close();

    const cli = await openConfiguredLattice({ config: ws.configPath });
    try {
      await cli.init();
      const registered = cli.getRegisteredTableNames();
      expect(registered).toContain('files');
      expect(registered).toContain('secrets');
      // The secret store is encrypted, so this also proves the command resolved
      // a usable key for the root it opened.
      const id = await cli.insert('secrets', { name: 'TOKEN', value: 'shh' });
      expect((await cli.get('secrets', id))?.value).toBe('shh');
    } finally {
      cli.close();
    }
  });

  it('alternating opens converge instead of flip-flopping', async () => {
    const ws = setupWorkspace();

    const lib = await Lattice.openWorkspace({ root: ws.root });
    await lib.insert('notes', { title: 'stable' });
    await lib.render(ws.contextDir);
    lib.close();

    for (let i = 0; i < 2; i++) {
      const cli = await openConfiguredLattice({ config: ws.configPath });
      try {
        await cli.init();
        const r = await cli.reconcile(ws.contextDir, {
          removeOrphanedDirectories: true,
          removeOrphanedFiles: true,
        });
        expect(r.cleanup.filesRemoved).toEqual([]);
      } finally {
        cli.close();
      }
      const again = await Lattice.openWorkspace({ root: ws.root });
      again.close();
    }

    const slugs = readdirSync(join(ws.contextDir, 'Notes'));
    expect(slugs.length).toBe(1);
    expect(existsSync(join(ws.contextDir, 'Notes', slugs[0]!, 'NOTE.md'))).toBe(true);
  });

  it('a standalone config is not given a workspace layout it never asked for', async () => {
    // A config that belongs to no root keeps rendering exactly what it declares;
    // only the framework's own tables are added, which every opener does.
    const dir = mkdtempSync(join(tmpdir(), 'lattice-standalone-'));
    dirs.push(dir);
    const configPath = join(dir, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        `db: ${join(dir, 'standalone.db')}`,
        'entities:',
        '  notes:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      title: { type: text }',
        '    outputFile: notes.md',
        '',
      ].join('\n'),
      'utf8',
    );

    const db = await openConfiguredLattice({ config: configPath });
    try {
      await db.init();
      expect(db.entityContexts().has('notes')).toBe(false);
      expect(db.getRegisteredTableNames()).toContain('files');
    } finally {
      db.close();
    }
  });

  it('the active workspace resolves the same way from both openers', async () => {
    const ws = setupWorkspace();
    const active = getActiveWorkspace(ws.root);
    expect(active).not.toBeNull();
    const lib = await Lattice.openWorkspace({ root: ws.root, autoRender: false });
    const cli = await openConfiguredLattice({ config: ws.configPath });
    try {
      await cli.init();
      expect([...cli.getRegisteredTableNames()].sort()).toEqual(
        [...lib.getRegisteredTableNames()].sort(),
      );
      expect([...cli.entityContexts().keys()].sort()).toEqual(
        [...lib.entityContexts().keys()].sort(),
      );
    } finally {
      lib.close();
      cli.close();
    }
  });
});
