import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';
import type { RenderProgress } from '../../src/render/progress.js';

// ---------------------------------------------------------------------------
// #1 — the background render walks entity-context tables CONCURRENTLY (bounded),
// so several tables advance at once instead of strictly one-after-another. The
// per-table ProgressThrottle keeps each table's progress flowing independently.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function makeMultiTableDb(
  tables: string[],
  rowsPer: number,
): Promise<{ db: Lattice; out: string }> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-rc-'));
  dirs.push(base);
  const db = new Lattice(join(base, 'test.db'));
  for (const t of tables) {
    db.define(t, {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: () => '',
      outputFile: `.schema-only/${t}.md`,
    });
    db.defineEntityContext(t, {
      slug: (r) => r.id as string,
      directoryRoot: t,
      files: {
        'INDEX.md': { source: { type: 'self' }, render: (rs) => `# ${String(rs[0]?.name ?? '')}` },
      },
    });
  }
  await db.init();
  for (const t of tables) {
    for (let i = 0; i < rowsPer; i++) await db.insert(t, { id: `${t}${i}`, name: `${t} ${i}` });
  }
  return { db, out: join(base, 'context') };
}

function dirCount(out: string, table: string): number {
  const root = join(out, table);
  if (!existsSync(root)) return 0;
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
}

describe('background render — concurrent entity tables (#1)', () => {
  it('overlaps tables: several start before the first finishes', async () => {
    const tables = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const { db, out } = await makeMultiTableDb(tables, 8);
    const events: RenderProgress[] = [];
    await db.render(out, { onProgress: (e) => events.push(e) });

    // `table-start` is only emitted by the entity-context phase (phase 1/2 emit a
    // bare table-done with tableCount 0). The first ENTITY-context table-done is
    // the one with a real tableCount > 0.
    const firstDoneIdx = events.findIndex(
      (e) => e.kind === 'table-done' && (e.tableCount ?? 0) > 0,
    );
    expect(firstDoneIdx).toBeGreaterThan(0);

    const startedBeforeFirstDone = new Set(
      events
        .slice(0, firstDoneIdx)
        .filter((e) => e.kind === 'table-start')
        .map((e) => e.table),
    );
    // Sequential rendering would have exactly ONE table-start before the first
    // table-done; the bounded-concurrent fan-out overlaps several.
    expect(startedBeforeFirstDone.size).toBeGreaterThanOrEqual(2);

    // Correctness: every table fully rendered, one table-done each, one terminal done.
    for (const t of tables) expect(dirCount(out, t)).toBe(8);
    const entityDones = events.filter(
      (e) => e.kind === 'table-done' && (e.tableCount ?? 0) > 0 && tables.includes(e.table as string),
    );
    expect(entityDones).toHaveLength(tables.length);
    expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
    db.close();
  });

  it('concurrency does not drop or duplicate any table (every dir rendered)', async () => {
    const tables = ['one', 'two', 'three', 'four', 'five'];
    const { db, out } = await makeMultiTableDb(tables, 5);
    await db.render(out);
    for (const t of tables) expect(dirCount(out, t)).toBe(5);
    db.close();
  });
});
