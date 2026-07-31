import { resolve, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parse } from 'yaml';
import type { LatticeConfig } from './config/types.js';
import { generateAll } from './codegen/generate.js';
import { Lattice } from './lattice.js';
import { checkForUpdate } from './update-check.js';
import { detectInstallContext } from './update-context.js';
import { startGuiServer, openUrl } from './gui/server.js';
import {
  bindWithExposureGate,
  remoteBindRefusal,
  RemoteBindRefused,
  type BindTarget,
  type ExposureIo,
} from './gui/remote-exposure.js';
import { isLoopbackHost } from './gui/origin-guard.js';
import { probeRunningGui } from './gui/probe-running.js';
import { superviseGui } from './gui/supervisor.js';
import { ensureRootForGui, type GuiBootstrap } from './framework/gui-bootstrap.js';
import { ensureRootAt, resolveSessionRoot, rootConfigDir } from './framework/lattice-root.js';
import {
  addWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  resolveWorkspacePaths,
} from './framework/workspace.js';
import { importLegacyUserConfig } from './framework/migrate-to-root.js';
import { analyticsEnabled } from './framework/user-config.js';
import { openConfiguredLattice } from './cli-open.js';
import { runWorkspaceCommand } from './cli-workspace.js';
import { runDatabaseCommand } from './cli-database.js';
import { runSchemaCommand } from './cli-schema.js';
import { runQuestionsCommand } from './cli-questions.js';
import { checkForNewerVersion } from './ops/update.js';
import { resolveCloudTarget, runCloudCommand } from './cli-cloud.js';
import { runAskCommand, askFailureMessage } from './cli-ask.js';
import { runModelCommand, resolveModelTarget } from './cli-model.js';
import { runConnectorCommand } from './cli-connector.js';
import { resolveWorkspaceTarget } from './cli-target.js';
import { runAccountCommand } from './cli-account.js';
import { runIngestCommand } from './cli-ingest.js';
import { runImportCommand } from './cli-import.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command?: string | undefined;
  subcommand?: string | undefined;
  /** Third positional for two-level subcommands, e.g. `workspace use <id>`. */
  action?: string | undefined;
  /** --root <dir> — the `.lattice` root for `init` / `workspace` commands. */
  root?: string | undefined;
  config: string;
  out: string;
  output: string;
  /**
   * `true` when the user explicitly passed `--output` / `--output-dir`.
   * The GUI command uses this to decide whether to auto-discover an
   * existing render dir (default behaviour) or trust the user's value
   * (when explicit).
   */
  outputExplicit: boolean;
  scaffold: boolean;
  help: boolean;
  version: boolean;
  dryRun: boolean;
  noOrphanDirs: boolean;
  noOrphanFiles: boolean;
  protected: string[];
  interval: number;
  cleanup: boolean;
  port: number;
  noOpen: boolean;
  /** `false` when `--no-auto-update` (or env LATTICE_NO_AUTO_UPDATE=1) disables the GUI's auto-update. */
  autoUpdate: boolean;
  host: string;
  /** --allow-remote — required to bind the unauthenticated GUI to a non-loopback host. */
  allowRemote: boolean;
  /**
   * --yes / -y — accept the remote-exposure disclosure without being asked, for
   * scripted use. Opt-in only: the disclosure is still printed.
   */
  assumeYes: boolean;
  /** --name <display> — workspace / user display name (workspace create, gui). */
  displayName?: string | undefined;
  /** --json — emit machine-readable JSON instead of formatted text (doctor). */
  json: boolean;
  /** Positional query text for `search`. */
  query?: string | undefined;
  /** Positional prompt text for `ask`. */
  prompt?: string | undefined;
  /** --table <t> — target table for `search`. */
  table?: string | undefined;
  /** --topk <n> — result count for `search`. */
  topK?: number | undefined;
  /** --explain — print the hybrid-search score breakdown (`search`). */
  explain: boolean;
  /** --fix — let `doctor` rebuild stale native vector indexes it finds. */
  fix: boolean;
  /**
   * --check — report what `update` WOULD do and change nothing. The default is
   * to install, which is the wrong thing to run on a machine you are only taking
   * an inventory of.
   */
  check: boolean;
  /** --email <address> — the invitee for `cloud invite`, the redeemer for `cloud join`. */
  email?: string | undefined;
  /** --token <token> — the invite being redeemed by `cloud join`. */
  token?: string | undefined;
  /** --pk <value> — the row's primary key for `cloud share`. */
  pk?: string | undefined;
  /** --visibility <private|everyone> — the row audience for `cloud share`. */
  visibility?: string | undefined;
  /** --to <member> — share one row with one person (`cloud share`). */
  to?: string | undefined;
  /** --revoke — with `--to`, take the access away instead of giving it. */
  revoke: boolean;
  /** --url-stdin — read a connection string from standard input instead of argv. */
  urlStdin: boolean;
  /** --base-url <url> — the OpenAI-compatible endpoint for `model connect`. */
  baseUrl?: string | undefined;
  /** --model <id> — the model that endpoint should be asked for (`model connect`). */
  modelId?: string | undefined;
  /** --key-stdin — read an API key from standard input instead of argv. */
  keyStdin: boolean;
  /** --code-stdin — read a sign-in code from standard input instead of argv. */
  codeStdin: boolean;
  /**
   * The parts of an external database to attach (`connector connect-database`).
   * Deliberately parts rather than one URL: a pasted connection string invites
   * reusing an owner account wholesale, and a data source wants a read-only user
   * entered on purpose.
   */
  dbHost?: string | undefined;
  dbPort?: string | undefined;
  dbName?: string | undefined;
  dbUser?: string | undefined;
  dbSchema?: string | undefined;
  /** --password-stdin — read a database password from standard input instead of argv. */
  passwordStdin: boolean;
  /** --once — walk a folder without registering it as a standing source (`ingest`). */
  once: boolean;
  /** --stdin — read a document's text from standard input (`ingest`). */
  stdin: boolean;
  /** --private — force an ingested document and everything derived from it private. */
  privateMode: boolean;
  /** --title <name> — what a text ingest is filed under. */
  title?: string | undefined;
  /**
   * --text <definition> — what `schema describe` writes. Distinguished from
   * "not given" so an empty string can CLEAR a definition rather than reading
   * as a missing argument.
   */
  text?: string | undefined;
  /** --sheet <name> — one sheet of a multi-sheet workbook (`import`). */
  sheet?: string | undefined;
  /** --as-of <YYYY-MM-DD> — a file-level date for a whole import. */
  asOf?: string | undefined;
  /** --as-of-column <name> — the column an import dates each row by. */
  asOfColumn?: string | undefined;
  /** --mode <schema|contents|both> — how much of an import to materialize. */
  mode?: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  let action: string | undefined;
  let config = './lattice.config.yml';
  let out = './generated';
  let output = './context';
  let outputExplicit = false;
  let scaffold = false;
  let help = false;
  let version = false;
  let dryRun = false;
  let noOrphanDirs = false;
  let noOrphanFiles = false;
  const protectedFiles: string[] = [];
  let interval = 5000;
  let cleanup = false;
  let port = 4317;
  let noOpen = false;
  let autoUpdate = true;
  let host = '127.0.0.1';
  let allowRemote = false;
  let assumeYes = false;
  let subcommand: string | undefined;
  let displayName: string | undefined;
  let root: string | undefined;
  let json = false;
  let query: string | undefined;
  let prompt: string | undefined;
  let table: string | undefined;
  let topK: number | undefined;
  let explain = false;
  let fix = false;
  let check = false;
  let email: string | undefined;
  let token: string | undefined;
  let pk: string | undefined;
  let visibility: string | undefined;
  let to: string | undefined;
  let revoke = false;
  let urlStdin = false;
  let baseUrl: string | undefined;
  let modelId: string | undefined;
  let keyStdin = false;
  let codeStdin = false;
  let dbHost: string | undefined;
  let dbPort: string | undefined;
  let dbName: string | undefined;
  let dbUser: string | undefined;
  let dbSchema: string | undefined;
  let passwordStdin = false;
  let once = false;
  let stdin = false;
  let privateMode = false;
  let title: string | undefined;
  let text: string | undefined;
  let sheet: string | undefined;
  let asOf: string | undefined;
  let asOfColumn: string | undefined;
  let mode: string | undefined;

  let i = 0;
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    command = argv[0];
    i = 1;
    // `lattice workspace <subcommand>` — pick up the second positional.
    if (command === 'workspace' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      // `lattice workspace <subcommand> <action>` — third positional for
      // two-level subcommands like `workspace use <id>`.
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
    }
    // `lattice database <subcommand> [<what>]` — the second positional is the
    // verb, the third names the database it acts on (`database create <name>`,
    // `database delete <name-or-path>`).
    if (command === 'database' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
    }
    // `lattice schema <subcommand> [<what>]` — the second positional is the
    // verb, the third names what it acts on: a table (`schema links people`,
    // `schema link orders --to customers`) or a `<table>.<column>` reference
    // (`schema unlink orders.customers_id`).
    if (command === 'schema' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
    }
    // `lattice questions <subcommand> [<id>]` — the second positional is the
    // verb, the third the question it acts on (`questions answer <id>`).
    if (command === 'questions' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
    }
    // `lattice cloud <subcommand>` — pick up the second positional, and the
    // third for the verbs that name a thing (`cloud revoke <member>`,
    // `cloud probe <url>`).
    if (command === 'cloud' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
    }
    // `lattice model <subcommand> [<what>]` — the second positional is the verb,
    // the third names what it acts on (`model use <provider>`, `model key <name>`,
    // `model disconnect <what>`).
    if (command === 'model' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
    }
    // `lattice account <subcommand> [<what>]` — the second positional is the
    // verb, the third names what it acts on (`account code <code>`,
    // `account revoke <membership>`).
    if (command === 'account' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
    }
    // `lattice connector <subcommand> [<id>]` — the second positional is the
    // verb, the third names the connection it acts on (`connector sync <id>`,
    // `connector disconnect <id>`).
    if (command === 'connector' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
    }
    // `lattice search <query>` — the next positional is the query text.
    if (command === 'search' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      query = argv[1];
      i = 2;
    }
    // `lattice ask "<prompt>"` — the next positional is the whole prompt.
    if (command === 'ask' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      prompt = argv[1];
      i = 2;
    }
    // `lattice reindex <table>` — the next positional is the table name.
    if (command === 'reindex' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      table = argv[1];
      i = 2;
    }
    // `lattice index <subcommand>` — e.g. `index status`.
    if (command === 'index' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
    }
    // `lattice ingest <path|folder|url|verb> [<id>]` — the second positional is
    // what to ingest (or a registry verb), the third the id `forget` removes.
    if (command === 'ingest' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
      if (argv[2] !== undefined && !argv[2].startsWith('-')) {
        action = argv[2];
        i = 3;
      }
    }
    // `lattice import <file>` — the second positional is the file to import.
    if (command === 'import' && argv[1] !== undefined && !argv[1].startsWith('-')) {
      subcommand = argv[1];
      i = 2;
    }
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if ((arg === '--config' || arg === '-c') && i + 1 < argv.length) {
      i++;
      config = argv[i] ?? config;
    } else if ((arg === '--out' || arg === '-o') && i + 1 < argv.length) {
      i++;
      out = argv[i] ?? out;
    } else if ((arg === '--output' || arg === '--output-dir') && i + 1 < argv.length) {
      i++;
      output = argv[i] ?? output;
      outputExplicit = true;
    } else if (arg === '--scaffold') {
      scaffold = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-orphan-dirs') {
      noOrphanDirs = true;
    } else if (arg === '--no-orphan-files') {
      noOrphanFiles = true;
    } else if (arg === '--protected' && i + 1 < argv.length) {
      i++;
      const csv = argv[i] ?? '';
      protectedFiles.push(...csv.split(',').filter(Boolean));
    } else if (arg === '--interval' && i + 1 < argv.length) {
      i++;
      const parsed = parseInt(argv[i] ?? '5000', 10);
      if (!isNaN(parsed)) interval = parsed;
    } else if (arg === '--cleanup') {
      cleanup = true;
    } else if (arg === '--port' && i + 1 < argv.length) {
      i++;
      const parsed = parseInt(argv[i] ?? '4317', 10);
      if (!isNaN(parsed)) port = parsed;
    } else if (arg === '--no-open') {
      noOpen = true;
    } else if (arg === '--no-auto-update') {
      autoUpdate = false;
    } else if (arg === '--host' && i + 1 < argv.length) {
      i++;
      host = argv[i] ?? host;
    } else if (arg === '--allow-remote') {
      allowRemote = true;
    } else if (arg === '--yes' || arg === '--assume-yes' || arg === '-y') {
      assumeYes = true;
    } else if (arg === '--name' && i + 1 < argv.length) {
      i++;
      displayName = argv[i];
    } else if (arg === '--root' && i + 1 < argv.length) {
      i++;
      root = argv[i];
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--explain') {
      explain = true;
    } else if (arg === '--fix') {
      fix = true;
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--table' && i + 1 < argv.length) {
      i++;
      table = argv[i];
    } else if (arg === '--email' && i + 1 < argv.length) {
      i++;
      email = argv[i];
    } else if (arg === '--token' && i + 1 < argv.length) {
      i++;
      token = argv[i];
    } else if (arg === '--pk' && i + 1 < argv.length) {
      i++;
      pk = argv[i];
    } else if (arg === '--visibility' && i + 1 < argv.length) {
      i++;
      visibility = argv[i];
    } else if (arg === '--to' && i + 1 < argv.length) {
      i++;
      to = argv[i];
    } else if (arg === '--revoke') {
      revoke = true;
    } else if (arg === '--url-stdin') {
      urlStdin = true;
    } else if (arg === '--base-url' && i + 1 < argv.length) {
      i++;
      baseUrl = argv[i];
    } else if (arg === '--model' && i + 1 < argv.length) {
      i++;
      modelId = argv[i];
    } else if (arg === '--key-stdin') {
      keyStdin = true;
    } else if (arg === '--code-stdin') {
      codeStdin = true;
    } else if (arg === '--db-host' && i + 1 < argv.length) {
      i++;
      dbHost = argv[i];
    } else if (arg === '--db-port' && i + 1 < argv.length) {
      i++;
      dbPort = argv[i];
    } else if (arg === '--db-name' && i + 1 < argv.length) {
      i++;
      dbName = argv[i];
    } else if (arg === '--db-user' && i + 1 < argv.length) {
      i++;
      dbUser = argv[i];
    } else if (arg === '--db-schema' && i + 1 < argv.length) {
      i++;
      dbSchema = argv[i];
    } else if (arg === '--password-stdin') {
      passwordStdin = true;
    } else if (arg === '--once') {
      once = true;
    } else if (arg === '--stdin') {
      stdin = true;
    } else if (arg === '--private') {
      privateMode = true;
    } else if (arg === '--title' && i + 1 < argv.length) {
      i++;
      title = argv[i];
    } else if (arg === '--text' && i + 1 < argv.length) {
      i++;
      text = argv[i];
    } else if (arg === '--sheet' && i + 1 < argv.length) {
      i++;
      sheet = argv[i];
    } else if (arg === '--as-of' && i + 1 < argv.length) {
      i++;
      asOf = argv[i];
    } else if (arg === '--as-of-column' && i + 1 < argv.length) {
      i++;
      asOfColumn = argv[i];
    } else if (arg === '--mode' && i + 1 < argv.length) {
      i++;
      mode = argv[i];
    } else if (arg === '--topk' && i + 1 < argv.length) {
      i++;
      const parsed = parseInt(argv[i] ?? '10', 10);
      if (!isNaN(parsed)) topK = parsed;
    }
    i++;
  }

  return {
    command,
    subcommand,
    action,
    config,
    out,
    output,
    outputExplicit,
    scaffold,
    help,
    version,
    dryRun,
    noOrphanDirs,
    noOrphanFiles,
    protected: protectedFiles,
    interval,
    cleanup,
    port,
    noOpen,
    // Env var is the inheritance channel: the supervisor re-spawns the child via
    // argv, but the desktop shell and any wrapper set the env instead — honor both.
    autoUpdate: autoUpdate && process.env.LATTICE_NO_AUTO_UPDATE !== '1',
    host,
    allowRemote,
    assumeYes,
    displayName,
    root,
    json,
    query,
    prompt,
    table,
    topK,
    explain,
    fix,
    check,
    email,
    token,
    pk,
    visibility,
    to,
    revoke,
    urlStdin,
    baseUrl,
    modelId,
    keyStdin,
    codeStdin,
    dbHost,
    dbPort,
    dbName,
    dbUser,
    dbSchema,
    passwordStdin,
    once,
    stdin,
    privateMode,
    title,
    text,
    sheet,
    asOf,
    asOfColumn,
    mode,
  };
}

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    [
      'lattice — latticesql CLI',
      '',
      'Usage:',
      '  lattice <command> [options]',
      '',
      'Commands:',
      '  init        Create a .lattice root + a default workspace (auto-renders context)',
      '  workspace   Manage workspaces (list | create <name> | use <name-or-id> |',
      '              rename <name-or-id> --name "<new>" | delete <name-or-id> --yes)',
      '  database    Manage the databases inside one workspace (list | create <name> |',
      '              delete <name-or-path> --yes)',
      '  schema      Relationships + definitions (links | link | unlink | describe)',
      '  questions   Drain the clarification queue (list | answer <id> --text | dismiss <id>)',
      '  generate    Generate TypeScript types, SQL migration, and scaffold files',
      '  render      One-shot context generation (writes entity context directories)',
      '  reconcile   Render + cleanup orphaned entity directories and files',
      '  status      Dry-run reconcile — show what would change without writing',
      '  watch       Poll for changes and re-render on each cycle',
      '  gui         Start a local browser GUI for exploring Lattice context',
      '  ask         Ask the assistant one question and print the answer (no browser)',
      '  model       Say which model this machine uses (status | connect | subscription |',
      '              code | account | use | test | key | disconnect) — no browser',
      '  account     Sign this machine in to an account (status | signin | code | signout |',
      '              sync | members | invite | revoke | create-workspace) — no browser',
      '  cloud       Run a shared workspace (status | members | secure | invite | join |',
      '              revoke | share | migrate | probe) — no browser, no network bind',
      '  connector   Attach and tend external sources (list | sync | connect-database |',
      '              reconnect-database | disconnect) — no browser',
      '  ingest      Bring in a document, a folder, a web address, or text on stdin',
      '  import      Turn a spreadsheet / CSV / JSON export into tables and rows',
      '  doctor      Report retrieval health (coverage, extensions; --fix rebuilds stale indexes)',
      '  search      Hybrid search a table (--table <t> [--explain] [--topk N])',
      "  reindex     Rebuild a table's native vector index (reindex <table>)",
      '  index       Vector index status (index status [--json])',
      '  update      Upgrade latticesql to the latest version (--check reports only)',
      '',
      'Options (generate):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --out, -o <dir>        Output directory for generated files (default: ./generated)',
      '  --scaffold             Also create empty scaffold render output files',
      '',
      'Options (render):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '',
      'Options (reconcile):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '  --dry-run              Report orphans but do not delete anything',
      '  --no-orphan-dirs       Skip removal of orphaned entity directories',
      '  --no-orphan-files      Skip removal of orphaned files inside entity dirs',
      '  --protected <csv>      Comma-separated list of protected filenames',
      '',
      'Options (status):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '',
      'Options (watch):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '  --interval <ms>        Poll interval in milliseconds (default: 5000)',
      '  --cleanup              Enable orphan cleanup after each render cycle',
      '  --no-orphan-dirs       Skip removal of orphaned entity directories (with --cleanup)',
      '  --no-orphan-files      Skip removal of orphaned files inside entity dirs (with --cleanup)',
      '  --protected <csv>      Comma-separated list of protected filenames (with --cleanup)',
      '',
      'Options (gui):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --output <dir>         Output directory for rendered context (default: ./context)',
      '  --port <number>        Localhost port (default: 4317; auto-increments if busy)',
      '  --no-open              Do not open the browser automatically',
      '  --no-auto-update       Pin to the current version (disable the GUI auto-update)',
      '  --host <addr>          Bind address (default: 127.0.0.1). Anything else is a',
      '                         network exposure: see --allow-remote',
      '  --allow-remote         Permit a non-loopback bind. The server is UNAUTHENTICATED,',
      '                         so this also requires --root and a typed confirmation',
      '  --yes, -y              Accept the exposure disclosure without being asked',
      '                         (scripted use; the disclosure is still printed)',
      '',
      'Options (account):',
      '  An account sign-in needs a person to approve it, but not a browser on THIS',
      '  machine: start it here, approve the printed link anywhere, paste the code back.',
      '  lattice account status                  Signed in or not, and as whom',
      '  lattice account signin                  Start a sign-in; prints the link to approve',
      '  lattice account code <code>             Finish it with the code the page showed',
      '  lattice account signout                 Sign out and revoke this device at the service',
      '  lattice account sync                    Pull down workspaces this account was invited to',
      '  lattice account members                 Who is on this hosted workspace',
      '  lattice account invite --email <address>   Invite somebody to it',
      '  lattice account revoke <membership-id>     Remove somebody from it',
      '  lattice account create-workspace --name <name>   Create another hosted workspace',
      '  --root <dir>           The .lattice root that `sync` registers workspaces in',
      '  --json                 Machine-readable output (status, signin, sync, members)',
      '  --code-stdin           Read the one-time code from standard input rather than',
      '                         an argument, which is readable from the process list by',
      '                         anyone on the machine and kept in your shell history:',
      '                           lattice account code --code-stdin < code.txt',
      '  The last four verbs act on a HOSTED workspace and need a session that has a',
      '  workspace manager; they say so plainly when there is none.',
      '',
      'Options (cloud):',
      '  A cloud is a shared Postgres database secured by row-level security. There is',
      '  no server to run: permission is the Postgres role you connect as, so every',
      '  verb below is refused by the database itself when you are not allowed it.',
      '  lattice cloud status                    Owner or member, whether row security is',
      '                                          installed, and anything left unprotected',
      '  lattice cloud members                   Who is on this cloud',
      '  lattice cloud secure                    Turn this Postgres into a cloud (owner)',
      '  lattice cloud invite --email <address>  Mint one invite token, printed once',
      '  lattice cloud join --token <token>      Redeem an invite into a NEW workspace',
      '  lattice cloud revoke <member>           Remove somebody, by role, email, or name',
      '  lattice cloud share --table <t> --pk <id> --visibility <private|everyone>',
      '  lattice cloud share --table <t> --pk <id> --to <member> [--revoke]',
      '  lattice cloud migrate --url-stdin       Move this workspace onto a shared database',
      '  lattice cloud probe --url-stdin         Check a database before pointing at it',
      '  --config, -c <path>    Workspace to operate on (default: the active workspace)',
      '  --root <dir>           The .lattice root holding that workspace',
      '  --json                 Machine-readable output (status, members, probe)',
      '  --token <token>        The invite being redeemed (join)',
      '  --email <address>      The invitee (invite), or who the invite was sent to (join;',
      '                         defaults to this machine identity)',
      '  --name <label>         Name for the workspace (join, migrate)',
      '  --url-stdin            Read the connection string for migrate/probe from standard',
      '                         input. A connection string contains the owner password, and',
      '                         an argument is readable from the process list by anyone on',
      '                         the machine and is kept in your shell history — so pipe it:',
      '                           lattice cloud migrate --url-stdin < db-url.txt',
      '                         LATTICE_CLOUD_URL is read when neither is given. Passing the',
      '                         URL as an argument still works, and warns.',
      '',
      'Options (connector):',
      '  An external source belongs to a workspace, so every verb takes one. Keeping a',
      '  source fresh was always scriptable; ATTACHING one is what this adds.',
      '  lattice connector list                  What is attached, and how each is doing',
      '  lattice connector sync                  Bring every stale source up to date',
      '  lattice connector sync <id>             Force one, stale or not (this is a retry)',
      '  lattice connector connect-database --db-host <h> --db-name <db> --db-user <u>',
      '                                          [--db-port <p>] [--db-schema <s>]',
      '                                          [--password-stdin]  Attach a Postgres',
      '                                          database and import its tables',
      '  lattice connector reconnect-database <id> --db-host <h> …   Fix a rotated',
      '                                          password or a corrected address',
      '  lattice connector disconnect <id>       Detach it and tear down what it made',
      '  --config, -c <path>    Workspace to operate on (default: the active workspace)',
      '  --root <dir>           The .lattice root holding that workspace',
      '  --json                 Machine-readable output (list, sync)',
      '  --password-stdin       Read the database password from standard input. A password',
      '                         given as an argument is readable from the process list by',
      '                         anyone on the machine and is kept in your shell history:',
      '                           lattice connector connect-database … --password-stdin < pw.txt',
      '  Authorizing an MCP server that uses OAuth is NOT here: it ends with a person',
      '  approving a consent page, so there is nothing for a command to complete.',
      '',
      'Options (ingest):',
      '  The same pipeline a drop into the app runs: read it, extract it, describe it,',
      '  import the data inside it, and link it to the records it is about.',
      '  lattice ingest <file>                   One document, read where it sits',
      '  lattice ingest <folder>                 Register the folder as a source, walk it',
      '  lattice ingest <folder> --once          Walk it without registering it',
      '  lattice ingest <url>                    Read a web page and keep what it says',
      '  lattice ingest --stdin --title <name>   Keep text piped in as a document',
      '  lattice ingest sources                  The folders and files registered here',
      '  lattice ingest forget <id>              Stop watching one (documents are kept)',
      '  --config, -c <path>    Workspace to ingest into (default: the active workspace)',
      '  --root <dir>           The .lattice root holding that workspace',
      '  --private              Keep the document, and everything derived from it, private',
      '  --json                 Machine-readable result instead of the summary line',
      '',
      'Options (import):',
      '  lattice import <file>                   Infer the schema and materialize it',
      '  --sheet <name>         One sheet of a multi-sheet workbook',
      '  --as-of <YYYY-MM-DD>   File-level date for the whole import. Absent, the import',
      '                         is filed under today, so a re-run APPENDS a snapshot',
      '                         rather than overwriting the last one',
      '  --as-of-column <name>  The column the source dates each row by',
      '  --mode <m>             schema | contents | both (default: both)',
      '  --dry-run              Report what it would create; write nothing',
      '  --yes, -y              Proceed past the safe table cap, having reviewed the scope',
      '  --config, -c <path>    Workspace to import into (default: the active workspace)',
      '  --json                 Machine-readable result instead of the summary line',
      '',
      'Options (doctor):',
      '  Exits non-zero when the report is not healthy — usable as a CI / deploy gate.',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --fix                  Rebuild every stale native vector index, then re-check',
      '  --json                 Emit the health report as JSON instead of formatted text',
      '',
      'Options (ask):',
      '  lattice ask "<prompt>"',
      '  The same assistant the app runs, over the same tools and the same workspace.',
      '  It answers, and it acts: a change it makes is audited and reversible from the',
      '  version history exactly like one made by hand. The answer goes to stdout and',
      '  nothing else does, so it pipes; which tools ran goes to stderr. Exits non-zero',
      '  when the turn fails or no model is connected.',
      '  --config, -c <path>    Workspace to ask about (default: the active workspace)',
      '  --root <dir>           The .lattice root holding that workspace',
      '  --json                 Emit the answer plus what the turn did, as JSON',
      '',
      'Options (model):',
      '  Which model answers is a property of THIS MACHINE, stored encrypted, and every',
      '  verb below works before any workspace exists — which is when you need them.',
      '  lattice model status                    What is connected, and what is blocking',
      '  lattice model connect --base-url <url> --model <id> [--key-stdin]',
      '                                          Connect an OpenAI-compatible endpoint.',
      '                                          It is asked to answer before it is kept',
      '  lattice model subscription              Start connecting a Claude subscription —',
      '                                          prints a URL to approve in any browser',
      '  lattice model code <code>               Finish it with the code that page showed',
      '  lattice model account                   Use the signed-in account for model access',
      '  lattice model use <anthropic|openai_compat>   Pick which configured backend answers',
      '  lattice model test                      Ask the active backend to answer once',
      '  lattice model key <openai|elevenlabs> --key-stdin   Save a speech key',
      '  lattice model key <openai|elevenlabs> --revoke      Clear one',
      '  lattice model disconnect <endpoint|account|subscription>',
      '  --json                 Machine-readable output (status, subscription)',
      '  --key-stdin            Read the API key from standard input. A key given as an',
      '                         argument is readable from the process list by anyone on the',
      '                         machine and is kept in your shell history — so pipe it:',
      '                           lattice model key openai --key-stdin < key.txt',
      '  --token <key>          The key inline, when the exposure above is acceptable',
      '  The one step no command can take is approving the consent screen itself — that',
      "  page is the provider's, and a person opens it on whatever machine they are at.",
      '',
      'Options (search):',
      '  lattice search "<query>" --table <table>',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --table <table>        Table to search (required)',
      '  --topk <n>             Number of results to return (default: 10)',
      '  --explain              Print the per-result score breakdown (vector / fts / rrf)',
      '  --json                 Emit the results as JSON instead of formatted text',
      '',
      'Options (reindex / index status):',
      '  --config, -c <path>    Path to config file (default: ./lattice.config.yml)',
      '  --json                 Emit the index status as JSON (index status)',
      '',
      'Options (init / workspace / gui):',
      '  --root <dir>           The .lattice root to use (default: ~/.lattice). A root is',
      '                         never picked up by searching upward from the current dir',
      '  --name <display>       Workspace display name (init default workspace / workspace',
      '                         create — `workspace create <name>` does the same thing)',
      '  --yes, -y              Confirm `workspace delete`. There is no prompt: this runs',
      '                         unattended, and a prompt in a script is a hang',
      '',
      'Options (database):',
      '  lattice database list | create <name> | delete <name-or-path> --yes',
      '  --config, -c <path>    Workspace whose databases these are (default: the active',
      '                         workspace)',
      '  --root <dir>           The .lattice root holding that workspace',
      '  --name <name>          Name for the new database (`create <name>` does the same)',
      '  --yes, -y              Confirm `database delete` — it removes the config and, for a',
      '                         local database, its data file',
      '',
      '  A database is ONE config inside a workspace; a workspace is the registry entry',
      '  that holds a whole set of them. Deleting the last database in a workspace is',
      '  refused — remove the workspace instead if that is what you meant.',
      '',
      'Options (schema):',
      '  lattice schema links [<table>]                    what is nested inside what',
      '  lattice schema link <table> --to <parent>         nest one table inside another',
      '  lattice schema unlink <table>.<column>            remove a link (values are kept)',
      '  lattice schema describe <table>[.<column>] --text "<definition>"',
      '  --config, -c <path>    Workspace to act on (default: the active workspace)',
      '  --root <dir>           The .lattice root holding that workspace',
      '  --to <parent>          The table a new link points at',
      '  --text <definition>    What `describe` writes. An empty --text "" clears it',
      '',
      '  `links` prints the `<table>.<column>` reference `unlink` takes. Unlinking is',
      '  soft: the column and its values stay, so the change reverts from history.',
      '',
      'Options (global):',
      '  --help, -h             Show this help message',
      '  --version, -v          Print the version number',
      '',
      'Aliases:',
      '  --output-dir <dir>     Same as --output',
      '  --assume-yes           Same as --yes',
    ].join('\n'),
  );
}

