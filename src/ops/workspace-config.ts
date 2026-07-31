/**
 * What a workspace's own configuration says, headless.
 *
 * Two operations sit beside `pointConfigAtDatabase`, and both existed only
 * inside request handlers — which is backwards, because the caller that most
 * wants them is a script standing a workspace up rather than a person looking at
 * a settings panel.
 *
 *   RENAMING. A workspace's name lives in two places that have to agree: the
 *   `name:` key in its own configuration, and the display name in the registry
 *   that lists it. Writing one without the other is what makes a renamed
 *   workspace keep its old label in the switcher — so this writes both, and says
 *   whether the registry actually had a record to update rather than leaving the
 *   caller to guess.
 *
 *   TESTING A CONNECTION. Asking "would this reach a database?" before committing
 *   it to the configuration is a pure question about a connection string, and the
 *   answer is the same whoever asks. The cloud half of it has been a library call
 *   for a while (`probeCloud`); the local half could only be asked by clicking.
 *
 * Neither reaches the network for the caller's benefit and then hides what it
 * found: a failed connection test is the ANSWER, returned as one, never a thrown
 * fault dressed up as a refusal.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { Lattice } from '../lattice.js';
import { buildPostgresUrl } from '../cloud/url.js';
import { resolveRelativeToConfig } from '../framework/db-pointer.js';
import { findWorkspaceByConfigPath, renameWorkspaceByConfigPath } from '../framework/workspace.js';
import { workspaceError } from './workspace-errors.js';

/**
 * A workspace name longer than this is a paste, not a name.
 *
 * Exported because the browser app enforces the same bound before it asks, and
 * two independently-chosen limits are how a field that validates locally starts
 * failing at the far end.
 */
export const MAX_WORKSPACE_NAME_CHARS = 200;

/** Which workspace to rename, and to what. */
export interface RenameWorkspaceInput {
  /** The workspace's configuration file. Its `name:` key is what gets written. */
  configPath: string;
  /** The new display name. Trimmed; must survive as a non-empty string. */
  name: string;
  /**
   * The `.lattice` root the workspace is registered under, when it is registered
   * at all. Omitted or null writes only the configuration — which is correct for
   * a workspace opened on a plain config outside any root, and is why this is not
   * an error case.
   */
  root?: string | null;
}

/** What a rename wrote. */
export interface WorkspaceRename {
  /** The name as stored, after trimming. */
  name: string;
  /** The configuration file that was rewritten. */
  configPath: string;
  /**
   * The id of the registry record that was renamed alongside it, or null when
   * no root was given or no record under that root points at this config.
   *
   * Reported rather than assumed: the registry write is a silent no-op when
   * nothing matches, so a caller that needs the switcher to show the new name
   * can tell "renamed both" from "renamed the file only".
   */
  workspaceId: string | null;
}

/**
 * Rename a workspace: write the `name:` key in its configuration, and mirror it
 * into the registry record that lists it.
 *
 * @throws a tagged `invalid_request` for an empty or over-long name, and an
 *         untagged error when the configuration cannot be read or written.
 */
export function renameWorkspace(input: RenameWorkspaceInput): WorkspaceRename {
  const name = input.name.trim();
  if (!name) throw workspaceError('invalid_request', 'name must be a non-empty string');
  if (name.length > MAX_WORKSPACE_NAME_CHARS) {
    throw workspaceError(
      'invalid_request',
      `name must be ${String(MAX_WORKSPACE_NAME_CHARS)} characters or fewer`,
    );
  }
  const doc = parseDocument(readFileSync(input.configPath, 'utf8'));
  doc.set('name', name);
  writeFileSync(input.configPath, doc.toString(), 'utf8');

  const root = input.root ?? null;
  // Look the record up BEFORE writing it, so the outcome can name what was
  // renamed. The registry helper reports nothing on a miss, and a caller told
  // "renamed" over an unchanged switcher entry has been misled.
  const record = root ? findWorkspaceByConfigPath(root, input.configPath) : null;
  if (root && record) renameWorkspaceByConfigPath(root, input.configPath, name);
  return { name, configPath: input.configPath, workspaceId: record?.id ?? null };
}

/**
 * A database to try to reach — the same two shapes a configuration can point at.
 *
 * Declared here rather than imported from the browser app's request-body types so
 * this module owes nothing to a route, while staying structurally compatible with
 * them: a parsed save body can be handed straight over.
 */
export type DatabaseTarget =
  | {
      type: 'postgres';
      host: string;
      port: number | string;
      dbname: string;
      user: string;
      password: string;
      /** Ignored here. Present so a parsed save body is assignable as-is. */
      label?: string;
    }
  | {
      type: 'sqlite';
      /** Absolute, or relative to the configuration the test is run against. */
      path: string;
    };

/** What to try to open, and what a relative local path is relative to. */
export interface DatabaseConnectionTest {
  /** The configuration a relative {@link DatabaseTarget} path resolves against. */
  configPath: string;
  /** The database to reach. */
  target: DatabaseTarget;
}

/**
 * Whether the database answered. A failure carries the message the driver gave,
 * because "it did not connect" without the reason is not a usable answer.
 */
export type DatabaseConnectionResult = { ok: true } | { ok: false; error: string };

/**
 * Open a database, confirm it initializes, and close it again.
 *
 * Returns the outcome instead of throwing it: an unreachable host, a rejected
 * password, and a path that is not a database are all things the caller ASKED
 * about, so each is an answer. A fault in this function itself would still throw.
 *
 * Note that opening a local path CREATES the store when nothing is there — the
 * same as pointing a workspace at it would. Testing a local target is therefore
 * a question about the path, not a promise that it leaves the disk untouched.
 */
export async function testDatabaseConnection(
  input: DatabaseConnectionTest,
): Promise<DatabaseConnectionResult> {
  const { target } = input;
  const url =
    target.type === 'postgres'
      ? buildPostgresUrl({
          host: target.host,
          port: Number(target.port),
          dbname: target.dbname,
          user: target.user,
          password: target.password,
        })
      : resolveRelativeToConfig(input.configPath, target.path);
  try {
    const probe = new Lattice(url);
    await probe.init();
    probe.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
