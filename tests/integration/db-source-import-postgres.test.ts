import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { Lattice } from '../../src/lattice.js';
import {
  DatabaseConnector,
  createConnector,
  syncConnector,
  type ExternalRecord,
} from '../../src/connectors/index.js';

/**
 * Real connect → introspect → import against an external Postgres. Gated on
 * LATTICE_TEST_PG_URL (the disposable cluster the integration suite boots). Uses a
 * dedicated schema so it never sees / collides with other tests' tables, and
 * disconnects to clear the machine-local creds + schema it stored.
 */

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const SCHEMA = 'dbsrc_it';

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

async function openPool(url: string): Promise<PgPool> {
  const mod = (await import('pg')) as unknown as {
    default?: { Pool: new (c: { connectionString: string }) => PgPool };
    Pool?: new (c: { connectionString: string }) => PgPool;
  };
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (!Pool) throw new Error('pg.Pool not found');
  return new Pool({ connectionString: url });
}

async function collect(it: AsyncIterable<ExternalRecord>): Promise<ExternalRecord[]> {
  const out: ExternalRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

/**
 * The connector accepts host/port/user/password/database FIELDS only (raw
 * connection strings were removed — the read-only data-source contract wants
 * deliberate credentials). Split the test cluster's URL into those fields.
 */
function connectParts(schema: string): Record<string, string> {
  const u = new URL(PG_URL!);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    schema,
  };
}

