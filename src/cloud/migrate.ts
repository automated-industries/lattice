import type { Lattice } from '../lattice.js';
import { parseConfigFile } from '../config/parser.js';
import { getOrCreateMasterKey } from '../framework/user-config.js';
import {
  archiveLocalSqlite,
  migrateLatticeData,
  openTargetLatticeForMigration,
  type MigrationProgress,
} from '../framework/cloud-migration.js';
import {
  isCredentialKey,
  pointConfigAtDatabase,
  readDbLine,
  uniqueCredentialKey,
} from '../framework/db-pointer.js';
import {
  readRegistry,
  registerOrUpdateCloudWorkspace,
  writeRegistry,
} from '../framework/workspace.js';
import { resolveContextDirForConfig } from '../framework/gui-bootstrap.js';
import { probeCloud } from '../framework/cloud-connect.js';
import { secureCloud } from './setup.js';
import { publishSharedSchema } from './shared-schema.js';
import { cloudError } from './errors.js';

/**
 * Moving a local workspace onto a shared database, as a capability.
 *
 * The copy itself has been a library call for a long time. The part that was
 * not — and the part that actually MOVES the workspace — is the last mile: the
 * config's `db:` line has to name the new database, the workspace registry has
 * to agree that this workspace is now a shared one, and the local file has to be
 * archived so nothing keeps writing to a store nobody reads. Those three writes
 * lived inline in a request handler, in that order, with no unwind between them.
 *
 * That is a data-integrity hazard, not a missing convenience. A failure halfway
 * through leaves a config pointing at a credential that was never stored, or a
 * registry that disagrees with the config, or — worst — a workspace whose local
 * database has been renamed out from under a config that still names it. None of
 * those announce themselves; the next open just finds an empty workspace.
 *
 * So the last mile here is a single reversible sequence. Each step records how
 * to undo itself, and any failure unwinds every step already taken, in reverse,
 * before rethrowing. The outcome is one of exactly two states: fully migrated,
 * or exactly as it was before — and if an unwind step ALSO fails, that failure
 * is named in the error rather than swallowed, because a half-unwound workspace
 * is precisely the thing a caller must not assume is clean.
 *
 * The archive is deliberately last, and deliberately a rename. It is the only
 * step that touches the data itself, so it happens once everything reversible
 * has already succeeded, and it renames rather than deletes so the original
 * bytes are still on disk under `<db>.local-bak` afterwards.
 *
 * WHAT IS NOT REVERSED, said plainly: the rows already copied into the target
 * database. Once the copy has started, the target holds some or all of the
 * workspace whether the rest succeeds or not — undoing that would mean deleting
 * somebody's data on the strength of a filesystem error, which is a worse failure
 * than the one being recovered from. EVERY failure past that point therefore
 * names the target and says what is in it, including whether row security got
 * installed, so the operator can drop it or point at it deliberately. A copy that
 * stopped before securing finished is the case that most needs saying: it is a
 * full copy of the workspace with nothing protecting it.
 */

/** The workspace registry state, captured so a failed cutover can restore it. */
type RegistrySnapshot = ReturnType<typeof readRegistry>;

/** One reversible step of the cutover, and how to take it back. */
interface Unwind {
  what: string;
  run: () => void;
}

/**
 * Undo every step already taken, most recent first, and report anything that
 * would not come back.
 *
 * @returns the description of each step that failed to unwind, in the order they
 * were attempted. Empty means the workspace is exactly as it was.
 */
function unwindAll(steps: Unwind[]): string[] {
  const failed: string[] = [];
  for (const step of steps.reverse()) {
    try {
      step.run();
    } catch (e) {
      failed.push(`${step.what} (${(e as Error).message})`);
    }
  }
  return failed;
}

