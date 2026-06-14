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
import { findLatticeRoot, rootConfigDir } from './lattice-root.js';

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
 *   identity.json         display_name + email.
 *   preferences.json      machine-local UI preferences (show_system_tables, ...).
 *   keys/<label>.token    per-joined-team bearer tokens (added later).
 *   db-credentials.enc    encrypted Postgres URLs (added later).
 *
 * Security: do NOT log filesystem paths or user identity values from
 * this module. Errors must be thrown without echoing sensitive arguments.
 */

/**
 * Root directory for machine-local lattice config.
 *
 * Resolution order:
 *   1. `LATTICE_CONFIG_DIR` — explicit override, always wins.
 *   2. `<root>/.config` — when a `.lattice` root is discoverable (via
 *      `LATTICE_ROOT` or by walking up from the cwd to a `.lattice/.config`).
 *      This is what consolidates config into the single per-install `.lattice`
 *      folder, BUT only when adopting the root won't orphan an existing key:
 *      use the root if it already holds a `master.key`, or — for a fresh
 *      install — if there is no legacy `~/.lattice/master.key` to strand.
 *   3. `~/.lattice` — legacy fallback, so existing installs keep decrypting.
 */
export function configDir(): string {
  if (process.env.LATTICE_CONFIG_DIR) return process.env.LATTICE_CONFIG_DIR;
  const legacy = join(homedir(), '.lattice');
  const root = findLatticeRoot();
  if (root) {
    const rootDir = rootConfigDir(root);
    // The root is the encryption home once it holds a key. Before that, only
    // adopt it for a fresh install (no legacy key to orphan); otherwise keep
    // using `~/.lattice` so an existing install keeps decrypting its secrets.
    if (existsSync(join(rootDir, MASTER_KEY_FILENAME))) return rootDir;
    if (!existsSync(join(legacy, MASTER_KEY_FILENAME))) return rootDir;
  }
  return legacy;
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
// Preferences — `~/.lattice/preferences.json` { show_system_tables, ... }
// ---------------------------------------------------------------------------

const PREFERENCES_FILENAME = 'preferences.json';

export interface UserPreferences {
  show_system_tables: boolean;
  /**
   * Consent for anonymous install/download analytics via Scarf. Default `true`
   * (opt-out, matching `scarfSettings.defaultOptIn`). When `false`, in-app
   * reinstalls (`lattice update` / `autoUpdate`) suppress the Scarf ping and
   * any future runtime telemetry is disabled. See {@link analyticsEnabled}.
   */
  analytics: boolean;
  /**
   * Preferred speech-to-text provider for the assistant's voice notes. This is
   * a USER preference, not a workspace secret — it lives here (machine-local) so
   * it persists across workspaces and never appears in any workspace's `secrets`
   * object. `'auto'` infers from whichever provider key is configured.
   */
  voice_provider: 'auto' | 'openai' | 'elevenlabs';
  /**
   * Inference aggressiveness (0 = conservative … 1 = aggressive). Drives the
   * assistant's sampling temperature and how liberally ingest links/extracts.
   * A user preference, machine-local (see `voice_provider`).
   */
  aggressiveness: number;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  show_system_tables: false,
  analytics: true,
  voice_provider: 'auto',
  aggressiveness: 0.5,
};

/**
 * Read machine-local user preferences. Returns defaults if the file is
 * missing or malformed — callers don't need a separate existence check.
 * Per-key fallback (not all-or-nothing) so a partial file still applies
 * the known-good keys.
 */
export function readPreferences(): UserPreferences {
  const dir = ensureConfigDir();
  const path = join(dir, PREFERENCES_FILENAME);
  if (!existsSync(path)) return { ...DEFAULT_PREFERENCES };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UserPreferences>;
    const agg = typeof parsed.aggressiveness === 'number' ? parsed.aggressiveness : NaN;
    return {
      show_system_tables:
        typeof parsed.show_system_tables === 'boolean'
          ? parsed.show_system_tables
          : DEFAULT_PREFERENCES.show_system_tables,
      analytics:
        typeof parsed.analytics === 'boolean' ? parsed.analytics : DEFAULT_PREFERENCES.analytics,
      voice_provider:
        parsed.voice_provider === 'openai' ||
        parsed.voice_provider === 'elevenlabs' ||
        parsed.voice_provider === 'auto'
          ? parsed.voice_provider
          : DEFAULT_PREFERENCES.voice_provider,
      aggressiveness: Number.isFinite(agg)
        ? Math.min(1, Math.max(0, agg))
        : DEFAULT_PREFERENCES.aggressiveness,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Persist the user preferences. Only the known keys are stored; extras
 * are silently dropped (forward-compat: an older binary reading a newer
 * preferences.json applies the keys it understands and leaves the rest).
 */
export function writePreferences(prefs: UserPreferences): void {
  const dir = ensureConfigDir();
  const path = join(dir, PREFERENCES_FILENAME);
  const body = JSON.stringify(
    {
      show_system_tables: prefs.show_system_tables,
      analytics: prefs.analytics,
      voice_provider: prefs.voice_provider,
      aggressiveness: prefs.aggressiveness,
    },
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

/**
 * The consent gate for anonymous install analytics (Scarf). Returns `false`
 * when the user opted out — via the standard `DO_NOT_TRACK` / `SCARF_ANALYTICS`
 * env vars (which always win), or via the `analytics` preference. Callers use
 * this to set the child-process env on `lattice update` reinstalls so the
 * opt-out is honored, and as the gate for any future runtime telemetry.
 */
export function analyticsEnabled(): boolean {
  const dnt = process.env.DO_NOT_TRACK;
  if (dnt === '1' || dnt === 'true') return false;
  const scarf = process.env.SCARF_ANALYTICS;
  if (scarf === 'false' || scarf === '0') return false;
  return readPreferences().analytics;
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
        Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
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

// ---------------------------------------------------------------------------
// Saved S3 configs — `~/.lattice/s3-config.enc`
// AES-GCM-encrypted JSON object: { [label]: S3Config }. Per-member + machine
// local (NOT in the shared DB), the same trust model as db-credentials.enc —
// each member configures their own S3 access for a cloud workspace.
// ---------------------------------------------------------------------------

const S3_CONFIG_FILENAME = 's3-config.enc';

function loadS3Configs(): Record<string, Record<string, unknown>> {
  const dir = ensureConfigDir();
  const path = join(dir, S3_CONFIG_FILENAME);
  if (!existsSync(path)) return {};
  const key = deriveKey(getOrCreateMasterKey());
  try {
    const parsed = JSON.parse(decrypt(readFileSync(path, 'utf8').trim(), key)) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, Record<string, unknown>>;
    }
    return {};
  } catch (e) {
    // The file EXISTS but won't decrypt/parse — a corrupt store or a wrong master
    // key, NOT "no config". Returning {} would silently present a configured
    // workspace as "S3 off" (internal guideline). Surface it loudly; degrade to no-config so
    // a corrupt local file can't crash every upload/serve, but make it observable.
    console.warn(
      `[s3-config] ${S3_CONFIG_FILENAME} exists but could not be read (corrupt store or wrong key); treating as no S3 config: ${(e as Error).message}`,
    );
    return {};
  }
}

function saveS3Configs(cfgs: Record<string, Record<string, unknown>>): void {
  const dir = ensureConfigDir();
  const path = join(dir, S3_CONFIG_FILENAME);
  const key = deriveKey(getOrCreateMasterKey());
  writeFileSync(path, encrypt(JSON.stringify(cfgs), key) + '\n', 'utf8');
  if (platform() !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort
    }
  }
}

/** Raw S3 config object stored under `label`, or null. (Typed access is via
 *  `resolveActiveS3Config` in s3-config.ts.) */
export function getS3ConfigRaw(label: string): Record<string, unknown> | null {
  return loadS3Configs()[label] ?? null;
}

/** Persist (or overwrite) the S3 config stored under `label`. */
export function saveS3ConfigRaw(label: string, cfg: Record<string, unknown>): void {
  const all = loadS3Configs();
  all[label] = cfg;
  saveS3Configs(all);
}

/**
 * Sanitize an arbitrary team name into a label safe to use as a
 * filesystem-ish credential key. Same character set as the labels
 * we already accept (`[A-Za-z0-9._-]+`); spaces become hyphens,
 * everything else is stripped.
 */
function sanitizeTeamLabel(teamName: string): string {
  const stripped = teamName
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '');
  if (stripped.length === 0) return 'team';
  return stripped.startsWith('.') ? `team-${stripped}` : stripped;
}

/**
 * Save a joined team's cloud URL as a switchable database credential so
 * it appears in the GUI's database dropdown alongside local YAML configs.
 *
 * Label format: `<sanitized-team-name>.config`. If that label already
 * exists with a different URL, we suffix `-<short-team-id>` to keep them
 * disambiguated. Returns the label actually used.
 */
export function saveDbCredentialForTeam(opts: {
  teamName: string;
  teamId: string;
  cloudUrl: string;
}): string {
  const base = sanitizeTeamLabel(opts.teamName);
  let label = `${base}.config`;
  const creds = loadCredentials();
  if (label in creds && creds[label] !== opts.cloudUrl) {
    const shortId = opts.teamId.split('-')[0] ?? opts.teamId.slice(0, 8);
    label = `${base}-${shortId}.config`;
  }
  creds[label] = opts.cloudUrl;
  saveCredentials(creds);
  return label;
}

/** Remove the connection URL stored under `label`. No-op if absent. */
export function deleteDbCredential(label: string): void {
  const creds = loadCredentials();
  if (!(label in creds)) return;
  const { [label]: _removed, ...rest } = creds;
  void _removed;
  saveCredentials(rest);
}

// ---------------------------------------------------------------------------
// Assistant credentials — `<config>/assistant-credentials.enc`
// AES-GCM-encrypted JSON object: { [kind]: value }.
//
// These are MACHINE-LOCAL, not stored in any single workspace database, so the
// assistant's API keys / OAuth tokens survive switching or creating a
// workspace. A Claude key is a property of the user + machine, not of one
// database — storing it per-DB meant a new workspace started with no key
// (the key appeared to "de-attach"). Same encryption as db-credentials.enc
// (AES-GCM under the machine master key).
// ---------------------------------------------------------------------------

const ASSISTANT_CREDENTIALS_FILENAME = 'assistant-credentials.enc';

function loadAssistantCredentials(): Record<string, string> {
  const dir = ensureConfigDir();
  const path = join(dir, ASSISTANT_CREDENTIALS_FILENAME);
  if (!existsSync(path)) return {};
  const key = deriveKey(getOrCreateMasterKey());
  try {
    const ciphertext = readFileSync(path, 'utf8').trim();
    const plaintext = decrypt(ciphertext, key);
    const parsed = JSON.parse(plaintext) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>;
    }
    return {};
  } catch {
    // Corrupt or unreadable — treat as empty rather than throwing.
    return {};
  }
}

function saveAssistantCredentials(creds: Record<string, string>): void {
  const dir = ensureConfigDir();
  const path = join(dir, ASSISTANT_CREDENTIALS_FILENAME);
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

/** Decrypted machine-local assistant credential by kind, or null if unset. */
export function getAssistantCredential(kind: string): string | null {
  const v = loadAssistantCredentials()[kind];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Persist (or overwrite) a machine-local assistant credential. */
export function setAssistantCredential(kind: string, value: string): void {
  const creds = loadAssistantCredentials();
  creds[kind] = value;
  saveAssistantCredentials(creds);
}

/** Remove a machine-local assistant credential. No-op if absent. */
export function deleteAssistantCredential(kind: string): void {
  const creds = loadAssistantCredentials();
  if (!(kind in creds)) return;
  const { [kind]: _removed, ...rest } = creds;
  void _removed;
  saveAssistantCredentials(rest);
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
