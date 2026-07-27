import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, disposeActive } from '../../src/gui/lifecycle.js';
import { execSql, loadConfigDoc, saveConfigDoc } from '../../src/gui/config-io.js';
import { applyRetypeColumn, canonicalizeForRetype } from '../../src/gui/planner/appliers.js';
import { isNumericValue } from '../../src/import/infer-core.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import type { ApplyOutcome } from '../../src/gui/planner/appliers.js';

/**
 * Safety contract for the column-retype applier. A retype REWRITES stored user
 * data and rebuilds a physical column, so the operation has exactly two
 * acceptable outcomes: it converts every row losslessly, or it refuses BEFORE it
 * has written anything at all. These pin the four ways it could do neither:
 *
 *  1. Ordering — every refusal happens before the first write, so a declined
 *     retype leaves the data, the physical schema, and (on a secured cloud) the
 *     masking view exactly as they were.
 *  2. Coverage — the value check reads EVERY row, including soft-deleted ones.
 *     The rebuild casts them all; verifying only the live ones means an
 *     unconvertible archived value is cast blind (a silent zero on SQLite, a
 *     mid-operation abort on Postgres).
 *  3. The SQLite rebuild — an index on the column, and the column's own NOT NULL
 *     / DEFAULT, must survive it; a failure mid-rebuild must never strand the
 *     temporary column where the user cannot remove it.
 *  4. Acceptance — the retype accepts exactly what the ingest type inference
 *     accepts, so the planner can never rewrite a value the importer would have
 *     refused to read as that type.
 */

/** The refusal message, or the empty string when the applier did NOT refuse. */
const refusal = (r: ApplyOutcome): string => (r.ok ? '' : r.error);

const dirs: string[] = [];
const actives: ActiveDb[] = [];

afterEach(() => {
  for (const a of actives.splice(0)) {
    try {
      a.db.close();
    } catch {
      // already disposed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CONFIG_ENTITIES = [
  'entities:',
  '  orders:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      code: { type: text }',
  '      qty: { type: text }',
  '      deleted_at: { type: text }',
  '    outputFile: orders.md',
  '  stock:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  "      level: { type: text, required: true, default: '0' }",
  '      deleted_at: { type: text }',
  '    outputFile: stock.md',
  '  strict:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      amount: { type: text, required: true }',
  '      deleted_at: { type: text }',
  '    outputFile: strict.md',
  '',
];

async function boot(dbSpec = './data/test.db'): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-retype-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(configPath, [`db: "${dbSpec}"`, '', ...CONFIG_ENTITIES].join('\n'), 'utf8');
  const active = await openConfig(configPath, join(root, 'context'), false);
  actives.push(active);
  return active;
}

/** Drop a field's declaration from the workspace configuration on disk — the
 *  shape a column that the live table has but the configuration never declared
 *  takes (a raw-SQL column, or one whose config write did not land). */
function undeclare(active: ActiveDb, table: string, column: string): void {
  const doc = loadConfigDoc(active.configPath);
  doc.deleteIn(['entities', table, 'fields', column]);
  saveConfigDoc(active.configPath, doc);
}

/** PRAGMA table_info for one column of a SQLite table. */
async function columnInfo(
  active: ActiveDb,
  table: string,
  column: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await allAsyncOrSync(active.db.adapter, `PRAGMA table_info("${table}")`);
  return rows.find((r) => String(r.name) === column);
}

async function physicalColumns(active: ActiveDb, table: string): Promise<string[]> {
  const rows = await allAsyncOrSync(active.db.adapter, `PRAGMA table_info("${table}")`);
  return rows.map((r) => String(r.name));
}

async function indexSql(active: ActiveDb, table: string): Promise<Record<string, unknown>[]> {
  return allAsyncOrSync(
    active.db.adapter,
    `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='${table}' AND sql IS NOT NULL`,
  );
}

/** Every row of a table (soft-deleted included), keyed by id. */
async function rowsById(
  active: ActiveDb,
  table: string,
): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await active.db.query(table, {})) as Record<string, unknown>[];
  return new Map(rows.map((r) => [String(r.id), r]));
}

const TEMP = 'qty_lattice_retype';

