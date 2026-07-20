import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLoopbackWatcher, type WatchFactory } from '../../src/gui/file-watcher.js';
import type { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';

/**
 * Regression: the file-loopback FSWatcher must have an `'error'` listener.
 *
 * An `fs.watch` FSWatcher emits an `'error'` EVENT (not a thrown exception) when its watched
 * directory is removed/unmounted out from under it. On Windows a recursive watch runs on a
 * native thread that can fire this even AFTER close() — e.g. the workspace temp dir being
 * deleted during test teardown → `EPERM: operation not permitted, watch`. Node treats an
 * emitter `'error'` with no listener as FATAL (an unhandled error that vitest reports as a
 * run-level failure even when every test passed — the exact Windows CI failure this fixes).
 * These tests drive the error path with a fake FSWatcher so it is deterministic on every
 * platform (a real close+rm never reproduces the late native fire off-Windows).
 *
 * Classification contract: dir GONE (or ENOENT) = benign teardown, quiet; dir still PRESENT
 * = a genuine failure (ACL change, antivirus lock) that must be surfaced — console.warn +
 * an activity-feed notice — never a silent loopback death that reads as data loss later.
 */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-fw-err-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A controllable stand-in for an FSWatcher: an EventEmitter with a spied `close()`.
 *  Faithful to the real one for this bug: `close()` does NOT remove listeners, and
 *  `emit('error')` with no listener throws (the emitter-level proxy for the fatal
 *  unhandled exception the native layer would produce). */
class FakeWatcher extends EventEmitter {
  closed = 0;
  close(): void {
    this.closed += 1;
  }
}

function makeWatcher(outputDir: string): {
  watcher: ReturnType<typeof createFileLoopbackWatcher>;
  feed: FeedBus;
  events: { summary?: string }[];
  lastFake: () => FakeWatcher | null;
} {
  let fake: FakeWatcher | null = null;
  const watchFactory: WatchFactory = () => {
    fake = new FakeWatcher();
    return fake as unknown as FSWatcher;
  };
  const feed = new FeedBus();
  const events: { summary?: string }[] = [];
  feed.subscribe((e) => events.push(e as { summary?: string }));
  const watcher = createFileLoopbackWatcher({
    db: {} as unknown as Lattice, // start()/error-path never touch the db
    feed,
    softDeletable: new Set<string>(),
    outputDir,
    watchFactory,
  });
  return { watcher, feed, events, lastFake: () => fake };
}

const errWithCode = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

describe('file-loopback watcher error handling', () => {
  it('handles an FSWatcher error event instead of letting it become fatal', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { watcher, lastFake } = makeWatcher(tempDir());
    watcher.start();
    const fake = lastFake();
    expect(fake).not.toBeNull();

    // Without the 'error' listener this emit throws synchronously (EventEmitter contract) and
    // would surface as vitest's run-level "unhandled error". With the fix it is handled.
    expect(() =>
      fake?.emit('error', errWithCode('EPERM: operation not permitted, watch', 'EPERM')),
    ).not.toThrow();
    // The dead watch is closed (degrade to no loopback), never left dangling.
    expect(fake?.closed).toBe(1);
    watcher.stop();
  });

  it('is quiet for a benign teardown error (the watched dir was removed)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = tempDir();
    const { watcher, events, lastFake } = makeWatcher(dir);
    watcher.start();
    // The real CI scenario: the temp outputDir is rm'd during teardown, THEN the native
    // thread delivers the failure. Teardown rm is synchronous, so the handler always runs
    // with the dir already gone.
    rmSync(dir, { recursive: true, force: true });
    lastFake()?.emit('error', errWithCode('EPERM: operation not permitted, watch', 'EPERM'));
    expect(warn).not.toHaveBeenCalled(); // benign: the watched dir is gone
    expect(events).toHaveLength(0); // and no feed noise either
    watcher.stop();
  });

  it('surfaces a genuine error (dir still present) via console.warn AND the activity feed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = tempDir(); // exists throughout — so this is NOT the benign "dir gone" case
    const { watcher, events, lastFake } = makeWatcher(dir);
    watcher.start();
    const fake = lastFake();
    fake?.emit('error', errWithCode('boom', 'EPERM')); // EPERM alone is NOT benign — dir present
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('file-loopback watcher error'),
      'boom',
    );
    // Desktop users never see the server console — the degraded state must reach the feed.
    expect(events.some((e) => (e.summary ?? '').includes('File-edit sync stopped'))).toBe(true);
    // A genuine error still degrades cleanly: watcher closed, restart possible.
    expect(fake?.closed).toBe(1);
    watcher.start();
    expect(lastFake()).not.toBe(fake);
    watcher.stop();
  });

  it('a late second error from a DEAD watcher never closes its healthy replacement', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { watcher, lastFake } = makeWatcher(tempDir());
    watcher.start();
    const first = lastFake();
    first?.emit('error', errWithCode('EPERM', 'EPERM'));
    expect(first?.closed).toBe(1);

    // start() early-returns while a watcher exists; after an error nulled it, a fresh
    // start() builds a NEW watcher (loopback recovers if the dir comes back).
    watcher.start();
    const second = lastFake();
    expect(second).not.toBe(first);

    // The fix's own premise is that Windows can deliver ANOTHER error after close(). The
    // stale handler must only touch its own (dead) instance — before the instance-capture
    // fix it closed over the shared slot and closed the healthy replacement.
    first?.emit('error', errWithCode('EPERM', 'EPERM'));
    expect(second?.closed).toBe(0); // replacement untouched
    expect(first?.closed).toBe(2); // the dead instance re-closed (idempotent, harmless)
    watcher.stop();
    expect(second?.closed).toBe(1); // stop() still owns the live watcher
  });

  it('the literal CI sequence — start, stop, dir removed, late error — is not fatal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = tempDir();
    const { watcher, lastFake } = makeWatcher(dir);
    watcher.start();
    watcher.stop(); // the suite's teardown discipline: watcher stopped first…
    rmSync(dir, { recursive: true, force: true }); // …then the temp dir removed…
    // …and THEN the native thread delivers the failed completion. Guards against a future
    // stop() refactor that removes listeners (removeAllListeners) silently resurrecting the
    // Windows CI failure.
    expect(() =>
      lastFake()?.emit('error', errWithCode('EPERM: operation not permitted, watch', 'EPERM')),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled(); // benign — quiet
  });

  it('smoke: the default real fs.watch factory wires up and stops cleanly', () => {
    // No injected factory — proves the `watch as WatchFactory` default matches the real
    // node:fs signature and that start()/stop() work against a genuine FSWatcher.
    const watcher = createFileLoopbackWatcher({
      db: {} as unknown as Lattice,
      feed: new FeedBus(),
      softDeletable: new Set<string>(),
      outputDir: tempDir(),
    });
    expect(() => {
      watcher.start();
      watcher.stop();
    }).not.toThrow();
  });
});
