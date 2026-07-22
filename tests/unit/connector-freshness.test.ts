import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { createConnector } from '../../src/connectors/registry.js';
import { touchConnectorTable, _resetConnectorFreshness } from '../../src/connectors/freshness.js';
import { builtinConnectors, freshnessConnectors } from '../../src/connectors/catalog.js';
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

// An external-DB (db_source) connector, minimal — mirrors FakeConnector but for the db_source
// kind, so on-access freshness can be exercised for imported `db_…` tables too.
const DB_TABLE = 'db_x_books';
function dbDef(): ConnectedModelDef['definition'] {
  return {
    columns: { bid: 'TEXT PRIMARY KEY', deleted_at: 'TEXT', title: 'TEXT' },
    primaryKey: 'bid',
    source: { connector: 'db_source', toolkit: 'db_source:x', model: 'book', naturalKey: 'bid' },
    render: () => '',
    outputFile: 'b.md',
  };
}
class FakeDbSourceConnector implements Connector {
  readonly connector = 'db_source';
  syncCalls = 0;
  toolkits(): string[] {
    return ['db_source:x'];
  }
  models(): ConnectedModelDef[] {
    return [{ model: 'book', table: DB_TABLE, naturalKey: 'bid', definition: dbDef() }];
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
    yield* [];
  }
}

describe('on-access freshness connector set', () => {
  afterEach(() => {
    _resetConnectorFreshness();
  });

  it('freshnessConnectors includes db_source, builtinConnectors does not (regression: db_source refresh was a silent no-op)', () => {
    // The bug: read-routes passed builtinConnectors() (MCP only), so touching an imported
    // external-DB table resolved no connector impl and never refreshed. The freshness set is a
    // superset that includes db_source.
    expect(builtinConnectors().some((c) => c.connector === 'db_source')).toBe(false);
    expect(freshnessConnectors().some((c) => c.connector === 'db_source')).toBe(true);
    expect(freshnessConnectors().some((c) => c.connector === 'mcp')).toBe(true);
    // The hand-authored connectors must ALSO be in the freshness set (freshnessConnectors
    // now derives from builtinConnectors) — otherwise on-access refresh silently no-ops
    // for their tables and re-warns on every dashboard query.
    for (const c of ['atlassian', 'gmail', 'calendar', 'drive', 'slack', 'salesforce']) {
      expect(freshnessConnectors().some((x) => x.connector === c)).toBe(true);
    }
  });

  it('refreshes an external-DB (db_source) table when the db_source connector is in the set', async () => {
    _resetConnectorFreshness();
    const db = new Lattice(':memory:');
    db.define(DB_TABLE, dbDef());
    await db.init();
    await createConnector(db, {
      connector: 'db_source',
      toolkit: 'db_source:x',
      connectionRef: 'c',
      connectedBy: 'u1',
    });
    const fakeDb = new FakeDbSourceConnector();
    await touchConnectorTable(db, [fakeDb], DB_TABLE, 1_000);
    expect(fakeDb.syncCalls).toBe(1); // never synced → stale → refreshed (not silently skipped)
    db.close();
  });
});