describe('column retype — refuses before it writes', () => {
  it('leaves the data and the physical column untouched when the column is not declared', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: ' 42 ' });
    await active.db.insert('orders', { id: 'o2', code: 'A-2', qty: '7' });
    undeclare(active, 'orders', 'qty');

    const r = await applyRetypeColumn(active, 'orders', 'qty', 'integer', 'sess');
    expect(r.ok).toBe(false);

    // Nothing was rewritten: the stored text is byte-identical, including the
    // padding a canonicalizing write would have stripped.
    const rows = await rowsById(active, 'orders');
    expect(rows.get('o1')?.qty).toBe(' 42 ');
    expect(rows.get('o2')?.qty).toBe('7');
    // ...and the physical column never moved storage class.
    expect(String((await columnInfo(active, 'orders', 'qty'))?.type).toUpperCase()).toBe('TEXT');
    expect(await physicalColumns(active, 'orders')).not.toContain(TEMP);
    expect(active.db.getRegisteredFieldTypes('orders')?.qty).toBe('text');
  });
});

describe('column retype — verifies every row, not just the live ones', () => {
  it('refuses when a SOFT-DELETED row holds a value that cannot convert', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: '1' });
    await active.db.insert('orders', { id: 'o2', code: 'A-2', qty: '2' });
    await active.db.insert('orders', {
      id: 'o3',
      code: 'A-3',
      qty: 'lots',
      deleted_at: '2026-01-01T00:00:00Z',
    });

    const r = await applyRetypeColumn(active, 'orders', 'qty', 'integer', 'sess');
    expect(r.ok).toBe(false);
    expect(refusal(r)).toMatch(/lots/);

    // The archived row keeps its value — it is not silently cast to zero.
    expect((await rowsById(active, 'orders')).get('o3')?.qty).toBe('lots');
    expect(active.db.getRegisteredFieldTypes('orders')?.qty).toBe('text');
  });

  it('canonicalizes a SOFT-DELETED row along with the live ones', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: '1' });
    await active.db.insert('orders', {
      id: 'o2',
      code: 'A-2',
      qty: '1,234',
      deleted_at: '2026-01-01T00:00:00Z',
    });

    const r = await applyRetypeColumn(active, 'orders', 'qty', 'integer', 'sess');
    expect(r).toEqual({ ok: true });

    // A raw CAST of "1,234" yields 1 on SQLite — the archived row must go
    // through the same canonicalization the live rows do.
    const rows = await rowsById(active, 'orders');
    expect(rows.get('o1')?.qty).toBe(1);
    expect(rows.get('o2')?.qty).toBe(1234);
  });
});

