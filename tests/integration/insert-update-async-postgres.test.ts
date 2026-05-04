/**
 * Postgres integration test for `Lattice` write operations going through the
 * async adapter surface.
 *
 * Why this exists:
 *   PR 2 flips lattice core to prefer the async surface. The unit-test
 *   suite covers SQLite-only; this test covers the Postgres path for
 *   `insert`, `upsert`, `upsertBy`, `update`, `updateReturning`, `delete`,
 *   `softDeleteMissing`, `link`, and `unlink` end-to-end against a real
 *   pg.Pool. Mirrors `feedback_test_against_target_dialect.md`.
 *
 * How to run locally:
 *   LATTICE_TEST_PG_URL=postgres://... npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('Lattice writes (Postgres async integration)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const itemTable = `__lattice_test_${runId}_items`;
  const tagTable = `__lattice_test_${runId}_tags`;
  const itemTagTable = `__lattice_test_${runId}_item_tags`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(itemTable, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT NOT NULL',
        qty: 'INTEGER',
        source_file: 'TEXT',
        deleted_at: 'TEXT',
        updated_at: 'TEXT',
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    db.define(tagTable, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        slug: 'TEXT NOT NULL',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    db.define(itemTagTable, {
      columns: {
        item_id: 'TEXT NOT NULL',
        tag_id: 'TEXT NOT NULL',
      },
      tableConstraints: ['PRIMARY KEY (item_id, tag_id)'],
      primaryKey: ['item_id', 'tag_id'],
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
  });

  afterAll(async () => {
    if (!db) return;
    const adapter = db.adapter;
    for (const t of [itemTagTable, itemTable, tagTable]) {
      try {
        if (adapter.runAsync) {
          await adapter.runAsync(`DROP TABLE IF EXISTS "${t}"`);
        } else {
          adapter.run(`DROP TABLE IF EXISTS "${t}"`);
        }
      } catch {
        /* swallow */
      }
    }
    db.close();
  });

  it('insert returns the auto-generated id and persists the row', async () => {
    const id = await db.insert(itemTable, { name: 'Widget', qty: 5 });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const got = await db.get(itemTable, id);
    expect(got?.name).toBe('Widget');
    expect(Number(got?.qty)).toBe(5);
  });

  it('insert respects a caller-supplied id', async () => {
    const id = `${runId}-explicit`;
    await db.insert(itemTable, { id, name: 'Explicit' });
    const got = await db.get(itemTable, id);
    expect(got?.id).toBe(id);
  });

  it('upsert inserts when no row exists, updates on conflict', async () => {
    const id = `${runId}-upsert`;
    await db.upsert(itemTable, { id, name: 'V1', qty: 1 });
    let got = await db.get(itemTable, id);
    expect(got?.name).toBe('V1');

    await db.upsert(itemTable, { id, name: 'V2', qty: 2 });
    got = await db.get(itemTable, id);
    expect(got?.name).toBe('V2');
    expect(Number(got?.qty)).toBe(2);
  });

  it('upsertBy looks up by natural key and updates the existing row', async () => {
    const id = `${runId}-upsertby`;
    await db.insert(itemTable, { id, name: 'unique-name', qty: 10 });
    const returnedId = await db.upsertBy(itemTable, 'name', 'unique-name', { qty: 99 });
    expect(returnedId).toBe(id);

    const got = await db.get(itemTable, id);
    expect(Number(got?.qty)).toBe(99);
  });

  it('update mutates fields without touching others', async () => {
    const id = await db.insert(itemTable, { name: 'orig', qty: 1 });
    await db.update(itemTable, id, { qty: 42 });
    const got = await db.get(itemTable, id);
    expect(got?.name).toBe('orig');
    expect(Number(got?.qty)).toBe(42);
  });

  it('updateReturning returns the updated full row', async () => {
    const id = await db.insert(itemTable, { name: 'returning', qty: 1 });
    const row = await db.updateReturning(itemTable, id, { qty: 7 });
    expect(row.id).toBe(id);
    expect(Number(row.qty)).toBe(7);
  });

  it('delete removes the row', async () => {
    const id = await db.insert(itemTable, { name: 'doomed' });
    await db.delete(itemTable, id);
    const got = await db.get(itemTable, id);
    expect(got).toBeNull();
  });

  it('softDeleteMissing soft-deletes rows whose natural key is not in the current set', async () => {
    // Seed three rows attributed to the same source file.
    const sf = `${runId}-source.yaml`;
    await db.insert(itemTable, { id: `${runId}-sd-1`, name: 'keep-1', source_file: sf });
    await db.insert(itemTable, { id: `${runId}-sd-2`, name: 'keep-2', source_file: sf });
    await db.insert(itemTable, { id: `${runId}-sd-3`, name: 'gone', source_file: sf });

    // Current set excludes 'gone'.
    const softDeleted = await db.softDeleteMissing(itemTable, 'name', sf, ['keep-1', 'keep-2']);
    expect(softDeleted).toBe(1);

    const gone = await db.get(itemTable, `${runId}-sd-3`);
    expect(gone?.deleted_at).not.toBeNull();
  });

  it('link inserts into a junction table idempotently (INSERT OR IGNORE semantics)', async () => {
    const itemId = await db.insert(itemTable, { name: 'tagged' });
    const tagId = await db.insert(tagTable, { slug: `${runId}-t1` });

    await db.link(itemTagTable, { item_id: itemId, tag_id: tagId });
    // Re-link should be a no-op (no duplicate-key error).
    await db.link(itemTagTable, { item_id: itemId, tag_id: tagId });

    const count = await db.count(itemTagTable, {
      filters: [{ col: 'item_id', op: 'eq', val: itemId }],
    });
    expect(count).toBe(1);
  });

  it('unlink removes the junction row', async () => {
    const itemId = await db.insert(itemTable, { name: 'untag-me' });
    const tagId = await db.insert(tagTable, { slug: `${runId}-t2` });

    await db.link(itemTagTable, { item_id: itemId, tag_id: tagId });
    await db.unlink(itemTagTable, { item_id: itemId, tag_id: tagId });

    const count = await db.count(itemTagTable, {
      filters: [{ col: 'item_id', op: 'eq', val: itemId }],
    });
    expect(count).toBe(0);
  });
});
