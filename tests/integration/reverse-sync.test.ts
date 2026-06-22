import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import {
  readManifest,
  entityFileNames,
  type LatticeManifest,
} from '../../src/lifecycle/manifest.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

  const reverseSyncAgent =
    opts?.withReverseSync !== false
      ? (content: string, entityRow: import('../../src/types.js').Row) => {
          const updates: import('../../src/schema/entity-context.js').ReverseSyncUpdate[] = [];
          const nameMatch = /^# (.+)$/m.exec(content);
          if (nameMatch && nameMatch[1] !== entityRow.name) {
            updates.push({
              table: 'agents',
              pk: { id: entityRow.id },
              set: { name: nameMatch[1] },
            });
          }
          const roleMatch = /^\*\*Role:\*\* (.+)$/m.exec(content);
          if (roleMatch && roleMatch[1] !== entityRow.role) {
            updates.push({
              table: 'agents',
              pk: { id: entityRow.id },
              set: { role: roleMatch[1] },
            });
          }
          const soulMatch = /## Soul\n([\s\S]*?)(?:\n##|$)/.exec(content);
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
          let md = `# ${(r?.name as string) ?? ''}\n`;
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
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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
          render: ([r]) => `# ${(r?.name as string) ?? ''}\n`,
          reverseSync: () => {
            throw new Error('Parse failed!');
          },
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
          render: ([r]) => `# ${(r?.name as string) ?? ''}\n`,
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
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as LatticeManifest;
    manifest.version = 1;
    // Convert entities to v1 string[] format
    for (const table of Object.keys(manifest.entityContexts)) {
      for (const slug of Object.keys(manifest.entityContexts[table]!.entities)) {
        const v2Entry = manifest.entityContexts[table]!.entities[slug]!;
        manifest.entityContexts[table]!.entities[slug] = Object.keys(v2Entry);
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

  it('tolerates an OLD on-disk v1 (string[]) manifest entry: filenames still read for cleanup, reverse-sync treats it as no-baseline (skips, never mis-reads it as a Record)', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha', role: 'Scout' });

    // First reconcile writes a fresh v2 manifest.
    await db.reconcile(outputDir);

    // Hand-construct a legacy v1 manifest entry directly: the value for the slug
    // is a bare string[] (the pre-hash format), NOT a Record. This is what an old
    // .lattice/manifest.json on disk looks like.
    const manifestFile = join(outputDir, '.lattice', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as LatticeManifest;
    manifest.version = 1;
    const v1Entry = manifest.entityContexts.agents!.entities.alpha!;
    const v1Filenames = Object.keys(v1Entry); // e.g. ['AGENT.md']
    // Cast through unknown — the WRITTEN type is v2-only, but a real old file
    // carries the array shape, and the read boundary must tolerate it.
    (manifest.entityContexts.agents!.entities as Record<string, unknown>).alpha = v1Filenames;
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    // (1) Cleanup path: entityFileNames must still return the bare filename list
    // off the v1 entry, so orphan detection keeps working for stale manifests.
    const reread = readManifest(outputDir)!;
    const rawEntry = (
      reread.entityContexts.agents!.entities as Record<
        string,
        Parameters<typeof entityFileNames>[0]
      >
    ).alpha!;
    expect(Array.isArray(rawEntry)).toBe(true); // it really is a string[] on disk
    expect(entityFileNames(rawEntry)).toEqual(v1Filenames);

    // (2) Reverse-sync path: an external edit to the file must NOT crash (the v1
    // entry is an array, not a Record) and must be treated as no-baseline (skipped),
    // leaving the DB untouched.
    writeFileSync(join(outputDir, 'agents', 'alpha', 'AGENT.md'), '# Hacked\n**Role:** Intruder\n');

    const result = await db.reconcile(outputDir);
    expect(result.reverseSync).not.toBeNull();
    expect(result.reverseSync!.filesChanged).toBe(0); // v1 entry skipped, never mis-read
    expect(result.reverseSync!.conflicts).toEqual([]); // no false conflict either
    expect(result.reverseSync!.errors).toEqual([]); // no crash from treating array as Record
    expect((await db.get('agents', 'a1'))?.name).toBe('Alpha');
    expect((await db.get('agents', 'a1'))?.role).toBe('Scout');

    // The reconcile re-render regenerates the manifest entry in the v2 (Record)
    // shape — the stale v1 entry is upgraded automatically, not left forever.
    const after = readManifest(outputDir)!;
    expect(after.version).toBe(2);
    const upgraded = after.entityContexts.agents!.entities.alpha!;
    expect(Array.isArray(upgraded)).toBe(false);
    expect(typeof (upgraded as Record<string, { hash: string }>)['AGENT.md'].hash).toBe('string');

    db.close();
  });

  // --- Multi-field update in a single file ---

  it('applies multiple updates from a single file change', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', {
      id: 'a1',
      name: 'Alpha',
      slug: 'alpha',
      role: 'Scout',
      soul: 'Original soul text',
    });

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

    const entityEntry = manifest!.entityContexts.agents!.entities.alpha;
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

describe('reverse-sync — optimistic-concurrency conflict gate', () => {
  it('rejects a file edit (reports a conflict) when the DB row changed since render — never clobbers the concurrent change', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha', role: 'Scout' });

    // Render → the manifest captures the row's version (Alpha/Scout) + file hash.
    await db.reconcile(outputDir);

    // A concurrent DB/cloud edit changes the SAME field the file round-trips.
    await db.update('agents', 'a1', { role: 'CloudRole' });

    // Meanwhile an external file edit sets a different, stale-based role.
    const agentFile = join(outputDir, 'agents', 'alpha', 'AGENT.md');
    writeFileSync(agentFile, '# Alpha\n**Role:** FileRole\n');

    // Reverse-sync must detect the row changed since render and REJECT the file
    // write (report a conflict) instead of silently overwriting the cloud change.
    const result = await db.reconcile(outputDir);

    expect(result.reverseSync).not.toBeNull();
    expect(result.reverseSync!.filesChanged).toBe(1); // the file did change on disk
    expect(result.reverseSync!.updatesApplied).toBe(0); // ...but nothing was applied
    expect(result.reverseSync!.conflicts.length).toBe(1);
    expect(result.reverseSync!.conflicts[0]).toMatchObject({
      table: 'agents',
      slug: 'alpha',
      filename: 'AGENT.md',
    });

    // The concurrent DB change survived — NOT clobbered by the rejected file edit.
    const row = await db.get('agents', 'a1');
    expect(row?.role).toBe('CloudRole');

    db.close();
  });

  it('applies a file edit normally when the DB row is unchanged since render (no false conflict)', async () => {
    const { db, outputDir } = await setupDb();

    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha', role: 'Scout' });
    await db.reconcile(outputDir);

    // Only the file is edited; the DB row is untouched since the render.
    const agentFile = join(outputDir, 'agents', 'alpha', 'AGENT.md');
    writeFileSync(agentFile, '# Alpha\n**Role:** Commander\n');

    const result = await db.reconcile(outputDir);

    expect(result.reverseSync!.conflicts.length).toBe(0);
    expect(result.reverseSync!.updatesApplied).toBe(1); // role applied, no conflict
    const row = await db.get('agents', 'a1');
    expect(row?.role).toBe('Commander');

    db.close();
  });

  it('redacts computed columns from reverse-sync (immutable — recomputed, never written back)', async () => {
    const outputDir = tempDir();
    const db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', slug: 'TEXT', body: 'TEXT' },
      computed: {
        body_len: { deps: ['body'], compute: (r) => String(r.body ?? '').length, type: 'INTEGER' },
      },
      render: (rows) => rows.map((r) => `- ${r.id as string}`).join('\n'),
      outputFile: 'notes.md',
    });
    db.defineEntityContext('notes', {
      slug: (r) => r.slug as string,
      directoryRoot: 'notes',
      files: {
        'NOTE.md': {
          source: { type: 'self' },
          render: ([r]) =>
            `Body: ${(r?.body as string) ?? ''}\nLen: ${String(r?.body_len ?? '')}\n`,
          reverseSync: (content: string, row: import('../../src/types.js').Row) => {
            const updates: import('../../src/schema/entity-context.js').ReverseSyncUpdate[] = [];
            const bodyM = /^Body: (.*)$/m.exec(content);
            if (bodyM && bodyM[1] !== row.body) {
              updates.push({ table: 'notes', pk: { id: row.id }, set: { body: bodyM[1] } });
            }
            const lenM = /^Len: (.*)$/m.exec(content);
            if (lenM) {
              // A (mischievous) attempt to write the computed column directly.
              updates.push({
                table: 'notes',
                pk: { id: row.id },
                set: { body_len: Number(lenM[1]) },
              });
            }
            return updates;
          },
        },
      },
    });
    await db.init();
    await db.insert('notes', { id: 'n1', slug: 'n1', body: 'hello' }); // body_len computed = 5
    await db.reconcile(outputDir);

    const file = join(outputDir, 'notes', 'n1', 'NOTE.md');
    // Edit ONLY the computed Len to a bogus value; leave Body unchanged.
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^Len: .*$/m, 'Len: 999'));
    await db.reconcile(outputDir);

    // The body_len write-back was redacted (computed/immutable) → it stays the
    // value derived from `body` (5), not the edited 999.
    expect(Number((await db.get('notes', 'n1'))!.body_len)).toBe(5);
    db.close();
  });
});
