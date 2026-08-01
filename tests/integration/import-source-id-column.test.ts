/**
 * An import whose source carries its own `id` column still produces a table
 * whose real primary key is the one the workspace declares.
 *
 * Every imported entity table is created with a synthetic `id TEXT PRIMARY KEY`
 * and is registered declaring `id` as its primary key. A source column literally
 * named `id` — the commonest shape in a CSV, JSON or database export — used to
 * overwrite that column definition, so the table was created with no key at all
 * while the registration still claimed one.
 *
 * Nothing failed at import time. The first upsert did, because every upsert
 * names the declared key in an `ON CONFLICT` clause and the relation has no such
 * constraint. Moving the workspace onto a shared database issues exactly that
 * statement per row, so the copy aborted part-way — after the target database
 * was already holding some of the workspace.
 *
 * The Postgres half is gated on a real cluster because the failure it pins is a
 * real copy onto a real second database; the local half needs no cluster and
 * runs everywhere.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Lattice, migrateWorkspaceToCloud } from '../../src/index.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import { inferSchema } from '../../src/import/infer.js';
import { dedupeAndDetectViews } from '../../src/import/dedupe-views.js';
import { materializeImport } from '../../src/import/materialize.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

const dirs: string[] = [];
const databases: string[] = [];
const opened: Lattice[] = [];

/** Three records that each carry their own `id`, as an export of them would. */
const ORDERS = {
  orders: [
    { id: 'o-1', customer: 'Anna Fields', amount: 120 },
    { id: 'o-2', customer: 'Bo Lindqvist', amount: 240 },
    { id: 'o-3', customer: 'Cai Ruiz', amount: 360 },
  ],
};

function dbUrl(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  return u.toString();
}

afterEach(async () => {
  for (const db of opened.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const name of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined);
  }
  await admin.end();
});

