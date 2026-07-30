/**
 * The `lattice cloud` subcommand, extracted from the CLI entrypoint so it is
 * importable (and therefore testable) on its own: `cli.ts` calls `main()` at
 * import time, so nothing defined inside it can be exercised from a test.
 *
 * WHY THESE COMMANDS EXIST. Running a shared workspace — seeing who is on it,
 * inviting somebody, taking them off, sharing a row, securing the database in
 * the first place — was reachable only by clicking in the browser app. On a
 * machine with no display that left exactly one workaround: bind the browser app
 * to a network address, a surface its own help text calls UNAUTHENTICATED. So
 * the price of administering a cloud from a server was publishing an
 * unauthenticated admin panel on it. These verbs remove that price.
 *
 * NO AUTHORITY IS INVENTED HERE, and that is the reason a command line is safe
 * to hand this. Permission on a cloud is the Postgres role you connect as, not a
 * session a caller can assert: the owner checks read `rolcreaterole` for the live
 * role, and every mutating step underneath is a definer function that raises for
 * a member on its own. A member typing `lattice cloud invite` is refused by the
 * database, exactly as they were through a request. Nothing below weakens that,
 * and nothing below re-implements it.
 *
 * Nothing here writes to stdout or exits the process. Output is RETURNED as
 * lines and errors are THROWN, so the same logic serves the CLI wrapper (which
 * prints and sets an exit code) and a caller that wants the outcome as a value.
 * The invite token rides out as one of those lines, which is how it reaches
 * stdout exactly once.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Lattice } from './lattice.js';
import { openConfiguredLattice } from './cli-open.js';
import { ensureRootAt, resolveSessionRoot, rootConfigDir } from './framework/lattice-root.js';
import { getActiveWorkspace, resolveWorkspacePaths } from './framework/workspace.js';
import { NATIVE_ENTITY_NAMES } from './framework/native-entities.js';
import { normalizeLabel } from './framework/db-pointer.js';
import { readIdentity } from './framework/user-config.js';
import { probeCloud } from './framework/cloud-connect.js';
import { cloudStatus, type CloudStatus } from './cloud/status.js';
import { listCloudMembers, type CloudMember } from './cloud/member-directory.js';
import { inviteMember, removeMember } from './cloud/membership.js';
import { assertNotManaged, MANAGED_REFUSAL } from './cloud/managed-guard.js';
import { redeemCloudInvite } from './cloud/join.js';
import { migrateWorkspaceToCloud } from './cloud/migrate.js';
import { parsePostgresUrl } from './cloud/url.js';
import { shareRow, grantRowAccess } from './cloud/sharing.js';
import { secureCloud } from './cloud/setup.js';

/** Every verb the command accepts, in the order the help lists them. */
export const CLOUD_SUBCOMMANDS = [
  'status',
  'members',
  'secure',
  'invite',
  'join',
  'revoke',
  'share',
  'migrate',
  'probe',
] as const;

export type CloudSubcommand = (typeof CLOUD_SUBCOMMANDS)[number];

/** The verbs that only read, and therefore honour `--json`. */
const READ_VERBS: ReadonlySet<string> = new Set(['status', 'members', 'probe']);

