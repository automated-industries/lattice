import { deleteDbCredential, getDbCredential, saveDbCredential } from './user-config.js';
import { credentialRef, readDbLine, uniqueCredentialKey } from './db-pointer.js';
import {
  addWorkspace,
  removeWorkspace,
  resolveWorkspacePaths,
  setActiveWorkspace,
  type WorkspacePaths,
} from './workspace.js';

/**
 * Turn a reachable cloud database into a workspace of its own.
 *
 * Joining a cloud — by redeeming an invite, by typing the credentials the owner
 * issued, or by having a membership synced down — always ends in the same four
 * steps: store the credential encrypted under a sanitized key, scaffold a NEW
 * workspace whose `db:` line points at that key, make it the active one, and
 * open it. It must be a new workspace and never a repoint of the one already
 * open: repointing overwrote whichever local workspace happened to be in front
 * of the user, leaving the wrong name, orphaned data, and no switcher entry.
 *
 * The sequence used to live as a closure inside the server, which made joining a
 * cloud something only a running server could do. It is a plain function here,
 * and the steps that genuinely belong to a live session — opening the database
 * and adopting it as the current one — are injected. A caller with no session (a
 * script, a command) passes neither and gets the registry work alone; the browser
 * app passes both and the open session swaps over as before.
 *
 * FOUR THINGS IT REFUSES TO DO QUIETLY, each of which it used to do:
 *
 * 1. Overwrite somebody else's connection. The credential store is one flat map
 *    for the whole machine and the key comes from a name, so joining a second
 *    cloud called "Acme" used to point the FIRST "Acme" workspace at the second
 *    cloud's database. The key is de-collided before anything is written.
 * 2. Delete a connection it did not create. Both rollback paths removed the key
 *    outright, so a failed join took out whatever was already stored under that
 *    name. Whatever the key held is captured first and put back instead.
 * 3. Report a cloud workspace whose config opens something else. The scaffold
 *    skips writing a starter config when one is already at that path, which left
 *    a registry record marked `cloud` over a config still naming a local file —
 *    a silent wrong-database open. The written config is read back and has to
 *    name this cloud, or the whole thing rolls back.
 * 4. Spend something it cannot give back and then throw the proceeds away. See
 *    {@link CloudWorkspaceHandlers.authorize}.
 *
 * Failures are rethrown, never swallowed.
 */

/**
 * The irreversible step a join may have to take, injected so the scaffold can
 * order it correctly.
 */
export interface CloudWorkspaceAuthorization {
  /**
   * Take the one step that cannot be taken back — spending a single-use invite.
   *
   * Deliberately run AFTER the workspace exists locally and BEFORE it is opened,
   * because that is the only point where both halves are true: a refusal can
   * still unwind everything, since nothing outside this machine has happened
   * yet; and a failure afterwards no longer costs the caller their invite, since
   * the workspace it bought is already registered and already pointed at the
   * right cloud.
   *
   * Claiming first — which is what this used to do — meant a transient failure
   * while opening the database left the invite spent, the credential deleted,
   * and the member with no way back in short of asking the owner for a new
   * invite. A throw here still rolls the whole scaffold back.
   */
  authorize?: () => Promise<void>;
}

/** What a caller supplies to reach a cloud workspace once it has been scaffolded. */
export interface CloudWorkspaceHandlers<T> extends CloudWorkspaceAuthorization {
  /**
   * Open the freshly scaffolded workspace. A throw here rolls the scaffold back
   * and propagates, so the caller sees the real reason the cloud would not open —
   * unless {@link CloudWorkspaceAuthorization.authorize} has already run, in
   * which case the workspace is KEPT and the error says how to reach it.
   */
  open?: (paths: WorkspacePaths) => Promise<T>;
  /**
   * Adopt what {@link CloudWorkspaceHandlers.open} returned as the live
   * workspace. Runs only after the registry already points at the new id, which
   * is the order the browser app relies on.
   */
  adopt?: (opened: T, workspaceId: string) => Promise<void>;
}

