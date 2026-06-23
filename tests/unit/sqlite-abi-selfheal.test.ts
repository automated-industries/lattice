/**
 * Unit tests for the self-healing better-sqlite3 loader (src/db/load-sqlite.ts).
 *
 * The loader is exercised with INJECTED require + rebuild seams so we test the
 * decision logic without ever touching a real native binary or running an
 * actual `npm rebuild`. The behaviors under test:
 *
 *   1. ABI mismatch on first load → rebuild invoked → second load returns the
 *      ctor (self-heal succeeds, no throw).
 *   2. Rebuild fails → throws the clear, system-agnostic actionable error that
 *      names the manual rebuild command and mentions NO Node version number.
 *   3. Non-ABI error (MODULE_NOT_FOUND) → does NOT attempt a rebuild, throws the
 *      peer-dependency guidance.
 *   4. LATTICE_SQLITE_NO_AUTOREBUILD set → ABI mismatch does NOT rebuild, throws
 *      the clear error.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveSqliteCtor } from '../../src/db/load-sqlite.js';

// A stand-in for the better-sqlite3 constructor — identity is all the loader
// cares about; it never instantiates it in these tests.
const FAKE_CTOR = class FakeDatabase {
  marker = 'fake-better-sqlite3';
} as unknown as ReturnType<typeof Object>;

// A no-op stderr logger used where the test doesn't assert on the notice line.
const noopLog = (_msg: string): void => undefined;

/** Build an error shaped like a native NODE_MODULE_VERSION ABI mismatch. */
function abiError(): Error {
  return new Error(
    "The module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node' " +
      'was compiled against a different Node.js version using NODE_MODULE_VERSION 115. ' +
      'This version of Node.js requires NODE_MODULE_VERSION 137.',
  );
}

/** Build an ERR_DLOPEN_FAILED-coded error (alternate ABI-mismatch shape). */
function dlopenError(): Error {
  const e = new Error('Error loading shared library');
  (e as { code?: string }).code = 'ERR_DLOPEN_FAILED';
  return e;
}

/** Build a MODULE_NOT_FOUND error (genuinely missing — not a rebuild case). */
function moduleNotFoundError(): Error {
  const e = new Error("Cannot find module 'better-sqlite3'");
  (e as { code?: string }).code = 'MODULE_NOT_FOUND';
  return e;
}

/**
 * Make a fake `require` that throws `errs[n]` on call n, then returns the ctor.
 * Pass a list so we can model "fail first, succeed after rebuild".
 */
function fakeRequire(errs: (Error | null)[]): { fn: NodeJS.Require; calls: () => number } {
  let i = 0;
  const fn = ((id: string) => {
    const idx = i++;
    if (id === 'better-sqlite3') {
      const e = errs[idx];
      if (e) throw e;
      return FAKE_CTOR;
    }
    throw new Error(`unexpected require: ${id}`);
  }) as unknown as NodeJS.Require;
  return { fn, calls: () => i };
}

afterEach(() => {
  delete process.env.LATTICE_SQLITE_NO_AUTOREBUILD;
  vi.restoreAllMocks();
});

