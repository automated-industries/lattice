import type { RenderEngine } from '../render/engine.js';
import type { WatchOptions, StopFn, RenderResult } from '../types.js';

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
      void this._engine
        .render(outputDir)
        .then((result: RenderResult) => {
          options.onRender?.(result);
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