/** Everything the cloud subcommand needs from the parsed argv. */
export interface CloudCommandArgs {
  /**
   * `status` | `members` | `secure` | `invite` | `join` | `revoke` | `share` |
   * `migrate` | `probe`. Defaults to `status`.
   */
  subcommand?: string | undefined;
  /**
   * The trailing positional: the member for `revoke`, the URL for `probe` and
   * for `migrate`.
   */
  action?: string | undefined;
  /** The workspace config this command operates on. Not needed by `probe` / `join`. */
  configPath?: string | undefined;
  /** The `.lattice` root the workspace belongs to, when it belongs to one. */
  latticeRoot?: string | null;
  /** `--json` — emit the machine-readable form of a read verb. */
  json?: boolean;
  /** `--email <address>` — the invitee, for `invite`. */
  email?: string | undefined;
  /** `--token <token>` — the invite token being redeemed, for `join`. */
  token?: string | undefined;
  /** `--name <label>` — the workspace name, for `join` and `migrate`. */
  displayName?: string | undefined;
  /** `--table <name>` — the row's table, for `share`. */
  table?: string | undefined;
  /** `--pk <value>` — the row's primary key, for `share`. */
  pk?: string | undefined;
  /** `--visibility <private|everyone|custom>` — for `share`. */
  visibility?: string | undefined;
  /** `--to <member>` — share with (or, with `--revoke`, un-share from) one person. */
  to?: string | undefined;
  /** `--revoke` — with `--to`, take the access away instead of giving it. */
  revoke?: boolean;
  /** `--url-stdin` — read the connection string from standard input. */
  urlStdin?: boolean;
  /**
   * Whether this process is a managed session. Defaults to reading the
   * environment; set it to drive the managed refusal explicitly.
   */
  managed?: boolean;
  /**
   * How the workspace is opened. Injected so a test — or a caller with its own
   * connection — can drive the verbs without a config file on disk. Whatever
   * this returns is CLOSED when the verb finishes, the same as the default.
   */
  open?: (configPath: string) => Promise<Lattice>;
  /** How standard input is read. Injected so the stdin form is testable. */
  readStdin?: () => Promise<string>;
}

// ── Getting a connection string in without publishing it ────────────────────

/** The environment variable `migrate` and `probe` read a connection string from. */
export const CLOUD_URL_ENV = 'LATTICE_CLOUD_URL';

/** Read standard input to the end and return its first non-empty line. */
async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  const text = Buffer.concat(chunks).toString('utf8');
  return text.split('\n').map((l) => l.trim())[0] ?? '';
}

/**
 * The connection string a verb operates on, taken from the safest source the
 * caller offered.
 *
 * A Postgres connection string CONTAINS THE PASSWORD, and the role it belongs to
 * is the cloud owner — the one that can create member roles. An argument is the
 * worst possible place to put it: on a shared machine every other user can read
 * it out of the process list while the command runs, and on the caller's own
 * machine it is written into the shell history file afterwards. The whole point
 * of this command group is that administering a shared workspace from a server
 * should not require publishing a secret on it, so it must not require publishing
 * one either.
 *
 * Three ways in, in order of preference:
 *
 *   `--url-stdin` (or `-` in place of the URL) — piped in, never in the process
 *     list and never in a history file. The recommended form.
 *   `LATTICE_CLOUD_URL` — an environment variable, for a job runner or a secret
 *     manager that already hands secrets over that way.
 *   the positional argument — still accepted, because scripts and one-off
 *     interactive use rely on it, but it WARNS on standard error, because a
 *     credential that has been in a process list has to be treated as exposed.
 *
 * @throws when none of the three produced anything.
 */
async function resolveCloudUrl(args: CloudCommandArgs, usage: string): Promise<string> {
  const positional = args.action?.trim() ?? '';
  if (args.urlStdin === true || positional === '-') {
    const piped = (await (args.readStdin ?? readStdinLine)()).trim();
    if (!piped) throw new Error('Nothing arrived on standard input. ' + usage);
    return piped;
  }
  if (positional) {
    console.warn(
      `[lattice] the connection string was passed as an argument, where other users of this ` +
        `machine can read it from the process list and your shell records it in its history. ` +
        `Treat that password as exposed. Pipe it in with --url-stdin, or set ${CLOUD_URL_ENV}.`,
    );
    return positional;
  }
  const fromEnv = (process.env[CLOUD_URL_ENV] ?? '').trim();
  if (fromEnv) return fromEnv;
  throw new Error(usage);
}

// ── Resolving which workspace the command is about ──────────────────────────

/** Where a cloud command operates: the config it opens, and the root it is in. */
export interface CloudTarget {
  configPath: string;
  latticeRoot: string | null;
}

/** What the CLI knows about which workspace the user meant. */
export interface CloudTargetInput {
  /** `--config` as parsed, which carries a default the user may not have typed. */
  config: string;
  /** True only when `--config` was actually passed. */
  explicitConfig: boolean;
  /** `--root`, when given. */
  root?: string | undefined;
}

