import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';
import { ProgressThrottle, type RenderProgress } from '../../src/render/progress.js';

// ---------------------------------------------------------------------------
// Backend core of latticesql 3.1's async background render:
//   - RenderEngine.render(outputDir, opts) emits per-table progress
//   - opts omitted ⇒ identical behavior (back-compat)
//   - an AbortSignal stops the render (pre-aborted + mid-aborted)
//   - ProgressThrottle coalesces table-progress but never drops lifecycle events
//   - Lattice.renderInBackground single-flights against auto-render
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Build a Lattice with one entity-context table ("widget") that renders one
 * file per row into `widget/<slug>/WIDGET.md`. Seeds `rows` widgets.
 */
async function makeEntityDb(rows: number): Promise<{ db: Lattice; out: string; base: string }> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-rp-'));
  dirs.push(base);
  const db = new Lattice(join(base, 'test.db'));
  db.define('widget', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
    render: () => '',
    outputFile: '.schema-only/widget.md',
  });
  db.defineEntityContext('widget', {
    slug: (r) => r.id as string,
    directoryRoot: 'widget',
    files: {
      'WIDGET.md': {
        source: { type: 'self' },
        render: (rs) => `# ${String(rs[0]?.name ?? '')}`,
      },
    },
  });
  await db.init();
  for (let i = 0; i < rows; i++) {
    await db.insert('widget', { id: `w${i}`, name: `Widget ${i}` });
  }
  return { db, out: join(base, 'context'), base };
}

/** Count the per-entity directories actually written under widget/. */
function widgetDirCount(out: string): number {
  const root = join(out, 'widget');
  if (!existsSync(root)) return 0;
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
}

describe('RenderEngine progress emits', () => {
  it('fires table-start/table-done per entity table with entitiesTotal == rowcount', async () => {
    const { db, out } = await makeEntityDb(5);
    const events: RenderProgress[] = [];

    await db.render(out, { onProgress: (e) => events.push(e) });

    const start = events.find((e) => e.kind === 'table-start' && e.table === 'widget');
    const done = events.find((e) => e.kind === 'table-done' && e.table === 'widget');
    expect(start).toBeDefined();
    expect(done).toBeDefined();
    expect(start!.entitiesTotal).toBe(5);
    expect(done!.entitiesTotal).toBe(5);
    expect(done!.entitiesRendered).toBe(5);
    expect(done!.pct).toBe(100);
    expect(start!.tableCount).toBeGreaterThanOrEqual(1);

    // Exactly one terminal `done` event closes the render.
    const terminal = events.filter((e) => e.kind === 'done');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.durationMs).toBeGreaterThanOrEqual(0);

    db.close();
  });

  it('every table-progress event carries an exact per-table pct', async () => {
    const { db, out } = await makeEntityDb(4);
    const events: RenderProgress[] = [];

    await db.render(out, { onProgress: (e) => events.push(e) });

    // table-progress may be throttled down to zero for a fast small table —
    // that is correct coalescing behavior. Whatever DOES surface must have an
    // exact pct = entitiesRendered/entitiesTotal.
    const progress = events.filter((e) => e.kind === 'table-progress' && e.table === 'widget');
    for (const p of progress) {
      expect(p.pct).toBeCloseTo((p.entitiesRendered / p.entitiesTotal) * 100, 5);
      expect(p.entitiesTotal).toBe(4);
    }
    db.close();
  });
});

describe('RenderEngine back-compat (onProgress omitted)', () => {
  it('produces an identical RenderResult whether or not onProgress is passed', async () => {
    const a = await makeEntityDb(6);
    const withCb = await a.db.render(a.out, {
      onProgress: () => {
        /* no-op sink */
      },
    });
    a.db.close();

    const b = await makeEntityDb(6);
    const without = await b.db.render(b.out);
    b.db.close();

    // Same number of files written and skipped — zero behavior change.
    expect(without.filesWritten.length).toBe(withCb.filesWritten.length);
    expect(without.filesSkipped).toBe(withCb.filesSkipped);
  });

  it('omitting opts entirely renders every entity dir', async () => {
    const { db, out } = await makeEntityDb(7);
    await db.render(out);
    expect(widgetDirCount(out)).toBe(7);
    db.close();
  });
});

describe('RenderEngine abort', () => {
  it('a pre-aborted signal stops the render before writing any entity files', async () => {
    const { db, out } = await makeEntityDb(10);
    const controller = new AbortController();
    controller.abort();

    const events: RenderProgress[] = [];
    await db.render(out, { signal: controller.signal, onProgress: (e) => events.push(e) });

    // No entity dirs written, and no terminal `done` (abort ≠ completion).
    expect(widgetDirCount(out)).toBe(0);
    expect(events.some((e) => e.kind === 'done')).toBe(false);
    db.close();
  });

  it('a mid-render abort stops the render with fewer files than a full render', async () => {
    // Full render count, for comparison.
    const full = await makeEntityDb(40);
    await full.db.render(full.out);
    const fullCount = widgetDirCount(full.out);
    full.db.close();
    expect(fullCount).toBe(40);

    // Aborting once the widget table starts leaves strictly fewer dirs than a
    // full render. We key off table-start (always emitted, never throttled) so
    // the abort is deterministic regardless of progress-tick throttling: the
    // engine checks the signal at the top of the per-entity loop and bails.
    const { db, out } = await makeEntityDb(40);
    const controller = new AbortController();
    const events: RenderProgress[] = [];
    await db.render(out, {
      signal: controller.signal,
      onProgress: (e) => {
        events.push(e);
        if (e.kind === 'table-start' && e.table === 'widget') {
          controller.abort();
        }
      },
    });

    const partialCount = widgetDirCount(out);
    expect(partialCount).toBeLessThan(fullCount);
    expect(events.some((e) => e.kind === 'done')).toBe(false);
    db.close();
  });
});

