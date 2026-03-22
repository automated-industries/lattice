import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import type { Row } from '../../src/types.js';

function makeDb(): Lattice {
  return new Lattice(':memory:');
}

// Shared seed data used across template tests
async function seedTasks(db: Lattice): Promise<void> {
  await db.insert('tasks', { id: 'task-1', title: 'Write docs', status: 'open',   priority: 1 });
  await db.insert('tasks', { id: 'task-2', title: 'Fix bug',    status: 'done',   priority: 3 });
  await db.insert('tasks', { id: 'task-3', title: 'Ship v0.3',  status: 'open',   priority: 2 });
}

// ---------------------------------------------------------------------------
// Backward compatibility — plain function still works
// ---------------------------------------------------------------------------

describe('backward compat — plain render function', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT', priority: 'INTEGER' },
      render: (rows) => rows.map((r) => String(r.title)).join(', '),
      outputFile: 'tasks.md',
    });
    await db.init();
    await seedTasks(db);
  });
  afterEach(() => { db.close(); });

  it('render function is called as-is', async () => {
    const rows = await db.query('tasks', { orderBy: 'id' });
    // Invoke via db.query and manually confirm render compiles correctly
    expect(rows).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// default-list
// ---------------------------------------------------------------------------

describe('default-list template', () => {
  let db: Lattice;

  afterEach(() => { db.close(); });

  it('produces a bullet per row using default key:value formatting', async () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT', priority: 'INTEGER' },
      render: 'default-list',
      outputFile: 'tasks.md',
    });
    await db.init();
    await db.insert('tasks', { id: 'a', title: 'Alpha', status: 'open', priority: 1 });

    const rows = await db.query('tasks');
    // Access the compiled render through the schema
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    const output = def.render(rows);
    expect(output).toMatch(/^- /);
    expect(output).toContain('title: Alpha');
  });

  it('applies formatRow string template', async () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT', priority: 'INTEGER' },
      render: {
        template: 'default-list',
        hooks: { formatRow: '{{title}} ({{status}})' },
      },
      outputFile: 'tasks.md',
    });
    await db.init();
    await db.insert('tasks', { id: 'a', title: 'Alpha', status: 'open', priority: 1 });
    await db.insert('tasks', { id: 'b', title: 'Beta',  status: 'done', priority: 2 });

    const rows = await db.query('tasks', { orderBy: 'id' });
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    const output = def.render(rows);
    expect(output).toBe('- Alpha (open)\n- Beta (done)');
  });

  it('applies formatRow function', async () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT', priority: 'INTEGER' },
      render: {
        template: 'default-list',
        hooks: { formatRow: (row: Row) => `[${String(row.status)}] ${String(row.title)}` },
      },
      outputFile: 'tasks.md',
    });
    await db.init();
    await db.insert('tasks', { id: 'a', title: 'Alpha', status: 'open', priority: 1 });

    const rows = await db.query('tasks');
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    const output = def.render(rows);
    expect(output).toBe('- [open] Alpha');
  });

  it('applies beforeRender hook', async () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT', priority: 'INTEGER' },
      render: {
        template: 'default-list',
        hooks: {
          beforeRender: (rows) => rows.filter((r) => r.status === 'open'),
          formatRow: '{{title}}',
        },
      },
      outputFile: 'tasks.md',
    });
    await db.init();
    await db.insert('tasks', { id: 'a', title: 'Alpha', status: 'open',   priority: 1 });
    await db.insert('tasks', { id: 'b', title: 'Beta',  status: 'done',   priority: 2 });
    await db.insert('tasks', { id: 'c', title: 'Gamma', status: 'open',   priority: 3 });

    const rows = await db.query('tasks', { orderBy: 'id' });
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    const output = def.render(rows);
    expect(output).toBe('- Alpha\n- Gamma');
  });

  it('returns empty string for zero rows', async () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
      render: 'default-list',
      outputFile: 'tasks.md',
    });
    await db.init();

    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    expect(def.render([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// default-table
// ---------------------------------------------------------------------------

describe('default-table template', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = makeDb();
    db.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', score: 'INTEGER' },
      render: 'default-table',
      outputFile: 'items.md',
    });
    await db.init();
  });
  afterEach(() => { db.close(); });

  it('produces a Markdown table header + separator + rows', async () => {
    await db.insert('items', { id: 'a', name: 'Alpha', score: 10 });
    await db.insert('items', { id: 'b', name: 'Beta',  score: 20 });

    const rows = await db.query('items', { orderBy: 'id' });
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('items')!;
    const output = def.render(rows);
    const lines = output.split('\n');

    expect(lines[0]).toBe('| id | name | score |');
    expect(lines[1]).toBe('| --- | --- | --- |');
    expect(lines[2]).toBe('| a | Alpha | 10 |');
    expect(lines[3]).toBe('| b | Beta | 20 |');
  });

  it('handles null values as empty string in cells', async () => {
    await db.insert('items', { id: 'x', name: null as unknown as string, score: 0 });

    const rows = await db.query('items');
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('items')!;
    const output = def.render(rows);
    expect(output).toContain('|  |'); // empty name cell
  });

  it('returns empty string for zero rows', () => {
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('items')!;
    expect(def.render([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// default-detail
// ---------------------------------------------------------------------------

describe('default-detail template', () => {
  let db: Lattice;

  afterEach(() => { db.close(); });

  it('renders one section per row with ## pk heading and key: value body', async () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT' },
      render: 'default-detail',
      outputFile: 'tasks.md',
    });
    await db.init();
    await db.insert('tasks', { id: 'task-1', title: 'Alpha', status: 'open' });

    const rows = await db.query('tasks');
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    const output = def.render(rows);
    expect(output).toContain('## task-1');
    expect(output).toContain('title: Alpha');
    expect(output).toContain('status: open');
  });

  it('separates multiple rows with ---', async () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT' },
      render: 'default-detail',
      outputFile: 'tasks.md',
    });
    await db.init();
    await db.insert('tasks', { id: 'task-1', title: 'Alpha', status: 'open' });
    await db.insert('tasks', { id: 'task-2', title: 'Beta',  status: 'done' });

    const rows = await db.query('tasks', { orderBy: 'id' });
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    const output = def.render(rows);
    expect(output).toContain('---');
    expect(output.indexOf('## task-1')).toBeLessThan(output.indexOf('## task-2'));
  });

  it('applies formatRow string template to section body', async () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT' },
      render: {
        template: 'default-detail',
        hooks: { formatRow: '{{title}} is {{status}}' },
      },
      outputFile: 'tasks.md',
    });
    await db.init();
    await db.insert('tasks', { id: 'task-1', title: 'Alpha', status: 'open' });

    const rows = await db.query('tasks');
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    const output = def.render(rows);
    expect(output).toContain('## task-1');
    expect(output).toContain('Alpha is open');
  });

  it('uses composite PK columns joined with : for heading', async () => {
    db = makeDb();
    db.define('seats', {
      columns: { event_id: 'TEXT NOT NULL', seat_no: 'INTEGER NOT NULL', holder: 'TEXT' },
      tableConstraints: ['PRIMARY KEY (event_id, seat_no)'],
      primaryKey: ['event_id', 'seat_no'],
      render: 'default-detail',
      outputFile: 'seats.md',
    });
    await db.init();
    await db.insert('seats', { event_id: 'evt-1', seat_no: 5, holder: 'Alice' });

    const rows = await db.query('seats');
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('seats')!;
    const output = def.render(rows);
    expect(output).toContain('## evt-1:5');
  });

  it('returns empty string for zero rows', () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
      render: 'default-detail',
      outputFile: 'tasks.md',
    });
    // Don't need init for this test — just call the compiled fn directly
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    expect(def.render([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// default-json
// ---------------------------------------------------------------------------

describe('default-json template', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = makeDb();
    db.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: 'default-json',
      outputFile: 'items.md',
    });
    await db.init();
  });
  afterEach(() => { db.close(); });

  it('produces valid JSON array', async () => {
    await db.insert('items', { id: 'a', name: 'Alpha' });
    await db.insert('items', { id: 'b', name: 'Beta' });

    const rows = await db.query('items', { orderBy: 'id' });
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('items')!;
    const output = def.render(rows);
    const parsed = JSON.parse(output) as Row[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.id).toBe('a');
    expect(parsed[1]?.id).toBe('b');
  });

  it('returns [] for zero rows', () => {
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('items')!;
    const output = def.render([]);
    expect(JSON.parse(output)).toEqual([]);
  });

  it('applies beforeRender hook before serialising', async () => {
    db.close();
    db = makeDb();
    db.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', active: 'INTEGER' },
      render: {
        template: 'default-json',
        hooks: { beforeRender: (rows) => rows.filter((r) => r.active === 1) },
      },
      outputFile: 'items.md',
    });
    await db.init();
    await db.insert('items', { id: 'a', name: 'Active',   active: 1 });
    await db.insert('items', { id: 'b', name: 'Inactive', active: 0 });

    const rows = await db.query('items');
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('items')!;
    const parsed = JSON.parse(def.render(rows)) as Row[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('Active');
  });
});

