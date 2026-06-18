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
    result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  return { render } as unknown as MockEngine;
}

describe('SyncLoop', () => {
  it('fires render after interval', async () => {
    const engine = makeEngine();
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 20 });

    await vi.waitFor(
      () => {
        expect(engine.render).toHaveBeenCalled();
      },
      { timeout: 200 },
    );
    stop();
  });

  it('calls onRender with result', async () => {
    const engine = makeEngine();
    const loop = new SyncLoop(engine);
    const results: RenderResult[] = [];
    const stop = loop.watch('/out', {
      interval: 20,
      onRender: (r) => {
        results.push(r);
      },
    });

    await vi.waitFor(
      () => {
        expect(results.length).toBeGreaterThan(0);
      },
      { timeout: 200 },
    );
    stop();
    expect(results[0]).toEqual(mockResult);
  });

  it('calls onError when render throws', async () => {
    const err = new Error('render failed');
    const engine = makeEngine(err);
    const loop = new SyncLoop(engine);
    const errors: Error[] = [];
    const stop = loop.watch('/out', {
      interval: 20,
      onError: (e) => {
        errors.push(e);
      },
    });

    await vi.waitFor(
      () => {
        expect(errors.length).toBeGreaterThan(0);
      },
      { timeout: 200 },
    );
    stop();
    expect(errors[0]?.message).toBe('render failed');
  });

  it('surfaces render errors via console.error when no onError handler is set', async () => {
    // A watch-loop render failure must never vanish silently just because the
    // consumer did not pass onError.
    const engine = makeEngine(new Error('render boom'));
    const loop = new SyncLoop(engine);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stop = loop.watch('/out', { interval: 20 }); // no onError handler
    await vi.waitFor(
      () => {
        expect(spy).toHaveBeenCalled();
      },
      { timeout: 200 },
    );
    stop();
    expect(
      spy.mock.calls.some((c) => c.some((a) => a instanceof Error && a.message === 'render boom')),
    ).toBe(true);
    spy.mockRestore();
  });

  it('passes the post-render manifest to cleanup as the 4th arg', async () => {
    const engine = makeEngine();
    const cleanup = vi.fn().mockResolvedValue({});
    (engine as unknown as { cleanup: typeof cleanup }).cleanup = cleanup;
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 20, cleanup: {} });
    await vi.waitFor(
      () => {
        expect(cleanup).toHaveBeenCalled();
      },
      { timeout: 200 },
    );
    stop();
    // cleanup now receives (outputDir, prevManifest, options, newManifest) — 4 args,
    // not the prior 3 that omitted the post-render manifest.
    expect(cleanup.mock.calls[0]?.length).toBe(4);
  });

  it('stop() prevents further renders', async () => {
    const engine = makeEngine();
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 20 });

    await vi.waitFor(
      () => {
        expect(engine.render).toHaveBeenCalled();
      },
      { timeout: 200 },
    );
    const callsBefore = engine.render.mock.calls.length;
    stop();

    await new Promise((r) => setTimeout(r, 60));
    // Should not have rendered again after stop
    expect(engine.render.mock.calls.length).toBe(callsBefore);
  });
});
