/**
 * Crypto-shred (Stage 3) — cryptographic erasure for sources flagged sensitive.
 * A value sealed under a source's key is opaque without it; destroying the key
 * makes the value unrecoverable, which is the durable, backup-proof half of
 * "forget this source".
 */
import { describe, it, expect } from 'vitest';
import {
  InMemorySourceKeyStore,
  SourceShreddedError,
  sealUnderSource,
  openUnderSource,
  shredSource,
} from '../../src/cloud/shred.js';

describe('crypto-shred', () => {
  it('seals + opens a value under its source key (round-trip)', () => {
    const store = new InMemorySourceKeyStore();
    const sealed = sealUnderSource('555-0100', 'fileF', store);
    expect(sealed).not.toContain('555-0100'); // opaque
    expect(openUnderSource(sealed, 'fileF', store)).toBe('555-0100');
  });

  it('shredding the source makes the value permanently unrecoverable', () => {
    const store = new InMemorySourceKeyStore();
    const sealed = sealUnderSource('secret', 'fileF', store);
    shredSource('fileF', store);
    expect(() => openUnderSource(sealed, 'fileF', store)).toThrow(SourceShreddedError);
    // Even re-creating a key for the same source id can't recover it (new key ≠ old key).
    expect(() => openUnderSource(sealed, 'fileF', store)).toThrow(/unrecoverable/);
  });

  it('shredding one source does not affect another', () => {
    const store = new InMemorySourceKeyStore();
    const f = sealUnderSource('from-F', 'fileF', store);
    const g = sealUnderSource('from-G', 'fileG', store);
    shredSource('fileF', store);
    expect(() => openUnderSource(f, 'fileF', store)).toThrow(SourceShreddedError);
    expect(openUnderSource(g, 'fileG', store)).toBe('from-G');
  });

  it('each source gets a distinct key (ciphertexts differ across sources)', () => {
    const store = new InMemorySourceKeyStore();
    const a = sealUnderSource('same', 'fileF', store);
    const b = sealUnderSource('same', 'fileG', store);
    expect(a).not.toBe(b);
    // A value sealed under F cannot be opened with G's key.
    expect(() => openUnderSource(a, 'fileG', store)).toThrow();
  });

  it('shred is idempotent', () => {
    const store = new InMemorySourceKeyStore();
    sealUnderSource('x', 'fileF', store);
    shredSource('fileF', store);
    expect(() => {
      shredSource('fileF', store);
    }).not.toThrow();
  });
});
