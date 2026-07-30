/**
 * Which workspace a command is about — resolved once, for every command that
 * takes `--config`.
 *
 * A command is far more likely to be typed from an arbitrary directory than a
 * render is: you ask a question, or administer a shared database, from wherever
 * you happen to be. So an explicit `--config` wins, a config file sitting in the
 * current directory is used next, and otherwise the command falls back to the
 * ACTIVE workspace in the root.
 *
 * Nothing here creates a root or a workspace. A command that only reads — a
 * question, a diagnosis — must not leave anything behind on a machine that had
 * none, and a command that fails to resolve should say so rather than
 * helpfully inventing an empty workspace to run against.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSessionRoot, rootConfigDir } from './framework/lattice-root.js';
import {
  findWorkspaceByConfigPath,
  getActiveWorkspace,
  resolveWorkspacePaths,
} from './framework/workspace.js';
import { discoverOutputDir } from './gui/discover-output-dir.js';

/** Where a command operates: the config it opens, its rendered tree, and its root. */
export interface WorkspaceTarget {
  configPath: string;
  /** The rendered-context directory that goes with that config. */
  contextDir: string;
  /** The `.lattice` root holding it, or null when the config belongs to none. */
  latticeRoot: string | null;
}

/** What the CLI knows about which workspace the user meant. */
export interface WorkspaceTargetInput {
  /** `--config` as parsed, which carries a default the user may not have typed. */
  config: string;
  /** True only when `--config` was actually passed. */
  explicitConfig: boolean;
  /** `--root`, when given. */
  root?: string | undefined;
}

/**
 * The rendered-context directory for a config.
 *
 * A registered workspace records its own, which is the only answer that can be
 * right for one — its tree may sit anywhere. A standalone config has no record,
 * so the usual probe of the conventional locations decides, exactly as it does
 * when the app is started on one.
 */
function contextDirFor(configPath: string, root: string | null): string {
  if (root !== null) {
    try {
      const ws = findWorkspaceByConfigPath(root, configPath);
      if (ws) return resolveWorkspacePaths(root, ws).contextDir;
    } catch {
      // An unreadable or malformed registry answers "not a workspace of mine",
      // which is the honest answer to the question being asked here.
    }
  }
  return resolve(discoverOutputDir('./context', false));
}

/**
 * Decide which workspace a command is about.
 *
 * @throws when the named config does not exist, or when nothing resolves.
 */
export function resolveWorkspaceTarget(input: WorkspaceTargetInput): WorkspaceTarget {
  const named = resolve(input.config);
  const session = resolveSessionRoot({ explicitRoot: input.root });
  const root = existsSync(rootConfigDir(session.root)) ? session.root : null;

  if (input.explicitConfig) {
    if (!existsSync(named)) throw new Error(`No config file at ${named}.`);
    return { configPath: named, contextDir: contextDirFor(named, root), latticeRoot: root };
  }
  if (existsSync(named)) {
    return { configPath: named, contextDir: contextDirFor(named, root), latticeRoot: root };
  }

  if (root === null) {
    throw new Error(
      `No workspace to operate on: there is no config at ${named} and no .lattice root ` +
        `at ${session.root}. Pass --config <path>, or run \`lattice init\` first.`,
    );
  }
  const active = getActiveWorkspace(root);
  if (!active) {
    throw new Error(
      `No active workspace in ${root}. Run \`lattice workspace use <name>\` to pick one, ` +
        `or pass --config <path>.`,
    );
  }
  const paths = resolveWorkspacePaths(root, active);
  return { configPath: paths.configPath, contextDir: paths.contextDir, latticeRoot: root };
}
