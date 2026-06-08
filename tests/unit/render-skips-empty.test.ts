import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';

// renderSkipsEmpty: opt-in option that skips the full-table read AND the file
// write for tables registered without a `render` spec (they compile to a no-op
// that would only emit an empty `.schema-only/<table>.md`). Default off must
// preserve the original behavior exactly.

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function makeDb(opts?: {
  renderSkipsEmpty?: boolean;
}): Promise<{ db: Lattice; out: string }> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-rse-'));
  dirs.push(base);
  const db = new Lattice(join(base, 'test.db'), { renderSkipsEmpty: opts?.renderSkipsEmpty });
  // Table WITH a render spec → renders normally.
  db.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
    render: (rows) => rows.map((r) => `- ${String(r.body)}`).join('\n'),
    outputFile: 'NOTES.md',
  });
  // Spec-less table → no-op render → empty .schema-only/note_tags.md.
  db.define('note_tags', {
    columns: { note_id: 'TEXT', tag: 'TEXT' },
  });
  await db.init();
  return { db, out: join(base, 'context') };
}

const scannedTables = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  spy.mock.calls.map((c) => c[1] as string);

describe('renderSkipsEmpty', () => {
  it('default (off): spec-less table is still scanned and writes an empty schema-only file', async () => {
    const { db, out } = await makeDb();
    await db.insert('notes', { id: 'n1', body: 'hi' });
    const spy = vi.spyOn(
      (db as unknown as { _schema: { queryTable: () => unknown } })._schema,
      'queryTable',
    );

    await db.render(out);

    expect(existsSync(join(out, 'NOTES.md'))).toBe(true); // real render written
    expect(existsSync(join(out, '.schema-only', 'note_tags.md'))).toBe(true); // empty file still written
    expect(scannedTables(spy)).toContain('note_tags'); // and it WAS scanned
    db.close();
  });

  it('on: spec-less table is neither scanned nor written; tables with a render spec are unaffected', async () => {
    const { db, out } = await makeDb({ renderSkipsEmpty: true });
    await db.insert('notes', { id: 'n1', body: 'hi' });
    const spy = vi.spyOn(
      (db as unknown as { _schema: { queryTable: () => unknown } })._schema,
      'queryTable',
    );

    await db.render(out);

    expect(existsSync(join(out, 'NOTES.md'))).toBe(true); // real render unaffected
    expect(existsSync(join(out, '.schema-only', 'note_tags.md'))).toBe(false); // skipped
    const scanned = scannedTables(spy);
    expect(scanned).toContain('notes'); // real table still scanned
    expect(scanned).not.toContain('note_tags'); // full-table scan avoided
    db.close();
  });
});
