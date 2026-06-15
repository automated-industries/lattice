import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { SourceKeyStore } from './shred.js';

/**
 * Durable, file-backed {@link SourceKeyStore} for production deployments.
 *
 * The default {@link InMemorySourceKeyStore} keeps source keys in process
 * memory only — a restart implicitly shreds every key, making every
 * sealed value unrecoverable. For real crypto-shred semantics you need a
 * shred-DURABLE store: keys that survive restarts but can be irreversibly
 * destroyed when you want to forget a source.
 *
 * This store writes keys to a single JSON file (one map of sourceId →
 * 32-byte AES key, base64-encoded). The file is created with mode 0600
 * and rewritten atomically (write-then-rename) on every change. An
 * optional passphrase enables AES-256-GCM encryption-at-rest using
 * scrypt-derived keys, so a stolen file is unreadable without the secret.
 *
 * **Threat-model note.** Keys should live SEPARATE from data so a
 * database compromise alone doesn't surrender every shredded value's
 * plaintext. This store satisfies that when its file is on a separate
 * filesystem / volume / backup-policy from the Postgres data — the
 * common production pattern is to mount this file from a secrets volume
 * (AWS Secrets Manager file ref, mounted via Secrets Store CSI; or a
 * dedicated EBS volume excluded from DB backups). Keeping the file on
 * the same disk as Postgres data is *better than InMemory* but does not
 * provide the strongest crypto-shred guarantee.
 *
 * For KMS-backed deployments, implement {@link SourceKeyStore} directly
 * against the KMS API — this class is the simplest durable option for
 * teams who don't want a KMS dependency.
 */

export interface FileSourceKeyStoreOptions {
  /**
   * Absolute or relative filesystem path where the key map is persisted.
   * Created if missing along with its parent directory. The file is
   * always chmod'd to 0600 (owner read/write only) on write.
   */
  path: string;

  /**
   * Optional passphrase. When set, the file is encrypted at rest with
   * AES-256-GCM under a scrypt-derived key (random salt per write). When
   * omitted, the file is stored as plaintext JSON — only acceptable if
   * the underlying filesystem already enforces secrecy (e.g. a Secrets
   * Manager mount, an LUKS-encrypted volume, or an HSM-backed disk).
   */
  passphrase?: string;
}

type KeyMap = Record<string, string>;

// Marker for encrypted-at-rest format. Plain JSON files start with '{'; the
// encrypted format starts with this magic so we can detect on read without
// extra metadata files.
const ENC_HEADER = 'LATTICE-KMS-v1\n';

// scrypt params — N=2^15 gives ~150ms derivation on a typical server,
// fast enough that key-rewrite isn't intolerable while still expensive
// for an offline attacker. r/p at defaults are conventional for AES-256-GCM.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

export class FileSourceKeyStore implements SourceKeyStore {
  private readonly path: string;
  private readonly passphrase: string | undefined;
  private readonly cache: Map<string, Buffer>;

  constructor(opts: FileSourceKeyStoreOptions) {
    if (!opts.path || typeof opts.path !== 'string') {
      throw new Error('lattice: FileSourceKeyStore requires a non-empty `path`');
    }
    this.path = resolve(opts.path);
    this.passphrase = opts.passphrase;
    this.cache = this.load();
  }

  get(sourceId: string): Buffer | undefined {
    return this.cache.get(sourceId);
  }

  getOrCreate(sourceId: string): Buffer {
    let key = this.cache.get(sourceId);
    if (!key) {
      key = randomBytes(KEY_LEN);
      this.cache.set(sourceId, key);
      this.persist();
    }
    return key;
  }

  destroy(sourceId: string): void {
    const key = this.cache.get(sourceId);
    if (key) key.fill(0); // best-effort wipe of the in-memory copy before drop
    if (this.cache.delete(sourceId)) {
      this.persist();
    }
  }

