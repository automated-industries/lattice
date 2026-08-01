/**
 * The `lattice model` subcommand — pointing a machine at a model, without a
 * browser.
 *
 * Every other part of Lattice could be driven from a script, and then the first
 * thing anyone has to do on a new machine — say which model answers — could only
 * be done by clicking. That made the assistant unusable exactly where it is most
 * useful: a server with no display, a container image being prepared, a fleet
 * being configured the same way twice. The settings screen was the only door.
 *
 * These verbs open the other one. Every value they touch is machine-local and
 * encrypted at rest, the same store the app writes, so a machine configured here
 * and a machine configured by clicking are indistinguishable afterwards.
 *
 * EVERY BACKEND IS REACHABLE FROM HERE, including a Claude subscription. That
 * one used to be the exception, and the reason was a browser cookie rather than
 * anything about the flow: only the consent screen needs a person and a browser,
 * and that page is the provider's, opened on whatever machine that person is at.
 * So it is start, approve, hand the code back:
 *
 *     lattice model subscription      prints the URL to approve
 *     …approve it in any browser…     the page shows a one-time code
 *     lattice model code <code>       this machine is connected
 *
 * The other backends — an OpenAI-compatible endpoint, a hosted account — take one
 * command each, and choosing which of them answers, the speech keys, and
 * disconnecting any of them are all here too.
 *
 * A SECRET NEVER HAS TO BE AN ARGUMENT. `--key-stdin` reads it from standard
 * input, so it stays out of shell history and out of the process list, which is
 * the same reason the cloud verbs read a connection string that way.
 *
 * Nothing here writes to stdout or exits the process. Output is RETURNED as lines
 * and errors are THROWN, so the same logic serves the command wrapper (which
 * prints and sets an exit code) and a caller that wants the outcome as a value.
 */
import type { Lattice } from './lattice.js';
import { openConfiguredLattice } from './cli-open.js';
import { resolveWorkspaceTarget } from './cli-target.js';
import {
  readModelStatus,
  connectModelEndpoint,
  disconnectModelEndpoint,
  connectAccountModel,
  disconnectAccountModel,
  selectModelProvider,
  testModelProvider,
  setAssistantApiKey,
  clearAssistantApiKey,
  disconnectClaudeSubscription,
  type ModelStatus,
} from './ops/ai-config.js';
import { modelError } from './ops/model-errors.js';
import {
  startSubscriptionSignIn,
  completeSubscriptionSignIn,
  pendingSubscriptionSignIn,
} from './ops/subscription.js';

/** Every verb the command accepts, in the order the help lists them. */
export const MODEL_SUBCOMMANDS = [
  'status',
  'connect',
  'subscription',
  'code',
  'account',
  'use',
  'test',
  'key',
  'disconnect',
] as const;

export type ModelSubcommand = (typeof MODEL_SUBCOMMANDS)[number];

/**
 * The verbs whose result is worth parsing, and therefore honour `--json`.
 *
 * Not the same set as "the verbs that only read": `subscription` changes
 * something (an attempt is now waiting) but hands back a URL a script has to
 * display or open. The verbs left out have nothing to parse, and a flag that
 * silently did nothing would be worse than one that says it does not apply.
 */
const READ_VERBS: ReadonlySet<string> = new Set(['status', 'subscription']);

/** What `disconnect` can be pointed at, and what each one forgets. */
const DISCONNECT_TARGETS: ReadonlySet<string> = new Set(['endpoint', 'account', 'subscription']);