/**
 * Decide which workspace a cloud command is about.
 *
 * A cloud command is far more likely to be typed from an arbitrary directory
 * than a `render` is — you administer a cloud from wherever you happen to be —
 * so an explicit `--config` wins, a config file sitting in the current directory
 * is used next, and otherwise the command falls back to the ACTIVE workspace in
 * the root. Nothing here creates a root or a workspace: a read-only diagnosis
 * must not leave anything behind on a machine that had none.
 *
 * @throws when the named config does not exist, or when nothing resolves.
 */
export function resolveCloudTarget(input: CloudTargetInput): CloudTarget {
  const named = resolve(input.config);
  const session = resolveSessionRoot({ explicitRoot: input.root });
  const root = existsSync(rootConfigDir(session.root)) ? session.root : null;

  if (input.explicitConfig) {
    if (!existsSync(named)) throw new Error(`No config file at ${named}.`);
    return { configPath: named, latticeRoot: root };
  }
  if (existsSync(named)) return { configPath: named, latticeRoot: root };

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
  return { configPath: resolveWorkspacePaths(root, active).configPath, latticeRoot: root };
}

/**
 * The root a join lands in — created if it is not there yet.
 *
 * Joining is the one cloud verb that does not operate ON a workspace: it makes a
 * new one. So it cannot resolve a target the way the others do, and it must work
 * on a machine that has never run anything else — the whole point is a fresh
 * server being given a token. Creating the root is the smallest thing that makes
 * that work, and it creates ONLY the root: no default workspace, nothing to
 * clean up if the join then fails.
 */
export function resolveJoinRoot(): string {
  return ensureRootAt(resolveSessionRoot().root);
}

// ── Naming a member ─────────────────────────────────────────────────────────

/**
 * Find the member a human named.
 *
 * Accepts what a person actually has in front of them after `lattice cloud
 * members`: the database role, the email, or the display name. Resolution is
 * most-specific-first so an exact role always wins, and a reference matching
 * more than one member is REFUSED with the roles to disambiguate with rather
 * than silently resolved to whichever came first — the operations behind this
 * revoke somebody's access, and picking the wrong person is not recoverable by
 * re-running it.
 *
 * The owner row is excluded: the owner is not a member, and neither removing nor
 * granting to yourself is a thing this resolves.
 *
 * @throws when nothing matches or the reference is ambiguous.
 */
