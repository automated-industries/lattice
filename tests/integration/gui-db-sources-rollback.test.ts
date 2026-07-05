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
 * Connect-a-database failure semantics.
 *
 * The original incident this file guards was a failed connect that (a) crashed on
 * a missing __lattice_edges table and (b) left a phantom entry in BOTH the
 * Databases and Connectors sidebar sections. Those two are fixed independently:
 * removeEdge/addEdges self-create the edges table, and /api/connectors excludes
 * db_source rows. So the connect handler no longer needs an all-or-nothing
 * rollback to mask them.
 *
 * The rollback that remained was actively harmful: it treated ANY import failure
 * — including one that throws AFTER thousands of rows were already committed — by
 * soft-deleting every imported row and hard-deleting the registry row. A user who
 * connected a real database watched all their data import and then silently
 * vanish ("nothing ingested"), with the only error trace destroyed by the same
 * rollback. See docs/bugs/2026-07-05-db-source-import-then-wipe.md.
 *
 * New contract (this file):
 *  1. A SETUP failure (defineLate / RLS — before any row lands) still rolls the
 *     whole connection back: no registry row, no creds, no descriptor.
 *  2. An IMPORT failure (syncConnector) KEEPS the connection in status='error'
 *     with its last_error, KEEPS any rows already imported, and surfaces the error
 *     loudly. The connection shows in Databases with its error so the user can
 *     Refresh (retry) or Disconnect — never a silent total wipe.
 *  3. /api/connectors still excludes db_source rows.
 */

const CONN_ID = 'rollbacktest1';
const CONN_ID2 = 'rollbacktest2';

/**
 * A DatabaseConnector whose remote "connects" fine but whose FIRST (and only)
 * model's import throws immediately — i.e. an import failure where zero rows ever
 * landed. Even here the connection is kept in an error state (not wiped) so the
 * failure is visible + retryable.
 */
class ExplodingDbConnector extends DatabaseConnector {
  async connect(): Promise<{ connectionId: string; displayName: string | null }> {
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

/**
 * A DatabaseConnector with TWO tables: the first ("authors") imports real rows,
 * the second ("books") throws — reproducing the production incident where rows
 * are committed and THEN a later model's import fails. The already-imported
 * author rows must survive.
 */
class PartialImportDbConnector extends DatabaseConnector {
  async connect(): Promise<{ connectionId: string; displayName: string | null }> {
    setDbSourceCreds(CONN_ID2, 'postgres://user:pass@example.invalid:5432/db');
    setSchemaDescriptor(CONN_ID2, {
      dialect: 'postgres',
      schema: 'public',
      prefix: 'store',
      tables: [
        {
          name: 'authors',
          columns: [
            { name: 'id', sqlSpec: 'TEXT' },
            { name: 'name', sqlSpec: 'TEXT' },
          ],
          pk: ['id'],
          selected: true,
        },
        {
          name: 'books',
          columns: [
            { name: 'id', sqlSpec: 'TEXT' },
            { name: 'title', sqlSpec: 'TEXT' },
          ],
          pk: ['id'],
          selected: true,
        },
      ],
    });
    return { connectionId: CONN_ID2, displayName: 'store' };
  }

  async *listChanges(
    _toolkit: string,
    model: string,
    _ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    if (model === 'authors') {
      yield { id: 'a1', row: { id: 'a1', name: 'Ada' } };
      yield { id: 'a2', row: { id: 'a2', name: 'Grace' } };
      return;
    }
    // The second model — books — fails AFTER authors' rows have been committed.
    throw new Error('books import exploded');
  }
}

describe('db-source connect failure semantics', () => {
  let db: Lattice;
  let tmp: string;
  let server: Server;
  let base: string;
  let fake: DatabaseConnector;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'dbsrc-rb-'));
    db = new Lattice(join(tmp, 'app.db'));
    await db.init();
    fake = new ExplodingDbConnector();
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

  it('an import failure surfaces the error and KEEPS an errored connection (no silent wipe)', async () => {
    const r = await fetch(`${base}/api/db-sources/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'example.invalid', user: 'reader', database: 'db' }),
    });
    // The error is surfaced loudly (Rule 16).
    expect(r.status).toBeGreaterThanOrEqual(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain('import exploded');

    // The connection is kept in an error state — visible + retryable, not wiped.
    const rows = await listConnectors(db, 'tester');
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.lastError).toBeTruthy();

    // It shows in the Databases list with its error (NOT an empty list).
    const list = await fetch(`${base}/api/db-sources`);
    const sources = ((await list.json()) as { sources: { status: string }[] }).sources;
    expect(sources.length).toBe(1);
    expect(sources[0]?.status).toBe('error');

    // Creds + descriptor are retained so a Refresh can retry the import.
    expect(getDbSourceCreds(CONN_ID)).not.toBeNull();
    expect(getSchemaDescriptor(CONN_ID)).not.toBeNull();
  });

  it('a post-persistence import failure keeps the already-imported rows + the connection', async () => {
    fake = new PartialImportDbConnector();
    const r = await fetch(`${base}/api/db-sources/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'example.invalid', user: 'reader', database: 'db' }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain('books import exploded');

    // The connection survives in an error state.
    const rows = await listConnectors(db, 'tester');
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('error');

    // The already-imported author rows are STILL LIVE (this is the data-loss the
    // old all-or-nothing rollback caused: it soft-deleted them under one stamp).
    const models = fake.models(`db_source:${CONN_ID2}`);
    const authorsTable = models.find((m) => m.table.endsWith('authors'))?.table;
    expect(authorsTable).toBeTruthy();
    const authors = await db.query(authorsTable as string, {});
    expect(authors.length).toBe(2);

    // …and the Databases list shows the errored source, not an empty list.
    const list = await fetch(`${base}/api/db-sources`);
    const sources = ((await list.json()) as { sources: unknown[] }).sources;
    expect(sources.length).toBe(1);
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
