import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import type { ReverseSyncUpdate } from '../../src/schema/entity-context.js';
import { createFileLoopbackWatcher } from '../../src/gui/file-watcher.js';
import { FeedBus } from '../../src/gui/feed.js';

const tmpDirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-loopback-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// An entity context whose files have NO hand-written reverseSync — exercising the
// default frontmatter + body derivation the GUI loopback relies on.
async function setupDb(): Promise<{ db: Lattice; outputDir: string }> {
  const outputDir = tempDir();
  const db = new Lattice(':memory:');
  db.define('agents', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      slug: 'TEXT NOT NULL',
      role: 'TEXT',
      status: 'TEXT',
    },
    changelog: true, // a file edit must be recorded as a versioned change
    render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
    outputFile: 'agents.md',
  });
  db.defineEntityContext('agents', {
    slug: (r) => r.slug as string,
    directoryRoot: 'agents',
    files: {
      // Frontmatter (role/status) + a free-form body — round-trippable via the default derivation.
      'AGENT.md': {
        source: { type: 'self' },
        render: ([r]) =>
          `---\nrole: ${(r?.role as string) ?? ''}\nstatus: ${(r?.status as string) ?? ''}\n---\n\n# ${(r?.name as string) ?? ''}\n`,
      },
      // Pure free-form prose, no structured fields — NOT round-trippable.
      'NOTES.md': {
        source: { type: 'self' },
        render: ([r]) => `# ${(r?.name as string) ?? ''}\n\nFree-form notes about this agent.\n`,
      },
    },
  });
  await db.init();
  return { db, outputDir };
}

describe('file loopback (default derivation → changelog-aware apply)', () => {
  it('captures a frontmatter edit into the DB as a versioned change', async () => {
    const { db, outputDir } = await setupDb();
    await db.insert('agents', {
      id: 'a1',
      name: 'Alpha',
      slug: 'alpha',
      role: 'Scout',
      status: 'active',
    });
    await db.reconcile(outputDir); // render + manifest

    const agentFile = join(outputDir, 'agents', 'alpha', 'AGENT.md');
    const original = readFileSync(agentFile, 'utf8');
    expect(original).toContain('role: Scout');

    // Edit the rendered file on disk (as the user would in their editor).
    writeFileSync(agentFile, original.replace('role: Scout', 'role: Commander'));

    const applied: ReverseSyncUpdate[] = [];
    const result = await db.reverseSyncFromFiles(outputDir, {
      useDefault: true,
      apply: async (u) => {
        applied.push(u);
        await db.update(u.table, u.pk, u.set, { reason: 'file-edit' });
      },
    });

    expect(result.filesChanged).toBeGreaterThan(0);
    expect(result.updatesApplied).toBe(1);
    expect(applied).toEqual([{ table: 'agents', pk: { id: 'a1' }, set: { role: 'Commander' } }]);

    const row = await db.get('agents', 'a1');
    expect(row?.role).toBe('Commander');

    // The change is version-controlled — recorded in the changelog like a GUI edit.
    const history = await db.history('agents', 'a1');
    expect(history.length).toBeGreaterThan(0);
    db.close();
  });

  it('suppresses render echoes (a re-rendered file is not re-ingested)', async () => {
    const { db, outputDir } = await setupDb();
    await db.insert('agents', {
      id: 'a1',
      name: 'Alpha',
      slug: 'alpha',
      role: 'Scout',
      status: 'active',
    });
    await db.reconcile(outputDir);

    // No on-disk edit — the files match the manifest, so nothing should change.
    const result = await db.reverseSyncFromFiles(outputDir, {
      useDefault: true,
      apply: () => {
        throw new Error('apply must not be called when nothing changed');
      },
    });
    expect(result.filesChanged).toBe(0);
    expect(result.updatesApplied).toBe(0);
    db.close();
  });

  it('skips a non-round-trippable file (free-form prose) without corrupting the row', async () => {
    const { db, outputDir } = await setupDb();
    await db.insert('agents', {
      id: 'a1',
      name: 'Alpha',
      slug: 'alpha',
      role: 'Scout',
      status: 'active',
    });
    await db.reconcile(outputDir);

    const notesFile = join(outputDir, 'agents', 'alpha', 'NOTES.md');
    writeFileSync(notesFile, '# Alpha\n\nA completely rewritten free-form note with no fields.\n');

    const skipped: string[] = [];
    const result = await db.reverseSyncFromFiles(outputDir, {
      useDefault: true,
      apply: () => {
        throw new Error('must not write from a free-form prose edit');
      },
      onSkip: (info) => skipped.push(info.filename),
    });

    expect(result.filesChanged).toBeGreaterThan(0); // the file did change on disk
    expect(result.updatesApplied).toBe(0); // but nothing was written
    expect(skipped).toContain('NOTES.md'); // and it was surfaced, not silently dropped

    const row = await db.get('agents', 'a1');
    expect(row?.name).toBe('Alpha'); // row untouched
    db.close();
  });

  it('does NOT flood the activity feed when a custom/computed-render file is skipped', async () => {
    const { db, outputDir } = await setupDb();
    await db.insert('agents', {
      id: 'a1',
      name: 'Alpha',
      slug: 'alpha',
      role: 'Scout',
      status: 'active',
    });
    await db.reconcile(outputDir);

    // Rewrite the free-form (non-round-trippable) file so a reverse-sync pass
    // flags it as changed-but-unimportable.
    const notesFile = join(outputDir, 'agents', 'alpha', 'NOTES.md');
    writeFileSync(notesFile, '# Alpha\n\nRewritten free-form prose, no fields.\n');

    const events: { summary?: string }[] = [];
    const feed = new FeedBus();
    feed.subscribe((e) => events.push(e as { summary?: string }));
    const watcher = createFileLoopbackWatcher({
      db,
      feed,
      softDeletable: new Set<string>(),
      outputDir,
    });
    await watcher.flush(); // one reverse-sync pass, synchronously
    watcher.stop();

    // The skip is an expected, non-actionable condition (the render owns the
    // file) — it must NOT surface in the activity feed, which it flooded with a
    // duplicate "not auto-importable" notice on every pass.
    expect(events.some((e) => (e.summary ?? '').includes('not auto-importable'))).toBe(false);
    db.close();
  });
});
