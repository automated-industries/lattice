import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { decrypt, deriveKey, encrypt } from '../security/encryption.js';
import { resolveSessionRoot, rootConfigDir } from './lattice-root.js';

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
 * `root` names the `.lattice` root to resolve against. Pass it whenever the
 * caller KNOWS which root it is working in — opening a workspace does, and
 * without it the answer came from the surrounding environment instead, so
 * opening one root by argument and the same root by environment could resolve
 * two different key stores on one machine, and only whichever one wrote a
 * workspace's encrypted values could read them back. Omit it for genuinely
 * ambient use.
 *
 * Resolution order:
 *   1. `LATTICE_CONFIG_DIR` — explicit override, always wins.
 *   2. `<root>/.config` — the given root, else the one this session was told to use
 *      (`LATTICE_ROOT`, else `~/.lattice`). This is what consolidates config into
 *      the single per-install `.lattice` folder, BUT only when adopting the root
 *      won't orphan an existing key: use the root if it already holds a
 *      `master.key`, or — for a fresh install — if there is no legacy
 *      `~/.lattice/master.key` to strand.
 *   3. `~/.lattice` — legacy fallback, so existing installs keep decrypting.
 *
 * The session root deliberately does NOT come from searching upward for a
 * `.lattice/.config`. The master key and the encrypted credential store are the
 * most sensitive things on the machine; picking them up from whatever root
 * happened to sit above the working directory means a leftover checkout can hand
 * a process working credentials for a database it was never meant to reach. A
 * GUI launched from the Dock/Finder (cwd=`/`) also never reached `~/.lattice` by
 * searching, so the desktop and the CLI resolved to DIFFERENT stores and every
 * credential read as missing. Anchoring on the session root fixes both.
 */
export function configDir(root?: string): string {
  if (process.env.LATTICE_CONFIG_DIR) return process.env.LATTICE_CONFIG_DIR;
  const legacy = join(homedir(), '.lattice');
  const rootDir = rootConfigDir(root ?? resolveSessionRoot().root);
  // The root is the encryption home once it holds a key. Before that, only
  // adopt it for a fresh install (no legacy key to orphan); otherwise keep
  // using `~/.lattice` so an existing install keeps decrypting its secrets.
  if (existsSync(join(rootDir, MASTER_KEY_FILENAME))) return rootDir;
  if (!existsSync(join(legacy, MASTER_KEY_FILENAME))) return rootDir;
  return legacy;
}

/** Ensure + return the machine-local config dir (exported for sibling credential stores).
 *  `root` is passed through to {@link configDir}. */