/** A fresh local workspace with `data` imported into it (default {@link ORDERS}). */
async function workspaceWithImport(
  data: Record<string, unknown> = ORDERS,
  opts: { asOf?: string } = {},
): Promise<{ db: Lattice; configPath: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-import-source-id-'));
  dirs.push(root);
  mkdirSync(join(root, 'context'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(configPath, 'db: ./lattice.db\nentities: {}\n', 'utf8');
  const db = new Lattice(
    { config: configPath },
    { encryptionKey: Buffer.alloc(32, 7).toString('base64') },
  );
  registerNativeEntities(db);
  await db.init();
  opened.push(db);
  const plan = await inferSchema(data);
  await materializeImport({ db, configPath }, data, plan, [], opts);
  return { db, configPath };
}

/**
 * The primary key the RELATION actually has, read from the catalog — not the one
 * the workspace declares. The whole defect was the two disagreeing, so the test
 * has to ask the database rather than the schema layer.
 */
async function actualPrimaryKey(db: Lattice, table: string): Promise<string[]> {
  if (db.adapter.dialect === 'postgres') {
    const rows = await allAsyncOrSync(
      db.adapter,
      `SELECT a.attname AS name, k.ord AS ord
         FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = to_regclass('${table}') AND i.indisprimary
        ORDER BY k.ord`,
    );
    return rows.map((r) => String(r.name));
  }
  const rows = await allAsyncOrSync(db.adapter, `PRAGMA table_info("${table}")`);
  return rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => String(r.name));
}

describe('importing a source that carries its own id column', () => {
  it('creates a table whose real key is the key the workspace declares', async () => {
    const { db } = await workspaceWithImport();

    expect(db.getRegisteredTableNames()).toContain('orders');
    // What the workspace declares…
    expect(db.getPrimaryKey('orders')).toEqual(['id']);
    // …and what the relation actually has. These disagreed: the source's `id`
    // column overwrote the synthetic key's definition, leaving no key at all.
    expect(await actualPrimaryKey(db, 'orders')).toEqual(['id']);

    // The source's own identifiers are not dropped to make room for the key.
    const rows = (await db.query('orders', {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.source_id).sort()).toEqual(['o-1', 'o-2', 'o-3']);
  });

  it('produces a table an upsert can actually write to', async () => {
    const { db } = await workspaceWithImport();
    const [first] = (await db.query('orders', {})) as { id: string }[];

    // Every upsert names the declared key in an ON CONFLICT clause. Against a
    // table created without that key it fails outright — which is what aborted
    // the copy below, and what any later sync of this table would hit too.
    await db.upsert('orders', { id: first!.id, amount: 999 });

    const after = (await db.query('orders', {})) as { id: string; amount: number }[];
    expect(after).toHaveLength(3);
    expect(after.find((r) => r.id === first!.id)?.amount).toBe(999);
  });

  it('still resolves a reference that points at another table’s source id', async () => {
    // `orders.customer` holds `customers.id` values, so the inferred link
    // resolves against the column that source `id` was materialized into. Read
    // back under the wrong name it matches nothing and the junction comes out
    // empty — silently, since an unresolved reference is reported, not fatal.
    const { db } = await workspaceWithImport({
      customers: [
        { id: 'c-1', name: 'Anna Fields' },
        { id: 'c-2', name: 'Bo Lindqvist' },
      ],
      orders: [
        { id: 'o-1', customer: 'c-1', amount: 120 },
        { id: 'o-2', customer: 'c-2', amount: 240 },
        { id: 'o-3', customer: 'c-1', amount: 360 },
      ],
    });

    const edges = (await db.query('orders_customers', {})) as Record<string, unknown>[];
    expect(edges).toHaveLength(3);
    const customers = (await db.query('customers', {})) as { id: string; source_id: string }[];
    const orders = (await db.query('orders', {})) as { id: string; source_id: string }[];
    const byEdge = edges.map(
      (e) =>
        orders.find((o) => o.id === e.orders_id)!.source_id +
        '->' +
        customers.find((c) => c.id === e.customers_id)!.source_id,
    );
    expect(byEdge.sort()).toEqual(['o-1->c-1', 'o-2->c-2', 'o-3->c-1']);
  });

  it('keeps appending dated snapshots that repeat the same source ids', async () => {
    // This is why the source's `id` is carried alongside the synthetic key
    // rather than becoming it: a later snapshot of the same records repeats
    // their identifiers, so a real PRIMARY KEY over them would reject it.
    const { db, configPath } = await workspaceWithImport(ORDERS, { asOf: '2026-01-31' });
    const plan = await inferSchema(ORDERS);
    await materializeImport({ db, configPath }, ORDERS, plan, [], { asOf: '2026-02-28' });

    const rows = (await db.query('orders', {})) as { source_id: string; as_of: string }[];
    expect(rows).toHaveLength(6);
    expect(
      rows
        .filter((r) => r.source_id === 'o-1')
        .map((r) => r.as_of)
        .sort(),
    ).toEqual(['2026-01-31', '2026-02-28']);
  });

  it('builds a reconstructed view that filters on a source id', async () => {
    // A per-value tab is materialized as `master WHERE <discriminator> = <tab>`.
    // When the discriminator IS the master's source `id` column, the WHERE must
    // name the column that one became — pointed at the synthetic key instead it
    // matches nothing and the view comes out empty rather than failing.
    const data = {
      regions: [
        { id: 'east', code: 'AAA', name: 'Alpha' },
        { id: 'east', code: 'BBB', name: 'Beta' },
        { id: 'west', code: 'CCC', name: 'Gamma' },
        { id: 'west', code: 'DDD', name: 'Delta' },
      ],
      east: [
        { code: 'AAA', name: 'Alpha' },
        { code: 'BBB', name: 'Beta' },
      ],
    };
    const root = mkdtempSync(join(tmpdir(), 'lattice-import-source-id-view-'));
    dirs.push(root);
    mkdirSync(join(root, 'context'), { recursive: true });
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(configPath, 'db: ./lattice.db\nentities: {}\n', 'utf8');
    const db = new Lattice(
      { config: configPath },
      { encryptionKey: Buffer.alloc(32, 7).toString('base64') },
    );
    registerNativeEntities(db);
    await db.init();
    opened.push(db);

    const detected = await dedupeAndDetectViews(await inferSchema(data), data);
    expect(detected.views.map((v) => v.filterColumn)).toEqual(['id']);
    const result = await materializeImport({ db, configPath }, data, detected.plan, detected.views);

    expect(result.views.map((v) => v.rows)).toEqual([2]);
    const rows = (await db.query('east', {})) as { code: string }[];
    expect(rows.map((r) => r.code).sort()).toEqual(['AAA', 'BBB']);
  });

  it('does not clobber a source that carries BOTH id and source_id', async () => {
    const { db } = await workspaceWithImport({
      shipments: [
        { id: 's-1', source_id: 'legacy-a', weight: 10 },
        { id: 's-2', source_id: 'legacy-b', weight: 20 },
      ],
    });

    expect(await actualPrimaryKey(db, 'shipments')).toEqual(['id']);
    const rows = (await db.query('shipments', {})) as Record<string, string>[];
    expect(rows.map((r) => r.source_id).sort()).toEqual(['legacy-a', 'legacy-b']);
    expect(rows.map((r) => r.source_id_).sort()).toEqual(['s-1', 's-2']);
  });

  it('re-imports into a table an EARLIER version already created, unchanged', async () => {
    // That table holds the source's identifiers in `id` itself and has no column
    // to move them to — a re-import that insisted on the new name would write to
    // a column the relation does not have, and split one record set across two.
    // So a table that already exists keeps the shape it has; the mapping only
    // decides where a column lands when the table is being created.
    const root = mkdtempSync(join(tmpdir(), 'lattice-import-source-id-prior-'));
    dirs.push(root);
    mkdirSync(join(root, 'context'), { recursive: true });
    const configPath = join(root, 'lattice.config.yml');
    // The workspace config the earlier version wrote for this exact import:
    // `id` carries the source's value and is not flagged as the primary key.
    writeFileSync(
      configPath,
      [
        'db: ./lattice.db',
        'entities:',
        '  orders:',
        '    fields:',
        '      id:',
        '        type: text',
        '      customer:',
        '        type: text',
        '      amount:',
        '        type: integer',
        '      deleted_at:',
        '        type: text',
        '    outputFile: .schema-only/orders.md',
        '',
      ].join('\n'),
      'utf8',
    );
    const db = new Lattice(
      { config: configPath },
      { encryptionKey: Buffer.alloc(32, 7).toString('base64') },
    );
    registerNativeEntities(db);
    await db.init();
    opened.push(db);
    await db.insert('orders', { id: 'o-1', customer: 'Anna Fields', amount: 120 });

    await materializeImport({ db, configPath }, ORDERS, await inferSchema(ORDERS));

    // Deduped against the row that was already there, in the column it is in —
    // not appended beside it under a second identity.
    const rows = (await db.query('orders', {})) as { id: string; source_id?: string }[];
    expect(rows.map((r) => r.id).sort()).toEqual(['o-1', 'o-2', 'o-3']);
    expect(rows.every((r) => r.source_id === undefined)).toBe(true);
    // …and the config still describes the table the database actually has.
    expect(readFileSync(configPath, 'utf8')).not.toContain('source_id');
  });
});

describe.skipIf(!PG_URL)('moving that workspace onto a shared database', () => {
  it('copies it in full instead of aborting part-way through', async () => {
    const dbname = `lattice_import_id_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    {
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();
    }
    const { db, configPath } = await workspaceWithImport();

    // The copy writes each row with the same upsert the local half exercises, so
    // a table with no key aborts here — after the target already holds part of
    // the workspace, and before row security is installed on it.
    const result = await migrateWorkspaceToCloud({
      db,
      configPath,
      url: dbUrl(dbname),
      label: `imp_${randomBytes(3).toString('hex')}`,
      encryptionKey: Buffer.alloc(32, 7).toString('base64'),
      releaseSource: () => {
        db.close();
      },
    });
    expect(result.tablesCopied).toContain('orders');

    const target = new Lattice(dbUrl(dbname));
    opened.push(target);
    await target.init({ introspectOnly: true });
    expect(await actualPrimaryKey(target, 'orders')).toEqual(['id']);
    const rows = (await target.query('orders', {})) as { source_id: string }[];
    expect(rows.map((r) => r.source_id).sort()).toEqual(['o-1', 'o-2', 'o-3']);
  }, 180_000);
});