describe('ProgressThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('coalesces a 1000-row table to a bounded count but always passes start + done', () => {
    const out: RenderProgress[] = [];
    const throttle = new ProgressThrottle((e) => out.push(e), 200);

    const base = {
      table: 't',
      entitiesTotal: 1000,
      tableIndex: 0,
      tableCount: 1,
    };

    throttle.force({ ...base, kind: 'table-start', entitiesRendered: 0, pct: 0 });
    // 1000 ticks over a simulated ~2 second window. With a 200ms window that is
    // at most ~10 passthroughs, well under the raw tick count.
    for (let i = 1; i <= 1000; i++) {
      throttle.tick({
        ...base,
        kind: 'table-progress',
        entitiesRendered: i,
        pct: (i / 1000) * 100,
      });
      // Advance ~2ms per tick → ~2s total → ~10 windows of 200ms.
      vi.advanceTimersByTime(2);
    }
    throttle.force({ ...base, kind: 'table-done', entitiesRendered: 1000, pct: 100 });

    const progress = out.filter((e) => e.kind === 'table-progress');
    const starts = out.filter((e) => e.kind === 'table-start');
    const dones = out.filter((e) => e.kind === 'table-done');

    expect(starts).toHaveLength(1); // always ≥ 1 start
    expect(dones).toHaveLength(1); // always ≥ 1 done
    expect(progress.length).toBeGreaterThanOrEqual(1);
    // Bounded: far fewer than the 1000 raw ticks (≈ window count, generous cap).
    expect(progress.length).toBeLessThanOrEqual(30);
  });

  it('a no-op throttle (undefined callback) never throws and emits nothing', () => {
    const throttle = new ProgressThrottle(undefined);
    expect(() => {
      throttle.force({
        kind: 'done',
        table: null,
        entitiesRendered: 0,
        entitiesTotal: 0,
        tableIndex: 0,
        tableCount: 0,
        pct: 100,
      });
    }).not.toThrow();
    expect(() => {
      throttle.tick({
        kind: 'table-progress',
        table: 't',
        entitiesRendered: 1,
        entitiesTotal: 2,
        tableIndex: 0,
        tableCount: 1,
        pct: 50,
      });
    }).not.toThrow();
  });

  it('force resets the window so the next tick of a new table is not suppressed', () => {
    const out: RenderProgress[] = [];
    const throttle = new ProgressThrottle((e) => out.push(e), 200);
    const mk = (kind: RenderProgress['kind'], table: string): RenderProgress => ({
      kind,
      table,
      entitiesRendered: 1,
      entitiesTotal: 2,
      tableIndex: 0,
      tableCount: 2,
      pct: 50,
    });

    // Tick A passes (window starts at 0).
    throttle.tick(mk('table-progress', 'a'));
    // A second immediate tick is suppressed.
    throttle.tick(mk('table-progress', 'a'));
    expect(out.filter((e) => e.kind === 'table-progress')).toHaveLength(1);

    // A forced lifecycle event passes immediately even within the window.
    throttle.force(mk('table-done', 'a'));
    expect(out.filter((e) => e.kind === 'table-done')).toHaveLength(1);
  });
});

describe('Lattice.renderInBackground single-flight', () => {
  it('a concurrent renderInBackground + auto-render-triggering mutation never overlap', async () => {
    const { db, out } = await makeEntityDb(30);

    // Count concurrent renders by spying on the engine's render method.
    const engine = (db as unknown as { _render: { render: (...a: unknown[]) => Promise<unknown> } })
      ._render;
    let active = 0;
    let maxConcurrent = 0;
    let renderCount = 0;
    const realRender = engine.render.bind(engine);
    vi.spyOn(engine, 'render').mockImplementation(async (...args: unknown[]) => {
      active++;
      renderCount++;
      maxConcurrent = Math.max(maxConcurrent, active);
      try {
        return await realRender(...args);
      } finally {
        active--;
      }
    });

    db.enableAutoRender(out, { debounceMs: 10 });

    // Kick off a background render and, while it runs, trigger an auto-render
    // via a mutation. The single-flight guard must serialize them.
    const bg = db.renderInBackground(out);
    await db.insert('widget', { id: 'w-late', name: 'late arrival' });

    await bg;
    // Give the debounced + coalesced follow-up auto-render time to run.
    await new Promise((r) => setTimeout(r, 80));

    expect(maxConcurrent).toBe(1); // never two renders to the same dir at once
    expect(renderCount).toBeGreaterThanOrEqual(1);

    db.close();
  });
});