export function resolveMemberRef(members: readonly CloudMember[], ref: string): CloudMember {
  const candidates = members.filter((m) => m.status !== 'owner');
  const pick = (matches: CloudMember[]): CloudMember | null => {
    if (matches.length === 1) return matches[0] ?? null;
    if (matches.length > 1) {
      const roles = matches.map((m) => m.role).join(', ');
      throw new Error(
        `"${ref}" matches ${String(matches.length)} members: ${roles}. Use the role instead.`,
      );
    }
    return null;
  };
  const lower = ref.toLowerCase();
  const byRole = pick(candidates.filter((m) => m.role === ref));
  if (byRole) return byRole;
  const byEmail = pick(candidates.filter((m) => m.email.toLowerCase() === lower));
  if (byEmail) return byEmail;
  const byName = pick(candidates.filter((m) => m.name.toLowerCase() === lower));
  if (byName) return byName;
  const known = candidates.map((m) => m.role).join(', ') || '(nobody)';
  throw new Error(`No member "${ref}" on this cloud. Members: ${known}.`);
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Pad `s` to `width`, for the aligned columns the roster prints. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** The human-readable status report. */
export function formatCloudStatus(status: CloudStatus, configPath: string): string[] {
  const lines = [`Workspace:  ${configPath}`, `Database:   ${status.dialect}`];
  if (status.dialect !== 'postgres') {
    lines.push(
      'Cloud:      no — a local single-user workspace. Only a Postgres database can be a cloud.',
    );
    return lines;
  }
  lines.push(`Connected:  ${status.role || '(unknown role)'}`);
  switch (status.standing) {
    case 'owner':
      lines.push('Security:   installed', 'You are:    the owner — you can invite and remove');
      break;
    case 'member':
      lines.push(
        'Security:   installed',
        'You are:    a member — you see the rows shared with you',
      );
      break;
    case 'not-a-cloud':
      lines.push(
        'Security:   NOT installed — this Postgres is not a cloud yet',
        'You are:    the only user. Run `lattice cloud secure` to share it.',
      );
      break;
  }
  if (status.warnings.length === 0) {
    lines.push('Warnings:   none');
    return lines;
  }
  lines.push(`Warnings:   ${String(status.warnings.length)}`);
  for (const w of status.warnings) lines.push(`  - ${w.table}: ${w.reason}`);
  return lines;
}

/** The human-readable roster. */
export function formatCloudMembers(members: readonly CloudMember[]): string[] {
  if (members.length === 0) {
    return ['Not a cloud — a local workspace has no members.'];
  }
  const nameWidth = Math.max(...members.map((m) => m.name.length), 4);
  const statusWidth = Math.max(...members.map((m) => m.status.length), 6);
  return members.map((m) => {
    const mark = m.isYou ? '*' : ' ';
    const email = m.email ? `  <${m.email}>` : '';
    return `${mark} ${pad(m.name, nameWidth)}  ${pad(m.status, statusWidth)}  ${m.role}${email}`;
  });
}

// ── The verbs ───────────────────────────────────────────────────────────────

/**
 * Check a connection string without committing to it. Never throws — an
 * unreachable target is an ANSWER here, not a failure, so the report says so and
 * the command still exits zero.
 */
async function runProbe(args: CloudCommandArgs): Promise<string[]> {
  const url = await resolveCloudUrl(
    args,
    `Usage: lattice cloud probe --url-stdin   (or set ${CLOUD_URL_ENV}, ` +
      `or pass the URL as an argument)`,
  );
  const result = await probeCloud(url);
  if (args.json) return [JSON.stringify(result, null, 2)];
  const lines = [`Reachable:  ${result.reachable ? 'yes' : 'no'}`, `Database:   ${result.dialect}`];
  if (!result.reachable) {
    lines.push(`Error:      ${result.error ?? 'unknown'}`);
    return lines;
  }
  lines.push(
    result.isCloud
      ? 'Cloud:      yes — row security is installed, join it with an invite'
      : 'Cloud:      no — nobody has secured this database as a cloud yet',
  );
  return lines;
}

async function runStatus(
  db: Lattice,
  args: CloudCommandArgs,
  configPath: string,
): Promise<string[]> {
  const status = await cloudStatus(db);
  if (args.json) return [JSON.stringify(status, null, 2)];
  return formatCloudStatus(status, configPath);
}

async function runMembers(db: Lattice, args: CloudCommandArgs): Promise<string[]> {
  const members = await listCloudMembers(db);
  if (args.json) return [JSON.stringify(members, null, 2)];
  return formatCloudMembers(members);
}

/**
 * Turn this database into a secured cloud, and PROVE the workspace's own tables
 * were covered.
 *
 * The proof is the point. Securing walks the tables the workspace has
 * registered, so a caller that opened the workspace without its built-in tables
 * — the file index, the secret store, the assistant's private conversation
 * storage — secures everything EXCEPT those, leaving them readable by every
 * member on a database that reports itself as secured. That is a silent
 * privacy hole and it is invisible from the outcome, so it is checked twice:
 * before, that the tables are registered at all, and after, that securing
 * actually reached them.
 *
 * The managed refusal comes first and is the SAME one the browser app raises.
 * Securing is not idempotent in the way "already a cloud" suggests: it re-stamps
 * row ownership and re-applies member access, so re-running it against a database
 * a manager provisioned changes state the manager owns.
 */
async function runSecure(db: Lattice, args: CloudCommandArgs): Promise<string[]> {
  assertNotManaged(args.managed, MANAGED_REFUSAL.secure);
  const registered = new Set(db.getRegisteredTableNames());
  const unregistered = [...NATIVE_ENTITY_NAMES].filter((n) => !registered.has(n)).sort();
  if (unregistered.length > 0) {
    throw new Error(
      `This workspace was opened without its built-in tables (${unregistered.join(', ')}), so ` +
        `securing would leave them unprotected while reporting success. Refusing to secure a ` +
        `partially-opened workspace.`,
    );
  }

  const before = await cloudStatus(db);
  if (before.dialect !== 'postgres') {
    throw new Error('Only a Postgres database can be secured as a cloud.');
  }
  if (before.standing === 'member') {
    throw new Error('Only a cloud owner can secure a cloud — this connection is a member.');
  }
  await secureCloud(db);

  const after = await cloudStatus(db);
  if (!after.secured) {
    throw new Error('Securing ran but row security is still not installed on this database.');
  }
  // The built-in tables carry files, secrets, and private conversations. If any
  // of them is still flagged after securing, say so and fail — a cloud that
  // reports itself secured while those are open is worse than one that refuses.
  const stillOpen = after.warnings.filter((w) => NATIVE_ENTITY_NAMES.has(w.table));
  if (stillOpen.length > 0) {
    throw new Error(
      `Securing did not cover this workspace's built-in tables:\n` +
        stillOpen.map((w) => `  - ${w.table}: ${w.reason}`).join('\n'),
    );
  }

  const lines = [
    before.secured
      ? 'Already a cloud — re-converged its row security and member access.'
      : 'Secured. This database is now a Lattice cloud.',
    `Connected as ${after.role} (owner).`,
  ];
  if (after.warnings.length > 0) {
    lines.push(`${String(after.warnings.length)} table(s) need attention:`);
    for (const w of after.warnings) lines.push(`  - ${w.table}: ${w.reason}`);
  }
  lines.push('Invite somebody with `lattice cloud invite --email <address>`.');
  return lines;
}

/**
 * Provision a scoped role for one person and print the token that carries it,
 * ONCE. The token is the credential — it is never stored and cannot be shown
 * again, so the guidance around it is the same guidance the browser app gives.
 */
async function runInvite(
  db: Lattice,
  args: CloudCommandArgs,
  target: CloudTarget,
): Promise<string[]> {
  const email = args.email?.trim() ?? '';
  if (!email) throw new Error('Usage: lattice cloud invite --email <address>');
  const result = await inviteMember(db, {
    email,
    configPath: target.configPath,
    latticeRoot: target.latticeRoot,
  });
  return [
    `Invited ${result.email} as role ${result.role}.`,
    '',
    'Send them this invite token privately. It is bound to that email address —',
    'only they can redeem it — it expires in about 7 days, and it is not stored',
    'anywhere, so this is the only time it can be shown:',
    '',
    result.token,
    '',
    'They redeem it by entering their email and this token in "Join a cloud", or',
    'by calling redeemCloudInvite() from the package with the same two values.',
  ];
}

/**
 * Redeem an invite and land in a NEW workspace.
 *
 * The member half of the flow, and the one that most needed a command: a token
 * arrives by email, and until now spending it required a browser — on the very
 * machine that may not have one. The token is bound to the address it was sent
 * to, and that address is half of what decrypts it, so `--email` is genuinely
 * required input rather than a lookup; this machine's own identity is used when
 * it matches, which it usually does, and is refused rather than guessed at when
 * there is none.
 *
 * The invite is claimed BEFORE anything is created (see the join capability), so
 * a token that was already spent, revoked, or has expired is refused with no
 * workspace made and nothing to undo. What lands is a NEW workspace pointing at
 * the shared database — never a repoint of whatever was already open.
 */
async function runJoin(args: CloudCommandArgs): Promise<string[]> {
  const token = args.token?.trim() ?? '';
  if (!token) {
    throw new Error('Usage: lattice cloud join --token <token> [--email <address>] [--name <n>]');
  }
  const email = (args.email?.trim() ?? '') || readIdentity().email.trim();
  if (!email) {
    throw new Error(
      'An invite is bound to the email address it was sent to, and that address is half of ' +
        'what decrypts it. Pass --email <address>.',
    );
  }
  const label = args.displayName?.trim() ?? '';
  const result = await redeemCloudInvite({
    email,
    token,
    latticeRoot: args.latticeRoot ?? resolveJoinRoot(),
    ...(label ? { label } : {}),
  });
  return [
    `Joined as ${email}.`,
    `Workspace "${result.label}" (${result.workspaceId}) is now the active one.`,
    '',
    'You are a scoped member: you see the rows shared with you, and nothing else.',
    'Run `lattice cloud status` to confirm, and `lattice cloud members` to see who else is on it.',
  ];
}

/**
 * Move this workspace onto a shared Postgres.
 *
 * Everything before the last mile was already a library call; what was missing
 * is the last mile itself — repointing the config, updating the registry, and
 * retiring the local file — which only existed inside a request handler and had
 * no unwind. The capability does all of it as one reversible sequence, so this
 * verb either reports a completed move or reports a refusal against a workspace
 * that is exactly as it was.
 *
 * The open handle is surrendered before the local file is renamed: a database a
 * process still holds open cannot be renamed at all on some platforms, and doing
 * it anyway is how the last step of a migration fails on somebody else's laptop.
 */
async function runMigrate(
  db: Lattice,
  args: CloudCommandArgs,
  target: CloudTarget,
  releaseSource: () => void,
): Promise<string[]> {
  const url = await resolveCloudUrl(
    args,
    `Usage: lattice cloud migrate --url-stdin [--name <workspace-name>]   (or set ` +
      `${CLOUD_URL_ENV}, or pass the URL as an argument)`,
  );
  const parsed = parsePostgresUrl(url);
  if (!parsed) {
    throw new Error(
      'A shared workspace is a Postgres database — pass its postgres:// URL. ' +
        'Check it first with `lattice cloud probe <url>`.',
    );
  }
  // The database name is a good default: it is what the operator already chose
  // for this workspace, and it is the name every member will see.
  const named = args.displayName?.trim() ?? '';
  const label = normalizeLabel(named.length > 0 ? named : parsed.dbname);
  if (!label) {
    throw new Error('The workspace name needs at least one letter or number — pass --name.');
  }
  const result = await migrateWorkspaceToCloud({
    db,
    configPath: target.configPath,
    url,
    label,
    latticeRoot: target.latticeRoot,
    releaseSource,
  });
  const lines = [
    `Migrated ${String(result.rowsCopied)} row(s) across ${String(result.tablesCopied.length)} ` +
      `table(s) into ${parsed.dbname}.`,
    `This workspace now runs on the shared database (connection "${result.credentialKey}"), and ` +
      `row security is installed.`,
  ];
  if (result.credentialKey !== label) {
    // Silently reusing the name would have repointed whichever workspace already
    // read it — say which name this one actually got.
    lines.push(
      `The name "${label}" was already stored for a different database, so this connection was ` +
        `saved as "${result.credentialKey}". Pass --name to choose one.`,
    );
  }
  if (result.sourceBackupPath !== null) {
    lines.push(`The local database was kept at ${result.sourceBackupPath}.`);
  }
  if (result.warning !== undefined) lines.push(`Warning: ${result.warning}`);
  lines.push('', 'Invite somebody with `lattice cloud invite --email <address>`.');
  return lines;
}

/**
 * The database role behind whatever a human typed, plus a label to say it back
 * with.
 *
 * Deliberately best-effort, and it has to be. Enumerating the roster is an owner
 * privilege — a member sees nobody but themselves — so resolving through the
 * roster is possible for one caller and impossible for the other. An owner
 * therefore gets name and email resolution plus a strict refusal on a typo, and
 * a member's argument is passed through UNTOUCHED as the role.
 *
 * That is not a loophole: passing it through is what lets the DATABASE answer.
 * A member who names a role they may not touch is refused by the definer
 * function behind the operation, which is the authoritative answer; resolving
 * locally would instead tell them the person does not exist, which is both
 * untrue and a worse thing to read.
 */
async function resolveMemberRole(
  db: Lattice,
  ref: string,
): Promise<{ role: string; label: string }> {
  const roster = await listCloudMembers(db);
  const canEnumerate = roster.some((m) => m.isYou && m.status === 'owner');
  if (!canEnumerate) return { role: ref, label: ref };
  const member = resolveMemberRef(roster, ref);
  return { role: member.role, label: member.name || member.role };
}

async function runRevoke(db: Lattice, args: CloudCommandArgs): Promise<string[]> {
  const ref = args.action?.trim() ?? '';
  if (!ref) throw new Error('Usage: lattice cloud revoke <member>   (role, email, or name)');
  const { role, label } = await resolveMemberRole(db, ref);
  const result = await removeMember(db, role);
  return [`Removed ${label} (${result.role}). Their credential no longer works.`];
}

/**
 * Change who can see one row: either its visibility, or one person's access to
 * it. The two forms are separate because they are separate operations in the
 * database, and conflating them is how a row ends up shared with everybody when
 * somebody meant to share it with one person.
 */
async function runShare(db: Lattice, args: CloudCommandArgs): Promise<string[]> {
  const table = args.table?.trim() ?? '';
  const pk = args.pk?.trim() ?? '';
  const visibility = args.visibility?.trim() ?? '';
  const to = args.to?.trim() ?? '';
  if (!table || !pk) {
    throw new Error(
      'Usage: lattice cloud share --table <table> --pk <id> --visibility <private|everyone>\n' +
        '   or: lattice cloud share --table <table> --pk <id> --to <member> [--revoke]',
    );
  }
  if (visibility && to) {
    throw new Error(
      'Pass either --visibility (who can see it at all) or --to (one person), not both.',
    );
  }
  if (to) {
    // A member sharing THEIR OWN row with a colleague is a legitimate thing to
    // do, and they cannot enumerate the roster to name them — so the reference
    // is passed through for them and the database decides. See resolveMemberRole.
    const { role, label } = await resolveMemberRole(db, to);
    const result = await grantRowAccess(db, {
      table,
      pk,
      grantee: role,
      revoke: args.revoke === true,
    });
    return [
      result.revoked
        ? `Revoked ${label}'s access to ${table} ${pk}.`
        : `Shared ${table} ${pk} with ${label}.`,
    ];
  }
  if (!visibility) {
    throw new Error('Pass --visibility <private|everyone> or --to <member>.');
  }
  const result = await shareRow(db, { table, pk, visibility });
  return [`${result.table} ${result.pk} is now visible to: ${result.visibility}.`];
}

// ── The command ─────────────────────────────────────────────────────────────

/** Open the workspace for a verb that needs one. The caller closes it. */
async function openWorkspace(configPath: string): Promise<Lattice> {
  const db = await openConfiguredLattice({ config: configPath });
  // A scoped member is detected inside init and skips the schema DDL it has no
  // privilege for, so one call serves an owner and a member alike.
  await db.init();
  return db;
}

/**
 * Run one `lattice cloud` subcommand.
 *
 * @returns the lines to print, in order.
 * @throws on a usage error, an unknown subcommand, or a refusal from the database.
 */
export async function runCloudCommand(args: CloudCommandArgs): Promise<string[]> {
  const sub = args.subcommand ?? 'status';
  if (!(CLOUD_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new Error(
      `Unknown cloud subcommand: ${sub} (expected: ${CLOUD_SUBCOMMANDS.join(' | ')})`,
    );
  }
  if (args.json && !READ_VERBS.has(sub)) {
    throw new Error(
      `--json describes a result that can be read; \`cloud ${sub}\` changes something. ` +
        `It is supported by: ${[...READ_VERBS].join(', ')}.`,
    );
  }
  // The two verbs that must work with NO workspace to operate on. Probing is how
  // you check a database before anything points at it; joining is how a machine
  // that has never had a workspace gets its first one.
  if (sub === 'probe') return runProbe(args);
  if (sub === 'join') return runJoin(args);

  const configPath = args.configPath;
  if (!configPath) throw new Error('No workspace config to open — pass --config <path>.');
  const target: CloudTarget = { configPath, latticeRoot: args.latticeRoot ?? null };

  const db = await (args.open ?? openWorkspace)(configPath);
  // Migrating hands the handle over part-way through, because the file behind it
  // has to be renamed. Closing exactly once — whoever gets there first — keeps
  // that from becoming a double close, without a swallowed error to hide it.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    db.close();
  };
  try {
    switch (sub) {
      case 'status':
        return await runStatus(db, args, configPath);
      case 'members':
        return await runMembers(db, args);
      case 'secure':
        return await runSecure(db, args);
      case 'invite':
        return await runInvite(db, args, target);
      case 'revoke':
        return await runRevoke(db, args);
      case 'migrate':
        return await runMigrate(db, args, target, release);
      default:
        return await runShare(db, args);
    }
  } finally {
    release();
  }
}