/** Combine the failure that stopped the cutover with anything the unwind left behind. */
function cutoverFailure(cause: unknown, unwound: string[], targetUrlHost: string): Error {
  const why = (cause as Error).message;
  if (unwound.length === 0) {
    return new Error(
      `Migration cutover failed and was rolled back: ${why}\n` +
        `This workspace is unchanged and still open on its local database. The data was ` +
        `already copied to ${targetUrlHost}, so that database now holds a secured copy — ` +
        `drop it, or point a workspace at it deliberately, before trying again.`,
    );
  }
  return new Error(
    `Migration cutover failed AND could not be fully rolled back: ${why}\n` +
      `These could not be put back: ${unwound.join('; ')}\n` +
      `This workspace is in a mixed state and must be repaired by hand: check the config's ` +
      `db: line, the workspace registry, and whether the local database file was renamed ` +
      `to <db>.local-bak. The data was copied to ${targetUrlHost}.`,
  );
}

/** Close `db`, returning why it would not close rather than hiding it. */
function closeReporting(db: Lattice): string | null {
  try {
    db.close();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * What is sitting in the target database after a failed copy, said plainly.
 *
 * The rows are not rolled back — deleting somebody's data on the strength of a
 * dropped connection is a worse failure than the one being recovered from — so
 * the target holds a partial or complete copy of the workspace either way. The
 * part that MUST be said out loud is whether row security got installed on it:
 * until it does, the copy (files, secrets and private conversations included) is
 * readable by anything that can connect. An error naming only the underlying
 * fault gave an operator no reason to go and look.
 */
function copyLeftBehind(targetName: string, secured: boolean): string {
  const where = `${targetName} now holds a partial or complete copy of this workspace`;
  return secured
    ? `${where}, with row security installed. Drop that database, or point a workspace at it ` +
        `deliberately, before trying again.`
    : `${where}, and row security was NOT installed on it — everything copied so far, including ` +
        `files, secrets and private conversations, is readable by anything that can connect to ` +
        `it. Drop that database before trying again.`;
}

/** The host a URL names, for a message that must not print a password. */
function safeTargetName(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return 'the target database';
  }
}

export interface CloudCutoverInput {
  /** The workspace config whose `db:` line is being repointed. */
  configPath: string;
  /** Credential key AND display name. Must already be a valid credential key. */
  label: string;
  /** The connection string the workspace will use from now on. */
  url: string;
  /**
   * The `.lattice` root holding this workspace's registry record. Null when the
   * config belongs to no root, in which case there is no registry step.
   */
  latticeRoot?: string | null;
  /**
   * The local database file to archive once everything else has succeeded. Null
   * to skip the archive (there is nothing local to retire).
   */
  sourceDbPath?: string | null;
}

export interface CloudCutoverResult {
  label: string;
  /**
   * The name the connection string is stored under, which is `label` unless that
   * name was already spoken for by a DIFFERENT database — see
   * {@link cutOverWorkspaceToCloud}. Worth reporting: it is what appears in the
   * config's `db:` line and what an operator sees in the credential store.
   */
  credentialKey: string;
  /** What the config's `db:` line now says. */
  dbLine: string;
  /** The registry record now describing this workspace, or null with no root. */
  workspaceId: string | null;
  /** Where the local database file was moved to, or null when none was archived. */
  sourceBackupPath: string | null;
}

/**
 * Repoint a workspace at an already-populated shared database: store the
 * credential, rewrite the config, flip the registry record, archive the local
 * file. All of it, or none of it.
 *
 * Separated from {@link migrateWorkspaceToCloud} because it is the half with the
 * integrity risk and no network in it, so it can be driven — and its every
 * failure forced — without a database anywhere near the test.
 *
 * `label` names the workspace AND is the preferred name for the stored
 * connection, but the second of those is a request rather than a promise. The
 * credential store is one flat map for the whole machine, so a name that is
 * already holding a DIFFERENT database gets a numbered variant instead. Reusing
 * it would silently repoint whichever workspace already read that name at this
 * database — which is not hypothetical: the default name is the target's own
 * database name, and on most managed Postgres hosts every project's database is
 * called `postgres`. The name actually used is reported as `credentialKey`.
 *
 * @throws with the original reason plus anything the unwind could not restore.
 */
export function cutOverWorkspaceToCloud(input: CloudCutoverInput): CloudCutoverResult {
  const { configPath, label, url } = input;
  if (!isCredentialKey(label)) {
    throw cloudError(
      'invalid_request',
      `"${label}" cannot be a workspace credential key — use letters, numbers, dot, dash, ` +
        `or underscore.`,
    );
  }
  const root = input.latticeRoot ?? null;
  const sourceDbPath = input.sourceDbPath ?? null;
  const steps: Unwind[] = [];
  const target = safeTargetName(url);
  const credentialKey = uniqueCredentialKey(label, url);

  try {
    // 1 + 2 — the credential and the line that names it, as one reversible pair:
    // a config naming a key with nothing behind it is not a state worth having.
    const pointed = pointConfigAtDatabase(configPath, {
      type: 'postgres',
      key: credentialKey,
      url,
    });
    steps.push({ what: "the config's db: line and the stored credential", run: pointed.undo });

    // 3 — the registry, which is what the workspace switcher reads. Snapshotted
    // whole rather than diffed: restoring the file we read is exact, and the
    // record may be created OR updated in place depending on whether this
    // workspace was already registered.
    let workspaceId: string | null = null;
    if (root !== null) {
      const before: RegistrySnapshot = readRegistry(root);
      const record = registerOrUpdateCloudWorkspace(root, {
        configPath,
        contextDir: resolveContextDirForConfig(configPath),
        displayName: label,
        db: pointed.dbLine,
        makeActive: true,
      });
      workspaceId = record.id;
      steps.push({
        what: 'the workspace registry record',
        run: () => {
          writeRegistry(root, before);
        },
      });
    }

    // 4 — the local file. Last, because it is the only step that touches the
    // data, and a rename rather than a delete, so the bytes survive either way.
    const sourceBackupPath = sourceDbPath === null ? null : archiveLocalSqlite(sourceDbPath);

    return { label, credentialKey, dbLine: pointed.dbLine, workspaceId, sourceBackupPath };
  } catch (e) {
    throw cutoverFailure(e, unwindAll(steps), target);
  }
}

export interface MigrateWorkspaceInput {
  /** The OPEN source workspace, already initialized. The caller owns it. */
  db: Lattice;
  /** Its config file — the thing being repointed at the shared database. */
  configPath: string;
  /** The shared Postgres to move into. */
  url: string;
  /** Credential key AND workspace display name. Normalize a human label first. */
  label: string;
  /** The `.lattice` root holding the workspace's registry record, when it has one. */
  latticeRoot?: string | null;
  /** Defaults to this machine's master key — both sides must share one. */
  encryptionKey?: string;
  /**
   * Close the source handle, once the copy is finished and before its file is
   * renamed. A live server keeps its handle and swaps afterwards; a command owns
   * the handle and hands it over here, because renaming a database a process
   * still holds open is refused outright on some platforms.
   */
  releaseSource?: () => void | Promise<void>;
  onProgress?: (progress: MigrationProgress) => void;
}

export interface MigrateWorkspaceResult extends CloudCutoverResult {
  tablesCopied: string[];
  rowsCopied: number;
  /** Files whose bytes stayed on this machine; the rows point at nothing shared. */
  blobsNotMigrated?: number;
  /** A human-readable warning when there is one — today, only about those files. */
  warning?: string;
}

/**
 * Move a local workspace onto a shared Postgres database, end to end: check the
 * target, copy the data in, secure it, publish the layout members render with,
 * and cut this workspace over to it.
 *
 * Refuses before touching anything when the target is unreachable, when it is
 * already somebody's cloud (migrating in would mix two owners' data), or when
 * the source is not a local file (there is nothing to move).
 *
 * @throws a tagged cloud failure for a refusal, and a plain error for a copy or
 * cutover failure. Either way the source workspace is left usable — see
 * {@link cutOverWorkspaceToCloud} for exactly what "usable" is guaranteed to mean.
 */
export async function migrateWorkspaceToCloud(
  input: MigrateWorkspaceInput,
): Promise<MigrateWorkspaceResult> {
  const { db, configPath, url, label } = input;
  if (!isCredentialKey(label)) {
    throw cloudError(
      'invalid_request',
      `"${label}" cannot be a workspace credential key — use letters, numbers, dot, dash, ` +
        `or underscore.`,
    );
  }
  if (db.getDialect() !== 'sqlite') {
    throw cloudError(
      'invalid_request',
      'Only a local workspace can be migrated onto a shared database. This one is already ' +
        'on Postgres — join it, or secure it in place.',
    );
  }

  const probe = await probeCloud(url);
  if (!probe.reachable) {
    throw cloudError('cloud_unreachable', probe.error ?? 'Cloud DB unreachable');
  }
  if (probe.isCloud) {
    throw cloudError(
      'cloud_already_secured',
      'Target is already a Lattice cloud — migration aborts to avoid mixing data. Join it instead.',
    );
  }

  // The db: line is read BEFORE anything is written, because the cutover
  // overwrites it and the local file it names is what gets archived at the end.
  const sourceDbPath = readDbLine(configPath) === null ? null : parseConfigFile(configPath).dbPath;
  const encryptionKey = input.encryptionKey ?? getOrCreateMasterKey();

  const target = await openTargetLatticeForMigration(configPath, url, encryptionKey);
  // Whether row security has been installed on the target yet. It decides what a
  // failure has to WARN about, so it is tracked rather than inferred: up to the
  // moment `secureCloud` returns, the copy in the target is readable by anything
  // that can connect to it.
  let targetSecured = false;
  let result;
  try {
    result = await migrateLatticeData(
      db,
      target,
      input.onProgress ? { onProgress: input.onProgress } : {},
    );
    // Build the full-text indexes AFTER the rows land — the copy doesn't run
    // init's FTS step, which would otherwise leave the target with all the data
    // and no index, so search and the assistant find nothing.
    await target.rebuildFtsIndexes();
    // The migrating connection owns the target, so it installs row security and
    // stamps itself owner of every copied row. Members then see only what they
    // are given, and chat / secrets / history are isolated the same way.
    await secureCloud(target);
    targetSecured = true;
    // Publish the layout a joined member hydrates their own config from; without
    // it a member renders an empty context tree against rows they can read.
    await publishSharedSchema(target, configPath);
  } catch (e) {
    // Release the target's connections before reporting — but never let closing
    // it REPLACE the reason the copy failed, which a `finally` would do. Both are
    // reported when both happen; neither is swallowed.
    const closeFailure = closeReporting(target);
    const also =
      closeFailure === null ? '' : `\nThe target connection also failed to close: ${closeFailure}`;
    // Say what is now sitting in the target. Rows have almost certainly been
    // written by this point, and if securing had not finished they are wide open
    // — files, secrets and private conversations included. An error that named
    // only the network fault left an operator with no reason to go and look.
    throw new Error(
      `${(e as Error).message}${also}\n${copyLeftBehind(safeTargetName(url), targetSecured)}`,
    );
  }
  target.close();

  if (input.releaseSource) await input.releaseSource();

  const cutover = cutOverWorkspaceToCloud({
    configPath,
    label,
    url,
    latticeRoot: input.latticeRoot ?? null,
    sourceDbPath,
  });

  return {
    ...cutover,
    tablesCopied: result.tablesCopied,
    rowsCopied: result.rowsCopied,
    ...(result.blobsNotMigrated
      ? {
          blobsNotMigrated: result.blobsNotMigrated,
          warning:
            `${result.blobsNotMigrated.toString()} file(s) point at local bytes left behind on ` +
            `this machine and will not be reachable for members.`,
        }
      : {}),
  };
}
