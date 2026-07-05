import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { Lattice } from '../../src/lattice.js';
import { createConnector } from '../../src/connectors/registry.js';
import { DatabaseConnector, setDbSourceCreds } from '../../src/connectors/db-source/connector.js';
import { setSchemaDescriptor } from '../../src/connectors/db-source/schema-cache.js';
import { reregisterDbSourceTables } from '../../src/connectors/db-source/reregister.js';

/**
 * A connected external database survives an app restart. The connect flow
 * `defineLate`s its tables, but that registration is in-memory only — on a fresh
 * open the tables persist on disk yet are absent from the live schema, so they
 * vanish from /api/entities, the graph, and the Objects/Tables views. openConfig
 * calls reregisterDbSourceTables() to replay the registration from the persisted
 * registry + schema descriptor.
 */
describe('db-source table re-registration on reopen', () => {
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

  it('a table registered at connect time is unknown after reopen, and reregister restores it', async () => {
    const dbPath = join(tmp, 'app.db');
    const [model] = new DatabaseConnector().models(toolkit);
    expect(model).toBeTruthy();

    // Session 1 — the connect flow: registry row + defineLate the table (which
    // also CREATEs it on disk).
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

    // Session 2 — a fresh open. The table exists on disk but the live schema does
    // not know it (defineLate was in-memory only).
    const s2 = new Lattice(dbPath);
    await s2.init();
    expect(s2.getRegisteredTableNames()).not.toContain(model!.table);

    // Re-registration (what openConfig runs) makes it known + queryable again.
    await reregisterDbSourceTables(s2);
    expect(s2.getRegisteredTableNames()).toContain(model!.table);
    await expect(s2.query(model!.table, {})).resolves.toBeInstanceOf(Array);
    s2.close();
  });
});
