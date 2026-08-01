import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { Lattice } from '../../src/lattice.js';
import { createConnector } from '../../src/connectors/registry.js';
import { DatabaseConnector, setDbSourceCreds } from '../../src/connectors/db-source/connector.js';
import {
  setSchemaDescriptor,
  clearSchemaDescriptor,
} from '../../src/connectors/db-source/schema-cache.js';

/**
 * A connected external database survives an app restart.
 *
 * The connect flow registers its tables on the live schema, but that
 * registration exists only in the process that made it — on a fresh open the
 * tables are still on disk while the live schema knows nothing about them, so
 * they vanish from the entity list, the graph and the table views, and (worse) a
 * reconciliation reads their rendered context as removed and deletes it.
 *
 * The replay therefore belongs to opening itself, not to any one client's open
 * path: a workspace that is open knows its connected sources, whoever opened it.
 */
describe('a connected external database across a restart', () => {
  let tmp: string;
  const CONN = 'reregtest1';
  const toolkit = `db_source:${CONN}`;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dbsrc-rereg-'));
    setDbSourceCreds(CONN, 'postgres://u:p@example.invalid:5432/db');
    setSchemaDescriptor(CONN, {
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
      ],
    });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('is known and queryable on a plain reopen, with no separate re-registration step', async () => {
    const dbPath = join(tmp, 'app.db');
    const [model] = new DatabaseConnector().models(toolkit);
    expect(model).toBeTruthy();

    // Session 1 — the connect flow: registry row + register the table (which also
    // creates it on disk).
    const s1 = new Lattice(dbPath);
    await s1.init();
    await createConnector(s1, {
      connector: 'db_source',
      toolkit,
      displayName: 'store',
      connectionRef: CONN,
      connectedBy: 'tester',
    });
    await s1.defineLate(model!.table, model!.definition);
    expect(s1.getRegisteredTableNames()).toContain(model!.table);
    s1.close();

    // Session 2 — an ordinary reopen. Nothing else is called.
    const s2 = new Lattice(dbPath);
    await s2.init();
    expect(s2.getRegisteredTableNames()).toContain(model!.table);
    await expect(s2.query(model!.table, {})).resolves.toBeInstanceOf(Array);

    // ...and it carries the per-record rendered context a table gets, so a
    // reconciliation reproduces its tree instead of reading it as removed.
    expect(s2.entityContexts().has(model!.table)).toBe(true);

    // The physical table is machine-namespaced (`db_store_authors`), but the
    // connected source carries the clean external table name — this is the
    // `entityLabel` the entities-summary enrichment surfaces so the Objects list
    // shows "Authors", not "Db Store Authors".
    expect(model!.table).toBe('db_store_authors');
    expect(s2.getConnectedSource(model!.table)?.model).toBe('authors');
    s2.close();
  });

  it('reports the source it cannot describe, rather than opening as if it were not there', async () => {
    const dbPath = join(tmp, 'lost-descriptor.db');
    const [model] = new DatabaseConnector().models(toolkit);

    const s1 = new Lattice(dbPath);
    await s1.init();
    await createConnector(s1, {
      connector: 'db_source',
      toolkit,
      displayName: 'store',
      connectionRef: CONN,
      connectedBy: 'tester',
    });
    await s1.defineLate(model!.table, model!.definition);
    s1.close();

    // The machine loses the description of the external schema — a second
    // machine, a cleared store. The tables can no longer be named from here.
    clearSchemaDescriptor(CONN);

    const s2 = new Lattice(dbPath);
    await s2.init();
    expect(s2.getRegisteredTableNames()).not.toContain(model!.table);
    // The connection is still connected, so this must not read as "no connected
    // sources" anywhere downstream — the reconciliation backstop asks the same
    // question and refuses to sweep what it cannot account for.
    const { connectedSourceTables } = await import('../../src/connectors/connected-schema.js');
    const { tables, unresolved } = await connectedSourceTables(s2);
    expect(tables.size).toBe(0);
    expect(unresolved).toEqual(['store']);
    s2.close();
  });
});
