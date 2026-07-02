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
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  it('connects, introspects, and imports rows with mapped types', async () => {
    const connector = new DatabaseConnector();
    const { connectionId, displayName } = await connector.connect({
      connectionString: PG_URL!,
      schema: SCHEMA,
    });
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
    const { connectionId } = await connector.connect({
      connectionString: PG_URL!,
      schema: SCHEMA,
    });
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
});
