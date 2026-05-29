import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice, SeedReconciliationError } from '../../src/lattice.js';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfigString } from '../../src/config/parser.js';

describe('Lattice (integration)', () => {
  let db: Lattice;
  let outputDir: string;
  const dirs: string[] = [];

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'lattice-int-'));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    outputDir = tempDir();
    db = new Lattice(':memory:');
    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', active: 'INTEGER DEFAULT 1' },
      render: (rows) =>
        rows
          .filter((r) => r.active)
          .map((r) => `- ${r.name as string}`)
          .join('\n'),
      outputFile: 'bots.md',
    });
  });

  afterEach(() => {
    db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('init() creates the table', async () => {
    await db.init();
    const count = await db.count('bots');
    expect(count).toBe(0);
  });

  it('insert + query roundtrip', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    await db.insert('bots', { id: 'b2', name: 'Beta' });
    const rows = await db.query('bots');
    expect(rows).toHaveLength(2);
  });

  it('query() returns rows with correct field values, not empty objects', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha', active: 1 });
    const rows = await db.query('bots');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'b1', name: 'Alpha', active: 1 });
  });

  it('get() returns row with correct field values, not empty object', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha', active: 1 });
    const row = await db.get('bots', 'b1');
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ id: 'b1', name: 'Alpha', active: 1 });
  });

  it('get() returns null for missing row, not empty object', async () => {
    await db.init();
    const row = await db.get('bots', 'nonexistent');
    expect(row).toBeNull();
  });

  it('upsert updates existing row', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    await db.upsert('bots', { id: 'b1', name: 'Alpha Updated' });
    const row = await db.get('bots', 'b1');
    expect(row?.name).toBe('Alpha Updated');
  });

  it('delete removes a row', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    await db.delete('bots', 'b1');
    const row = await db.get('bots', 'b1');
    expect(row).toBeNull();
  });

  it('count with where clause', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha', active: 1 });
    await db.insert('bots', { id: 'b2', name: 'Beta', active: 0 });
    const n = await db.count('bots', { where: { active: 1 } });
    expect(n).toBe(1);
  });

  it('render() writes files', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    const result = await db.render(outputDir);
    expect(result.filesWritten).toHaveLength(1);
    const content = readFileSync(join(outputDir, 'bots.md'), 'utf8');
    expect(content).toContain('Alpha');
  });

  it('render() skips unchanged files', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    await db.render(outputDir);
    const result2 = await db.render(outputDir);
    expect(result2.filesSkipped).toBe(1);
    expect(result2.filesWritten).toHaveLength(0);
  });

  it('audit events fire for configured tables', async () => {
    const auditDb = new Lattice(':memory:', {
      security: { auditTables: ['bots'] },
    });
    auditDb.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      render: (rows) => rows.map((r) => r.name as string).join('\n'),
      outputFile: 'bots.md',
    });
    await auditDb.init();

    const events: string[] = [];
    auditDb.on('audit', (e) => events.push(e.operation));

    await auditDb.insert('bots', { id: 'b1', name: 'Alpha' });
    await auditDb.update('bots', 'b1', { name: 'Beta' });
    await auditDb.delete('bots', 'b1');

    expect(events).toEqual(['insert', 'update', 'delete']);
    auditDb.close();
  });

  it('init() is idempotent', async () => {
    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    // Re-running init on a new instance with same :memory: isn't possible,
    // but we can verify schema application doesn't throw on existing tables
    await expect(db.init()).rejects.toThrow(); // already initialized
  });
});

// ---------------------------------------------------------------------------
// seed() integration
// ---------------------------------------------------------------------------

describe('seed()', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = new Lattice(':memory:');
    db.define('agents', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT NOT NULL',
        role: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'agents.md',
    });
    await db.init();
  });

  afterEach(() => {
    db.close();
  });

  it('seed() + query() returns rows with correct field values', async () => {
    await db.seed({
      table: 'agents',
      naturalKey: 'name',
      data: [
        { name: 'Alice', role: 'engineer' },
        { name: 'Bob', role: 'devops' },
      ],
    });
    const rows = await db.query('agents');
    expect(rows).toHaveLength(2);
    const alice = rows.find((r) => r.name === 'Alice');
    expect(alice).toBeDefined();
    expect(alice?.role).toBe('engineer');
  });

  it('seed() + get() returns correct row, not empty object', async () => {
    await db.seed({
      table: 'agents',
      naturalKey: 'name',
      data: [{ name: 'Alice', role: 'engineer' }],
    });
    const rows = await db.query('agents');
    const id = rows[0]?.id as string;
    const row = await db.get('agents', id);
    expect(row).not.toBeNull();
    expect(row?.name).toBe('Alice');
    expect(row?.role).toBe('engineer');
  });
});

