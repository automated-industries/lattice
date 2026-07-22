import { describe, it, expect } from 'vitest';
import { EncryptionLayer, DecryptionKeyError } from '../../src/security/encryption-layer.js';

// Build a ready-to-use layer keyed with `key`, encrypting the named columns of
// the `secrets` table (mirrors how Lattice wires the native secrets entity).
async function makeLayer(key: string, cols: string[]): Promise<EncryptionLayer> {
  const layer = new EncryptionLayer({
    encryptionKeyRaw: key,
    getEntityContexts: () => [['secrets', { encrypted: { columns: cols } }]],
    getTables: () => [],
    introspectColumns: () => Promise.resolve(cols),
  });
  await layer.finalizeSetup();
  return layer;
}

describe('EncryptionLayer key mismatch', () => {
  it('decryptRow throws an actionable DecryptionKeyError, not the raw OpenSSL string', async () => {
    const a = await makeLayer('key-A', ['value']);
    const b = await makeLayer('key-B', ['value']);

    const enc = a.encryptRow('secrets', { id: '1', value: 'sk-secret' });
    expect(enc.value).not.toBe('sk-secret'); // actually encrypted
    expect(String(enc.value)).toMatch(/^enc:/);

    // Wrong key → the error names LATTICE_ENCRYPTION_KEY and how to fix it,
    // instead of "Unsupported state or unable to authenticate data".
    let thrown: unknown;
    try {
      b.decryptRow('secrets', { ...enc });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DecryptionKeyError);
    expect((thrown as Error).message).toMatch(/LATTICE_ENCRYPTION_KEY/);
    expect((thrown as Error).message).not.toMatch(/unable to authenticate|Unsupported state/i);
    // the raw crypto error is preserved as the cause for debugging
    expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it('the correct key still round-trips (no false positive on valid data)', async () => {
    const a = await makeLayer('key-A', ['value']);
    const enc = a.encryptRow('secrets', { id: '1', value: 'sk-secret' });
    expect(a.decryptRow('secrets', { ...enc }).value).toBe('sk-secret');
  });

  it('a plaintext (non-enc:) value passes through without a spurious mismatch error', async () => {
    const a = await makeLayer('key-A', ['value']);
    // Legacy/plaintext row — decrypt is a passthrough, must not throw.
    expect(a.decryptRow('secrets', { id: '1', value: 'plain-text' }).value).toBe('plain-text');
  });
});
