/**
 * Pure-Node crypto helpers for the invite relay.
 *
 * The inviter side derives an AES-256-GCM key from the raw invite token,
 * encrypts the cloud URL with a fresh per-envelope IV, and POSTs the
 * ciphertext to latticesql.com along with hashed lookups. The relay
 * never sees the plaintext URL or the raw token.
 *
 * Algorithm:
 *   tokenDigest = SHA-256(rawToken UTF-8 bytes)         32 bytes
 *   key         = tokenDigest[0..31]                    AES-256 key
 *   aad         = hex(tokenDigest)                      64 ASCII chars
 *   iv          = crypto.randomBytes(12)                fresh per envelope
 *   ciphertext  = AES-256-GCM-encrypt(plaintext, key, iv, aad) || tag
 *
 * Each token produces a unique key, so per-envelope random IVs are safe
 * even if the same plaintext is encrypted repeatedly under different
 * tokens. Binding the AAD to the digest defends against an attacker who
 * swaps ciphertexts between KV slots.
 */

import { createCipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;

export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return createHash('sha256').update(buf).digest();
}

export function sha256Hex(input: string | Uint8Array): string {
  return Buffer.from(sha256Bytes(input)).toString('hex');
}

export interface AesGcmEnvelope {
  ciphertextHex: string;
  ivHex: string;
}

export function aesGcmEncrypt(plaintext: string, rawToken: string): AesGcmEnvelope {
  const tokenDigest = sha256Bytes(rawToken);
  const key = tokenDigest.slice(0, 32);
  const aad = Buffer.from(Buffer.from(tokenDigest).toString('hex'), 'utf8');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertextHex: Buffer.concat([enc, tag]).toString('hex'),
    ivHex: iv.toString('hex'),
  };
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
