import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { enableConnectorRls } from '../../src/connectors/acl.js';
import type { Connector, ConnectedModelDef, ExternalRecord } from '../../src/connectors/types.js';

/**
 * 4.3 — connector ACL helper. RLS is a cloud-Postgres concern; on SQLite it must
 * be a safe no-op (it never throws, and applies no DDL). The cloud per-member
 * behavior is exercised by the PG integration suite.
 */

const MODELS: ConnectedModelDef[] = [
  {
    model: 'thing',
    table: 'demo_things',
    naturalKey: 'tid',
    definition: {
      columns: { tid: 'TEXT PRIMARY KEY', deleted_at: 'TEXT' },
      primaryKey: 'tid',
      source: { connector: 'fake', toolkit: 'demo', model: 'thing', naturalKey: 'tid' },
      render: () => '',
      outputFile: 'd.md',
    },
  },
];

class FakeConnector implements Connector {
  readonly connector = 'fake';
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
  async disconnect() {}
  async *listChanges(): AsyncIterable<ExternalRecord> {}
}

describe('connector ACL (SQLite no-op)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('is a safe no-op on SQLite', async () => {
    db = new Lattice(':memory:');
    await db.init();
    await db.defineLate('demo_things', MODELS[0]!.definition);
    // Must not throw and must not have applied any RLS DDL (SQLite has no RLS).
    await expect(enableConnectorRls(db, new FakeConnector(), 'demo')).resolves.toBeUndefined();
  });
});
