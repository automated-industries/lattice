import { describe, it, expect } from 'vitest';
import { deriveKey, encrypt, decrypt } from '../../src/security/encryption.js';

/**
 * deriveKey runs a deliberately expensive, blocking scryptSync. Every credential
 * read/write used to re-derive, so one connector sync fired thousands of scrypts
 * back-to-back and froze the event loop. deriveKey now memoizes by master-key
 * value. These pin BOTH the perf property (cache hit ⇒ no re-derive) and that
 * correctness is unchanged (deterministic + safe when the key changes).
 */
describe('deriveKey memoization (event-loop freeze fix)', () => {
  it('returns the SAME buffer for repeated calls with the same master key (cache hit — scrypt not re-run)', () => {
    const a = deriveKey('master-key-abc');
    const b = deriveKey('master-key-abc');
    expect(b).toBe(a); // reference identity ⇒ memoized, not recomputed
  });

  it('re-derives for a DIFFERENT master key (keyed by value ⇒ safe across key changes)', () => {
    const a = deriveKey('key-one');
    const b = deriveKey('key-two');
    expect(b).not.toBe(a);
    expect(b.equals(a)).toBe(false);
  });

  it('is deterministic: switching keys away and back reproduces identical bytes (fixed salt)', () => {
    const first = Buffer.from(deriveKey('determinism-key')); // copy before eviction
    deriveKey('evict-with-other-key'); // evict the memo
    const again = deriveKey('determinism-key'); // cache miss ⇒ recompute
    expect(again.equals(first)).toBe(true);
  });

  it('the memoized key still encrypts/decrypts round-trip', () => {
    const k = deriveKey('round-trip-key');
    expect(decrypt(encrypt('secret-token', k), k)).toBe('secret-token');
  });
});
