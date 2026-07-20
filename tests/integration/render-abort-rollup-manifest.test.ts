import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';
import { readManifest } from '../../src/lifecycle/manifest.js';
import { contentHash } from '../../src/render/writer.js';

/**
 * ABORT-CONSISTENT ROLLUP MANIFEST.
 *
 * A table ROLLUP is written per-table in phase 1 as a COMPLETE atomic file, but the
 * manifest that records its hash is written last (the deliberate "commit point"). If a
 * render is aborted (a superseding render cancels it) after writing a rollup but before
 * that final manifest write, the file gets AHEAD of the manifest — and the next render
 * would compare the on-disk bytes against a STALE manifest hash and mis-report its own
 * atomic write as a hand edit ("… was edited on disk, but table rollups are generated
 * files").
 *
 * The fix: an aborted render flushes the rollup hashes it wrote into the manifest, so a
 * superseding render's baseline is the true on-disk bytes. This test drives an abort
 * right after a rollup is written and asserts the manifest hash equals the on-disk hash
 * (which is exactly what makes the false notice impossible on the next render).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeDb(base: string): Lattice {
  const db = new Lattice(join(base, 'db.sqlite'));
  // Two rollup tables whose content REFLECTS their rows, so adding a row genuinely
  // changes the rollup bytes (an empty render would never exercise the notice).
  for (const t of ['agents', 'tasks']) {
    db.define(t, {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: (rows) => rows.map((r) => String(r.name)).join('\n') + '\n',
      outputFile: `.schema-only/${t}.md`,
    });
    db.defineEntityContext(t, {
      slug: (r) => String(r.name),
      files: { 'ITEM.md': { source: { type: 'self' }, render: ([r]) => `# ${String(r?.name)}\n` } },
    });
  }
  return db;
}

describe('aborted render keeps the rollup manifest consistent with disk', () => {
  it('records the rollups an aborted pass wrote, so the next render sees no divergence', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-abort-rollup-'));
    dirs.push(base);
    const dir = join(base, 'out');
    const db = makeDb(base);
    await db.init();

    // Baseline render → manifest records each rollup's hash.
    await db.insert('agents', { id: 'a1', name: 'Ada' });
    await db.insert('tasks', { id: 't1', title: 'T1', name: 'T1' });
    await db.render(dir);

    // Change BOTH rollups, then render but abort right after the first rollup is written
    // (its phase-1 `table-done`). The next per-table abort check bails with the partial
    // pass — which must still flush the rollup it wrote.
    await db.insert('agents', { id: 'a2', name: 'Bob' });
    await db.insert('tasks', { id: 't2', title: 'T2', name: 'T2' });
    const ctrl = new AbortController();
    let abortedTable: string | null = null;
    await db.render(dir, {
      signal: ctrl.signal,
      onProgress: (e) => {
        if (e.kind === 'table-done' && e.table && !abortedTable) {
          abortedTable = e.table;
          ctrl.abort();
        }
      },
    });
    expect(abortedTable).toBeTruthy();

    // The manifest now records the rollup the aborted render actually wrote: its recorded
    // hash equals the on-disk bytes. That is precisely what makes the "edited on disk"
    // notice impossible on the next render (onDisk === priorRollup.hash).
    const man = readManifest(dir);
    expect(man).toBeTruthy();
    const t = abortedTable as unknown as string;
    const entry = man?.tableFiles?.[t];
    expect(entry).toBeTruthy();
    const onDisk = contentHash(readFileSync(join(dir, entry!.path), 'utf8'));
    expect(entry!.hash).toBe(onDisk);

    // And a subsequent COMPLETE render finishes cleanly; every rollup's manifest hash
    // matches its on-disk bytes (no lingering divergence to false-flag).
    await db.render(dir);
    const man2 = readManifest(dir);
    for (const tbl of ['agents', 'tasks']) {
      const e2 = man2?.tableFiles?.[tbl];
      expect(e2).toBeTruthy();
      expect(e2!.hash).toBe(contentHash(readFileSync(join(dir, e2!.path), 'utf8')));
    }
    db.close();
  });
});
