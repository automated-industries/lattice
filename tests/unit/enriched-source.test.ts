import { describe, it, expect, beforeEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import type { Row } from '../../src/types.js';

async function createTestDb() {
  const db = new Lattice(':memory:');
  db.define('org', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', type: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: '/dev/null',
  });
  db.define('agent', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      org_id: 'TEXT',
      status: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '/dev/null',
  });
  db.define('project', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      org_id: 'TEXT',
      status: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '/dev/null',
  });
  db.define('user_project', {
    columns: { user_id: 'TEXT NOT NULL', project_id: 'TEXT NOT NULL' },
    render: () => '',
    outputFile: '/dev/null',
    primaryKey: ['user_id', 'project_id'],
    tableConstraints: ['PRIMARY KEY (user_id, project_id)'],
  });
  db.define('user', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', role: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: '/dev/null',
  });
  await db.init();

  await db.insert('org', { id: 'o1', name: 'Acme Corp', type: 'company' });
  await db.insert('agent', { id: 'a1', name: 'Alice', org_id: 'o1', status: 'active' });
  await db.insert('agent', { id: 'a2', name: 'Bob', org_id: 'o1', status: 'active' });
  await db.insert('agent', { id: 'a3', name: 'Deleted', org_id: 'o1', status: 'active' });
  await db.update('agent', 'a3', { deleted_at: '2026-01-01' });
  await db.insert('project', { id: 'p1', name: 'Alpha', org_id: 'o1', status: 'active' });
  await db.insert('project', { id: 'p2', name: 'Beta', org_id: 'o1', status: 'paused' });
  await db.insert('user', { id: 'u1', name: 'Alice', role: 'owner' });
  await db.insert('user_project', { user_id: 'u1', project_id: 'p1' });
  await db.insert('user_project', { user_id: 'u1', project_id: 'p2' });

  return db;
}

describe('enriched source type', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('attaches hasMany lookups as _key JSON fields', async () => {
    const rendered: Row[][] = [];

    db.defineEntityContext('org', {
      slug: (r) => r.id as string,
      files: {
        'ORG.md': {
          source: {
            type: 'enriched',
            include: {
              agents: {
                type: 'hasMany',
                table: 'agent',
                foreignKey: 'org_id',
                softDelete: true,
                orderBy: 'name',
              },
              projects: {
                type: 'hasMany',
                table: 'project',
                foreignKey: 'org_id',
                softDelete: true,
                orderBy: 'name',
              },
            },
          },
          render: (rows) => {
            rendered.push(rows);
            return 'ok';
          },
        },
      },
    });

    const tmpDir = `/tmp/lattice-test-enriched-${String(Date.now())}`;
    await db.reconcile(tmpDir);

    expect(rendered).toHaveLength(1);
    const row = rendered[0]![0]!;

    // Entity's own fields are preserved
    expect(row.name).toBe('Acme Corp');
    expect(row.type).toBe('company');

    // Enriched fields are JSON strings keyed with _prefix
    const agents = JSON.parse(row._agents as string) as Row[];
    expect(agents).toHaveLength(2); // softDelete excluded a3
    expect(agents.map((a: Row) => a.name)).toEqual(['Alice', 'Bob']);

    const projects = JSON.parse(row._projects as string) as Row[];
    expect(projects).toHaveLength(2);
    expect(projects.map((p: Row) => p.name)).toEqual(['Alpha', 'Beta']);
  });

  it('attaches manyToMany lookups', async () => {
    const rendered: Row[][] = [];

    db.defineEntityContext('user', {
      slug: (r) => r.id as string,
      files: {
        'USER.md': {
          source: {
            type: 'enriched',
            include: {
              projects: {
                type: 'manyToMany',
                junctionTable: 'user_project',
                localKey: 'user_id',
                remoteKey: 'project_id',
                remoteTable: 'project',
                softDelete: true,
              },
            },
          },
          render: (rows) => {
            rendered.push(rows);
            return 'ok';
          },
        },
      },
    });

    const tmpDir = `/tmp/lattice-test-enriched-m2m-${String(Date.now())}`;
    await db.reconcile(tmpDir);

    const row = rendered[0]![0]!;
    expect(row.name).toBe('Alice');

    const projects = JSON.parse(row._projects as string) as Row[];
    expect(projects).toHaveLength(2);
  });

  it('attaches belongsTo lookups', async () => {
    // Add org_id to agent for belongsTo test
    const rendered: Row[][] = [];

    db.defineEntityContext('agent', {
      slug: (r) => r.id as string,
      files: {
        'AGENT.md': {
          source: {
            type: 'enriched',
            include: {
              org: { type: 'belongsTo', table: 'org', foreignKey: 'org_id', softDelete: true },
            },
          },
          render: (rows) => {
            rendered.push(rows);
            return 'ok';
          },
        },
      },
    });

    const tmpDir = `/tmp/lattice-test-enriched-bt-${String(Date.now())}`;
    await db.reconcile(tmpDir);

    // Alice (active) should have org enrichment
    const aliceRow = rendered.find((r) => r[0]?.name === 'Alice')?.[0];
    expect(aliceRow).toBeDefined();
    const org = JSON.parse(aliceRow!._org as string) as Row[];
    expect(org).toHaveLength(1);
    expect(org[0]!.name).toBe('Acme Corp');
  });

  it('supports custom sub-lookups for complex queries', async () => {
    const rendered: Row[][] = [];

    db.defineEntityContext('org', {
      slug: (r) => r.id as string,
      files: {
        'ORG.md': {
          source: {
            type: 'enriched',
            include: {
              agent_count: {
                type: 'custom',
                query: (row, adapter) => {
                  const count = adapter.all(
                    'SELECT COUNT(*) as cnt FROM agent WHERE org_id = ? AND deleted_at IS NULL',
                    [row.id],
                  );
                  return count;
                },
              },
            },
          },
          render: (rows) => {
            rendered.push(rows);
            return 'ok';
          },
        },
      },
    });

    const tmpDir = `/tmp/lattice-test-enriched-custom-${String(Date.now())}`;
    await db.reconcile(tmpDir);

    const row = rendered[0]![0]!;
    const result = JSON.parse(row._agent_count as string) as Row[];
    expect(result[0]!.cnt).toBe(2);
  });

  it('returns single-element array (like self)', async () => {
    const rendered: Row[][] = [];

    db.defineEntityContext('org', {
      slug: (r) => r.id as string,
      files: {
        'ORG.md': {
          source: {
            type: 'enriched',
            include: {},
          },
          render: (rows) => {
            rendered.push(rows);
            return 'ok';
          },
        },
      },
    });

    const tmpDir = `/tmp/lattice-test-enriched-empty-${String(Date.now())}`;
    await db.reconcile(tmpDir);

    expect(rendered[0]).toHaveLength(1);
    expect(rendered[0]![0]!.name).toBe('Acme Corp');
  });
});
