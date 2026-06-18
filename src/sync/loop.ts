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

    const tick = (): void => {
      if (stopped) return;

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
