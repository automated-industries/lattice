import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Lattice } from '../../src/lattice.js';
import { readManifest } from '../../src/lifecycle/manifest.js';
import { deriveCanonicalContexts } from '../../src/framework/canonical-context.js';
import type { TableDefinition } from '../../src/types.js';

/**
 * Reconciliation of the rendered Context/ tree — the file-deletion machinery.
 * The invariants under test:
 *
 *  1. Every phase-1 rollup gets a LIFECYCLE record (manifest.tableFiles), and a
 *     path no longer produced (outputFile change, dropped table) moves to the
 *     RETIRED ledger and is pruned by reconciliation — the orphan class where a
 *     root-level rollup sat next to its table's folder forever.
 *  2. SAFE-PRUNE HASH GUARD: a file whose on-disk bytes differ from Lattice's
 *     own last write (a manual edit) is NEVER deleted — left in place with a
 *     loud warning, and its ledger entry persists for the next pass.
 *  3. Manual edits are DRAINED into the DB before a render can overwrite them
 *     (the lost-edit race): the auto-render path ingests the edit first, so the
 *     re-rendered file carries it and the DB row is updated.
 *  4. A pre-v4 manifest (no rollup history) prunes NOTHING it cannot prove.
 */

const ROLLUP_ROOT = 'STATES.md';
const ROLLUP_HOMED = '.schema-only/states.md';

function statesDef(outputFile: string): TableDefinition {
  return {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
    render: (rows) => `# States\n\n${rows.map((r) => `- ${String(r.name)}`).join('\n')}\n`,
    outputFile,
  };
}

