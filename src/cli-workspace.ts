/**
 * The `lattice workspace` subcommand, extracted from the CLI entrypoint so it is
 * importable (and therefore testable) on its own: `cli.ts` calls `main()` at
 * import time, so nothing defined inside it can be exercised from a test.
 *
 * Nothing here writes to stdout or exits the process. Output is RETURNED as
 * lines and errors are THROWN, so the same logic serves the CLI wrapper (which
 * prints and sets an exit code) and a caller that wants the outcome as a value.
 */
import { Lattice } from './lattice.js';
import {
  addWorkspace,
  effectiveConfigPath,
  getActiveWorkspace,
  listWorkspaces,
  setActiveWorkspace,
  type WorkspaceRecord,
} from './framework/workspace.js';
import { deleteWorkspace } from './ops/workspace-lifecycle.js';
import { renameWorkspace } from './ops/workspace-config.js';

/** Everything the workspace subcommand needs from the parsed argv. */
export interface WorkspaceCommandArgs {
  /** The `.lattice` root to operate on — already resolved by the caller. */
  root: string;
  /** `list` | `create` | `use` | `rename` | `delete`. Defaults to `list`. */
  subcommand?: string | undefined;
  /**
   * The trailing positional: the new display name for `create`, the workspace
   * to switch to for `use`, the workspace to rename for `rename`, the workspace
   * to remove for `delete`.
   */
  action?: string | undefined;
  /**
   * `--name <display>` — an explicit display name for `create`, and the new name
   * for `rename` (where it is required, since the positional names the target).
   */
  displayName?: string | undefined;
  /**
   * `--yes` — the explicit confirmation `delete` requires.
   *
   * Deleting a workspace destroys a database and, for a shared one, the
   * credentials this machine kept in order to reach it. A prompt is the usual
   * answer and it is the wrong one here: this command exists so the operation can
   * run with nobody watching, and a prompt in a script is a hang, not a
   * safeguard. A flag is a confirmation somebody had to write down.
   */
  assumeYes?: boolean;
}

/**
 * Find the workspace a human named. Accepts what a human actually has in front
 * of them — the display name they see in `lattice workspace list` — as well as
 * the UUID, which is stable across renames and is what scripts should use.
 *
 * Resolution order is most-specific-first, so an exact match always wins over a
 * looser one: id, then exact display name, then case-insensitive display name,
 * then the on-disk folder name. Two workspaces can legitimately share a display
 * name, so a name that matches more than one is REFUSED with the ids to
 * disambiguate with — never silently resolved to whichever came first.
 *
 * @throws if nothing matches, or if the reference is ambiguous.
 */
export function resolveWorkspaceRef(root: string, ref: string): WorkspaceRecord {
  const all = listWorkspaces(root);
  const byId = all.find((w) => w.id === ref);
  if (byId) return byId;

  const pick = (matches: WorkspaceRecord[]): WorkspaceRecord | null => {
    if (matches.length === 1) return matches[0] ?? null;
    if (matches.length > 1) {
      const ids = matches.map((w) => `${w.displayName} (${w.id})`).join(', ');
      throw new Error(
        `"${ref}" matches ${String(matches.length)} workspaces: ${ids}. Use the id instead.`,
      );
    }
    return null;
  };

  const lower = ref.toLowerCase();
  const exactName = pick(all.filter((w) => w.displayName === ref));
  if (exactName) return exactName;
  const looseName = pick(all.filter((w) => w.displayName.toLowerCase() === lower));
  if (looseName) return looseName;
  const byDir = pick(all.filter((w) => w.dir.toLowerCase() === lower));
  if (byDir) return byDir;

  throw new Error(
    `No workspace named "${ref}" under ${root}. Run \`lattice workspace list\` to see them.`,
  );
}

/**
 * Run one `lattice workspace` subcommand against an existing root.
 *
 * @returns the lines to print, in order.
 * @throws on a usage error, an unknown subcommand, or an unresolvable workspace.
 */
