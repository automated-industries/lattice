import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lattice-ec-'));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('defineEntityContext (integration)', () => {
  let db: Lattice;
  let outputDir: string;
  const dirs: string[] = [];

  beforeEach(() => {
    outputDir = tempDir();
    dirs.push(outputDir);
    db = new Lattice(':memory:');

    // Primary entity table
    db.define('agents', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', slug: 'TEXT NOT NULL' },
      render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
      outputFile: 'agents.md',
    });

    // hasMany related table
    db.define('tasks', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        agent_id: 'TEXT NOT NULL',
        title: 'TEXT NOT NULL',
      },
      render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
      outputFile: 'tasks.md',
    });

    // manyToMany remote + junction
    db.define('skills', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
      outputFile: 'skills.md',
    });
    db.define('agent_skills', {
      columns: { id: 'TEXT PRIMARY KEY', agent_id: 'TEXT NOT NULL', skill_id: 'TEXT NOT NULL' },
      render: () => '',
      outputFile: '_ignored.md',
    });

    // belongsTo parent table
    db.define('teams', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      render: () => '',
      outputFile: '_teams.md',
    });
  });

  afterEach(() => {
    db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  // -------------------------------------------------------------------------
  // Basic setup
  // -------------------------------------------------------------------------

  it('defineEntityContext() is chainable and does not throw', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
      },
    });
    await db.init();
  });

  it('throws if the same table is registered twice', async () => {
    await db.init();
    // Can only call defineEntityContext before init, so close and reopen
    db.close();
    db = new Lattice(':memory:');
    db.define('agents', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', slug: 'TEXT NOT NULL' },
      render: () => '',
      outputFile: 'agents.md',
    });
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {},
    });
    expect(() =>
      db.defineEntityContext('agents', {
        slug: (r) => r.slug as string,
        files: {},
      }),
    ).toThrow(/already defined/);
  });

  // -------------------------------------------------------------------------
  // Index file
  // -------------------------------------------------------------------------

  it('writes the index file', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      index: {
        outputFile: 'agents/AGENTS.md',
        render: (rows) => `# Agents\n\n${rows.map((r) => `- ${r.name as string}`).join('\n')}`,
      },
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('agents', { id: 'a2', name: 'Beta', slug: 'beta' });

    await db.render(outputDir);

    const indexContent = readFileSync(join(outputDir, 'agents/AGENTS.md'), 'utf8');
    expect(indexContent).toContain('# Agents');
    expect(indexContent).toContain('- Alpha');
    expect(indexContent).toContain('- Beta');
  });

  // -------------------------------------------------------------------------
  // Per-entity directories and files
  // -------------------------------------------------------------------------

  it('creates per-entity directory with slug-named subdirectory', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.render(outputDir);

    expect(existsSync(join(outputDir, 'agents', 'alpha'))).toBe(true);
    const agentMd = readFileSync(join(outputDir, 'agents', 'alpha', 'AGENT.md'), 'utf8');
    expect(agentMd).toBe('# Alpha');
  });

  it('uses custom directoryRoot when specified', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      directoryRoot: 'context/bots',
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.render(outputDir);

    expect(existsSync(join(outputDir, 'context', 'bots', 'alpha', 'AGENT.md'))).toBe(true);
  });

  it('uses custom directory() function when specified', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      directory: (r) => `custom/${r.slug as string}/ctx`,
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.render(outputDir);

    expect(existsSync(join(outputDir, 'custom', 'alpha', 'ctx', 'AGENT.md'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Source types
  // -------------------------------------------------------------------------

  it('hasMany source — writes related rows', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'TASKS.md': {
          source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
          render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Task One' });
    await db.insert('tasks', { id: 't2', agent_id: 'a1', title: 'Task Two' });
    // task for a different agent — should not appear
    await db.insert('agents', { id: 'a2', name: 'Beta', slug: 'beta' });
    await db.insert('tasks', { id: 't3', agent_id: 'a2', title: 'Beta Task' });

    await db.render(outputDir);

    const content = readFileSync(join(outputDir, 'agents', 'alpha', 'TASKS.md'), 'utf8');
    expect(content).toContain('Task One');
    expect(content).toContain('Task Two');
    expect(content).not.toContain('Beta Task');
  });

  it('manyToMany source — joins through junction table', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'SKILLS.md': {
          source: {
            type: 'manyToMany',
            junctionTable: 'agent_skills',
            localKey: 'agent_id',
            remoteKey: 'skill_id',
            remoteTable: 'skills',
          },
          render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('skills', { id: 's1', name: 'TypeScript' });
    await db.insert('skills', { id: 's2', name: 'Python' });
    await db.insert('agent_skills', { agent_id: 'a1', skill_id: 's1' });
    await db.insert('agent_skills', { agent_id: 'a1', skill_id: 's2' });

    await db.render(outputDir);

    const content = readFileSync(join(outputDir, 'agents', 'alpha', 'SKILLS.md'), 'utf8');
    expect(content).toContain('TypeScript');
    expect(content).toContain('Python');
  });

  it('belongsTo source — looks up parent row', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'TEAM.md': {
          source: { type: 'belongsTo', table: 'teams', foreignKey: 'team_id' },
          render: ([r]) => (r ? `Team: ${r.name as string}` : 'No team'),
        },
      },
    });

    // Need team_id column — redefine agents with extra column via migration approach
    // Since agents is already defined, close and reopen with extended schema
    db.close();
    db = new Lattice(':memory:');
    db.define('agents', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT NOT NULL',
        slug: 'TEXT NOT NULL',
        team_id: 'TEXT',
      },
      render: () => '',
      outputFile: '_agents.md',
    });
    db.define('teams', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      render: () => '',
      outputFile: '_teams.md',
    });
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'TEAM.md': {
          source: { type: 'belongsTo', table: 'teams', foreignKey: 'team_id' },
          render: ([r]) => (r ? `Team: ${r.name as string}` : 'No team'),
        },
      },
    });

    await db.init();
    await db.insert('teams', { id: 'tm1', name: 'Dream Team' });
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha', team_id: 'tm1' });

    await db.render(outputDir);

    const content = readFileSync(join(outputDir, 'agents', 'alpha', 'TEAM.md'), 'utf8');
    expect(content).toBe('Team: Dream Team');
  });

  it('custom source — delegates to caller function', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'CUSTOM.md': {
          source: {
            type: 'custom',
            query: (row, adapter) =>
              adapter.all('SELECT * FROM tasks WHERE agent_id = ? ORDER BY title', [row.id]),
          },
          render: (rows) => rows.map((r) => `* ${r.title as string}`).join('\n'),
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Bravo' });
    await db.insert('tasks', { id: 't2', agent_id: 'a1', title: 'Alpha' });

    await db.render(outputDir);

    const content = readFileSync(join(outputDir, 'agents', 'alpha', 'CUSTOM.md'), 'utf8');
    expect(content).toContain('* Alpha');
    expect(content).toContain('* Bravo');
  });

  // -------------------------------------------------------------------------
  // omitIfEmpty
  // -------------------------------------------------------------------------

  it('omitIfEmpty — skips file when source returns no rows', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
        'TASKS.md': {
          source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
          render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
          omitIfEmpty: true,
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    // No tasks inserted

    await db.render(outputDir);

    expect(existsSync(join(outputDir, 'agents', 'alpha', 'AGENT.md'))).toBe(true);
    expect(existsSync(join(outputDir, 'agents', 'alpha', 'TASKS.md'))).toBe(false);
  });

  it('omitIfEmpty — writes file when source has rows', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'TASKS.md': {
          source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
          render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
          omitIfEmpty: true,
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Task One' });

    await db.render(outputDir);

    expect(existsSync(join(outputDir, 'agents', 'alpha', 'TASKS.md'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Budget truncation
  // -------------------------------------------------------------------------

  it('truncates file content at budget', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'DATA.md': {
          source: { type: 'self' },
          render: () => 'x'.repeat(100),
          budget: 10,
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.render(outputDir);

    const content = readFileSync(join(outputDir, 'agents', 'alpha', 'DATA.md'), 'utf8');
    expect(content).toContain('[truncated');
    expect(content.startsWith('x'.repeat(10))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Combined file
  // -------------------------------------------------------------------------

  it('combined — writes all files joined with separator', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
        'TASKS.md': {
          source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
          render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
        },
      },
      combined: { outputFile: 'CONTEXT.md' },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Task One' });

    await db.render(outputDir);

    const content = readFileSync(join(outputDir, 'agents', 'alpha', 'CONTEXT.md'), 'utf8');
    expect(content).toContain('# Alpha');
    expect(content).toContain('Task One');
    expect(content).toContain('---');
  });

  it('combined — respects exclude list', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
        'TASKS.md': {
          source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
          render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
        },
      },
      combined: { outputFile: 'CONTEXT.md', exclude: ['TASKS.md'] },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Task One' });

    await db.render(outputDir);

    const content = readFileSync(join(outputDir, 'agents', 'alpha', 'CONTEXT.md'), 'utf8');
    expect(content).toContain('# Alpha');
    expect(content).not.toContain('Task One');
  });

  it('combined — omitted files (omitIfEmpty) are excluded from combined', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
        'TASKS.md': {
          source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
          render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
          omitIfEmpty: true,
        },
      },
      combined: { outputFile: 'CONTEXT.md' },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    // No tasks

    await db.render(outputDir);

    const content = readFileSync(join(outputDir, 'agents', 'alpha', 'CONTEXT.md'), 'utf8');
    expect(content).toContain('# Alpha');
    // TASKS.md was omitted, so separator should not appear
    expect(content).not.toContain('---');
  });

  // -------------------------------------------------------------------------
  // Hash-skip (atomicWrite idempotency)
  // -------------------------------------------------------------------------

  it('second render skips unchanged files', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    const first = await db.render(outputDir);
    const second = await db.render(outputDir);

    // On the second render, content is unchanged — files should be skipped
    expect(second.filesSkipped).toBeGreaterThan(0);
    expect(second.filesWritten.length).toBeLessThan(first.filesWritten.length);
  });

  // -------------------------------------------------------------------------
  // RenderResult counters
  // -------------------------------------------------------------------------

  it('filesWritten includes entity context files', async () => {
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      index: {
        outputFile: 'agents/AGENTS.md',
        render: (rows) => rows.map((r) => `- ${r.slug as string}`).join('\n'),
      },
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r?.name as string}`,
        },
        'TASKS.md': {
          source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
          render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
        },
      },
      combined: { outputFile: 'CONTEXT.md' },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Task One' });

    const result = await db.render(outputDir);

    // index + AGENT.md + TASKS.md + CONTEXT.md + agents.md + tasks.md + skills.md + agent_skills.md + _teams.md
    // At minimum: index(1) + AGENT.md(1) + TASKS.md(1) + CONTEXT.md(1) = 4 entity-context files
    const ecFiles = result.filesWritten.filter(
      (f) => f.includes('alpha') || f.includes('AGENTS.md'),
    );
    expect(ecFiles.length).toBeGreaterThanOrEqual(4);
  });
});
