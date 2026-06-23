/**
 * Two render-layer fixes that make the symmetric-junction render look correct on
 * real data:
 *
 *  - SLUG UNIQUENESS: two entity rows whose `slug` function returns the SAME base
 *    value used to write to the SAME directory — one clobbered the other, so a row
 *    that exists in the DB never got its own rendered context. The render loop now
 *    disambiguates colliding slugs DETERMINISTICALLY (PK-derived suffix), so both
 *    rows get distinct, STABLE directories while a unique slug stays untouched.
 *
 *  - COLLAPSED-CONTEXT CLEANUP: when a table stops being an entity context (e.g. a
 *    junction collapses into a relation and is dropped from getEntityContexts()),
 *    cleanup never visited its directory tree, leaving it orphaned forever. Cleanup
 *    now sweeps a table that was an entity context in the PRIOR manifest but is no
 *    longer one — using the prior manifest as the record of what Lattice managed,
 *    so it never touches a directory Lattice didn't create.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';
import { cleanupEntityContexts } from '../../src/lifecycle/cleanup.js';
import type { LatticeManifest } from '../../src/lifecycle/manifest.js';
import type { EntityContextDefinition } from '../../src/schema/entity-context.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// Reach the live entity-context registry so a test can simulate a junction
// collapsing (the table is dropped from getEntityContexts()).
function entityContexts(db: Lattice): Map<string, EntityContextDefinition> {
  return (
    db as unknown as { _schema: { getEntityContexts(): Map<string, EntityContextDefinition> } }
  )._schema.getEntityContexts();
}

describe('slug uniqueness (BUG B)', () => {
  it('two rows with the SAME base slug each get their own distinct directory with content', async () => {
    const base = tmp('lattice-slugb-');
    const out = join(base, 'context');
    const db = new Lattice(join(base, 'test.db'));
    db.define('meetings', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT NOT NULL', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/meetings.md',
    });
    db.defineEntityContext('meetings', {
      // Deliberately collision-prone slug: both rows share the same title.
      slug: (r) => r.title as string,
      directoryRoot: 'Meeting',
      files: {
        'MEETING.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r.title as string}\nid: ${r.id as string}`,
        },
      },
    });
    await db.init();

    await db.insert('meetings', { id: 'aaaa1111-0000-0000-0000-000000000000', title: 'Interview' });
    await db.insert('meetings', { id: 'bbbb2222-0000-0000-0000-000000000000', title: 'Interview' });
    await db.insert('meetings', { id: 'cccc3333-0000-0000-0000-000000000000', title: 'Standup' });

    await db.render(out);

    const root = join(out, 'Meeting');
    const subdirs = readdirSync(root)
      .filter((n) => existsSync(join(root, n, 'MEETING.md')))
      .sort();

    // The unique-slug row keeps its plain slug.
    expect(subdirs).toContain('Standup');

    // The two colliding rows each get their OWN directory (no clobber): the base
    // "Interview" was used by 2 rows, so both are disambiguated with a PK suffix.
    const interviewDirs = subdirs.filter((n) => n.startsWith('Interview-'));
    expect(interviewDirs).toHaveLength(2);

    // Both colliding directories have real, DISTINCT content (one per row's id).
    const contents = interviewDirs.map((d) => readFileSync(join(root, d, 'MEETING.md'), 'utf8'));
    expect(contents[0]).not.toBe(contents[1]);
    expect(contents.some((c) => c.includes('aaaa1111'))).toBe(true);
    expect(contents.some((c) => c.includes('bbbb2222'))).toBe(true);

    // Three rows in the DB → three rendered dirs (none silently dropped).
    expect(subdirs).toHaveLength(3);
    db.close();
  });

  it('disambiguation is STABLE across renders (same dirs both times, no churn)', async () => {
    const base = tmp('lattice-slugb-stable-');
    const out = join(base, 'context');
    const db = new Lattice(join(base, 'test.db'));
    db.define('meetings', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT NOT NULL', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/meetings.md',
    });
    db.defineEntityContext('meetings', {
      slug: (r) => r.title as string,
      directoryRoot: 'Meeting',
      files: {
        'MEETING.md': { source: { type: 'self' }, render: ([r]) => `# ${r.title as string}` },
      },
    });
    await db.init();
    await db.insert('meetings', { id: 'aaaa1111-x', title: 'Interview' });
    await db.insert('meetings', { id: 'bbbb2222-x', title: 'Interview' });

    await db.render(out);
    const root = join(out, 'Meeting');
    const firstPass = readdirSync(root).sort();

    // Re-render with the SAME data → identical directory set, no new/renamed dirs.
    await db.render(out);
    const secondPass = readdirSync(root).sort();
    expect(secondPass).toEqual(firstPass);

    // And reconcile (render + cleanup) must NOT prune the just-rendered dirs.
    const result = await db.reconcile(out);
    expect(result.cleanup.directoriesRemoved).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(firstPass);
    db.close();
  });
});

describe('collapsed entity-context cleanup (BUG A)', () => {
  it('removes Context/<X>/ when X stops being an entity context, leaving other tables untouched', async () => {
    const base = tmp('lattice-bugA-');
    const out = join(base, 'context');
    const db = new Lattice(join(base, 'test.db'));

    // A real entity context "links" (stands in for a junction that later collapses)
    // and a stable context "people" that must survive.
    db.define('links', {
      columns: { id: 'TEXT PRIMARY KEY', label: 'TEXT NOT NULL', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/links.md',
    });
    db.define('people', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/people.md',
    });
    db.defineEntityContext('links', {
      slug: (r) => r.id as string,
      directoryRoot: 'Contact_meeting',
      files: { 'LINK.md': { source: { type: 'self' }, render: ([r]) => `# ${r.label as string}` } },
    });
    db.defineEntityContext('people', {
      slug: (r) => r.name as string,
      directoryRoot: 'Person',
      files: {
        'PERSON.md': { source: { type: 'self' }, render: ([r]) => `# ${r.name as string}` },
      },
    });
    await db.init();

    await db.insert('links', { id: 'link-1', label: 'one' });
    await db.insert('links', { id: 'link-2', label: 'two' });
    await db.insert('people', { id: 'p-1', name: 'Ada' });

    // First reconcile: writes the Contact_meeting/ + Person/ trees and a manifest
    // that records both as managed entity contexts.
    await db.reconcile(out);
    expect(existsSync(join(out, 'Contact_meeting', 'link-1', 'LINK.md'))).toBe(true);
    expect(existsSync(join(out, 'Contact_meeting', 'link-2', 'LINK.md'))).toBe(true);
    expect(existsSync(join(out, 'Person', 'Ada', 'PERSON.md'))).toBe(true);

    // Simulate the junction collapsing: drop "links" from the entity-context set.
    // The prior manifest still records Contact_meeting/ as managed.
    entityContexts(db).delete('links');

    // Second reconcile: the collapsed table's tree must be swept; "people" untouched.
    const result = await db.reconcile(out);

    expect(existsSync(join(out, 'Contact_meeting', 'link-1'))).toBe(false);
    expect(existsSync(join(out, 'Contact_meeting', 'link-2'))).toBe(false);
    expect(existsSync(join(out, 'Contact_meeting'))).toBe(false); // empty root removed too
    // The surviving context is left completely alone.
    expect(existsSync(join(out, 'Person', 'Ada', 'PERSON.md'))).toBe(true);

    expect(result.cleanup.directoriesRemoved.some((p) => p.includes('link-1'))).toBe(true);
    expect(result.cleanup.directoriesRemoved.some((p) => p.includes('Person'))).toBe(false);
    db.close();
  });

  it('honors prior-manifest-only safety: a dir Lattice never managed is NOT removed', () => {
    const out = tmp('lattice-bugA-safety-');

    // Manifest records a COLLAPSED table "junction" that managed exactly ONE dir
    // (row-a) with one file. A sibling dir "row-untracked" and an unrelated
    // top-level dir "Untracked" were NEVER recorded → must be left alone.
    const managedRoot = join(out, 'Junction');
    mkdirSync(join(managedRoot, 'row-a'), { recursive: true });
    writeFileSync(join(managedRoot, 'row-a', 'J.md'), 'managed');
    mkdirSync(join(managedRoot, 'row-untracked'), { recursive: true });
    writeFileSync(join(managedRoot, 'row-untracked', 'J.md'), 'NOT managed');
    mkdirSync(join(out, 'Untracked'), { recursive: true });
    writeFileSync(join(out, 'Untracked', 'keep.md'), 'unrelated top-level dir');

    const manifest: LatticeManifest = {
      version: 2,
      generated_at: new Date().toISOString(),
      entityContexts: {
        junction: {
          directoryRoot: 'Junction',
          declaredFiles: ['J.md'],
          protectedFiles: [],
          entities: { 'row-a': { 'J.md': { hash: 'x' } } },
        },
      },
    };

    // Current entity-context set is EMPTY → "junction" collapsed.
    const result = cleanupEntityContexts(
      out,
      new Map(), // no current contexts
      new Map(), // no current slugs
      manifest,
    );

    // The one managed per-row dir is removed.
    expect(existsSync(join(managedRoot, 'row-a'))).toBe(false);
    // The dir Lattice never recorded survives — root not removed because it still
    // holds an unmanaged dir.
    expect(existsSync(join(managedRoot, 'row-untracked', 'J.md'))).toBe(true);
    expect(existsSync(managedRoot)).toBe(true);
    // The unrelated top-level dir is never touched.
    expect(existsSync(join(out, 'Untracked', 'keep.md'))).toBe(true);

    expect(result.directoriesRemoved.some((p) => p.endsWith(join('Junction', 'row-a')))).toBe(true);
    expect(result.directoriesRemoved.some((p) => p.includes('Untracked'))).toBe(false);
    expect(result.directoriesRemoved.some((p) => p.includes('row-untracked'))).toBe(false);
  });

  it('respects dryRun: reports the collapsed dirs as orphans without removing them', () => {
    const out = tmp('lattice-bugA-dryrun-');
    const root = join(out, 'Junction');
    mkdirSync(join(root, 'row-a'), { recursive: true });
    writeFileSync(join(root, 'row-a', 'J.md'), 'managed');

    const manifest: LatticeManifest = {
      version: 2,
      generated_at: new Date().toISOString(),
      entityContexts: {
        junction: {
          directoryRoot: 'Junction',
          declaredFiles: ['J.md'],
          protectedFiles: [],
          entities: { 'row-a': { 'J.md': { hash: 'x' } } },
        },
      },
    };

    const seen: string[] = [];
    const result = cleanupEntityContexts(out, new Map(), new Map(), manifest, {
      dryRun: true,
      onOrphan: (p) => seen.push(p),
    });

    // Nothing removed from disk in dryRun, but the orphans are reported.
    expect(existsSync(join(root, 'row-a', 'J.md'))).toBe(true);
    expect(result.filesRemoved.length + result.directoriesRemoved.length).toBeGreaterThan(0);
    expect(seen.some((p) => p.includes('row-a'))).toBe(true);
  });
});
