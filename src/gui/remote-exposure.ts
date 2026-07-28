import { isLoopbackHost } from './origin-guard.js';
import type { SessionRootSource } from '../framework/lattice-root.js';

/**
 * The gate in front of a non-loopback GUI bind.
 *
 * The GUI's data routes carry no authentication — that is a deliberate trade for
 * a tool that normally serves one person on their own machine over the loopback.
 * The moment it binds elsewhere, every row it can read, write and delete becomes
 * reachable by anything on that network. So a remote bind has to clear two bars:
 *
 *   1. The root was NAMED (`--root`, or `LATTICE_ROOT`). Which data to publish is
 *      not something to infer from a working directory.
 *   2. The operator was shown WHICH root and WHICH workspace, and agreed. A
 *      warning that describes the risk but not the subject is exactly how the
 *      wrong workspace gets published without anyone noticing.
 *
 * Kept pure + injectable so the policy and the ordering are unit-tested directly
 * rather than by booting a server and reading a terminal.
 */

/** The workspace a bind is about to publish. */
export interface ExposedWorkspace {
  displayName: string;
  kind: 'local' | 'cloud';
  /** Absolute config path, when the workspace has one. */
  configPath: string | null;
}

export interface BindTarget {
  /** Bind host, e.g. `127.0.0.1` or `0.0.0.0`. */
  host: string;
  port: number;
  /** `--allow-remote` was passed. */
  allowRemote: boolean;
  /** `--yes` was passed: skip the question, never the disclosure. */
  assumeYes: boolean;
  /** How the session's root was chosen. `'home'` means nobody named it. */
  rootSource: SessionRootSource;
  /** Absolute path to the resolved root. */
  root: string;
  /** The workspace that will be served, or null in the zero-workspace state. */
  workspace: ExposedWorkspace | null;
}

/** Thrown when a bind must not happen. The CLI turns this into a non-zero exit. */
export class RemoteBindRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteBindRefused';
  }
}

export interface ExposureIo {
  /** Write one line of disclosure. */
  log: (line: string) => void;
  /**
   * Ask a question and resolve with the raw answer. Absent when there is no
   * terminal to ask — which is a refusal, never an implied yes.
   */
  prompt?: ((question: string) => Promise<string>) | undefined;
}

/**
 * Why this bind must be refused, or null when it may proceed (subject to the
 * confirmation in {@link bindWithExposureGate}). Loopback binds are always fine.
 *
 * Takes only the fields it actually decides on, so a caller can run it as a
 * preflight — before resolving or creating anything — and a bind that is going
 * to be refused has no side effects at all. Widening what a refusal depends on
 * is a type change here, which forces those callers to supply the new field
 * rather than silently drifting.
 */
export function remoteBindRefusal(
  t: Pick<BindTarget, 'host' | 'allowRemote' | 'rootSource'>,
): string | null {
  if (isLoopbackHost(t.host)) return null;
  if (!t.allowRemote) {
    return (
      `Refusing to bind the GUI to non-loopback host "${t.host}": its data routes are ` +
      `UNAUTHENTICATED and would be reachable from the network. Re-run with --allow-remote ` +
      `if that is genuinely intended (and only behind your own network controls).`
    );
  }
  if (t.rootSource === 'home') {
    return (
      `Refusing to bind the GUI to non-loopback host "${t.host}": no root was named, so the ` +
      `session fell back to the default one. Publishing a workspace to a network is not ` +
      `something to infer — re-run with --root <dir> naming the .lattice root you mean to serve.`
    );
  }
  return null;
}

/** The lines shown before a remote bind. Empty for a loopback bind. */
export function describeExposure(t: BindTarget): string[] {
  if (isLoopbackHost(t.host)) return [];
  const ws = t.workspace;
  const lines = [
    '',
    'About to serve Lattice on a NON-LOOPBACK address.',
    `  Address:   http://${t.host}:${String(t.port)}/`,
    `  Root:      ${t.root}`,
  ];
  if (ws) {
    lines.push(`  Workspace: "${ws.displayName}" (${ws.kind})`);
    if (ws.configPath) lines.push(`  Config:    ${ws.configPath}`);
  } else {
    lines.push('  Workspace: no workspace yet — the welcome screen would be served');
  }
  lines.push(
    '',
    'This server is UNAUTHENTICATED. There is no login: anyone who can reach',
    `${t.host}:${String(t.port)} can read, change and delete everything in that workspace.`,
  );
  if (ws?.kind === 'cloud') {
    lines.push(
      '',
      'WARNING: this is a CLOUD workspace. It is backed by a shared remote database,',
      'so what you would be publishing is not only your own data — everyone else on',
      'that database is exposed through this address too.',
    );
  }
  lines.push('');
  return lines;
}

/** True for an affirmative answer, tolerating case and surrounding whitespace. */
function isAffirmative(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

/**
 * Run `listen` only once the bind has cleared the gate. `listen` is invoked
 * strictly after any refusal check and any confirmation, so there is no ordering
 * for a caller to get wrong: an un-agreed exposure cannot reach the socket.
 *
 * @throws RemoteBindRefused when the bind is disallowed or not confirmed.
 */
export async function bindWithExposureGate<T>(
  t: BindTarget,
  io: ExposureIo,
  listen: () => Promise<T>,
): Promise<T> {
  const refusal = remoteBindRefusal(t);
  if (refusal) throw new RemoteBindRefused(refusal);
  if (isLoopbackHost(t.host)) return listen();

  for (const line of describeExposure(t)) io.log(line);

  if (t.assumeYes) {
    io.log('--yes was passed: continuing without asking.');
    return listen();
  }
  if (!io.prompt) {
    throw new RemoteBindRefused(
      'Refusing to expose this workspace: there is no terminal to confirm on. ' +
        'Re-run with --yes to accept the exposure described above without being asked.',
    );
  }
  const answer = await io.prompt('Serve this workspace on the network? [y/N] ');
  if (!isAffirmative(answer)) {
    throw new RemoteBindRefused('Not confirmed — the GUI was not started.');
  }
  return listen();
}
