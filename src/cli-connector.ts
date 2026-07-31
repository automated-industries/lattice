/**
 * The `lattice connector` subcommand — attaching and tending external sources
 * from a script.
 *
 * Keeping a connected source up to date was always a library call. ATTACHING one
 * was not: the handshake lived inside a request handler, so a machine could sync
 * a database forever and could not add one. That is exactly backwards for the
 * places this matters most — a container image being prepared, a fleet configured
 * the same way twice, a nightly job that has to notice a source went stale.
 *
 * So the verbs here cover the whole life of a source: attach an external
 * database, list what is attached, bring it up to date, repair a rotated
 * password, and detach it.
 *
 * A PASSWORD NEVER HAS TO BE AN ARGUMENT. `--password-stdin` reads it from
 * standard input, so it stays out of shell history and out of the process list —
 * the same reason the cloud verbs read a connection string that way.
 *
 * WHAT IS NOT HERE, on purpose: authorizing an MCP server that uses OAuth. That
 * ends with a person approving a consent page and a code bound to that browser's
 * session; there is nothing for a command line to complete. The library call says
 * so plainly (it hands back the URL to approve) rather than offering a verb that
 * could never finish.
 *
 * Nothing here writes to stdout or exits the process. Output is RETURNED as lines
 * with the exit code that goes with them, and errors are THROWN, so the same
 * logic serves the command wrapper (which prints and exits) and a caller that
 * wants the outcome as a value.
 *
 * A verb can FAIL while still having something worth printing — a refresh pass
 * that got three sources back and lost two has a report either way — which is
 * why an exit code travels beside the lines instead of every failure being a
 * thrown error. A thrown error carries a message and no report; that is right
 * for "this cannot be done" and wrong for "here is what happened, and it was
 * not good enough".
 */
import type { Lattice } from './lattice.js';
import { openConfiguredLattice } from './cli-open.js';
import { builtinConnectors } from './connectors/catalog.js';
import {
  listConnectors,
  getConnector,
  resolveConnectorIdentity,
  type ConnectorRecord,
} from './connectors/registry.js';
import { syncConnector } from './connectors/sync.js';
import { disconnectConnector } from './connectors/teardown.js';
import { DatabaseConnector } from './connectors/db-source/connector.js';
import { readIdentity } from './framework/user-config.js';
import {
  connectDatabaseSource,
  reconnectDatabaseSource,
  refreshStaleSources,
} from './ops/connect-source.js';
import { connectorError } from './ops/connector-errors.js';

/** Every verb the command accepts, in the order the help lists them. */
export const CONNECTOR_SUBCOMMANDS = [
  'list',
  'sync',
  'connect-database',
  'reconnect-database',
  'disconnect',
] as const;

export type ConnectorSubcommand = (typeof CONNECTOR_SUBCOMMANDS)[number];

/** The verbs whose result is worth parsing, and therefore honour `--json`. */
const JSON_VERBS: ReadonlySet<string> = new Set(['list', 'sync']);

/** Everything the connector subcommand needs from the parsed argv. */
export interface ConnectorCommandArgs {
  /** One of {@link CONNECTOR_SUBCOMMANDS}. Defaults to `list`. */
  subcommand?: string | undefined;
  /** The trailing positional: which connection `sync`, `reconnect-database`, or `disconnect` means. */
  action?: string | undefined;
  /** The workspace to operate on. Required — a source belongs to a workspace. */
  configPath: string;
  /** That workspace's rendered-context directory, so a teardown can prune it. */
  outputDir: string;
  /** `--db-host` / `--db-port` / `--db-name` / `--db-user` / `--db-schema`. */
  dbHost?: string | undefined;
  dbPort?: string | undefined;
  dbName?: string | undefined;
  dbUser?: string | undefined;
  dbSchema?: string | undefined;
  /** `--password-stdin` — read the database password from standard input. */
  passwordStdin?: boolean;
  /** `--json` — emit the machine-readable form of a verb that has one. */
  json?: boolean;
  /** Reads the password when `--password-stdin` was passed. Injected for tests. */
  readStdin?: () => Promise<string>;
  /**
   * Opens the workspace and returns it READY — schema applied. Injected for
   * tests; defaults to the shared opener. An opener that hands back an
   * unopened workspace is the bug this contract exists to name: every verb
   * below reads the connector registry, and an unopened one fails at the first
   * query with a message about an adapter rather than about connectors.
   */
  open?: (configPath: string) => Promise<Lattice>;
}

