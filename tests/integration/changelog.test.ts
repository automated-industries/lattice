import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

describe('Changelog (integration)', () => {
  let db: Lattice;

  beforeEach(() => {
    db = new Lattice(':memory:', { changelog: { retentionDays: 90, maxEntriesPerRow: 100 } });
    db.define('agents', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', status: 'TEXT DEFAULT "active"' },
      render: () => '',
      changelog: true,
    });
    db.define('logs', {
      columns: { id: 'TEXT PRIMARY KEY', message: 'TEXT' },
      render: () => '',
      // changelog NOT enabled
    });
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Automatic capture
  // -------------------------------------------------------------------------

  it('insert creates a changelog entry with full row as changes', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', status: 'active' });

    const history = await db.history('agents', 'a1');
    expect(history).toHaveLength(1);
    expect(history[0].operation).toBe('insert');
    expect(history[0].changes).toMatchObject({ id: 'a1', name: 'Alpha', status: 'active' });
    expect(history[0].previous).toBeNull();
    expect(history[0].table).toBe('agents');
    expect(history[0].rowId).toBe('a1');
    expect(history[0].createdAt).toBeTruthy();
  });

  it('update creates a changelog entry with changed fields + previous values', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', status: 'active' });
    await db.update('agents', 'a1', { name: 'Alpha-v2' });

    const history = await db.history('agents', 'a1');
    expect(history).toHaveLength(2);
    // Most recent first
    const updateEntry = history[0];
    expect(updateEntry.operation).toBe('update');
    expect(updateEntry.changes).toMatchObject({ name: 'Alpha-v2' });
    expect(updateEntry.previous).toMatchObject({ name: 'Alpha' });
  });

  it('delete creates a changelog entry with full row as previous', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', status: 'active' });
    await db.delete('agents', 'a1');

    const history = await db.history('agents', 'a1');
    expect(history).toHaveLength(2);
    const deleteEntry = history[0];
    expect(deleteEntry.operation).toBe('delete');
    expect(deleteEntry.changes).toBeNull();
    expect(deleteEntry.previous).toMatchObject({ id: 'a1', name: 'Alpha', status: 'active' });
  });

  it('tables without changelog: true produce no entries', async () => {
    await db.init();
    await db.insert('logs', { id: 'l1', message: 'hello' });
    await db.update('logs', 'l1', { message: 'updated' });
    await db.delete('logs', 'l1');

    const changes = await db.recentChanges({ table: 'logs' });
    expect(changes).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // history() ordering + limit
  // -------------------------------------------------------------------------

  it('history returns entries in reverse chronological order', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'v1' });
    await db.update('agents', 'a1', { name: 'v2' });
    await db.update('agents', 'a1', { name: 'v3' });

    const history = await db.history('agents', 'a1');
    expect(history).toHaveLength(3);
    expect(history[0].changes).toMatchObject({ name: 'v3' });
    expect(history[2].changes).toMatchObject({ id: 'a1', name: 'v1' });
  });

  it('history respects limit option', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'v1' });
    await db.update('agents', 'a1', { name: 'v2' });
    await db.update('agents', 'a1', { name: 'v3' });

    const history = await db.history('agents', 'a1', { limit: 1 });
    expect(history).toHaveLength(1);
    expect(history[0].changes).toMatchObject({ name: 'v3' });
  });

  // -------------------------------------------------------------------------
  // recentChanges()
  // -------------------------------------------------------------------------

  it('recentChanges returns entries across rows', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha' });
    await db.insert('agents', { id: 'a2', name: 'Beta' });

    const changes = await db.recentChanges();
    expect(changes).toHaveLength(2);
  });

  it('recentChanges filters by table', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha' });
    await db.insert('logs', { id: 'l1', message: 'test' }); // no changelog

    const changes = await db.recentChanges({ table: 'agents' });
    expect(changes).toHaveLength(1);
  });

  it('recentChanges filters by since timestamp', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha' });

    // All entries should be recent
    const changes = await db.recentChanges({ since: '2020-01-01T00:00:00Z' });
    expect(changes.length).toBeGreaterThanOrEqual(1);

    // Nothing in the far future
    const futureChanges = await db.recentChanges({ since: '2099-01-01T00:00:00Z' });
    expect(futureChanges).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // rollback()
  // -------------------------------------------------------------------------

  it('rollback of an insert deletes the row', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha' });

    const history = await db.history('agents', 'a1');
    await db.rollback(history[0].id);

    const row = await db.get('agents', 'a1');
    expect(row).toBeNull();
  });

  it('rollback of an update restores previous values', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', status: 'active' });
    await db.update('agents', 'a1', { name: 'Beta' });

    const history = await db.history('agents', 'a1');
    // history[0] is the update entry
    await db.rollback(history[0].id);

    const row = await db.get('agents', 'a1');
    expect(row!.name).toBe('Alpha');
  });

  it('rollback of a delete re-inserts the row', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', status: 'active' });
    await db.delete('agents', 'a1');

    const history = await db.history('agents', 'a1');
    // history[0] is the delete entry
    await db.rollback(history[0].id);

    const row = await db.get('agents', 'a1');
    expect(row).not.toBeNull();
    expect(row!.name).toBe('Alpha');
  });

  it('rollback creates its own changelog entry', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha' });
    await db.update('agents', 'a1', { name: 'Beta' });

    const historyBefore = await db.history('agents', 'a1');
    await db.rollback(historyBefore[0].id);

    const historyAfter = await db.history('agents', 'a1');
    // Should have 3 entries: insert, update, rollback
    expect(historyAfter).toHaveLength(3);
    expect(historyAfter[0].operation).toBe('rollback');
    expect(historyAfter[0].reason).toContain(historyBefore[0].id);
  });

  it('rollback of nonexistent entry rejects', async () => {
    await db.init();
    await expect(db.rollback('nonexistent')).rejects.toThrow('not found');
  });

  // -------------------------------------------------------------------------
  // diff()
  // -------------------------------------------------------------------------

  it('diff shows field-level changes between two points', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'v1', status: 'active' });
    await db.update('agents', 'a1', { name: 'v2' });
    await db.update('agents', 'a1', { name: 'v3', status: 'idle' });

    const history = await db.history('agents', 'a1');
    // history[0]=update(v3,idle), history[1]=update(v2), history[2]=insert(v1)
    const d = await db.diff('agents', 'a1', history[2].id, history[0].id);

    expect(d.name).toEqual({ old: 'v1', new: 'v3' });
    expect(d.status).toEqual({ old: 'active', new: 'idle' });
    // id should not appear since it didn't change
    expect(d.id).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // snapshot()
  // -------------------------------------------------------------------------

  it('snapshot reconstructs row state at a given point', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'v1', status: 'active' });
    await db.update('agents', 'a1', { name: 'v2' });
    await db.update('agents', 'a1', { name: 'v3', status: 'idle' });

    const history = await db.history('agents', 'a1');
    // Snapshot at the insert point
    const snap = await db.snapshot('agents', 'a1', history[2].id);
    expect(snap.name).toBe('v1');
    expect(snap.status).toBe('active');

    // Snapshot at second update
    const snap2 = await db.snapshot('agents', 'a1', history[0].id);
    expect(snap2.name).toBe('v3');
    expect(snap2.status).toBe('idle');
  });

  it('snapshot of nonexistent entry rejects', async () => {
    await db.init();
    await expect(db.snapshot('agents', 'a1', 'nonexistent')).rejects.toThrow('not found');
  });

  // -------------------------------------------------------------------------
  // Retention / pruning
  // -------------------------------------------------------------------------

  it('pruneChangelog can be called manually', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha' });

    // Should not throw
    await db.pruneChangelog();

    const history = await db.history('agents', 'a1');
    expect(history).toHaveLength(1); // Nothing pruned (within retention)
  });

  it('maxEntriesPerRow prunes oldest entries beyond the limit', async () => {
    const dbSmall = new Lattice(':memory:', {
      changelog: { maxEntriesPerRow: 3 },
    });
    dbSmall.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', val: 'TEXT' },
      render: () => '',
      changelog: true,
    });
    await dbSmall.init();

    await dbSmall.insert('items', { id: 'i1', val: 'v1' });
    await dbSmall.update('items', 'i1', { val: 'v2' });
    await dbSmall.update('items', 'i1', { val: 'v3' });
    await dbSmall.update('items', 'i1', { val: 'v4' });
    await dbSmall.update('items', 'i1', { val: 'v5' });

    // 5 entries created, prune should keep only 3
    await dbSmall.pruneChangelog();

    const history = await dbSmall.history('items', 'i1');
    expect(history.length).toBeLessThanOrEqual(3);

    dbSmall.close();
  });

  // -------------------------------------------------------------------------
  // Concurrent writes
  // -------------------------------------------------------------------------

  it('concurrent writes are both captured in order', async () => {
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'start' });

    // Simulate two sequential "concurrent" writes
    await db.update('agents', 'a1', { name: 'writer-A' });
    await db.update('agents', 'a1', { name: 'writer-B' });

    const history = await db.history('agents', 'a1');
    expect(history).toHaveLength(3);
    expect(history[0].changes).toMatchObject({ name: 'writer-B' });
    expect(history[0].previous).toMatchObject({ name: 'writer-A' });
    expect(history[1].changes).toMatchObject({ name: 'writer-A' });
    expect(history[1].previous).toMatchObject({ name: 'start' });
  });
});
