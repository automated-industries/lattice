import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { dispatchDbSourcesRoute } from '../../src/gui/db-sources-routes.js';
import { genericConnector } from '../../src/connectors/generic/connector.js';
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
const CONN_ID3 = 'reconnecttest1';

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

/**
 * A DatabaseConnector whose connect + import succeed, and whose reconnect is a
 * fake that records the edited credentials + re-points the stored connection
 * string — no real external pool. Lets the route-level edit flow be tested end to
 * end (connect → reconnect → re-sync) without a live Postgres.
 */
class ReconnectableDbConnector extends DatabaseConnector {
  readonly reconnectCalls: { id: string; creds: Record<string, string> }[] = [];
  async connect(): Promise<{ connectionId: string; displayName: string | null }> {
    setDbSourceCreds(CONN_ID3, 'postgres://olduser:oldpass@example.invalid:5432/db');
    setSchemaDescriptor(CONN_ID3, {
      dialect: 'postgres',
      schema: 'public',
      prefix: 'store3',
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
      ],
    });
    return { connectionId: CONN_ID3, displayName: 'store3' };
  }
  async reconnect(
    id: string,
    creds: Record<string, string>,
  ): Promise<{ connectionId: string; displayName: string | null }> {
    this.reconnectCalls.push({ id, creds });
    const user = creds.user || 'olduser';
    const pass = creds.password || 'oldpass';
    const host = creds.host || 'example.invalid';
    setDbSourceCreds(CONN_ID3, `postgres://${user}:${pass}@${host}:5432/db`);
    return { connectionId: id, displayName: 'store3' };
  }
  async *listChanges(
    _toolkit: string,
    _model: string,
    _ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    yield { id: 'a1', row: { id: 'a1', name: 'Ada' } };
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
        // The generic MCP connector is mounted (as the real GUI server does) so
        // the implementation-based GET filter has a live 'mcp' toolkit to keep.
        if (await dispatchConnectorsRoute(req, res, { ...deps, connectors: [genericConnector()] }))
          return;
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
    // The error is surfaced loudly, not swallowed.
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
    const authors = await db.query(authorsTable!, {});
    expect(authors.length).toBe(2);

    // …and the Databases list shows the errored source, not an empty list.
    const list = await fetch(`${base}/api/db-sources`);
    const sources = ((await list.json()) as { sources: unknown[] }).sources;
    expect(sources.length).toBe(1);
  });

  it('reconnect edits credentials, re-syncs, and reuses the SAME connection (no new row)', async () => {
    const rc = new ReconnectableDbConnector();
    fake = rc;
    const headers = { 'content-type': 'application/json' };

    // Establish a healthy connection.
    const c = await fetch(`${base}/api/db-sources/connect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ host: 'example.invalid', user: 'olduser', database: 'db' }),
    });
    expect(c.status).toBe(200);
    const before = await listConnectors(db, 'tester');
    expect(before.length).toBe(1);
    const id = before[0]!.id;

    // Edit: change the user + password.
    const r = await fetch(`${base}/api/db-sources/${id}/reconnect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        host: 'example.invalid',
        user: 'newuser',
        password: 'newpass',
        database: 'db',
      }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);

    // The route delegated to connector.reconnect with the edited creds…
    expect(rc.reconnectCalls.length).toBe(1);
    expect(rc.reconnectCalls[0]?.creds.user).toBe('newuser');
    expect(rc.reconnectCalls[0]?.creds.password).toBe('newpass');
    // …the stored connection string was re-pointed…
    expect(getDbSourceCreds(CONN_ID3)).toContain('newuser');
    // …and NO new registry row was created (same connection edited in place).
    const after = await listConnectors(db, 'tester');
    expect(after.length).toBe(1);
    expect(after[0]?.id).toBe(id);
    // A successful re-sync clears the connection back to healthy.
    expect(after[0]?.status).toBe('connected');
  });

  it('GET /<id>/connection returns the non-secret parts, never the password', async () => {
    const rc = new ReconnectableDbConnector();
    fake = rc;
    const headers = { 'content-type': 'application/json' };
    const c = await fetch(`${base}/api/db-sources/connect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ host: 'example.invalid', user: 'olduser', database: 'db' }),
    });
    expect(c.status).toBe(200);
    const id = (await listConnectors(db, 'tester'))[0]!.id;

    const r = await fetch(`${base}/api/db-sources/${id}/connection`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { connection: Record<string, string> };
    expect(body.connection.user).toBe('olduser');
    expect(body.connection.host).toBe('example.invalid');
    expect(JSON.stringify(body.connection)).not.toContain('oldpass');
    expect(body.connection).not.toHaveProperty('password');
  });

  it('/api/connectors excludes db_source rows (they live under Databases only)', async () => {
    await createConnector(db, {
      connector: 'db_source',
      toolkit: 'db_source:x1',
      displayName: 'somedb',
      connectionRef: 'x1',
      connectedBy: 'tester',
    });
    // A toolkit with a live implementation in the GUI catalog (the generic MCP
    // connector) IS listed; the db_source row — whose toolkit has no
    // implementation in that catalog — is not.
    await createConnector(db, {
      connector: 'mcp',
      toolkit: 'mcp',
      displayName: 'A real connector',
      connectionRef: 'c1',
      connectedBy: 'tester',
    });
    const r = await fetch(`${base}/api/connectors`);
    const body = (await r.json()) as { connectors: { toolkit: string }[] };
    const toolkits = body.connectors.map((c) => c.toolkit);
    expect(toolkits).toContain('mcp');
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
