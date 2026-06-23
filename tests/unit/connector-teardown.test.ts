import { describe, it, expect, afterEach } from 'vitest';
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
      composioConnectionId: 'conn-9',
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
