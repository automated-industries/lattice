import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { decrypt, deriveKey, encrypt } from '../security/encryption.js';

/**
 * Machine-local lattice user config — small files that live outside any
 * single Lattice DB so a user's identity, encryption master key, saved
 * cloud-DB credentials, and per-team bearer tokens survive switching
 * projects. NOT a Lattice DB itself.
 *
 * Layout under `~/.lattice/`:
 *   master.key            32-byte AES key (base64). chmod 0600. Auto-
 *                         generated on first use. `LATTICE_ENCRYPTION_KEY`
 *                         env var takes precedence if set.
 *   identity.json         display_name + email (added in a later step).
 *   keys/<label>.token    per-joined-team bearer tokens (added later).
 *   db-credentials.enc    encrypted Postgres URLs (added later).
 *
 * Per Rule 7 (public-repo isolation), do NOT log filesystem paths or
 * user identity values from this module.
 */

/** Root directory for machine-local lattice config. Override via env. */
export function configDir(): string {
  return process.env.LATTICE_CONFIG_DIR ?? join(homedir(), '.lattice');
}

function ensureConfigDir(): string {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // Best-effort restrictive permissions on POSIX; no-op on Windows.
    if (platform() !== 'win32') {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // ignore — best-effort
      }
    }
  }
  return dir;
}

const MASTER_KEY_FILENAME = 'master.key';

/**
 * Resolve the lattice-wide encryption master key.
 *
 *   1. `LATTICE_ENCRYPTION_KEY` env var — when set, used verbatim.
 *   2. `~/.lattice/master.key` — read if present.
 *   3. Otherwise, generate 32 random bytes, write as base64 (chmod 0600
 *      on POSIX), and return.
 *
 * The returned string is suitable as the `encryptionKey` Lattice option;
 * scrypt-derivation happens inside `src/security/encryption.ts`.
 *
 * Losing `master.key` means losing the ability to decrypt anything
 * encrypted with it. Document loudly to consumers.
 */
export function getOrCreateMasterKey(): string {
  const envKey = process.env.LATTICE_ENCRYPTION_KEY;
  if (envKey && envKey.length > 0) return envKey;

  const dir = ensureConfigDir();
  const keyPath = join(dir, MASTER_KEY_FILENAME);
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf8').trim();
  }
  const key = randomBytes(32).toString('base64');
  writeFileSync(keyPath, key, 'utf8');
  if (platform() !== 'win32') {
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // best-effort
    }
  }
  return key;
}

// ---------------------------------------------------------------------------
// Identity — `~/.lattice/identity.json` { display_name, email }
// ---------------------------------------------------------------------------

const IDENTITY_FILENAME = 'identity.json';

export interface UserIdentity {
  display_name: string;
  email: string;
}

const EMPTY_IDENTITY: UserIdentity = { display_name: '', email: '' };

/**
 * Read the machine-local user identity. Returns `{display_name: '',
 * email: ''}` if the file is missing or malformed — callers can treat
 * empty fields as "not set yet" without a separate existence check.
 */
export function readIdentity(): UserIdentity {
  const dir = ensureConfigDir();
  const path = join(dir, IDENTITY_FILENAME);
  if (!existsSync(path)) return { ...EMPTY_IDENTITY };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UserIdentity>;
    return {
      display_name: typeof parsed.display_name === 'string' ? parsed.display_name : '',
      email: typeof parsed.email === 'string' ? parsed.email : '',
    };
  } catch {
    return { ...EMPTY_IDENTITY };
  }
}

/**
 * Persist the user identity. Only the two known keys are stored; any
 * extra fields the caller passed in are silently dropped.
 */
