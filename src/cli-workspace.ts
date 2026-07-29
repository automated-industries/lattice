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
  getActiveWorkspace,
  listWorkspaces,
  setActiveWorkspace,
  type WorkspaceRecord,
} from './framework/workspace.js';

/** Everything the workspace subcommand needs from the parsed argv. */
export interface WorkspaceCommandArgs {
  /** The `.lattice` root to operate on — already resolved by the caller. */
  root: string;
  /** `list` | `create` | `use`. Defaults to `list`. */
  subcommand?: string | undefined;
  /**
   * The trailing positional: the new display name for `create`, the workspace
   * to switch to for `use`.
   */
  action?: string | undefined;
  /** `--name <display>` — an explicit display name for `create`. */
  displayName?: string | undefined;
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
    default:
      throw new Error(`Unknown workspace subcommand: ${sub} (expected: list | create | use)`);
  }
}
