import { describe, it, expect, vi } from 'vitest';
import { resolveEntitySource, truncateContent } from '../../src/render/entity-query.js';
import type { StorageAdapter } from '../../src/db/adapter.js';
import type { Row } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(
  overrides: Partial<Pick<StorageAdapter, 'all' | 'get'>> = {},
): StorageAdapter {
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

const entityRow: Row = { id: 'agent-1', name: 'Alpha' };

// ---------------------------------------------------------------------------
// resolveEntitySource
// ---------------------------------------------------------------------------

describe('resolveEntitySource — self', () => {
  it('returns the entity row wrapped in an array', () => {
    const adapter = makeAdapter();
    const rows = resolveEntitySource({ type: 'self' }, entityRow, 'id', adapter);
    expect(rows).toEqual([entityRow]);
    expect(adapter.all).not.toHaveBeenCalled();
  });
});

describe('resolveEntitySource — hasMany', () => {
  it('queries related table by foreignKey', () => {
    const related: Row[] = [{ id: 't1', agent_id: 'agent-1', title: 'Task 1' }];
    const adapter = makeAdapter({ all: vi.fn().mockReturnValue(related) });

    const rows = resolveEntitySource(
      { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
      entityRow,
      'id',
      adapter,
    );

    expect(rows).toEqual(related);
    expect(adapter.all).toHaveBeenCalledWith(
      'SELECT * FROM "tasks" WHERE "agent_id" = ?',
      ['agent-1'],
    );
  });

  it('uses custom references column when specified', () => {
    const adapter = makeAdapter({ all: vi.fn().mockReturnValue([]) });

    resolveEntitySource(
      { type: 'hasMany', table: 'tasks', foreignKey: 'owner_ref', references: 'slug' },
      { id: 'a1', slug: 'alpha' },
      'id',
      adapter,
    );

    expect(adapter.all).toHaveBeenCalledWith(
      'SELECT * FROM "tasks" WHERE "owner_ref" = ?',
      ['alpha'],
    );
  });

  it('falls back to entityPk when references is omitted', () => {
    const adapter = makeAdapter({ all: vi.fn().mockReturnValue([]) });

    resolveEntitySource(
      { type: 'hasMany', table: 'items', foreignKey: 'parent_id' },
      { slug: 'my-entity' },
      'slug',
      adapter,
    );

    expect(adapter.all).toHaveBeenCalledWith(
      'SELECT * FROM "items" WHERE "parent_id" = ?',
      ['my-entity'],
    );
  });
});

describe('resolveEntitySource — manyToMany', () => {
  it('joins junction and remote table', () => {
    const skills: Row[] = [{ id: 's1', name: 'TypeScript' }];
    const adapter = makeAdapter({ all: vi.fn().mockReturnValue(skills) });

    const rows = resolveEntitySource(
      {
        type: 'manyToMany',
        junctionTable: 'agent_skills',
        localKey: 'agent_id',
        remoteKey: 'skill_id',
        remoteTable: 'skills',
      },
      entityRow,
      'id',
      adapter,
    );

    expect(rows).toEqual(skills);
    expect(adapter.all).toHaveBeenCalledWith(
      expect.stringContaining('JOIN "agent_skills" j ON j."skill_id" = r."id"'),
      ['agent-1'],
    );
    expect(adapter.all).toHaveBeenCalledWith(
      expect.stringContaining('WHERE j."agent_id" = ?'),
      ['agent-1'],
    );
  });

  it('uses custom references column on remote table', () => {
    const adapter = makeAdapter({ all: vi.fn().mockReturnValue([]) });

    resolveEntitySource(
      {
        type: 'manyToMany',
        junctionTable: 'proj_tags',
        localKey: 'proj_id',
        remoteKey: 'tag_id',
        remoteTable: 'tags',
        references: 'tag_key',
      },
      { id: 'p1' },
      'id',
      adapter,
    );

    expect(adapter.all).toHaveBeenCalledWith(
      expect.stringContaining('j."tag_id" = r."tag_key"'),
      ['p1'],
    );
  });
});

describe('resolveEntitySource — belongsTo', () => {
  it('looks up the parent row by FK value', () => {
    const team: Row = { id: 'team-1', name: 'Team Alpha' };
    const adapter = makeAdapter({ get: vi.fn().mockReturnValue(team) });

    const rows = resolveEntitySource(
      { type: 'belongsTo', table: 'teams', foreignKey: 'team_id' },
      { id: 'bot-1', team_id: 'team-1' },
      'id',
      adapter,
    );

    expect(rows).toEqual([team]);
    expect(adapter.get).toHaveBeenCalledWith(
      'SELECT * FROM "teams" WHERE "id" = ?',
      ['team-1'],
    );
  });

  it('returns [] when FK is null', () => {
    const adapter = makeAdapter();

    const rows = resolveEntitySource(
      { type: 'belongsTo', table: 'teams', foreignKey: 'team_id' },
      { id: 'bot-1', team_id: null },
      'id',
      adapter,
    );

    expect(rows).toEqual([]);
    expect(adapter.get).not.toHaveBeenCalled();
  });

  it('returns [] when parent row is not found', () => {
    const adapter = makeAdapter({ get: vi.fn().mockReturnValue(undefined) });

    const rows = resolveEntitySource(
      { type: 'belongsTo', table: 'teams', foreignKey: 'team_id' },
      { id: 'bot-1', team_id: 'missing' },
      'id',
      adapter,
    );

    expect(rows).toEqual([]);
  });

  it('uses custom references column', () => {
    const adapter = makeAdapter({ get: vi.fn().mockReturnValue(undefined) });

    resolveEntitySource(
      { type: 'belongsTo', table: 'orgs', foreignKey: 'org_slug', references: 'slug' },
      { id: 'u1', org_slug: 'acme' },
      'id',
      adapter,
    );

    expect(adapter.get).toHaveBeenCalledWith(
      'SELECT * FROM "orgs" WHERE "slug" = ?',
      ['acme'],
    );
  });
});

describe('resolveEntitySource — custom', () => {
  it('delegates to the caller-supplied query function', () => {
    const customRows: Row[] = [{ id: 'e1', type: 'event' }];
    const query = vi.fn().mockReturnValue(customRows);
    const adapter = makeAdapter();

    const rows = resolveEntitySource(
      { type: 'custom', query },
      entityRow,
      'id',
      adapter,
    );

    expect(rows).toEqual(customRows);
    expect(query).toHaveBeenCalledWith(entityRow, adapter);
  });
});

// ---------------------------------------------------------------------------
// truncateContent
// ---------------------------------------------------------------------------

describe('truncateContent', () => {
  it('returns content unchanged when no budget set', () => {
    const content = 'x'.repeat(10000);
    expect(truncateContent(content, undefined)).toBe(content);
  });

  it('returns content unchanged when within budget', () => {
    const content = 'hello world';
    expect(truncateContent(content, 100)).toBe(content);
  });

  it('returns content unchanged when exactly at budget', () => {
    const content = 'abc';
    expect(truncateContent(content, 3)).toBe(content);
  });

  it('truncates and appends notice when over budget', () => {
    const content = 'hello world';
    const result = truncateContent(content, 5);
    expect(result).toBe('hello\n\n*[truncated — context budget exceeded]*');
  });

  it('truncation notice is appended after the slice', () => {
    const content = 'a'.repeat(200);
    const result = truncateContent(content, 10);
    expect(result.startsWith('a'.repeat(10))).toBe(true);
    expect(result).toContain('[truncated');
  });
});
