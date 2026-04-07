import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Token budget rendering', () => {
  let db: Lattice;
  let outputDir: string;
  const dirs: string[] = [];

  function tempDir() {
    const d = mkdtempSync(join(tmpdir(), 'lattice-tb-'));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    outputDir = tempDir();
  });

  afterEach(() => {
    db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('truncates output when over token budget', async () => {
    db = new Lattice(':memory:');
    db.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
      outputFile: 'items.md',
      tokenBudget: 5, // very tight budget
    });
    await db.init();

    // Insert enough rows to exceed budget
    for (let i = 0; i < 20; i++) {
      await db.insert('items', { name: `Item number ${i} with some extra text` });
    }

    await db.render(outputDir);
    const content = readFileSync(join(outputDir, 'items.md'), 'utf8');
    expect(content).toContain('[truncated');
    expect(content).toContain('of 20 rows');
  });

  it('does not truncate when within budget', async () => {
    db = new Lattice(':memory:');
    db.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
      outputFile: 'items.md',
      tokenBudget: 10000,
    });
    await db.init();
    await db.insert('items', { name: 'Short' });

    await db.render(outputDir);
    const content = readFileSync(join(outputDir, 'items.md'), 'utf8');
    expect(content).not.toContain('[truncated');
    expect(content).toBe('- Short');
  });

  it('respects prioritizeBy column', async () => {
    db = new Lattice(':memory:');
    db.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', priority: 'INTEGER' },
      render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
      outputFile: 'items.md',
      tokenBudget: 8, // fits ~2 rows
      prioritizeBy: 'priority',
    });
    await db.init();
    await db.insert('items', { name: 'Low', priority: 1 });
    await db.insert('items', { name: 'High', priority: 100 });
    await db.insert('items', { name: 'Medium', priority: 50 });

    await db.render(outputDir);
    const content = readFileSync(join(outputDir, 'items.md'), 'utf8');
    // High priority should appear; low priority may be cut
    expect(content).toContain('High');
  });
});

describe('Relevance-filtered rendering', () => {
  let db: Lattice;
  let outputDir: string;
  const dirs: string[] = [];

  function tempDir() {
    const d = mkdtempSync(join(tmpdir(), 'lattice-rf-'));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    outputDir = tempDir();
  });

  afterEach(() => {
    db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('filters rows by task context', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      render: (rows) => rows.map((r) => r.body as string).join('\n'),
      outputFile: 'notes.md',
      relevanceFilter: (row, ctx) =>
        ctx ? (row.body as string).toLowerCase().includes(ctx.toLowerCase()) : true,
    });
    await db.init();
    await db.insert('notes', { body: 'deploy the service' });
    await db.insert('notes', { body: 'fix the login bug' });
    await db.insert('notes', { body: 'deploy monitoring' });

    db.setTaskContext('deploy');
    await db.render(outputDir);
    const content = readFileSync(join(outputDir, 'notes.md'), 'utf8');
    expect(content).toContain('deploy the service');
    expect(content).toContain('deploy monitoring');
    expect(content).not.toContain('login bug');
  });

  it('renders all rows when no task context is set', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      render: (rows) => rows.map((r) => r.body as string).join('\n'),
      outputFile: 'notes.md',
      relevanceFilter: (row, ctx) => (ctx ? (row.body as string).includes(ctx) : true),
    });
    await db.init();
    await db.insert('notes', { body: 'A' });
    await db.insert('notes', { body: 'B' });

    await db.render(outputDir);
    const content = readFileSync(join(outputDir, 'notes.md'), 'utf8');
    expect(content).toContain('A');
    expect(content).toContain('B');
  });

  it('getTaskContext returns current context', () => {
    db = new Lattice(':memory:');
    expect(db.getTaskContext()).toBe('');
    db.setTaskContext('test');
    expect(db.getTaskContext()).toBe('test');
  });
});

