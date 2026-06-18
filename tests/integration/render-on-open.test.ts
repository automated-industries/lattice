/**
 * Open/restart render staleness gate.
 *
 * The GUI re-renders the whole context tree on every open — a plain restart and a
 * version update both land in the same boot-time background render. When nothing
 * the tree depends on has changed, that full render is pure churn: it re-reads
 * every table off the wire (shared-quota egress) and paints per-table
 * "Rendering…%" overlays even though zero files change.
 *
 * `renderInBackground(dir, { gateOnOpen: true })` makes the open render
 * CONDITIONAL: it records a cursor in the manifest (a render-output template
 * version + the change-log / sharing-graph high-water marks, read through the
 * render's own scope) and, on the next open, SKIPS the render entirely when the
 * live cursor hasn't advanced. When the cursor is forced to render anyway, a
 * content-hash backstop suppresses per-table progress for tables whose bytes
 * didn't actually change.
 *
 * The gate FAILS OPEN: a missing/foreign manifest, a template-version mismatch,
 * or an unreadable cursor always renders. These tests prove (1) a no-change
 * restart skips with zero files written and zero per-table progress (and a true
 * skip, not an atomicWrite no-op — a tampered file is left untouched), (2) an
 * in-place edit on a table with NO `updated_at` still re-renders (the change-log
 * cursor catches what a count/maxMtime fingerprint would miss), (4) a
 * template-version mismatch renders, (5) a missing manifest renders.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readManifest,
  writeManifest,
  manifestPath,
  TEMPLATE_VERSION,
} from '../../src/lifecycle/manifest.js';
import type { RenderProgress } from '../../src/render/progress.js';

describe('render-on-open staleness gate', () => {
  let db: Lattice;
  let dir: string;
  const dirs: string[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-open-'));
    dirs.push(dir);
    db = new Lattice(':memory:');
    db.define('agents', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', slug: 'TEXT' },
      render: () => '',
      outputFile: '_agents.md',
    });
    // A table with NO updated_at column on purpose (case 2): an in-place edit here
    // is invisible to a COUNT(*)+MAX(updated_at) fingerprint, but the change-log
    // cursor must still catch it.
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', slug: 'TEXT' },
      changelog: true,
      render: () => '',
      outputFile: '_notes.md',
    });
    db.defineEntityContext('agents', {
      slug: (r) => r.slug as string,
      files: {
        'AGENT.md': { source: { type: 'self' }, render: ([a]) => `AGENT ${a?.name as string}` },
      },
    });
    db.defineEntityContext('notes', {
      slug: (r) => r.slug as string,
      files: {
        'NOTE.md': { source: { type: 'self' }, render: ([n]) => `NOTE ${n?.body as string}` },
      },
    });
    await db.init();
    await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha' });
    await db.insert('notes', { id: 'n1', body: 'first', slug: 'note-one' });
    // Initial full render writes the manifest + cursor.
    await db.renderInBackground(dir, { gateOnOpen: true });
  });

  afterEach(() => {
    db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  const agentFile = (): string => join(dir, 'agents/alpha/AGENT.md');
  const noteFile = (): string => join(dir, 'notes/note-one/NOTE.md');

  /** Collect every progress event of a render. */
  async function renderCollecting(opts: { gateOnOpen?: boolean } = {}): Promise<RenderProgress[]> {
    const events: RenderProgress[] = [];
    await db.renderInBackground(dir, {
      gateOnOpen: opts.gateOnOpen ?? true,
      onProgress: (e) => events.push(e),
    });
    return events;
  }

  it('case 1: restart with no data change skips — 0 files, only a terminal done', async () => {
    const events = await renderCollecting();
    // No per-table lifecycle at all — just the single terminal 'done'.
    const tableEvents = events.filter(
      (e) => e.kind === 'table-start' || e.kind === 'table-progress' || e.kind === 'table-done',
    );
    expect(tableEvents).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
  });

  it('case 1 (strengthened): a true SKIP does not overwrite a tampered on-disk file', async () => {
    // Tamper a rendered file. A real skip never reads/writes it, so the tamper
    // survives — proving the skip is not just an atomicWrite no-op (which WOULD
    // restore correct content because it still renders + compares).
    writeFileSync(agentFile(), 'TAMPERED-AGENT');
    const result = await db.renderInBackground(dir, { gateOnOpen: true });
    expect(result.filesWritten).toEqual([]);
    expect(readFileSync(agentFile(), 'utf8')).toBe('TAMPERED-AGENT');
  });

  it('case 2: in-place edit on a table with NO updated_at still re-renders that entity', async () => {
    // Mutate notes (no updated_at column). The change-log cursor advances, so the
    // gate must NOT skip — the note re-renders to its new body.
    writeFileSync(noteFile(), 'TAMPERED-NOTE');
    await db.update('notes', 'n1', { body: 'second' });
    const result = await db.renderInBackground(dir, { gateOnOpen: true });
    expect(readFileSync(noteFile(), 'utf8')).toContain('second'); // re-rendered, not skipped
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });

  it('case 4: a template-version mismatch in the manifest forces a full render', async () => {
    // Corrupt the recorded template version. The gate treats a mismatch as stale.
    const m = readManifest(dir);
    expect(m).not.toBeNull();
    if (m) {
      m.templateVersion = TEMPLATE_VERSION + 999;
      writeManifest(dir, m);
    }
    writeFileSync(agentFile(), 'TAMPERED-AGENT');
    const result = await db.renderInBackground(dir, { gateOnOpen: true });
    // Render ran (it re-wrote the tampered file back to correct content).
    expect(readFileSync(agentFile(), 'utf8')).toContain('AGENT Alpha');
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });

  it('case 5: a missing manifest forces a full render', async () => {
    rmSync(manifestPath(dir), { force: true });
    writeFileSync(agentFile(), 'TAMPERED-AGENT');
    const result = await db.renderInBackground(dir, { gateOnOpen: true });
    expect(readFileSync(agentFile(), 'utf8')).toContain('AGENT Alpha');
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });

  it('content-hash backstop: a forced render of an unchanged table emits no per-table progress', async () => {
    // Force the cursor to "render" by bumping ONLY the recorded changelog mark so
    // it looks stale, while the data is genuinely unchanged. The render runs but
    // the backstop must suppress per-table progress because every hash matches.
    const m = readManifest(dir);
    if (m?.cursor) {
      m.cursor.changelog = '00000000000000000000'; // lower than live → looks stale → renders
      writeManifest(dir, m);
    }
    const events = await renderCollecting();
    const tableEvents = events.filter(
      (e) => e.kind === 'table-start' || e.kind === 'table-progress' || e.kind === 'table-done',
    );
    // Data didn't change, so no table card should churn even though it rendered.
    expect(tableEvents).toHaveLength(0);
    // The on-disk tree is still correct.
    expect(existsSync(agentFile())).toBe(true);
    expect(readFileSync(agentFile(), 'utf8')).toContain('AGENT Alpha');
  });

  it('an explicit (non-gated) render is unaffected — it always re-renders', async () => {
    // The mutation/realtime path never sets gateOnOpen; a plain render() restores
    // a tampered file (proves the gate is opt-in, not global).
    writeFileSync(agentFile(), 'TAMPERED-AGENT');
    await db.render(dir);
    expect(readFileSync(agentFile(), 'utf8')).toContain('AGENT Alpha');
  });
});
