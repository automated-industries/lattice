/**
 * The `lattice import` subcommand — turning a spreadsheet into tables from a
 * terminal.
 *
 * This is the operation the product is most often asked to do on a schedule:
 * here is this month's workbook, import it. Until now the only door was dropping
 * the file into the app and confirming, so the schedule had to be a person.
 *
 * The command takes a path and runs the SAME apply the confirm does — infer the
 * schema, recognise the file as a new period of something already held, split a
 * workbook too large for one plan into per-sheet units, and materialize it — with
 * the same no-overwrite guarantee: an import carrying no date of its own is filed
 * under today's, so re-running it next month APPENDS a snapshot instead of
 * clobbering the last one.
 *
 * `--dry-run` reads and plans without writing anything, which is how you find out
 * what a file would create before letting a job loose on it.
 *
 * WHERE THE OUTPUT GOES: the summary goes to stdout, the progress lines to
 * stderr, so `lattice import book.xlsx | tail -1` carries the outcome alone.
 * `--json` puts the structured result on stdout instead.
 *
 * Extracted from the CLI entrypoint so it is importable and therefore testable:
 * `cli.ts` calls `main()` at import time, so nothing defined inside it can be
 * exercised from a test.
 */
import { basename, dirname, resolve } from 'node:path';
import { openConfig, disposeActive } from './gui/lifecycle.js';
import type { ActiveDb } from './gui/active-db.js';
import { resolveWorkspaceTarget } from './cli-target.js';
import { commandLineSessionId } from './cli-ask.js';
import { createComputedTable } from './gui/computed-ops.js';
import { inferSchema } from './import/infer.js';
import { dedupeAndDetectViews } from './import/dedupe-views.js';
import { matchSchemaToExisting } from './import/match.js';
import type { ImportMode, MaterializeResult } from './import/materialize.js';
import {
  applyImport,
  existingDataTables,
  readImportSource,
  type ImportApplyEvent,
} from './ops/import-apply.js';

/** Everything the import subcommand needs from the parsed argv. */
export interface ImportCommandArgs {
  /** The positional: the file to import. */
  target?: string | undefined;
  /** `--config` as parsed, which carries a default the user may not have typed. */
  config: string;
  /** True only when `--config` was actually passed. */
  explicitConfig: boolean;
  /** `--root`, when given. */
  root?: string | undefined;
  /** `--json` — put the structured result on stdout instead of the summary. */
  json?: boolean;
  /** `--dry-run` — read and plan, write nothing. */
  dryRun?: boolean;
  /** `--mode <schema|contents|both>`. */
  mode?: string | undefined;
  /** `--as-of <YYYY-MM-DD>` — a file-level date for the whole import. */
  asOf?: string | undefined;
  /** `--as-of-column <name>` — the source dates each row itself. */
  asOfColumn?: string | undefined;
  /** `--sheet <name>` — one sheet of a multi-sheet workbook. */
  sheet?: string | undefined;
  /** `--yes` — proceed past the safe table cap, having reviewed the scope. */
  assumeYes?: boolean;
}

/** Where the command's two streams go. Injected so a test can read them. */
export interface ImportIo {
  /** The summary (or the JSON result). Nothing else is ever written here. */
  out(line: string): void;
  /** Progress and status. Safe to be noisy: it is not the output. */
  err(line: string): void;
  /** Opens the workspace. Injected so a test can hand over one it already has. */
  open?(configPath: string, outputDir: string): Promise<ActiveDb>;
}

export const IMPORT_USAGE =
  'Usage: lattice import <file> [--sheet <name>] [--as-of <YYYY-MM-DD>]\n' +
  '                             [--as-of-column <name>] [--mode schema|contents|both]\n' +
  '                             [--dry-run] [--yes] [--json]';

/** One line saying what landed, in the terms somebody asked in. */
export function importSummary(name: string, result: MaterializeResult): string {
  const rows = Object.values(result.rowsByTable).reduce((a, b) => a + b, 0);
  // Tables WRITTEN, not tables created. A re-import of a known document creates
  // nothing — every table is already there — and reporting "across 0 tables"
  // after loading hundreds of rows reads as though nothing happened. Which
  // tables were newly created is a separate, smaller fact, so it is said
  // separately rather than substituted for the one somebody asked about.
  const written = Object.keys(result.rowsByTable).length;
  const dated = result.asOfColumn
    ? ` dated by "${result.asOfColumn}"`
    : result.asOf
      ? ` as the ${result.asOf} snapshot`
      : '';
  const created =
    result.tablesCreated.length > 0 ? ` (new: ${result.tablesCreated.join(', ')})` : '';
  return (
    `Imported ${name}${dated}: ${String(rows)} row${rows === 1 ? '' : 's'} ` +
    `across ${String(written)} table${written === 1 ? '' : 's'}` +
    (result.links.length > 0 ? `, ${String(result.links.length)} link(s)` : '') +
    (result.views.length > 0 ? `, ${String(result.views.length)} view(s)` : '') +
    created
  );
}

