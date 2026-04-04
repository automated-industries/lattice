import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const PREFIX = 'enc:';

/**
 * Derive a 256-bit AES key from a master password using scrypt.
 * The salt is fixed per Lattice instance — callers should use a unique
 * master key per database.
 */
export function deriveKey(masterKey: string): Buffer {
  return scryptSync(masterKey, 'lattice-enc-v1', 32);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns `enc:<base64(iv + authTag + ciphertext)>`.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a ciphertext string produced by {@link encrypt}.
 * Returns the original plaintext. If the input doesn't start with `enc:`,
 * returns it unchanged (plaintext passthrough for migration safety).
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  if (!ciphertext.startsWith(PREFIX)) return ciphertext;
  const buf = Buffer.from(ciphertext.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString('utf8') + decipher.final('utf8');
}

/**
 * Check whether a value is an encrypted ciphertext.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Columns that are never encrypted (structural, not user data). */
const SKIP_COLUMNS = new Set([
  'id',
  'created_at',
  'updated_at',
  'deleted_at',
  'source_file',
  'source_hash',
]);

/**
 * Determine which columns should be encrypted for a given entity context.
 *
 * @param encrypted - The `encrypted` option from EntityContextDefinition.
 *   `true` encrypts all TEXT columns except structural ones.
 *   `{ columns: [...] }` encrypts only the named columns.
 * @param allColumns - All column names for the table.
 */
export function resolveEncryptedColumns(
  encrypted: boolean | { columns: string[] },
  allColumns: string[],
): Set<string> {
  if (typeof encrypted === 'object' && 'columns' in encrypted) {
    return new Set(encrypted.columns);
  }
  // encrypted === true → all text columns except structural
  return new Set(allColumns.filter((c) => !SKIP_COLUMNS.has(c)));
}
