import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';
import { readManifest } from '../../src/lifecycle/manifest.js';

/**
 * NON-REGRESSION LOCK — render ↔ DB equivalence.
 *
 * This test PASSES on the current code and must keep passing after the
 * data-safety fix. It does NOT demonstrate the fix; it locks the invariant
 * that the committed manifest and the on-disk tree exactly describe the set of
 * non-deleted rows (no missing entity, no ghost entity) so the surgical change
 * cannot silently regress the steady-state contract.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeDb(base: string): Lattice {
  const db = new Lattice(join(base, 'db.sqlite'));
  db.define('agents', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', role: 'TEXT' },
    render: () => '',
    outputFile: '.schema-only/agents.md',
  });
  db.defineEntityContext('agents', {
    slug: (r) => String(r.name),
    files: {
      'AGENT.md': {
        source: { type: 'self' },
        render: ([r]) => `# ${String(r?.name)}\n\nRole: ${String(r?.role)}\n`,
      },
    },
  });
  return db;
}

describe('render ↔ DB equivalence (non-regression lock)', () => {
  it('committed manifest + on-disk tree enumerate exactly the non-deleted slugs', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-eq-'));
    dirs.push(base);
    const db = makeDb(base);
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'alpha', role: 'eng' });
    await db.insert('agents', { id: 'a2', name: 'beta', role: 'qa' });
    await db.insert('agents', { id: 'a3', name: 'gamma', role: 'pm' });

    const out = join(base, 'ctx');
    await db.render(out);

    const manifest = readManifest(out);
    expect(manifest).not.toBeNull();
    const entry = manifest!.entityContexts.agents;
    expect(entry).toBeDefined();

    // (1) manifest enumerates EXACTLY the 3 non-deleted slugs — no missing, no ghost.
    const manifestSlugs = Object.keys(entry!.entities).sort();
    expect(manifestSlugs).toEqual(['alpha', 'beta', 'gamma']);

    // (2) every manifest-listed file exists on disk and matches the DB row.
    const rows = await db.query('agents', {});
    const roleBySlug = new Map(rows.map((r) => [String(r.name), String(r.role)]));
    for (const slug of manifestSlugs) {
      const file = join(out, entry!.directoryRoot, slug, 'AGENT.md');
      expect(existsSync(file)).toBe(true);
      const content = readFileSync(file, 'utf8');
      expect(content).toContain(`# ${slug}`);
      expect(content).toContain(`Role: ${roleBySlug.get(slug)}`);
    }

    // (3) no on-disk entity dir is absent from the manifest (no ghost dirs).
    const rootDir = join(out, entry!.directoryRoot);
    const onDisk = readdirSync(rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(onDisk).toEqual(manifestSlugs);

    db.close();
  });

  it('delete + reconcile drops the deleted slug from both manifest and tree', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-eq-del-'));
    dirs.push(base);
    const db = makeDb(base);
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'alpha', role: 'eng' });
    await db.insert('agents', { id: 'a2', name: 'beta', role: 'qa' });
    await db.insert('agents', { id: 'a3', name: 'gamma', role: 'pm' });

    const out = join(base, 'ctx');
    await db.reconcile(out);

    // delete one row, then reconcile (render + cleanup against prior manifest).
    await db.delete('agents', 'a2');
    await db.reconcile(out);

    const manifest = readManifest(out);
    const entry = manifest!.entityContexts.agents;
    const manifestSlugs = Object.keys(entry!.entities).sort();
    expect(manifestSlugs).toEqual(['alpha', 'gamma']);

    // The deleted slug's dir is pruned from disk.
    const rootDir = join(out, entry!.directoryRoot);
    const onDisk = readdirSync(rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(onDisk).toEqual(['alpha', 'gamma']);
    expect(existsSync(join(rootDir, 'beta'))).toBe(false);

    db.close();
  });
});
