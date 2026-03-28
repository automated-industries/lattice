import { describe, it, expect, beforeEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

/**
 * Tests for generic CRUD methods (v0.11) that work on any table,
 * including tables created via raw DDL (not define()).
 */

function createTestDb() {
  const db = new Lattice(':memory:');
  // Define one table via latticesql (for contrast)
  db.define('managed', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: '/dev/null',
  });
  db.init();

  // Create a table via raw DDL (NOT define()) — this is how SB works
  (db as any)._adapter.run(`
    CREATE TABLE agent (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      name TEXT NOT NULL UNIQUE,
      role TEXT,
      status TEXT DEFAULT 'active',
      source_file TEXT,
      source_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT
    )
  `);
  (db as any)._adapter.run(`
    CREATE TABLE agent_project (
      agent_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role TEXT DEFAULT 'contributor',
      source TEXT DEFAULT 'direct',
      PRIMARY KEY (agent_id, project_id)
    )
  `);
  (db as any)._adapter.run(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT,
      deleted_at TEXT
    )
  `);

  return db;
}

describe('upsertByNaturalKey', () => {
  let db: Lattice;

  beforeEach(() => { db = createTestDb(); });

  it('inserts a new record with generated UUID', async () => {
    const id = await db.upsertByNaturalKey('agent', 'name', 'Alice', { role: 'engineer', status: 'active' });
    expect(id).toBeTruthy();
    const row = await db.getByNaturalKey('agent', 'name', 'Alice');
    expect(row?.name).toBe('Alice');
    expect(row?.role).toBe('engineer');
  });

  it('updates existing record on second upsert', async () => {
    await db.upsertByNaturalKey('agent', 'name', 'Alice', { role: 'engineer' });
    await db.upsertByNaturalKey('agent', 'name', 'Alice', { role: 'qa' });
    const row = await db.getByNaturalKey('agent', 'name', 'Alice');
    expect(row?.role).toBe('qa');
  });

  it('sets org_id from options on insert', async () => {
    await db.upsertByNaturalKey('agent', 'name', 'Bob', { role: 'devops' }, { orgId: 'org-1' });
    const row = await db.getByNaturalKey('agent', 'name', 'Bob');
    expect(row?.org_id).toBe('org-1');
  });

  it('sets source_file and source_hash', async () => {
    await db.upsertByNaturalKey('agent', 'name', 'Carol', { role: 'pm' }, { sourceFile: 'agents.md', sourceHash: 'abc123' });
    const row = await db.getByNaturalKey('agent', 'name', 'Carol');
    expect(row?.source_file).toBe('agents.md');
    expect(row?.source_hash).toBe('abc123');
  });
});

describe('enrichByNaturalKey', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = createTestDb();
    await db.upsertByNaturalKey('agent', 'name', 'Alice', { role: 'engineer', status: 'active' });
  });

  it('updates only non-null fields', async () => {
    const result = await db.enrichByNaturalKey('agent', 'name', 'Alice', { role: 'qa', status: null });
    expect(result).toBe(true);
    const row = await db.getByNaturalKey('agent', 'name', 'Alice');
    expect(row?.role).toBe('qa');
    expect(row?.status).toBe('active'); // not overwritten because null was filtered
  });

  it('returns false for non-existent record', async () => {
    const result = await db.enrichByNaturalKey('agent', 'name', 'Nonexistent', { role: 'qa' });
    expect(result).toBe(false);
  });
});

describe('softDeleteMissing', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = createTestDb();
    await db.upsertByNaturalKey('agent', 'name', 'Alice', { role: 'eng' }, { sourceFile: 'agents.md' });
    await db.upsertByNaturalKey('agent', 'name', 'Bob', { role: 'qa' }, { sourceFile: 'agents.md' });
    await db.upsertByNaturalKey('agent', 'name', 'Carol', { role: 'pm' }, { sourceFile: 'agents.md' });
  });

  it('soft-deletes records not in the current set', async () => {
    const count = await db.softDeleteMissing('agent', 'name', 'agents.md', ['Alice', 'Bob']);
    expect(count).toBe(1); // Carol soft-deleted
    const active = await db.getActive('agent');
    expect(active.map(r => r.name)).toEqual(['Alice', 'Bob']);
  });
});

describe('getActive / countActive', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = createTestDb();
    await db.upsertByNaturalKey('agent', 'name', 'Alice', { role: 'eng' });
    await db.upsertByNaturalKey('agent', 'name', 'Bob', { role: 'qa' });
  });

  it('returns all non-deleted rows', async () => {
    const rows = await db.getActive('agent');
    expect(rows).toHaveLength(2);
  });

  it('counts non-deleted rows', async () => {
    expect(await db.countActive('agent')).toBe(2);
  });

  it('excludes soft-deleted rows', async () => {
    await db.softDeleteMissing('agent', 'name', '', ['Alice']);
    // Note: softDeleteMissing only deletes from source_file match — use direct SQL for this test
    (db as any)._adapter.run("UPDATE agent SET deleted_at = datetime('now') WHERE name = 'Bob'");
    expect(await db.countActive('agent')).toBe(1);
  });
});

describe('link / unlink', () => {
  let db: Lattice;

  beforeEach(() => { db = createTestDb(); });

  it('inserts a junction row', async () => {
    await db.link('agent_project', { agent_id: 'a1', project_id: 'p1', role: 'lead' });
    const rows = (db as any)._adapter.all("SELECT * FROM agent_project WHERE agent_id = 'a1'");
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('lead');
  });

  it('is idempotent (INSERT OR IGNORE)', async () => {
    await db.link('agent_project', { agent_id: 'a1', project_id: 'p1' });
    await db.link('agent_project', { agent_id: 'a1', project_id: 'p1' });
    const rows = (db as any)._adapter.all("SELECT * FROM agent_project WHERE agent_id = 'a1'");
    expect(rows).toHaveLength(1);
  });

  it('upsert mode uses INSERT OR REPLACE', async () => {
    await db.link('agent_project', { agent_id: 'a1', project_id: 'p1', role: 'contrib' });
    await db.link('agent_project', { agent_id: 'a1', project_id: 'p1', role: 'lead' }, { upsert: true });
    const rows = (db as any)._adapter.all("SELECT * FROM agent_project WHERE agent_id = 'a1'");
    expect(rows[0].role).toBe('lead');
  });

  it('unlink removes matching rows', async () => {
    await db.link('agent_project', { agent_id: 'a1', project_id: 'p1' });
    await db.link('agent_project', { agent_id: 'a1', project_id: 'p2' });
    await db.unlink('agent_project', { agent_id: 'a1', project_id: 'p1' });
    const rows = (db as any)._adapter.all("SELECT * FROM agent_project WHERE agent_id = 'a1'");
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe('p2');
  });
});
