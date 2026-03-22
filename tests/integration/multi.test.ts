import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-multi-'));
  dirs.push(d);
  return d;
}

// -------------------------------------------------------------------------
// defineMulti
// -------------------------------------------------------------------------

describe('defineMulti', () => {
  it('generates one file per anchor entity', async () => {
    const outputDir = tempDir();
    const db = new Lattice(':memory:');

    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      render: (rows) => rows.map((r) => r.name as string).join('\n'),
      outputFile: 'bots.md',
    });
    db.define('tasks', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        title: 'TEXT NOT NULL',
        bot_id: 'TEXT',
      },
      render: (rows) => rows.map((r) => r.title as string).join('\n'),
      outputFile: 'tasks.md',
    });
    db.defineMulti('bot-context', {
      keys: () => db.query('bots'),
      outputFile: (bot) => `bots/${bot.name as string}/CONTEXT.md`,
      tables: ['tasks'],
      render: (bot, tables) => {
        const myTasks = (tables.tasks ?? []).filter((t) => t.bot_id === bot.id);
        return `# ${bot.name as string}\n\nTasks: ${myTasks.length.toString()}`;
      },
    });

    await db.init();
    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    await db.insert('bots', { id: 'b2', name: 'Beta' });
    await db.insert('tasks', { id: 't1', title: 'Fix bug', bot_id: 'b1' });
    await db.insert('tasks', { id: 't2', title: 'Deploy', bot_id: 'b1' });
    await db.insert('tasks', { id: 't3', title: 'Review', bot_id: 'b2' });

    const result = await db.render(outputDir);
    expect(result.filesWritten.length).toBeGreaterThanOrEqual(4); // 2 single + 2 multi

    const alpha = readFileSync(join(outputDir, 'bots/Alpha/CONTEXT.md'), 'utf8');
    expect(alpha).toContain('Alpha');
    expect(alpha).toContain('Tasks: 2');

    const beta = readFileSync(join(outputDir, 'bots/Beta/CONTEXT.md'), 'utf8');
    expect(beta).toContain('Beta');
    expect(beta).toContain('Tasks: 1');

    db.close();
  });
});

// -------------------------------------------------------------------------
// upsertBy
// -------------------------------------------------------------------------

describe('upsertBy', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = new Lattice(':memory:');
    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', persona: 'TEXT' },
      render: () => '',
      outputFile: 'bots.md',
    });
    await db.init();
  });

  afterEach(() => {
    db.close();
  });

  it('inserts a new row if not found by column', async () => {
    await db.upsertBy('bots', 'name', 'Alpha', { persona: 'You are Alpha.' });
    const count = await db.count('bots');
    expect(count).toBe(1);
  });

  it('updates existing row if found by column', async () => {
    await db.insert('bots', { id: 'b1', name: 'Alpha', persona: 'Old' });
    await db.upsertBy('bots', 'name', 'Alpha', { persona: 'New' });
    const count = await db.count('bots');
    expect(count).toBe(1);
    const row = await db.get('bots', 'b1');
    expect(row?.persona).toBe('New');
  });
});

// -------------------------------------------------------------------------
// query options
// -------------------------------------------------------------------------

describe('query options', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = new Lattice(':memory:');
    db.define('items', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT NOT NULL',
        score: 'INTEGER DEFAULT 0',
      },
      render: () => '',
      outputFile: 'items.md',
    });
    await db.init();
    await db.insert('items', { id: 'i1', name: 'Alpha', score: 3 });
    await db.insert('items', { id: 'i2', name: 'Beta', score: 1 });
    await db.insert('items', { id: 'i3', name: 'Gamma', score: 2 });
  });

  afterEach(() => {
    db.close();
  });

  it('orderBy ascending', async () => {
    const rows = await db.query('items', { orderBy: 'score', orderDir: 'asc' });
    expect(rows.map((r) => r.name)).toEqual(['Beta', 'Gamma', 'Alpha']);
  });

  it('orderBy descending', async () => {
    const rows = await db.query('items', { orderBy: 'score', orderDir: 'desc' });
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Gamma', 'Beta']);
  });

  it('limit', async () => {
    const rows = await db.query('items', { limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it('offset', async () => {
    const all = await db.query('items', { orderBy: 'id' });
    const offset1 = await db.query('items', { orderBy: 'id', offset: 1 });
    expect(offset1).toHaveLength(2);
    expect(offset1[0]?.id).toBe(all[1]?.id);
  });
});

// -------------------------------------------------------------------------
// watch
// -------------------------------------------------------------------------

describe('watch', () => {
  it('re-renders after data changes', async () => {
    const outputDir = tempDir();
    const db = new Lattice(':memory:');
    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      render: (rows) => rows.map((r) => r.name as string).join('\n'),
      outputFile: 'bots.md',
    });
    await db.init();

    const results: string[] = [];
    const stop = await db.watch(outputDir, {
      interval: 30,
      onRender: (r) => results.push(r.filesWritten.join(',')),
    });

    await db.insert('bots', { id: 'b1', name: 'Alpha' });
    // Wait for a render cycle to fire
    await new Promise((r) => setTimeout(r, 100));
    stop();

    const content = readFileSync(join(outputDir, 'bots.md'), 'utf8');
    expect(content).toContain('Alpha');
    db.close();
  });
});