describe('render reconciliation (retired rollups + hash guard)', () => {
  let tmp: string;
  let ctxDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lattice-reconcile-'));
    ctxDir = join(tmp, 'Context');
    dbPath = join(tmp, 'app.db');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function renderWithOutputFile(outputFile: string): Promise<Lattice> {
    const db = new Lattice(dbPath);
    db.define('states', statesDef(outputFile));
    await db.init();
    return db;
  }

  it('a changed outputFile retires the old rollup and reconciliation prunes it (the orphan class)', async () => {
    // Render 1: legacy root-level rollup.
    const db1 = await renderWithOutputFile(ROLLUP_ROOT);
    await db1.insert('states', { id: 's1', name: 'Florida' });
    await db1.render(ctxDir);
    db1.close();
    expect(existsSync(join(ctxDir, ROLLUP_ROOT))).toBe(true);
    const m1 = readManifest(ctxDir);
    expect(m1?.tableFiles?.states?.path).toBe(ROLLUP_ROOT);

    // Render 2: the table now renders to the hidden home (the config-upgrade
    // rewrite). The old root path moves to the retired ledger…
    const db2 = await renderWithOutputFile(ROLLUP_HOMED);
    const prev = readManifest(ctxDir);
    await db2.render(ctxDir);
    const next = readManifest(ctxDir);
    expect(next?.tableFiles?.states?.path).toBe(ROLLUP_HOMED);
    expect((next?.retiredFiles ?? []).map((e) => e.path)).toContain(ROLLUP_ROOT);

    // …and reconciliation deletes the pristine orphan.
    const res = await db2.reconcileRenderedTree(ctxDir, prev, next);
    db2.close();
    expect(existsSync(join(ctxDir, ROLLUP_ROOT))).toBe(false);
    expect(existsSync(join(ctxDir, ROLLUP_HOMED))).toBe(true);
    expect(res.filesRemoved.some((p) => p.endsWith(ROLLUP_ROOT))).toBe(true);

    // The next render drops the pruned entry from the ledger (file is gone).
    const db3 = await renderWithOutputFile(ROLLUP_HOMED);
    await db3.render(ctxDir);
    db3.close();
    expect((readManifest(ctxDir)?.retiredFiles ?? []).map((e) => e.path)).not.toContain(
      ROLLUP_ROOT,
    );
  });

  it('HASH GUARD: a manually edited retired rollup is NEVER deleted — warned, and retried later', async () => {
    const db1 = await renderWithOutputFile(ROLLUP_ROOT);
    await db1.insert('states', { id: 's1', name: 'Florida' });
    await db1.render(ctxDir);
    db1.close();

    // The user edits the file before the layout change lands.
    writeFileSync(join(ctxDir, ROLLUP_ROOT), '# States\n\n- Florida\n- MY MANUAL NOTE\n');

    const db2 = await renderWithOutputFile(ROLLUP_HOMED);
    const prev = readManifest(ctxDir);
    await db2.render(ctxDir);
    const next = readManifest(ctxDir);
    const res = await db2.reconcileRenderedTree(ctxDir, prev, next);
    db2.close();

    // The edited file SURVIVES, loudly.
    expect(existsSync(join(ctxDir, ROLLUP_ROOT))).toBe(true);
    expect(readFileSync(join(ctxDir, ROLLUP_ROOT), 'utf8')).toContain('MY MANUAL NOTE');
    expect(res.warnings.some((w) => w.includes(ROLLUP_ROOT))).toBe(true);
    // And the ledger keeps carrying it (still on disk) so a later pass can retry.
    expect((readManifest(ctxDir)?.retiredFiles ?? []).map((e) => e.path)).toContain(ROLLUP_ROOT);
  });

  it('a dropped table retires + prunes its rollup', async () => {
    const db1 = await renderWithOutputFile(ROLLUP_ROOT);
    await db1.insert('states', { id: 's1', name: 'Florida' });
    await db1.render(ctxDir);
    db1.close();

    // Render 2: no `states` table at all.
    const db2 = new Lattice(dbPath);
    db2.define('other', {
      columns: { id: 'TEXT PRIMARY KEY', deleted_at: 'TEXT' },
      render: () => 'other\n',
      outputFile: '.schema-only/other.md',
    });
    await db2.init();
    const prev = readManifest(ctxDir);
    await db2.render(ctxDir);
    const next = readManifest(ctxDir);
    await db2.reconcileRenderedTree(ctxDir, prev, next);
    db2.close();
    expect(existsSync(join(ctxDir, ROLLUP_ROOT))).toBe(false);
  });

  it('a pre-v4 manifest (no rollup history) prunes nothing it cannot prove', async () => {
    const db1 = await renderWithOutputFile(ROLLUP_HOMED);
    await db1.insert('states', { id: 's1', name: 'Florida' });
    await db1.render(ctxDir);
    db1.close();

    // Simulate a v3 manifest: strip the rollup history + plant a stray root file
    // that COULD look like an orphan (but nothing proves Lattice wrote it).
    const mPath = join(ctxDir, '.lattice', 'manifest.json');
    const m = JSON.parse(readFileSync(mPath, 'utf8')) as Record<string, unknown>;
    delete m.tableFiles;
    delete m.retiredFiles;
    writeFileSync(mPath, JSON.stringify(m));
    writeFileSync(join(ctxDir, 'STRAY.md'), 'user file — not Lattice-written\n');

    const db2 = await renderWithOutputFile(ROLLUP_HOMED);
    const prev = readManifest(ctxDir);
    await db2.render(ctxDir);
    const next = readManifest(ctxDir);
    const res = await db2.reconcileRenderedTree(ctxDir, prev, next);
    db2.close();
    expect(existsSync(join(ctxDir, 'STRAY.md'))).toBe(true);
    expect(res.filesRemoved.some((p) => p.endsWith('STRAY.md'))).toBe(false);
  });

  it('a vanished multi-output key retires + prunes its file (edited one survives)', async () => {
    // Render 1: a multi produces one file per key.
    const mkDb = async (keys: string[]): Promise<Lattice> => {
      const db = new Lattice(dbPath);
      db.define('anchor', {
        columns: { id: 'TEXT PRIMARY KEY', deleted_at: 'TEXT' },
        render: () => 'anchor\n',
        outputFile: '.schema-only/anchor.md',
      });
      db.defineMulti('per_key', {
        keys: () => Promise.resolve(keys),
        outputFile: (k: string) => `Keys/${k}.md`,
        render: (k: string) => `# ${k}\n`,
      });
      await db.init();
      return db;
    };
    const db1 = await mkDb(['a', 'b']);
    await db1.render(ctxDir);
    db1.close();
    expect(existsSync(join(ctxDir, 'Keys', 'a.md'))).toBe(true);
    expect(existsSync(join(ctxDir, 'Keys', 'b.md'))).toBe(true);

    // The user edits b's file; then key b vanishes.
    writeFileSync(join(ctxDir, 'Keys', 'b.md'), '# b\nMY NOTE\n');
    const db2 = await mkDb(['a']);
    const prev = readManifest(ctxDir);
    await db2.render(ctxDir);
    const next = readManifest(ctxDir);
    expect((next?.retiredFiles ?? []).map((e) => e.path)).toContain('Keys/b.md');
    const res = await db2.reconcileRenderedTree(ctxDir, prev, next);
    db2.close();

    // Edited b survives with a warning; a is untouched.
    expect(existsSync(join(ctxDir, 'Keys', 'b.md'))).toBe(true);
    expect(res.warnings.some((w) => w.includes('b.md'))).toBe(true);
    expect(existsSync(join(ctxDir, 'Keys', 'a.md'))).toBe(true);

    // A PRISTINE vanished key is pruned: re-render with b restored then removed.
    const db3 = await mkDb(['a', 'c']);
    await db3.render(ctxDir);
    db3.close();
    const db4 = await mkDb(['a']);
    const prev4 = readManifest(ctxDir);
    await db4.render(ctxDir);
    const next4 = readManifest(ctxDir);
    await db4.reconcileRenderedTree(ctxDir, prev4, next4);
    db4.close();
    expect(existsSync(join(ctxDir, 'Keys', 'c.md'))).toBe(false);
  });
});