/** Everything the model subcommand needs from the parsed argv. */
export interface ModelCommandArgs {
  /** One of {@link MODEL_SUBCOMMANDS}. Defaults to `status`. */
  subcommand?: string | undefined;
  /**
   * The trailing positional: the provider for `use`, the credential name for
   * `key`, what to forget for `disconnect`, the one-time code for `code`.
   */
  action?: string | undefined;
  /** `--base-url` — the OpenAI-compatible endpoint to connect. */
  baseUrl?: string | undefined;
  /** `--model` — the model id that endpoint should be asked for. */
  model?: string | undefined;
  /** `--token` — a credential passed inline. Prefer `--key-stdin`. */
  token?: string | undefined;
  /** `--key-stdin` — read the credential from standard input instead. */
  keyStdin?: boolean;
  /** `--revoke` — with `key`, clear the named credential instead of setting it. */
  revoke?: boolean;
  /** `--json` — emit the machine-readable form of a read verb. */
  json?: boolean;
  /**
   * The workspace whose `secrets` table should also be tidied, when one is open.
   * Optional: the configuration itself is machine-local, so every verb works on a
   * machine that has no workspace at all — which is the state a fresh install is
   * in, and exactly when someone is configuring a model.
   */
  configPath?: string | undefined;
  /** Reads the credential when `--key-stdin` was passed. Injected for tests. */
  readStdin?: () => Promise<string>;
  /**
   * Opens the workspace and returns it READY — schema applied, adapter opened.
   * Injected for tests; defaults to the shared opener. An opener that hands back
   * an unopened workspace is the bug this seam exists to name: every verb below
   * can reach the `secrets` table, and an unopened workspace fails there with a
   * message about an adapter rather than about models — after the machine-local
   * half of the write has already landed.
   */
  open?: (configPath: string) => Promise<Lattice>;
}

/** Read a secret from standard input, whitespace-trimmed. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * The credential this invocation was given, from whichever channel was used.
 *
 * Being explicit about "neither" matters: a `connect` with no key is a legitimate
 * request (a local model server that wants none), while a `key set` with no key
 * is a mistake. The two callers want different answers to the same question, so
 * this returns what it found and lets each decide.
 */
async function suppliedKey(args: ModelCommandArgs): Promise<string | null> {
  if (args.keyStdin) return (await (args.readStdin ?? readAllStdin)()).trim();
  if (typeof args.token === 'string' && args.token.trim()) return args.token.trim();
  return null;
}

/**
 * The one-time code this invocation was given, from whichever channel was used.
 *
 * A code is short-lived and single-use, so it is far less sensitive than a key —
 * but it reads back the same two channels, because a person who has learned to
 * pipe a secret should not have to learn a second habit for this one.
 */
async function suppliedCode(args: ModelCommandArgs): Promise<string> {
  if (args.keyStdin) return (await (args.readStdin ?? readAllStdin)()).trim();
  if (typeof args.token === 'string' && args.token.trim()) return args.token.trim();
  return (args.action ?? '').trim();
}

/**
 * Open the workspace a verb was pointed at, READY TO QUERY, or work
 * machine-local only.
 *
 * A missing workspace is NOT an error here, and that is the whole point: model
 * configuration is a property of the machine, so a fresh install with no
 * workspace yet must still be able to connect one. What a workspace adds is the
 * retirement of a legacy per-workspace copy of a key, which is tidying rather
 * than the operation.
 *
 * Constructing the workspace is only half of opening it. Every verb here can
 * reach the `secrets` table — the status read consults it for a credential the
 * machine store does not hold, and the key verbs retire the legacy copy in it —
 * and an unopened workspace throws at that first query. That is worse than a
 * plain failure for the write verbs, which change the machine-local store BEFORE
 * they tidy the workspace: the credential is saved and the command still reports
 * that it failed.
 */
async function openReady(configPath: string): Promise<Lattice> {
  const db = await openConfiguredLattice({ config: configPath });
  // A scoped member is detected inside init and skips the schema DDL it has no
  // privilege for, so one call serves an owner and a member alike.
  await db.init();
  return db;
}

async function openIfConfigured(
  configPath: string | undefined,
  open: (configPath: string) => Promise<Lattice>,
): Promise<Lattice | null> {
  if (configPath === undefined) return null;
  return open(configPath);
}

/** The workspace a model verb should tidy, when the machine has one to tidy. */
export function resolveModelTarget(input: {
  config: string;
  explicitConfig: boolean;
  root?: string | undefined;
}): string | undefined {
  try {
    return resolveWorkspaceTarget(input).configPath;
  } catch (e) {
    // No workspace resolved. Every verb still works — the configuration lives on
    // the machine, not in a workspace — so this is a fact about the machine, not
    // a failure of the command. An EXPLICIT --config that does not exist is a
    // different matter: the user named something, and it is not there.
    if (input.explicitConfig) throw e;
    return undefined;
  }
}

