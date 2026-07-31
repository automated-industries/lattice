/**
 * The `lattice database` subcommand — the databases INSIDE one workspace.
 *
 * A workspace holds a set of them and opens one at a time. `list` says which
 * exist, `create` adds one, `delete` removes one. The distinction from
 * `lattice workspace` is worth stating once: a workspace is a registry entry with
 * its own root and its own credentials; a database is one config file in that
 * workspace's directory. Deleting a workspace takes the whole set with it;
 * deleting a database takes one member of it.
 *
 * Nothing here writes to stdout or exits the process. Output is RETURNED as lines
 * and errors are THROWN, so the same logic serves the CLI wrapper (which prints
 * and sets an exit code) and a caller that wants the outcome as a value.
 */
import { resolve } from 'node:path';
import { listConfigs, type ListedConfig } from './gui/config-paths.js';
import { createDatabase, deleteDatabase, type DatabaseDeletion } from './ops/databases.js';

/** Everything the database subcommand needs from the parsed argv. */
export interface DatabaseCommandArgs {
  /**
   * Any config in the set — normally the workspace this command was pointed at.
   * Its DIRECTORY is the set every verb here operates on.
   */
  configPath: string;
  /** `list` | `create` | `delete`. Defaults to `list`. */
  subcommand?: string | undefined;
  /**
   * The trailing positional: the new name for `create`, the database to remove
   * for `delete`.
   */
  action?: string | undefined;
  /** `--name <display>` — an explicit name for `create`. Wins over the positional. */
  displayName?: string | undefined;
  /**
   * `--yes` — the explicit confirmation `delete` requires.
   *
   * Deleting a database destroys its rows. A prompt is the usual answer and it is
   * the wrong one here: this command exists so the operation can run with nobody
   * watching, and a prompt in a script is a hang rather than a safeguard. A flag
   * is a confirmation somebody had to write down.
   */
  assumeYes?: boolean;
}

/**
 * Find the database a human named. Accepts what a human actually has in front of
 * them — the label printed by `lattice database list` — as well as the config
 * filename and a path, which is what a script should pass.
 *
 * Resolution is most-specific-first, so an exact match always wins over a looser
 * one: the resolved path, then the exact label, then the filename, then a
 * case-insensitive label. Two databases can legitimately share a label, so one
 * that matches more than one is REFUSED with the paths to disambiguate with —
 * never silently resolved to whichever came first, because the operation this
 * feeds is irreversible.
 *
 * @throws if nothing matches, or if the reference is ambiguous.
 */
export function resolveDatabaseRef(configPath: string, ref: string): ListedConfig {
  const all = listConfigs(resolve(configPath));
  const asPath = resolve(ref);
  const byPath = all.find((c) => resolve(c.path) === asPath);
  if (byPath) return byPath;

  const pick = (matches: ListedConfig[]): ListedConfig | null => {
    if (matches.length === 1) return matches[0] ?? null;
    if (matches.length > 1) {
      const paths = matches.map((c) => `${c.label} (${c.path})`).join(', ');
      throw new Error(
        `"${ref}" matches ${String(matches.length)} databases: ${paths}. Use the path instead.`,
      );
    }
    return null;
  };

  const lower = ref.toLowerCase();
  const exactLabel = pick(all.filter((c) => c.label === ref));
  if (exactLabel) return exactLabel;
  const byName = pick(all.filter((c) => c.name === ref));
  if (byName) return byName;
  const looseLabel = pick(all.filter((c) => c.label.toLowerCase() === lower));
  if (looseLabel) return looseLabel;

  throw new Error(
    `No database named "${ref}" in this workspace. Run \`lattice database list\` to see them.`,
  );
}

/**
 * What a completed delete did to the deleted database's rows, in one line.
 *
 * Four outcomes, because there are four and a report that offers fewer has to
 * make one of them up. The one that matters is the third: a LOCAL database whose
 * store file was never written removes no file, exactly like a shared database
 * does, and calling that "your rows are elsewhere and untouched" is a false
 * statement about somebody's data on the single command where a false statement
 * about data is least recoverable.
 */
function storeOutcome(deleted: DatabaseDeletion): string[] {
  if (deleted.deletedDbFile) return [`  removed ${deleted.deletedDbFile}`];
  if (deleted.store.kind === 'shared') {
    return ['  its rows live in a shared database, which was not touched'];
  }
  if (deleted.store.kind === 'local') {
    return [`  it had no data file to remove — nothing was ever written to ${deleted.store.file}`];
  }
  const declared = deleted.store.declared;
  return [
    declared
      ? `  its store was "${declared}", which is not a file — nothing else was removed`
      : '  it named no store, so nothing else was removed',
  ];
}

/**
 * Run one `lattice database` subcommand against an existing workspace.
 *
 * @returns the lines to print, in order.
 * @throws on a usage error, an unknown subcommand, or an unresolvable database.
 */
export async function runDatabaseCommand(args: DatabaseCommandArgs): Promise<string[]> {
  const { configPath } = args;
  const sub = args.subcommand ?? 'list';
  switch (sub) {
    case 'list': {
      const all = listConfigs(resolve(configPath));
      if (all.length === 0) return ['No databases. Run `lattice database create <name>`.'];
      const activePath = resolve(configPath);
      return all.map((c) => {
        const mark = resolve(c.path) === activePath ? '*' : ' ';
        return `${mark} ${c.label}  [${c.kind}]  ${c.dbFile}  ${c.path}`;
      });
    }
    case 'create': {
      // Either form works: a positional name (`create Ledger`) or the explicit
      // flag (`create --name Ledger`). The flag wins when both are given, which
      // is how `workspace create` already behaves.
      const name = args.displayName ?? args.action;
      if (!name) {
        throw new Error('Usage: lattice database create <name>   (or --name <name>)');
      }
      const created = createDatabase({ configPath, name });
      return [
        `Created database "${created.name}" (${created.path})`,
        '  It has no tables yet, and its store is written the first time it is opened.',
      ];
    }
    case 'delete': {
      if (!args.action) throw new Error('Usage: lattice database delete <name-or-path> --yes');
      // Resolve BEFORE asking for confirmation, so a typo is reported as a typo
      // rather than as a missing flag — and so the refusal can name what would go.
      const target = resolveDatabaseRef(configPath, args.action);
      if (args.assumeYes !== true) {
        throw new Error(
          `Refusing to delete database "${target.label}" (${target.path}) without --yes. ` +
            `This permanently removes its config and, for a local database, its data file. ` +
            `Re-run with --yes if that is what you want.`,
        );
      }
      // No release hook: a command holds no open store, so there is no handle to
      // let go of before the files are unlinked.
      const deleted = await deleteDatabase({ configPath, target: target.path });
      const lines = [`Deleted database "${target.label}" (${deleted.deletedConfig})`];
      // What happened to the ROWS, told from where they actually lived. This is
      // the one line of this command somebody reads after an irreversible act, so
      // it reports the store that was classified before anything was unlinked —
      // never inferred from "no file was removed", which is equally true of a
      // shared database and of a local one whose file was never written.
      lines.push(...storeOutcome(deleted));
      lines.push(`  ${String(deleted.remaining.length)} left in this workspace`);
      return lines;
    }
    default:
      throw new Error(`Unknown database subcommand: ${sub} (expected: list | create | delete)`);
  }
}
