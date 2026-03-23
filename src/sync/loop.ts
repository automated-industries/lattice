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
        .then((result: RenderResult) => {
          options.onRender?.(result);
          if (options.cleanup) {
            const cleanupResult = this._engine.cleanup(outputDir, prevManifest, options.cleanup);
            options.onCleanup?.(cleanupResult);
          }
        })
        .catch((err: unknown) => {
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
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
