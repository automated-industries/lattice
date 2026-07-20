import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { createConnector, getConnector } from '../../src/connectors/registry.js';
import { syncConnector } from '../../src/connectors/sync.js';
import { disconnectConnector } from '../../src/connectors/teardown.js';
import type { Connector, ConnectedModelDef, ExternalRecord } from '../../src/connectors/types.js';

/**
 * 4.3 — disconnect teardown: soft-deletes ingested rows, marks the connector
 * disconnected (or removes it in hard mode), and revokes the backend connection.
 */

const MODELS: ConnectedModelDef[] = [
  {
    model: 'project',
    table: 'demo_projects',
    naturalKey: 'pid',
    definition: {
      columns: { pid: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'pid',
      source: { connector: 'fake', toolkit: 'demo', model: 'project', naturalKey: 'pid' },
      render: () => '',
      outputFile: 'p.md',
    },
  },
  {
    model: 'task',
    table: 'demo_tasks',
    naturalKey: 'tid',
    definition: {
      columns: { tid: 'TEXT PRIMARY KEY', title: 'TEXT', pid: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'tid',
      source: { connector: 'fake', toolkit: 'demo', model: 'task', naturalKey: 'tid' },
      render: () => '',
      outputFile: 't.md',
    },
  },
];

class FakeConnector implements Connector {
  readonly connector = 'fake';
  revoked: string[] = [];
  toolkits() {
    return ['demo'];
  }
  models() {
    return MODELS;
  }
  async authorize() {
    return { redirectUrl: '' };
  }
  async completeAuth() {
    return { connectionId: '' };
  }
  async disconnect(id: string) {
    this.revoked.push(id);
  }
  async *listChanges(_t: string, model: string): AsyncIterable<ExternalRecord> {
    if (model === 'project') yield { id: 'P1', row: { pid: 'P1', name: 'Alpha' } };
    else if (model === 'task') yield { id: 'T1', row: { tid: 'T1', title: 'x', pid: 'P1' } };
  }
}

describe('connector teardown (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setupAndSync(): Promise<{ db: Lattice; fake: FakeConnector; id: string }> {
    db = new Lattice(':memory:');
    await db.init();
    const fake = new FakeConnector();
    const id = await createConnector(db, {
      connector: 'fake',
      toolkit: 'demo',
      connectionRef: 'conn-9',
      connectedBy: 'u1',
    });
    await syncConnector(db, fake, id);
    return { db, fake, id };
  }

  it('soft mode: rows vanish, status becomes disconnected, connection revoked', async () => {
    const { db, fake, id } = await setupAndSync();
    expect(await db.query('demo_tasks', {})).toHaveLength(1);

    const res = await disconnectConnector(db, fake, id);
    expect(res.softDeleted).toEqual({ demo_tasks: 1, demo_projects: 1 });

    // rows no longer available (hidden from live reads: render/search/GUI filter deleted_at)
    expect(await live(db, 'demo_tasks')).toHaveLength(0);
    expect(await live(db, 'demo_projects')).toHaveLength(0);
    // but SOFT-deleted, not hard-deleted: still physically present with deleted_at set
    const t1 = (await db.query('demo_tasks', {}))[0];
    expect(t1).toBeDefined();
    expect(t1!.deleted_at).toBeTruthy();
    // registry row kept, marked disconnected
    expect((await getConnector(db, id))?.status).toBe('disconnected');
    // backend connection revoked
    expect(fake.revoked).toEqual(['conn-9']);
  });

  it('hard mode removes the registry record', async () => {
    const { db, fake, id } = await setupAndSync();
    await disconnectConnector(db, fake, id, { mode: 'hard' });
    expect(await getConnector(db, id)).toBeNull();
    expect(await live(db, 'demo_tasks')).toHaveLength(0);
    // rows soft-deleted (recoverable), not physically destroyed
    expect((await db.query('demo_tasks', {}))[0]?.deleted_at).toBeTruthy();
    expect(fake.revoked).toEqual(['conn-9']);
  });
});

/** Rows visible to live reads (render/search/GUI all filter deleted_at IS NULL). */
function live(db: Lattice, table: string): Promise<unknown[]> {
  return db.query(table, { filters: [{ col: 'deleted_at', op: 'isNull' }] });
}

/**
 * Regression: disconnecting a db-source whose tables were registered in an
 * EARLIER process (so the disconnecting session doesn't know them) and whose
 * natural key is NOT `id` (a composite/keyless import uses `_pk`). The teardown
 * soft-deletes rows via the query/update layer, which — for an unregistered
 * table — fell back to a default `id` primary key that the table doesn't have,
 * throwing `no such column: id`. disconnectConnector now registers the models
 * first, so PK resolution uses the real `_pk`.
 */
const PK_MODELS: ConnectedModelDef[] = [
  {
    model: 'orders',
    table: 'db_x_orders',
    naturalKey: '_pk',
    definition: {
      // A composite/keyless import — the synthesized PK column is `_pk`, no `id`.
      columns: {
        _pk: 'TEXT PRIMARY KEY',
        region: 'TEXT',
        _source_connector_id: 'TEXT',
        deleted_at: 'TEXT',
      },
      primaryKey: '_pk',
      source: { connector: 'dbx', toolkit: 'demo', model: 'orders', naturalKey: '_pk' },
      render: () => '',
      outputFile: '.schema-only/db_x_orders.md',
    },
  },
];

class PkConnector implements Connector {
  readonly connector = 'dbx';
  revoked: string[] = [];
  toolkits() {
    return ['demo'];
  }
  models() {
    return PK_MODELS;
  }
  async authorize() {
    return { redirectUrl: '' };
  }
  async completeAuth() {
    return { connectionId: '' };
  }
  async disconnect(id: string) {
    this.revoked.push(id);
  }
  // eslint-disable-next-line require-yield
  async *listChanges(): AsyncIterable<ExternalRecord> {
    throw new Error('unused');
  }
}

describe('connector teardown — unregistered composite-PK table (regression)', () => {
  let dir: string;
  let dbFile: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('disconnects a `_pk` db-source table not registered this session (no "no such column: id")', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-teardown-'));
    dbFile = join(dir, 'app.db');

    // Session 1: register the table, plant rows + the connector registry row.
    const s1 = new Lattice(dbFile);
    await s1.init();
    await s1.defineLate('db_x_orders', PK_MODELS[0]!.definition);
    const connId = await createConnector(s1, {
      connector: 'dbx',
      toolkit: 'demo',
      connectionRef: 'conn-x',
      connectedBy: 'u1',
    });
    await s1.insert('db_x_orders', {
      _pk: '["east",1]',
      region: 'east',
      _source_connector_id: connId,
    });
    await s1.insert('db_x_orders', {
      _pk: '["west",1]',
      region: 'west',
      _source_connector_id: connId,
    });
    s1.close();

    // Session 2 (fresh): does NOT register db_x_orders. Disconnect must still
    // work — the fix registers the models first so the real `_pk` PK is used.
    const s2 = new Lattice(dbFile);
    await s2.init();
    const conn = new PkConnector();
    const res = await disconnectConnector(s2, conn, connId, { mode: 'hard' });
    expect(res.softDeleted).toEqual({ db_x_orders: 2 });
    expect(await live(s2, 'db_x_orders')).toHaveLength(0);
    expect(conn.revoked).toEqual(['conn-x']);
    s2.close();
  });
});
