/**
 * The single way a CLI command opens the workspace named by its `--config`.
 *
 * Three things MUST happen before (and around) constructing the Lattice, and all
 * three are easy to forget when a new command is added:
 *
 *  1. **Resolve the master key.** The framework's own tables (`secrets`, `files`)
 *     carry encrypted columns, so any command that touches them needs the same
 *     key the browser uses — the environment variable or the machine-local key
 *     file.
 *
 *  2. **Hydrate the shared entity/render layout into the config file.** Someone
 *     who joined a shared workspace has a local config whose `entities:` block is
 *     EMPTY until it is filled in from the layout the workspace owner published.
 *     Constructing the Lattice before that happens yields a schema with ZERO
 *     tables, and that is actively destructive, not merely degraded: a reconcile
 *     on an empty schema compares the previous render manifest against "no entity
 *     contexts at all", concludes every previously-rendered context has been
 *     removed, and goes to delete the whole rendered tree from disk. The same
 *     empty schema makes the read-only commands (search, doctor, status) report
 *     on nothing at all. Hydration reads and rewrites the config FILE, so it has
 *     to run BEFORE the Lattice parses it — which is why this is an open helper
 *     rather than something the constructor could do for itself. It is a no-op
 *     for a workspace that is not shared, and for a config that already carries
 *     entities. A layout that could not be READ is a different thing entirely,
 *     and stops the command rather than opening an empty workspace.
 *
 *  3. **Apply the same schema every other opener applies.** A command, the
 *     library, and the browser must all see ONE workspace, not three views of it.
 *     The rendered tree is reconciled against what the LAST render wrote, so a
 *     command that opens with a smaller schema than the one that rendered the
 *     tree reads the difference as "these were removed" and deletes them — the
 *     same destruction as an un-hydrated open, arriving through a different door.
 *
 * And WHICH workspace is opened is decided in one place too — the same
 * resolution every command added since gets: a path that was typed wins, a
 * config sitting in the current directory is next, and otherwise the workspace
 * this machine is ACTIVELY using. Resolving the literal default path against
 * wherever the shell happens to be standing is not a resolution at all: it names
 * a file that exists almost nowhere, including inside the workspace directory
 * (whose file is called something else), so the read-and-render commands could
 * only ever be run by somebody who typed a path.
 *
 * Throws if the workspace cannot be resolved, if the config cannot be read or
 * parsed, and if the workspace is shared but its layout could not be read;
 * callers report that and exit.
 */
import { dirname } from 'node:path';
import { Lattice } from './lattice.js';
import { parseConfigFile } from './config/parser.js';
import { getOrCreateMasterKey } from './framework/user-config.js';
import { hydrateMemberConfigFromCloud } from './cloud/shared-schema.js';
import { applyWorkspaceSchema } from './framework/workspace-schema.js';
import { registerNativeEntities } from './framework/native-entities.js';
import { findLatticeRoot, resolveSessionRoot } from './framework/lattice-root.js';
import { findWorkspaceByConfigPath } from './framework/workspace.js';
import { resolveWorkspaceTarget } from './cli-target.js';

/**
 * The `.lattice` root that has `configPath` registered as one of its workspaces,
 * or null when the config is a standalone file belonging to no root.
 *
 * Two roots are worth asking, and they can differ: the one that OWNS the path
 * (found by looking upward from the config, which is how a root sitting under a
 * project directory is reached) and the one this session was told to use. A
 * config recorded in either is a workspace.
 */
function owningRoot(configPath: string): string | null {
  const candidates = [findLatticeRoot(dirname(configPath)), resolveSessionRoot().root];
  for (const root of candidates) {
    if (root === null) continue;
    try {
      if (findWorkspaceByConfigPath(root, configPath)) return root;
    } catch {
      // An unreadable or malformed registry answers "not a workspace of mine",
      // which is the honest answer to the question being asked here. The config
      // still opens — it just opens as the standalone file it looks like.
    }
  }
  return null;
}

/** Which workspace to open, in the terms the command line describes one. */
export interface OpenConfiguredLatticeArgs {
  /** `--config` as parsed, which carries a default the user may not have typed. */
  config: string;
  /**
   * True only when `--config` was actually passed.
   *
   * Omitting it means "this path is already resolved" — which is what a caller
   * that has run the resolution itself passes, and why the default is `true`:
   * such a path must be opened or fail, never quietly swapped for a different
   * workspace because the file it names has gone missing.
   */
  explicitConfig?: boolean;
  /** `--root`, when given. */
  root?: string | undefined;
}

export async function openConfiguredLattice(args: OpenConfiguredLatticeArgs): Promise<Lattice> {
  const { configPath } = resolveWorkspaceTarget({
    config: args.config,
    explicitConfig: args.explicitConfig ?? true,
    ...(args.root !== undefined ? { root: args.root } : {}),
  });
  // Parsed only for the database location hydration needs — the Lattice reads
  // the config file itself, AFTER hydration has had its chance to rewrite it.
  const parsed = parseConfigFile(configPath);
  const root = owningRoot(configPath);
  // Key from the root this workspace lives under, so a command and a library
  // open of the same workspace resolve the same key. A standalone config has no
  // root to key from and uses this session's.
  const encryptionKey = root === null ? getOrCreateMasterKey() : getOrCreateMasterKey(root);
  const hydration = await hydrateMemberConfigFromCloud(configPath, parsed.dbPath, encryptionKey);
  if (hydration.outcome === 'unavailable') {
    throw new Error(
      `Lattice: this workspace is shared, and its layout could not be read from the database ` +
        `(${hydration.reason}). Opening without it would treat the workspace as empty — which ` +
        `reports nothing, and on a reconcile goes after the rendered context tree. Fix the ` +
        `connection (or your access to it) and run this again.`,
    );
  }

  const db = new Lattice({ config: configPath }, { encryptionKey });
  if (root === null) {
    // A standalone config renders exactly the layout it declares; only the
    // framework's own tables are added, matching every other way of opening one.
    registerNativeEntities(db);
  } else {
    // Re-parsed, because hydration may have just rewritten the file.
    applyWorkspaceSchema(db, parseConfigFile(configPath).tables);
  }
  return db;
}