export async function runWorkspaceCommand(args: WorkspaceCommandArgs): Promise<string[]> {
  const { root } = args;
  const sub = args.subcommand ?? 'list';
  switch (sub) {
    case 'list': {
      const all = listWorkspaces(root);
      if (all.length === 0) return ['No workspaces. Run `lattice workspace create <name>`.'];
      const active = getActiveWorkspace(root);
      return all.map((w) => {
        const mark = w.id === active?.id ? '*' : ' ';
        return `${mark} ${w.displayName}  [${w.kind}]  ${w.dir}  ${w.id}`;
      });
    }
    case 'create': {
      // Either form works: a positional name (`create Research`) or the explicit
      // flag (`create --name Research`). The flag wins when both are given.
      const displayName = args.displayName ?? args.action;
      if (!displayName) {
        throw new Error('Usage: lattice workspace create <name>   (or --name <display name>)');
      }
      const ws = addWorkspace(root, { displayName });
      // Open once so the workspace exists on disk with its initial context tree.
      const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
      db.close();
      return [`Created workspace "${ws.displayName}" (${ws.dir})`];
    }
    case 'use': {
      if (!args.action) throw new Error('Usage: lattice workspace use <name-or-id>');
      const ws = resolveWorkspaceRef(root, args.action);
      setActiveWorkspace(root, ws.id);
      return [`Active workspace set to "${ws.displayName}" (${ws.id})`];
    }
    case 'rename': {
      if (!args.action) {
        throw new Error('Usage: lattice workspace rename <name-or-id> --name "<new name>"');
      }
      const ws = resolveWorkspaceRef(root, args.action);
      if (args.displayName === undefined) {
        throw new Error(
          `Nothing to rename "${ws.displayName}" to. Pass the new name: ` + '--name "<new name>".',
        );
      }
      // The registry knows where this workspace's config actually is — scaffolded
      // under its own folder, or adopted wherever the user already had it — so the
      // name is written to the right file either way.
      const renamed = renameWorkspace({
        configPath: effectiveConfigPath(root, ws),
        name: args.displayName,
        root,
      });
      const lines = [`Renamed workspace "${ws.displayName}" to "${renamed.name}"`];
      if (renamed.workspaceId === null) {
        // Reported, not swallowed: the file says the new name and the switcher
        // still says the old one, which is exactly the half-rename this reports.
        lines.push('  the registry had no record for this config — only the file was renamed');
      }
      return lines;
    }
    case 'delete': {
      if (!args.action) throw new Error('Usage: lattice workspace delete <name-or-id> --yes');
      // Resolve BEFORE asking for confirmation, so a typo is reported as a typo
      // rather than as a missing flag — and so the refusal can name what would
      // have gone.
      const ws = resolveWorkspaceRef(root, args.action);
      if (args.assumeYes !== true) {
        throw new Error(
          `Refusing to delete workspace "${ws.displayName}" (${ws.id}) without --yes. ` +
            `This permanently removes its database and, for a shared workspace, the ` +
            `credentials this machine kept in order to reach it. The shared database itself ` +
            `is never touched. Re-run with --yes if that is what you want.`,
        );
      }
      const removal = deleteWorkspace({ root, id: ws.id });
      const lines = [
        `Deleted workspace "${removal.workspace.displayName}" (${removal.workspace.id})`,
      ];
      if (removal.removedDir) lines.push(`  removed ${removal.removedDir}`);
      if (removal.removedConfig) lines.push(`  removed ${removal.removedConfig}`);
      if (removal.purgedLabel) {
        lines.push(`  purged the stored credentials for ${removal.purgedLabel}`);
      }
      if (!removal.removedDir && !removal.removedConfig) {
        lines.push('  its files were left where they are — this workspace only pointed at them');
      }
      return lines;
    }
    default:
      throw new Error(
        `Unknown workspace subcommand: ${sub} (expected: list | create | use | rename | delete)`,
      );
  }
}
