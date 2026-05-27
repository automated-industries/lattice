import { describe, it, expect } from 'vitest';
import { createDecipheriv } from 'node:crypto';
import {
  aesGcmEncrypt,
  constantTimeEqualHex,
  sha256Bytes,
  sha256Hex,
} from '../../src/teams/invite-crypto.js';

describe('invite-crypto', () => {
  it('sha256Hex produces a stable 64-char lowercase hex digest', () => {
    const h = sha256Hex('latinv_0000000000');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('latinv_0000000000')).toBe(h);
  });

  it('aesGcmEncrypt round-trips through node:crypto with the right key + AAD', () => {
    const rawToken = 'latinv_' + 'a'.repeat(48);
    const plaintext = 'postgres://example.test/db';
    const { ciphertextHex, ivHex } = aesGcmEncrypt(plaintext, rawToken);

    const tokenDigest = sha256Bytes(rawToken);
    const key = tokenDigest.subarray(0, 32);
    const iv = Buffer.from(ivHex, 'hex');
    const ctTag = Buffer.from(ciphertextHex, 'hex');
    const ciphertext = ctTag.subarray(0, ctTag.length - 16);
    const tag = ctTag.subarray(ctTag.length - 16);
    const aad = Buffer.from(Buffer.from(tokenDigest).toString('hex'), 'utf8');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(aad);
    const decoded = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    expect(decoded).toBe(plaintext);
  });

  it('aesGcmEncrypt uses a fresh IV per call', () => {
    const a = aesGcmEncrypt('x', 'latinv_token');
    const b = aesGcmEncrypt('x', 'latinv_token');
    expect(a.ivHex).not.toBe(b.ivHex);
  });

  it('wrong key fails to decrypt (auth tag mismatch)', () => {
    const rawToken = 'latinv_correct';
    const { ciphertextHex, ivHex } = aesGcmEncrypt('secret', rawToken);

    const wrongKey = sha256Bytes('latinv_wrong').subarray(0, 32);
    const iv = Buffer.from(ivHex, 'hex');
    const ctTag = Buffer.from(ciphertextHex, 'hex');
    const ciphertext = ctTag.subarray(0, ctTag.length - 16);
    const tag = ctTag.subarray(ctTag.length - 16);
    const aad = Buffer.from(Buffer.from(sha256Bytes(rawToken)).toString('hex'), 'utf8');

    const decipher = createDecipheriv('aes-256-gcm', wrongKey, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(aad);
    expect(() => {
      decipher.update(ciphertext);
      decipher.final();
    }).toThrow();
  });

  it('wrong AAD fails to decrypt', () => {
    const rawToken = 'latinv_correct';
    const { ciphertextHex, ivHex } = aesGcmEncrypt('secret', rawToken);

    const tokenDigest = sha256Bytes(rawToken);
    const key = tokenDigest.subarray(0, 32);
    const iv = Buffer.from(ivHex, 'hex');
    const ctTag = Buffer.from(ciphertextHex, 'hex');
    const ciphertext = ctTag.subarray(0, ctTag.length - 16);
    const tag = ctTag.subarray(ctTag.length - 16);
    const wrongAad = Buffer.from('0'.repeat(64), 'utf8');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(wrongAad);
    expect(() => {
      decipher.update(ciphertext);
      decipher.final();
    }).toThrow();
  });

  it('constantTimeEqualHex returns true for equal hex of the same length', () => {
    expect(constantTimeEqualHex('abcd', 'abcd')).toBe(true);
  });

  it('constantTimeEqualHex returns false for mismatched lengths', () => {
    expect(constantTimeEqualHex('abcd', 'abcdef')).toBe(false);
  });

  it('constantTimeEqualHex returns false for same-length differing values', () => {
    expect(constantTimeEqualHex('abcd', 'abce')).toBe(false);
  });
});
