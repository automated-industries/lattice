/**
 * Durable retry for transient database failures.
 *
 * Under contention a database returns retryable errors that a robust app should
 * simply re-attempt: SQLite `SQLITE_BUSY`, Postgres serialization failures
 * (`40001`) and deadlocks (`40P01` / `40P02`), and dropped connections. `withRetry`
 * re-runs an operation through a bounded, decorrelated-jitter backoff so these
 * blips don't surface as user-facing failures.
 *
 * CRITICAL: only wrap **idempotent** work — a whole bulk operation or a Lattice
 * API method that is safe to re-run, NOT a raw non-idempotent `adapter.run()`
 * (re-running an `INSERT` after a mid-statement connection drop could double-apply
 * it). A nested `withRetry` is detected and does NOT add a second retry layer, so
 * composing retry-wrapped helpers can't multiply the attempt count.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RetryOptions {
  /** Maximum attempts including the first. Default 5. */
  maxAttempts?: number;
  /** Base backoff in ms. Default 50. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 2000. */
  maxDelayMs?: number;
  /** Override the retryable-error classifier. */
  isRetryable?: (err: unknown) => boolean;
  /** Called before each retry (for logging/metrics). */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injectable RNG in [0,1) for deterministic tests. Default Math.random. */
  random?: () => number;
  /** Injectable sleep for deterministic tests. Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Postgres SQLSTATE codes that are safe to retry. */
const RETRYABLE_PG_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '40P02', // (reserved deadlock variant)
  '55P03', // lock_not_available
  '57P01', // admin_shutdown (connection dropped)
  '08006', // connection_failure
  '08003', // connection_does_not_exist
  '08000', // connection_exception
]);

/** Node socket error codes that indicate a dropped/reset connection. */
const RETRYABLE_NODE_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED']);

/** Default classifier: SQLITE_BUSY / locked, retryable PG SQLSTATEs, dropped sockets. */
export function isRetryableDbError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  if (code) {
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code.startsWith('SQLITE_BUSY')) {
      return true;
    }
    if (RETRYABLE_PG_CODES.has(code)) return true;
    if (RETRYABLE_NODE_CODES.has(code)) return true;
  }
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return (
    msg.includes('database is locked') ||
    msg.includes('connection terminated') ||
    msg.includes('connection reset') ||
    msg.includes('server closed the connection')
  );
}

/** Tracks whether the current async context is already inside a withRetry. */
const retryDepth = new AsyncLocalStorage<boolean>();

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run `fn`, retrying transient DB failures with decorrelated-jitter backoff.
 * A nested call (already inside a `withRetry`) runs `fn` directly without a
 * second retry layer.
 *
 * @throws the last error if every attempt fails, or immediately for a
 *   non-retryable error.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  // Nested-retry guard: don't multiply attempts when retry-wrapped helpers compose.
  if (retryDepth.getStore()) return fn();

  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelay = opts.baseDelayMs ?? 50;
  const maxDelay = opts.maxDelayMs ?? 2000;
  const isRetryable = opts.isRetryable ?? isRetryableDbError;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;

  return retryDepth.run(true, async () => {
    let prevDelay = baseDelay;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === maxAttempts) throw err;
        // Decorrelated jitter: delay = min(maxDelay, random in [base, prev*3]).
        const delay = Math.min(maxDelay, baseDelay + random() * (prevDelay * 3 - baseDelay));
        prevDelay = delay;
        opts.onRetry?.(err, attempt, delay);
        await sleep(delay);
      }
    }
    // Unreachable (loop either returns or throws), but satisfies the type checker.
    throw lastErr;
  });
}