  /**
   * Number of keys currently held — useful for diagnostics. Not part of
   * the SourceKeyStore interface.
   */
  size(): number {
    return this.cache.size;
  }

  // ── internals ────────────────────────────────────────────────────────

  private load(): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    if (!existsSync(this.path)) {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      return out;
    }
    const raw = readFileSync(this.path);
    const json = this.decodeFile(raw);
    for (const [sourceId, b64] of Object.entries(json)) {
      try {
        const key = Buffer.from(b64, 'base64');
        if (key.length !== KEY_LEN) continue; // skip malformed entries
        out.set(sourceId, key);
      } catch {
        // skip any entry that can't be base64-decoded
      }
    }
    return out;
  }

  private persist(): void {
    const obj: KeyMap = {};
    for (const [k, v] of this.cache) obj[k] = v.toString('base64');
    const encoded = this.encodeFile(obj);

    // Atomic write: write to a sibling temp file then rename. Avoids a
    // half-written file if the process dies mid-write — either the old
    // file is intact or the new one is fully present.
    const tmpPath = `${this.path}.tmp-${process.pid.toString()}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmpPath, encoded, { mode: 0o600 });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // chmod is best-effort on platforms that don't honor POSIX modes (Windows)
    }
    renameSync(tmpPath, this.path);
  }

  private decodeFile(raw: Buffer): KeyMap {
    const text = raw.toString('utf8');
    const looksEncrypted = text.startsWith(ENC_HEADER);
    if (looksEncrypted && !this.passphrase) {
      throw new Error(
        'lattice: key file is encrypted (ENC_HEADER present) but no passphrase was provided',
      );
    }
    if (!looksEncrypted && this.passphrase) {
      // Plaintext JSON but caller expects encrypted — auto-migrate on next write.
      // Accept the plaintext for this read so we don't lose existing keys.
      return JSON.parse(text) as KeyMap;
    }
    if (!looksEncrypted) {
      return JSON.parse(text) as KeyMap;
    }
    const body = text.slice(ENC_HEADER.length);
    // body format: <salt-hex>:<iv-hex>:<ciphertext+tag-hex>
    const parts = body.split(':');
    if (parts.length !== 3) {
      throw new Error('lattice: encrypted key file is malformed');
    }
    const [saltHex, ivHex, ctTagHex] = parts;
    if (!saltHex || !ivHex || !ctTagHex) {
      throw new Error('lattice: encrypted key file is missing components');
    }
    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const ctAndTag = Buffer.from(ctTagHex, 'hex');
    if (ctAndTag.length < TAG_LEN) {
      throw new Error('lattice: encrypted key file is truncated');
    }
    const ct = ctAndTag.subarray(0, ctAndTag.length - TAG_LEN);
    const tag = ctAndTag.subarray(ctAndTag.length - TAG_LEN);
    const { passphrase } = this;
    if (passphrase === undefined) {
      throw new Error('lattice: key file is encrypted but no passphrase was configured');
    }
    const derived = scryptSync(passphrase, salt, KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024, // raise Node's default 32MB cap so N=2^15 fits
    });
    const decipher = createDecipheriv('aes-256-gcm', derived, iv);
    decipher.setAuthTag(tag);
    let plaintext: string;
    try {
      plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('lattice: key file decryption failed — wrong passphrase or file tampered');
    }
    return JSON.parse(plaintext) as KeyMap;
  }

  private encodeFile(obj: KeyMap): Buffer {
    const json = JSON.stringify(obj);
    if (!this.passphrase) {
      return Buffer.from(json, 'utf8');
    }
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const derived = scryptSync(this.passphrase, salt, KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024,
    });
    const cipher = createCipheriv('aes-256-gcm', derived, iv);
    const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const body = `${salt.toString('hex')}:${iv.toString('hex')}:${Buffer.concat([ct, tag]).toString('hex')}`;
    return Buffer.from(`${ENC_HEADER}${body}`, 'utf8');
  }
}
