/**
 * Creating and removing the databases inside one workspace, headless.
 *
 * A workspace holds a SET of databases: sibling config files in one directory,
 * one of which is open at a time. Adding one scaffolds a blank config beside the
 * others; removing one deletes that config and, for a local store, the data file
 * behind it. Neither operation needs a browser, and both are the natural shape of
 * a script — stand a workspace up with the databases a project expects, tear down
 * the scratch one a test made.
 *
 * Both used to exist only inside request handlers, along with the two rules that
 * make the delete safe, so a caller outside the browser could neither perform the
 * operation nor inherit its safeguards:
 *
 *   CONTAINMENT. Only a config this workspace actually lists can be deleted.
 *   Without it, the operation is "unlink whatever path you are given", which is a
 *   very different and much worse operation than the one it looks like.
 *
 *   A WORKSPACE KEEPS A DATABASE. Removing the last one leaves a workspace that
 *   opens into nothing, so it is refused. This is a rule about the set, not about
 *   which database happens to be open, and it now reads that way.
 *
 * For a cloud config only the local YAML is removed. The remote database is
 * shared and is never touched from here.
 */
import { resolve } from 'node:path';
import {
  createBlankConfig,
  deleteDatabaseFiles,
  listConfigs,
  type ConfigStore,
} from '../gui/config-paths.js';
import { workspaceError } from './workspace-errors.js';

/** Where to add a database, and what to call it. */
export interface CreateDatabaseInput {
  /**
   * Any config in the set. Its DIRECTORY is the set, so the workspace's active
   * config is the ordinary thing to pass — the new database lands beside it.
   */
  configPath: string;
  /** The friendly name. Slugged into the new config's filename. */
  name: string;
}

/** The database that was scaffolded. */
export interface DatabaseCreation {
  /** Absolute path to the config file that was written. */
  path: string;
  /**
   * The name the new database is LISTED under, which is the name it was given.
   *
   * Not the filename. The filename is a slug derived from the name and it is
   * lossy — "Q3 Ledger" becomes `q3-ledger.config` — so reporting the filename
   * here would answer "what did you call it?" with a string the caller never
   * typed, and the obvious next command, deleting it by that name, would not
   * find it.
   */
  name: string;
}

/**
 * Scaffold a new, empty database beside an existing one: a starter config and
 * the data directory its store will live in. The store itself is created the
 * first time the database is opened.
 *
 * Does NOT open or switch to it. Which database a process has open is that
 * process's business; a caller that wants the new one open opens it.
 *
 * @throws a tagged `invalid_request` for an empty name, and an untagged error
 *         when the name cannot become a filename or a config by that name is
 *         already there.
 */
export function createDatabase(input: CreateDatabaseInput): DatabaseCreation {
  const name = input.name.trim();
  if (!name) throw workspaceError('invalid_request', 'name must be a non-empty string');
  const path = createBlankConfig(resolve(input.configPath), name);
  return { path, name };
}

/** Which database to remove, out of which set. */
export interface DeleteDatabaseInput {
  /** Any config in the set. Its directory is the set the target must belong to. */
  configPath: string;
  /** The config to delete. Must be one this workspace lists. */
  target: string;
  /**
   * Called once, after the target has been validated and BEFORE anything is
   * unlinked, with the configs that will remain.
   *
   * This is the seam for a caller that currently has the target OPEN: a live
   * store keeps a file handle, and on some platforms unlinking underneath it
   * either fails or leaves the process holding a file that no longer exists. A
   * caller holding no handle — a script, a command, a job — omits it entirely.
   *
   * Throwing from here ABORTS the delete with nothing removed, which is the
   * right answer when the handle could not be released: a database whose files
   * are gone but which the process still believes it has open is worse than one
   * that is still there.
   */
  releaseTarget?: (remaining: RemainingDatabases) => void | Promise<void>;
}

/**
 * The configs a delete leaves behind, in listing order — and never empty.
 *
 * The emptiness is carried in the TYPE rather than left to a comment, because
 * the one caller that reads this is switching a live process onto one of them
 * and would otherwise have to assert that a rule this module already enforces
 * still holds.
 */
export type RemainingDatabases = [string, ...string[]];

/** What removing a database took off disk, and what the set has left. */
export interface DatabaseDeletion {
  /** The config filename that was removed. */
  deletedConfig: string;
  /**
   * The local store that was removed with the config, or null when no file was
   * removed.
   *
   * Null does NOT mean "the rows are somewhere else, untouched". It also covers a
   * LOCAL database whose file was never written or is already gone, and reading
   * it as the first is how a delete comes to tell somebody their data lives in a
   * shared database when it never did. {@link store} is what that distinction is
   * for; a caller that reports the outcome to a person reads it, not this.
   */
  deletedDbFile: string | null;
  /** Where the deleted config's rows lived, read before anything was unlinked. */
  store: ConfigStore;
  /** Absolute paths of the configs still in the set, in listing order. */
  remaining: RemainingDatabases;
}

/**
 * Permanently remove one database from a workspace: its config, and for a local
 * store the data file plus its write-ahead siblings.
 *
 * Destructive and irreversible. The caller owns confirmation.
 *
 * @throws a tagged `not_found` when the target is not one of this workspace's
 *         databases, a tagged `last_database` when it is the only one left, and
 *         an untagged error when the release hook or the filesystem fails.
 */
export async function deleteDatabase(input: DeleteDatabaseInput): Promise<DatabaseDeletion> {
  const raw = input.target.trim();
  if (!raw) throw workspaceError('invalid_request', 'path must be a non-empty string');
  const target = resolve(raw);

  // Only a config we actually list. This stops the operation from being coaxed
  // into unlinking arbitrary files outside the database set.
  const known = listConfigs(resolve(input.configPath));
  if (!known.some((c) => resolve(c.path) === target)) {
    throw workspaceError('not_found', `Not a known database config: ${target}`);
  }
  const [first, ...rest] = known
    .filter((c) => resolve(c.path) !== target)
    .map((c) => resolve(c.path));
  if (first === undefined) {
    throw workspaceError(
      'last_database',
      'Cannot delete the only database. Create or add another database first, then delete this one.',
    );
  }
  const remaining: RemainingDatabases = [first, ...rest];

  await input.releaseTarget?.(remaining);

  let deleted: { deletedConfig: string; deletedDbFile: string | null; store: ConfigStore };
  try {
    deleted = deleteDatabaseFiles(target);
  } catch (e) {
    // Surface a filesystem failure loudly rather than half-deleting silently,
    // and keep the original so a caller can inspect what the platform said.
    throw new Error(`Failed to delete database files: ${(e as Error).message}`, { cause: e });
  }
  return { ...deleted, remaining };
}
