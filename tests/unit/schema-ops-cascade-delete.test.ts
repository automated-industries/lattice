import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfig, type ActiveDb } from '../../src/gui/server.js';
import { applySchemaConfig } from '../../src/gui/lifecycle.js';
import {
  aiDeleteEntity,
  createFileJunction,
  inboundLinksTo,
  removeInboundLinks,
} from '../../src/gui/schema-ops.js';
import {
  createRow,
  revertEntry,
  parseAudit,
  type AuditEntry,
  type MutationCtx,
} from '../../src/gui/mutations.js';

/**
 * Cascading table deletion.
 *
 * A table that anything links to used to be undeletable: the only resolution
 * that carried inbound links across was a MERGE into another table, and the
 * refusal told the caller to "remove those links first". For an automatically
 * created `files_<table>` link table that advice is a loop — the link table is
 * itself a table with links pointing at it, so removing it hits the same
 * refusal. These specs pin the two halves of the fix:
 *
 *   1. a link table that exists ONLY to express a relationship with the table
 *      being deleted is part of that relationship, so it goes with it and never
 *      gates the delete;
 *   2. a first-class table whose own rows point here still gates the delete, but
 *      the gate now hands back the links WITH their row counts and a third
 *      resolution — `delete_cascade` — that removes them too.
 *
 * Everything the cascade touches goes through the shared audited mutation
 * primitives, so the whole operation is reversible from history.
 */

const dirs: string[] = [];
let live: ActiveDb | null = null;