/**
 * Register `url` as a new cloud workspace named `displayName`, keyed by `key`,
 * and return its workspace id.
 *
 * `key` must already be a sanitized, space-free label — it becomes the basis of
 * both the credential key and the `${LATTICE_DB:…}` reference, and the path
 * resolver rejects anything else. It is a REQUEST, not a guarantee: a key already
 * holding a different database gets a numbered variant instead, because reusing
 * it would repoint an existing workspace. The human-readable name is
 * `displayName` and is kept separate.
 */
export async function createCloudWorkspace<T = void>(
  latticeRoot: string | null,
  displayName: string,
  key: string,
  url: string,
  handlers: CloudWorkspaceHandlers<T> = {},
): Promise<string> {
  if (!latticeRoot) throw new Error('No .lattice root — cannot create a cloud workspace');
  // Pick a key nobody else's workspace is already reading, and remember what it
  // held (an identical URL from an earlier join of the same cloud) so an unwind
  // restores rather than deletes.
  const credentialKey = uniqueCredentialKey(key, url);
  const previousCredential = getDbCredential(credentialKey);
  const unwindCredential = (): void => {
    if (previousCredential === null) deleteDbCredential(credentialKey);
    else saveDbCredential(credentialKey, previousCredential);
  };

  const dbLine = credentialRef(credentialKey);
  saveDbCredential(credentialKey, url);
  let created;
  try {
    created = addWorkspace(latticeRoot, { displayName, db: dbLine, makeActive: false });
  } catch (e) {
    unwindCredential();
    throw e;
  }

  const paths = resolveWorkspacePaths(latticeRoot, created);
  /** Undo everything this call has made. Only safe while nothing has been spent. */
  const unwindAll = (): void => {
    removeWorkspace(latticeRoot, created.id);
    unwindCredential();
  };

  // The scaffold leaves an existing config file alone, so a record can be marked
  // `cloud` over a config that still opens something else. Read back what the
  // workspace will actually open; a disagreement is a wrong-database join and is
  // refused rather than reported as a successful one. A config that cannot be
  // read at all counts as a disagreement: it is not this cloud either, and it is
  // the same file the next open would choke on.
  let written: string | null = null;
  let unreadable: string | null = null;
  try {
    written = readDbLine(paths.configPath);
  } catch (e) {
    unreadable = (e as Error).message;
  }
  if (unreadable !== null || written !== dbLine) {
    unwindAll();
    throw new Error(
      `Lattice: the new workspace "${displayName}" would open ` +
        `${unreadable === null ? (written ?? 'no database') : `an unreadable config (${unreadable})`} ` +
        `instead of the cloud it was created for — a config file was already at ` +
        `${paths.configPath}. Move or remove it, or join under a different name.`,
    );
  }

  if (handlers.authorize) {
    try {
      await handlers.authorize();
    } catch (e) {
      unwindAll();
      throw e;
    }
  }

  let opened: T | undefined;
  let didOpen = false;
  if (handlers.open) {
    try {
      opened = await handlers.open(paths);
      didOpen = true;
    } catch (e) {
      if (!handlers.authorize) {
        unwindAll();
        throw e;
      }
      // Something single-use was already spent to get here, so the workspace and
      // its credential STAY — they are what that purchase bought, and they are
      // already correct. Not made active: this session could not open it, and
      // pointing the registry at a workspace that just failed to open would move
      // the failure to the next start instead of reporting it now.
      throw new Error(
        `Joined, but this workspace could not be opened right now: ${(e as Error).message}\n` +
          `It is registered as "${displayName}" and already points at the shared database, so ` +
          `nothing needs to be redeemed again — switch to it once the database is reachable.`,
      );
    }
  }
  setActiveWorkspace(latticeRoot, created.id);
  if (didOpen && handlers.adopt) await handlers.adopt(opened as T, created.id);
  return created.id;
}