export function ensureConfigDir(root?: string): string {
  const dir = configDir(root);
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
/**
 * A short, NON-reversible fingerprint of a master key — first 8 hex of its
 * SHA-256. Safe to log (reveals nothing usable about the key); lets an operator
 * confirm at a glance whether two surfaces (e.g. `lattice gui`/desktop vs. the
 * CLI) resolved the SAME key, which is exactly what the env-var-shadowing bug
 * makes ambiguous.
 */
export function masterKeyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

// Log the chosen key SOURCE once per process — never the key, only source +
// fingerprint. GUI-launched apps inherit a different environment than the shell,
// so LATTICE_ENCRYPTION_KEY can silently differ between the desktop app and the
// CLI on the same machine; surfacing the source makes that divergence visible.
let _keySourceLogged = false;
function logKeySource(source: 'env' | 'file' | 'generated', key: string): void {
  if (_keySourceLogged) return;
  _keySourceLogged = true;
  console.error(
    `[lattice] encryption key: source=${source} fingerprint=${masterKeyFingerprint(key)}`,
  );
}

/** The env master key, trimmed; undefined when unset or blank (the footgun value). */
function readEnvMasterKey(): string | undefined {
  const v = process.env.LATTICE_ENCRYPTION_KEY;
  return v !== undefined && v.trim().length > 0 ? v : undefined;
}

/** The on-disk `master.key`, or undefined when absent OR blank. An empty/whitespace
 *  file is NOT a usable key — treating it as '' would encrypt everything under a
 *  publicly-derivable blank key (mirrors readEnvMasterKey's blank guard). */
function readFileMasterKey(root?: string): string | undefined {
  const keyPath = join(ensureConfigDir(root), MASTER_KEY_FILENAME);
  if (!existsSync(keyPath)) return undefined;
  const c = readFileSync(keyPath, 'utf8').trim();
  return c.length > 0 ? c : undefined;
}

/** Does `masterKey` decrypt `ciphertext`? (A wrong key throws an AES-GCM auth-tag error.) */
function canDecryptWith(ciphertext: string, masterKey: string): boolean {
  try {
    decrypt(ciphertext, deriveKey(masterKey));
    return true;
  } catch {
    return false;
  }
}

/**
 * ALL raw ciphertexts from the machine-local, master-key-encrypted stores — used
 * to VALIDATE a candidate key without exposing any plaintext. Each of these files
 * is written with `deriveKey(getOrCreateMasterKey())`, so collectively they
 * witness which key this machine's data was actually encrypted with. Returns the
 * ones present (any subset), or `[]` when nothing is encrypted yet. Never throws —
 * an unreadable file is skipped, so a hot-path key resolution can't crash on it.
 */
function readMachineLocalCiphertexts(root?: string): string[] {
  const out: string[] = [];
  let dir: string;
  try {
    dir = ensureConfigDir(root);
  } catch {
    return out;
  }
  for (const fn of [ASSISTANT_CREDENTIALS_FILENAME, DB_CREDENTIALS_FILENAME, S3_CONFIG_FILENAME]) {
    try {
      const p = join(dir, fn);
      if (!existsSync(p)) continue;
      const c = readFileSync(p, 'utf8').trim();
      if (c.startsWith('enc:')) out.push(c);
    } catch {
      /* unreadable — skip this witness, try the next */
    }
  }
  return out;
}

/** Cheap, stable fingerprint of the sample set, so the cache re-resolves when the witnesses change. */
function samplesFingerprint(samples: string[]): string {
  return createHash('sha256').update(samples.join(' ')).digest('hex').slice(0, 16);
}

let _blankEnvWarned = false;
function warnBlankEnvKeyOnce(): void {
  const raw = process.env.LATTICE_ENCRYPTION_KEY;
  if (raw === undefined || raw.trim().length > 0) return; // unset, or a real value
  if (_blankEnvWarned) return;
  _blankEnvWarned = true;
  console.error(
    '[lattice] LATTICE_ENCRYPTION_KEY is set but blank — ignoring it and using master.key. ' +
      'Unset the variable to silence this warning.',
  );
}

// Cache the (expensive: 2 scrypt derivations) conflict resolution. Keyed by the
// config dir + both candidate values, so per-test config dirs and an env swap
// re-resolve rather than returning a stale decision.
let _conflictCacheKey: string | null = null;
let _conflictCacheVal: string | null = null;

/**
 * A non-blank `LATTICE_ENCRYPTION_KEY` and a `master.key` both exist and DIFFER —
 * the env-shadows-file footgun (a GUI app inheriting a stale env var is the
 * documented failure). The `master.key` FILE is the machine's PERSISTENT key, so
 * the env key is trusted ONLY when it actually decrypts this machine's stored
 * data; otherwise the file wins. We never proceed under an unvalidated env key
 * when a file exists — that would risk writing new data under a key that can't
 * read the old (a split). Validates against ALL machine-local witnesses; with
 * none, prefers the file (the persistent key), not the stale env. Never throws
 * (many hot paths); a genuine mismatch surfaces the actionable DecryptionKeyError
 * downstream.
 *
 * Known limit: this validates against machine-local ciphertext, not the workspace
 * DB. In the rare pre-existing split where machine-local data is under the env key
 * but the workspace DB is under the file key (keys diverged across sessions), the
 * env key validates here and the workspace read then surfaces the actionable
 * mismatch error — it is not silently wrong.
 */
function resolveKeyConflict(envKey: string, fileKey: string, root?: string): string {
  const samples = readMachineLocalCiphertexts(root);
  if (samples.length === 0) {
    // Nothing to validate against -> prefer the persistent file key. A stale
    // inherited env var is the documented failure, so we never fall through to it
    // unvalidated. NOT cached: self-heals the moment encrypted data appears.
    console.error(
      '[lattice] LATTICE_ENCRYPTION_KEY differs from master.key and could not be validated (no ' +
        "encrypted data on disk yet) - using master.key, the machine's persistent key. Unset " +
        'LATTICE_ENCRYPTION_KEY if it is stale.',
    );
    logKeySource('file', fileKey);
    return fileKey;
  }
  const cacheKey =
    configDir(root) + ' ' + envKey + ' ' + fileKey + ' ' + samplesFingerprint(samples);
  if (_conflictCacheKey === cacheKey && _conflictCacheVal !== null) return _conflictCacheVal;

  // Trust the env key ONLY if it decrypts real data (any witness); else the file.
  const chosen = samples.some((s) => canDecryptWith(s, envKey)) ? envKey : fileKey;
  if (chosen === envKey) {
    logKeySource('env', envKey);
  } else {
    console.error(
      samples.some((s) => canDecryptWith(s, fileKey))
        ? "[lattice] LATTICE_ENCRYPTION_KEY does not decrypt this machine's stored data - using " +
            'master.key (the key that does). Unset LATTICE_ENCRYPTION_KEY to silence this.'
        : "[lattice] Neither LATTICE_ENCRYPTION_KEY nor master.key decrypts this machine's stored " +
            'data - using master.key. If secrets fail to load, the data was encrypted with a ' +
            'different key; restore it or set the correct key.',
    );
    logKeySource('file', fileKey);
  }
  _conflictCacheKey = cacheKey;
  _conflictCacheVal = chosen;
  return chosen;
}

/**
 * Resolve the lattice-wide encryption master key. A single key is returned for
 * BOTH reads and writes so machine-local stores and the workspace never split
 * across keys. Priority:
 *   1. `LATTICE_ENCRYPTION_KEY` (non-blank) when there's no differing `master.key`.
 *   2. When a non-blank env key AND a differing `master.key` both exist, the key
 *      that actually decrypts this machine's encrypted data wins (validated) —
 *      so a stale env var can't shadow the working file (see {@link resolveKeyConflict}).
 *   3. `master.key` when present; otherwise 32 random bytes, written base64 (0600).
 *
 * A set-but-blank env var is treated as unset (with a warning) — it used to be
 * taken verbatim and break every decrypt.
 *
 * `root` names the `.lattice` root whose key is wanted (see {@link configDir}).
 * Pass it when opening a specific root, so opening that root by argument and by
 * environment resolve the SAME key rather than two different ones.
 */
export function getOrCreateMasterKey(root?: string): string {
  const envKey = readEnvMasterKey();
  const fileKey = readFileMasterKey(root);
  warnBlankEnvKeyOnce();

  if (envKey && fileKey && envKey !== fileKey) return resolveKeyConflict(envKey, fileKey, root);
  if (envKey) {
    logKeySource('env', envKey);
    return envKey;
  }
  if (fileKey) {
    logKeySource('file', fileKey);
    return fileKey;
  }
  // Create under the cross-process lock with a re-check: two concurrent fresh
  // processes must not write divergent keys, which would make each other's
  // encrypted credentials undecryptable. The first to acquire writes; the rest
  // re-read the key it created.
  const keyPath = join(ensureConfigDir(root), MASTER_KEY_FILENAME);
  return withCredentialLock(() => {
    if (existsSync(keyPath)) {
      const key = readFileSync(keyPath, 'utf8').trim();
      if (key.length > 0) {
        logKeySource('file', key);
        return key;
      }
      // An existing but EMPTY/whitespace master.key must NEVER become a blank
      // encryption key — fall through to generate + atomically write a real one.
    }
    const key = randomBytes(32).toString('base64');
    writeFileAtomic(keyPath, key);
    logKeySource('generated', key);
    return key;
  });
}

const ANALYTICS_ID_FILENAME = 'analytics-id';

/**
 * A stable, machine-local, ANONYMIZED analytics client id (a random UUID, no
 * PII). It exists only so Google Analytics can collapse one machine's reloads
 * and relaunches into a SINGLE client, instead of counting every session as a
 * brand-new user — the embedded desktop webview does not reliably persist gtag's
 * own client-id cookie, so without a server-pinned id the active-user count
 * inflates to ~one-per-session. Generated once, then reused forever.
 */
export function getOrCreateAnalyticsId(): string {
  const dir = ensureConfigDir();
  const idPath = join(dir, ANALYTICS_ID_FILENAME);
  if (existsSync(idPath)) {
    const v = readFileSync(idPath, 'utf8').trim();
    if (v) return v;
  }
  // Create under the cross-process lock with a re-check, so two fresh processes
  // don't write divergent ids (mirrors getOrCreateMasterKey).
  return withCredentialLock(() => {
    if (existsSync(idPath)) {
      const v = readFileSync(idPath, 'utf8').trim();
      if (v) return v;
    }
    const id = randomUUID();
    writeFileAtomic(idPath, id);
    return id;
  });
}

const SESSION_SECRET_FILENAME = 'session.key';

/**
 * A machine-local RANDOM secret used to derive the session identity a
 * command-line run's writes are attributed to.
 *
 * It has to be a secret rather than a name, because that session identity is the
 * authorship gate on reversing a change: undo, redo, and group-revert only touch
 * entries carrying the caller's own session. Deriving that from anything the
 * caller merely ASSERTS — an email in a config file, a display name, an
 * environment variable — means a second person on the same shared workspace can
 * assert somebody else's and reverse their work. This is 32 random bytes,
 * readable only by its owner, so the derived identity cannot be guessed or
 * spoofed by anyone who is not already this user on this machine.
 *
 * Generated once and reused forever: STABLE is the other half of the
 * requirement, since every command is a fresh process and one run has to be able
 * to undo what the previous one did.
 */
export function getOrCreateSessionSecret(): string {
  const dir = ensureConfigDir();
  const keyPath = join(dir, SESSION_SECRET_FILENAME);
  if (existsSync(keyPath)) {
    const v = readFileSync(keyPath, 'utf8').trim();
    if (v) return v;
  }
  // Created under the cross-process lock with a re-check, so two fresh processes
  // don't write divergent secrets (mirrors getOrCreateMasterKey).
  return withCredentialLock(() => {
    if (existsSync(keyPath)) {
      const v = readFileSync(keyPath, 'utf8').trim();
      if (v) return v;
    }
    const secret = randomBytes(32).toString('base64');
    writeFileAtomic(keyPath, secret);
    return secret;
  });
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
 *
 * In a managed/hosted deployment there is no local identity file, so a stored
 * field falls back to the `LATTICE_USER_NAME` / `LATTICE_USER_EMAIL` env vars
 * (which the host injects per session). Env is only a fallback — a value written
 * to the identity file always wins, preserving the "empty = not set" contract.
 */
export function readIdentity(): UserIdentity {
  // A stored value wins; an empty (unset) field falls back to the env var. Uses an
  // explicit empty check because '' is the "not set" sentinel here — `??` would
  // keep the empty string instead of falling back.
  const pick = (stored: string, fromEnv: string | undefined): string =>
    stored !== '' ? stored : (fromEnv ?? '');
  const withEnvFallback = (id: UserIdentity): UserIdentity => ({
    display_name: pick(id.display_name, process.env.LATTICE_USER_NAME),
    email: pick(id.email, process.env.LATTICE_USER_EMAIL),
  });
  const dir = ensureConfigDir();
  const path = join(dir, IDENTITY_FILENAME);
  if (!existsSync(path)) return withEnvFallback({ ...EMPTY_IDENTITY });
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UserIdentity>;
    return withEnvFallback({
      display_name: typeof parsed.display_name === 'string' ? parsed.display_name : '',
      email: typeof parsed.email === 'string' ? parsed.email : '',
    });
  } catch {
    return withEnvFallback({ ...EMPTY_IDENTITY });
  }
}

/** Account names that name the machine's role, not a person. */
const IMPERSONAL_ACCOUNTS = new Set([
  'root',
  'admin',
  'administrator',
  'user',
  'ubuntu',
  'ec2-user',
]);

/**
 * A display name to OFFER when none has been set — derived from the operating
 * system account (`ada.lovelace` → `Ada Lovelace`).
 *
 * Deliberately NOT part of {@link readIdentity}: an empty `display_name` there
 * means "not set", and several callers depend on that — the cloud member
 * directory falls back on it, and folding a machine account name into the stored
 * identity would publish a login name to a shared workspace as though the person
 * had chosen it. This is a suggestion the interface can fill a field with, which
 * only becomes the identity if the person leaves it there.
 *
 * Returns '' when the account name is impersonal or unavailable, so a caller
 * gets nothing rather than a name like "Root".
 */
export function suggestedDisplayName(): string {
  let raw = '';
  try {
    raw = userInfo().username;
  } catch {
    // No account information available (a locked-down container). Nothing to
    // suggest, which is a fine answer — the field is simply left for the user.
    raw = '';
  }
  raw = (raw || '').trim();
  if (!raw || IMPERSONAL_ACCOUNTS.has(raw.toLowerCase())) return '';
  return raw
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
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
   * object.
   *   `'local'`      — on-device, in-browser speech model. The keyless default:
   *                    no API key, no config, audio never leaves the machine.
   *   `'openai'` /   — cloud providers (fallback when a key IS configured).
   *   `'elevenlabs'`
   *   `'auto'`       — infer from whichever cloud provider key is configured;
   *                    legacy "off" sentinel kept for back-compat.
   */
  voice_provider: 'local' | 'auto' | 'openai' | 'elevenlabs';
  /**
   * Inference aggressiveness (0 = conservative … 1 = aggressive). Drives the
   * assistant's sampling temperature and how liberally ingest links/extracts.
   * A user preference, machine-local (see `voice_provider`).
   */
  aggressiveness: number;
  /**
   * Clarify threshold (0..1) — the single confidence bar that decides when an
   * automated inference asks the user instead of guessing. At or above the
   * threshold the system acts silently; between the floor (threshold / 2,
   * derived where consumed) and the threshold it asks a short multiple-choice
   * question; below the floor it drops the inference as noise. A user
   * preference, machine-local (see `voice_provider`).
   */
  clarify_threshold: number;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  show_system_tables: false,
  // Telemetry is OPT-IN (default off): a local-first, "files never leave your
  // computer" tool must not send analytics until the user explicitly turns it on.
  analytics: false,
  // On-device is the keyless default — voice dictation works with no API key and
  // no config, and audio never leaves the machine.
  voice_provider: 'local',
  aggressiveness: 0.85,
  clarify_threshold: 0.6,
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
    const clarify = typeof parsed.clarify_threshold === 'number' ? parsed.clarify_threshold : NaN;
    return {
      show_system_tables:
        typeof parsed.show_system_tables === 'boolean'
          ? parsed.show_system_tables
          : DEFAULT_PREFERENCES.show_system_tables,
      analytics:
        typeof parsed.analytics === 'boolean' ? parsed.analytics : DEFAULT_PREFERENCES.analytics,
      voice_provider:
        parsed.voice_provider === 'local' ||
        parsed.voice_provider === 'openai' ||
        parsed.voice_provider === 'elevenlabs' ||
        parsed.voice_provider === 'auto'
          ? parsed.voice_provider
          : DEFAULT_PREFERENCES.voice_provider,
      aggressiveness: Number.isFinite(agg)
        ? Math.min(1, Math.max(0, agg))
        : DEFAULT_PREFERENCES.aggressiveness,
      clarify_threshold: Number.isFinite(clarify)
        ? Math.min(1, Math.max(0, clarify))
        : DEFAULT_PREFERENCES.clarify_threshold,
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
      clarify_threshold: prefs.clarify_threshold,
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

// ---------------------------------------------------------------------------
// Cross-process lock for credential-store mutations.
//
// The credential store + master key are shared, process-global files. Heal-on-
// open turns opening a raw-`postgres://` config into a load-modify-write of that
// store, so two concurrent opens (two `lattice gui` launches, or the parallel
// test workers) would otherwise race: lost updates (one writer's whole-file save
// clobbers another's) and a master-key creation race (two processes write
// divergent keys → each other's ciphertext becomes undecryptable). We serialize
// the mutation across processes with an exclusive lock file, re-entrant within a
// single process, with a stale-lock breaker so a crashed holder can't wedge it.
// ---------------------------------------------------------------------------

const CRED_LOCK_FILENAME = '.credentials.lock';
const LOCK_STALE_MS = 10_000; // a lock older than this is presumed abandoned
const LOCK_TIMEOUT_MS = 15_000; // give up acquiring after this
/** Re-entrancy depth per store directory, for THIS process. */
const lockDepthInProcess = new Map<string, number>();

/** Sleep synchronously without busy-spinning the CPU. */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive lock over the credential store, so the
 * load-modify-write of the shared encrypted files is atomic across concurrent
 * processes. Re-entrant within a single process; breaks a stale lock left by a
 * crashed holder.
 */
function withCredentialLock<T>(fn: () => T): T {
  return withCredentialLockIn(ensureConfigDir(), fn);
}

/** {@link withCredentialLock} against a specific store directory. */
function withCredentialLockIn<T>(dir: string, fn: () => T): T {
  const key = resolve(dir);
  const held = lockDepthInProcess.get(key) ?? 0;
  if (held > 0) {
    // Already held by this process — run inline (the outer holder protects us).
    lockDepthInProcess.set(key, held + 1);
    try {
      return fn();
    } finally {
      lockDepthInProcess.set(key, (lockDepthInProcess.get(key) ?? 1) - 1);
    }
  }
  const lockPath = join(dir, CRED_LOCK_FILENAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx'); // O_CREAT|O_EXCL — atomic; throws EEXIST if held
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EEXIST = the lock is held → retry. On Windows, an O_EXCL open racing
      // another process that is mid-create/delete on the same lockfile surfaces
      // transiently as EPERM / EACCES (a sharing/access race, not a hard failure);
      // treat those identically so a contended writer retries (stale-reclaim +
      // backoff below, bounded by the deadline) instead of crashing with a lost
      // update. POSIX only ever sees EEXIST here, so its behavior is unchanged.
      const contended =
        code === 'EEXIST' ||
        (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
      if (!contended) throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath); // abandoned by a crashed holder — reclaim it
          continue;
        }
      } catch {
        continue; // the lock vanished between stat and now — retry the acquire
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Lattice: timed out acquiring the credential-store lock. If no Lattice ` +
            `process is running, remove ${lockPath} and retry.`,
        );
      }
      syncSleep(25);
    }
  }
  lockDepthInProcess.set(key, 1);
  try {
    return fn();
  } finally {
    lockDepthInProcess.set(key, (lockDepthInProcess.get(key) ?? 1) - 1);
    try {
      closeSync(fd);
      unlinkSync(lockPath);
    } catch {
      // best-effort release
    }
  }
}

/** Atomically write `data` to `path` via a temp file + rename, then chmod 0600. */
/** Atomic same-dir write (exported for sibling credential stores). */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  if (platform() !== 'win32') {
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // best-effort
    }
  }
  renameSync(tmp, path); // atomic same-dir replace — a reader never sees a partial file
}

/**
 * Atomically load → mutate → save the credential store under the cross-process
 * lock. The load happens INSIDE the lock, so a mutation can never clobber a
 * concurrently-written entry (the lost-update bug).
 */
function mutateCredentials(mutate: (creds: Record<string, string>) => void): void {
  withCredentialLock(() => {
    const creds = loadCredentials();
    mutate(creds);
    saveCredentials(creds);
  });
}

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
  } catch (e) {
    // The file EXISTS but won't decrypt/parse — a wrong encryption key or a corrupt
    // store, NOT "no credentials". Surface it (mirrors loadS3Configs) so a key
    // mismatch is visible instead of silently presenting the store as empty.
    console.warn(
      `[lattice] ${DB_CREDENTIALS_FILENAME} exists but could not be read (wrong encryption key ` +
        `or corrupt store); treating as empty: ${(e as Error).message}`,
    );
    return {};
  }
}

function saveCredentials(creds: Record<string, string>): void {
  const dir = ensureConfigDir();
  const path = join(dir, DB_CREDENTIALS_FILENAME);
  const key = deriveKey(getOrCreateMasterKey());
  const ciphertext = encrypt(JSON.stringify(creds), key);
  writeFileAtomic(path, ciphertext + '\n');
}

/** Return the labels of all saved DB credentials. URLs are not exposed. */
export function listDbCredentials(): string[] {
  return Object.keys(loadCredentials()).sort();
}

/**
 * Return the connection URL stored under `label`, or null if absent.
 *
 * Falls back to a `LATTICE_DB_<label>` env var (the exact label, then an
 * uppercased/underscored form for shell-friendliness) — a credential-injection
 * escape hatch for CI / IT that needs no GUI. This is exactly what the
 * "…or set LATTICE_DB_<label>" hint on a missing-credential error promises; the
 * env var used to be suggested but never read.
 */
export function getDbCredential(label: string): string | null {
  const creds = loadCredentials();
  if (creds[label] !== undefined) return creds[label];
  const exact = process.env['LATTICE_DB_' + label];
  if (exact) return exact;
  const shellSafe = process.env['LATTICE_DB_' + label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')];
  return shellSafe ?? null;
}

/** Persist (or overwrite) the connection URL stored under `label`. */
export function saveDbCredential(label: string, url: string): void {
  mutateCredentials((creds) => {
    creds[label] = url;
  });
}

/** Derive a `${LATTICE_DB:…}`-charset label from a connection URL — the database
 *  name, falling back to the host, then `cloud`. Sanitized to `[A-Za-z0-9._-]`. */
function labelForUrl(url: string): string {
  let base = 'cloud';
  try {
    const u = new URL(url);
    base = u.pathname.replace(/^\//, '') || u.hostname || 'cloud';
  } catch {
    /* malformed — fall back to 'cloud' */
  }
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return safe.length > 0 ? safe : 'cloud';
}

/**
 * Heal a config whose `db:` line is a RAW `postgres://…` connection string into
 * the encrypted-credential model: move the URL into the encrypted credential
 * store under a synthesized label and rewrite the `db:` line to
 * `${LATTICE_DB:<label>}`. Keeps a plaintext connection string (with its
 * password) from lingering in a YAML file on disk. Idempotent: a `db:` line that
 * is already a `${LATTICE_DB:…}` reference, a SQLite path, or anything non-raw is
 * left untouched. If the chosen label is already taken by a DIFFERENT URL, a
 * short uniquifying suffix is appended so an existing credential is never
 * clobbered. Returns the label when a heal happened, else null.
 */
export function healRawDbUrl(configPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return null; // no readable config → nothing to heal
  }
  const doc = parseDocument(raw);
  const dbVal = doc.get('db');
  const dbLine = typeof dbVal === 'string' ? dbVal.trim() : '';
  if (!/^postgres(ql)?:\/\//i.test(dbLine)) return null; // already a ref / not a raw URL

  // Decide the label and persist the credential atomically: the collision check
  // and the write happen against the SAME locked snapshot, so a concurrent heal
  // can neither make us fork a spurious suffix off a clobbered read nor lose the
  // entry the rewritten config will reference.
  let label = labelForUrl(dbLine);
  mutateCredentials((creds) => {
    if (creds[label] !== undefined && creds[label] !== dbLine) {
      label = `${label}-${randomBytes(2).toString('hex')}`;
    }
    creds[label] = dbLine;
  });
  doc.set('db', '${LATTICE_DB:' + label + '}');
  writeFileSync(configPath, doc.toString(), 'utf8');
  return label;
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
    // workspace as "S3 off" (a real failure). Surface it loudly; degrade to no-config so
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
  mutateCredentials((creds) => {
    if (label in creds && creds[label] !== opts.cloudUrl) {
      const shortId = opts.teamId.split('-')[0] ?? opts.teamId.slice(0, 8);
      label = `${base}-${shortId}.config`;
    }
    creds[label] = opts.cloudUrl;
  });
  return label;
}

/** Remove the connection URL stored under `label`. No-op if absent. */
export function deleteDbCredential(label: string): void {
  mutateCredentials((creds) => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- label is a credential key
    delete creds[label];
  });
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
  } catch (e) {
    // The file EXISTS but won't decrypt/parse — a wrong encryption key or a corrupt
    // store, NOT "no credential". Surface it so a key mismatch is visible.
    console.warn(
      `[lattice] ${ASSISTANT_CREDENTIALS_FILENAME} exists but could not be read (wrong encryption ` +
        `key or corrupt store); treating as none: ${(e as Error).message}`,
    );
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
// "Credential cleared" sentinels.
//
// Clearing an assistant credential must be authoritative: it has to suppress
// the matching environment-variable fallback too, and stay cleared across
// reloads/restarts until the user saves a new value. A deleted store entry
// alone can't do that — the env var would re-resolve the credential on the next
// read. We persist a per-kind sentinel in the SAME encrypted machine-local
// store (under a reserved key prefix that can't collide with a real `kind`):
// when set, callers skip BOTH the stored read and the env fallback for that
// kind. Saving a value clears the sentinel.
// ---------------------------------------------------------------------------

const CLEARED_SENTINEL_PREFIX = '__cleared__:';

/** True when `kind` was explicitly cleared and not since re-saved. */
export function isAssistantCredentialCleared(kind: string): boolean {
  return loadAssistantCredentials()[CLEARED_SENTINEL_PREFIX + kind] === '1';
}

/** Mark `kind` as cleared so its env fallback is suppressed until a re-save. */
export function setAssistantCredentialCleared(kind: string): void {
  const creds = loadAssistantCredentials();
  creds[CLEARED_SENTINEL_PREFIX + kind] = '1';
  saveAssistantCredentials(creds);
}

/** Clear the "cleared" sentinel for `kind` (called when a new value is saved). */
export function clearAssistantCredentialCleared(kind: string): void {
  const creds = loadAssistantCredentials();
  const sentinel = CLEARED_SENTINEL_PREFIX + kind;
  if (!(sentinel in creds)) return;
  const { [sentinel]: _removed, ...rest } = creds;
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
  if (!isTokenSafeLabel(label)) {
    throw new Error(`Invalid label "${label}": must match [A-Za-z0-9._-]+ and not start with .`);
  }
}

/** The predicate behind {@link assertSafeLabel}, for callers that branch instead of throwing. */
function isTokenSafeLabel(label: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(label) && !label.startsWith('.');
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

// ---------------------------------------------------------------------------
// Per-workspace secret purge — what this machine keeps in order to reconnect.
//
// A cloud workspace leaves three things behind on the machine that joined it,
// all keyed by its `${LATTICE_DB:<label>}` label: the encrypted connection
// string, the S3 access keys, and its bearer token. Dropping the registry
// pointer without these leaves the machine perfectly able to reconnect to a
// database its operator believes it has been disconnected from — a delete that
// reports success while the access it was supposed to revoke still works.
//
// Only label-keyed entries are removed. The master key, identity, preferences
// and assistant credentials are SHARED by every workspace under a root; taking
// them out would strand the workspaces that remain.
// ---------------------------------------------------------------------------

export interface WorkspaceSecretPurge {
  /** Store directories that were inspected. */
  dirs: string[];
  /** What was actually removed, as `<store file>:<dir>` entries. Empty is fine. */
  removed: string[];
}

/**
 * Every store directory that could plausibly hold `root`'s secrets: the root's
 * own `.config`, plus the store this process is currently resolving to. They are
 * usually the same; they diverge when the session is running against a different
 * root (or an explicit `LATTICE_CONFIG_DIR`), which is exactly the case where a
 * purge aimed at only one of them silently leaves the credential in place.
 */
function credentialStoreDirs(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of [rootConfigDir(root), configDir()]) {
    const key = resolve(dir);
    if (seen.has(key) || !existsSync(dir)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * Candidate master keys for a store directory, most specific first: the store's
 * own `master.key`, the environment key, then the key file this process would
 * otherwise use. The store is decrypted with whichever one works, and
 * re-encrypted with that SAME key — a delete must never silently re-key a store
 * it does not own.
 *
 * Deliberately reads key FILES rather than calling `getOrCreateMasterKey()`:
 * removing a credential must not have the side effect of minting a master key on
 * a machine that had none.
 */
function candidateKeysFor(dir: string): string[] {
  const out: string[] = [];
  const push = (v: string | undefined): void => {
    if (v !== undefined && v.length > 0 && !out.includes(v)) out.push(v);
  };
  const readKeyFile = (from: string): void => {
    const path = join(from, MASTER_KEY_FILENAME);
    if (!existsSync(path)) return;
    try {
      push(readFileSync(path, 'utf8').trim());
    } catch {
      /* unreadable — the other candidates still apply */
    }
  };
  readKeyFile(dir);
  push(readEnvMasterKey());
  try {
    readKeyFile(configDir());
  } catch {
    /* no resolvable ambient store — the candidates above still apply */
  }
  return out;
}

/**
 * Read + decrypt a label-keyed JSON store. Returns null when the file is absent.
 * Throws when it exists but no candidate key opens it: we cannot prove the
 * credential is gone, and reporting a successful purge in that state is the
 * false assurance this whole path exists to prevent.
 */
function openLabelStore(
  path: string,
  keys: string[],
): { data: Record<string, unknown>; key: string } | null {
  if (!existsSync(path)) return null;
  const ciphertext = readFileSync(path, 'utf8').trim();
  for (const candidate of keys) {
    try {
      const parsed = JSON.parse(decrypt(ciphertext, deriveKey(candidate))) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { data: parsed as Record<string, unknown>, key: candidate };
      }
    } catch {
      /* wrong key or corrupt — try the next candidate */
    }
  }
  throw new Error(
    `Lattice: cannot remove stored credentials — ${path} exists but could not be decrypted ` +
      `with any available key. The credentials are still on disk and still usable; resolve the ` +
      `key mismatch (or remove the file yourself) before treating this workspace as disconnected.`,
  );
}

/** Drop `label` from a label-keyed encrypted store, then verify it is gone. */
function purgeLabelStore(dir: string, filename: string, label: string, keys: string[]): boolean {
  const path = join(dir, filename);
  return withCredentialLockIn(dir, () => {
    const opened = openLabelStore(path, keys);
    if (!opened || !(label in opened.data)) return false;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- label is a store key
    delete opened.data[label];
    writeFileAtomic(path, encrypt(JSON.stringify(opened.data), deriveKey(opened.key)) + '\n');
    // Re-read from disk, still holding the lock: a write that appeared to succeed
    // but did not land would otherwise be reported as a completed purge.
    const after = openLabelStore(path, keys);
    if (after && label in after.data) {
      throw new Error(
        `Lattice: failed to remove "${label}" from ${path} — the credential is still stored.`,
      );
    }
    return true;
  });
}

/**
 * Remove every machine-local secret keyed to `label` — the encrypted connection
 * string, the S3 configuration, and the bearer token — from the stores belonging
 * to `root`. Shared material (master key, identity, preferences, assistant
 * credentials) is untouched, as are all other labels.
 *
 * Throws if anything keyed to `label` survives, or if a store cannot be read.
 * Callers must let that surface: a delete that quietly leaves working
 * credentials behind is worse than one that fails.
 */
export function purgeWorkspaceSecrets(root: string, label: string): WorkspaceSecretPurge {
  const dirs = credentialStoreDirs(root);
  const removed: string[] = [];
  for (const dir of dirs) {
    const keys = candidateKeysFor(dir);
    for (const filename of [DB_CREDENTIALS_FILENAME, S3_CONFIG_FILENAME]) {
      if (purgeLabelStore(dir, filename, label, keys)) removed.push(`${filename}:${dir}`);
    }
    // Token files are named after the label, so only labels that `writeToken`
    // would have accepted can have one. Checking here (rather than rejecting the
    // whole purge) keeps an odd-but-harmless label from turning a delete into a
    // failure, while still refusing to build a path out of an unsafe name.
    if (!isTokenSafeLabel(label)) continue;
    const tokenPath = join(dir, KEYS_SUBDIR, label + TOKEN_EXT);
    if (existsSync(tokenPath)) {
      unlinkSync(tokenPath);
      if (existsSync(tokenPath)) {
        throw new Error(`Lattice: failed to remove the stored token at ${tokenPath}.`);
      }
      removed.push(`${KEYS_SUBDIR}/${label}${TOKEN_EXT}:${dir}`);
    }
  }
  return { dirs, removed };
}