afterEach(() => {
  if (live) {
    live.db.close();
    live = null;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A workspace with `a`, a first-class child `b` (belongsTo a), and an
 * automatically created `files_a` link table carrying rows — the exact shape
 * that used to be impossible to delete.
 */
async function boot(): Promise<ActiveDb> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-cascade-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  a:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: a.md',
      '  b:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      a_id: { type: uuid }',
      '      deleted_at: { type: text }',
      '    relations:',
      '      a: { type: belongsTo, table: a, foreignKey: a_id }',
      '    outputFile: b.md',
      '  c:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: c.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const active = await openConfig(configPath, join(root, 'context'), false);
  // Open kicks off background convergence; wait it out so the specs' own schema
  // work never races it for the connection's single transaction slot.
  await active.converged;
  live = active;
  return active;
}

/** Seed: two `a` rows, two `b` rows pointing at them, one unrelated `b` row, and
 *  a `files_a` link table with two rows. */
async function seed(active: ActiveDb): Promise<void> {
  await active.db.insert('a', { id: 'a1', name: 'Ada' });
  await active.db.insert('a', { id: 'a2', name: 'Linus' });
  await active.db.insert('b', { id: 'b1', name: 'child-1', a_id: 'a1' });
  await active.db.insert('b', { id: 'b2', name: 'child-2', a_id: 'a2' });
  await active.db.insert('b', { id: 'b3', name: 'unrelated', a_id: null });
  const junction = await createFileJunction(active, 'a', 'sess');
  expect(junction?.junction).toBe('files_a');
  await active.db.insert('files_a', { id: 'j1', file_id: 'f1', a_id: 'a1' });
  await active.db.insert('files_a', { id: 'j2', file_id: 'f2', a_id: 'a2' });
}

/** Every audit row, newest last. */
async function auditEntries(active: ActiveDb): Promise<AuditEntry[]> {
  const rows = (await active.db.query('_lattice_gui_audit', {
    orderBy: 'ts',
    orderDir: 'asc',
  })) as Record<string, unknown>[];
  return rows.map(parseAudit);
}

function mctxFor(active: ActiveDb): MutationCtx {
  return {
    db: active.db,
    feed: active.feed,
    softDeletable: active.softDeletable,
    source: 'gui',
  };
}

/** Physical row count straight off the adapter — proves a soft delete kept the
 *  table and its bytes, independently of what the registry now lists. */
async function physicalCount(active: ActiveDb, table: string): Promise<number> {
  const adapter = (
    active.db as unknown as { _adapter: { allAsync?: (s: string) => Promise<unknown[]> } }
  )._adapter;
  const rows = (await adapter.allAsync?.(`SELECT count(*) AS n FROM "${table}"`)) as
    | { n: number }[]
    | undefined;
  return rows?.[0]?.n ?? -1;
}

describe('inboundLinksTo', () => {
  it('separates relationship-owned link tables from first-class tables', async () => {
    const active = await boot();
    await seed(active);

    const links = inboundLinksTo(active, 'a');
    const byTable = new Map(links.map((l) => [l.table, l]));
    // The automatically created files link table belongs to the relationship.
    expect(byTable.get('files_a')?.owned).toBe(true);
    // `b` carries its own data, so it is not owned by the relationship.
    expect(byTable.get('b')?.owned).toBe(false);
    expect(byTable.get('b')?.foreignKey).toBe('a_id');
  });

  it('a link table that has since gained a payload column is no longer owned', async () => {
    const active = await boot();
    await seed(active);

    // A write carrying a field the link table does not have creates that column
    // (the auto-column path every write goes through). From that moment the
    // table holds data of its own, which lives nowhere else.
    await createRow(mctxFor(active), 'files_a', {
      id: 'j3',
      file_id: 'f3',
      a_id: 'a1',
      note: 'signed copy',
    });

    const byTable = new Map(inboundLinksTo(active, 'a').map((l) => [l.table, l]));
    // Classified from the shape it has NOW, not from the shape it was created
    // with — otherwise the deletion of `a` would take this data with it.
    expect(byTable.get('files_a')?.owned).toBe(false);
  });
});

describe('delete_cascade', () => {
  it('a table whose only inbound link is its own link table deletes with no resolution', async () => {
    const active = await boot();
    // `c` has nothing but a files link table pointing at it. Before the fix this
    // was undeletable: the link table blocked `c`, and deleting the link table
    // first hit the same refusal, because it too has links pointing at it.
    const junction = await createFileJunction(active, 'c', 'sess');
    expect(junction?.junction).toBe('files_c');

    const out = await aiDeleteEntity(active, 'c', undefined, 'sess');
    expect(out).toMatchObject({ ok: true, deleted: 'c', droppedLinkTables: ['files_c'] });
    expect(active.validTables.has('c')).toBe(false);
    expect(active.validTables.has('files_c')).toBe(false);
    // Both removals are soft, so both physical tables survive for a restore.
    expect(await physicalCount(active, 'files_c')).toBe(0);
    const ops = (await auditEntries(active)).filter((e) => e.operation === 'schema.delete_entity');
    expect(ops.map((e) => e.table_name).sort()).toEqual(['c', 'files_c']);
  });

  it('without a resolution, names the first-class links and their row counts', async () => {
    const active = await boot();
    await seed(active);

    const out = await aiDeleteEntity(active, 'a', undefined, 'sess');
    expect(out).toMatchObject({ needsResolution: true, rowCount: 2 });
    if (!('needsResolution' in out)) throw new Error('expected a resolution round-trip');
    // The caller is told exactly what else goes: the link, and how many rows.
    expect(out.message).toContain('b.a_id');
    expect(out.message).toContain('2 rows');
    expect(out.message).toContain('delete_cascade');
    // The relationship-owned link table is NOT presented as a decision.
    expect(out.message).not.toContain('files_a');
    // Nothing was touched.
    expect(active.validTables.has('a')).toBe(true);
    expect(await active.db.count('a')).toBe(2);
  });

  it('delete_data still refuses while first-class links point here, and points at the cascade', async () => {
    const active = await boot();
    await seed(active);

    const out = await aiDeleteEntity(active, 'a', 'delete_data', 'sess');
    expect(out).toMatchObject({ ok: false });
    if (!('error' in out)) throw new Error('expected a refusal');
    expect(out.error).toContain('b.a_id');
    expect(out.error).toContain('delete_cascade');
    expect(active.validTables.has('a')).toBe(true);
  });

  it('removes the table, the rows that link to it, and its own link table', async () => {
    const active = await boot();
    await seed(active);

    const out = await aiDeleteEntity(active, 'a', 'delete_cascade', 'sess');
    expect(out).toMatchObject({
      ok: true,
      deleted: 'a',
      deletedRows: 2,
      cascadedLinkRows: 2,
      droppedLinkTables: ['files_a'],
    });

    // The table and its link table are gone from the live registry.
    expect(active.validTables.has('a')).toBe(false);
    expect(active.validTables.has('files_a')).toBe(false);

    // `b` survives with only its unlinked row live.
    expect(active.validTables.has('b')).toBe(true);
    const liveB = (await active.db.query('b', {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
    })) as { id: string }[];
    expect(liveB.map((r) => r.id)).toEqual(['b3']);

    // Nothing was physically dropped — every row is still on disk, which is what
    // makes the whole operation restorable.
    expect(await physicalCount(active, 'a')).toBe(2);
    expect(await physicalCount(active, 'b')).toBe(3);
    expect(await physicalCount(active, 'files_a')).toBe(2);
  });

  it('undo restores the table, its link table, and every cascaded row', async () => {
    const active = await boot();
    await seed(active);
    expect(await aiDeleteEntity(active, 'a', 'delete_cascade', 'sess')).toMatchObject({ ok: true });

    const entries = await auditEntries(active);
    const schemaEntries = entries.filter((e) => e.operation === 'schema.delete_entity');
    expect(schemaEntries.map((e) => e.table_name).sort()).toEqual(['a', 'files_a']);

    // Reverse the schema removals first (each reopens the workspace).
    let current = active;
    for (const entry of [...schemaEntries].reverse()) {
      current = await applySchemaConfig(current, entry, 'inverse', false);
      live = current;
      await current.db.update('_lattice_gui_audit', entry.id, { undone: 1 });
    }
    expect(current.validTables.has('a')).toBe(true);
    expect(current.validTables.has('files_a')).toBe(true);

    // Then reverse the row removals. The soft delete was recorded as an update,
    // so the inverse writes the pre-image back (deleted_at cleared).
    const rowEntries = entries.filter(
      (e) => (e.table_name === 'a' || e.table_name === 'b') && e.operation === 'update',
    );
    expect(rowEntries.length).toBe(4); // 2 rows of `a` + the 2 `b` rows that linked to it
    for (const entry of [...rowEntries].reverse()) {
      const result = await revertEntry(mctxFor(current), entry.id);
      expect(result.ok).toBe(true);
    }

    const restoredA = (await current.db.query('a', {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
    })) as { id: string }[];
    expect(restoredA.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
    const restoredB = (await current.db.query('b', {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
    })) as { id: string }[];
    expect(restoredB.map((r) => r.id).sort()).toEqual(['b1', 'b2', 'b3']);
    // The link table came back with its rows intact.
    expect(await current.db.count('files_a')).toBe(2);
  });

  it('without a cascade, drops the owned link table and leaves first-class rows alone', async () => {
    // The shape the HTTP delete route takes: it removes the table itself but not
    // its rows, so the link side must do exactly the same — take the link tables
    // the relationship owns, touch nothing else.
    const active = await boot();
    await seed(active);

    const links = await removeInboundLinks(
      active,
      'a',
      inboundLinksTo(active, 'a'),
      mctxFor(active),
      { cascade: false, rowBudget: 1000 },
      'sess',
    );
    expect(links).toMatchObject({ ok: true, cascadedLinkRows: 0, droppedLinkTables: ['files_a'] });
    expect(active.validTables.has('files_a')).toBe(false);
    // `b` is untouched: no cascade was asked for.
    expect(await active.db.count('b', { filters: [{ col: 'deleted_at', op: 'isNull' }] })).toBe(3);
  });

  it('refuses an over-budget cascade without writing anything', async () => {
    const active = await boot();
    await seed(active);

    const links = await removeInboundLinks(
      active,
      'a',
      inboundLinksTo(active, 'a'),
      mctxFor(active),
      { cascade: true, rowBudget: 1 }, // two `b` rows point at `a`
      'sess',
    );
    expect(links.ok).toBe(false);
    if (links.ok) throw new Error('expected a refusal');
    expect(links.error).toContain('2 rows');
    // Nothing was removed — not the rows, and not the link table.
    expect(await active.db.count('b', { filters: [{ col: 'deleted_at', op: 'isNull' }] })).toBe(3);
    expect(active.validTables.has('files_a')).toBe(true);
  });

  it('never sweeps away a link table that has gained data of its own', async () => {
    // The silent-loss shape: `c`'s only inbound link is its own link table, so
    // the delete used to go through with no decision at all — taking the link
    // table with it. Once that table carries a column of its own it is a
    // first-class object, and removing it has to be asked about like any other.
    const active = await boot();
    const junction = await createFileJunction(active, 'c', 'sess');
    expect(junction?.junction).toBe('files_c');
    await createRow(mctxFor(active), 'files_c', {
      id: 'j1',
      file_id: 'f1',
      c_id: 'c1',
      note: 'signed copy',
    });

    const out = await aiDeleteEntity(active, 'c', undefined, 'sess');
    expect(out).toMatchObject({ needsResolution: true });
    if (!('needsResolution' in out)) throw new Error('expected a resolution round-trip');
    // Named in the confirmation, with its row count — never removed silently.
    expect(out.message).toContain('files_c');
    expect(out.message).toContain('1 row');
    // And nothing was touched while the question is outstanding.
    expect(active.validTables.has('c')).toBe(true);
    expect(active.validTables.has('files_c')).toBe(true);
    expect(await active.db.count('files_c')).toBe(1);
  });

  it('a cascade over a link table with data removes its rows but keeps the table', async () => {
    const active = await boot();
    const junction = await createFileJunction(active, 'c', 'sess');
    expect(junction?.junction).toBe('files_c');
    await createRow(mctxFor(active), 'files_c', {
      id: 'j1',
      file_id: 'f1',
      c_id: 'c1',
      note: 'signed copy',
    });

    const out = await aiDeleteEntity(active, 'c', 'delete_cascade', 'sess');
    expect(out).toMatchObject({ ok: true, deleted: 'c', cascadedLinkRows: 1 });
    if (!('ok' in out) || !out.ok) throw new Error('expected the cascade to go through');
    // It is not plumbing any more, so it is not dropped along with `c`.
    expect(out.droppedLinkTables).toBeUndefined();
    expect(active.validTables.has('files_c')).toBe(true);
  });

  it('behaves like delete_data when nothing links to the table', async () => {
    const active = await boot();
    await active.db.insert('c', { id: 'c1', name: 'solo' });

    const out = await aiDeleteEntity(active, 'c', 'delete_cascade', 'sess');
    expect(out).toMatchObject({ ok: true, deleted: 'c', deletedRows: 1 });
    expect(active.validTables.has('c')).toBe(false);
  });
});
