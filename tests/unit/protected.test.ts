import { describe, it, expect, vi } from 'vitest';
import { resolveEntitySource, type ProtectionContext } from '../../src/render/entity-query.js';
import type { StorageAdapter } from '../../src/db/adapter.js';
import type { Row } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides: Partial<Pick<StorageAdapter, 'all' | 'get'>> = {}): StorageAdapter {
  return {
    run: vi.fn(),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
    prepare: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as StorageAdapter;
}

const agentRow: Row = { id: 'agent-1', name: 'Alpha', slug: 'alpha' };
const userRow: Row = { id: 'user-1', name: 'Brian', email: 'brian@test.com' };

// ---------------------------------------------------------------------------
// Protected entity context — source filtering
// ---------------------------------------------------------------------------

describe('protected entity contexts', () => {
  const protectedTables = new Set(['agents', 'users', 'secrets']);

  describe('hasMany referencing a protected table', () => {
    it('returns empty when target table is a different protected entity', () => {
      const allFn = vi.fn().mockReturnValue([userRow]);
      const adapter = makeAdapter({ all: allFn });
      const protection: ProtectionContext = { protectedTables, currentTable: 'projects' };

      const rows = resolveEntitySource(
        { type: 'hasMany', table: 'agents', foreignKey: 'project_id' },
        { id: 'proj-1', name: 'MyProject' },
        'id',
        adapter,
        protection,
      );

      expect(rows).toEqual([]);
      expect(allFn).not.toHaveBeenCalled();
    });

    it('returns self-only when target table is the same protected entity', () => {
      const allFn = vi.fn().mockReturnValue([agentRow, { id: 'agent-2', name: 'Beta' }]);
      const adapter = makeAdapter({ all: allFn });
      const protection: ProtectionContext = { protectedTables, currentTable: 'agents' };

      const rows = resolveEntitySource(
        { type: 'hasMany', table: 'agents', foreignKey: 'reports_to' },
        agentRow,
        'id',
        adapter,
        protection,
      );

      expect(rows).toEqual([agentRow]);
      expect(allFn).not.toHaveBeenCalled();
    });

    it('queries normally when target table is not protected', () => {
      const tasks = [{ id: 't1', agent_id: 'agent-1', title: 'Task 1' }];
      const allFn = vi.fn().mockReturnValue(tasks);
      const adapter = makeAdapter({ all: allFn });
      const protection: ProtectionContext = { protectedTables, currentTable: 'agents' };

      const rows = resolveEntitySource(
        { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
        agentRow,
        'id',
        adapter,
        protection,
      );

      expect(rows).toEqual(tasks);
      expect(allFn).toHaveBeenCalled();
    });
  });

  describe('manyToMany referencing a protected table', () => {
    it('returns empty when remote table is a different protected entity', () => {
      const allFn = vi.fn().mockReturnValue([agentRow]);
      const adapter = makeAdapter({ all: allFn });
      const protection: ProtectionContext = { protectedTables, currentTable: 'projects' };

      const rows = resolveEntitySource(
        {
          type: 'manyToMany',
          junctionTable: 'agent_project',
          localKey: 'project_id',
          remoteKey: 'agent_id',
          remoteTable: 'agents',
        },
        { id: 'proj-1' },
        'id',
        adapter,
        protection,
      );

      expect(rows).toEqual([]);
      expect(allFn).not.toHaveBeenCalled();
    });

    it('returns self-only when remote table is the same protected entity', () => {
      const allFn = vi.fn().mockReturnValue([agentRow, { id: 'agent-2' }]);
      const adapter = makeAdapter({ all: allFn });
      const protection: ProtectionContext = { protectedTables, currentTable: 'agents' };

      const rows = resolveEntitySource(
        {
          type: 'manyToMany',
          junctionTable: 'agent_skills',
          localKey: 'skill_id',
          remoteKey: 'agent_id',
          remoteTable: 'agents',
        },
        agentRow,
        'id',
        adapter,
        protection,
      );

      expect(rows).toEqual([agentRow]);
      expect(allFn).not.toHaveBeenCalled();
    });

    it('queries normally when remote table is not protected', () => {
      const skills = [{ id: 's1', name: 'TypeScript' }];
      const allFn = vi.fn().mockReturnValue(skills);
      const adapter = makeAdapter({ all: allFn });
      const protection: ProtectionContext = { protectedTables, currentTable: 'agents' };

      const rows = resolveEntitySource(
        {
          type: 'manyToMany',
          junctionTable: 'agent_skills',
          localKey: 'agent_id',
          remoteKey: 'skill_id',
          remoteTable: 'skills',
        },
        agentRow,
        'id',
        adapter,
        protection,
      );

      expect(rows).toEqual(skills);
      expect(allFn).toHaveBeenCalled();
    });
  });

  describe('belongsTo referencing a protected table', () => {
    it('returns empty when target table is a different protected entity', () => {
      const getFn = vi.fn().mockReturnValue(agentRow);
      const adapter = makeAdapter({ get: getFn });
      const protection: ProtectionContext = { protectedTables, currentTable: 'projects' };

      const rows = resolveEntitySource(
        { type: 'belongsTo', table: 'users', foreignKey: 'owner_id' },
        { id: 'proj-1', owner_id: 'user-1' },
        'id',
        adapter,
        protection,
      );

      expect(rows).toEqual([]);
      expect(getFn).not.toHaveBeenCalled();
    });

    it('returns self-only when target table is the same protected entity', () => {
      const getFn = vi.fn().mockReturnValue({ id: 'agent-2', name: 'Beta' });
      const adapter = makeAdapter({ get: getFn });
      const protection: ProtectionContext = { protectedTables, currentTable: 'agents' };

      const rows = resolveEntitySource(
        { type: 'belongsTo', table: 'agents', foreignKey: 'reports_to' },
        agentRow,
        'id',
        adapter,
        protection,
      );

      expect(rows).toEqual([agentRow]);
      expect(getFn).not.toHaveBeenCalled();
    });
  });

  describe('enriched source with protected sub-lookups', () => {
    it('returns empty arrays for protected sub-lookups', () => {
      const allFn = vi.fn().mockReturnValue([]);
      const adapter = makeAdapter({ all: allFn });
      const protection: ProtectionContext = { protectedTables, currentTable: 'orgs' };

      const rows = resolveEntitySource(
        {
          type: 'enriched',
          include: {
            agents: { type: 'hasMany', table: 'agents', foreignKey: 'org_id' },
            projects: { type: 'hasMany', table: 'projects', foreignKey: 'org_id' },
          },
        },
        { id: 'org-1', name: 'TestOrg' },
        'id',
        adapter,
        protection,
      );

      expect(rows).toHaveLength(1);
      // agents is protected → empty
      expect(JSON.parse(rows[0]._agents as string)).toEqual([]);
      // projects is not protected → queries normally
      expect(allFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('self source is never affected by protection', () => {
    it('always returns the entity row', () => {
      const adapter = makeAdapter();
      const protection: ProtectionContext = { protectedTables, currentTable: 'agents' };

      const rows = resolveEntitySource({ type: 'self' }, agentRow, 'id', adapter, protection);
      expect(rows).toEqual([agentRow]);
    });
  });

  describe('no protection context — backward compatible', () => {
    it('queries normally when protection is undefined', () => {
      const related = [{ id: 'agent-2', name: 'Beta' }];
      const allFn = vi.fn().mockReturnValue(related);
      const adapter = makeAdapter({ all: allFn });

      const rows = resolveEntitySource(
        { type: 'hasMany', table: 'agents', foreignKey: 'org_id' },
        { id: 'org-1' },
        'id',
        adapter,
        undefined,
      );

      expect(rows).toEqual(related);
      expect(allFn).toHaveBeenCalled();
    });
  });
});
