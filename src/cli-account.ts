/**
 * The `lattice account` subcommand — signing a machine in, and running a hosted
 * workspace, without a browser.
 *
 * A device sign-in needs a person to approve it, and that made it look like a
 * browser-only feature. It is not: the approval happens on the account service's
 * own page, which the person can open on ANY machine, and everything on either
 * side of it is an ordinary call. So the flow here is start, approve, paste:
 *
 *     lattice account signin           prints a URL to approve
 *     …approve it in any browser…      the page shows a one-time code
 *     lattice account code <code>      this machine is signed in
 *
 * The two halves are separate runs on purpose. A server being prepared over ssh
 * has no browser to hand the code back over a loopback, and the person approving
 * may not even be at that machine — so the unfinished sign-in is kept (encrypted)
 * until a later command finishes it.
 *
 * A CODE NEVER HAS TO BE AN ARGUMENT. `--code-stdin` reads it from standard
 * input, keeping it out of shell history and out of the process list, the same
 * way the model and cloud verbs read a key or a connection string.
 *
 * Nothing here writes to stdout or exits the process. Output is RETURNED as lines
 * and errors are THROWN, so the same logic serves the command wrapper (which
 * prints and sets an exit code) and a caller that wants the outcome as a value.
 */
import { existsSync } from 'node:fs';
import { resolveSessionRoot, rootConfigDir } from './framework/lattice-root.js';
import {
  readAccountStatus,
  pendingAccountSignIn,
  startAccountSignIn,
  completeAccountSignIn,
  signOutAccount,
  syncAccountMemberships,
  listManagedMembers,
  inviteToManagedWorkspace,
  revokeManagedMembership,
  createManagedWorkspace,
  type AccountStatus,
  type MembershipSyncResult,
} from './ops/account.js';
import { accountError } from './ops/account-errors.js';

/** Every verb the command accepts, in the order the help lists them. */
export const ACCOUNT_SUBCOMMANDS = [
  'status',
  'signin',
  'code',
  'signout',
  'sync',
  'members',
  'invite',
  'revoke',
  'create-workspace',
] as const;

export type AccountSubcommand = (typeof ACCOUNT_SUBCOMMANDS)[number];

/**
 * The verbs whose result is worth parsing, and therefore honour `--json`.
 *
 * Not the same set as "the verbs that only read": `signin` changes something (a
 * request is now waiting) and `sync` changes rather a lot, but both hand back a
 * result a script acts on — a URL to display, a list of what arrived. The verbs
 * left out have nothing to parse; a flag that silently did nothing would be worse
 * than one that says it does not apply.
 */
const JSON_VERBS: ReadonlySet<string> = new Set(['status', 'signin', 'sync', 'members']);

/** Everything the account subcommand needs from the parsed argv. */
export interface AccountCommandArgs {
  /** One of {@link ACCOUNT_SUBCOMMANDS}. Defaults to `status`. */
  subcommand?: string | undefined;
  /**
   * The trailing positional: the one-time code for `code`, the membership for
   * `revoke`.
   */
  action?: string | undefined;
  /** `--email` — the invitee for `invite`. */
  email?: string | undefined;
  /** `--name` — the workspace name for `create-workspace`. */
  displayName?: string | undefined;
  /** `--code-stdin` — read the one-time code from standard input instead. */
  codeStdin?: boolean;
  /** `--json` — emit the machine-readable form, for the verbs that have one. */
  json?: boolean;
  /** `--root` — the `.lattice` root a sync registers arriving workspaces in. */
  root?: string | undefined;
  /** Reads the code when `--code-stdin` was passed. Injected for tests. */
  readStdin?: () => Promise<string>;
}

/** Read the one-time code from standard input, whitespace-trimmed. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** The code this invocation was given, from whichever channel was used. */
async function suppliedCode(args: AccountCommandArgs): Promise<string> {
  if (args.codeStdin) return (await (args.readStdin ?? readAllStdin)()).trim();
  return (args.action ?? '').trim();
}

/**
 * The `.lattice` root arriving workspaces are registered in, or null when this
 * machine has none.
 *
 * Deliberately NOT `resolveWorkspaceTarget`: that resolves a workspace, and the
 * machine most likely to run `account sync` is the one that has just been signed
 * in and has no workspace at all yet — which is the entire point of syncing. A
 * root with nothing in it is a perfectly good place to put the first one.
 */
export function resolveAccountRoot(explicitRoot?: string): string | null {
  const session = resolveSessionRoot({ explicitRoot });
  return existsSync(rootConfigDir(session.root)) ? session.root : null;
}

/** The human-readable status report. */
export function formatAccountStatus(
  status: AccountStatus,
  pending: { startedAt: string } | null,
): string[] {
  const lines: string[] = [];
  lines.push(status.linked ? 'Account: signed in' : 'Account: NOT signed in');
  if (status.linked) {
    lines.push(`  Signed in as: ${status.email ?? '?'}${status.name ? ` (${status.name})` : ''}`);
  }
  lines.push(
    status.serviceAvailable
      ? '  Account service: reachable'
      : '  Account service: not reachable from this machine',
  );
  if (status.accountUrl) lines.push(`  Manage the account at: ${status.accountUrl}`);
  if (pending) {
    lines.push(`  A sign-in started ${pending.startedAt} is waiting for its code.`);
    lines.push('  Finish it with: lattice account code <code>');
  }
  if (status.managedWorkspaces) {
    lines.push('  Hosted workspace: this session delegates membership to a workspace manager');
    lines.push('  (members / invite / revoke / create-workspace act on it).');
  }
  return lines;
}