/** How a provider kind reads in a sentence. */
function providerLabel(kind: string): string {
  if (kind === 'openai_compat') return 'an OpenAI-compatible endpoint';
  if (kind === 'lattice_cloud') return 'a Lattice Cloud account';
  return 'Claude';
}

/** The human-readable status report. */
export function formatModelStatus(status: ModelStatus): string[] {
  const lines: string[] = [];
  lines.push(status.connected ? 'Model: connected' : 'Model: NOT connected');
  lines.push(
    `  Active backend: ${providerLabel(status.activeProvider)} (${status.activeProvider})`,
  );
  if (status.managedModelAuth) {
    lines.push('  Managed deployment: the operator supplies the credential, and it cannot be');
    lines.push('  changed from here.');
  }
  if (status.claudeAuthKind === 'oauth') {
    lines.push('  Claude subscription: connected');
  } else {
    lines.push('  Claude subscription: not connected (lattice model subscription)');
    // A started-and-unfinished attempt is the state most likely to look like
    // nothing happened, so it is reported with the verb that finishes it.
    const pending = pendingSubscriptionSignIn();
    if (pending) {
      lines.push(`    A connection started ${pending.startedAt} is waiting for its code.`);
      lines.push('    Finish it with: lattice model code <code>');
    }
  }
  lines.push(
    status.openaiCompat.configured
      ? `  OpenAI-compatible endpoint: ${status.openaiCompat.model ?? '?'} at ${status.openaiCompat.baseUrl ?? '?'}`
      : '  OpenAI-compatible endpoint: not configured',
  );
  lines.push(
    status.latticeCloud.configured
      ? '  Lattice Cloud account: active'
      : '  Lattice Cloud account: not active',
  );
  if (status.modelAccessBlocked === 'cloud_balance_exhausted') {
    lines.push('  Blocked: the account has no tokens left — top it up or switch backend.');
  }
  if (status.balanceUnavailable) {
    lines.push('  Balance: could not be read (this is not the same as zero).');
  } else if (status.balanceCents !== null) {
    lines.push(`  Balance: ${(status.balanceCents / 100).toFixed(2)}`);
  }
  if (status.limitState) lines.push('  Claude usage limit is currently in effect.');
  if (status.authWarning) lines.push('  Claude needs reconnecting — its token refresh failed.');
  lines.push(
    status.hasVoiceKey
      ? `  Speech: ${status.sttProvider ?? '?'} key configured (mode: ${status.voiceMode})`
      : `  Speech: no cloud key (mode: ${status.voiceMode})`,
  );
  return lines;
}

/**
 * Run one `lattice model` verb.
 *
 * @returns the lines to print.
 * @throws when the verb is unknown, its arguments are wrong, or the operation is
 * refused. Every one of those is a non-zero exit for the caller: a command that
 * printed a reassuring line after failing to configure anything would be worse
 * than useless to the script that ran it.
 */
