import { describe, it, expect, beforeEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import type { Row } from '../../src/types.js';
import { resolveEntitySource } from '../../src/render/entity-query.js';
import type { StorageAdapter } from '../../src/db/adapter.js';

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

async function createTestDb() {
  const db = new Lattice(':memory:');
  db.define('team', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: '/dev/null',
  });
  db.define('agent', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      team_id: 'TEXT',
      status: 'TEXT DEFAULT "active"',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '/dev/null',
  });
  db.define('skill', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: '/dev/null',
  });
  db.define('agent_skill', {
    columns: { agent_id: 'TEXT NOT NULL', skill_id: 'TEXT NOT NULL' },
    render: () => '',
    outputFile: '/dev/null',
    primaryKey: ['agent_id', 'skill_id'],
    tableConstraints: ['PRIMARY KEY (agent_id, skill_id)'],
  });
  await db.init();

  // Seed data
  await db.insert('team', { id: 't1', name: 'Alpha' });
  await db.insert('agent', { id: 'a1', name: 'Alice', team_id: 't1', status: 'active' });
  await db.insert('agent', { id: 'a2', name: 'Bob', team_id: 't1', status: 'active' });
  await db.insert('agent', { id: 'a3', name: 'Charlie', team_id: 't1', status: 'inactive' });
  await db.insert('agent', { id: 'a4', name: 'Deleted', team_id: 't1', status: 'active' });
  await db.update('agent', 'a4', { deleted_at: '2026-01-01T00:00:00Z' });
  await db.insert('skill', { id: 's1', name: 'TypeScript' });
  await db.insert('skill', { id: 's2', name: 'Python' });
  await db.insert('skill', { id: 's3', name: 'Deleted Skill' });
  await db.update('skill', 's3', { deleted_at: '2026-01-01T00:00:00Z' });
  await db.insert('agent_skill', { agent_id: 'a1', skill_id: 's1' });
  await db.insert('agent_skill', { agent_id: 'a1', skill_id: 's2' });
  await db.insert('agent_skill', { agent_id: 'a1', skill_id: 's3' });

  return db;
}

function getAdapter(db: Lattice): StorageAdapter {
  // Access the internal adapter for direct testing
  return (db as unknown as { _adapter: StorageAdapter })._adapter;
}

// ---------------------------------------------------------------------------
// hasMany source query options
// ---------------------------------------------------------------------------

