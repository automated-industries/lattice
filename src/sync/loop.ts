import type { RenderEngine } from '../render/engine.js';
import type { WatchOptions, StopFn, RenderResult } from '../types.js';
import { readManifest } from '../lifecycle/manifest.js';

export class SyncLoop {
  private readonly _engine: RenderEngine;

  constructor(engine: RenderEngine) {
    this._engine = engine;
  }

  watch(outputDir: string, options: WatchOptions = {}): StopFn {
    const interval = options.interval ?? 5000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    // Change-detection gate. The token captured at the START of the last render
    // that actually ran (the snapshot of DB state as of when that render began
    // reading). A tick may skip its render ONLY when a freshly-read probe token
    // is defined AND strictly equal to this stored token — equality proves zero
    // commits since the last render started, so nothing a render reads could
    // have changed and the rendered tree is already current.
    //
    // CAPTURE POINT — read the token BEFORE the render reads, and store it as
    // the new baseline whenever a render runs. This cannot miss a change:
    //   - A write that commits DURING a render moves the token away from the
    //     stored start-of-render value, so the NEXT tick sees inequality and
    //     re-renders (capturing pre-render here, post-render storage would risk
    //     adopting a baseline that already reflects a mid-render write and then
    //     skipping it). Pre-render capture means the worst case is one extra
    //     render, never a skipped-but-needed one.
    //   - `undefined` (backend has no complete probe) NEVER equals a prior
    //     token, so the loop always renders — today's behavior, unchanged.
    //   - The first tick has no stored token (`lastRenderedToken` is the unique
    //     NOT_RENDERED sentinel, never returned by a probe), so it always
    //     renders.
    const NOT_RENDERED = Symbol('not-rendered');
    let lastRenderedToken: string | undefined | typeof NOT_RENDERED = NOT_RENDERED;

    const tick = (): void => {
      if (stopped) return;

      // Probe BEFORE reading anything for the render. A defined token equal to
      // the last render's start-token means the DB provably has not changed —
      // skip this tick's render AND its cleanup, but still re-arm the next tick.
      // (`changeProbe()` itself returns undefined on backends without a complete
      // signal, so undefined never equals a prior token → always renders.)
      const token = this._engine.changeProbe();
      if (token !== undefined && token === lastRenderedToken) {
        timer = setTimeout(tick, interval);
        return;
      }
      // A render is going to run: adopt this pre-render token as the new
      // baseline now (before the render reads), so a write landing mid-render
      // differs from it and the next tick re-renders.
      lastRenderedToken = token;

      // Read previous manifest before render so cleanup can detect orphans
      const prevManifest = options.cleanup ? readManifest(outputDir) : null;

      void this._engine
        .render(outputDir)
        .then(async (result: RenderResult) => {
          options.onRender?.(result);
          if (options.cleanup) {
            // Pass the manifest render JUST wrote (4th arg) — every other cleanup()
            // caller does. Without it, cleanup detected orphaned directories from the
            // previous manifest but could not detect stale files in surviving entities
            // (omitIfEmpty / removed files), leaving them on disk.
            const newManifest = readManifest(outputDir);
            const cleanupResult = await this._engine.cleanup(
              outputDir,
              prevManifest,
              options.cleanup,
              newManifest,
            );
            options.onCleanup?.(cleanupResult);
          }
        })
        .catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          // A render/cleanup failure in the watch loop must surface even when the
          // consumer supplied no onError handler — never vanish silently.
          if (options.onError) options.onError(error);
          else console.error('[lattice watch] render/cleanup failed:', error);
        })
        .finally(() => {
          if (!stopped) {
            timer = setTimeout(tick, interval);
          }
        });
    };

    timer = setTimeout(tick, interval);

    return () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }
}
