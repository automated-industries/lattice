/**
 * WS8a — the assistant's `get_row_context` tool reads a row's RENDERED context
 * (the organized, pre-joined markdown Lattice produced) instead of re-deriving it
 * from raw DB reads, and cleanly falls back when nothing is rendered yet.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { executeFunction, type DispatchCtx } from '../../src/gui/ai/dispatch.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-grc-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(): Promise<{ db: Lattice; ctx: DispatchCtx; outputDir: string }> {
  const outputDir = tempDir();
  const db = new Lattice(':memory:');
  db.define('agents', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      slug: 'TEXT NOT NULL',
      role: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: (rows) => rows.map((r) => `- ${r.name as string}`).join('\n'),
    outputFile: 'agents.md',
  });
  db.defineEntityContext('agents', {
    slug: (r) => r.slug as string,
    directoryRoot: 'agents',
    files: {
      'AGENT.md': {
        source: { type: 'self' },
        render: ([r]) => `# ${(r?.name as string) ?? ''}\n\nrole: ${(r?.role as string) ?? ''}\n`,
      },
    },
  });
  await db.init();
  await db.insert('agents', { id: 'a1', name: 'Alpha', slug: 'alpha', role: 'Scout' });
  await db.reconcile(outputDir); // render the entity context tree
  const ctx: DispatchCtx = {
    db,
    feed: new FeedBus(),
    validTables: new Set(['agents']),
    junctionTables: new Set(),
    softDeletable: new Set(['agents']),
    outputDir,
  };
  return { db, ctx, outputDir };
}

describe('get_row_context tool', () => {
  it('returns the rendered context files for a row', async () => {
    const { db, ctx } = await setup();
    const res = await executeFunction(ctx, 'get_row_context', { table: 'agents', id: 'a1' });
    expect(res.ok).toBe(true);
    const files = (res.result as { files: { name: string; content: string }[] }).files;
    expect(files.some((f) => f.name === 'AGENT.md' && f.content.includes('# Alpha'))).toBe(true);
    db.close();
  });

  it('reports no rendered context (so the model falls back to get_row) when unrendered', async () => {
    const { db, ctx } = await setup();
    // Added after the reconcile above → no rendered directory for 'beta'.
    await db.insert('agents', { id: 'a2', name: 'Beta', slug: 'beta', role: 'X' });
    const res = await executeFunction(ctx, 'get_row_context', { table: 'agents', id: 'a2' });
    expect(res.ok).toBe(false);
    db.close();
  });

  it('errors on a missing row', async () => {
    const { db, ctx } = await setup();
    const res = await executeFunction(ctx, 'get_row_context', { table: 'agents', id: 'nope' });
    expect(res.ok).toBe(false);
    db.close();
  });
});