describe('hasMany with query options', () => {
  let db: Lattice;
  let adapter: StorageAdapter;
  const teamRow: Row = { id: 't1', name: 'Alpha' };

  beforeEach(async () => {
    db = await createTestDb();
    adapter = getAdapter(db);
  });

  it('basic hasMany without options (backward compat)', () => {
    const rows = resolveEntitySource(
      { type: 'hasMany', table: 'agent', foreignKey: 'team_id' },
      teamRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(4); // includes deleted
  });

  it('softDelete: true excludes soft-deleted rows', () => {
    const rows = resolveEntitySource(
      { type: 'hasMany', table: 'agent', foreignKey: 'team_id', softDelete: true },
      teamRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(3); // a1, a2, a3 (not a4)
    expect(rows.every((r) => r.deleted_at === null || r.deleted_at === undefined)).toBe(true);
  });

  it('orderBy sorts results', () => {
    const rows = resolveEntitySource(
      { type: 'hasMany', table: 'agent', foreignKey: 'team_id', softDelete: true, orderBy: 'name' },
      teamRow,
      'id',
      adapter,
    );
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('orderDir: desc reverses sort', () => {
    const rows = resolveEntitySource(
      {
        type: 'hasMany',
        table: 'agent',
        foreignKey: 'team_id',
        softDelete: true,
        orderBy: 'name',
        orderDir: 'desc',
      },
      teamRow,
      'id',
      adapter,
    );
    expect(rows.map((r) => r.name)).toEqual(['Charlie', 'Bob', 'Alice']);
  });

  it('limit caps result count', () => {
    const rows = resolveEntitySource(
      {
        type: 'hasMany',
        table: 'agent',
        foreignKey: 'team_id',
        softDelete: true,
        orderBy: 'name',
        limit: 2,
      },
      teamRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob']);
  });

  it('filters with eq operator', () => {
    const rows = resolveEntitySource(
      {
        type: 'hasMany',
        table: 'agent',
        foreignKey: 'team_id',
        filters: [{ col: 'status', op: 'eq', val: 'inactive' }],
      },
      teamRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Charlie');
  });

  it('combines softDelete with explicit filters', () => {
    const rows = resolveEntitySource(
      {
        type: 'hasMany',
        table: 'agent',
        foreignKey: 'team_id',
        softDelete: true,
        filters: [{ col: 'status', op: 'eq', val: 'active' }],
      },
      teamRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(2); // Alice, Bob (not Charlie inactive, not a4 deleted)
  });
});

// ---------------------------------------------------------------------------
// manyToMany source query options
// ---------------------------------------------------------------------------

describe('manyToMany with query options', () => {
  let db: Lattice;
  let adapter: StorageAdapter;
  const agentRow: Row = { id: 'a1', name: 'Alice', team_id: 't1' };

  beforeEach(async () => {
    db = await createTestDb();
    adapter = getAdapter(db);
  });

  it('basic manyToMany without options (backward compat)', () => {
    const rows = resolveEntitySource(
      {
        type: 'manyToMany',
        junctionTable: 'agent_skill',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skill',
      },
      agentRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(3); // includes deleted skill
  });

  it('softDelete: true excludes soft-deleted remote rows', () => {
    const rows = resolveEntitySource(
      {
        type: 'manyToMany',
        junctionTable: 'agent_skill',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skill',
        softDelete: true,
      },
      agentRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(2); // TypeScript, Python (not Deleted Skill)
  });

  it('orderBy sorts remote table results', () => {
    const rows = resolveEntitySource(
      {
        type: 'manyToMany',
        junctionTable: 'agent_skill',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skill',
        softDelete: true,
        orderBy: 'name',
      },
      agentRow,
      'id',
      adapter,
    );
    expect(rows.map((r) => r.name)).toEqual(['Python', 'TypeScript']);
  });

  it('limit caps manyToMany results', () => {
    const rows = resolveEntitySource(
      {
        type: 'manyToMany',
        junctionTable: 'agent_skill',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skill',
        softDelete: true,
        orderBy: 'name',
        limit: 1,
      },
      agentRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Python');
  });
});

// ---------------------------------------------------------------------------
// belongsTo source query options
// ---------------------------------------------------------------------------

describe('belongsTo with query options', () => {
  let db: Lattice;
  let adapter: StorageAdapter;

  beforeEach(async () => {
    db = await createTestDb();
    adapter = getAdapter(db);
    // Soft-delete the team
    await db.update('team', 't1', { deleted_at: '2026-01-01T00:00:00Z' });
  });

  it('basic belongsTo returns deleted row (backward compat)', () => {
    const agentRow: Row = { id: 'a1', name: 'Alice', team_id: 't1' };
    const rows = resolveEntitySource(
      { type: 'belongsTo', table: 'team', foreignKey: 'team_id' },
      agentRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(1);
  });

  it('softDelete: true excludes soft-deleted parent', () => {
    const agentRow: Row = { id: 'a1', name: 'Alice', team_id: 't1' };
    const rows = resolveEntitySource(
      { type: 'belongsTo', table: 'team', foreignKey: 'team_id', softDelete: true },
      agentRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(0);
  });

  it('returns empty when FK is null', () => {
    const agentRow: Row = { id: 'a5', name: 'NoTeam', team_id: null };
    const rows = resolveEntitySource(
      { type: 'belongsTo', table: 'team', foreignKey: 'team_id', softDelete: true },
      agentRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sourceDefaults integration (via entity context)
// ---------------------------------------------------------------------------

describe('sourceDefaults merging', () => {
  it('merges sourceDefaults into hasMany sources', async () => {
    const db = await createTestDb();
    const rendered: Row[][] = [];

    db.defineEntityContext('team', {
      slug: (r) => r.id as string,
      sourceDefaults: { softDelete: true, orderBy: 'name' },
      files: {
        'AGENTS.md': {
          source: { type: 'hasMany', table: 'agent', foreignKey: 'team_id' },
          render: (rows) => {
            rendered.push(rows);
            return rows.map((r) => r.name).join(', ');
          },
        },
      },
    });

    const tmpDir = `/tmp/lattice-test-defaults-${Date.now()}`;
    await db.reconcile(tmpDir);

    expect(rendered).toHaveLength(1);
    expect(rendered[0]!).toHaveLength(3); // softDelete excluded a4
    expect(rendered[0]!.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Charlie']); // ordered by name
  });

  it('per-file source options override sourceDefaults', async () => {
    const db = await createTestDb();
    const rendered: Row[][] = [];

    db.defineEntityContext('team', {
      slug: (r) => r.id as string,
      sourceDefaults: { softDelete: true, orderBy: 'name' },
      files: {
        'AGENTS.md': {
          source: {
            type: 'hasMany',
            table: 'agent',
            foreignKey: 'team_id',
            orderBy: 'name',
            orderDir: 'desc',
          }, // override direction
          render: (rows) => {
            rendered.push(rows);
            return rows.map((r) => r.name).join(', ');
          },
        },
      },
    });

    const tmpDir = `/tmp/lattice-test-override-${Date.now()}`;
    await db.reconcile(tmpDir);

    expect(rendered[0]!.map((r) => r.name)).toEqual(['Charlie', 'Bob', 'Alice']); // desc override
  });

  it('does not affect custom or self sources', async () => {
    const db = await createTestDb();
    let selfRows: Row[] = [];
    let customRows: Row[] = [];

    db.defineEntityContext('team', {
      slug: (r) => r.id as string,
      sourceDefaults: { softDelete: true },
      files: {
        'TEAM.md': {
          source: { type: 'self' },
          render: (rows) => {
            selfRows = rows;
            return 'self';
          },
        },
        'CUSTOM.md': {
          source: {
            type: 'custom',
            query: (row, adapter) => adapter.all('SELECT * FROM agent WHERE team_id = ?', [row.id]),
          },
          render: (rows) => {
            customRows = rows;
            return 'custom';
          },
        },
      },
    });

    const tmpDir = `/tmp/lattice-test-noaffect-${Date.now()}`;
    await db.reconcile(tmpDir);

    expect(selfRows).toHaveLength(1); // self always returns entity row
    expect(customRows).toHaveLength(4); // custom query not affected by softDelete default
  });
});

// ---------------------------------------------------------------------------
// Junction column projection (v0.8)
// ---------------------------------------------------------------------------

describe('manyToMany with junctionColumns', () => {
  let db: Lattice;
  let adapter: StorageAdapter;
  const agentRow: Row = { id: 'a1', name: 'Alice', team_id: 't1' };

  beforeEach(async () => {
    db = await createTestDb();
    adapter = getAdapter(db);
  });

  it('includes junction columns as string', () => {
    // Add proficiency column to agent_skill junction for testing
    (db as unknown as { _adapter: StorageAdapter })._adapter.run(
      `ALTER TABLE agent_skill ADD COLUMN proficiency TEXT DEFAULT 'standard'`,
    );
    (db as unknown as { _adapter: StorageAdapter })._adapter.run(
      `UPDATE agent_skill SET proficiency = 'expert' WHERE agent_id = 'a1' AND skill_id = 's1'`,
    );

    const rows = resolveEntitySource(
      {
        type: 'manyToMany',
        junctionTable: 'agent_skill',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skill',
        softDelete: true,
        junctionColumns: ['proficiency'],
      },
      agentRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(2); // s1 + s2, not s3 (deleted)
    const ts = rows.find((r) => r.name === 'TypeScript');
    expect(ts?.proficiency).toBe('expert');
  });

  it('includes junction columns with alias', () => {
    (db as unknown as { _adapter: StorageAdapter })._adapter.run(
      `ALTER TABLE agent_skill ADD COLUMN proficiency TEXT DEFAULT 'standard'`,
    );

    const rows = resolveEntitySource(
      {
        type: 'manyToMany',
        junctionTable: 'agent_skill',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skill',
        softDelete: true,
        junctionColumns: [{ col: 'proficiency', as: 'skill_level' }],
      },
      agentRow,
      'id',
      adapter,
    );
    expect(rows[0]?.skill_level).toBeDefined();
  });

  it('works without junctionColumns (backward compat)', () => {
    const rows = resolveEntitySource(
      {
        type: 'manyToMany',
        junctionTable: 'agent_skill',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skill',
        softDelete: true,
      },
      agentRow,
      'id',
      adapter,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.proficiency).toBeUndefined(); // no junction columns without opt-in
  });
});

// ---------------------------------------------------------------------------
// Multi-column ORDER BY (v0.8)
// ---------------------------------------------------------------------------

describe('multi-column orderBy', () => {
  let db: Lattice;
  let adapter: StorageAdapter;
  const teamRow: Row = { id: 't1', name: 'Alpha' };

  beforeEach(async () => {
    db = await createTestDb();
    adapter = getAdapter(db);
  });

  it('sorts by multiple columns', () => {
    const rows = resolveEntitySource(
      {
        type: 'hasMany',
        table: 'agent',
        foreignKey: 'team_id',
        softDelete: true,
        orderBy: [{ col: 'status' }, { col: 'name', dir: 'desc' }],
      },
      teamRow,
      'id',
      adapter,
    );
    // status: active, active, inactive → active first, then by name desc within same status
    expect(rows).toHaveLength(3);
    expect(rows[0]!.status).toBe('active');
  });

  it('string orderBy still works (backward compat)', () => {
    const rows = resolveEntitySource(
      {
        type: 'hasMany',
        table: 'agent',
        foreignKey: 'team_id',
        softDelete: true,
        orderBy: 'name',
        orderDir: 'desc',
      },
      teamRow,
      'id',
      adapter,
    );
    expect(rows.map((r) => r.name)).toEqual(['Charlie', 'Bob', 'Alice']);
  });
});
