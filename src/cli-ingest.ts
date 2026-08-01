/**
 * The `lattice ingest` subcommand — bringing documents in from a terminal.
 *
 * Dropping a file into the app was the only way to get a document into a
 * workspace, which made the single most scriptable thing this product does
 * unscriptable: a folder of contracts, a nightly export, a machine being
 * prepared the same way twice. All of it needed a person, a browser, and a
 * drag-and-drop.
 *
 * So this takes what the browser takes — a path, a folder, a web address, or
 * text on standard input — and runs the SAME pipeline: read it, extract it,
 * describe it, import the data inside it, notice a document already held, and
 * link what it is about to the records it belongs with. Nothing here is a
 * reduced version of the drop.
 *
 * A FOLDER IS REGISTERED, NOT JUST READ. `lattice ingest ./contracts` records
 * that folder as a source of this workspace and then walks it, which is exactly
 * what adding a folder in the app does — so running it again picks up what
 * changed, and the app shows the same folder the script added. `--once` walks
 * without registering, for a directory that is not a standing source.
 *
 * WHERE THE OUTPUT GOES: the summary goes to stdout, progress to stderr, so
 * `lattice ingest ./docs | tail -1` carries the outcome alone. `--json` puts the
 * structured result on stdout instead.
 *
 * Extracted from the CLI entrypoint so it is importable and therefore testable:
 * `cli.ts` calls `main()` at import time, so nothing defined inside it can be
 * exercised from a test.
 */
import { statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { openConfig, disposeActive } from './gui/lifecycle.js';
import type { ActiveDb } from './gui/active-db.js';
import { resolveWorkspaceTarget } from './cli-target.js';
import { fileJunctions, entityDescriptions } from './gui/data.js';
import { createUserEntity, createUserJunction, createFileJunction } from './gui/schema-ops.js';
import { getAggressiveness } from './ops/ai-config.js';
import { commandLineSessionId } from './cli-ask.js';
import {
  ingestMutationCtx,
  ingestPath,
  ingestText,
  mimeFor,
  type IngestContext,
} from './ops/ingest-file.js';
import { looksLikeUrl } from './ops/ingest-text.js';
import {
  addSourceRoot,
  ingestFolder,
  listSourceRoots,
  removeSourceRoot,
  type IngestFolderResult,
} from './ops/source-roots.js';

/** The two registry verbs, which take a word rather than a path. */
export const INGEST_SUBCOMMANDS = ['sources', 'forget'] as const;

/** Everything the ingest subcommand needs from the parsed argv. */
export interface IngestCommandArgs {
  /** The positional: a path, a folder, a web address, or a registry verb. */
  target?: string | undefined;
  /** The second positional — the id `forget` removes. */
  action?: string | undefined;
  /** `--config` as parsed, which carries a default the user may not have typed. */
  config: string;
  /** True only when `--config` was actually passed. */
  explicitConfig: boolean;
  /** `--root`, when given. */
  root?: string | undefined;
  /** `--json` — put the structured result on stdout instead of the summary. */
  json?: boolean;
  /** `--title <name>` — the name a text ingest is filed under. */
  title?: string | undefined;
  /** `--private` — force the document and everything derived from it private. */
  privateMode?: boolean;
  /** `--once` — walk a folder without registering it as a standing source. */
  once?: boolean;
  /** `--stdin` — read the document's text from standard input. */
  stdin?: boolean;
}

/** Where the command's two streams go. Injected so a test can read them. */
export interface IngestIo {
  /** The summary (or the JSON result). Nothing else is ever written here. */
  out(line: string): void;
  /** Progress and status. Safe to be noisy: it is not the output. */
  err(line: string): void;
  /** Opens the workspace. Injected so a test can hand over one it already has. */
  open?(configPath: string, outputDir: string): Promise<ActiveDb>;
  /** Reads standard input for `--stdin`. Injected for tests. */
  readStdin?: () => Promise<string>;
}

export const INGEST_USAGE =
  'Usage: lattice ingest <path|folder|url> [--once] [--private] [--json]\n' +
  '       lattice ingest --stdin [--title <name>]\n' +
  '       lattice ingest sources          (list the registered folders)\n' +
  '       lattice ingest forget <id>      (stop watching one)';

/** Read everything on standard input as text. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Every primitive an ingest may use, wired to an open workspace.
 *
 * The same wiring the app hands the ingest pipeline — the audited, reversible
 * schema ops included — so a document ingested from a terminal is linked and
 * extracted exactly as one dropped into the app is. Rendering is left on: a
 * freshly-ingested row whose rendered context has not been written reads as an
 * empty record, and a script has nobody watching to notice.
 */
export function ingestContextFor(active: ActiveDb, sessionId: string): IngestContext {
  return {
    db: active.db,
    feed: active.feed,
    softDeletable: active.softDeletable,
    fileJunctions: fileJunctions(active.configPath, active.outputDir),
    entityDescriptions: entityDescriptions(active.configPath, active.outputDir),
    createJunction: (otherTable: string) => createFileJunction(active, otherTable, sessionId),
    createObjectJunction: (a: string, b: string) => createUserJunction(active, a, b, sessionId),
    createEntity: (entity: string, columns: string[]) =>
      createUserEntity(active, entity, columns, sessionId, { rejectAnonymous: true }),
    aggressiveness: getAggressiveness(),
    latticeRoot: dirname(active.configPath),
    configPath: active.configPath,
    outputDir: active.outputDir,
    autoRender: true,
    sessionId,
  };
}

/**
 * The exit code for a document that landed, and the reason on stderr when it is
 * not zero.
 *
 * A row carrying an extraction or enrichment error is NOT a success. The
 * document is recorded, and the whole point of recording it — reading it,
 * describing it, pulling the data out of it, linking it to what it is about —
 * did not happen. Reporting that as zero is how a nightly job ingests a folder
 * of unreadable documents and reports a clean run every night.
 *
 * Every branch that lands a document runs through here, because the failure is
 * the same failure whether the text arrived on standard input, from a web
 * address, or from a path: the earlier version of this command guarded only the
 * path, so the identical enrichment failure exited 1 from a file and 0 from a
 * pipe.
 */
function ingestedExitCode(result: { error?: unknown }, io: IngestIo): number {
  if (result.error === undefined) return 0;
  const why = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
  io.err(`The document was recorded, but processing it failed: ${why}`);
  return 1;
}

/** One line summarising what a folder walk brought in — including what it did not. */
export function folderSummary(path: string, r: IngestFolderResult): string {
  const parts = [`Ingested ${String(r.ingested)} of ${String(r.scanned)} files from ${path}`];
  if (r.skipped > 0) parts.push(`${String(r.skipped)} skipped`);
  if (r.capped) parts.push('stopped at the per-run file limit — run it again for the rest');
  if (r.scanTruncated) {
    parts.push('stopped collecting at the scan limit — the folder is very large');
  }
  return parts.join('; ');
}

/**
 * Run one `lattice ingest`.
 *
 * @returns the process exit code — 0 when something was ingested, 1 when nothing was.
 * @throws when the arguments name nothing to ingest, or the workspace cannot be
 * resolved or opened. The caller reports and exits on it.
 */
export async function runIngestCommand(args: IngestCommandArgs, io: IngestIo): Promise<number> {
  const target = (args.target ?? '').trim();
  if (!args.stdin && !target) throw new Error(INGEST_USAGE);

  const ws = resolveWorkspaceTarget({
    config: args.config,
    explicitConfig: args.explicitConfig,
    ...(args.root !== undefined ? { root: args.root } : {}),
  });

  // The registry verbs touch nothing but the list of registered sources — no
  // model, no extraction — so they answer without opening the database at all.
  if (!args.stdin && target === 'sources') {
    const roots = listSourceRoots(ws.configPath);
    if (args.json) {
      io.out(JSON.stringify(roots, null, 2));
    } else if (roots.length === 0) {
      io.out('No folders or files are registered as sources of this workspace.');
    } else {
      for (const r of roots) io.out(`${r.id}  ${r.kind.padEnd(6)}  ${r.path}`);
    }
    return 0;
  }
  if (!args.stdin && target === 'forget') {
    const id = (args.action ?? '').trim();
    if (!id) {
      throw new Error(
        'Usage: lattice ingest forget <id> — run "lattice ingest sources" for the id.',
      );
    }
    const { removed } = removeSourceRoot(ws.configPath, id);
    if (!removed) {
      // Reporting success for an id that matched nothing would leave a script
      // believing it had stopped watching a folder it is still watching.
      io.err(`No registered source has the id ${id}.`);
      return 1;
    }
    io.out(`Stopped watching ${id}. The documents already ingested from it are untouched.`);
    return 0;
  }

  const active = await (io.open ?? openConfig)(ws.configPath, ws.contextDir);
  const sessionId = commandLineSessionId();
  const ctx = ingestContextFor(active, sessionId);
  const mctx = ingestMutationCtx(ctx);
  const privateMode = args.privateMode === true;
  try {
    io.err(`Workspace: ${dirname(ws.configPath)}`);

    // ── Text on standard input ──
    if (args.stdin) {
      const text = await (io.readStdin ?? readAllStdin)();
      const result = await ingestText(ctx, mctx, text, {
        ...(args.title ? { title: args.title } : {}),
        privateMode,
      });
      if (args.json) io.out(JSON.stringify(result, null, 2));
      else io.out(`Ingested as ${String(result.id)}`);
      return ingestedExitCode(result, io);
    }

    // ── A web address ──
    // Read through the same URL path the app uses (address safety, policy, rate
    // limit, untrusted-content framing) rather than fetching it here.
    if (looksLikeUrl(target)) {
      io.err(`Reading ${target}…`);
      const result = await ingestText(ctx, mctx, target, { privateMode });
      if (args.json) io.out(JSON.stringify(result, null, 2));
      else io.out(`Ingested ${target} as ${String(result.id)}`);
      return ingestedExitCode(result, io);
    }

    // ── A path on this machine ──
    const abs = resolve(target);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(abs).isDirectory();
    } catch {
      throw new Error(`Nothing to ingest at ${abs}.`);
    }

    if (isDirectory) {
      const ingestFile = (p: string) => ingestPath(ctx, mctx, p, { privateMode });
      // `--once`: walk without registering, for a directory that is not a
      // standing source of this workspace.
      if (args.once) {
        io.err(`Walking ${abs}…`);
        const r = await ingestFolder(abs, ingestFile, ctx.db, undefined, active.feed);
        if (args.json) io.out(JSON.stringify(r, null, 2));
        else io.out(folderSummary(abs, r));
        return r.ingested > 0 ? 0 : 1;
      }
      // The default: a folder becomes a standing source, then is walked — so the
      // app and the command line agree about where this workspace's documents
      // come from, and a re-run picks up what changed.
      io.err(`Registering ${abs} as a source and walking it…`);
      const added = await addSourceRoot(
        {
          db: ctx.db,
          ingestFile,
          configPath: active.configPath,
          feed: active.feed,
        },
        { path: abs, kind: 'folder' },
      );
      const r = added.result as IngestFolderResult;
      if (args.json) io.out(JSON.stringify(added, null, 2));
      else io.out(folderSummary(abs, r));
      return r.ingested > 0 ? 0 : 1;
    }

    // A single file, read in place as a local reference — exactly what the app
    // does when it is given a real path.
    io.err(`Reading ${basename(abs)} (${mimeFor(abs)})…`);
    const result = await ingestPath(ctx, mctx, abs, { privateMode });
    if (args.json) {
      io.out(JSON.stringify(result, null, 2));
    } else {
      io.out(`Ingested ${basename(abs)} as ${result.id} (${result.extraction_status})`);
      if (result.suggestedLinks.length > 0) {
        io.err(`Linked to ${String(result.suggestedLinks.length)} record(s).`);
      }
    }
    return ingestedExitCode(result, io);
  } finally {
    await disposeActive(active);
  }
}
