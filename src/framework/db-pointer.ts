import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { deleteDbCredential, getDbCredential, saveDbCredential } from './user-config.js';

/**
 * Which database a workspace points at — and how to point it somewhere else and
 * back again.
 *
 * A workspace is a config file plus the store its `db:` line names. Moving it to
 * a different store is therefore two writes that have to agree: the credential
 * goes into the machine-local store under a key, and the config's `db:` line
 * becomes the reference that reads it back. Do one without the other and the
 * workspace is broken — a key nobody names, or a name with nothing behind it.
 *
 * That pair lived inside a request handler, which made repointing a workspace
 * something only a running server could do. It is a plain function here, and it
 * hands back an `undo` so a caller doing something larger — a migration, which
 * repoints the config as its second of four steps — can put the workspace back
 * exactly as it found it when a later step fails.
 *
 * The credential key charset is not cosmetic: the `${LATTICE_DB:…}` reference is
 * read back with a strict pattern, so a key with a space in it resolves to
 * nothing and drops the caller on an empty database with no error at all. Labels
 * are normalized rather than rejected — see {@link normalizeLabel} — and a label
 * that normalizes to nothing is a refusal, never a silent empty key.
 */

/** The reference form a stored credential is named by inside a config's `db:` line. */
export function credentialRef(key: string): string {
  return '${LATTICE_DB:' + key + '}';
}

/**
 * Normalize a display label into the credential-key charset [A-Za-z0-9._-] that
 * the `${LATTICE_DB:<label>}` reference is read back with. Runs of unsupported
 * characters (spaces, slashes, accents) collapse to a single '-'; leading and
 * trailing '-' are trimmed. `Strategy Team` -> `Strategy-Team`. Returns '' only
 * when nothing usable survives (e.g. an all-symbol label), which the caller turns
 * into a specific field error rather than a silent empty key.
 */
export function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Is `key` already usable as a credential key, exactly as written? */
export function isCredentialKey(key: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(key);
}

/** How many suffixed variants of a key are tried before giving up. */
const MAX_KEY_VARIANTS = 100;

/**
 * A credential key that is free to hold `url` — never one already spoken for by
 * a different database.
 *
 * Credential keys are MACHINE-GLOBAL: one flat map, not one entry per workspace.
 * The key is derived from a label, and labels collide constantly — two people
 * both name a workspace "Acme", and on most managed Postgres hosts every
 * project's database is literally named `postgres`. Writing over the entry does
 * not fail; it silently repoints whichever workspace already named that key at
 * somebody else's database, and the next open reads the wrong tenant's data with
 * nothing anywhere reporting it.
 *
 * So the key is reused only when it is free or already holds this exact URL, and
 * otherwise `<key>-2`, `<key>-3`, … until one is free. Running out is a refusal,
 * because the alternative is the silent overwrite this exists to prevent.
 *
 * @throws when every variant is taken by a different database.
 */
export function uniqueCredentialKey(key: string, url: string): string {
  const free = (candidate: string): boolean => {
    const held = getDbCredential(candidate);
    return held === null || held === url;
  };
  if (free(key)) return key;
  for (let n = 2; n <= MAX_KEY_VARIANTS; n++) {
    const candidate = `${key}-${String(n)}`;
    if (free(candidate)) return candidate;
  }
  throw new Error(
    `Lattice: the connection name "${key}" and every variant up to ` +
      `"${key}-${String(MAX_KEY_VARIANTS)}" already point at a different database. Pass an ` +
      `explicit name so this workspace gets its own.`,
  );
}

/** Resolve `path` relative to the config file directory unless it's already absolute. */
export function resolveRelativeToConfig(configPath: string, candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(configPath, '..', candidate);
}

/** Replace the `db:` line in a YAML config while preserving comments + order. */
export function rewriteDbLine(configPath: string, newValue: string): void {
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  doc.set('db', newValue);
  writeFileSync(configPath, doc.toString(), 'utf8');
}

/** Remove the `db:` line entirely — only used to undo a config that had none. */
function clearDbLine(configPath: string): void {
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  doc.delete('db');
  writeFileSync(configPath, doc.toString(), 'utf8');
}

/** The `db:` line exactly as written, or null when the config names none. */
export function readDbLine(configPath: string): string | null {
  const raw = parseDocument(readFileSync(configPath, 'utf8')).get('db');
  return typeof raw === 'string' ? raw : null;
}

/**
 * A file path written the way a config should carry it: relative and
 * POSIX-separated when it sits under the config's own directory, absolute when
 * it does not. Windows' backslashes would otherwise be written into a file that
 * is routinely shared across machines.
 */
export function portableDbPath(configPath: string, candidate: string): string {
  const abs = resolveRelativeToConfig(configPath, candidate);
  const rel = relative(resolve(configPath, '..'), abs);
  return rel.startsWith('..') ? abs : './' + rel.split(sep).join('/');
}

/** Where a workspace's data lives: a stored Postgres credential, or a local file. */
export type DatabasePointer =
  | { type: 'postgres'; key: string; url: string }
  | { type: 'sqlite'; path: string };

export interface PointConfigResult {
  /** The value written to the config's `db:` line. */
  dbLine: string;
  /**
   * Put the config — and the credential store — back exactly as they were.
   * Throws if it cannot; a caller unwinding a larger operation must report that
   * rather than assume the workspace is clean.
   */
  undo: () => void;
}

/**
 * Point `configPath` at `pointer`, and return the way back.
 *
 * For a Postgres pointer this stores the connection string under its key and
 * writes the reference that names it. For a local file it writes the path. The
 * credential is written FIRST so the config never names a key with nothing
 * behind it, and the credential's previous value (if the key was already in use)
 * is captured so undo restores it rather than deleting somebody else's.
 *
 * @throws when the config cannot be read or written. The credential write is
 * rolled back first, so a failure here leaves nothing behind.
 */
export function pointConfigAtDatabase(
  configPath: string,
  pointer: DatabasePointer,
): PointConfigResult {
  if (pointer.type === 'postgres' && !isCredentialKey(pointer.key)) {
    throw new Error(
      `Lattice: "${pointer.key}" cannot be a credential key — a config reads it back with ` +
        `[A-Za-z0-9._-] only, so a key outside that charset resolves to nothing and opens an ` +
        `empty database. Normalize it first (normalizeLabel).`,
    );
  }
  const previousLine = readDbLine(configPath);
  const previousCredential = pointer.type === 'postgres' ? getDbCredential(pointer.key) : null;

  const restoreCredential = (): void => {
    if (pointer.type !== 'postgres') return;
    if (previousCredential === null) deleteDbCredential(pointer.key);
    else saveDbCredential(pointer.key, previousCredential);
  };

  if (pointer.type === 'postgres') saveDbCredential(pointer.key, pointer.url);
  const dbLine =
    pointer.type === 'postgres'
      ? credentialRef(pointer.key)
      : portableDbPath(configPath, pointer.path);
  try {
    rewriteDbLine(configPath, dbLine);
  } catch (e) {
    restoreCredential();
    throw e;
  }

  return {
    dbLine,
    undo: () => {
      if (previousLine === null) clearDbLine(configPath);
      else rewriteDbLine(configPath, previousLine);
      restoreCredential();
    },
  };
}
