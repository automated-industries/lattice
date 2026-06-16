import { describe, expect, it } from 'vitest';
import { openWithinTimeout, type ActiveDb } from '../../src/gui/server.js';

/**
 * Regression: the workspace switch awaited the new workspace's open with no
 * timeout. A slow / stalled (e.g. cloud Postgres) open therefore hung the whole
 * GUI on "Switching…" indefinitely. openWithinTimeout caps the open: on timeout
 * the caller keeps the current workspace, and the slow open is disposed when it
 * eventually settles so it can't leak a DB handle / pg connection.
 */
function fakeDb(tag: string): ActiveDb {
  return { tag } as unknown as ActiveDb;
}

describe('openWithinTimeout', () => {
  it('returns timedOut when the open never settles, and disposes the orphan once it resolves', async () => {
    let resolveOpen!: (db: ActiveDb) => void;
    const open = (): Promise<ActiveDb> =>
      new Promise<ActiveDb>((resolve) => {
        resolveOpen = resolve;
      });
    const disposed: ActiveDb[] = [];
    const dispose = (db: ActiveDb): Promise<void> => {
      disposed.push(db);
      return Promise.resolve();
    };

    const t0 = Date.now();
    const res = await openWithinTimeout(open, 40, dispose);
    expect(Date.now() - t0).toBeLessThan(2000); // would hang forever before the fix
    expect(res).toEqual({ timedOut: true });

    // The slow open eventually settles → its orphaned workspace is disposed.
    const orphan = fakeDb('orphan');
    resolveOpen(orphan);
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });
    expect(disposed).toEqual([orphan]);
  });

  it('returns the db on a fast open', async () => {
    const db = fakeDb('ok');
    const res = await openWithinTimeout(
      () => Promise.resolve(db),
      1000,
      () => Promise.resolve(),
    );
    expect(res).toEqual({ db });
  });

  it('rethrows a genuine open error (distinct from a timeout)', async () => {
    await expect(
      openWithinTimeout(
        () => Promise.reject(new Error('connect refused')),
        1000,
        () => Promise.resolve(),
      ),
    ).rejects.toThrow('connect refused');
  });
});