describe('column retype — the SQLite rebuild', () => {
  it('keeps an index that references the column, and strands no temporary column', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: '1' });
    await active.db.insert('orders', { id: 'o2', code: 'A-2', qty: '42' });
    await execSql(active.db, 'CREATE INDEX "idx_orders_qty" ON "orders" ("qty")');

    const r = await applyRetypeColumn(active, 'orders', 'qty', 'integer', 'sess');
    expect(r).toEqual({ ok: true });

    const idx = await indexSql(active, 'orders');
    expect(idx.map((i) => String(i.name))).toContain('idx_orders_qty');
    expect(String(idx.find((i) => String(i.name) === 'idx_orders_qty')?.sql)).toMatch(/"?qty"?/);
    expect(await physicalColumns(active, 'orders')).not.toContain(TEMP);
    const rows = await rowsById(active, 'orders');
    expect(rows.get('o1')?.qty).toBe(1);
    expect(rows.get('o2')?.qty).toBe(42);
  });

  it('preserves NOT NULL and DEFAULT through the rebuild', async () => {
    const active = await boot();
    await active.db.insert('stock', { id: 's1', level: '5' });

    const r = await applyRetypeColumn(active, 'stock', 'level', 'integer', 'sess');
    expect(r).toEqual({ ok: true });

    const info = await columnInfo(active, 'stock', 'level');
    expect(Number(info?.notnull)).toBe(1);
    expect(info?.dflt_value).not.toBeNull();
    // The default still applies to a row that omits the column.
    await execSql(active.db, `INSERT INTO "stock" ("id") VALUES ('s2')`);
    expect((await rowsById(active, 'stock')).get('s2')?.level).toBe(0);
  });

  it('refuses a NOT NULL column with no default rather than silently dropping the constraint', async () => {
    const active = await boot();
    await active.db.insert('strict', { id: 'x1', amount: '3' });

    const r = await applyRetypeColumn(active, 'strict', 'amount', 'integer', 'sess');
    expect(r.ok).toBe(false);
    expect(refusal(r)).toMatch(/required|not null/i);

    const info = await columnInfo(active, 'strict', 'amount');
    expect(Number(info?.notnull)).toBe(1);
    expect(active.db.getRegisteredFieldTypes('strict')?.amount).toBe('text');
  });

  it('refuses a column carrying a unique constraint it could not rebuild', async () => {
    const active = await boot();
    // A physical table whose column carries a UNIQUE constraint — SQLite builds
    // an implicit index for it that has no recreatable definition.
    await execSql(active.db, 'DROP TABLE "orders"');
    await execSql(
      active.db,
      'CREATE TABLE "orders" ("id" TEXT PRIMARY KEY, "code" TEXT, "qty" TEXT UNIQUE, "deleted_at" TEXT)',
    );
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: '1' });

    const r = await applyRetypeColumn(active, 'orders', 'qty', 'integer', 'sess');
    expect(r.ok).toBe(false);
    expect(refusal(r)).toMatch(/unique/i);

    expect(String((await columnInfo(active, 'orders', 'qty'))?.type).toUpperCase()).toBe('TEXT');
    expect(await physicalColumns(active, 'orders')).not.toContain(TEMP);
  });

  it('cleans up the temporary column when the rebuild fails mid-way', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: '1' });
    // A trigger that reads the column makes SQLite refuse the DROP COLUMN step,
    // i.e. a failure AFTER the temporary column has been added.
    await execSql(
      active.db,
      `CREATE TRIGGER "trg_orders_qty" AFTER UPDATE OF "code" ON "orders" ` +
        `BEGIN UPDATE "orders" SET "code" = "qty" WHERE "id" = NEW."id"; END`,
    );

    // The engine's own failure is what surfaces — the cleanup never replaces it.
    await expect(applyRetypeColumn(active, 'orders', 'qty', 'integer', 'sess')).rejects.toThrow(
      /qty/,
    );

    // The half-built column is gone — the user is never left with a stray
    // "<col>_lattice_retype" they cannot remove.
    expect(await physicalColumns(active, 'orders')).not.toContain(TEMP);
    expect(await physicalColumns(active, 'orders')).toContain('qty');
  });
});

describe('column retype — accepts exactly what ingest inference accepts', () => {
  it('refuses a value the importer does not read as a number (never a silent zero)', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: '1' });
    await active.db.insert('orders', { id: 'o2', code: 'A-2', qty: '$' });

    const r = await applyRetypeColumn(active, 'orders', 'qty', 'integer', 'sess');
    expect(r.ok).toBe(false);
    expect(refusal(r)).toMatch(/\$/);
    expect((await rowsById(active, 'orders')).get('o2')?.qty).toBe('$');
  });

  it('refuses boolean spellings ingest inference treats as text', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: 'yes' });
    await active.db.insert('orders', { id: 'o2', code: 'A-2', qty: 'no' });

    const r = await applyRetypeColumn(active, 'orders', 'qty', 'boolean', 'sess');
    expect(r.ok).toBe(false);
    expect((await rowsById(active, 'orders')).get('o1')?.qty).toBe('yes');
  });

  it('refuses a date spelling ingest inference treats as text', async () => {
    const active = await boot();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: 'March 5, 2026' });

    const r = await applyRetypeColumn(active, 'orders', 'qty', 'date', 'sess');
    expect(r.ok).toBe(false);
    expect((await rowsById(active, 'orders')).get('o1')?.qty).toBe('March 5, 2026');
  });

  it('numeric acceptance is the shared ingest predicate, value for value', () => {
    const samples = [
      '1',
      '42',
      '1,234',
      '$5',
      '12%',
      '(10)',
      '3.5',
      '$',
      '%',
      ',',
      'lots',
      '1 2',
      'NaN',
      'Infinity',
      '',
      '  ',
      '0x1f',
    ];
    for (const s of samples) {
      const accepted = !('problem' in canonicalizeForRetype(s, 'real'));
      // An empty/blank cell is "no value" on both sides — every other sample
      // must match the ingest inference verdict exactly.
      const expected = s.trim() === '' ? true : isNumericValue(s);
      expect([s, accepted]).toEqual([s, expected]);
    }
  });

  it('boolean + temporal acceptance mirrors ingest inference too', () => {
    for (const s of ['1', '0', 'true', 'false', 't', 'f']) {
      expect('problem' in canonicalizeForRetype(s, 'boolean')).toBe(false);
    }
    for (const s of ['yes', 'no', 'y', 'n', 'maybe']) {
      expect('problem' in canonicalizeForRetype(s, 'boolean')).toBe(true);
    }
    expect('problem' in canonicalizeForRetype('2026-01-02', 'date')).toBe(false);
    expect('problem' in canonicalizeForRetype('2026-01-02T10:30', 'datetime')).toBe(false);
    expect('problem' in canonicalizeForRetype('Jan 2 2026', 'date')).toBe(true);
    expect('problem' in canonicalizeForRetype('2026', 'date')).toBe(true);
  });
});