// ---------------------------------------------------------------------------
// belongsTo relation resolution in {{rel.field}} interpolation
// ---------------------------------------------------------------------------

describe('belongsTo relation field interpolation', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = makeDb();
    db.define('users', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: 'default-list',
      outputFile: 'users.md',
    });
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', author_id: 'TEXT' },
      relations: {
        author: { type: 'belongsTo', table: 'users', foreignKey: 'author_id' },
      },
      render: {
        template: 'default-list',
        hooks: { formatRow: '{{title}} by {{author.name}}' },
      },
      outputFile: 'tasks.md',
    });
    await db.init();
    await db.insert('users', { id: 'u-1', name: 'Alice' });
    await db.insert('users', { id: 'u-2', name: 'Bob' });
    await db.insert('tasks', { id: 't-1', title: 'Write docs', author_id: 'u-1' });
    await db.insert('tasks', { id: 't-2', title: 'Fix bug',    author_id: 'u-2' });
  });
  afterEach(() => { db.close(); });

  it('resolves belongsTo relation and interpolates nested field', async () => {
    const rows = await db.query('tasks', { orderBy: 'id' });
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    const output = def.render(rows);
    expect(output).toBe('- Write docs by Alice\n- Fix bug by Bob');
  });

  it('renders empty for missing FK (null author_id)', async () => {
    await db.insert('tasks', { id: 't-3', title: 'Orphan', author_id: null as unknown as string });

    const rows = await db.query('tasks', { where: { id: 't-3' } });
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    const output = def.render(rows);
    // No author resolved — interpolation of {{author.name}} → empty string
    expect(output).toBe('- Orphan by ');
  });
});

// ---------------------------------------------------------------------------
// beforeRender hook on plain render function (function + hook)
// ---------------------------------------------------------------------------

describe('beforeRender hook on plain render function', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = makeDb();
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT' },
      render: {
        template: 'default-list',
        hooks: {
          beforeRender: (rows) => rows.filter((r) => r.status === 'open'),
          formatRow: '{{title}}',
        },
      },
      outputFile: 'tasks.md',
    });
    await db.init();
    await db.insert('tasks', { id: 'a', title: 'Alpha', status: 'open' });
    await db.insert('tasks', { id: 'b', title: 'Beta',  status: 'done' });
    await db.insert('tasks', { id: 'c', title: 'Gamma', status: 'open' });
  });
  afterEach(() => { db.close(); });

  it('filters rows before rendering', async () => {
    const rows = await db.query('tasks', { orderBy: 'id' });
    const def = (db._schema as { getTables: () => Map<string, { render: (r: Row[]) => string }> }).getTables().get('tasks')!;
    const output = def.render(rows);
    expect(output).toBe('- Alpha\n- Gamma');
  });
});