// -------------------------------------------------------------------------
// sync with writeback
// -------------------------------------------------------------------------

describe('sync with writeback', () => {
  it('renders and runs writeback in one call', async () => {
    const outputDir = tempDir();
    const sessionFile = join(outputDir, 'session.md');
    writeFileSync(sessionFile, 'event-1\n');

    const db = new Lattice(':memory:');
    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '# Bots',
      outputFile: 'bots.md',
    });
    db.define('events', {
      columns: { id: 'TEXT PRIMARY KEY', data: 'TEXT' },
      render: () => '',
      outputFile: 'events.md',
    });
    db.defineWriteback({
      file: sessionFile,
      parse: (content, fromOffset) => {
        const newContent = content.slice(fromOffset);
        const entries = newContent.split('\n').filter((l) => l.trim());
        return { entries, nextOffset: fromOffset + newContent.length };
      },
      persist: async (entry) => {
        await db.insert('events', { id: entry as string, data: entry as string });
      },
    });

    await db.init();
    const result = await db.sync(outputDir);

    expect(result.writebackProcessed).toBe(1);
    const count = await db.count('events');
    expect(count).toBe(1);
    db.close();
  });
});

// -------------------------------------------------------------------------
// on() event handlers
// -------------------------------------------------------------------------

describe('on() event handlers', () => {
  it('emits render events', async () => {
    const outputDir = tempDir();
    const db = new Lattice(':memory:');
    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '',
      outputFile: 'bots.md',
    });
    await db.init();

    const renders: number[] = [];
    db.on('render', (r) => renders.push(r.durationMs));

    await db.render(outputDir);
    expect(renders).toHaveLength(1);
    db.close();
  });

  it('init() throws if called twice', async () => {
    const db = new Lattice(':memory:');
    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY' },
      render: () => '',
      outputFile: 'b.md',
    });
    await db.init();
    await expect(db.init()).rejects.toThrow('already been called');
    db.close();
  });

  it('CRUD methods throw before init()', async () => {
    const db = new Lattice(':memory:');
    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY' },
      render: () => '',
      outputFile: 'b.md',
    });
    await expect(db.insert('bots', { id: 'b1' })).rejects.toThrow('init()');
    db.close();
  });

  it('define() throws after init()', async () => {
    const db = new Lattice(':memory:');
    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY' },
      render: () => '',
      outputFile: 'b.md',
    });
    await db.init();
    expect(() =>
      db.define('tasks', {
        columns: { id: 'TEXT PRIMARY KEY' },
        render: () => '',
        outputFile: 't.md',
      }),
    ).toThrow('before init()');
    db.close();
  });
});

// -------------------------------------------------------------------------
// Migrations via init()
// -------------------------------------------------------------------------

describe('init() migrations', () => {
  it('applies versioned migrations', async () => {
    const db = new Lattice(':memory:');
    db.define('items', {
      columns: { id: 'TEXT PRIMARY KEY' },
      render: () => '',
      outputFile: 'items.md',
    });
    await db.init({
      migrations: [
        { version: 1, sql: 'ALTER TABLE items ADD COLUMN name TEXT' },
        { version: 2, sql: 'ALTER TABLE items ADD COLUMN score INTEGER DEFAULT 0' },
      ],
    });

    await db.insert('items', { id: 'i1', name: 'Test', score: 42 });
    const row = await db.get('items', 'i1');
    expect(row?.score).toBe(42);
    db.close();
  });
});
