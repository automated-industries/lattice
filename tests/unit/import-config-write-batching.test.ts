import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The import writes every table it creates into the workspace config. Doing that
 * one table at a time re-read, re-parsed and re-serialized the WHOLE config file
 * per table — and since each table appends to that file, the file grew as the
 * import ran, so the k-th table paid to re-serialize the k-1 before it and the
 * run went quadratic in table count. It dominated the apply: importing n tables
 * straight through `materializeImport`, going from n=10 to n=160 cost 129x the
 * time before this was batched and 15.5x after.
 *
 * These tests pin the shape of the fix rather than its speed: the config is
 * loaded once and saved once per import, no matter how many tables land, and
 * every table still ends up recorded. A count is deterministic on every
 * platform; a duration would not be. (Before batching, the first test below
 * reported 61 saves for its 30 tables.)
 */
const counts = { load: 0, save: 0 };

vi.mock('../../src/gui/config-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gui/config-io.js')>();
  return {
    ...actual,
    loadConfigDoc: (path: string) => {
      counts.load += 1;
      return actual.loadConfigDoc(path);
    },
    saveConfigDoc: (path: string, doc: ReturnType<typeof actual.loadConfigDoc>) => {
      counts.save += 1;
      actual.saveConfigDoc(path, doc);
    },
  };
});

const { Lattice, ensureLatticeRoot, addWorkspace, resolveWorkspacePaths } =
  await import('../../src/index.js');
const { inferSchema } = await import('../../src/import/infer.js');
const { materializeImport } = await import('../../src/import/materialize.js');

const dirs: string[] = [];
const dbs: InstanceType<typeof Lattice>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

async function freshWorkspace(prefix: string): Promise<{
  db: InstanceType<typeof Lattice>;
  configPath: string;
}> {
  const base = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(base);
  process.env.LATTICE_ROOT = join(base, '.lattice');
  const root = ensureLatticeRoot(base);
  const ws = addWorkspace(root, { displayName: 'Batch' });
  const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
  dbs.push(db);
  return { db, configPath: resolveWorkspacePaths(root, ws).configPath };
}

/** `n` independent arrays in one source → `n` entity tables from one import. */
function manyTables(n: number): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    data['t' + String(i)] = [
      { id: i, v: 'a' + String(i) },
      { id: i + 1000, v: 'b' + String(i) },
    ];
  }
  return data;
}

describe('import: the workspace config is written once per import, not once per table', () => {
  it('loads and saves the config exactly once however many tables the import creates', async () => {
    const { db, configPath } = await freshWorkspace('lattice-cfgbatch-');
    const data = manyTables(30);
    const plan = await inferSchema(data);

    counts.load = 0;
    counts.save = 0;
    await materializeImport({ db, configPath }, data, plan);

    // Per-table writing did one load+save per created table; batching does one of
    // each for the whole run. Anchored to 1 (not "fewer than 30") so a partial
    // regression back toward per-table writes fails here too.
    expect(counts.save).toBe(1);
    expect(counts.load).toBe(1);

    // …and the single write still records every table it created.
    const config = readFileSync(configPath, 'utf8');
    for (const name of ['t0', 't15', 't29']) {
      expect(config, `config is missing table ${name}`).toContain(name + ':');
    }
    expect(await db.count('t0')).toBe(2);
    expect(await db.count('t29')).toBe(2);
  });

  it('stays at one write when the import also creates dimensions and junctions', async () => {
    const { db, configPath } = await freshWorkspace('lattice-cfgbatch-mixed-');
    // Fund-shaped: entities + a deduped dimension + a junction, so all three
    // table kinds go through the same batched writer.
    const data = {
      funds: [
        { code: 'EP', name: 'Early Plays' },
        { code: 'GG', name: 'Global Growth' },
      ],
      investments: Array.from({ length: 8 }, (_, i) => ({
        company: 'Company ' + String(i),
        funds: [i % 2 === 0 ? 'EP' : 'GG'],
        region: ['Europe', 'Asia', 'N. America'][i % 3],
        invested: 1 + i,
      })),
    };
    const plan = await inferSchema(data);

    counts.load = 0;
    counts.save = 0;
    const result = await materializeImport({ db, configPath }, data, plan);

    expect(counts.save).toBe(1);
    expect(counts.load).toBe(1);
    // More than one table really was created — otherwise "one write" is trivial.
    expect(result.tablesCreated.length).toBeGreaterThan(1);
    const config = readFileSync(configPath, 'utf8');
    for (const name of result.tablesCreated) {
      expect(config, `config is missing table ${name}`).toContain(name + ':');
    }
  });

  it('still records the tables it created when the import throws part-way', async () => {
    const { db, configPath } = await freshWorkspace('lattice-cfgbatch-throw-');
    const data = manyTables(6);
    const plan = await inferSchema(data);

    counts.load = 0;
    counts.save = 0;
    // Fail after some tables exist: the batched write happens in a `finally`, so a
    // run that dies mid-way must not lose the schema for what it already created.
    // (Per-table writing got this for free; batching has to keep it.)
    const boom = new Error('import aborted');
    await expect(
      materializeImport({ db, configPath }, data, plan, [], {
        onProgress: (p) => {
          if (p.phase === 'entities' && p.table === 't3') throw boom;
        },
      }),
    ).rejects.toThrow('import aborted');

    expect(counts.save).toBe(1);
    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain('t0:');
  });
});
