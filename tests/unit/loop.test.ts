import { describe, it, expect, vi } from 'vitest';
import { SyncLoop } from '../../src/sync/loop.js';
import type { RenderEngine } from '../../src/render/engine.js';
import type { RenderResult } from '../../src/types.js';

const mockResult: RenderResult = { filesWritten: [], filesSkipped: 0, durationMs: 0 };

interface MockEngine extends RenderEngine {
  render: ReturnType<typeof vi.fn>;
}

function makeEngine(result: RenderResult | Error = mockResult): MockEngine {
  const render =
    result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
  return { render } as unknown as MockEngine;
}

describe('SyncLoop', () => {
  it('fires render after interval', async () => {
    const engine = makeEngine();
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 20 });

    await vi.waitFor(() => { expect(engine.render).toHaveBeenCalled(); }, { timeout: 200 });
    stop();
  });

  it('calls onRender with result', async () => {
    const engine = makeEngine();
    const loop = new SyncLoop(engine);
    const results: RenderResult[] = [];
    const stop = loop.watch('/out', { interval: 20, onRender: (r) => { results.push(r); } });

    await vi.waitFor(() => { expect(results.length).toBeGreaterThan(0); }, { timeout: 200 });
    stop();
    expect(results[0]).toEqual(mockResult);
  });

  it('calls onError when render throws', async () => {
    const err = new Error('render failed');
    const engine = makeEngine(err);
    const loop = new SyncLoop(engine);
    const errors: Error[] = [];
    const stop = loop.watch('/out', { interval: 20, onError: (e) => { errors.push(e); } });

    await vi.waitFor(() => { expect(errors.length).toBeGreaterThan(0); }, { timeout: 200 });
    stop();
    expect(errors[0]?.message).toBe('render failed');
  });

  it('stop() prevents further renders', async () => {
    const engine = makeEngine();
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 20 });

    await vi.waitFor(() => { expect(engine.render).toHaveBeenCalled(); }, { timeout: 200 });
    const callsBefore = engine.render.mock.calls.length;
    stop();

    await new Promise((r) => setTimeout(r, 60));
    // Should not have rendered again after stop
    expect(engine.render.mock.calls.length).toBe(callsBefore);
  });
});
