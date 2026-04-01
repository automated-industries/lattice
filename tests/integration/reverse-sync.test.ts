import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { readManifest, entityFileNames } from '../../src/lifecycle/manifest.js';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-rs-'));
  tmpDirs.push(d);
  return d;
}

/**
 * Build a Lattice instance with agents table and entity context.
 * The AGENT.md file has a reverseSync that parses `# Name` back to `name` column.
 */
async function setupDb(opts?: {
  withReverseSync?: boolean;
  path?: string;
}): Promise<{ db: Lattice; outputDir: string }> {
  const outputDir = tempDir();
  const db = new Lattice(opts?.path ?? ':memory:');

  db.define('agents', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      slug: 'TEXT NOT NULL',
      role: 'TEXT',
      soul: 'TEXT',
    },
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

  const reverseSyncAgent = opts?.withReverseSync !== false
    ? (content: string, entityRow: import('../../src/types.js').Row) => {
        const updates: import('../../src/schema/entity-context.js').ReverseSyncUpdate[] = [];
        const nameMatch = content.match(/^# (.+)$/m);
        if (nameMatch && nameMatch[1] !== entityRow.name) {
          updates.push({
            table: 'agents',
            pk: { id: entityRow.id },
            set: { name: nameMatch[1] },
          });
        }
        const roleMatch = content.match(/^\*\*Role:\*\* (.+)$/m);
        if (roleMatch && roleMatch[1] !== entityRow.role) {
          updates.push({
            table: 'agents',
            pk: { id: entityRow.id },
            set: { role: roleMatch[1] },
          });
        }
        const soulMatch = content.match(/## Soul\n([\s\S]*?)(?:\n##|$)/);
        if (soulMatch) {
          const soul = soulMatch[1].trim();
          if (soul && soul !== entityRow.soul) {
            updates.push({
              table: 'agents',
              pk: { id: entityRow.id },
              set: { soul },
            });
          }
        }
        return updates;
      }
    : undefined;

  db.defineEntityContext('agents', {
    slug: (r) => r.slug as string,
    directoryRoot: 'agents',
    files: {
      'AGENT.md': {
        source: { type: 'self' },
        render: ([r]) => {
          let md = `# ${(r ?? {}).name as string}\n`;
          if (r?.role) md += `**Role:** ${r.role as string}\n`;
          if (r?.soul) md += `\n## Soul\n${r.soul as string}\n`;
          return md;
        },
        reverseSync: reverseSyncAgent,
      },
      'TASKS.md': {
        source: { type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' },
        render: (rows) => rows.map((r) => `- ${r.title as string}`).join('\n'),
        omitIfEmpty: true,
        // No reverseSync — should be skipped
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

describe('reverse-sync', () => {

  // --- Core round-trip ---

  it('detects file modification and syncs change back to DB', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha', role: 'Scout' });

    // First reconcile: renders files and writes manifest with hashes
    await db.reconcile(outputDir);

    const agentFile = join(outputDir, 'agents', 'alpha', 'AGENT.md');
    expect(readFileSync(agentFile, 'utf8')).toContain('# Alpha');

    // Simulate agent editing the file
    writeFileSync(agentFile, '# Alpha Reborn\n**Role:** Commander\n');

    // Second reconcile: should detect change, reverse-sync to DB, then re-render
    const result = await db.reconcile(outputDir);

    expect(result.reverseSync).not.toBeNull();
    expect(result.reverseSync!.filesScanned).toBeGreaterThan(0);
    expect(result.reverseSync!.filesChanged).toBe(1);
    expect(result.reverseSync!.updatesApplied).toBe(2); // name + role

    // DB should be updated
    const row = await db.get('agents', 'a1');
    expect(row?.name).toBe('Alpha Reborn');
    expect(row?.role).toBe('Commander');

    // Re-rendered file should reflect the new DB state
    const newContent = readFileSync(agentFile, 'utf8');
    expect(newContent).toContain('# Alpha Reborn');
    expect(newContent).toContain('**Role:** Commander');

    db.close();
  });

  it('does not modify DB when file content unchanged', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.reconcile(outputDir);
    const result = await db.reconcile(outputDir);

    expect(result.reverseSync).not.toBeNull();
    expect(result.reverseSync!.filesScanned).toBeGreaterThan(0);
    expect(result.reverseSync!.filesChanged).toBe(0);
    expect(result.reverseSync!.updatesApplied).toBe(0);

    db.close();
  });

  it('skips files without reverseSync function', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('tasks', { id: 't1', agent_id: 'a1', title: 'Task One' });

    await db.reconcile(outputDir);

    // Modify TASKS.md (which has no reverseSync)
    const tasksFile = join(outputDir, 'agents', 'alpha', 'TASKS.md');
    writeFileSync(tasksFile, '- Modified Task\n');

    const result = await db.reconcile(outputDir);

    // Only AGENT.md should be scanned (the one with reverseSync)
    expect(result.reverseSync!.filesScanned).toBe(1);
    expect(result.reverseSync!.filesChanged).toBe(0);

    db.close();
  });

  // --- Dry-run mode ---

  it('dry-run reports changes but does not modify DB', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.reconcile(outputDir);

    const agentFile = join(outputDir, 'agents', 'alpha', 'AGENT.md');
    writeFileSync(agentFile, '# Modified Name\n');

    const result = await db.reconcile(outputDir, { reverseSync: 'dry-run' });

    // Changes detected and counted
    expect(result.reverseSync!.filesChanged).toBe(1);
    expect(result.reverseSync!.updatesApplied).toBe(1);

    // But DB was NOT modified
    const row = await db.get('agents', 'a1');
    expect(row?.name).toBe('Alpha');

    db.close();
  });

  // --- Disabled ---

  it('reverseSync: false skips the entire phase', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.reconcile(outputDir);

    const agentFile = join(outputDir, 'agents', 'alpha', 'AGENT.md');
    writeFileSync(agentFile, '# Should Not Sync\n');

    const result = await db.reconcile(outputDir, { reverseSync: false });

    expect(result.reverseSync).toBeNull();

    // DB unchanged
    const row = await db.get('agents', 'a1');
    expect(row?.name).toBe('Alpha');

    db.close();
  });

  // --- Edge cases ---

  it('handles deleted file gracefully', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.reconcile(outputDir);

    // Delete the file
    const agentFile = join(outputDir, 'agents', 'alpha', 'AGENT.md');
    rmSync(agentFile);

    // Reconcile should not crash — file is gone so reverse-sync skips it
    const result = await db.reconcile(outputDir);
    expect(result.reverseSync!.filesChanged).toBe(0);
    expect(result.reverseSync!.errors).toEqual([]);

    db.close();
  });

  it('handles reverseSync function that throws', async () => {
    const outputDir = tempDir();
    const db = new Lattice(':memory:');

    db.define('agents', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', slug: 'TEXT NOT NULL' },
      render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
      outputFile: 'agents.md',
    });

    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      directoryRoot: 'agents',
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${(r ?? {}).name as string}\n`,
          reverseSync: () => { throw new Error('Parse failed!'); },
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.reconcile(outputDir);

    // Modify file to trigger reverseSync
    writeFileSync(join(outputDir, 'agents', 'alpha', 'AGENT.md'), '# Changed\n');

    const result = await db.reconcile(outputDir);

    // Error captured, not thrown
    expect(result.reverseSync!.filesChanged).toBe(1);
    expect(result.reverseSync!.errors.length).toBe(1);
    expect(result.reverseSync!.errors[0].error).toContain('Parse failed!');

    // DB unchanged (transaction rolled back)
    const row = await db.get('agents', 'a1');
    expect(row?.name).toBe('Alpha');

    db.close();
  });

  it('handles reverseSync returning empty array (no updates)', async () => {
    const outputDir = tempDir();
    const db = new Lattice(':memory:');

    db.define('agents', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', slug: 'TEXT NOT NULL' },
      render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
      outputFile: 'agents.md',
    });

    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      directoryRoot: 'agents',
      files: {
        'AGENT.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${(r ?? {}).name as string}\n`,
          reverseSync: () => [], // Always returns empty
        },
      },
    });

    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.reconcile(outputDir);
    writeFileSync(join(outputDir, 'agents', 'alpha', 'AGENT.md'), '# Changed\n');

    const result = await db.reconcile(outputDir);

    expect(result.reverseSync!.filesChanged).toBe(1);
    expect(result.reverseSync!.updatesApplied).toBe(0);

    db.close();
  });

  it('skips entities deleted since last manifest (no row in DB)', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('agents', { id: 'a2', name: 'Beta', slug: 'beta' });

    await db.reconcile(outputDir);

    // Modify both files
    writeFileSync(join(outputDir, 'agents', 'alpha', 'AGENT.md'), '# Alpha Modified\n');
    writeFileSync(join(outputDir, 'agents', 'beta', 'AGENT.md'), '# Beta Modified\n');

    // Delete Beta from DB
    await db.delete('agents', 'a2');

    const result = await db.reconcile(outputDir);

    // Only Alpha's change should be processed (Beta's entity is gone)
    expect(result.reverseSync!.filesChanged).toBe(1);
    expect(result.reverseSync!.updatesApplied).toBe(1);

    const row = await db.get('agents', 'a1');
    expect(row?.name).toBe('Alpha Modified');

    db.close();
  });

  // --- v1 manifest backward compatibility ---

  it('skips reverse-sync for v1 manifests (no hashes to compare)', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    // First reconcile writes a v2 manifest
    await db.reconcile(outputDir);

    // Manually downgrade the manifest to v1 format
    const manifestFile = join(outputDir, '.lattice', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.version = 1;
    // Convert entities to v1 string[] format
    for (const table of Object.keys(manifest.entityContexts)) {
      for (const slug of Object.keys(manifest.entityContexts[table].entities)) {
        const v2Entry = manifest.entityContexts[table].entities[slug];
        manifest.entityContexts[table].entities[slug] = Object.keys(v2Entry);
      }
    }
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    // Modify file
    writeFileSync(join(outputDir, 'agents', 'alpha', 'AGENT.md'), '# Hacked\n');

    // Reconcile should skip reverse-sync for v1 entries (empty hashes)
    const result = await db.reconcile(outputDir);
    expect(result.reverseSync!.filesChanged).toBe(0);

    // DB unchanged
    expect((await db.get('agents', 'a1'))?.name).toBe('Alpha');

    db.close();
  });

  // --- Multi-field update in a single file ---

  it('applies multiple updates from a single file change', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha', role: 'Scout', soul: 'Original soul text' });

    await db.reconcile(outputDir);

    // Modify all fields at once
    const agentFile = join(outputDir, 'agents', 'alpha', 'AGENT.md');
    writeFileSync(agentFile, '# Alpha Prime\n**Role:** Director\n\n## Soul\nNew soul identity\n');

    const result = await db.reconcile(outputDir);

    expect(result.reverseSync!.updatesApplied).toBe(3); // name + role + soul

    const row = await db.get('agents', 'a1');
    expect(row?.name).toBe('Alpha Prime');
    expect(row?.role).toBe('Director');
    expect(row?.soul).toBe('New soul identity');

    db.close();
  });

  // --- Multiple entities ---

  it('processes changes across multiple entities independently', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('agents', { id: 'a2', name: 'Beta', slug: 'beta' });
    await db.insert('agents', { id: 'a3', name: 'Gamma', slug: 'gamma' });

    await db.reconcile(outputDir);

    // Modify only Alpha and Gamma
    writeFileSync(join(outputDir, 'agents', 'alpha', 'AGENT.md'), '# Alpha V2\n');
    writeFileSync(join(outputDir, 'agents', 'gamma', 'AGENT.md'), '# Gamma V2\n');

    const result = await db.reconcile(outputDir);

    expect(result.reverseSync!.filesScanned).toBe(3);
    expect(result.reverseSync!.filesChanged).toBe(2);
    expect(result.reverseSync!.updatesApplied).toBe(2);

    expect((await db.get('agents', 'a1'))?.name).toBe('Alpha V2');
    expect((await db.get('agents', 'a2'))?.name).toBe('Beta'); // unchanged
    expect((await db.get('agents', 'a3'))?.name).toBe('Gamma V2');

    db.close();
  });

  // --- No reverseSync defined anywhere ---

  it('returns zero-count result when no file specs have reverseSync', async () => {
    const { db, outputDir } = await setupDb({ withReverseSync: false });

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.reconcile(outputDir);

    writeFileSync(join(outputDir, 'agents', 'alpha', 'AGENT.md'), '# Hacked\n');

    const result = await db.reconcile(outputDir);

    expect(result.reverseSync!.filesScanned).toBe(0);
    expect(result.reverseSync!.filesChanged).toBe(0);

    // DB unchanged since no reverseSync function
    expect((await db.get('agents', 'a1'))?.name).toBe('Alpha');

    db.close();
  });

  // --- Manifest hash tracking ---

  it('manifest v2 includes per-file hashes', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });

    await db.reconcile(outputDir);

    const manifest = readManifest(outputDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe(2);

    const entityEntry = manifest!.entityContexts['agents']!.entities['alpha'];
    // v2 format: Record<string, EntityFileManifestInfo>
    expect(entityEntry).not.toBeInstanceOf(Array);
    expect(typeof entityEntry).toBe('object');

    const agentInfo = (entityEntry as Record<string, { hash: string }>)['AGENT.md'];
    expect(agentInfo).toBeDefined();
    expect(typeof agentInfo.hash).toBe('string');
    expect(agentInfo.hash.length).toBe(64); // SHA-256 hex

    db.close();
  });
});