describe('reverse-sync drain (the lost-edit race)', () => {
  let tmp: string;
  let ctxDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lattice-drain-'));
    ctxDir = join(tmp, 'Context');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a manual file edit is ingested into the DB BEFORE the render overwrites it', async () => {
    const db = new Lattice(join(tmp, 'app.db'));
    const def: TableDefinition = {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/items.md',
    };
    db.define('items', def);
    // The canonical per-record context — the same derivation workspace opens use,
    // whose self file round-trips through the default reverse-sync parser.
    for (const { table, definition } of deriveCanonicalContexts([
      { name: 'items', definition: def },
    ])) {
      db.defineEntityContext(table, definition);
    }
    await db.init();
    await db.insert('items', { id: 'r1', name: 'Alpha' });
    db.enableAutoRender(ctxDir);
    await db.render(ctxDir);

    // Find the rendered self file and hand-edit its name field.
    const root = join(ctxDir, 'Items');
    const slug = readdirSync(root).find((d) => !d.startsWith('.'));
    expect(slug).toBeTruthy();
    const selfFile = join(root, String(slug), 'ITEM.md');
    // Edit the round-trippable FIELD bullet (not the heading — headings parse to
    // nothing by design, so an edit there is surfaced as non-importable instead).
    const edited = readFileSync(selfFile, 'utf8').replace(
      '- **name:** Alpha',
      '- **name:** Alpha (edited by hand)',
    );
    expect(edited).toContain('edited by hand');
    writeFileSync(selfFile, edited);

    // A render cycle through the guarded auto-render path (what the GUI open /
    // background render runs). WITHOUT the drain, this overwrote the file and the
    // edit vanished; WITH it, the edit lands in the DB first.
    const scheduler = (
      db as unknown as {
        _autoRender: { runGuarded(dir: string, opts: object): Promise<unknown> };
      }
    )._autoRender;
    await scheduler.runGuarded(ctxDir, {});

    const rows = (await db.query('items', {})) as { id: string; name: string }[];
    expect(rows.find((r) => r.id === 'r1')?.name).toBe('Alpha (edited by hand)');
    // And the re-rendered file carries the edit (no silent clobber).
    expect(readFileSync(selfFile, 'utf8')).toContain('Alpha (edited by hand)');
    db.close();
  });
});