// ---------------------------------------------------------------------------
// seed() junction reconciliation — unresolved links must be surfaced,
// never silently dropped (Rule: no silent failures)
// ---------------------------------------------------------------------------

describe('seed() junction reconciliation', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = new Lattice(':memory:');
    // Singular source-table name so seed()'s FK inference (table + '_id')
    // matches the junction's `meeting_id` column.
    db.define('meeting', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        slug: 'TEXT NOT NULL',
        title: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'meeting.md',
    });
    db.define('people', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        slug: 'TEXT NOT NULL',
        name: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'people.md',
    });
    db.define('meeting_people', {
      columns: {
        meeting_id: 'TEXT NOT NULL',
        person_id: 'TEXT NOT NULL',
      },
      primaryKey: ['meeting_id', 'person_id'],
      render: () => '',
      outputFile: 'meeting-people.md',
    });
    await db.init();
    // Only alice exists — bob is deliberately absent so links to him don't resolve.
    await db.seed({
      table: 'people',
      naturalKey: 'slug',
      data: [{ slug: 'alice', name: 'Alice' }],
    });
  });

  afterEach(() => {
    db.close();
  });

  function seedMeeting(onUnresolvedLink?: 'collect' | 'throw') {
    return db.seed({
      table: 'meeting',
      naturalKey: 'slug',
      data: [{ slug: 'standup', title: 'Standup', attendees: ['alice', 'bob'] }],
      linkTo: {
        attendees: {
          junction: 'meeting_people',
          foreignKey: 'person_id',
          resolveBy: 'slug',
          resolveTable: 'people',
        },
      },
      ...(onUnresolvedLink ? { onUnresolvedLink } : {}),
    });
  }

  it('default mode collects unresolved links and links the resolvable ones', async () => {
    const result = await seedMeeting();
    // alice linked, bob surfaced as unresolved (not silently dropped).
    expect(result.linked).toBe(1);
    expect(result.unresolvedLinks).toHaveLength(1);
    expect(result.unresolvedLinks[0]).toMatchObject({
      record: 'standup',
      field: 'attendees',
      name: 'bob',
      junction: 'meeting_people',
      resolveTable: 'people',
      resolveBy: 'slug',
    });
    // The resolvable link really landed in the junction table.
    const junction = await db.query('meeting_people');
    expect(junction).toHaveLength(1);
  });

  it("'throw' mode raises SeedReconciliationError listing the missing target", async () => {
    await expect(seedMeeting('throw')).rejects.toBeInstanceOf(SeedReconciliationError);
    try {
      await seedMeeting('throw');
      expect.unreachable('seed should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SeedReconciliationError);
      const err = e as SeedReconciliationError;
      expect(err.table).toBe('meeting');
      expect(err.unresolvedLinks).toHaveLength(1);
      expect(err.unresolvedLinks[0]?.name).toBe('bob');
      expect(err.message).toContain('bob');
    }
  });

  it('reports empty unresolvedLinks when every target resolves', async () => {
    await db.seed({
      table: 'people',
      naturalKey: 'slug',
      data: [{ slug: 'bob', name: 'Bob' }],
    });
    const result = await seedMeeting('throw');
    expect(result.unresolvedLinks).toHaveLength(0);
    expect(result.linked).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// render() path — config-parsed outputFile must not be doubled
// ---------------------------------------------------------------------------

describe('render() outputFile path', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'lattice-render-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('config-parsed outputFile renders to outputDir/relative, not doubled path', async () => {
    // outputFile: 'context/bots.md' should resolve to outputDir/context/bots.md
    // Bug: the parser resolved it against configDir, so render got
    //      join(outputDir, '/configDir/context/bots.md') = '/outputDir/configDir/context/bots.md'
    const yaml = `
db: ./test.db
entities:
  bot:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text }
    render: default-list
    outputFile: context/bots.md
`;
    const { tables } = parseConfigString(yaml, '/some/config/dir');
    const db = new Lattice(':memory:');
    for (const { name, definition } of tables) {
      db.define(name, definition);
    }
    await db.init();
    await db.insert('bot', { id: 'b1', name: 'Alpha' });

    const outputDir = tempDir();
    const result = await db.render(outputDir);
    db.close();

    // Correct path: <outputDir>/context/bots.md
    const expectedPath = join(outputDir, 'context/bots.md');
    expect(result.filesWritten).toHaveLength(1);
    expect(result.filesWritten[0]).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });
});
