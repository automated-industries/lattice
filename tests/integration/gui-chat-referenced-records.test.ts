/**
 * C/E — the assistant resolves what the user is referring to in CODE, not by
 * prompt nudging: the record they're VIEWING (activeContext) and any record they
 * pasted a LOCAL GUI LINK to (`#/fs/<table>/<id>`) are fetched (RLS-gated get_row)
 * and their actual data returned, so "this card" and an in-system URL resolve to
 * the concrete record. Unknown tables / absent rows are skipped, never guessed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { resolveReferencedRecords } from '../../src/gui/ai/chat.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(): Promise<DispatchCtx> {
  const outputDir = mkdtempSync(join(tmpdir(), 'lattice-refrec-'));
  dirs.push(outputDir);
  const db = new Lattice(':memory:');
  db.define('aliases', {
    columns: { id: 'TEXT PRIMARY KEY', alias_text: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'aliases.md',
  });
  await db.init();
  await db.insert('aliases', { id: 'al1', alias_text: 'Example Translation Services' });
  return {
    db,
    feed: new FeedBus(),
    validTables: new Set(['aliases']),
    junctionTables: new Set(),
    softDeletable: new Set(['aliases']),
    outputDir,
  };
}

describe('resolveReferencedRecords (deterministic in-system reference resolution)', () => {
  it('resolves the actively-viewed record to its real data', async () => {
    const ctx = await setup();
    const out = await resolveReferencedRecords(ctx, 'update this card', {
      table: 'aliases',
      id: 'al1',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ table: 'aliases', id: 'al1' });
    expect(JSON.stringify(out[0]!.data)).toContain('Example Translation Services');
  });

  it('resolves a pasted LOCAL GUI url (#/fs/<table>/<id>) to the record — no web fetch', async () => {
    const ctx = await setup();
    const msg = 'please refresh http://127.0.0.1:4317/#/fs/aliases/al1 from the website';
    const out = await resolveReferencedRecords(ctx, msg);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ table: 'aliases', id: 'al1' });
    expect(JSON.stringify(out[0]!.data)).toContain('Example Translation Services');
  });

  it('dedupes the viewed record and a link to the same record', async () => {
    const ctx = await setup();
    const out = await resolveReferencedRecords(ctx, 'http://127.0.0.1:4317/#/fs/aliases/al1', {
      table: 'aliases',
      id: 'al1',
    });
    expect(out).toHaveLength(1);
  });

  it('skips an unknown table and an absent row (never guesses)', async () => {
    const ctx = await setup();
    const out = await resolveReferencedRecords(
      ctx,
      'look at http://127.0.0.1:4317/#/fs/evil/x and http://127.0.0.1:4317/#/fs/aliases/missing',
      { table: 'aliases', id: 'al1' },
    );
    // Only the visible, existing active record resolves.
    expect(out.map((r) => r.id)).toEqual(['al1']);
  });
});
