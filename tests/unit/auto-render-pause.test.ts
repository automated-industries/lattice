import { describe, it, expect } from 'vitest';
import { AutoRenderScheduler, type AutoRenderDeps } from '../../src/render/auto-render.js';
import type { RenderResult } from '../../src/types.js';

// Phase 1b: a bulk operation (folder ingest) pauses auto-render so hundreds of
// per-file writes don't each fire a render (the O(N²) blowup). Writes still
// accumulate the render scope; resume() fires exactly ONE coalesced render.

function makeScheduler(): { s: AutoRenderScheduler; renders: () => number } {
  let renders = 0;
  const deps: AutoRenderDeps = {
    render: async () => {
      renders++;
      return {} as RenderResult;
    },
    cleanup: async () => ({ removedFiles: [], removedDirs: [] }) as never,
    readManifest: () => null,
    emitRender: () => {},
    emitError: () => {},
    isInitialized: () => true,
  };
  return { s: new AutoRenderScheduler(deps), renders: () => renders };
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('AutoRenderScheduler pause/resume', () => {
  it('accumulates writes while paused and fires exactly ONE render on resume', async () => {
    const { s, renders } = makeScheduler();
    s.enable('/tmp/out', { debounceMs: 5 });
    s.pause();
    for (let i = 0; i < 20; i++) s.schedule('t' + (i % 3));
    await tick(30);
    expect(renders()).toBe(0); // paused → no render despite 20 writes
    s.resume();
    await tick(30);
    expect(renders()).toBe(1); // one coalesced render covers all of them
  });

  it('is re-entrant — the render fires only after the LAST balancing resume', async () => {
    const { s, renders } = makeScheduler();
    s.enable('/tmp/out', { debounceMs: 5 });
    s.pause();
    s.pause();
    s.schedule('a');
    s.resume();
    await tick(25);
    expect(renders()).toBe(0); // still suspended (depth 1)
    s.resume();
    await tick(25);
    expect(renders()).toBe(1);
  });

  it('renders normally when never paused (baseline unchanged)', async () => {
    const { s, renders } = makeScheduler();
    s.enable('/tmp/out', { debounceMs: 5 });
    s.schedule('a');
    s.schedule('b');
    await tick(25);
    expect(renders()).toBe(1);
  });
});
