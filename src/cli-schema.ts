/**
 * The `lattice schema` subcommand — relationships and definitions from a
 * terminal.
 *
 * Nesting one table inside another, and saying what a column MEANS, are the two
 * schema edits a person makes constantly while a workspace is being shaped — and
 * both could only be made by clicking. That is backwards for the case they matter
 * most in: a workspace stood up by a script, an embedder preparing the same shape
 * twice, a migration that has to describe forty columns. Neither operation needs
 * anybody to look at anything.
 *
 * `links` lists what is nested where — and prints the exact `<table>.<column>`
 * reference `unlink` takes, because you cannot remove a link you cannot name.
 * `link` adds one, `unlink` removes it (softly: the column and its values stay,
 * so the change reverts), and `describe` writes a definition for a table or a
 * column.
 *
 * A table reference is `<table>`; a column reference is `<table>.<column>`. That
 * is the whole grammar, and it is why nothing here needs a third positional.
 *
 * Nothing here writes to stdout or exits the process. Output is RETURNED as lines
 * and errors are THROWN, so the same logic serves the CLI wrapper (which prints
 * and sets an exit code) and a caller that wants the outcome as a value.
 */
import { openConfig, disposeActive } from './gui/lifecycle.js';
import type { ActiveDb } from './gui/active-db.js';
import { getGuiEntities } from './gui/data.js';
import {
  addUserLink,
  removeUserLink,
  setColumnMeta,
  setTableDefinition,
} from './gui/schema-ops.js';
import { commandLineSessionId } from './cli-ask.js';

/** Everything the schema subcommand needs from the parsed argv. */
export interface SchemaCommandArgs {
  /** The workspace this command is about. */
  configPath: string;
  /** Its rendered-context directory. */
  contextDir: string;
  /** `links` | `link` | `unlink` | `describe`. Defaults to `links`. */
  subcommand?: string | undefined;
  /**
   * The trailing positional: the table for `links`, the child table for `link`,
   * and a `<table>` or `<table>.<column>` reference for `unlink` and `describe`.
   */
  action?: string | undefined;
  /** `--to <parent>` — the table a new link points at. */
  to?: string | undefined;
  /** `--text <definition>` — what `describe` writes. An empty string clears it. */
  text?: string | undefined;
  /** Opens the workspace. Injected so a test can hand over one it already has. */
  open?: (configPath: string, outputDir: string) => Promise<ActiveDb>;
}

export const SCHEMA_USAGE =
  'Usage: lattice schema links [<table>]\n' +
  '       lattice schema link <table> --to <parent>\n' +
  '       lattice schema unlink <table>.<column>\n' +
  '       lattice schema describe <table>[.<column>] --text "<definition>"';

/** A `<table>` or `<table>.<column>` reference, split. */
function splitRef(ref: string): { table: string; column?: string } {
  const dot = ref.indexOf('.');
  if (dot < 0) return { table: ref };
  return { table: ref.slice(0, dot), column: ref.slice(dot + 1) };
}

/**
 * Run one `lattice schema` subcommand against an existing workspace.
 *
 * The workspace is opened for the duration and closed again, including when the
 * operation fails — a command that leaves a store open behind it holds a file
 * handle nothing will ever release.
 *
 * @returns the lines to print, in order.
 * @throws on a usage error, an unknown subcommand, or a refused operation.
 */
export async function runSchemaCommand(args: SchemaCommandArgs): Promise<string[]> {
  const sub = args.subcommand ?? 'links';
  if (!['links', 'link', 'unlink', 'describe'].includes(sub)) {
    throw new Error(`Unknown schema subcommand: ${sub}\n${SCHEMA_USAGE}`);
  }
  const active = await (args.open ?? openConfig)(args.configPath, args.contextDir);
  const sessionId = commandLineSessionId();
  try {
    switch (sub) {
      case 'links': {
        const tables = getGuiEntities(active.configPath, active.outputDir).tables;
        const only = args.action;
        const lines: string[] = [];
        for (const t of tables) {
          if (only !== undefined && t.name !== only) continue;
          for (const rel of Object.values(t.relations)) {
            if (rel.type !== 'belongsTo') continue;
            lines.push(`${t.name}.${rel.foreignKey} → ${rel.table}`);
          }
        }
        if (only !== undefined && !tables.some((t) => t.name === only)) {
          throw new Error(`Unknown table: ${only}`);
        }
        if (lines.length === 0) {
          return [
            only === undefined
              ? 'Nothing is nested inside anything yet. Add one with `lattice schema link <table> --to <parent>`.'
              : `"${only}" is not nested inside anything.`,
          ];
        }
        return lines.sort();
      }
      case 'link': {
        const child = args.action;
        const parent = args.to;
        if (!child || !parent) {
          throw new Error('Usage: lattice schema link <table> --to <parent>');
        }
        const outcome = await addUserLink(active, child, parent, sessionId);
        // A refusal is the answer, not a fault — but it must not read as success.
        if (!outcome.ok) throw new Error(outcome.error);
        return [
          `Linked ${child} → ${parent} (${child}.${outcome.column})`,
          `  Remove it with \`lattice schema unlink ${child}.${outcome.column}\`.`,
        ];
      }
      case 'unlink': {
        if (!args.action) throw new Error('Usage: lattice schema unlink <table>.<column>');
        const { table, column } = splitRef(args.action);
        if (!column) {
          throw new Error(
            `"${args.action}" names a table, not a link. Use <table>.<column> — ` +
              '`lattice schema links` prints them.',
          );
        }
        const outcome = await removeUserLink(active, table, column, sessionId);
        if (!outcome.ok) throw new Error(outcome.error);
        return [
          `Unlinked ${table} → ${outcome.target}`,
          `  The column and its values are kept, so this reverts. Undo id: ${outcome.undoId}`,
        ];
      }
      default: {
        if (!args.action) {
          throw new Error(
            'Usage: lattice schema describe <table>[.<column>] --text "<definition>"',
          );
        }
        if (args.text === undefined) {
          throw new Error(
            `Nothing to write. Pass the definition: --text "<definition>" ` +
              '(an empty --text "" clears it).',
          );
        }
        const { table, column } = splitRef(args.action);
        if (column === undefined) {
          // The table form writes BOTH stores a definition is read from — the
          // configuration the data-model profiler consults and the browsable row
          // the interface and the assistant show. Writing only one is what makes a
          // documented table keep reading as undocumented.
          await setTableDefinition(active, table, args.text);
          return [
            args.text.trim() ? `Described ${table}.` : `Cleared the description of ${table}.`,
          ];
        }
        const outcome = await setColumnMeta(active, table, column, { description: args.text });
        if (!outcome.ok) throw new Error(outcome.error);
        return [
          args.text.trim()
            ? `Described ${table}.${column}.`
            : `Cleared the description of ${table}.${column}.`,
        ];
      }
    }
  } finally {
    await disposeActive(active);
  }
}
