import { describe, it, expect, vi } from 'vitest';
import { SyncLoop } from '../../src/sync/loop.js';
import type { RenderEngine } from '../../src/render/engine.js';
import type { RenderResult } from '../../src/types.js';

const mockResult: RenderResult = { filesWritten: [], filesSkipped: 0, durationMs: 0 };

interface MockEngine extends RenderEngine {
  render: ReturnType<typeof vi.fn>;
  changeProbe: ReturnType<typeof vi.fn>;
}

/**
 * Build a mock engine. `probe` is the injectable change-probe seam, mirroring
 * the real `RenderEngine.changeProbe()` which is always present and returns a
 * token (SQLite) or `undefined` (Postgres / no complete signal):
 *   - omit it → `changeProbe` returns `undefined` (a backend that can't gate;
 *     the loop must render every tick — today's default behavior).
 *   - pass a function → it backs `engine.changeProbe`; the loop consults it
 *     before each render and skips when the token is unchanged.
 */
function makeEngine(
  result: RenderResult | Error = mockResult,
  probe?: () => string | undefined,
): MockEngine {
  const render =
    result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  const engine = { render } as unknown as MockEngine;
  engine.changeProbe = vi.fn(probe ?? (() => undefined));
  return engine;
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

  // ── change-detection gate ────────────────────────────────────────────────
  // The gate may ONLY skip on a complete change signal. A backend that cannot
  // expose one (no probe → undefined) MUST keep rendering every tick.

  it('renders every tick when no probe is present (unsupported backend)', async () => {
    // No probe installed: the engine cannot prove the DB is unchanged, so the
    // loop falls through to a full render every tick — exactly today's default.
    const engine = makeEngine(); // no probe
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 15 });

    await vi.waitFor(
      () => {
        expect(engine.render.mock.calls.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 300 },
    );
    stop();
  });

  it('renders every tick when the probe token changes each tick', async () => {
    // A constantly-changing token means the DB is being written on every tick —
    // the gate must NEVER skip; every tick renders.
    let n = 0;
    const engine = makeEngine(mockResult, () => `tok-${String(n++)}`);
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 15 });

    await vi.waitFor(
      () => {
        expect(engine.render.mock.calls.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 300 },
    );
    stop();
  });

  it('skips render on ticks where the probe token is unchanged', async () => {
    // A stable token means the DB provably has not changed since the last
    // render — every subsequent tick is gated (no render).
    const engine = makeEngine(mockResult, () => 'stable-token');
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 15 });

    // First tick (no prior token) always renders. Wait for it.
    await vi.waitFor(
      () => {
        expect(engine.render.mock.calls.length).toBe(1);
      },
      { timeout: 200 },
    );

    // Let several more ticks elapse: the token never changes, so none render.
    await new Promise((r) => setTimeout(r, 90));
    expect(engine.render.mock.calls.length).toBe(1);
    // But the probe IS consulted every tick (the gate keeps re-arming).
    expect(engine.changeProbe.mock.calls.length).toBeGreaterThanOrEqual(3);
    stop();
  });

  it('always renders the first tick even with a stable token', async () => {
    // The very first tick has no prior token to compare against, so it must
    // render unconditionally — never gate the initial render.
    const engine = makeEngine(mockResult, () => 'stable-token');
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 15 });

    await vi.waitFor(
      () => {
        expect(engine.render.mock.calls.length).toBe(1);
      },
      { timeout: 200 },
    );
    stop();
  });

  it('re-renders after a real change, then gates again on the new stable token', async () => {
    // Token sequence: A (render #1), A (skip), B (change → render #2), B (skip)...
    // Proves the gate (a) skips equal tokens and (b) catches a change, then
    // re-stabilizes on the NEW token captured at the change render.
    const tokens = ['A', 'A', 'B', 'B', 'B'];
    let i = 0;
    const engine = makeEngine(mockResult, () => tokens[Math.min(i++, tokens.length - 1)] ?? 'B');
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 15 });

    // Expect exactly two renders: the first tick (token A) and the change to B.
    await vi.waitFor(
      () => {
        expect(engine.render.mock.calls.length).toBe(2);
      },
      { timeout: 400 },
    );
    // After settling on B, no further renders.
    await new Promise((r) => setTimeout(r, 60));
    expect(engine.render.mock.calls.length).toBe(2);
    stop();
  });

  it('runs cleanup only when a gated render actually happens', async () => {
    // Gate skips both the render AND its cleanup on an unchanged token; a
    // changed token runs render + cleanup as today.
    const tokens = ['A', 'A', 'B'];
    let i = 0;
    const engine = makeEngine(mockResult, () => tokens[Math.min(i++, tokens.length - 1)] ?? 'B');
    const cleanup = vi.fn().mockResolvedValue({});
    (engine as unknown as { cleanup: typeof cleanup }).cleanup = cleanup;
    const loop = new SyncLoop(engine);
    const stop = loop.watch('/out', { interval: 15, cleanup: {} });

    await vi.waitFor(
      () => {
        // render #1 (A) + render #2 (B) → cleanup ran exactly twice, NOT on the
        // skipped middle tick.
        expect(cleanup.mock.calls.length).toBe(2);
      },
      { timeout: 400 },
    );
    expect(engine.render.mock.calls.length).toBe(2);
    stop();
  });
});
