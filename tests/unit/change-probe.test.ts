/**
 * Adapter change-probe tests.
 *
 * The watch-loop render gate may skip a render ONLY when two consecutive probe
 * tokens are strictly equal — so the token MUST change on every committed data
 * change, from this connection AND from any other connection/process. These
 * tests lock down that completeness for SQLite (the only backend that exposes a
 * probe) and confirm Postgres deliberately leaves it unimplemented so the gate
 * falls through to a full render every tick.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '../../src/db/sqlite.js';
import { PostgresAdapter } from '../../src/db/postgres.js';

describe('SQLiteAdapter.changeProbe', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('is stable across reads on an idle database (no false-positive change)', () => {
    const adapter = new SQLiteAdapter(':memory:');
    adapter.open();
    adapter.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    try {
      const a = adapter.changeProbe();
      const b = adapter.changeProbe();
      const c = adapter.changeProbe();
      expect(a).toBe(b);
      expect(b).toBe(c);
    } finally {
      adapter.close();
    }
  });

  it('changes on a write made by THIS connection (own-write completeness)', () => {
    // PRAGMA data_version alone is blind to same-connection commits; the probe
    // composes total_changes() to cover them. Without that, the gate would skip
    // a render that an in-process write made necessary — the staleness bug.
    const adapter = new SQLiteAdapter(':memory:');
    adapter.open();
    adapter.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    try {
      const before = adapter.changeProbe();
      adapter.run('INSERT INTO t (v) VALUES (?)', ['x']);
      const afterInsert = adapter.changeProbe();
      expect(afterInsert).not.toBe(before);

      const beforeUpdate = adapter.changeProbe();
      adapter.run('UPDATE t SET v = ? WHERE id = 1', ['y']);
      expect(adapter.changeProbe()).not.toBe(beforeUpdate);

      const beforeDelete = adapter.changeProbe();
      adapter.run('DELETE FROM t WHERE id = 1');
      expect(adapter.changeProbe()).not.toBe(beforeDelete);
    } finally {
      adapter.close();
    }
  });

  it('does not change on a no-op write (zero rows affected)', () => {
    const adapter = new SQLiteAdapter(':memory:');
    adapter.open();
    adapter.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    try {
      const before = adapter.changeProbe();
      // Matches no rows → commits nothing → token must stay put.
      adapter.run('UPDATE t SET v = ? WHERE id = 999', ['z']);
      expect(adapter.changeProbe()).toBe(before);
    } finally {
      adapter.close();
    }
  });

  it('changes when ANOTHER connection commits (cross-connection completeness)', () => {
    // data_version is the half of the probe that catches other-connection /
    // other-process commits — the canonical `latticesql watch` case where the
    // writer is a separate process from the renderer.
    dir = mkdtempSync(join(tmpdir(), 'lattice-probe-'));
    const dbPath = join(dir, 'probe.db');

    const reader = new SQLiteAdapter(dbPath);
    reader.open();
    reader.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    const writer = new SQLiteAdapter(dbPath);
    writer.open();
    try {
      const before = reader.changeProbe();
      // Write on a DIFFERENT connection — reader's own total_changes() does not
      // move, but data_version does.
      writer.run('INSERT INTO t (v) VALUES (?)', ['from-other']);
      const afterOther = reader.changeProbe();
      expect(afterOther).not.toBe(before);
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('counts trigger- and cascade-driven row changes (indirect-write completeness)', () => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-probe-cascade-'));
    const dbPath = join(dir, 'cascade.db');
    const adapter = new SQLiteAdapter(dbPath);
    adapter.open();
    adapter.run('PRAGMA foreign_keys = ON');
    adapter.run('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
    adapter.run(
      'CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id) ON DELETE CASCADE)',
    );
    try {
      adapter.run('INSERT INTO parent (id) VALUES (1)');
      adapter.run('INSERT INTO child (id, p) VALUES (10, 1)');
      const before = adapter.changeProbe();
      // Cascade deletes the child too; total_changes() counts both rows, so the
      // probe moves even though we only issued one DELETE.
      adapter.run('DELETE FROM parent WHERE id = 1');
      expect(adapter.changeProbe()).not.toBe(before);
    } finally {
      adapter.close();
    }
  });
});

describe('PostgresAdapter.changeProbe', () => {
  it('is not implemented (no complete cheap global counter → gate stays full-render)', () => {
    // Constructing the adapter does not open a pool, so this is connection-free.
    // Postgres deliberately omits changeProbe; the loop sees undefined and
    // renders every tick — today's never-stale behavior.
    const adapter = new PostgresAdapter('postgres://unused');
    expect((adapter as { changeProbe?: unknown }).changeProbe).toBeUndefined();
  });
});