/** Open the workspace a verb was pointed at, ready to read. The caller closes it. */
async function openReady(configPath: string): Promise<Lattice> {
  const db = await openConfiguredLattice({ config: configPath });
  // A scoped member is detected inside init and skips the schema DDL it has no
  // privilege for, so one call serves an owner and a member alike.
  await db.init();
  return db;
}

/** Read a secret from standard input, whitespace-trimmed. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Who this run connects AS.
 *
 * The same resolution the app uses: on a shared database the connection is keyed
 * on the member role, so ownership and row partitioning agree with what the app
 * would have written; elsewhere it is this machine's identity. A command that
 * used a different name here would attach a source the app then could not see.
 */
async function connectingIdentity(db: Lattice): Promise<string> {
  const ident = readIdentity();
  const fallback = ident.email || ident.display_name || 'local';
  return await resolveConnectorIdentity(db, fallback);
}

/** The database credentials this invocation was given, as the connector's fields. */
async function databaseCredentials(args: ConnectorCommandArgs): Promise<Record<string, string>> {
  const creds: Record<string, string> = {};
  if (args.dbHost !== undefined) creds.host = args.dbHost;
  if (args.dbPort !== undefined) creds.port = args.dbPort;
  if (args.dbName !== undefined) creds.database = args.dbName;
  if (args.dbUser !== undefined) creds.user = args.dbUser;
  if (args.dbSchema !== undefined) creds.schema = args.dbSchema;
  if (args.passwordStdin) creds.password = await (args.readStdin ?? readAllStdin)();
  return creds;
}

/** One connected source, as a line. */
function formatConnector(c: ConnectorRecord): string {
  const name = c.displayName ?? c.toolkit;
  const when = c.lastSyncAt ?? 'never';
  const trailer = c.lastError ? ` — ${c.lastError}` : '';
  return `  ${c.id}  ${name} [${c.connector}] ${c.status}, last sync ${when}${trailer}`;
}

/**
 * What one verb produced: the lines to print, and the code to exit with.
 *
 * The two are separate because they are separate facts. A refresh pass prints a
 * report whether or not every source came back, and the code says which of those
 * it was.
 */
export interface ConnectorCommandResult {
  lines: string[];
  /** 0 when the verb did what it was asked; non-zero when it did not. */
  exitCode: number;
}

/** How many rows a sync brought in, as a sentence. */
function formatSync(upserted: Record<string, number>): string {
  const tables = Object.keys(upserted);
  if (tables.length === 0) return 'Nothing changed.';
  const rows = Object.values(upserted).reduce((a, b) => a + b, 0);
  return `Imported ${String(rows)} rows across ${String(tables.length)} tables.`;
}

/**
 * Run one `lattice connector` verb.
 *
 * @returns the lines to print and the code to exit with.
 * @throws when the verb is unknown, its arguments are wrong, or the operation is
 * refused. Every one of those is a non-zero exit for the caller: a command that
 * printed a reassuring line after failing to attach anything would be worse than
 * useless to the script that ran it.
 */
