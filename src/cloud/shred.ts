import { randomBytes } from 'node:crypto';
import { encrypt, decrypt } from '../security/encryption.js';

/**
 * Cryptographic erasure ("crypto-shred") for sources flagged sensitive.
 *
 * Un-sharing or deleting a source already removes its derived values from every
 * viewer's fold (the fold only includes observations whose sources are visible —
 * see ./fold.ts). But the bytes can linger in backups and WAL. For a legal /
 * GDPR "right to be forgotten", a source flagged `source_sensitive` gets a
 * stronger guarantee: every value derived from it is stored ENCRYPTED under a
 * key unique to that source. To forget the source you destroy its key — and the
 * derived values become unrecoverable everywhere the ciphertext exists, backups
 * included, because the key never lived in the row.
 *
 * The key store is pluggable so the keys can live somewhere shred-durable and
 * separate from the data (a KMS, a key table on a different retention policy).
 * The default in-memory store is for tests + single-process use.
 */

/** Holds the per-source AES keys. Destroying a key is the erasure operation. */
export interface SourceKeyStore {
  /** The key for a source, or undefined if it was never created / has been shredded. */
  get(sourceId: string): Buffer | undefined;
  /** The key for a source, creating a fresh random 256-bit key on first use. */
  getOrCreate(sourceId: string): Buffer;
  /** Destroy a source's key — irreversibly. Values sealed under it can no longer
   *  be opened, anywhere. Idempotent. */
  destroy(sourceId: string): void;
}

/** In-memory {@link SourceKeyStore}. Keys vanish with the process — fine for
 *  tests; production should persist keys in a shred-durable store. */
export class InMemorySourceKeyStore implements SourceKeyStore {
  private readonly keys = new Map<string, Buffer>();

  get(sourceId: string): Buffer | undefined {
    return this.keys.get(sourceId);
  }

  getOrCreate(sourceId: string): Buffer {
    let key = this.keys.get(sourceId);
    if (!key) {
      key = randomBytes(32); // a random 256-bit key — NOT derived, so destroying it is true erasure
      this.keys.set(sourceId, key);
    }
    return key;
  }

  destroy(sourceId: string): void {
    const key = this.keys.get(sourceId);
    if (key) key.fill(0); // best-effort wipe of the buffer before dropping the reference
    this.keys.delete(sourceId);
  }
}

/** Error thrown when opening a value whose source key has been shredded. */
export class SourceShreddedError extends Error {
  constructor(public readonly sourceId: string) {
    super(
      `lattice: source "${sourceId}" has been cryptographically shredded — value unrecoverable`,
    );
    this.name = 'SourceShreddedError';
  }
}

/**
 * Encrypt a derived value under its (sensitive) source's key, creating the key on
 * first use. The returned ciphertext is opaque without the source key.
 */
export function sealUnderSource(
  plaintext: string,
  sourceId: string,
  store: SourceKeyStore,
): string {
  return encrypt(plaintext, store.getOrCreate(sourceId));
}

/**
 * Decrypt a value sealed under a source's key. Throws {@link SourceShreddedError}
 * if the source has been shredded (the key is gone) — the value is unrecoverable,
 * which is the intended "forgotten" state, not an error to paper over.
 */
export function openUnderSource(
  ciphertext: string,
  sourceId: string,
  store: SourceKeyStore,
): string {
  const key = store.get(sourceId);
  if (!key) throw new SourceShreddedError(sourceId);
  return decrypt(ciphertext, key);
}

/**
 * Cryptographically shred a source: destroy its key so every value sealed under
 * it is unrecoverable everywhere the ciphertext exists (live rows, backups, WAL).
 * Pair with the fold-level revocation (which removes the value from live views) —
 * this is the durable, backup-proof half for legally-sensitive sources.
 */
export function shredSource(sourceId: string, store: SourceKeyStore): void {
  store.destroy(sourceId);
}
