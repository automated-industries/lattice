/**
 * Removing a workspace, headless.
 *
 * Deleting a workspace is two writes that have to agree: drop the registry
 * record, and remove the files that record owned. Doing one without the other is
 * the whole reason this is a capability rather than a handler — a record with no
 * files behind it opens into an error, and files with no record are a database
 * nothing lists and nobody can reach.
 *
 * The file half is also where a delete can be dangerously polite. Three kinds of
 * workspace need three different answers, and the wrong one is either
 * destructive or a false assurance:
 *
 *   scaffolded local   we created its folder, so we remove the folder.
 *   cloud              we remove the LOCAL pointer and everything this machine
 *                      kept in order to reconnect — the encrypted connection
 *                      string, the S3 keys, the bearer token. The shared remote
 *                      database is never touched: other people are using it.
 *   adopted local      the user's own files, which we only ever pointed at. They
 *                      stay exactly where they are.
 *
 * The cloud case is the one that matters most. Forgetting only the pointer
 * leaves the machine able to reconnect to a database its operator was told it
 * had been disconnected from, so a failure to remove that material MUST reach
 * the caller. Reporting a clean delete over still-working credentials is the
 * false assurance this exists to prevent, and it is why nothing here is caught
 * and logged.
 *
 * ORDER IS LOAD-BEARING. The registry record is dropped BEFORE the files, because
 * the cloud branch asks "does any other registered workspace still point at this
 * credential?" — and with the record still present, the answer is always yes and
 * nothing is ever purged.
 *
 * All of this used to live inside the browser app's request handlers — twice, in
 * two of them, because a workspace can be deleted while it is open and also while
 * nothing is open at all. Two copies of a rule about which files to destroy is
 * exactly the kind of duplication that drifts silently, so both routes now call
 * the function below.
 */
import { existsSync, rmSync } from 'node:fs';
import {
  getWorkspace,
  listWorkspaces,
  removeWorkspace,
  type WorkspaceRecord,
} from '../framework/workspace.js';
import { workspaceDir } from '../framework/lattice-root.js';
import { purgeWorkspaceSecrets } from '../framework/user-config.js';
import { workspaceError } from './workspace-errors.js';

/** What removing a workspace's files actually took off this machine. */
export interface WorkspaceFileCleanup {
  /** The scaffolded workspace folder that was removed, when the workspace owned one. */
  removedDir: string | null;
  /** The local pointer config that was removed, for a cloud workspace. */
  removedConfig: string | null;
  /**
   * The credential label this delete PURGED — meaning it is now guaranteed that
   * nothing keyed to that label remains on this machine, whether or not anything
   * was there to begin with.
   *
   * Null means no purge ran, which is two different situations and both are
   * correct: the workspace named no credential, or another registered workspace
   * still points at the same label, so the material is not this one's to remove.
   */
  purgedLabel: string | null;
}

/**
 * Remove a workspace's owned files from disk after its registry record has been
 * dropped. Loud on failure — the caller surfaces it rather than reporting a
 * delete that did not happen.
 *
 * Reports what it removed so a caller can say so; it used to return nothing,
 * which left every caller describing the outcome from its own guess about which
 * branch had run.
 */
export function cleanupWorkspaceFiles(root: string, ws: WorkspaceRecord): WorkspaceFileCleanup {
  const cleanup: WorkspaceFileCleanup = {
    removedDir: null,
    removedConfig: null,
    purgedLabel: null,
  };
  if (!ws.configPath && ws.kind === 'local') {
    const dir = workspaceDir(root, ws.dir);
    rmSync(dir, { recursive: true, force: true });
    cleanup.removedDir = dir;
  } else if (ws.kind === 'cloud') {
    if (ws.configPath && existsSync(ws.configPath)) {
      rmSync(ws.configPath, { force: true });
      cleanup.removedConfig = ws.configPath;
    }
    const labelMatch = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/.exec(ws.db.trim());
    const label = labelMatch?.[1];
    if (label) {
      // Another registered workspace pointing at the same label still needs
      // these — they are not exclusively this workspace's to remove.
      const stillUsed = listWorkspaces(root).some((w) =>
        w.db.includes('${LATTICE_DB:' + label + '}'),
      );
      if (!stillUsed) {
        purgeWorkspaceSecrets(root, label);
        cleanup.purgedLabel = label;
      }
    }
  }
  // Adopted local workspaces: leave the user's files in place (non-destructive).
  return cleanup;
}

/** Which workspace to remove, and from where. */
export interface DeleteWorkspaceInput {
  /** The `.lattice` root the workspace is registered under. */
  root: string;
  /** The workspace id. Ids survive renames, which is why this is not a name. */
  id: string;
}

/** The record that was removed, and what came off disk with it. */
export interface WorkspaceRemoval extends WorkspaceFileCleanup {
  workspace: WorkspaceRecord;
}

/**
 * Unregister a workspace and remove the files it owned.
 *
 * Does NOT close anything. A caller that currently has this workspace OPEN must
 * release its handle first — that is a property of the caller's process, not of
 * the workspace, and a library or command-line caller that never opened it has
 * nothing to release.
 *
 * @throws a tagged `not_found` when no workspace under `root` has that id, and
 *         an untagged error when the filesystem or the credential purge fails —
 *         at which point the record is already gone and the message says so.
 */
export function deleteWorkspace(input: DeleteWorkspaceInput): WorkspaceRemoval {
  const root = input.root.trim();
  if (!root) throw workspaceError('invalid_request', 'A .lattice root is required.');
  const id = input.id.trim();
  if (!id) throw workspaceError('invalid_request', 'id must be a string');

  const ws = getWorkspace(root, id);
  if (!ws) throw workspaceError('not_found', `No workspace with id ${id}`);

  // Registry first — see the note above on why the order cannot be swapped.
  removeWorkspace(root, ws.id);
  return { workspace: ws, ...cleanupWorkspaceFiles(root, ws) };
}
