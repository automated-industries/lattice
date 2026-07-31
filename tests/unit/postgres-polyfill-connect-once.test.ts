import { describe, expect, it, vi, afterEach } from 'vitest';
import { POSTGRES_POLYFILLS, registerPostgresPolyfills } from '../../src/db/postgres.js';

/**
 * Registering the SQLite-compat polyfills runs several independent DDL
 * statements, each non-fatal so a permission-restricted role still connects.
 *
 * That per-statement tolerance is right for a permission refusal — the next
 * statement may well succeed — but it used to apply just as happily to a
 * connection that never came up. Pointed at an unreachable host, one open
 * therefore made one connection attempt per polyfill, paying a full connect
 * timeout each time to rediscover the same fact. Where a refused connection is
 * cheap that is invisible; where it is not, it is the dominant cost of learning
 * that a database is unreachable.
 *
 * These tests pin attempt COUNTS rather than durations: the count is the defect,
 * and it is identical on every platform.
 */
describe('postgres polyfills: an unreachable database is discovered once, not once per statement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** More than one polyfill, or "stops early" vs "ran them all" is untestable. */
  it('has several statements to run', () => {
    expect(POSTGRES_POLYFILLS.length).toBeGreaterThan(1);
  });

  it('stops at the first statement when the connection itself is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let attempts = 0;
    await registerPostgresPolyfills(() => {
      attempts += 1;
      return Promise.reject(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
      );
    });
    expect(attempts).toBe(1);
  });

  it.each([
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND db.example.invalid'],
    ['ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.1:5432'],
    ['28P01', 'password authentication failed for user "nobody"'],
    ['3D000', 'database "none" does not exist'],
  ])('stops at the first statement for a %s failure too', async (code, message) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let attempts = 0;
    await registerPostgresPolyfills(() => {
      attempts += 1;
      return Promise.reject(Object.assign(new Error(message), { code }));
    });
    expect(attempts).toBe(1);
  });

  it('says why it stopped — stopping early is not staying quiet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await registerPostgresPolyfills(() =>
      Promise.reject(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
      ),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(' ')).toMatch(/could not reach the database/i);
    expect(warn.mock.calls[0]?.join(' ')).toMatch(/ECONNREFUSED/);
  });

  it('still tries every statement when a permission refusal is what came back', async () => {
    // A scoped member cannot create these and does not need to — the owner
    // already did. Each statement is genuinely independent here, so the loop
    // must keep going, and the noise stays collapsed into one debug line.
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let attempts = 0;
    await registerPostgresPolyfills(() => {
      attempts += 1;
      return Promise.reject(new Error('permission denied for schema public'));
    });
    expect(attempts).toBe(POSTGRES_POLYFILLS.length);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still tries every statement when the failure is not one it recognizes', async () => {
    // Unrecognized errors take the cautious branch: assume statement-level, so a
    // provider quirk on one statement cannot silently skip the rest.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let attempts = 0;
    await registerPostgresPolyfills(() => {
      attempts += 1;
      return Promise.reject(new Error('extension "pgcrypto" is not available'));
    });
    expect(attempts).toBe(POSTGRES_POLYFILLS.length);
  });

  it('runs every statement when they all succeed', async () => {
    let attempts = 0;
    await registerPostgresPolyfills(() => {
      attempts += 1;
      return Promise.resolve();
    });
    expect(attempts).toBe(POSTGRES_POLYFILLS.length);
  });
});