describe.skipIf(!PG_URL)('db-source import (Postgres integration)', () => {
  let admin: PgPool;

  beforeAll(async () => {
    admin = await openPool(PG_URL!);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query(
      `CREATE TABLE ${SCHEMA}.widgets (id text PRIMARY KEY, name text, qty integer, active boolean)`,
    );
    await admin.query(
      `INSERT INTO ${SCHEMA}.widgets (id, name, qty, active) VALUES
        ('w1','Alpha',3,true), ('w2','Beta',0,false), ('w3','Gamma',7,true)`,
    );
    // Composite primary key — the shape that previously corrupted: the synthesized
    // _pk was joined with a control char the row sanitizer strips, so the stored
    // key never matched the sync's seen-key and every row was soft-deleted on the
    // very sync that imported it (and the prune crashed on __lattice_edges).
    await admin.query(
      `CREATE TABLE ${SCHEMA}.orders (region text, num integer, item text, PRIMARY KEY (region, num))`,
    );
    await admin.query(
      `INSERT INTO ${SCHEMA}.orders (region, num, item) VALUES
        ('east', 1, 'anvil'), ('west', 1, 'rope')`,
    );
    // A single-column FK → widgets(id): must import as a graph edge between the
    // imported tables (the remote's relational structure carries over).
    await admin.query(
      `CREATE TABLE ${SCHEMA}.reviews (id text PRIMARY KEY, widget_id text REFERENCES ${SCHEMA}.widgets(id), rating integer)`,
    );
    await admin.query(
      `INSERT INTO ${SCHEMA}.reviews (id, widget_id, rating) VALUES ('r1','w1',5), ('r2','w2',3)`,
    );
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  it('external-pool sessions are read-only at the wire (default_transaction_read_only=on)', async () => {
    const { withExternalPool } = await import('../../src/connectors/db-source/external-pool.js');
    const flag = await withExternalPool(PG_URL!, async (pool) => {
      const r = await pool.query('SHOW default_transaction_read_only');
      return r.rows[0]?.default_transaction_read_only;
    });
    // The startup parameter reached the server: every transaction on this pool
    // defaults to read-only, so the SOURCE database refuses writes even if a
    // statement somehow slipped past the query-shape guard.
    expect(flag).toBe('on');
  });

  it('connects, introspects, and imports rows with mapped types', async () => {
    const connector = new DatabaseConnector();
    const { connectionId, displayName } = await connector.connect(connectParts(SCHEMA));
    expect(connectionId).toBeTruthy();
    expect(displayName).toBeTruthy();
    try {
      const toolkit = `db_source:${connectionId}`;
      const models = connector.models(toolkit);
      const widgets = models.find((m) => m.model === 'widgets');
      expect(widgets).toBeDefined();
      expect(widgets!.naturalKey).toBe('id');
      // qty → INTEGER, active(boolean) → INTEGER, name/id → TEXT.
      expect(widgets!.definition.columns.qty).toBe('INTEGER');
      expect(widgets!.definition.columns.active).toBe('INTEGER');
      expect(widgets!.definition.columns.name).toBe('TEXT');

      const records = await collect(
        connector.listChanges(toolkit, 'widgets', { connectionId, userId: connectionId }),
      );
      expect(records.map((r) => r.id).sort()).toEqual(['w1', 'w2', 'w3']);
      const alpha = records.find((r) => r.id === 'w1')!;
      expect(alpha.row.name).toBe('Alpha');
      expect(alpha.row.qty).toBe(3); // INTEGER coercion
      expect(alpha.row.active).toBe(1); // boolean → 1
      const beta = records.find((r) => r.id === 'w2')!;
      expect(beta.row.active).toBe(0); // boolean false → 0
    } finally {
      await connector.disconnect(connectionId);
    }
  });

  it('imports rows into a Lattice table via the sync engine, stamped with lineage', async () => {
    const connector = new DatabaseConnector();
    const { connectionId } = await connector.connect(connectParts(SCHEMA));
    const db = new Lattice(':memory:');
    await db.init();
    try {
      const toolkit = `db_source:${connectionId}`;
      const widgets = connector.models(toolkit).find((m) => m.model === 'widgets')!;
      const connectorId = await createConnector(db, {
        connector: 'db_source',
        toolkit,
        connectionRef: connectionId,
        connectedBy: 'test',
        displayName: 'test',
      });
      for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);

      const res = await syncConnector(db, connector, connectorId);
      expect(res.upserted[widgets.table]).toBe(3);

      const rows = (await db.query(widgets.table, {
        filters: [{ col: 'deleted_at', op: 'isNull' }],
      })) as Record<string, unknown>[];
      expect(rows.length).toBe(3);
      // The sync engine namespaces keys by connectorId (so two members importing
      // the same source can't collide on the shared PK).
      const w1 = rows.find((r) => r.id === `${connectorId}:w1`)!;
      expect(w1.name).toBe('Alpha');
      expect(w1.qty).toBe(3);
      // The sync engine stamps connector lineage on every imported row.
      expect(w1._source_connector_id).toBeTruthy();
    } finally {
      await connector.disconnect(connectionId);
    }
  });

  it('composite-PK rows survive the sync (and a re-sync) — no phantom prune, no edges crash', async () => {
    const connector = new DatabaseConnector();
    const { connectionId } = await connector.connect(connectParts(SCHEMA));
    const db = new Lattice(':memory:');
    await db.init();
    try {
      const toolkit = `db_source:${connectionId}`;
      const orders = connector.models(toolkit).find((m) => m.model === 'orders')!;
      expect(orders.naturalKey).toBe('_pk'); // synthesized for a composite PK
      const connectorId = await createConnector(db, {
        connector: 'db_source',
        toolkit,
        connectionRef: connectionId,
        connectedBy: 'test',
        displayName: 'test',
      });
      for (const m of connector.models(toolkit)) await db.defineLate(m.table, m.definition);

      // FIRST sync: both rows land and STAY live. Previously the control-char-
      // joined _pk was stripped by the sanitizer at storage time, so the prune
      // judged every row vanished — soft-deleting the whole import (live=0) and
      // crashing on the never-created __lattice_edges table.
      const res1 = await syncConnector(db, connector, connectorId);
      expect(res1.upserted[orders.table]).toBe(2);
      expect(res1.softDeleted[orders.table] ?? 0).toBe(0);
      const live1 = (await db.query(orders.table, {
        filters: [{ col: 'deleted_at', op: 'isNull' }],
      })) as Record<string, unknown>[];
      expect(live1.length).toBe(2);

      // SECOND sync: idempotent — still 2 live, nothing pruned.
      const res2 = await syncConnector(db, connector, connectorId);
      expect(res2.softDeleted[orders.table] ?? 0).toBe(0);
      const live2 = (await db.query(orders.table, {
        filters: [{ col: 'deleted_at', op: 'isNull' }],
      })) as Record<string, unknown>[];
      expect(live2.length).toBe(2);

      // GENUINE remote delete → the prune fires on a workspace whose local DB has
      // no __lattice_edges table (db-source models emit no graph edges, so nothing
      // ever created it). Previously: "no such table: __lattice_edges". Now the
      // prune self-ensures the table and soft-deletes exactly the vanished row.
      await admin.query(`DELETE FROM ${SCHEMA}.orders WHERE region='west' AND num=1`);
      const res3 = await syncConnector(db, connector, connectorId);
      expect(res3.softDeleted[orders.table]).toBe(1);
      const live3 = (await db.query(orders.table, {
        filters: [{ col: 'deleted_at', op: 'isNull' }],
      })) as Record<string, unknown>[];
      expect(live3.length).toBe(1);
    } finally {
      await connector.disconnect(connectionId);
    }
  });

  it('imports remote FOREIGN KEYs as graph edges + namespaces tables per connection', async () => {
    const connector = new DatabaseConnector();
    const { connectionId } = await connector.connect(connectParts(SCHEMA));
    const db = new Lattice(':memory:');
    await db.init();
    try {
      const toolkit = `db_source:${connectionId}`;
      const models = connector.models(toolkit);
      const reviews = models.find((m) => m.model === 'reviews')!;
      const widgets = models.find((m) => m.model === 'widgets')!;

      // Table names carry a short connection-id suffix, so two connections whose
      // databases share a name (every Supabase DB is "postgres") can never merge
      // into the same imported tables.
      expect(reviews.table).toContain(`_${connectionId.slice(0, 4)}_`);

      // The remote FK reviews.widget_id → widgets.id imports as a graph edge spec.
      expect(reviews.graphEdges).toEqual([
        { fkColumn: 'widget_id', dstTable: widgets.table, type: 'references' },
      ]);

      const connectorId = await createConnector(db, {
        connector: 'db_source',
        toolkit,
        connectionRef: connectionId,
        connectedBy: 'test',
        displayName: 'test',
      });
      for (const m of models) await db.defineLate(m.table, m.definition);
      const res = await syncConnector(db, connector, connectorId);
      expect(res.upserted[reviews.table]).toBe(2);
      // Two review rows → two derived edges into the imported widgets table.
      expect(res.edges).toBe(2);
      const out = await db.neighbors(
        { table: reviews.table, id: `${connectorId}:r1` },
        { direction: 'out' },
      );
      expect(out.length).toBe(1);
      expect(out[0]!.dstTable).toBe(widgets.table);
      expect(out[0]!.dstId).toBe(`${connectorId}:w1`);
      expect(out[0]!.type).toBe('references');
    } finally {
      await connector.disconnect(connectionId);
    }
  });
});