describe('resolveSqliteCtor — self-healing loader', () => {
  it('self-heals on ABI mismatch: rebuild invoked, second load returns the ctor', () => {
    const { fn: req, calls } = fakeRequire([abiError(), null]);
    const rebuild = vi.fn(() => ({ ok: true as const }));
    const log = vi.fn();

    const ctor = resolveSqliteCtor({
      require: req,
      rebuild,
      installRoot: () => '/fake/root',
      log,
    });

    expect(ctor).toBe(FAKE_CTOR);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith('/fake/root');
    // First (failed) require + second (post-rebuild) require.
    expect(calls()).toBe(2);
    // A concise notice was emitted so a long rebuild isn't a silent hang.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('rebuilding better-sqlite3');
  });

  it('also classifies ERR_DLOPEN_FAILED as an ABI mismatch and self-heals', () => {
    const { fn: req } = fakeRequire([dlopenError(), null]);
    const rebuild = vi.fn(() => ({ ok: true as const }));

    const ctor = resolveSqliteCtor({
      require: req,
      rebuild,
      installRoot: () => '/fake/root',
      log: noopLog,
    });

    expect(ctor).toBe(FAKE_CTOR);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('throws a clear, system-agnostic error when the rebuild fails', () => {
    const rebuild = vi.fn(() => ({ ok: false as const, reason: 'node-gyp not found' }));
    // Each call gets a fresh single-error require so the queued ABI error is
    // re-thrown on each invocation (the require call index does not survive).
    const run = () =>
      resolveSqliteCtor({
        require: fakeRequire([abiError()]).fn,
        rebuild,
        installRoot: () => '/fake/root',
        log: noopLog,
      });

    expect(run).toThrow(/npm rebuild better-sqlite3/);

    // Inspect the full message: it names the command and the short reason, and
    // contains NO Node version number / machine path.
    let message = '';
    try {
      run();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('npm rebuild better-sqlite3');
    expect(message).toContain('node-gyp not found');
    // System-agnostic: no NODE_MODULE_VERSION, no bare version like "v25" / "115".
    expect(message).not.toContain('NODE_MODULE_VERSION');
    expect(message).not.toMatch(/NODE_MODULE_VERSION|\bv?\d{2,3}\b/);
  });

  it('throws the same clear error if the rebuilt module still fails to load', () => {
    // require fails twice: once before rebuild, once after (rebuild "succeeded"
    // but the binary still doesn't load).
    const { fn: req } = fakeRequire([abiError(), abiError()]);
    const rebuild = vi.fn(() => ({ ok: true as const }));

    let message = '';
    try {
      resolveSqliteCtor({ require: req, rebuild, installRoot: () => '/fake/root', log: noopLog });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(message).toContain('npm rebuild better-sqlite3');
    expect(message).toContain('still failed to load');
  });

  it('does NOT rebuild on a non-ABI error (MODULE_NOT_FOUND): throws peer-dep guidance', () => {
    const { fn: req } = fakeRequire([moduleNotFoundError()]);
    const rebuild = vi.fn(() => ({ ok: true as const }));

    let message = '';
    try {
      resolveSqliteCtor({ require: req, rebuild, installRoot: () => '/fake/root', log: noopLog });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(rebuild).not.toHaveBeenCalled();
    expect(message).toContain('required peer dependency');
    expect(message).toContain('npm install better-sqlite3');
  });

  it('does NOT rebuild when LATTICE_SQLITE_NO_AUTOREBUILD is set: throws the clear error', () => {
    process.env.LATTICE_SQLITE_NO_AUTOREBUILD = '1';
    const { fn: req } = fakeRequire([abiError()]);
    const rebuild = vi.fn(() => ({ ok: true as const }));

    let message = '';
    try {
      resolveSqliteCtor({ require: req, rebuild, installRoot: () => '/fake/root', log: noopLog });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(rebuild).not.toHaveBeenCalled();
    expect(message).toContain('npm rebuild better-sqlite3');
    expect(message).toContain('disabled');
  });

  it('treats LATTICE_SQLITE_NO_AUTOREBUILD=false / 0 as NOT opted out (still self-heals)', () => {
    for (const falsey of ['false', '0', 'no', '']) {
      process.env.LATTICE_SQLITE_NO_AUTOREBUILD = falsey;
      const { fn: req } = fakeRequire([abiError(), null]);
      const rebuild = vi.fn(() => ({ ok: true as const }));
      const ctor = resolveSqliteCtor({
        require: req,
        rebuild,
        installRoot: () => '/fake/root',
        log: noopLog,
      });
      expect(ctor).toBe(FAKE_CTOR);
      expect(rebuild).toHaveBeenCalledTimes(1);
    }
  });
});