/** What a membership sync did, as lines. Never says "done" about a partial pass. */
export function formatSyncResult(result: MembershipSyncResult): string[] {
  const lines: string[] = [];
  if (!result.linked) {
    lines.push('Not signed in — run `lattice account signin` first.');
    if (result.sessionExpired) {
      lines.push('The stored session was rejected by the service and has been cleared.');
    }
    return lines;
  }
  lines.push(
    result.added.length > 0
      ? `Added ${String(result.added.length)} workspace(s):`
      : 'No new workspaces.',
  );
  for (const a of result.added) lines.push(`  ${a.name} (${a.workspaceId})`);
  if (result.skipped > 0) lines.push(`Already present: ${String(result.skipped)}.`);
  for (const name of result.revoked) lines.push(`Access revoked: ${name}`);
  if (result.errors.length > 0) {
    lines.push('Some memberships did not arrive:');
    for (const e of result.errors) lines.push(`  ${e}`);
  }
  return lines;
}

/**
 * Run one `lattice account` verb.
 *
 * @returns the lines to print.
 * @throws when the verb is unknown, its arguments are wrong, or the operation did
 * not fully succeed. A partial sync and an unconfirmed revocation both throw
 * AFTER reporting what did happen: a command that exited zero having left a
 * spendable token alive, or three of four workspaces unarrived, would be telling
 * the script that ran it something untrue.
 */
export async function runAccountCommand(args: AccountCommandArgs): Promise<string[]> {
  const sub = args.subcommand ?? 'status';
  if (!(ACCOUNT_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new Error(
      `Unknown account subcommand: ${sub} (expected: ${ACCOUNT_SUBCOMMANDS.join(', ')})`,
    );
  }
  if (args.json && !JSON_VERBS.has(sub)) {
    throw new Error(`--json applies to: ${[...JSON_VERBS].join(', ')}`);
  }
  const asJson = (value: unknown): string[] => [JSON.stringify(value, null, 2)];

  switch (sub) {
    case 'status': {
      const status = await readAccountStatus();
      const pending = pendingAccountSignIn();
      return args.json
        ? asJson({ ...status, pendingSignIn: pending })
        : formatAccountStatus(status, pending);
    }

    case 'signin': {
      const started = await startAccountSignIn();
      if (args.json) return asJson(started);
      return [
        'Open this link in any browser and approve the request:',
        `  ${started.verifyUrl}`,
        '',
        'The page will show a one-time code. Finish signing in with:',
        '  lattice account code <code>',
      ];
    }

    case 'code': {
      const code = await suppliedCode(args);
      if (!code) {
        throw accountError(
          'invalid_request',
          'Usage: lattice account code <code> (or --code-stdin and pipe it in)',
        );
      }
      const who = await completeAccountSignIn(code);
      return [`Signed in as ${who.email}${who.name ? ` (${who.name})` : ''}.`];
    }

    case 'signout': {
      const revocation = await signOutAccount();
      if (revocation.revoked) {
        return ['Signed out. This device can no longer spend the account balance.'];
      }
      // Local sign-out already happened; what did NOT happen is the part that
      // matters, so it leaves as a failure rather than a reassuring line.
      throw new Error(revocation.error);
    }

    case 'sync': {
      const root = resolveAccountRoot(args.root);
      const result = await syncAccountMemberships({ latticeRoot: root });
      if (args.json) return asJson(result);
      const lines = formatSyncResult(result);
      // A pass that lost some memberships leaves as a failure, carrying the whole
      // report. Exiting zero after three of four workspaces failed to arrive would
      // tell the script that ran it something untrue.
      if (result.errors.length > 0) throw new Error(lines.join('\n'));
      return lines;
    }

    case 'members': {
      const listed = await listManagedMembers();
      if (args.json) return asJson(listed);
      const members = Array.isArray(listed.members) ? listed.members : [];
      if (members.length === 0) return ['Nobody is on this workspace yet.'];
      return members.map((m) => `${m.email} — ${m.role} (${m.status})`);
    }

    case 'invite': {
      const email = (args.email ?? '').trim();
      if (!email) {
        throw accountError('invalid_request', 'Usage: lattice account invite --email <address>');
      }
      await inviteToManagedWorkspace(email);
      return [`Invited ${email}.`];
    }

    case 'revoke': {
      const membershipId = (args.action ?? '').trim();
      if (!membershipId) {
        throw accountError('invalid_request', 'Usage: lattice account revoke <membership-id>');
      }
      await revokeManagedMembership(membershipId);
      return [`Removed membership ${membershipId}.`];
    }

    case 'create-workspace': {
      const name = (args.displayName ?? '').trim();
      if (!name) {
        throw accountError(
          'invalid_request',
          'Usage: lattice account create-workspace --name <name>',
        );
      }
      await createManagedWorkspace(name);
      return [`Created hosted workspace "${name}".`];
    }
  }

  // Unreachable: the verb was checked against the list above. Throwing rather
  // than returning an empty result keeps a future verb that forgets its case from
  // reporting silent success.
  throw new Error(`Unhandled account subcommand: ${sub}`);
}
