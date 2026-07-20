import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, type ActiveDb } from '../../src/gui/server.js';
import { createRow, updateRow, deleteRow, type MutationCtx } from '../../src/gui/mutations.js';

/**
 * A connected external table is a LIVE, READ-ONLY MIRROR: its rows are replaced on every sync.
 * A row write to it "succeeds" locally but is silently overwritten on the next sync — a
 * meaningless edit that let the assistant narrate a fake "I updated your <source> record".
 * The row-write chokepoint (create/update/delete) must REFUSE a connected table (loudly), exactly
 * as it already refuses computed views — while leaving authored tables writable and the connector
 * SYNC path (db.upsert/db.update, which bypasses this chokepoint) unaffected.
 */

const dirs: string[] = [];
const dbs: ActiveDb[] = [];

afterEach(() => {
  for (const a of dbs.splice(0)) a.db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-connwrite-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  people:', // an authored table — the control that must still accept writes
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

/** Register a connected external mirror the way the connector reregister path does. */
async function addMirror(active: ActiveDb, table = 'jira_issues'): Promise<void> {
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

function mctxOf(active: ActiveDb): MutationCtx {
  return {
    db: active.db,
    feed: active.feed,
    softDeletable: new Set(['people', 'jira_issues']),
    source: 'gui',
  } as unknown as MutationCtx;
}

describe('row-write mutations refuse connected external tables', () => {
  it('create_row / update_row / delete_row on a connected mirror are refused (loud), never a silent write', async () => {
    const active = await boot();
    await addMirror(active);
    expect(active.db.getConnectedSource('jira_issues')).toBeTruthy();
    const mctx = mctxOf(active);

    await expect(createRow(mctx, 'jira_issues', { issue_key: 'X-1', summary: 's' })).rejects.toThrow(
      /read-only view of a connected external source/i,
    );
    await expect(
      updateRow(mctx, 'jira_issues', 'X-1', { summary: 'edited' }),
    ).rejects.toThrow(/read-only view of a connected external source/i);
    await expect(deleteRow(mctx, 'jira_issues', 'X-1')).rejects.toThrow(
      /read-only view of a connected external source/i,
    );

    // Nothing landed in the mirror — the write was refused before any DB mutation.
    expect(await active.db.count('jira_issues')).toBe(0);
  });

  it('an authored table still accepts create/update/delete (the guard does not over-block)', async () => {
    const active = await boot();
    await addMirror(active); // present but irrelevant here
    const mctx = mctxOf(active);

    const { id } = await createRow(mctx, 'people', { name: 'Acme' });
    expect(id).toBeTruthy();
    expect(await active.db.count('people')).toBe(1);
    await updateRow(mctx, 'people', id, { name: 'Acme Inc' });
    expect((await active.db.get('people', id))?.name).toBe('Acme Inc');
    await deleteRow(mctx, 'people', id);
  });

  it('the connector SYNC path (db.upsert) still writes the mirror — the guard only blocks the mutation chokepoint', async () => {
    const active = await boot();
    await addMirror(active);
    // A sync writes the mirror directly via db.upsert (NOT createRow), so it is unaffected.
    await active.db.upsert('jira_issues', { issue_key: 'X-9', summary: 'synced', status: 'open' });
    expect(await active.db.count('jira_issues')).toBe(1);
  });
});
