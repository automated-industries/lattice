import { describe, it, expect } from 'vitest';
import { withRetry, isRetryableDbError } from '../../src/db/retry.js';

const noSleep = (): Promise<void> => Promise.resolve();

/** A DB-style error: an Error carrying a `.code` (as better-sqlite3 / pg throw). */
function dbErr(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

describe('isRetryableDbError', () => {
  it('classifies SQLITE_BUSY / locked', () => {
    expect(isRetryableDbError({ code: 'SQLITE_BUSY' })).toBe(true);
    expect(isRetryableDbError({ code: 'SQLITE_LOCKED' })).toBe(true);
    expect(isRetryableDbError({ message: 'database is locked' })).toBe(true);
  });

  it('classifies retryable Postgres SQLSTATEs', () => {
    expect(isRetryableDbError({ code: '40001' })).toBe(true); // serialization_failure
    expect(isRetryableDbError({ code: '40P01' })).toBe(true); // deadlock
    expect(isRetryableDbError({ code: '08006' })).toBe(true); // connection_failure
  });

  it('classifies dropped sockets', () => {
    expect(isRetryableDbError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableDbError({ message: 'Connection terminated unexpectedly' })).toBe(true);
  });

  it('does not classify ordinary errors as retryable', () => {
    expect(isRetryableDbError({ code: '23505' })).toBe(false); // unique_violation
    expect(isRetryableDbError(new Error('syntax error'))).toBe(false);
    expect(isRetryableDbError(null)).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the value on first success', async () => {
    const r = await withRetry(() => Promise.resolve(42), { sleep: noSleep });
    expect(r).toBe(42);
  });

  it('retries a transient error then succeeds', async () => {
    let calls = 0;
    const r = await withRetry(
      () => {
        calls++;
        if (calls < 3) return Promise.reject(dbErr('SQLITE_BUSY'));
        return Promise.resolve('ok');
      },
      { sleep: noSleep, random: () => 0.5 },
    );
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws immediately on a non-retryable error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          return Promise.reject(new Error('unique_violation'));
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow('unique_violation');
    expect(calls).toBe(1);
  });

  it('exhausts maxAttempts on a persistent retryable error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          return Promise.reject(dbErr('SQLITE_BUSY', 'busy'));
        },
        { sleep: noSleep, maxAttempts: 4, random: () => 0.1 },
      ),
    ).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    expect(calls).toBe(4);
  });

  it('does not nest — an inner withRetry runs fn once', async () => {
    let inner = 0;
    const r = await withRetry(
      () =>
        withRetry(
          () => {
            inner++;
            if (inner < 5) return Promise.reject(dbErr('SQLITE_BUSY'));
            return Promise.resolve('done');
          },
          { sleep: noSleep },
        ),
      { sleep: noSleep, maxAttempts: 10, random: () => 0.5 },
    );
    // The OUTER retry drives the attempts; the inner one is a pass-through, so
    // total calls equal the outer attempts, not attempts * attempts.
    expect(r).toBe('done');
    expect(inner).toBe(5);
  });

  it('invokes onRetry with the attempt number', async () => {
    const attempts: number[] = [];
    let calls = 0;
    await withRetry(
      () => {
        calls++;
        if (calls < 3) return Promise.reject(dbErr('40001'));
        return Promise.resolve('ok');
      },
      { sleep: noSleep, random: () => 0.5, onRetry: (_e, a) => attempts.push(a) },
    );
    expect(attempts).toEqual([1, 2]);
  });
});