/** Turn one progress line into something worth reading on a terminal. */
function progressLine(event: ImportApplyEvent): string | null {
  const message = typeof event.message === 'string' ? event.message : '';
  if (!message) return null;
  const phase = typeof event.phase === 'string' ? event.phase : '';
  return phase === 'warning' ? `  ! ${message}` : `  ${message}`;
}

/**
 * Run one `lattice import`.
 *
 * @returns the process exit code — 0 when the import landed, 1 when it created
 * nothing at all (which a script must not read as success).
 * @throws when the arguments name no file, or the workspace cannot be resolved
 * or opened. The caller reports and exits on it.
 */
export async function runImportCommand(args: ImportCommandArgs, io: ImportIo): Promise<number> {
  const target = (args.target ?? '').trim();
  if (!target) throw new Error(IMPORT_USAGE);
  const abs = resolve(target);
  const name = basename(abs);

  const ws = resolveWorkspaceTarget({
    config: args.config,
    explicitConfig: args.explicitConfig,
    ...(args.root !== undefined ? { root: args.root } : {}),
  });

  io.err(`Reading ${name}…`);
  const source = await readImportSource(abs, name, args.sheet ?? null);

  const active = await (io.open ?? openConfig)(ws.configPath, ws.contextDir);
  const sessionId = commandLineSessionId();
  try {
    io.err(`Workspace: ${dirname(ws.configPath)}`);
    for (const w of source.importWarnings) io.err(`  ! ${w}`);

    // ── Plan only ──
    // Reading and inferring writes nothing, so a caller can find out what a file
    // would create before a job is pointed at it. Deliberately the same inference
    // the apply runs, not a cheaper approximation that could disagree with it.
    if (args.dryRun) {
      const { plan } = await dedupeAndDetectViews(await inferSchema(source.data), source.data);
      const match = matchSchemaToExisting(existingDataTables(active.db), plan);
      const planned = {
        entities: plan.entities.map((e) => e.name),
        dimensions: plan.dimensions.map((d) => d.name),
        links: plan.linkages.length,
        recognizedAsExisting: match.isKnownDocument,
        matchedTables: match.matchedCount,
      };
      if (args.json) {
        io.out(JSON.stringify(planned, null, 2));
      } else {
        io.out(
          `Would create ${String(planned.entities.length)} table(s): ` +
            (planned.entities.join(', ') || '(none)'),
        );
        if (planned.dimensions.length > 0) {
          io.out(`Shared value sets: ${planned.dimensions.join(', ')}`);
        }
        if (match.isKnownDocument) {
          io.out(
            `Recognized as a new period of an existing document ` +
              `(${String(match.matchedCount)} of ${String(match.totalEntities)} tables matched).`,
          );
        }
      }
      return planned.entities.length > 0 ? 0 : 1;
    }

    const mode: ImportMode =
      args.mode === 'schema' || args.mode === 'contents' ? args.mode : 'both';
    const result = await applyImport(
      {
        db: active.db,
        configPath: active.configPath,
        latticeRoot: dirname(active.configPath),
        validTables: active.validTables,
        softDeletable: active.softDeletable,
        feed: active.feed,
        createComputed: (computedName, def) =>
          createComputedTable(active, computedName, def, sessionId),
      },
      source,
      {
        mode,
        asOf: args.asOf ?? null,
        asOfColumn: args.asOfColumn ?? null,
        override: args.assumeYes === true,
      },
      (event) => {
        const line = progressLine(event);
        if (line) io.err(line);
      },
    );

    if (args.json) io.out(JSON.stringify(result, null, 2));
    else io.out(importSummary(name, result));
    // An import that created no table and no row is not a success, whatever it
    // reported on the way — a script must not carry on as though data landed.
    const rows = Object.values(result.rowsByTable).reduce((a, b) => a + b, 0);
    return result.tablesCreated.length > 0 || rows > 0 ? 0 : 1;
  } finally {
    await disposeActive(active);
  }
}