export function writeIdentity(identity: UserIdentity): void {
  const dir = ensureConfigDir();
  const path = join(dir, IDENTITY_FILENAME);
  const body = JSON.stringify(
    { display_name: identity.display_name, email: identity.email },
    null,
    2,
  );
  writeFileSync(path, body + '\n', 'utf8');
  if (platform() !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Saved DB credentials — `~/.lattice/db-credentials.enc`
// AES-GCM-encrypted JSON object: { [label]: postgresUrl }
// ---------------------------------------------------------------------------

const DB_CREDENTIALS_FILENAME = 'db-credentials.enc';

function loadCredentials(): Record<string, string> {
  const dir = ensureConfigDir();
  const path = join(dir, DB_CREDENTIALS_FILENAME);
  if (!existsSync(path)) return {};
  const key = deriveKey(getOrCreateMasterKey());
  try {
    const ciphertext = readFileSync(path, 'utf8').trim();
    const plaintext = decrypt(ciphertext, key);
    const parsed = JSON.parse(plaintext) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          ([, v]) => typeof v === 'string',
        ),
      ) as Record<string, string>;
    }
    return {};
  } catch {
    // Corrupt or unreadable — treat as empty rather than throwing.
    // The caller will simply not find the label they asked for.
    return {};
  }
}

function saveCredentials(creds: Record<string, string>): void {
  const dir = ensureConfigDir();
  const path = join(dir, DB_CREDENTIALS_FILENAME);
  const key = deriveKey(getOrCreateMasterKey());
  const ciphertext = encrypt(JSON.stringify(creds), key);
  writeFileSync(path, ciphertext + '\n', 'utf8');
  if (platform() !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort
    }
  }
}

/** Return the labels of all saved DB credentials. URLs are not exposed. */
export function listDbCredentials(): string[] {
  return Object.keys(loadCredentials()).sort();
}

/** Return the connection URL stored under `label`, or null if absent. */
export function getDbCredential(label: string): string | null {
  const creds = loadCredentials();
  return creds[label] ?? null;
}

/** Persist (or overwrite) the connection URL stored under `label`. */
export function saveDbCredential(label: string, url: string): void {
  const creds = loadCredentials();
  creds[label] = url;
  saveCredentials(creds);
}

/** Remove the connection URL stored under `label`. No-op if absent. */
export function deleteDbCredential(label: string): void {
  const creds = loadCredentials();
  if (!(label in creds)) return;
  delete creds[label];
  saveCredentials(creds);
}

// ---------------------------------------------------------------------------
// Per-team bearer tokens — `~/.lattice/keys/<label>.token`
// ---------------------------------------------------------------------------

const KEYS_SUBDIR = 'keys';
const TOKEN_EXT = '.token';

function ensureKeysDir(): string {
  const dir = join(ensureConfigDir(), KEYS_SUBDIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    if (platform() !== 'win32') {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // best-effort
      }
    }
  }
  return dir;
}

/**
 * Reject labels that would escape the keys/ directory or otherwise be
 * unsafe as a filename. Allow conservative ssh-style label characters.
 */
function assertSafeLabel(label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(label) || label.startsWith('.')) {
    throw new Error(`Invalid label "${label}": must match [A-Za-z0-9._-]+ and not start with .`);
  }
}

/** Return labels of all stored team tokens (each ends in `.token`). */
export function listTokens(): string[] {
  const dir = ensureKeysDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith(TOKEN_EXT))
    .map((f) => f.slice(0, -TOKEN_EXT.length))
    .sort();
}

/** Read the token stored under `label`, or null if absent. */
export function readToken(label: string): string | null {
  assertSafeLabel(label);
  const path = join(ensureKeysDir(), label + TOKEN_EXT);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim();
}

/** Persist (or overwrite) the token stored under `label` (chmod 0600). */
export function writeToken(label: string, token: string): void {
  assertSafeLabel(label);
  const path = join(ensureKeysDir(), label + TOKEN_EXT);
  writeFileSync(path, token + '\n', 'utf8');
  if (platform() !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort
    }
  }
}

/** Remove the token stored under `label`. No-op if absent. */
export function deleteToken(label: string): void {
  assertSafeLabel(label);
  const path = join(ensureKeysDir(), label + TOKEN_EXT);
  if (existsSync(path)) unlinkSync(path);
}