export async function runConnectorCommand(
  args: ConnectorCommandArgs,
): Promise<ConnectorCommandResult> {
  const sub = args.subcommand ?? 'list';
  if (!(CONNECTOR_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new Error(
      `Unknown connector subcommand: ${sub} (expected: ${CONNECTOR_SUBCOMMANDS.join(', ')})`,
    );
  }
  if (args.json && !JSON_VERBS.has(sub)) {
    throw new Error(`--json applies to: ${[...JSON_VERBS].join(', ')}`);
  }
  const db = await (args.open ?? openReady)(args.configPath);
  const connectedBy = await connectingIdentity(db);
  const asJson = (value: unknown): string[] => [JSON.stringify(value, null, 2)];
  /** A verb that did what it was asked. */
  const ok = (lines: string[]): ConnectorCommandResult => ({ lines, exitCode: 0 });

  switch (sub) {
    case 'list': {
      const rows = await listConnectors(db, connectedBy);
      if (args.json) return ok(asJson(rows));
      if (rows.length === 0) return ok(['No connected sources.']);
      return ok([`Connected sources (${String(rows.length)}):`, ...rows.map(formatConnector)]);
    }

    case 'sync': {
      // No id means the whole pass — every stale source, plus the one-time
      // repairs that only ever ran because somebody opened the app. Naming one
      // syncs exactly that one, stale or not, which is what a retry is.
      if (args.action === undefined) {
        const r = await refreshStaleSources(db, builtinConnectors(), connectedBy);
        // The report is worth printing either way, so it is PRINTED either way
        // and the exit code carries the verdict. A pass that lost sources leaves
        // as a failure: a nightly job told "0 synced, 3 failed" and handed a zero
        // would carry on as though the data it depends on had arrived.
        const lines = args.json
          ? asJson(r)
          : [
              `Synced ${String(r.synced)} sources; ${String(r.failed)} failed.`,
              ...r.failures.map((f) => `  ${f.displayName ?? f.connectorId}: ${f.error}`),
            ];
        return { lines, exitCode: r.failures.length > 0 ? 1 : 0 };
      }
      const { record, impl } = await resolveOwned(db, args.action, connectedBy);
      const result = await syncConnector(db, impl, record.id);
      if (args.json) return ok(asJson(result));
      return ok([`${record.displayName ?? record.toolkit}: ${formatSync(result.upserted)}`]);
    }

    case 'connect-database': {
      const credentials = await databaseCredentials(args);
      const out = await connectDatabaseSource(db, {
        credentials,
        connectedBy,
        outputDir: args.outputDir,
      });
      return ok([
        `Connected "${out.displayName ?? 'database'}" as ${out.connectorId}.`,
        `  ${formatSync(out.result.upserted)}`,
      ]);
    }

    case 'reconnect-database': {
      if (args.action === undefined) {
        throw connectorError(
          'invalid_request',
          'Usage: lattice connector reconnect-database <id> --db-host … [--password-stdin]',
        );
      }
      const credentials = await databaseCredentials(args);
      const out = await reconnectDatabaseSource(db, {
        connectorId: args.action,
        credentials,
        connectedBy,
        outputDir: args.outputDir,
      });
      return ok([
        `Reconnected "${out.displayName ?? 'database'}" (${out.connectorId}).`,
        `  ${formatSync(out.result.upserted)}`,
      ]);
    }

    case 'disconnect': {
      if (args.action === undefined) {
        throw connectorError('invalid_request', 'Usage: lattice connector disconnect <id>');
      }
      const { record, impl } = await resolveOwned(db, args.action, connectedBy);
      // A hard teardown for an external database, matching what removing one in
      // the app does: its imported tables are its own and nothing else reads them.
      const result = await disconnectConnector(db, impl, record.id, {
        outputDir: args.outputDir,
        ...(record.connector === 'db_source' ? { mode: 'hard' as const } : {}),
      });
      const retired = Object.values(result.softDeleted).reduce((a, b) => a + b, 0);
      return ok([
        `Disconnected "${record.displayName ?? record.toolkit}" (${result.mode}).`,
        `  ${String(retired)} rows retired across ${String(Object.keys(result.softDeleted).length)} tables.`,
      ]);
    }
  }
  // Unreachable: the verb was checked against the list above.
  throw new Error(`Unhandled connector subcommand: ${sub}`);
}

/**
 * The connection an id names, with the implementation that serves it — refusing
 * one that is not this member's.
 *
 * The ownership check is here rather than left to the database because the
 * command connects with full rights: a scoped role would be refused by the
 * database itself, and an owner would not be, so an id belonging to somebody else
 * would otherwise be synced or torn down without a word.
 */
async function resolveOwned(
  db: Lattice,
  id: string,
  connectedBy: string,
): Promise<{ record: ConnectorRecord; impl: ReturnType<typeof builtinConnectors>[number] }> {
  const record = await getConnector(db, id);
  if (record?.connectedBy !== connectedBy) {
    throw connectorError('connector_not_found', `No connected source "${id}".`);
  }
  if (record.connector === 'db_source') {
    return { record, impl: new DatabaseConnector() };
  }
  const impl = builtinConnectors().find((c) => c.connector === record.connector);
  if (!impl) {
    throw connectorError(
      'unsupported',
      `"${record.connector}" has no implementation in this build, so it cannot be synced or removed here.`,
    );
  }
  return { record, impl };
}
