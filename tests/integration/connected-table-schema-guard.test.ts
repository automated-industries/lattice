import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, type ActiveDb } from '../../src/gui/server.js';
import { addUserColumn, aiDeleteEntity, softDeleteUserEntity } from '../../src/gui/schema-ops.js';

/**
 * A connected external table (db-source / Gmail / Jira / …) is a LIVE MIRROR:
 * its rows and columns are synced from the source, so it can't be reshaped from
 * inside Lattice. The assistant's schema-shape tools must recognize this and
 * REFUSE-AND-STEER, exactly as they already do for computed views and managed
 * native objects — never silently "succeed":
 *
 *  - `add_column` on a mirror would ALTER the local copy, adding a dead column
 *    the next sync ignores/drops. Before this guard it returned {ok:true}, which
 *    made the assistant produce a nonsensical result and then confabulate that
 *    the table "isn't in the workspace" (the reported bug: chat couldn't act on
 *    the connected `db_postgres_*` tables it could plainly see in its schema
 *    context).
 *  - `delete_entity` on a mirror unregisters a table the connector re-registers
 *    on the next open — a confusing no-op.
 *
 * The mirror is registered exactly the way the db-source reregister path does it
 * (defineLate with a `source` descriptor → getConnectedSource() is truthy).
 */

const dirs: string[] = [];
const dbs: ActiveDb[] = [];

afterEach(() => {
  for (const a of dbs.splice(0)) a.db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-connguard-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  people:', // an authored table — the control that must still accept columns
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: people.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  dbs.push(active);
  return active;
}

/** Register a connected external mirror the way the db-source reregister path does. */
async function addMirror(active: ActiveDb, table = 'jira_issues'): Promise<void> {
  // Let openConfig's background open-time render (an async withClient BEGIN/COMMIT
  // on the sync SQLite driver) finish before we run our own schema DDL, so the
  // defineLate below doesn't collide with an in-flight transaction. In production
  // reregister runs inline inside openConfig, before that background work starts.
  await new Promise((r) => setTimeout(r, 0));
  await active.db.defineLate(table, {
    columns: {
      issue_key: 'TEXT PRIMARY KEY',
      summary: 'TEXT',
      status: 'TEXT',
      deleted_at: 'TEXT',
    },
    primaryKey: 'issue_key',
    source: { connector: 'jira', toolkit: 'jira', model: 'issue', naturalKey: 'issue_key' },
    render: () => '',
    outputFile: 'i.md',
  });
  active.validTables.add(table);
}

describe('schema-shape mutations refuse connected external tables', () => {
  it('add_column on a connected mirror steers instead of adding a dead column', async () => {
    const active = await boot();
    await addMirror(active);
    // Sanity: the assistant CAN see it (it is in the registry / valid tables).
    expect(active.validTables.has('jira_issues')).toBe(true);
    expect(active.db.getConnectedSource('jira_issues')).toBeTruthy();

    const out = await addUserColumn(active, 'jira_issues', 'priority', 'sess');
    if (out.ok) throw new Error('expected the connected-table guard to refuse add_column');
    expect(out.error).toMatch(/connected external data source/i);

    // The mirror's shape is untouched — no ALTER ran.
    expect(active.db.getRegisteredColumns('jira_issues')).not.toHaveProperty('priority');
  });

  it('delete_entity on a connected mirror steers to disconnecting the connector', async () => {
    const active = await boot();
    await addMirror(active);

    const out = await aiDeleteEntity(active, 'jira_issues', undefined, 'sess');
    expect(out).toEqual({
      ok: false,
      error: expect.stringMatching(/disconnecting that connector/i),
    });

    // Still registered — nothing was unregistered.
    expect(active.validTables.has('jira_issues')).toBe(true);
    expect(active.db.getRegisteredTableNames()).toContain('jira_issues');
  });

  it('the data-model editor delete path (softDeleteUserEntity) refuses a connected mirror too', async () => {
    const active = await boot();
    await addMirror(active);
    await expect(softDeleteUserEntity(active, 'jira_issues', 'sess')).rejects.toThrow(
      /connected external data source/i,
    );
    expect(active.validTables.has('jira_issues')).toBe(true);
  });

  it('an authored table still accepts a new column (the guard does not over-block)', async () => {
    const active = await boot();
    await addMirror(active); // present but irrelevant here
    const out = await addUserColumn(active, 'people', 'nickname', 'sess');
    expect(out).toEqual({ ok: true, column: 'nickname' });
    expect(active.db.getRegisteredColumns('people')).toHaveProperty('nickname');
  });
});