export async function runModelCommand(args: ModelCommandArgs): Promise<string[]> {
  const sub = args.subcommand ?? 'status';
  if (!(MODEL_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new Error(`Unknown model subcommand: ${sub} (expected: ${MODEL_SUBCOMMANDS.join(', ')})`);
  }
  if (args.json && !READ_VERBS.has(sub)) {
    throw new Error(`--json applies to: ${[...READ_VERBS].join(', ')}`);
  }

  const db = await openIfConfigured(args.configPath, args.open ?? openReady);
  try {
    return await runModelVerb(sub, args, db);
  } finally {
    // Opened here, closed here. A command that left a connection behind would
    // hold a database file (or a pooled cloud connection) open past its own exit.
    db?.close();
  }
}

/** The verb itself, with the workspace already open (or absent). */
async function runModelVerb(
  sub: string,
  args: ModelCommandArgs,
  db: Lattice | null,
): Promise<string[]> {
  switch (sub) {
    case 'status': {
      const status = await readModelStatus(db);
      return args.json ? [JSON.stringify(status, null, 2)] : formatModelStatus(status);
    }

    case 'connect': {
      const baseUrl = args.baseUrl?.trim() ?? '';
      const model = args.model?.trim() ?? '';
      if (!baseUrl || !model) {
        throw modelError(
          'invalid_request',
          'Usage: lattice model connect --base-url <url> --model <id> [--key-stdin]',
        );
      }
      const key = await suppliedKey(args);
      // Always verified before it is kept. A command that reported success on an
      // endpoint that never answered would leave the machine configured and
      // broken, and the next thing to notice would be a failing turn.
      const result = await connectModelEndpoint(db, {
        baseUrl,
        model,
        ...(key !== null ? { apiKey: key } : {}),
        test: true,
      });
      if (!result.ok) {
        throw new Error(`The endpoint did not answer, so nothing was changed: ${result.error}`);
      }
      return [`Connected ${result.model} at ${result.baseUrl}. It is now the active backend.`];
    }

    case 'subscription': {
      const started = startSubscriptionSignIn();
      if (args.json) return [JSON.stringify(started, null, 2)];
      return [
        'Open this link in any browser and approve the request:',
        `  ${started.authorizeUrl}`,
        '',
        'The page will show a one-time code. Finish connecting with:',
        '  lattice model code <code>',
      ];
    }

    case 'code': {
      const code = await suppliedCode(args);
      if (!code) {
        throw modelError(
          'invalid_request',
          'Usage: lattice model code <code> (or --key-stdin and pipe it in)',
        );
      }
      await completeSubscriptionSignIn(code);
      return ['Claude subscription connected. It is now available as a backend.'];
    }

    case 'account': {
      const cfg = await connectAccountModel();
      return [
        'Lattice Cloud account model is active.',
        `  Credential valid until ${cfg.expiresAt}.`,
      ];
    }

    case 'use': {
      const provider = (args.action ?? '').trim();
      if (!provider) {
        throw modelError('invalid_request', 'Usage: lattice model use <anthropic|openai_compat>');
      }
      const active = selectModelProvider(provider);
      return [`Turns now go to ${providerLabel(active)}.`];
    }

    case 'test': {
      const result = await testModelProvider(db);
      if (!result.ok) throw new Error(`The model did not answer: ${result.error}`);
      return ['The model answered.'];
    }

    case 'key': {
      const name = (args.action ?? '').trim();
      if (!name) {
        throw modelError(
          'invalid_request',
          'Usage: lattice model key <openai|elevenlabs> --key-stdin (or --revoke to clear)',
        );
      }
      if (args.revoke) {
        await clearAssistantApiKey(db, name);
        return [`Cleared the ${name} key.`];
      }
      const key = await suppliedKey(args);
      if (key === null) {
        throw modelError(
          'invalid_request',
          'No key given. Pass --key-stdin and pipe it in, or --token <key>.',
        );
      }
      await setAssistantApiKey(db, name, key);
      return [`Saved the ${name} key.`];
    }

    case 'disconnect': {
      const what = (args.action ?? '').trim();
      if (!DISCONNECT_TARGETS.has(what)) {
        throw modelError(
          'invalid_request',
          `Usage: lattice model disconnect <${[...DISCONNECT_TARGETS].join('|')}>`,
        );
      }
      if (what === 'endpoint') {
        disconnectModelEndpoint();
        return ['Forgot the OpenAI-compatible endpoint. Turns fall back to Claude.'];
      }
      if (what === 'account') {
        disconnectAccountModel();
        return ['Stopped using the Lattice Cloud account model. Turns fall back to Claude.'];
      }
      disconnectClaudeSubscription();
      return ['Disconnected the Claude subscription.'];
    }
  }

  // Unreachable: the verb was checked against the list above. Throwing rather
  // than returning an empty result keeps a future verb that forgets its case from
  // reporting silent success.
  throw new Error(`Unhandled model subcommand: ${sub}`);
}
