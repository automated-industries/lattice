import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { readManifest } from '../../src/lifecycle/manifest.js';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-lc-'));
  tmpDirs.push(d);
  return d;
}

/** Build a fresh Lattice instance with agents + tasks + skills + agent_skills tables. */
async function setupDb(path = ':memory:'): Promise<{ db: Lattice; outputDir: string }> {
  const outputDir = tempDir();
  const db = new Lattice(path);

  db.define('agents', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', slug: 'TEXT NOT NULL' },
    render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
    outputFile: 'agents.md',
  });

  db.define('tasks', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      agent_id: 'TEXT NOT NULL',
      title: 'TEXT NOT NULL',
    },
    render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
    outputFile: 'tasks.md',
  });

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

  db.defineEntityContext('agents', {
    slug: (r) => r.slug as string,
    directoryRoot: 'agents',
    index: {
      outputFile: 'agents/AGENTS.md',
      render: (rows) => `# Agents\n\n${rows.map((r) => `- ${r.name as string}`).join('\n')}`,
    },
    files: {
      'AGENT.md': {
        source: { type: 'self' },
        render: ([r]) => `# ${(r ?? {}).name as string}`,
      },
      'TASKS.md': {
        source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
        render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
        omitIfEmpty: true,
      },
      'SKILLS.md': {
        source: {
          type: 'manyToMany',
          junctionTable: 'agent_skills',
          localKey: 'agent_id',
          remoteKey: 'skill_id',
          remoteTable: 'skills',
        },
        render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
        omitIfEmpty: true,
      },
    },
    combined: { outputFile: 'CONTEXT.md' },
  });

  await db.init();
  return { db, outputDir };
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lifecycle: manifest + orphan cleanup', () => {

  // 1. Entity deletion — reconcile removes orphaned directory
  it('reconcile removes orphaned directory when entity is deleted', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('agents', { id: 'a2', name: 'Beta', slug: 'beta' });

    // First reconcile: creates both directories
    await db.reconcile(outputDir);

    expect(existsSync(join(outputDir, 'agents', 'alpha'))).toBe(true);
    expect(existsSync(join(outputDir, 'agents', 'beta'))).toBe(true);

    // Delete agent Beta
    await db.delete('agents', 'a2');

    // Second reconcile: should remove beta directory
    const result = await db.reconcile(outputDir);

    expect(existsSync(join(outputDir, 'agents', 'beta'))).toBe(false);
    expect(result.cleanup.directoriesRemoved.length).toBeGreaterThanOrEqual(1);
    expect(result.cleanup.directoriesRemoved.some((d) => d.endsWith('beta'))).toBe(true);

    db.close();
  });

  // 2. Protected files — directory left in place when SESSION.md exists; managed files removed
  it('leaves directory in place when protectedFiles present, removes managed files', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    // Render to create the directory
    await db.reconcile(outputDir);

    // Simulate a user-written file in the agent's directory
    const agentDir = join(outputDir, 'agents', 'alpha');
    writeFileSync(join(agentDir, 'SESSION.md'), '# Session notes');

    // Delete the agent
    await db.delete('agents', 'a1');

    // Reconcile with protectedFiles
    const result = await db.reconcile(outputDir, { protectedFiles: ['SESSION.md'] });

    // Directory should NOT be removed (user file exists)
    expect(existsSync(agentDir)).toBe(true);
    // SESSION.md should still be there
    expect(existsSync(join(agentDir, 'SESSION.md'))).toBe(true);
    // Managed files should be gone
    expect(existsSync(join(agentDir, 'AGENT.md'))).toBe(false);
    // Directory reported as skipped
    expect(result.cleanup.directoriesSkipped.some((d) => d.endsWith('alpha'))).toBe(true);

    db.close();
  });

  // 3. Entity creation — new entity directory created on render
  it('creates new entity directory on render', async () => {
    const { db, outputDir } = await setupDb();

    await db.render(outputDir);

    // No agents yet — directory should not exist
    expect(existsSync(join(outputDir, 'agents', 'gamma'))).toBe(false);

    // Add agent
    await db.insert('agents', { id: 'a3', name: 'Gamma', slug: 'gamma' });
    await db.render(outputDir);

    expect(existsSync(join(outputDir, 'agents', 'gamma'))).toBe(true);
    const content = readFileSync(join(outputDir, 'agents', 'gamma', 'AGENT.md'), 'utf8');
    expect(content).toContain('# Gamma');

    db.close();
  });

  // 4. Entity slug rename — old directory removed, new directory created
  it('reconcile removes old slug directory and creates new slug directory on rename', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha-v1' });

    await db.reconcile(outputDir);
    expect(existsSync(join(outputDir, 'agents', 'alpha-v1'))).toBe(true);

    // Simulate a slug rename by deleting and re-inserting
    await db.delete('agents', 'a1');
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha-v2' });

    const result = await db.reconcile(outputDir);

    // Old directory gone
    expect(existsSync(join(outputDir, 'agents', 'alpha-v1'))).toBe(false);
    // New directory present
    expect(existsSync(join(outputDir, 'agents', 'alpha-v2'))).toBe(true);
    expect(result.cleanup.directoriesRemoved.some((d) => d.endsWith('alpha-v1'))).toBe(true);

    db.close();
  });

  // 5. Relationship file added — new file appears automatically on next render
  it('new relationship file appears when entity gains related rows', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    // Render with no tasks: TASKS.md should be omitted (omitIfEmpty)
    await db.render(outputDir);
    expect(existsSync(join(outputDir, 'agents', 'alpha', 'TASKS.md'))).toBe(false);

    // Add a task
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Task One' });
    await db.render(outputDir);

    // Now TASKS.md should exist
    expect(existsSync(join(outputDir, 'agents', 'alpha', 'TASKS.md'))).toBe(true);
    const content = readFileSync(join(outputDir, 'agents', 'alpha', 'TASKS.md'), 'utf8');
    expect(content).toContain('Task One');

    db.close();
  });

  // 6. Relationship file removed — reconcile removes stale file
  it('reconcile removes stale omitIfEmpty file when all related rows are deleted', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Task One' });

    // First reconcile: TASKS.md written
    await db.reconcile(outputDir);
    expect(existsSync(join(outputDir, 'agents', 'alpha', 'TASKS.md'))).toBe(true);

    // Delete all tasks
    await db.delete('tasks', 't1');

    // Second reconcile: TASKS.md should be removed (omitIfEmpty + no rows)
    // The render won't write it; cleanup should remove the stale version
    const result = await db.reconcile(outputDir);

    expect(existsSync(join(outputDir, 'agents', 'alpha', 'TASKS.md'))).toBe(false);
    expect(result.cleanup.filesRemoved.some((f) => f.endsWith('TASKS.md'))).toBe(true);

    db.close();
  });

  // 7. Dry run — orphans reported but nothing deleted
  it('dry run reports orphans without deleting anything', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.reconcile(outputDir);
    expect(existsSync(join(outputDir, 'agents', 'alpha'))).toBe(true);

    // Delete the agent
    await db.delete('agents', 'a1');

    const orphans: Array<{ path: string; kind: string }> = [];
    const result = await db.reconcile(outputDir, {
      dryRun: true,
      onOrphan: (path, kind) => orphans.push({ path, kind }),
    });

    // Directory should still exist (dry run)
    expect(existsSync(join(outputDir, 'agents', 'alpha'))).toBe(true);

    // But orphans are reported
    expect(result.cleanup.filesRemoved.length + result.cleanup.directoriesRemoved.length).toBeGreaterThan(0);
    expect(orphans.length).toBeGreaterThan(0);

    db.close();
  });

  // 8. Manifest continuity — manifest reflects what was written; updates when omitIfEmpty changes
  it('manifest reflects written files and updates when omitIfEmpty files appear', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    // First render: no tasks, so TASKS.md omitted
    await db.render(outputDir);

    const manifest1 = readManifest(outputDir);
    expect(manifest1).not.toBeNull();
    expect(manifest1!.version).toBe(1);
    expect(manifest1!.entityContexts['agents']).toBeDefined();

    const alphaFiles1 = manifest1!.entityContexts['agents']!.entities['alpha'] ?? [];
    expect(alphaFiles1).toContain('AGENT.md');
    expect(alphaFiles1).not.toContain('TASKS.md');
    expect(alphaFiles1).toContain('CONTEXT.md');

    // Add task and re-render
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Task One' });
    await db.render(outputDir);

    const manifest2 = readManifest(outputDir);
    expect(manifest2).not.toBeNull();
    const alphaFiles2 = manifest2!.entityContexts['agents']!.entities['alpha'] ?? [];
    expect(alphaFiles2).toContain('AGENT.md');
    expect(alphaFiles2).toContain('TASKS.md');
    expect(alphaFiles2).toContain('CONTEXT.md');

    db.close();
  });

  // Bonus: manifest is written to .lattice/manifest.json inside outputDir
  it('manifest is written at .lattice/manifest.json', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.render(outputDir);

    const manifestFile = join(outputDir, '.lattice', 'manifest.json');
    expect(existsSync(manifestFile)).toBe(true);

    const raw = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    expect(raw['version']).toBe(1);
    expect(typeof raw['generated_at']).toBe('string');

    db.close();
  });

  // Bonus: reconcile returns RenderResult + cleanup combined
  it('reconcile result includes both render and cleanup data', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    const result = await db.reconcile(outputDir);

    // RenderResult fields
    expect(typeof result.filesWritten).toBe('object');
    expect(typeof result.filesSkipped).toBe('number');
    expect(typeof result.durationMs).toBe('number');

    // CleanupResult fields
    expect(Array.isArray(result.cleanup.directoriesRemoved)).toBe(true);
    expect(Array.isArray(result.cleanup.filesRemoved)).toBe(true);
    expect(Array.isArray(result.cleanup.directoriesSkipped)).toBe(true);
    expect(Array.isArray(result.cleanup.warnings)).toBe(true);

    db.close();
  });
});
