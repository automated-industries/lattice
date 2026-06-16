import { afterEach, describe, expect, it } from 'vitest';
import { disposeActive, type ActiveDb } from '../../src/gui/server.js';

// Resolvers for promises we intentionally leave pending (a "wedged" broker
// stop()). Drained after each test so nothing stays unsettled across the file.
const pendingResolvers: (() => void)[] = [];
afterEach(() => {
  for (const resolve of pendingResolvers.splice(0)) resolve();
});

/** A stop() that never settles — simulates a stalled LISTEN/NOTIFY client. */
function neverSettles(): Promise<void> {
  return new Promise<void>((resolve) => {
    pendingResolvers.push(resolve);
  });
}

/** Minimal ActiveDb stub — only the fields disposeActive touches. */
function makeActive(realtime: { stop: () => Promise<void> } | null): {
  active: ActiveDb;
  abort: AbortController;
  closed: () => boolean;
} {
  const abort = new AbortController();
  let didClose = false;
  const active = {
    renderAbort: abort,
    realtime,
    db: {
      close: (): void => {
        didClose = true;
      },
    },
  } as unknown as ActiveDb;
  return { active, abort, closed: () => didClose };
}

describe('disposeActive — teardown resilience', () => {
  it('completes (and still closes the db) when the broker stop() never settles', async () => {
    const { active, closed } = makeActive({ stop: neverSettles });
    const start = Date.now();
    await disposeActive(active, 50); // time-bounded teardown
    // Before the fix this awaited stop() forever and the workspace switch hung.
    expect(Date.now() - start).toBeLessThan(2000);
    expect(closed()).toBe(true); // teardown proceeds past the abandoned broker
  });

  it('awaits a well-behaved stop() and closes the db', async () => {
    let stopped = false;
    const { active, closed } = makeActive({
      stop: (): Promise<void> => {
        stopped = true;
        return Promise.resolve();
      },
    });
    await disposeActive(active, 1000);
    expect(stopped).toBe(true);
    expect(closed()).toBe(true);
  });

  it('aborts the in-flight render before teardown', async () => {
    const { active, abort } = makeActive(null);
    await disposeActive(active, 100);
    expect(abort.signal.aborted).toBe(true);
  });

  it('never lets a rejecting stop() throw out of teardown', async () => {
    const { active, closed } = makeActive({
      stop: (): Promise<void> => Promise.reject(new Error('broker exploded')),
    });
    await expect(disposeActive(active, 500)).resolves.toBeUndefined();
    expect(closed()).toBe(true);
  });
});
