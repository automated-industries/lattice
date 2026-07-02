import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { dispatchDbSourcesRoute } from '../../src/gui/db-sources-routes.js';
import { dispatchConnectorsRoute } from '../../src/gui/connectors-routes.js';
import { createConnector, listConnectors } from '../../src/connectors/registry.js';
import {
  DatabaseConnector,
  getDbSourceCreds,
  setDbSourceCreds,
} from '../../src/connectors/db-source/connector.js';
import {
  getSchemaDescriptor,
  setSchemaDescriptor,
} from '../../src/connectors/db-source/schema-cache.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * Connect-a-database failure semantics (regressions for the production incident
 * where a failed connect crashed on __lattice_edges AND left a phantom entry in
 * BOTH the Databases and Connectors sidebar sections):
 *
 *  1. A failed initial import ROLLS BACK the whole connection — no registry row,
 *     no stored creds, no schema descriptor. A failed connect leaves NOTHING.
 *  2. /api/connectors excludes db_source rows — a connected database appears only
 *     under Databases, never double-listed under Connectors.
 */

const CONN_ID = 'rollbacktest1';

/** A DatabaseConnector whose remote "connects" fine but whose import explodes. */
class ExplodingDbConnector extends DatabaseConnector {
  async connect(): Promise<{ connectionId: string; displayName: string | null }> {
    // Mimic the real connect(): persist creds + descriptor under the new id.
    setDbSourceCreds(CONN_ID, 'postgres://user:pass@example.invalid:5432/db');
    setSchemaDescriptor(CONN_ID, {
      dialect: 'postgres',
      schema: 'public',
      prefix: 'testdb',
      tables: [
        {
          name: 'widgets',
          columns: [
            { name: 'id', sqlSpec: 'TEXT' },
            { name: 'name', sqlSpec: 'TEXT' },
          ],
          pk: ['id'],
          selected: true,
        },
      ],
    });
    return { connectionId: CONN_ID, displayName: 'testdb' };
  }

  // eslint-disable-next-line require-yield
  async *listChanges(
    _toolkit: string,
    _model: string,
    _ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    throw new Error('import exploded');
  }
}

describe('db-source connect failure semantics', () => {
  let db: Lattice;
  let tmp: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'dbsrc-rb-'));
    db = new Lattice(join(tmp, 'app.db'));
    await db.init();
    const fake = new ExplodingDbConnector();
    server = createServer((req, res) => {
      void (async () => {
        const deps = { db, outputDir: tmp, connectedBy: 'tester', feed: new FeedBus() };
        if (await dispatchDbSourcesRoute(req, res, { ...deps, connectorOverride: fake })) return;
        if (await dispatchConnectorsRoute(req, res, { ...deps, connectors: [] })) return;
        res.statusCode = 404;
        res.end('{}');
      })().catch((e: unknown) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: (e as Error).message }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a failed initial import rolls back the whole connection — nothing left behind', async () => {
    const r = await fetch(`${base}/api/db-sources/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionString: 'postgres://user:pass@example.invalid:5432/db' }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/Import failed/i);
    expect(body.error).toContain('import exploded');

    // No phantom entry in the Databases list…
    const list = await fetch(`${base}/api/db-sources`);
    expect(((await list.json()) as { sources: unknown[] }).sources).toEqual([]);
    // …no registry row at all…
    expect((await listConnectors(db, 'tester')).length).toBe(0);
    // …and the stored creds + schema descriptor were cleared by the rollback.
    expect(getDbSourceCreds(CONN_ID)).toBeNull();
    expect(getSchemaDescriptor(CONN_ID)).toBeNull();
  });

  it('/api/connectors excludes db_source rows (they live under Databases only)', async () => {
    await createConnector(db, {
      connector: 'db_source',
      toolkit: 'db_source:x1',
      displayName: 'somedb',
      connectionRef: 'x1',
      connectedBy: 'tester',
    });
    await createConnector(db, {
      connector: 'fake',
      toolkit: 'demo',
      displayName: 'A real connector',
      connectionRef: 'c1',
      connectedBy: 'tester',
    });
    const r = await fetch(`${base}/api/connectors`);
    const body = (await r.json()) as { connectors: { toolkit: string }[] };
    const toolkits = body.connectors.map((c) => c.toolkit);
    expect(toolkits).toContain('demo');
    expect(toolkits.some((t) => t.startsWith('db_source:'))).toBe(false);
  });

  it('removeEdge is safe on a DB where __lattice_edges was never created', async () => {
    // Publicly exported; previously threw "no such table: __lattice_edges" when
    // called before any addEdge had created the table.
    await expect(
      db.removeEdge({ srcTable: 'a', srcId: '1', dstTable: 'b', dstId: '2' }),
    ).resolves.toBeUndefined();
  });
});
