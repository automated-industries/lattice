import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyWriteEntry } from '../../src/session/apply.js';
import type { SessionWriteEntry } from '../../src/session/parser.js';

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      role TEXT,
      deleted_at TEXT
    );
    CREATE TABLE nosoft (
      id TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

function entry(overrides: Partial<SessionWriteEntry> = {}): SessionWriteEntry {
  return {
    id: 'test-id',
    timestamp: '2026-03-25T10:00:00Z',
    op: 'update',
    table: 'agent',
    target: 'agent-1',
    fields: {},
    ...overrides,
  };
}

describe('applyWriteEntry', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
    db.prepare("INSERT INTO agent (id, name) VALUES ('agent-1', 'Alpha')").run();
  });

  it('applies an update', () => {
    const result = applyWriteEntry(db, entry({ fields: { status: 'inactive' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table).toBe('agent');
    expect(result.recordId).toBe('agent-1');

    const row = db.prepare("SELECT status FROM agent WHERE id = 'agent-1'").get() as { status: string };
    expect(row.status).toBe('inactive');
  });

  it('inserts a new row for create', () => {
    const result = applyWriteEntry(db, entry({
      op: 'create',
      target: undefined,
      fields: { id: 'agent-new', name: 'Nova' },
    }));
    expect(result.ok).toBe(true);
    const row = db.prepare("SELECT name FROM agent WHERE id = 'agent-new'").get() as { name: string };
    expect(row.name).toBe('Nova');
  });

  it('auto-generates id for create when not in fields', () => {
    const result = applyWriteEntry(db, entry({
      op: 'create',
      target: undefined,
      fields: { name: 'AutoId' },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = db.prepare("SELECT id FROM agent WHERE id = ?").get(result.recordId) as { id: string } | undefined;
    expect(row).toBeDefined();
  });

  it('soft-deletes when deleted_at column exists', () => {
    const result = applyWriteEntry(db, entry({ op: 'delete', fields: {} }));
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT deleted_at FROM agent WHERE id = 'agent-1'").get() as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
  });

  it('hard-deletes when no deleted_at column', () => {
    db.prepare("INSERT INTO nosoft (id, value) VALUES ('r1', 'x')").run();
    const result = applyWriteEntry(db, entry({ op: 'delete', table: 'nosoft', target: 'r1', fields: {} }));
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT id FROM nosoft WHERE id = 'r1'").get();
    expect(row).toBeUndefined();
  });

  it('rejects unknown table', () => {
    const result = applyWriteEntry(db, entry({ table: 'nonexistent' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Unknown table');
  });

  it('rejects invalid table name (SQL injection guard)', () => {
    const result = applyWriteEntry(db, entry({ table: 'agent; DROP TABLE agent--' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Invalid table name');
  });

  it('rejects unknown field', () => {
    const result = applyWriteEntry(db, entry({ fields: { nonexistent_col: 'x' } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Unknown field');
  });

  it('rejects invalid field name (SQL injection guard)', () => {
    const result = applyWriteEntry(db, entry({ fields: { 'bad field!': 'x' } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Invalid field name');
  });

  it('requires target for update', () => {
    const result = applyWriteEntry(db, entry({ target: undefined, fields: { status: 'x' } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('target');
  });

  it('requires target for delete', () => {
    const result = applyWriteEntry(db, entry({ op: 'delete', target: undefined, fields: {} }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('target');
  });
});
