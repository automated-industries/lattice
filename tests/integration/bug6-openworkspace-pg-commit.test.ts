import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  Lattice,
  addWorkspace,
  ensureLatticeRoot,
  resolveWorkspacePaths,
  saveDbCredential,
} from '../../src/index.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const req = createRequire(import.meta.url);

// Reproduction of the reported Bug 6: writes via openWorkspace to a cloud (Postgres)
// workspace return an id and satisfy in-session reads, but never land in the cloud
// Postgres. The arbiter is a SEPARATE raw `pg` connection (as the reporter used).
describe.skipIf(!PG_URL)('Bug 6: openWorkspace writes must commit to Postgres', () => {
  const dirs: string[] = [];
  let savedCfg: string | undefined;
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.LATTICE_ROOT;
    if (savedCfg === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = savedCfg;
  });

  it('a row written via openWorkspace lands in Postgres (a separate pg connection sees it)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bug6-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    savedCfg = process.env.LATTICE_CONFIG_DIR;
    process.env.LATTICE_CONFIG_DIR = join(base, '.lattice', '.config');
    const root = ensureLatticeRoot(base);
    saveDbCredential('bug6db', PG_URL!);
    const ws = addWorkspace(root, { displayName: 'Bug6' });
    const p = resolveWorkspacePaths(root, ws);
    const table = 'bug6_meetings';
    writeFileSync(
      p.configPath,
      [
        'name: "Bug6"',
        'db: ${LATTICE_DB:bug6db}',
        'entities:',
        '  ' + table + ':',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      slug: { type: text }',
        '      title: { type: text }',
        '',
      ].join('\n'),
      'utf8',
    );

    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id, autoRender: false });
    const id = await db.upsertBy(table, 'slug', 'bug6-slug', { title: 'x' });
    expect(id).toBeTruthy();
    const inSession = await db.query(table, {});
    expect(inSession.some((r) => r.slug === 'bug6-slug')).toBe(true); // reporter: reads confirm
    db.close();

    // The DEFINITIVE check — a separate raw pg connection, like the reporter's owner-role query.
    const { Client } = req('pg') as { Client: new (c: { connectionString: string }) => any };
    const client = new Client({ connectionString: PG_URL! });
    await client.connect();
    let count = -1;
    try {
      const res = await client.query(`SELECT id FROM "${table}" WHERE slug = 'bug6-slug'`);
      count = res.rows.length;
    } finally {
      await client.end();
    }
    expect(count).toBe(1); // if 0 → Bug 6 reproduced: the write never committed to Postgres
  });
});
