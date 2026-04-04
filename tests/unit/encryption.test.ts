import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  deriveKey,
  isEncrypted,
  resolveEncryptedColumns,
} from '../../src/security/encryption.js';

describe('encryption utilities', () => {
  const key = deriveKey('test-master-key');

  it('encrypts and decrypts a string round-trip', () => {
    const plaintext = 'sk-ant-api03-secret-key-value';
    const ciphertext = encrypt(plaintext, key);
    expect(ciphertext).toMatch(/^enc:/);
    expect(ciphertext).not.toContain(plaintext);
    expect(decrypt(ciphertext, key)).toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const a = encrypt('same-value', key);
    const b = encrypt('same-value', key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe('same-value');
    expect(decrypt(b, key)).toBe('same-value');
  });

  it('passes through plaintext without enc: prefix', () => {
    expect(decrypt('not-encrypted', key)).toBe('not-encrypted');
  });

  it('isEncrypted detects the prefix', () => {
    expect(isEncrypted('enc:abc')).toBe(true);
    expect(isEncrypted('plain-value')).toBe(false);
  });

  it('throws on decryption with wrong key', () => {
    const ciphertext = encrypt('secret', key);
    const wrongKey = deriveKey('wrong-key');
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });

  it('handles empty string', () => {
    const ciphertext = encrypt('', key);
    expect(decrypt(ciphertext, key)).toBe('');
  });

  it('handles unicode content', () => {
    const plaintext = 'Héllo Wörld 🔑 日本語';
    const ciphertext = encrypt(plaintext, key);
    expect(decrypt(ciphertext, key)).toBe(plaintext);
  });
});

describe('resolveEncryptedColumns', () => {
  const allColumns = [
    'id',
    'name',
    'value',
    'description',
    'created_at',
    'updated_at',
    'deleted_at',
  ];

  it('with true: encrypts all columns except structural', () => {
    const cols = resolveEncryptedColumns(true, allColumns);
    expect(cols.has('name')).toBe(true);
    expect(cols.has('value')).toBe(true);
    expect(cols.has('description')).toBe(true);
    expect(cols.has('id')).toBe(false);
    expect(cols.has('created_at')).toBe(false);
    expect(cols.has('updated_at')).toBe(false);
    expect(cols.has('deleted_at')).toBe(false);
  });

  it('with { columns }: encrypts only named columns', () => {
    const cols = resolveEncryptedColumns({ columns: ['value'] }, allColumns);
    expect(cols.has('value')).toBe(true);
    expect(cols.has('name')).toBe(false);
    expect(cols.has('description')).toBe(false);
  });
});
