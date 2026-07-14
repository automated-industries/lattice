import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { createConnector } from '../../src/connectors/registry.js';
import { touchConnectorTable, _resetConnectorFreshness } from '../../src/connectors/freshness.js';
import type {
  Connector,
  ConnectedModelDef,
  ExternalRecord,
  ListChangesContext,
} from '../../src/connectors/types.js';

/**
 * On-access connector freshness: reading a connector-backed table kicks a THROTTLED, stale-gated
 * background refresh (a query/dashboard touch), bounded so a burst causes at most one source sync
 * (external sources share one egress budget). Local (SQLite) only; a non-connector table + a cloud
 * DB are no-ops.
 */

const TABLE = 'demo_items';
function def(): ConnectedModelDef['definition'] {
  return {
    columns: { iid: 'TEXT PRIMARY KEY', deleted_at: 'TEXT', name: 'TEXT' },
    primaryKey: 'iid',
    source: { connector: 'fake', toolkit: 'demo', model: 'item', naturalKey: 'iid' },
    render: () => '',
    outputFile: 'demo.md',
  };
}

class FakeConnector implements Connector {
  readonly connector = 'fake';
  syncCalls = 0;
  toolkits(): string[] {
    return ['demo'];
  }
  models(): ConnectedModelDef[] {
    return [{ model: 'item', table: TABLE, naturalKey: 'iid', definition: def() }];
  }
  async authorize(): Promise<{ redirectUrl: string }> {
    return { redirectUrl: '' };
  }
  async completeAuth(): Promise<{ connectionId: string }> {
    return { connectionId: '' };
  }
  async disconnect(): Promise<void> {}
  async *listChanges(
    _t: string,
    _m: string,
    _c: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    this.syncCalls++;
    yield* []; // a cheap, real sync that yields nothing (just stamps lastSyncAt)
  }
}

describe('touchConnectorTable', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
    _resetConnectorFreshness();
  });

  async function setup(): Promise<{ db: Lattice; fake: FakeConnector }> {
    _resetConnectorFreshness();
    db = new Lattice(':memory:');
    db.define(TABLE, def());
    await db.init();
    await createConnector(db, {
      connector: 'fake',
      toolkit: 'demo',
      connectionRef: 'conn',
      connectedBy: 'u1',
    });
    return { db, fake: new FakeConnector() };
  }

  it('kicks a background refresh when a connector table is touched (stale connection)', async () => {
    const { db, fake } = await setup();
    await touchConnectorTable(db, [fake], TABLE, 1_000);
    expect(fake.syncCalls).toBe(1); // never synced → stale → refreshed
  });

  it('throttles a burst: a second touch within the window does not re-sync', async () => {
    const { db, fake } = await setup();
    await touchConnectorTable(db, [fake], TABLE, 1_000);
    await touchConnectorTable(db, [fake], TABLE, 1_000 + 30_000); // 30s < 60s throttle
    expect(fake.syncCalls).toBe(1); // second is throttled
  });

  it('is a no-op for a non-connector (authored) table', async () => {
    const { db, fake } = await setup();
    await db.defineLate('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      render: () => '',
      outputFile: 'n.md',
    });
    await touchConnectorTable(db, [fake], 'notes', 1_000);
    expect(fake.syncCalls).toBe(0);
  });

  it('never throws when there is no matching connector implementation', async () => {
    const { db } = await setup();
    // No fake in the list → nothing to sync, but the connector table exists → must not throw.
    await expect(touchConnectorTable(db, [], TABLE, 1_000)).resolves.toBeUndefined();
  });
});
