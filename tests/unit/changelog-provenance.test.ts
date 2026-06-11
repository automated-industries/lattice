/**
 * Stage-0 confused-deputy guard: a DERIVED write (e.g. an AI enrichment computed
 * from source files) must record the source-set that produced it, instead of
 * discarding it and writing an unstamped value into shared ground truth. This
 * checks the provenance threads from `update()` into `__lattice_changelog` and
 * back out through `history()` / `recentChanges()` — and that a plain edit still
 * records nothing extra (no behavior change).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

let db: Lattice | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

async function openNotes(): Promise<Lattice> {
  const d = new Lattice(':memory:');
  d.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
    changelog: true,
    render: () => '',
    outputFile: 'notes.md',
  });
  await d.init();
  return d;
}

describe('changelog provenance (Stage-0)', () => {
  it('records the source-set + change_kind on a derived update', async () => {
    db = await openNotes();
    await db.insert('notes', { id: 'n1', body: 'thin' });
    await db.update(
      'notes',
      'n1',
      { body: 'a fuller body synthesized from two files' },
      { sourceRef: ['file-a', 'file-b'], changeKind: 'derived' },
    );

    const hist = await db.history('notes', 'n1');
    const derived = hist.find((h) => h.operation === 'update');
    expect(derived).toBeDefined();
    expect(derived?.sourceRef).toEqual(['file-a', 'file-b']);
    expect(derived?.changeKind).toBe('derived');
  });

  it('a plain edit records no provenance (no behavior change)', async () => {
    db = await openNotes();
    await db.insert('notes', { id: 'n2', body: 'one' });
    await db.update('notes', 'n2', { body: 'two' });

    const hist = await db.history('notes', 'n2');
    const edit = hist.find((h) => h.operation === 'update');
    expect(edit).toBeDefined();
    expect(edit?.sourceRef ?? null).toBeNull();
    expect(edit?.changeKind ?? null).toBeNull();
  });

  it('normalizes a single source ref to an array', async () => {
    db = await openNotes();
    await db.insert('notes', { id: 'n3', body: 'x' });
    await db.update('notes', 'n3', { body: 'y' }, { sourceRef: 'only-source' });
    const hist = await db.history('notes', 'n3');
    expect(hist.find((h) => h.operation === 'update')?.sourceRef).toEqual(['only-source']);
  });
});
