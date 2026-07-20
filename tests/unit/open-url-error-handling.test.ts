import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Regression (same class as the file-loopback FSWatcher fix): `openUrl`'s detached
 * browser-opener spawn must have an `'error'` listener. A missing opener binary
 * (e.g. headless Linux without `xdg-open`) delivers the failure as an async `'error'`
 * EVENT on the ChildProcess — with no listener, Node turns it into a fatal unhandled
 * exception that takes the GUI server down right as it boots and tries to open a tab.
 */

class FakeChild extends EventEmitter {
  unref(): void {
    // detached fire-and-forget — nothing to do
  }
}

const spawned: FakeChild[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

afterEach(() => {
  spawned.splice(0);
  vi.restoreAllMocks();
});

describe('openUrl error handling', () => {
  it('handles a spawn error event (missing opener binary) instead of crashing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { openUrl } = await import('../../src/gui/server.js');
    openUrl('http://127.0.0.1:4317');
    const child = spawned.at(-1);
    expect(child).toBeDefined();
    // Without the 'error' listener this emit throws synchronously (the emitter-level
    // proxy for the fatal unhandled exception the async native failure produces).
    expect(() =>
      child?.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })),
    ).not.toThrow();
    // And the failure is surfaced, not swallowed.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not open'),
      expect.stringContaining('ENOENT'),
    );
  });
});
