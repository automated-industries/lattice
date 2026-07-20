import { describe, it, expect } from 'vitest';
import { sanitizeConnectorError } from '../../src/connectors/registry.js';

/**
 * `last_error` is member-visible via GET /api/connectors. A raw DB conflict error
 * can echo the conflicting key value (another member's data) — an existence oracle.
 * Constraint/conflict errors must genericize (no value); other errors pass through
 * bounded.
 */
describe('sanitizeConnectorError', () => {
  it('genericizes a Postgres unique/PK violation (drops the leaked key value)', () => {
    const raw =
      'error: duplicate key value violates unique constraint "gmail_threads_pkey" DETAIL: Key (thread_id)=(18f2a) already exists.';
    const out = sanitizeConnectorError(raw);
    expect(out).not.toContain('18f2a');
    expect(out).not.toContain('thread_id');
    expect(out).toMatch(/conflict/i);
  });

  it('genericizes a SQLite constraint error', () => {
    const out = sanitizeConnectorError(
      'SQLITE_CONSTRAINT: UNIQUE constraint failed: monday_items.item_id',
    );
    expect(out).not.toContain('monday_items');
    expect(out).toMatch(/conflict/i);
  });

  it('passes through a non-constraint (network/auth) error, bounded', () => {
    expect(sanitizeConnectorError('fetch failed: ECONNREFUSED')).toBe('fetch failed: ECONNREFUSED');
    const long = 'x'.repeat(900);
    expect(sanitizeConnectorError(long).length).toBeLessThanOrEqual(501);
  });
});