// ── Postgres: the dialect where a blind cast aborts instead of zeroing ────────

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('column retype (Postgres)', () => {
  const databases: string[] = [];

  async function bootPg(): Promise<{ active: ActiveDb; dbname: string }> {
    const pg = (await import('pg')).default;
    const dbname = `lattice_retype_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();
    databases.push(dbname);
    const u = new URL(PG_URL!);
    u.pathname = `/${dbname}`;
    const active = await boot(u.toString());
    await active.converged;
    return { active, dbname };
  }

  afterEach(async () => {
    if (!PG_URL || databases.length === 0) return;
    // Tear the workspace down fully (realtime listener included) before the
    // database goes away, so nothing is left reconnecting to a dropped database.
    for (const a of actives.splice(0)) await disposeActive(a);
    const pg = (await import('pg')).default;
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    for (const d of databases.splice(0)) {
      await admin
        .query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [d],
        )
        .catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${d}"`).catch(() => undefined);
    }
    await admin.end();
  });

  it('refuses a soft-deleted unconvertible value instead of aborting mid-cast', async () => {
    const { active } = await bootPg();
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: '1' });
    await active.db.insert('orders', {
      id: 'o2',
      code: 'A-2',
      qty: 'lots',
      deleted_at: '2026-01-01T00:00:00Z',
    });

    const r = await applyRetypeColumn(active, 'orders', 'qty', 'integer', 'sess');
    expect(r.ok).toBe(false);
    expect(refusal(r)).toMatch(/lots/);

    const rows = await rowsById(active, 'orders');
    expect(rows.get('o2')?.qty).toBe('lots');
    expect(active.db.getRegisteredFieldTypes('orders')?.qty).toBe('text');
  });

  it('a refused retype does not drop the cloud masking view', async () => {
    const { active } = await bootPg();
    const { secureCloud } = await import('../../src/cloud/setup.js');
    const { setColumnAudience } = await import('../../src/cloud/audience.js');
    await secureCloud(active.db);
    const cols = Object.keys(active.db.getRegisteredColumns('orders')!);
    const pk = active.db.getPrimaryKey('orders');
    await setColumnAudience(active.db, 'orders', 'code', 'owner', cols, pk);
    await active.db.insert('orders', { id: 'o1', code: 'A-1', qty: '1' });

    const viewExists = async (): Promise<boolean> => {
      const rows = await allAsyncOrSync(
        active.db.adapter,
        `SELECT table_name FROM information_schema.views
          WHERE table_schema = current_schema() AND table_name = 'orders_v'`,
      );
      return rows.length === 1;
    };
    expect(await viewExists()).toBe(true);

    // A retype that must be REFUSED — the column is not declared in the
    // workspace configuration — must not have touched the mask first.
    undeclare(active, 'orders', 'qty');
    const r = await applyRetypeColumn(active, 'orders', 'qty', 'integer', 'sess');
    expect(r.ok).toBe(false);
    expect(await viewExists()).toBe(true);
  });
});