// Injected by tsup's `define` at build time (see tsup.config.ts). Undefined when
// running unbundled from source (dev / tsx), where the package.json read below
// works because import.meta.url points into src/.
declare const __LATTICE_VERSION__: string | undefined;

function getVersion(): string {
  // Build-time constant — reliable in the bundled/published CLI + GUI, where the
  // runtime package.json read fails (the bundle runs from node_modules). This is
  // the fix for the "vunknown" version chip in published builds.
  if (typeof __LATTICE_VERSION__ === 'string') return __LATTICE_VERSION__;
  try {
    const pkgPath = new URL('../package.json', import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

function printVersion(): void {
  console.log(getVersion());
}

/**
 * Absolute path to the built `dist/gui-assets/` directory (on-device voice worker
 * + ONNX-Runtime WASM). Resolved against the package via `import.meta.url` — the
 * CLI is ESM-only, so this works whether running from the bundled `dist/cli.js`
 * (assets are a sibling: `dist/gui-assets/`) or unbundled from source in dev
 * (where `import.meta.url` points into `src/`, so `../dist/gui-assets`). Passed to
 * `startGuiServer` because server.ts is dual-bundled (CJS+ESM) and can't read
 * `import.meta.url` itself.
 */
function getGuiAssetsDir(): string {
  // Bundled: import.meta.url is dist/cli.js → dist/gui-assets is a sibling.
  // Source:  import.meta.url is src/cli.ts → ../dist/gui-assets.
  const fromBundle = new URL('./gui-assets', import.meta.url).pathname;
  if (existsSync(fromBundle)) return fromBundle;
  return new URL('../dist/gui-assets', import.meta.url).pathname;
}

async function runUpdate(args: ParsedArgs): Promise<void> {
  const currentVersion = getVersion();

  // `--check` REPORTS and installs nothing — for a machine you are taking an
  // inventory of rather than upgrading. It also distinguishes the two ways
  // "nothing newer" can happen, which the install path cannot: a registry that
  // could not be reached must never read as "you are on the latest version".
  if (args.check) {
    const found = await checkForNewerVersion({ currentVersion });
    const lines = [`Current version: ${found.current}`, `Install: ${found.kind} — ${found.reason}`];
    if (!found.checked) {
      lines.push(`Could not check for updates: ${found.error ?? 'unknown reason'}`);
      for (const line of lines) console.log(line);
      process.exitCode = 1;
      return;
    }
    if (!found.latest) lines.push('Already up to date.');
    else if (found.installable) {
      lines.push(`Update available: ${found.current} → ${found.latest}`);
      lines.push('Run `lattice update` to install it.');
    } else {
      lines.push(`Update available: ${found.current} → ${found.latest}`);
      lines.push('This copy cannot be upgraded in place — reinstall to move to it.');
    }
    for (const line of lines) console.log(line);
    return;
  }

  console.log(`Current version: ${currentVersion}`);

  // A check that could not run must not print "Already up to date." — that is the
  // one sentence this command can say that is worse than an error, because it
  // ends the conversation.
  let latest: string | null;
  try {
    latest = await checkForUpdate('latticesql', currentVersion);
  } catch (e) {
    console.error(`Could not check for updates: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (!latest) {
    console.log('Already up to date.');
    return;
  }

  console.log(`Updating to ${latest}...`);
  try {
    execSync('npm install -g latticesql@latest', {
      stdio: 'inherit',
      // Honor the analytics opt-out on the reinstall (suppresses the Scarf ping).
      env: analyticsEnabled() ? process.env : { ...process.env, SCARF_ANALYTICS: 'false' },
    });
    console.log(`Updated latticesql ${currentVersion} → ${latest}`);
  } catch {
    console.error('Update failed. Try running manually: npm install -g latticesql@latest');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function runGenerate(args: ParsedArgs): void {
  const configPath = resolve(args.config);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    console.error(`Error: cannot read config file at "${configPath}"`);
    process.exit(1);
  }

  let config: LatticeConfig;
  try {
    config = parse(raw) as LatticeConfig;
  } catch (e) {
    console.error(`Error: YAML parse error in "${configPath}": ${(e as Error).message}`);
    process.exit(1);
  }

  if (!(config as { entities?: unknown }).entities) {
    console.error('Error: config must have an "entities" key');
    process.exit(1);
  }

  const configDir = dirname(configPath);
  const outDir = resolve(args.out);

  try {
    const result = generateAll({ config, configDir, outDir, scaffold: args.scaffold });
    console.log(`Generated ${String(result.filesWritten.length)} file(s):`);
    for (const f of result.filesWritten) {
      console.log(`  ✓ ${f}`);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function runRender(args: ParsedArgs): Promise<void> {
  const outputDir = resolve(args.output);

  let db: Lattice | undefined;
  try {
    db = await openConfiguredLattice(args);
    await db.init();
    const start = Date.now();
    const result = await db.render(outputDir);
    const durationMs = Date.now() - start;

    console.log(`Rendered ${String(result.filesWritten.length)} files in ${String(durationMs)}ms`);
    for (const f of result.filesWritten) {
      console.log(`  ✓ ${f}`);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db?.close();
  }
}

async function runDoctor(args: ParsedArgs): Promise<void> {
  let db: Lattice | undefined;
  try {
    db = await openConfiguredLattice(args);
    await db.init();
    let report = await db.diagnoseRetrieval();
    if (args.fix) {
      // Rebuild every index the report flagged stale, then re-diagnose so the
      // printed report reflects the repaired state.
      const stale = [
        ...new Set(
          [...report.issues, ...report.tables.flatMap((t) => t.issues)].flatMap((iss) =>
            iss.kind === 'index_stale' && iss.table ? [iss.table] : [],
          ),
        ),
      ];
      for (const t of stale) {
        process.stderr.write(`Rebuilding stale vector index for "${t}"…\n`);
        await db.buildVectorIndex(t);
      }
      if (stale.length > 0) report = await db.diagnoseRetrieval();
    }
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const { formatHealthReport } = await import('./search/doctor.js');
      console.log(formatHealthReport(report));
    }
    // Exit non-zero when an error-severity issue exists, so `lattice doctor` can
    // gate CI / a deploy on retrieval health.
    if (!report.healthy) process.exitCode = 1;
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db?.close();
  }
}

async function runReindex(args: ParsedArgs): Promise<void> {
  if (!args.table) {
    console.error('Usage: lattice reindex <table>');
    process.exit(1);
  }
  let db: Lattice | undefined;
  try {
    db = await openConfiguredLattice(args);
    await db.init();
    const n = await db.buildVectorIndex(args.table);
    console.log(
      n > 0
        ? `Rebuilt native vector index for "${args.table}" (${String(n)} vectors).`
        : `No native vector extension available — "${args.table}" uses the in-process scan.`,
    );
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db?.close();
  }
}

async function runIndex(args: ParsedArgs): Promise<void> {
  const sub = args.subcommand ?? 'status';
  if (sub !== 'status') {
    console.error(`Unknown index subcommand: ${sub} (expected: status)`);
    process.exit(1);
  }
  let db: Lattice | undefined;
  try {
    db = await openConfiguredLattice(args);
    await db.init();
    const report = await db.diagnoseRetrieval();
    const { getVectorIndexMeta } = await import('./search/vector-index.js');
    const rows: {
      table: string;
      embeddings: number;
      indexed: boolean;
      builtAt: string | null;
      vecDim: number | null;
      hnswM: number | null;
      hnswEfConstruction: number | null;
      stale: boolean;
    }[] = [];
    for (const t of report.tables) {
      const meta = await getVectorIndexMeta(db.adapter, t.table);
      rows.push({
        table: t.table,
        embeddings: t.embeddingCount ?? 0,
        indexed: meta !== null,
        builtAt: meta?.builtAt ?? null,
        vecDim: meta?.vecDim ?? null,
        hnswM: meta?.hnswM ?? null,
        hnswEfConstruction: meta?.hnswEfConstruction ?? null,
        stale: t.issues.some((iss) => iss.kind === 'index_stale'),
      });
    }
    if (args.json) {
      console.log(
        JSON.stringify(
          { dialect: report.dialect, extensions: report.extensions, tables: rows },
          null,
          2,
        ),
      );
    } else {
      console.log(`Vector index status — ${report.dialect}`);
      if (rows.length === 0) console.log('  (no embedding-enabled tables)');
      for (const r of rows) {
        const bits = [
          `emb=${String(r.embeddings)}`,
          r.indexed ? `indexed@${String(r.builtAt)}` : 'no-index',
        ];
        if (r.indexed && (r.hnswM !== null || r.hnswEfConstruction !== null)) {
          bits.push(`hnsw(m=${String(r.hnswM)},ef_construction=${String(r.hnswEfConstruction)})`);
        }
        if (r.stale) bits.push('STALE — run `lattice reindex` or `doctor --fix`');
        console.log(`  ${r.table}: ${bits.join(' ')}`);
      }
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db?.close();
  }
}

async function runSearch(args: ParsedArgs): Promise<void> {
  if (!args.query) {
    console.error('Usage: lattice search "<query>" --table <table> [--explain] [--topk N]');
    process.exit(1);
  }
  if (!args.table) {
    console.error('Error: --table <table> is required for search');
    process.exit(1);
  }
  let db: Lattice | undefined;
  try {
    db = await openConfiguredLattice(args);
    await db.init();
    const results = await db.hybridSearch(args.table, args.query, { topK: args.topK ?? 10 });
    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log('No matches.');
      return;
    }
    for (const r of results) {
      const id =
        typeof r.row.id === 'string' || typeof r.row.id === 'number' ? String(r.row.id) : '(no id)';
      console.log(`${r.score.toFixed(4)}  ${id}`);
      if (args.explain) {
        const e = r.explain;
        const v =
          e.vectorRank === null
            ? '—'
            : `#${String(e.vectorRank)} (${(e.vectorScore ?? 0).toFixed(3)})`;
        const f =
          e.ftsRank === null ? '—' : `#${String(e.ftsRank)} (${(e.ftsScore ?? 0).toFixed(3)})`;
        console.log(
          `      vector ${v} | fts ${f} | rrf ${e.rrf.toFixed(5)} | boost ${e.rankingBoost.toFixed(3)}` +
            (e.rerankerScore !== undefined ? ` | rerank ${e.rerankerScore.toFixed(3)}` : ''),
        );
      }
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db?.close();
  }
}

async function runReconcile(args: ParsedArgs, isDryRun: boolean): Promise<void> {
  const outputDir = resolve(args.output);

  let db: Lattice | undefined;
  try {
    db = await openConfiguredLattice(args);
    await db.init();
    const start = Date.now();
    const reconcileOpts: import('./types.js').ReconcileOptions = {
      dryRun: isDryRun,
      removeOrphanedDirectories: !args.noOrphanDirs,
      removeOrphanedFiles: !args.noOrphanFiles,
    };
    if (args.protected.length > 0) {
      reconcileOpts.protectedFiles = args.protected;
    }
    const result = await db.reconcile(outputDir, reconcileOpts);
    const durationMs = Date.now() - start;

    if (isDryRun) {
      console.log('DRY RUN — no changes made');
    }

    console.log(`Rendered ${String(result.filesWritten.length)} files in ${String(durationMs)}ms`);
    for (const f of result.filesWritten) {
      console.log(`  ✓ ${f}`);
    }

    const { cleanup } = result;
    const totalRemoved = cleanup.directoriesRemoved.length + cleanup.filesRemoved.length;
    if (totalRemoved > 0 || cleanup.directoriesSkipped.length > 0) {
      console.log(
        `Cleanup: removed ${String(cleanup.directoriesRemoved.length)} directories, ${String(cleanup.filesRemoved.length)} files`,
      );
      for (const d of cleanup.directoriesRemoved) {
        console.log(`  ✓ Removed ${d}`);
      }
      for (const f of cleanup.filesRemoved) {
        console.log(`  ✓ Removed ${f}`);
      }
      for (const d of cleanup.directoriesSkipped) {
        console.log(`  ✗ Left ${d} (protected files remain)`);
      }
    }

    if (cleanup.warnings.length > 0) {
      console.log(`Warnings: ${String(cleanup.warnings.length)}`);
      for (const w of cleanup.warnings) {
        console.warn(`  ! ${w}`);
      }
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db?.close();
  }
}

function formatTimestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function runWatch(args: ParsedArgs): Promise<void> {
  const outputDir = resolve(args.output);

  let db: Lattice;
  try {
    db = await openConfiguredLattice(args);
    await db.init();
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }

  const cleanupOpts: import('./types.js').CleanupOptions | undefined = args.cleanup
    ? {
        removeOrphanedDirectories: !args.noOrphanDirs,
        removeOrphanedFiles: !args.noOrphanFiles,
        ...(args.protected.length > 0 ? { protectedFiles: args.protected } : {}),
      }
    : undefined;

  const stop = await db.watch(outputDir, {
    interval: args.interval,
    onRender: (result) => {
      console.log(
        `[${formatTimestamp()}] Rendered ${String(result.filesWritten.length)} files in ${String(result.durationMs)}ms`,
      );
    },
    onError: (err) => {
      console.error(`[${formatTimestamp()}] Error: ${err.message}`);
    },
    ...(cleanupOpts !== undefined ? { cleanup: cleanupOpts } : {}),
    ...(cleanupOpts !== undefined
      ? {
          onCleanup: (result) => {
            console.log(
              `[${formatTimestamp()}] Cleanup: removed ${String(result.directoriesRemoved.length)} dirs, ${String(result.filesRemoved.length)} files`,
            );
          },
        }
      : {}),
  });

  const shutdown = (): void => {
    stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runGui(args: ParsedArgs): Promise<void> {
  const port = args.port;
  // Singleton: never start a SECOND Lattice GUI when one is already serving this
  // port. The server's port-fallback (bind the next free port if the requested one
  // is busy) would otherwise run a DUPLICATE instance — its own browser tab, its
  // own background auto-update supervisor. Repeated launches (the installer,
  // double-clicking the app, dev testing) then pile up instances + tabs at drifting
  // versions, which is what crashes the browser. If a Lattice GUI is already up on
  // this port, just open it and exit. The supervised child (LATTICE_GUI_SUPERVISED)
  // is spawned precisely to bind the port, and the supervisor frees the port before
  // an in-place update restart — so the child must skip this check.
  if (!process.env.LATTICE_GUI_SUPERVISED) {
    const running = await probeRunningGui(port);
    if (running) {
      const url = `http://127.0.0.1:${String(port)}/`;
      console.log(
        `Lattice is already running at ${url}${running.version ? ` (v${running.version})` : ''} — opening it.`,
      );
      if (!args.noOpen) openUrl(url);
      return;
    }
  }
  // A fresh, installable invocation becomes the supervisor: it silently installs
  // the latest version and respawns the server on a background update, so the GUI
  // self-updates with no manual refresh. The supervised child (and any
  // non-installable context — dev checkout, npx) falls through to run the server
  // directly. `LATTICE_GUI_SUPERVISED` prevents infinite re-supervision.
  // `--no-auto-update` skips supervision entirely: run the server in place with
  // no startup install and no background relaunch.
  if (
    args.autoUpdate &&
    !process.env.LATTICE_GUI_SUPERVISED &&
    detectInstallContext().installable
  ) {
    try {
      // The supervisor respawns the server unattended after every background
      // update, so a network exposure has to be agreed to HERE — once, while
      // someone is still at the terminal. The respawned child inherits that
      // decision (see `assumeYes` below) instead of asking a terminal nobody is
      // watching. A loopback bind skips this entirely: nothing is published, so
      // there is nothing to agree to.
      if (!isLoopbackHost(args.host)) {
        if (args.root) process.env.LATTICE_ROOT = args.root;
        assertBindAllowed(args);
        await bindWithExposureGate(bindTargetFor(args, port), exposureIo(), () =>
          Promise.resolve(),
        );
      }
      await superviseGui({
        cliPath: process.argv[1] ?? '',
        childArgs: process.argv.slice(2),
        currentVersion: getVersion(),
      });
    } catch (e) {
      exitOnGuiFailure(e);
    }
    return;
  }

  try {
    // The `.lattice`/workspace model is universal for the GUI: ensure a root
    // exists, adopt the opened config as a workspace, and reconcile any stray
    // (e.g. previously-joined) sibling configs so every database shows up as a
    // single switchable workspace. There is no "database mode" fallback — that
    // duality was the source of the inconsistent header/settings lists.
    if (args.root) process.env.LATTICE_ROOT = args.root;
    // Refuse a disallowed bind BEFORE resolving or creating anything, so a
    // refusal leaves nothing behind. The gate below re-checks — this is an early
    // out, not the decision.
    assertBindAllowed(args);
    const target = bindTargetFor(args, port);
    const boot = target.boot;
    console.log(
      boot.workspaceId
        ? `Lattice GUI: opening workspace "${boot.displayName}".`
        : 'Lattice GUI: no workspace yet — opening the welcome screen.',
    );
    // Everything above the loopback is a publication. The gate refuses a bind
    // whose root nobody named, states which root + workspace is about to be
    // served, and does not reach the socket until that is confirmed.
    const handle = await bindWithExposureGate(target, exposureIo(), () =>
      startGuiServer({
        configPath: boot.configPath,
        outputDir: boot.contextDir,
        latticeRoot: boot.root,
        port,
        // Honored only after the exposure gate above; defaults to loopback.
        host: args.host,
        openBrowser: !args.noOpen,
        autoRender: true,
        version: getVersion(),
        guiAssetsDir: getGuiAssetsDir(),
        // Master switch: --no-auto-update (or LATTICE_NO_AUTO_UPDATE=1) pins the version.
        autoUpdate: args.autoUpdate,
        // Only a supervised child polls + relaunches: exiting to apply an update is
        // safe solely when the supervisor is there to respawn it.
        selfUpdate: process.env.LATTICE_GUI_SUPERVISED === '1',
      }),
    );
    console.log(`Lattice GUI listening at ${handle.url}`);
    console.log('Press Ctrl+C to stop.');

    const shutdown = (): void => {
      void handle.close().finally(() => process.exit(0));
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    exitOnGuiFailure(e);
  }
}

/** A `BindTarget` plus the bootstrap it was derived from (the caller needs both). */
type GuiBindTarget = BindTarget & { boot: GuiBootstrap };

/**
 * Throw if this bind is disallowed outright — no `--allow-remote`, or a root
 * nobody named. Cheap and side-effect-free, so it can run before any root is
 * resolved or created: a refused `lattice gui` should leave the disk untouched.
 */
function assertBindAllowed(args: ParsedArgs): void {
  const why = remoteBindRefusal({
    host: args.host,
    allowRemote: args.allowRemote,
    rootSource: resolveSessionRoot({ explicitRoot: args.root }).source,
  });
  if (why) throw new RemoteBindRefused(why);
}

/**
 * Resolve the session root, bootstrap it, and describe exactly what a bind would
 * publish. Both the pre-supervision confirmation and the real bind build their
 * target here, so the two can never describe different things.
 */
function bindTargetFor(args: ParsedArgs, port: number): GuiBindTarget {
  const session = resolveSessionRoot({ explicitRoot: args.root });
  const boot = ensureRootForGui({
    startDir: args.root ?? process.cwd(),
    configPath: resolve(args.config),
    explicitConfig: args.config !== './lattice.config.yml',
    ...(args.root !== undefined ? { root: args.root } : {}),
  });
  const activeWs = boot.workspaceId
    ? listWorkspaces(boot.root).find((w) => w.id === boot.workspaceId)
    : undefined;
  return {
    boot,
    host: args.host,
    port,
    allowRemote: args.allowRemote,
    // A supervised child does not re-ask: the supervisor that spawned it already
    // put the disclosure in front of a person. (Setting the variable by hand
    // grants nothing — anyone who can do that can pass --yes.)
    assumeYes: args.assumeYes || process.env.LATTICE_GUI_SUPERVISED === '1',
    rootSource: session.source,
    root: boot.root,
    workspace: activeWs
      ? {
          displayName: activeWs.displayName,
          kind: activeWs.kind,
          configPath: boot.configPath,
        }
      : null,
  };
}

/** Disclosure goes to stderr so stdout stays parseable; the prompt needs a terminal. */
function exposureIo(): ExposureIo {
  return {
    log: (line: string) => {
      console.error(line);
    },
    ...(process.stdin.isTTY ? { prompt: askTerminal } : {}),
  };
}

/**
 * Report a GUI startup failure and exit non-zero. A refused exposure is an
 * operator decision, not a crash, so it prints its reason plainly — without the
 * "Error:" prefix that would read like a bug.
 */
function exitOnGuiFailure(e: unknown): never {
  if (e instanceof RemoteBindRefused) {
    console.error(e.message);
    process.exit(1);
  }
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
}

/** Ask a question on the terminal and resolve with the raw answer. */
async function askTerminal(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// init / workspace
// ---------------------------------------------------------------------------

async function runInit(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  // The home root unless one was named — the same root `lattice gui` will open.
  // Creating a root wherever the shell happened to be is how a checkout ends up
  // holding a registry that a later, unrelated session picks up.
  const root = ensureRootAt(resolveSessionRoot({ explicitRoot: args.root }).root);

  const migrated = importLegacyUserConfig(root);
  if (migrated.migrated) {
    console.log(
      `Imported legacy config (${migrated.copied.join(', ')}) into ${rootConfigDir(root)}`,
    );
  }

  let ws = getActiveWorkspace(root);
  if (!ws) {
    ws = addWorkspace(root, { displayName: args.displayName ?? 'My Workspace' });
    console.log(`Created workspace "${ws.displayName}"`);
  } else {
    console.log(`Using existing workspace "${ws.displayName}"`);
  }

  // Open once to render the initial Context/ tree (no manual `lattice render`).
  const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
  db.close();

  const paths = resolveWorkspacePaths(root, ws);
  console.log(`Lattice root: ${root}`);
  console.log(`Workspace:    ${paths.dir}`);
  console.log(`Context:      ${paths.contextDir}`);
}

async function runWorkspace(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  const session = resolveSessionRoot({ explicitRoot: args.root });
  const root = session.root;
  if (!existsSync(rootConfigDir(root))) {
    console.error(`No .lattice root at ${root}. Run \`lattice init\` first.`);
    if (session.shadowed) {
      console.error(
        `(A root does exist above this directory at ${session.shadowed}; ` +
          `pass --root ${session.shadowed} to use it.)`,
      );
    }
    process.exitCode = 1;
    return;
  }

  try {
    const lines = await runWorkspaceCommand({
      root,
      subcommand: args.subcommand,
      action: args.action,
      displayName: args.displayName,
      assumeYes: args.assumeYes,
    });
    for (const line of lines) console.log(line);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

/**
 * `lattice database` — the databases inside ONE workspace, which is why this
 * resolves a workspace target (`--config`, else a config here, else the active
 * workspace) rather than a root: the set is that workspace's directory.
 */
async function runDatabase(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  try {
    const target = resolveWorkspaceTarget({
      config: args.config,
      explicitConfig: args.config !== './lattice.config.yml',
      ...(args.root !== undefined ? { root: args.root } : {}),
    });
    const lines = await runDatabaseCommand({
      configPath: target.configPath,
      subcommand: args.subcommand,
      action: args.action,
      displayName: args.displayName,
      assumeYes: args.assumeYes,
    });
    for (const line of lines) console.log(line);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

/**
 * `lattice schema` — relationships and definitions in ONE workspace, so this
 * resolves a workspace target the same way `database` does. The workspace is
 * opened for the call, which is why this is the only one of the three that has
 * to know where the rendered context lives.
 */
async function runSchema(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  try {
    const target = resolveWorkspaceTarget({
      config: args.config,
      explicitConfig: args.config !== './lattice.config.yml',
      ...(args.root !== undefined ? { root: args.root } : {}),
    });
    const lines = await runSchemaCommand({
      configPath: target.configPath,
      contextDir: target.contextDir,
      subcommand: args.subcommand,
      action: args.action,
      to: args.to,
      text: args.text,
    });
    for (const line of lines) console.log(line);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

/**
 * `lattice questions` — the clarification queue for ONE workspace, resolved the
 * same way `schema` resolves it, and opened for the call because answering runs
 * real writes against the workspace it belongs to.
 */
async function runQuestions(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  try {
    const target = resolveWorkspaceTarget({
      config: args.config,
      explicitConfig: args.config !== './lattice.config.yml',
      ...(args.root !== undefined ? { root: args.root } : {}),
    });
    const lines = await runQuestionsCommand({
      configPath: target.configPath,
      contextDir: target.contextDir,
      subcommand: args.subcommand,
      action: args.action,
      text: args.text,
      json: args.json,
    });
    for (const line of lines) console.log(line);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// cloud
// ---------------------------------------------------------------------------

/**
 * Run a `lattice cloud` verb against the workspace the flags name.
 *
 * The thin half of the command: resolve which workspace is meant, hand the
 * parsed flags to the subcommand module, print what it returns. Everything with
 * a decision in it lives in that module, where a test can reach it — `main()`
 * runs at import time here, so this file cannot be imported by one.
 *
 * A refusal is not a crash: it prints the reason and sets a non-zero exit code
 * rather than throwing, so a script sees a clean failure and the process still
 * exits normally.
 */
/**
 * `lattice ask "<prompt>"` — the assistant, with no browser.
 *
 * The answer goes to stdout and NOTHING else does, so the command pipes; progress
 * goes to stderr. A turn that failed, or a machine with no model connected, exits
 * non-zero saying what to do — never an empty answer with a zero exit, which a
 * script would read as success.
 */
async function runAsk(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  try {
    process.exitCode = await runAskCommand(
      {
        prompt: args.prompt,
        config: args.config,
        explicitConfig: args.config !== './lattice.config.yml',
        ...(args.root !== undefined ? { root: args.root } : {}),
        json: args.json,
      },
      {
        out: (line) => {
          console.log(line);
        },
        err: (line) => {
          console.error(line);
        },
      },
    );
  } catch (e) {
    console.error(askFailureMessage(e));
    process.exitCode = 1;
  }
}

/**
 * `lattice model <verb>` — say which model this machine uses, with no browser.
 *
 * A workspace is OPTIONAL here and resolving one that does not exist is not a
 * failure: the configuration is machine-local, so a fresh install with nothing
 * set up yet is exactly the machine somebody is configuring. What a workspace
 * adds is retiring a legacy per-workspace copy of a key.
 */
async function runModel(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  try {
    const configPath = resolveModelTarget({
      config: args.config,
      explicitConfig: args.config !== './lattice.config.yml',
      ...(args.root !== undefined ? { root: args.root } : {}),
    });
    const lines = await runModelCommand({
      subcommand: args.subcommand,
      action: args.action,
      baseUrl: args.baseUrl,
      model: args.modelId,
      token: args.token,
      keyStdin: args.keyStdin,
      revoke: args.revoke,
      json: args.json,
      ...(configPath !== undefined ? { configPath } : {}),
    });
    for (const line of lines) console.log(line);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

async function runAccount(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  try {
    const lines = await runAccountCommand({
      subcommand: args.subcommand,
      action: args.action,
      email: args.email,
      displayName: args.displayName,
      codeStdin: args.codeStdin,
      json: args.json,
      root: args.root,
    });
    for (const line of lines) console.log(line);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

/**
 * `lattice connector` — attach and tend external sources.
 *
 * A workspace is REQUIRED here, unlike the model and account verbs: a connected
 * source is part of a workspace, not a property of the machine. Resolving one
 * that does not exist fails the command rather than inventing an empty workspace
 * to attach a database to.
 */
async function runConnector(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  try {
    const target = resolveWorkspaceTarget({
      config: args.config,
      explicitConfig: args.config !== './lattice.config.yml',
      ...(args.root !== undefined ? { root: args.root } : {}),
    });
    const lines = await runConnectorCommand({
      subcommand: args.subcommand,
      action: args.action,
      configPath: target.configPath,
      outputDir: target.contextDir,
      dbHost: args.dbHost,
      dbPort: args.dbPort,
      dbName: args.dbName,
      dbUser: args.dbUser,
      dbSchema: args.dbSchema,
      passwordStdin: args.passwordStdin,
      json: args.json,
    });
    for (const line of lines) console.log(line);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

async function runCloud(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  try {
    // `probe` and `join` must work before a workspace exists — one checks a
    // database nothing points at yet, the other makes the first one — so
    // resolving a target is skipped for them rather than failing ahead of the work.
    const needsWorkspace = args.subcommand !== 'probe' && args.subcommand !== 'join';
    const target = needsWorkspace
      ? resolveCloudTarget({
          config: args.config,
          explicitConfig: args.config !== './lattice.config.yml',
          ...(args.root !== undefined ? { root: args.root } : {}),
        })
      : null;
    const lines = await runCloudCommand({
      subcommand: args.subcommand,
      action: args.action,
      configPath: target?.configPath,
      latticeRoot: target?.latticeRoot ?? null,
      json: args.json,
      email: args.email,
      token: args.token,
      displayName: args.displayName,
      table: args.table,
      pk: args.pk,
      visibility: args.visibility,
      to: args.to,
      revoke: args.revoke,
      urlStdin: args.urlStdin,
    });
    for (const line of lines) console.log(line);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

/**
 * `lattice ingest` — bring a document, a folder, a web address, or text on
 * standard input into the workspace. The summary goes to stdout and progress to
 * stderr, so the outcome survives a pipe.
 */
async function runIngest(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  try {
    process.exitCode = await runIngestCommand(
      {
        target: args.subcommand,
        action: args.action,
        config: args.config,
        explicitConfig: args.config !== './lattice.config.yml',
        root: args.root,
        json: args.json,
        title: args.title,
        privateMode: args.privateMode,
        once: args.once,
        stdin: args.stdin,
      },
      {
        out: (line) => {
          console.log(line);
        },
        err: (line) => {
          console.error(line);
        },
      },
    );
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

/**
 * `lattice import` — turn a spreadsheet, CSV, JSON export, or document with
 * tables in it into real tables and rows. `--dry-run` plans without writing.
 */
async function runImport(args: ParsedArgs): Promise<void> {
  if (args.root) process.env.LATTICE_ROOT = args.root;
  try {
    process.exitCode = await runImportCommand(
      {
        target: args.subcommand,
        config: args.config,
        explicitConfig: args.config !== './lattice.config.yml',
        root: args.root,
        json: args.json,
        dryRun: args.dryRun,
        mode: args.mode,
        asOf: args.asOf,
        asOfColumn: args.asOfColumn,
        sheet: args.sheet,
        assumeYes: args.assumeYes,
      },
      {
        out: (line) => {
          console.log(line);
        },
        err: (line) => {
          console.error(line);
        },
      },
    );
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    printVersion();
    return;
  }

  if (args.help || args.command === undefined) {
    printHelp();
    process.exit(args.command === undefined && !args.help ? 1 : 0);
  }

  // Fire-and-forget update check — prints notice on exit
  const version = getVersion();
  if (version !== 'unknown') {
    checkForUpdate('latticesql', version)
      .then((latest) => {
        if (latest) {
          process.on('exit', () => {
            console.log(
              `\nUpdate available: ${version} → ${latest} — run "lattice update" to upgrade`,
            );
          });
        }
      })
      .catch(() => undefined);
  }

  switch (args.command) {
    case 'generate':
      runGenerate(args);
      break;
    case 'render':
      void runRender(args);
      break;
    case 'reconcile':
      void runReconcile(args, args.dryRun);
      break;
    case 'status':
      void runReconcile(args, true);
      break;
    case 'watch':
      void runWatch(args);
      break;
    case 'gui':
      void runGui(args);
      break;
    case 'init':
      void runInit(args);
      break;
    case 'workspace':
      void runWorkspace(args);
      break;
    case 'database':
      void runDatabase(args);
      break;
    case 'schema':
      void runSchema(args);
      break;
    case 'questions':
      void runQuestions(args);
      break;
    case 'account':
      void runAccount(args);
      break;
    case 'cloud':
      void runCloud(args);
      break;
    case 'connector':
      void runConnector(args);
      break;
    case 'ingest':
      void runIngest(args);
      break;
    case 'import':
      void runImport(args);
      break;
    case 'update':
      void runUpdate(args);
      break;
    case 'doctor':
      void runDoctor(args);
      break;
    case 'search':
      void runSearch(args);
      break;
    case 'ask':
      void runAsk(args);
      break;
    case 'model':
      void runModel(args);
      break;
    case 'reindex':
      void runReindex(args);
      break;
    case 'index':
      void runIndex(args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      printHelp();
      process.exit(1);
  }
}

main();