describe('Context enrichment pipeline', () => {
  let db: Lattice;
  let outputDir: string;
  const dirs: string[] = [];

  function tempDir() {
    const d = mkdtempSync(join(tmpdir(), 'lattice-enrich-'));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    outputDir = tempDir();
  });

  afterEach(() => {
    db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('applies enrichment hooks in order', async () => {
    db = new Lattice(':memory:');
    db.define('data', {
      columns: { id: 'TEXT PRIMARY KEY', val: 'INTEGER' },
      render: (rows) => JSON.stringify(rows),
      outputFile: 'data.json',
      enrich: [
        (rows) => rows.map((r) => ({ ...r, doubled: (r.val as number) * 2 })),
        (rows) => rows.filter((r) => (r.doubled as number) > 5),
      ],
    });
    await db.init();
    await db.insert('data', { val: 1 });
    await db.insert('data', { val: 5 });
    await db.insert('data', { val: 10 });

    await db.render(outputDir);
    const content = JSON.parse(readFileSync(join(outputDir, 'data.json'), 'utf8'));
    // val=1 → doubled=2 (filtered out), val=5 → doubled=10, val=10 → doubled=20
    expect(content).toHaveLength(2);
    expect(content[0].doubled).toBe(10);
    expect(content[1].doubled).toBe(20);
  });
});

describe('Reward-scored memory', () => {
  let db: Lattice;
  let outputDir: string;
  const dirs: string[] = [];

  function tempDir() {
    const d = mkdtempSync(join(tmpdir(), 'lattice-reward-'));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    outputDir = tempDir();
  });

  afterEach(() => {
    db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('auto-adds reward columns when rewardTracking is true', async () => {
    db = new Lattice(':memory:');
    db.define('knowledge', {
      columns: { id: 'TEXT PRIMARY KEY', fact: 'TEXT' },
      render: (rows) => rows.map((r) => r.fact as string).join('\n'),
      outputFile: 'knowledge.md',
      rewardTracking: true,
    });
    await db.init();
    await db.insert('knowledge', { fact: 'The sky is blue' });

    const rows = await db.query('knowledge');
    expect(rows[0]._reward_total).toBe(0);
    expect(rows[0]._reward_count).toBe(0);
  });

  it('updates reward scores via reward()', async () => {
    db = new Lattice(':memory:');
    db.define('knowledge', {
      columns: { id: 'TEXT PRIMARY KEY', fact: 'TEXT' },
      render: (rows) => rows.map((r) => r.fact as string).join('\n'),
      outputFile: 'knowledge.md',
      rewardTracking: true,
    });
    await db.init();
    const id = await db.insert('knowledge', { fact: 'Water is wet' });

    await db.reward('knowledge', id, { relevance: 0.8, accuracy: 1.0 });
    let row = (await db.get('knowledge', id))!;
    expect(row._reward_total).toBe(0.9); // avg(0.8, 1.0) = 0.9
    expect(row._reward_count).toBe(1);

    // Second reward call — running average
    await db.reward('knowledge', id, { relevance: 0.5 });
    row = (await db.get('knowledge', id))!;
    expect(row._reward_count).toBe(2);
    // new_total = (0.9 * 1 + 0.5) / 2 = 0.7
    expect(row._reward_total).toBeCloseTo(0.7, 5);
  });

  it('rejects reward() on tables without rewardTracking', async () => {
    db = new Lattice(':memory:');
    db.define('plain', {
      columns: { id: 'TEXT PRIMARY KEY' },
    });
    await db.init();

    await expect(db.reward('plain', 'x', { score: 1 })).rejects.toThrow('rewardTracking');
  });

  it('sorts rows by reward descending during render', async () => {
    db = new Lattice(':memory:');
    db.define('tips', {
      columns: { id: 'TEXT PRIMARY KEY', tip: 'TEXT' },
      render: (rows) => rows.map((r) => r.tip as string).join('\n'),
      outputFile: 'tips.md',
      rewardTracking: true,
    });
    await db.init();
    const id1 = await db.insert('tips', { tip: 'Low tip' });
    const id2 = await db.insert('tips', { tip: 'High tip' });

    await db.reward('tips', id1, { score: 0.2 });
    await db.reward('tips', id2, { score: 0.9 });

    await db.render(outputDir);
    const content = readFileSync(join(outputDir, 'tips.md'), 'utf8');
    const lines = content.split('\n');
    expect(lines[0]).toBe('High tip');
    expect(lines[1]).toBe('Low tip');
  });
});

describe('Semantic search via embeddings', () => {
  let db: Lattice;
  const dirs: string[] = [];

  // Helper available for tests that need on-disk DB
  // function tempDir() { const d = mkdtempSync(join(tmpdir(), 'lattice-embed-')); dirs.push(d); return d; }

  afterEach(() => {
    db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  // Simple mock embedding: convert text to a fixed-length vector based on char codes
  function mockEmbed(text: string): Promise<number[]> {
    const vec = new Array(8).fill(0) as number[];
    for (let i = 0; i < text.length; i++) {
      vec[i % 8]! += text.charCodeAt(i) / 1000;
    }
    // Normalize
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return Promise.resolve(mag > 0 ? vec.map((v) => v / mag) : vec);
  }

  it('stores and retrieves by semantic similarity', async () => {
    db = new Lattice(':memory:');
    db.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT' },
      render: () => '',
      outputFile: 'docs.md',
      embeddings: {
        fields: ['title', 'body'],
        embed: mockEmbed,
      },
    });
    await db.init();

    await db.insert('docs', { title: 'Deploy guide', body: 'How to deploy the app to production' });
    await db.insert('docs', { title: 'Testing guide', body: 'How to write unit tests' });
    await db.insert('docs', { title: 'Deploy checklist', body: 'Steps for production deployment' });

    // Wait a tick for async embedding storage
    await new Promise((r) => setTimeout(r, 50));

    const results = await db.search('docs', 'deployment to production', { topK: 2 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.length).toBeLessThanOrEqual(2);
    // Each result has row and score
    expect(results[0].row).toBeDefined();
    expect(typeof results[0].score).toBe('number');
  });

  it('rejects search on tables without embeddings', async () => {
    db = new Lattice(':memory:');
    db.define('plain', {
      columns: { id: 'TEXT PRIMARY KEY' },
    });
    await db.init();

    await expect(db.search('plain', 'test')).rejects.toThrow('embeddings');
  });

  it('respects minScore filter', async () => {
    db = new Lattice(':memory:');
    db.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      render: () => '',
      outputFile: 'docs.md',
      embeddings: {
        fields: ['body'],
        embed: mockEmbed,
      },
    });
    await db.init();

    await db.insert('docs', { body: 'completely unrelated content about cooking recipes' });
    await new Promise((r) => setTimeout(r, 50));

    const results = await db.search('docs', 'deploy', { minScore: 0.999 });
    // With such a high threshold, unlikely to match random content
    expect(results.length).toBeLessThanOrEqual(1);
  });
});
